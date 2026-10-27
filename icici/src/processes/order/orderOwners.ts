import Log from '../../util/Log';
import Mongo from '../../tools/mongo';

/**
 * Order-owner ledger: broker order id -> the app user that placed it. Written when an order is placed/tracked (before it can
 * fill) and never deleted, so a restart's /reconcile can decide whose fill an order id is without guessing from the contract
 * name. First writer wins ($setOnInsert): a later, inferred booking can never rewrite an owner.
 */
const COLLECTION = 'orderOwners';
// Owners confirmed against Mongo (the source of truth across restarts). Trusted without a lookup.
const cache = new Map<string, string>();
// Owners recorded in this process whose Mongo write has not been confirmed yet (or failed). Only a fallback when Mongo has no row:
// after a restart Mongo may already hold a different first writer, which must win.
const unconfirmed = new Map<string, string>();
// Ids with an upsert in flight: only the first recorder per id writes, so a later (possibly inferred) owner never races it to Mongo.
const writing = new Set<string>();
const MAX_UNCONFIRMED = 5000;

export function recordOrderOwner(orderId: string | undefined, user: string | undefined, broker: string): void {
    if (!orderId || !user) return;
    const id = String(orderId);
    if (cache.has(id) || writing.has(id)) return;
    if (!unconfirmed.has(id)) {
        unconfirmed.set(id, user);
        if (unconfirmed.size > MAX_UNCONFIRMED) unconfirmed.delete(unconfirmed.keys().next().value as string);
    }
    // Fire-and-forget, same convention as the other bookkeeping writes - a Mongo hiccup must not block order placement.
    const col = Mongo.getInstance()?.db.collection(COLLECTION);
    if (!col) return;
    writing.add(id);
    col.updateOne({ orderId: id }, { $setOnInsert: { orderId: id, user, broker, at: new Date() } }, { upsert: true })
        .then(async (res) => {
            // $setOnInsert is a no-op when a row already exists: read back the real first writer instead of assuming it was us.
            let owner = user;
            if (!res.upsertedCount) {
                const row = await col.findOne({ orderId: id }, { projection: { user: 1 } });
                if (row?.user) owner = String(row.user);
            }
            cache.set(id, owner);
            unconfirmed.delete(id);
        })
        .catch((e) => Log.log('[order] orderOwners: Mongo persist failed for', id, e))
        .finally(() => writing.delete(id));
}

// Owners for the given order ids (confirmed cache, then Mongo, then this process's unconfirmed guesses). Missing ids are simply absent.
export async function loadOrderOwners(orderIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const id of orderIds) {
        const hit = cache.get(id);
        if (hit) out.set(id, hit); else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
        const rows = await Mongo.getInstance()?.db.collection(COLLECTION).find({ orderId: { $in: missing } }).toArray();
        for (const r of rows ?? []) {
            out.set(String(r.orderId), String(r.user));
            cache.set(String(r.orderId), String(r.user));
            unconfirmed.delete(String(r.orderId));
        }
    } catch (e) {
        Log.log('[order] orderOwners: Mongo read failed (owners unknown, ambiguous order ids will be held for review):', e);
    }
    for (const id of missing) {
        if (!out.has(id) && unconfirmed.has(id)) out.set(id, unconfirmed.get(id)!);
    }
    return out;
}

// Idempotent startup index creation: the per-fill lookups (Trade by brokerOrderId+action, orderOwners by orderId) otherwise scan
// ever-growing collections on the live fill path. The orderOwners index is unique so concurrent first writers cannot both insert.
export async function ensureOrderIndexes(): Promise<void> {
    const db = Mongo.getInstance()?.db;
    if (!db) return;
    try {
        await db.collection('Trade').createIndex({ brokerOrderId: 1, action: 1 });
    } catch (e) {
        Log.log('[order] Trade index creation failed:', e);
    }
    try {
        await db.collection(COLLECTION).createIndex({ orderId: 1 }, { unique: true });
    } catch (e) {
        // A pre-existing duplicate orderId makes the unique build fail; fall back to a plain index so lookups are still fast.
        Log.log('[order] orderOwners unique index failed, using non-unique:', e);
        try { await db.collection(COLLECTION).createIndex({ orderId: 1 }); } catch (e2) { Log.log('[order] orderOwners index failed:', e2); }
    }
}
