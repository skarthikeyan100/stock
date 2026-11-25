/**
 * Broker-scoped order ownership (open-review-items 140). ANT and Prism/Shoonya issue colliding Noren-style order ids (live 2026-11-25: ANT order
 * 26112500161991 equalled an earlier Prism order of another user). The ledger, the in-memory order->user map, the booked-sell proof, the parked
 * Sells and the GTT exit registry are keyed broker|orderId; a legacy ledger row without a broker still answers for any broker.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/orderOwnersBrokerScope.test.js
 */
process.env.MOCK_BROKER = 'true';
import Mongo from '../tools/mongo';
import Log from '../util/Log';
import { Trade } from '../model/model';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }
const logs: string[] = [];
Log.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };

type Doc = Record<string, any>;
const eq = (a: any, v: any) => (a == null && v == null) || String(a) === String(v);
function matches(d: Doc, f: Doc): boolean {
    return Object.entries(f).every(([k, v]) => {
        if (v && typeof v === 'object' && '$in' in v) return (v.$in as any[]).some((x) => eq(d[k], x));
        return eq(d[k], v);
    });
}
// a Mongo stand-in with unique-index enforcement (the legacy index is unique on orderId alone, the new one on orderId+broker)
class Col {
    docs: Doc[] = [];
    idx: { name: string; key: Doc; unique?: boolean }[] = [];
    find(f: Doc = {}) { return { toArray: async () => this.docs.filter((d) => matches(d, f)) }; }
    async insertOne(doc: Doc) {
        for (const i of this.idx.filter((x) => x.unique)) {
            const ks = Object.keys(i.key);
            if (this.docs.some((d) => ks.every((k) => eq(d[k], doc[k])))) { const e: any = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
        }
        this.docs.push({ ...doc });
        return {};
    }
    async indexes() { return this.idx; }
    async createIndex(key: Doc, o: Doc = {}) { const name = Object.keys(key).map((k) => `${k}_1`).join('_'); if (!this.idx.some((i) => i.name === name)) this.idx.push({ name, key, unique: o.unique }); return name; }
    async dropIndex(name: string) { this.idx = this.idx.filter((i) => i.name !== name); }
    async countDocuments(f: Doc = {}) { return this.docs.filter((d) => matches(d, f)).length; }
    aggregate() {
        const g = new Map<string, number>();
        for (const d of this.docs) { const k = `${d.orderId}|${d.broker ?? ''}`; g.set(k, (g.get(k) ?? 0) + 1); }
        return { toArray: async () => Array.from(g).filter(([, n]) => n > 1).map(([k, n]) => ({ _id: { orderId: k.split('|')[0], broker: k.split('|')[1] || null }, n })) };
    }
    deleteOne = async () => ({ deletedCount: 0 });
    replaceOne = async () => ({});
    updateOne = async () => ({});
}
const cols = new Map<string, Col>();
const colOf = (n: string) => { if (!cols.has(n)) cols.set(n, new Col()); return cols.get(n)!; };
(Mongo as any).instance = { db: { collection: (n: string) => colOf(n) }, insert: async () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = () => { delete require.cache[require.resolve('../processes/order/orderOwners')]; return require('../processes/order/orderOwners') as typeof import('../processes/order/orderOwners'); };

(async () => {
    const ID = '26112500161991';
    console.log('(1) two brokers, same order id, different users (new index {orderId, broker})');
    let oo = fresh();
    const ledger = colOf('orderOwners');
    await ledger.createIndex({ orderId: 1, broker: 1 }, { unique: true });
    oo.recordOrderOwner(ID, 'prismUser', 'prism');
    await sleep(20);
    oo.recordOrderOwner(ID, 'antUser', 'ant');
    await sleep(20);
    assert(ledger.docs.length === 2, 'both rows stored: the second insert is not lost');
    assert((await oo.loadOrderOwners([ID], 'prism')).get(ID) === 'prismUser', 'Prism order resolves to the Prism user');
    assert((await oo.loadOrderOwners([ID], 'ant')).get(ID) === 'antUser', 'ANT order resolves to the ANT user');
    assert(!(await oo.loadOrderOwners([ID], 'kite')).has(ID), 'a third broker does not inherit either owner');
    oo.recordOrderOwner(ID, 'someoneElse', 'ant');
    await sleep(20);
    assert((await oo.loadOrderOwners([ID], 'ant')).get(ID) === 'antUser' && ledger.docs.length === 2, 'first writer still wins per broker');

    console.log('(2) restart reload from Mongo (fresh module state, same rows)');
    oo = fresh();
    assert((await oo.loadOrderOwners([ID], 'prism')).get(ID) === 'prismUser' && (await oo.loadOrderOwners([ID], 'ant')).get(ID) === 'antUser', 'owners restored per broker after a restart');
    const rows = await oo.loadOrderOwnerRows([ID], 'ant');
    assert(rows.length === 1 && rows[0].user === 'antUser', 'loadOrderOwnerRows returns only the broker\'s row');

    console.log('(3) legacy rows');
    ledger.docs.push({ orderId: 'L1', user: 'legacyU' }, { orderId: 'L2', user: 'prismLegacy', broker: 'prism' });
    oo = fresh();
    assert((await oo.loadOrderOwners(['L1'], 'ant')).get('L1') === 'legacyU' && (await oo.loadOrderOwners(['L1'], 'kite')).get('L1') === 'legacyU', 'a legacy row without a broker answers for any broker');
    assert((await oo.loadOrderOwners(['L2'], 'prism')).get('L2') === 'prismLegacy' && !(await oo.loadOrderOwners(['L2'], 'ant')).has('L2'), 'a legacy row that names its broker answers only for it');

    console.log('(4) pre-migration unique index on orderId alone still exists: no throw, owner kept in memory');
    cols.clear();
    const led2 = colOf('orderOwners');
    led2.idx.push({ name: 'orderId_1', key: { orderId: 1 }, unique: true });
    led2.docs.push({ orderId: ID, user: 'prismUser', broker: 'prism' });
    oo = fresh();
    oo.recordOrderOwner(ID, 'antUser', 'ant');
    await sleep(30);
    assert((await oo.loadOrderOwners([ID], 'ant')).get(ID) === 'antUser', 'the ANT owner resolves from memory');
    assert((await oo.loadOrderOwners([ID], 'prism')).get(ID) === 'prismUser', 'the Prism owner is untouched');
    assert(logs.some((l) => l.includes('migrate-order-owners-index.js')), 'the log points at the migration script');

    console.log('(5) index migration: dry run changes nothing, apply creates the new index before dropping the old, idempotent');
    let r = await oo.migrateOrderOwnerIndexes({ dryRun: true });
    assert(led2.idx.length === 1 && led2.idx[0].name === 'orderId_1' && r.actions.length === 2, 'dry run reports create + drop and changes nothing');
    r = await oo.migrateOrderOwnerIndexes();
    assert(led2.idx.length === 1 && led2.idx[0].name === 'orderId_1_broker_1' && led2.idx[0].unique === true, 'new unique index in place, old one dropped');
    r = await oo.migrateOrderOwnerIndexes();
    assert(led2.idx.length === 1 && r.actions.every((a) => !a.startsWith('create') && !a.startsWith('drop')), 'second run is a no-op');
    oo.recordOrderOwner(ID, 'antUser2', 'kite');
    await sleep(20);
    assert(led2.docs.length === 2, 'after the migration a third broker\'s row with the same id is stored');
    cols.clear();
    const led3 = colOf('orderOwners');
    led3.idx.push({ name: 'orderId_1', key: { orderId: 1 } });
    led3.docs.push({ orderId: 'D', user: 'a', broker: 'ant' }, { orderId: 'D', user: 'b', broker: 'ant' });
    r = await oo.migrateOrderOwnerIndexes();
    assert(r.duplicates.length === 1 && led3.idx.length === 1 && led3.idx[0].name === 'orderId_1', 'duplicate (orderId, broker) documents: old index kept, nothing dropped');

    console.log('(6) bookkeeping: GTT exit registry, order->user map, booked proof and parked Sells are broker-scoped');
    const bookkeeping = require('../processes/order/bookkeeping').default;
    const b: any = bookkeeping;
    bookkeeping.markGttExit('kite', ID, 77);
    assert(bookkeeping.isBrokerOwnedExit('kite', ID) && !bookkeeping.isBrokerOwnedExit('ant', ID) && !bookkeeping.isBrokerOwnedExit('prism', ID), 'a Kite GTT exit is not the exit of another broker\'s order with the same id');
    assert(b.gttFiredOrders.get('kite:' + ID) === 77 && !b.gttFiredOrders.has('ant:' + ID), 'gttFiredOrders keyed broker|id');
    bookkeeping.trackOrder(ID, 'prismUser', 'prism');
    assert(b.resolveUser(ID, undefined, 'prism') === 'prismUser' && b.resolveUser(ID, undefined, 'ant') === 'Default', 'order->user map: an ANT order of the same id is not the Prism user\'s');
    const mk = (broker: string, user: string): Trade => { const t = new Trade(); t.tsym = 'NIFTY26NOV25550CE'; t.quantity = 65; t.price = 0; t.action = 'Sell'; t.status = 'COMPLETE'; t.user = user; t.broker = broker as any; t.brokerOrderId = ID; return t; };
    b.parkUnresolvedSell(mk('prism', 'prismUser'));
    b.parkUnresolvedSell(mk('ant', 'antUser'));
    assert(bookkeeping.getUnresolvedFills().length === 2, 'two parked Sells with one bare id (different brokers) are two entries');
    b.markSellBooked(ID, 'ant');
    assert(bookkeeping.getUnresolvedFills().length === 1 && bookkeeping.getUnresolvedFills()[0].broker === 'prism', 'booking the ANT sell clears only the ANT parked Sell');
    b.clearParkedSellById(mk('prism', 'prismUser'));
    assert(bookkeeping.getUnresolvedFills().length === 1, 'the ANT booked proof does not clear the Prism parked Sell (bookedFillIds keyed broker|id)');
    b.markSellBooked(ID, 'prism');
    assert(bookkeeping.getUnresolvedFills().length === 0, 'the Prism booking clears the Prism one');

    console.log('(7) a platform order is not foreign because another broker\'s order shares the id');
    cols.clear(); colOf('orderOwners').idx.push({ name: 'orderId_1_broker_1', key: { orderId: 1, broker: 1 }, unique: true });
    oo = fresh();
    const bk = require('../processes/order/orderOwners');
    bk.recordOrderOwner('X9', 'antUser', 'ant');
    await sleep(20);
    // the same id arriving on Prism's stream is NOT the platform's (nothing recorded for prism), the ANT one is
    assert(!(await bk.loadOrderOwners(['X9'], 'prism')).has('X9') && (await bk.loadOrderOwners(['X9'], 'ant')).has('X9'), 'ledger: the id is the platform\'s on ANT only');

    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
