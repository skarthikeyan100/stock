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

    //TODO quoteCollection is hard-coded
    insert = async (obj) => {
        await this.db.collection(obj.constructor.name).insertOne(obj)
    }

    close = async () => {
        if (!this.client) return;
        const client = this.client;
        this.client = undefined as any; // a second close() (or a later init()) must not touch a closed client
        await client.close();
    }

    getAll = (collectionName) => {
        try {
            const collection = this.db.collection(collectionName);
            Log.log('Collection: ', collection)
            return collection.find({'day': 'Thursday'}).stream()
    
        } catch (e) {
            Log.log(e);
        }
        
        
    }

};


