import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import { orderKey, noteOrderId, ORDER_KEY_FIELD } from '../../util/orderKey';

/**
 * Order-owner ledger: (broker, broker order id) -> the app user that placed it. Written when an order is placed/tracked (before it can
 * fill) and never deleted, so a restart's /reconcile can decide whose fill an order id is without guessing from the contract
 * name. First writer wins: a later, inferred booking can never rewrite an owner.
 *
 * Scoped by BROKER: ANT and Prism/Shoonya both issue Noren-style order ids, and ids of two brokers collide (live 2026-11-25: ANT order
 * 26112500161991 equalled an earlier Prism order of another user). A bare-id ledger recorded the ANT order as the Prism user's. Rows written
 * before the scoping may carry no `broker` field (legacy): such a row still answers for any broker, a row WITH a broker answers only for it.
 */
const COLLECTION = 'orderOwners';
const key = (broker: string, id: string) => orderKey(broker, id); // the composite '<broker>:<orderId>' (util/orderKey.ts)
// Owners confirmed against Mongo (the source of truth across restarts), keyed broker|orderId. Trusted without a lookup.
const cache = new Map<string, string>();
// Owners recorded in this process whose Mongo write has not been confirmed yet (or failed). Only a fallback when Mongo has no row:
// after a restart Mongo may already hold a different first writer, which must win.
const unconfirmed = new Map<string, string>();
// Keys with a write in flight: only the first recorder per key writes, so a later (possibly inferred) owner never races it to Mongo.
const writing = new Set<string>();
const MAX_UNCONFIRMED = 5000;

// The row of `rows` (all rows sharing one order id, any broker) that answers for `broker`: the broker's own row first, else a legacy row without a broker.
export function ownerRowFor<T extends { broker?: unknown }>(rows: T[], broker: string): T | undefined {
    return rows.find((r) => r.broker != null && String(r.broker) === broker) ?? rows.find((r) => r.broker == null || r.broker === '');
}

// `foreign` marks an order the platform did NOT place (a manual/broker-side sell booked against a user's lots): the ledger names the user whose
// position it closed, but the order is not the platform's. platformSells() relies on it to book only the platform's own sells to a strategy.
export function recordOrderOwner(orderId: string | undefined, user: string | undefined, broker: string, opts: { foreign?: boolean } = {}): void {
    if (!orderId || !user) return;
    const id = String(orderId);
    noteOrderId(broker, id); // INFO line when another broker used this id string today
    const k = key(broker, id);
    if (cache.has(k) || writing.has(k)) return;
    if (!unconfirmed.has(k)) {
        unconfirmed.set(k, user);
        if (unconfirmed.size > MAX_UNCONFIRMED) unconfirmed.delete(unconfirmed.keys().next().value as string);
    }
    // Fire-and-forget, same convention as the other bookkeeping writes - a Mongo hiccup must not block order placement.
    const col = Mongo.getInstance()?.db?.collection(COLLECTION); // db?: an instance whose connection is not up yet must not make recordFill throw
    if (!col) return;
    writing.add(k);
    (async () => {
        const rowsOf = async (): Promise<any> => ownerRowFor(await col.find({ orderId: id }).toArray(), broker);
        let row = await rowsOf();
        if (!row) {
            try {
                await col.insertOne({ orderId: id, user, broker, [ORDER_KEY_FIELD]: k, at: new Date(), ...(opts.foreign ? { foreign: true } : {}) });
            } catch (e: any) {
                if (e?.code !== 11000) throw e;
                // Duplicate key: another writer got there first (same broker: it is the owner), or the pre-migration unique index on orderId alone still
                // exists and another broker's row holds this id. Read back; with no row for this broker the owner stays in memory only (see migrate script).
                row = await rowsOf();
                if (!row) {
                    Log.log(`[order] orderOwners: ${key(broker, id)} could not be stored (the legacy unique index on orderId still exists; run scripts/migrate-order-owners-index.js --apply) - kept in memory for this process`);
                    cache.set(k, user);
                    unconfirmed.delete(k);
                    return;
                }
            }
        }
        // The first writer is the owner: read back the real row instead of assuming it was us.
        cache.set(k, row?.user ? String(row.user) : user);
        unconfirmed.delete(k);
    })()
        .catch((e) => Log.log('[order] orderOwners: Mongo persist failed for', k, e))
        .finally(() => writing.delete(k));
}

// Ledger rows (user, foreign flag, ...) for the given order ids of ONE broker: the broker's own row, else a legacy row without a broker field.
export async function loadOrderOwnerRows(orderIds: string[], broker: string): Promise<any[]> {
    if (orderIds.length === 0) return [];
    const rows: any[] = (await Mongo.getInstance()?.db?.collection(COLLECTION).find({ orderId: { $in: orderIds } }).toArray()) ?? [];
    const byId = new Map<string, any[]>();
    for (const r of rows) byId.set(String(r.orderId), [...(byId.get(String(r.orderId)) ?? []), r]);
    const out: any[] = [];
    for (const rs of byId.values()) { const r = ownerRowFor(rs, broker); if (r) out.push(r); }
    return out;
}

