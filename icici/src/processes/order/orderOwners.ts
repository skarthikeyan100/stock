import Log from '../../util/Log';
import Mongo from '../../tools/mongo';

/**
 * Order-owner ledger: broker order id -> the app user that placed it. Written when an order is placed/tracked (before it can
 * fill) and never deleted, so a restart's /reconcile can decide whose fill an order id is without guessing from the contract
 * name. First writer wins ($setOnInsert): a later, inferred booking can never rewrite an owner.
 */
const COLLECTION = 'orderOwners';
const cache = new Map<string, string>();

export function recordOrderOwner(orderId: string | undefined, user: string | undefined, broker: string): void {
    if (!orderId || !user) return;
    const id = String(orderId);
    if (!cache.has(id)) cache.set(id, user);
    // Fire-and-forget, same convention as the other bookkeeping writes - a Mongo hiccup must not block order placement.
    Mongo.getInstance()?.db.collection(COLLECTION)
        .updateOne({ orderId: id }, { $setOnInsert: { orderId: id, user, broker, at: new Date() } }, { upsert: true })
        .catch((e) => Log.log('[order] orderOwners: Mongo persist failed for', id, e));
}

// Owners for the given order ids (memory first, then Mongo). Missing ids are simply absent.
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
        }
    } catch (e) {
        Log.log('[order] orderOwners: Mongo read failed (owners unknown, ambiguous order ids will be held for review):', e);
    }
    return out;
}
