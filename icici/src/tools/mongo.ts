import Log from '../util/Log';
import MongoClient, { Db } from 'mongodb'


export default class Mongo {
    dbUrl = 'mongodb://localhost:27017/stocks'
    dbName = 'stocks'
    db: Db
    client: MongoClient.MongoClient
    static instance: Mongo;

    static async init() {
        Log.log("Mongo is initialized")
        if (!Mongo.instance) {
            Mongo.instance = new Mongo();
        }
        await Mongo.getInstance()._init(['trade', 'quote', 'NiftyQuote', 'users']);
    }

    static getInstance() {
        return Mongo.instance;
    }


    //TODO when to close db

    _init = async (_collection: string[]) => {
        // Idempotent: a second init() must not open another client (and leak the first).
        if (this.client && this.db) return this;
        this.client = await MongoClient.connect(this.dbUrl, { useUnifiedTopology: true, ignoreUndefined: true })
        this.db = this.client.db(this.dbName);
        Log.log('Mongo is initialized')
        return this;
    }

    // The collection is the object's class name (Trade, NiftyQuote, OptionQuote ...), unless one is given. A plain object has no
    // class name ('Object'): inserting it would silently create a junk collection, so it must name its collection explicitly.
    insert = async (obj, collectionName?: string) => {
        const name = collectionName ?? obj?.constructor?.name;
        if (!name || name === 'Object') throw new Error('Mongo.insert: a plain object needs an explicit collection name');
        await this.db.collection(name).insertOne(obj)
    }

    // Fire-and-forget insert for tick-rate paths: a failure (Mongo down, db unset) is logged at most once a minute instead of per tick.
    // Throttled per distinct message, so a flood of identical tick failures cannot hide a different (e.g. trade-audit) failure.
    private lastInsertFailureLogAt = new Map<string, number>();
    tryInsert = (obj, collectionName?: string): void => {
        this.insert(obj, collectionName).catch((e) => {
            const key = String(e?.message ?? e);
            if (Date.now() - (this.lastInsertFailureLogAt.get(key) ?? 0) < 60_000) return;
            this.lastInsertFailureLogAt.set(key, Date.now());
            Log.log('[mongo] insert failed (the same failure is suppressed for 60s):', e);
        });
    }

    close = async () => {
        if (!this.client) return;
        const client = this.client;
        this.client = undefined as any; // a second close() (or a later init()) must not touch a closed client
        await client.close();
    }

    // Streams a collection, optionally filtered. The only caller (decision.ts) replays the expiry-day (Thursday) quotes, so that is
    // its filter; nothing else is implied here.
    getAll = (collectionName: string, filter: Record<string, unknown> = {}) => {
        try {
            return this.db.collection(collectionName).find(filter).stream()
        } catch (e) {
            Log.log(e);
        }
    }

};


