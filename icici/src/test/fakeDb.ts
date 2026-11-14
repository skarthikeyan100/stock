/**
 * A tiny in-memory stand-in for the parts of the mongodb 3.x Db/Collection API the level modules use, so their tests run without a database.
 * Install with installFakeDb(); it replaces Mongo.instance for the process. Supports equality, $ne and $in filters, $set / $unset updates,
 * upsert-free findOneAndUpdate (returns { value }), insertOne (assigns an ObjectId), find().sort().toArray(), countDocuments, createIndex (no-op).
 */
import { ObjectId } from 'mongodb';
import Mongo from '../tools/mongo';

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([k, v]) => {
        const actual = doc[k];
        if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
            if ('$ne' in v) return String(actual) !== String(v.$ne);
            if ('$in' in v) return (v.$in as any[]).map(String).includes(String(actual));
            if ('$exists' in v) return (actual !== undefined) === v.$exists;
            if ('$lt' in v) return actual < v.$lt;
        }
        return String(actual) === String(v);
    });
}

class FakeCollection {
    docs: Doc[] = [];
    async createIndex() { return 'ok'; }
    async findOne(filter: Doc = {}) { return this.docs.find((d) => matches(d, filter)) ?? null; }
    async insertOne(doc: Doc) { const d = { _id: new ObjectId(), ...doc }; this.docs.push(d); return { insertedId: d._id }; }
    private apply(d: Doc, update: Doc) {
        Object.assign(d, update.$set ?? {});
        for (const k of Object.keys(update.$unset ?? {})) delete d[k];
    }
    async updateOne(filter: Doc, update: Doc) { const d = this.docs.find((x) => matches(x, filter)); if (d) this.apply(d, update); return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 }; }
    async findOneAndUpdate(filter: Doc, update: Doc, _opts?: Doc) { const d = this.docs.find((x) => matches(x, filter)); if (d) this.apply(d, update); return { value: d ?? null, ok: 1 }; }
    find(filter: Doc = {}) {
        let out = this.docs.filter((d) => matches(d, filter));
        const api = {
            sort: (spec: Doc) => { const [[k, dir]] = Object.entries(spec); out = [...out].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir as number)); return api; },
            toArray: async () => out,
        };
        return api;
    }
    async countDocuments(filter: Doc = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
}

export class FakeDb {
    cols = new Map<string, FakeCollection>();
    collection(name: string) { if (!this.cols.has(name)) this.cols.set(name, new FakeCollection()); return this.cols.get(name)!; }
}

export function installFakeDb(): FakeDb {
    const db = new FakeDb();
    (Mongo as any).instance = { db };
    return db;
}