// Owners for the given order ids of `broker` (confirmed cache, then Mongo, then this process's unconfirmed guesses). Missing ids are simply absent.
export async function loadOrderOwners(orderIds: string[], broker: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const missing: string[] = [];
    for (const id of orderIds) {
        const hit = cache.get(key(broker, id));
        if (hit) out.set(id, hit); else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
        for (const r of await loadOrderOwnerRows(missing, broker)) {
            const id = String(r.orderId);
            out.set(id, String(r.user));
            cache.set(key(broker, id), String(r.user));
            unconfirmed.delete(key(broker, id));
        }
    } catch (e) {
        Log.log('[order] orderOwners: Mongo read failed (owners unknown, ambiguous order ids will be held for review):', e);
    }
    for (const id of missing) {
        const k = key(broker, id);
        if (!out.has(id) && unconfirmed.has(k)) out.set(id, unconfirmed.get(k)!);
    }
    return out;
}

export interface OwnerIndexReport { actions: string[]; duplicates: { orderId: string; broker: string | null; count: number }[]; legacyNoBroker: number; applied: boolean }

/**
 * The orderOwners index migration, idempotent and safe to run live: (1) create the unique index {orderId, broker} (a no-op when it exists),
 * (2) only then drop the old unique index on orderId alone (it would reject a second broker's row with the same id). Duplicate (orderId, broker)
 * documents make step 1 fail: nothing is dropped and the duplicates are reported (the script, not startup, removes them). dryRun only reports.
 */
export async function migrateOrderOwnerIndexes(opts: { dryRun?: boolean } = {}): Promise<OwnerIndexReport> {
    const report: OwnerIndexReport = { actions: [], duplicates: [], legacyNoBroker: 0, applied: !opts.dryRun };
    const col = Mongo.getInstance()?.db?.collection(COLLECTION);
    if (!col) { report.actions.push('no Mongo connection: nothing done'); return report; }
    const sameKeys = (k: any, want: Record<string, number>) => k && Object.keys(want).length === Object.keys(k).length && Object.entries(want).every(([f, d]) => k[f] === d);
    let indexes: any[] = [];
    try { indexes = await col.indexes(); } catch { /* collection does not exist yet: both creates below make it */ }
    const hasNew = indexes.some((i) => sameKeys(i.key, { orderId: 1, broker: 1 }) && i.unique === true);
    const old = indexes.find((i) => sameKeys(i.key, { orderId: 1 }));
    report.legacyNoBroker = await col.countDocuments({ broker: { $in: [null, ''] } });
    report.duplicates = (await col.aggregate([
        { $group: { _id: { orderId: '$orderId', broker: { $ifNull: ['$broker', null] } }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } },
    ]).toArray()).map((d: any) => ({ orderId: String(d._id.orderId), broker: d._id.broker ?? null, count: d.n }));
    if (report.duplicates.length > 0) { report.actions.push(`${report.duplicates.length} duplicate (orderId, broker) group(s): the unique index cannot be built, the old index stays`); return report; }
    if (!hasNew) {
        report.actions.push('create unique index {orderId:1, broker:1}');
        if (!opts.dryRun) await col.createIndex({ orderId: 1, broker: 1 }, { unique: true });
    } else report.actions.push('unique index {orderId:1, broker:1} already exists');
    if (old) {
        report.actions.push(`drop old index ${old.name}${old.unique ? ' (unique on orderId alone)' : ''}`);
        if (!opts.dryRun) await col.dropIndex(old.name);
    } else report.actions.push('old index on orderId alone does not exist');
    return report;
}

// Idempotent startup index creation: the per-fill lookups (Trade by brokerOrderId+action, orderOwners by orderId) otherwise scan
// ever-growing collections on the live fill path. The orderOwners index is unique so concurrent first writers cannot both insert.
export async function ensureOrderIndexes(): Promise<void> {
    const db = Mongo.getInstance()?.db;
    if (!db) return;
    try {
        await db.collection('Trade').createIndex({ brokerOrderId: 1, action: 1 });
        // brokerOrderKey = '<broker>:<orderId>': the fill dedupe and every order-id lookup read it (util/orderKey.ts). Non-unique: a fill may be stored as several raw docs.
        await db.collection('Trade').createIndex({ [ORDER_KEY_FIELD]: 1, action: 1 });
        await db.collection('closedTrades').createIndex({ [ORDER_KEY_FIELD]: 1 }, { sparse: true });
        await db.collection(COLLECTION).createIndex({ [ORDER_KEY_FIELD]: 1 }, { sparse: true });
    } catch (e) {
        Log.log('[order] Trade index creation failed:', e);
    }
    try {
        const r = await migrateOrderOwnerIndexes();
        if (r.duplicates.length > 0) Log.log(`[order] orderOwners: ${r.duplicates.length} duplicate (orderId, broker) group(s) block the broker-scoped unique index (the old index stays, cross-broker id collisions stay in memory only): run scripts/migrate-order-owners-index.js --apply`);
    } catch (e) {
        // The old unique index still exists and could not be replaced: keep a plain index so lookups are fast; recordOrderOwner copes with its duplicate-key errors.
        Log.log('[order] orderOwners index migration failed, leaving the existing index:', e);
        try { await db.collection(COLLECTION).createIndex({ orderId: 1 }); } catch (e2) { Log.log('[order] orderOwners index failed:', e2); }
    }
}
