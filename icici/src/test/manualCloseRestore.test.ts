/**
 * Regression test (live 2026-11-13): a position closed by a manual square-off came back as OPEN after a restart (its Sell fill doc carried no
 * token, so the token-filtered restore ignored it) and the sync then booked a SECOND, estimated close for it.
 *
 * Covers: (1) a Sell fill without a token is given the open position's token before it is stored; (2) the restore treats a tokenless Sell as
 * belonging to the contract (and still keeps two expiries that share a tsym apart); (3) partial / chunked closes net correctly; (4) the sync's
 * Mongo check never lets a lot that already has a closing Sell be closed a second time; (5) drainPendingWrites waits for the raw fill insert.
 * No broker is touched: Mongo is an in-memory fake.
 *
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/manualCloseRestore.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }

const docs: any[] = [];
let insertDelayMs = 0;
function brokerOk(d: any, spec: any): boolean {
    if (!spec?.$or) return true;
    return spec.$or.some((o: any) => {
        if (o.broker?.$exists === false) return d.broker === undefined;
        if (o.broker?.$in) return o.broker.$in.some((x: any) => (x instanceof RegExp ? x.test(String(d.broker)) : x === d.broker));
        return d.broker === o.broker;
    });
}
function match(d: any, f: any): boolean {
    if (f.tsym !== undefined) { if (f.tsym?.$in ? !f.tsym.$in.includes(d.tsym) : d.tsym !== f.tsym) return false; }
    if (f.action !== undefined) { if (f.action?.$in ? !f.action.$in.includes(d.action) : d.action !== f.action) return false; }
    return brokerOk(d, f);
}
const fakeDb = {
    collection: (name: string) => ({
        find: (f: any) => {
            const rows = name === 'Trade' ? docs.filter((d) => match(d, f ?? {})) : [];
            const c: any = { sort: () => { rows.sort((a, b) => +a.entryTime - +b.entryTime); return c; }, toArray: async () => rows, project: () => c };
            return c;
        },
        distinct: async (_k: string, f: any) => Array.from(new Set(docs.filter((d) => match(d, f)).map((d) => d.user))),
        findOne: async () => null,
        insertOne: async () => ({}),
        createIndex: async () => ({}),
        updateOne: async () => ({}), updateMany: async () => ({}), deleteOne: async () => ({}), replaceOne: async () => ({}), countDocuments: async () => 0,
    }),
};
(Mongo as any).instance = {
    db: fakeDb,
    insert: async (obj: any) => { await new Promise((r) => setTimeout(r, insertDelayMs)); docs.push({ ...obj }); },
};

const TS = 'NIFTY17NOV26P25050';
let n = 0;
function fill(action: 'Buy' | 'Sell', qty: number, price: number, o: { token?: string; user?: string; tsym?: string; minute?: number } = {}) {
    const d: any = { _id: `d${++n}`, user: o.user ?? 'U1', open: true, tsym: o.tsym ?? TS, quantity: qty, price, action, status: 'COMPLETE', broker: 'ant', brokerOrderId: `o${n}`, entryTime: new Date(Date.UTC(2026, 10, 13, 6, o.minute ?? n)) };
    if (o.token !== undefined) d.token = o.token;
    docs.push(d);
    return d;
}
const b: any = bookkeeping;
const restore = async (tsym = TS, token = '45389') => (await b.restoreOpenTradesForTsym(tsym, null, token, 'ant', undefined, [token])) as Trade[];

async function main() {
    // (2) the exact live shape: Buy with token, Sell without one.
    docs.length = 0;
    fill('Buy', 325, 133.8, { token: '45389' });
    fill('Sell', 325, 97.9); // manual square-off before the fix: no token
    assert((await restore()).length === 0, 'Buy 325 + tokenless Sell 325: restore brings back nothing');

    // a Sell WITH the token (strategy's own resting sell) still nets
    docs.length = 0;
    fill('Buy', 325, 139, { token: '45391' }); fill('Sell', 325, 144, { token: '45391' });
    assert((await restore(TS, '45391')).length === 0, 'tokened Sell still nets');

    // (3) partial close, tokenless Sell
    docs.length = 0;
    fill('Buy', 325, 100, { token: '45389' }); fill('Sell', 100, 90);
    let r = await restore();
    assert(r.length === 1 && r[0].quantity === 225, `partial manual close: 225 restored (got ${r.map((x) => x.quantity)})`);

    // chunks: two Buy lots at different times, manual close of one lot's quantity (FIFO consumes the oldest)
    docs.length = 0;
    fill('Buy', 130, 100, { token: '45389', minute: 1 }); fill('Buy', 195, 110, { token: '45389', minute: 2 }); fill('Sell', 130, 95, { minute: 3 });
    r = await restore();
    assert(r.length === 1 && r[0].quantity === 195 && Math.abs(r[0].price - 110) < 1e-9, 'two lots, one closed: the other restored at its own price');

    // two expiries sharing a tsym (Breeze style): a tokenless sell must NOT be applied when another token exists on the tsym
    docs.length = 0;
    fill('Buy', 100, 100, { token: 'A', minute: 1 }); fill('Buy', 100, 100, { token: 'B', minute: 2 }); fill('Sell', 100, 90, { token: 'A', minute: 3 });
    r = await restore(TS, 'B');
    assert(r.length === 1 && r[0].quantity === 100, 'other expiry sharing the tsym is not netted by the first one\'s sell');

    // other user's tokenless Sell does not close this user's lot
    docs.length = 0;
    fill('Buy', 100, 100, { token: '45389', user: 'U1' }); fill('Buy', 100, 100, { token: '45389', user: 'U2' }); fill('Sell', 100, 90, { user: 'U2' });
    r = await restore();
    assert(r.length === 1 && r[0].user === 'U1', 'only the user who sold is closed');

    // (1) recordFill of a tokenless Sell stores the token of the open position
    docs.length = 0;
    (bookkeeping as any).trades.length = 0;
    const buy = new Trade(); buy.tsym = TS; buy.token = '45389'; buy.quantity = 325; buy.price = 133.8; buy.action = 'Buy'; buy.status = 'COMPLETE'; buy.user = 'U1'; buy.broker = 'ant'; buy.brokerOrderId = 'bb1'; buy.right = 'PE' as any;
    await bookkeeping.recordFill(buy);
    await bookkeeping.drainPendingWrites();
    const sell = new Trade(); sell.tsym = TS; sell.quantity = 325; sell.price = 97.9; sell.action = 'Sell'; sell.status = 'COMPLETE'; sell.user = 'U1'; sell.broker = 'ant'; sell.brokerOrderId = 'ss1';
    insertDelayMs = 200; // (5) slow raw insert: the doc must still land once drained
    await bookkeeping.recordFill(sell);
    assert(!docs.some((d) => d.brokerOrderId === 'ss1'), 'raw Sell insert is still in flight right after recordFill');
    await bookkeeping.drainPendingWrites();
    insertDelayMs = 0;
    const stored = docs.find((d) => d.brokerOrderId === 'ss1');
    assert(!!stored, 'drainPendingWrites waited for the raw Sell insert');
    assert(stored?.token === '45389', `stored Sell carries the position's token (got ${stored?.token})`);
    assert((await restore()).length === 0, 'restart right after the manual close: nothing restored');

    // (4) sync guard: a stale open trade in memory whose lots Mongo shows closed is never closed a second time
    const stale = new Trade(); stale.tsym = TS; stale.token = '45389'; stale.quantity = 325; stale.price = 133.8; stale.action = 'Buy'; stale.status = 'COMPLETE'; stale.user = 'U1'; stale.broker = 'ant';
    assert((await b.mongoOpenQuantity(stale)) === 0, 'mongoOpenQuantity: closed lot -> 0');
    docs.length = 0;
    fill('Buy', 325, 133.8, { token: '45389' }); fill('Sell', 100, 90);
    assert((await b.mongoOpenQuantity(stale)) === 225, 'mongoOpenQuantity: partial close -> 225');
    docs.length = 0;
    assert((await b.mongoOpenQuantity(stale)) === 'unknown', 'mongoOpenQuantity: no Buy in Mongo -> unknown (old behaviour kept)');

    // syncExternalCloses end to end with a stubbed broker read: flat broker, stale tracked lot, Mongo shows it closed
    docs.length = 0;
    fill('Buy', 325, 133.8, { token: '45389' }); fill('Sell', 325, 97.9, { token: '45389' });
    const booked: Trade[] = [];
    const origRead = b.readBrokerRows, origBook = b.bookExternalSell, origMongoFlat = b.mongoOpenLotsFlatAtBroker;
    b.readBrokerRows = async () => [];
    b.mongoOpenLotsFlatAtBroker = async () => [];
    b.bookExternalSell = async (t: Trade) => { booked.push(t); };
    const realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => realSetTimeout(fn, ms && ms >= 3000 ? 1 : ms, ...a); // the 3 s confirmation read
    (bookkeeping as any).trades.length = 0;
    (bookkeeping as any).trades.push(stale);
    const count = await bookkeeping.syncExternalCloses('ant', 0);
    assert(count === 0 && booked.length === 0, 'sync books NO second close for a lot with a closing Sell');
    assert(!(bookkeeping as any).trades.includes(stale), 'the stale in-memory lot is dropped');

    // and a genuinely open lot (no Sell) that the broker lost is still booked
    docs.length = 0;
    fill('Buy', 325, 133.8, { token: '45389' });
    const open = Object.assign(new Trade(), stale); (bookkeeping as any).trades.push(open);
    const count2 = await bookkeeping.syncExternalCloses('ant', 0);
    assert(count2 === 1 && booked.length === 1, 'a really open lot flat at the broker is still booked once');
    (global as any).setTimeout = realSetTimeout;
    b.readBrokerRows = origRead; b.bookExternalSell = origBook; b.mongoOpenLotsFlatAtBroker = origMongoFlat;

    console.log(failed ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
