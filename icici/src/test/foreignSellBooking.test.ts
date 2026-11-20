/**
 * Live 2026-11-20 NIFTY26NOV25550CE: ContinuousStrategy held 195 (buys 124.45 / 114.25 / 105.6, avg 114.77); the user bought 1755 @103 by hand and sold
 * 1755 + 195 @104: the extra 195 consumed the platform's lots. Covers: (1) the foreign-sell excess rule on the real trade-book rows; (2) the shortfall is
 * booked as a Sell of the platform's trade at the trade-book price, once (a second poll, a sync, a restart's empty memory book nothing more), with the
 * fill listeners told (live) or not (sync); (3) no excess -> nothing booked; the user's own lots are never booked; several holders -> ALERT only;
 * (4) Kite's per-contract sell lock waits instead of refusing, and refuses after its bounded wait.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/foreignSellBooking.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';
import Kite from '../kite/Kite';
import { waitUntilNotResting, RACED_FILL_WAIT_MS } from '../processes/order/BrokerExecutor';
import { foreignSellExcess, piecesForShortfall, type TimedFill } from '../processes/order/foreignSells';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }

const docs: any[] = [];
const fakeDb = {
    collection: (name: string) => ({
        find: (f: any) => {
            const rows = name === 'Trade' ? docs.filter((d) => (f?.brokerOrderId?.$exists ? d.brokerOrderId != null : true)) : [];
            const c: any = { sort: () => c, toArray: async () => rows, project: () => c };
            return c;
        },
        findOne: async (f: any) => (name === 'Trade' ? docs.find((d) => d.brokerOrderId === f?.brokerOrderId && d.action === f?.action) ?? null : null),
        insertOne: async () => ({}), createIndex: async () => ({}),
        updateOne: async () => ({ upsertedCount: 1 }), updateMany: async () => ({}), deleteOne: async () => ({}), replaceOne: async () => ({}), countDocuments: async () => 0,
    }),
};
(Mongo as any).instance = { db: fakeDb, insert: async (obj: any) => { docs.push({ ...obj }); } };

const TS = 'NIFTY26NOV25550CE';
const T0 = Date.UTC(2026, 10, 20, 5, 0);
const f = (orderId: string, tradeId: string, action: 'Buy' | 'Sell', qty: number, price: number, min: number, tsym = TS): TimedFill => ({ orderId, tradeId, action, tsym, qty, price, at: T0 + min * 60_000, });
const PLATFORM = new Set(['P1', 'P2', 'P3']);
// the real rows: platform buys P1-P3, the user's buy 1755 (3 trade rows), sells 1755 (2 rows) + 195
let seq = 0;
const real = (): TimedFill[] => {
    const k = `-${++seq}`; // the order-owner ledger is process-wide: every scenario gets its own order ids
    return REAL_BASE.map((x) => ({ ...x, orderId: PLATFORM.has(x.orderId) ? x.orderId : x.orderId + k }));
};
const REAL_BASE: TimedFill[] = [
    f('P1', '1', 'Buy', 65, 124.45, 25), f('P2', '2', 'Buy', 65, 114.25, 27), f('P3', '3', 'Buy', 65, 105.6, 29),
    f('U1', '3002981', 'Buy', 1625, 103, 34), f('U1', '3002988', 'Buy', 65, 103, 34), f('U1', '3002989', 'Buy', 65, 103, 34),
    f('U2', '3068164', 'Sell', 1105, 104, 36), f('U2', '3068165', 'Sell', 650, 104, 36), f('U3', '3068166', 'Sell', 195, 104, 36),
];

function trade(user: string, qty: number, price: number, tsym = TS): Trade {
    const t = new Trade(); t.tsym = tsym; t.token = '55555'; t.quantity = qty; t.price = price; t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = 'kite'; t.open = true; t.right = 'CE' as any;
    return t;
}
const b: any = bookkeeping;
let brokerNet = 0;
let book: TimedFill[] = [];
b.readBrokerRows = async () => [{ tsyms: [TS], tokens: ['55555'], qty: brokerNet }];
b.readKiteTimedFills = async () => book;
b.mongoFillKeys = async () => ({ keys: new Set(docs.filter((d) => d.brokerOrderId).map((d) => `${d.action}|${d.brokerOrderId}`)), tsyms: new Set([TS]) });
const notified: Trade[] = [];
bookkeeping.onFill((_u, t) => { notified.push(t); });
const reset = () => { docs.length = 0; notified.length = 0; b.trades.length = 0; b.closedTrades.length = 0; b.processedFillIds.clear(); };

async function main() {
    // (1) the rule on the real rows
    const REAL = REAL_BASE;
    const e = foreignSellExcess(REAL, (id) => PLATFORM.has(id));
    assert(e.foreignBuyQty === 1755 && e.foreignSellQty === 1950 && e.excessQty === 195, `excess = 1950 sold - 1755 bought = 195 (got ${e.excessQty})`);
    assert(e.pieces.length === 1 && e.pieces[0].orderId === 'U3' && e.pieces[0].price === 104 && e.pieces[0].tradeIds[0] === '3068166', 'the 195 piece is order U3 @104');
    assert(foreignSellExcess(REAL, (id) => PLATFORM.has(id), T0 + 35 * 60_000).excessQty === 0, 'a sell newer than the grace cut-off is left out');
    // a manual sell BEFORE the user's own buy comes out of the platform's lots; one AFTER consumes the user's own buys
    const before = foreignSellExcess([f('U1', '1', 'Sell', 100, 120, 1), f('U2', '2', 'Buy', 100, 110, 2)], () => false);
    assert(before.excessQty === 100, 'a manual sell with no manual lots before it is all excess');
    const partial = foreignSellExcess([f('U1', '1', 'Buy', 100, 110, 1), f('U2', '2', 'Sell', 60, 120, 2), f('U3', '3', 'Sell', 60, 121, 3)], () => false);
    assert(partial.excessQty === 20 && partial.pieces[0].orderId === 'U3', 'manual buy 100, manual sells 60+60: only 20 of the later sell is excess');
    const cut = piecesForShortfall([{ orderId: 'a', qty: 50, price: 1, at: 1, tradeIds: [] }, { orderId: 'b', qty: 50, price: 2, at: 2, tradeIds: [] }], 70);
    assert(cut.length === 2 && cut[0].orderId === 'a' && cut[0].qty === 20 && cut[1].qty === 50, 'newest sells first, oldest cut to the need');

    // (2) the live case: platform 195 @114.77, broker net 0
    reset();
    b.trades.push(trade('ContinuousStrategy', 195, (124.45 + 114.25 + 105.6) / 3));
    const avg = (124.45 + 114.25 + 105.6) / 3;
    brokerNet = 0; book = real();
    let n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 1, `booked 1 sell (got ${n})`);
    assert(b.trades.length === 0, 'the platform trade is closed');
    const closed = b.closedTrades[b.closedTrades.length - 1];
    assert(!!closed && closed.quantity === 195 && Math.abs(closed.realizedPnL - 195 * (104 - avg)) < 0.01, `realized P&L = 195 x (104 - 114.77) (got ${closed?.realizedPnL})`);
    assert(docs.some((d) => d.action === 'Sell' && /^U3-/.test(d.brokerOrderId) && d.price === 104 && d.quantity === 195 && d.user === 'ContinuousStrategy'), 'raw Sell stored under the broker order id at the trade-book price');
    assert(!docs.some((d) => /^U2/.test(d.brokerOrderId)), "the user's own 1755 sell is not booked");
    assert(notified.length === 1 && notified[0].action === 'Sell' && notified[0].price === 104, 'the fill listeners (strategies) were told once');
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0 });
    assert(n === 0 && docs.filter((d) => d.action === 'Sell').length === 1, 'a second poll books nothing more');
    // a restart's memory: the position is restored although Mongo has the Sell -> still not booked twice
    b.trades.push(trade('ContinuousStrategy', 195, 114.77)); b.processedFillIds.clear();
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: false, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 0 && docs.filter((d) => d.action === 'Sell').length === 1, 'after a restart (empty memory) / sync it is not booked a second time');

    // sync flavour: no strategy told
    reset(); book = real();
    b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: false, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 1 && notified.length === 0 && b.trades.length === 0, 'sync: booked at the trade-book price, strategies not notified');

    // (3) no excess: the user bought 1755 and sold 1755 only; platform still 195 but the broker shows 0 (cause unknown) -> nothing booked
    reset(); book = real();
    b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    book = book.filter((x) => !x.orderId.startsWith('U3'));
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1, 'no manual sell beyond the manual buys: nothing booked');
    assert(/not explained/.test(await bookkeeping.explainNeverShort('kite', TS, (id) => PLATFORM.has(id))), 'the NEVER-SHORT line says it is not a non-platform sell');
    book = real();
    assert(/YES, a non-platform sell explains it.*U3-\d+ \(195 @ 104\.00\)/.test(await bookkeeping.explainNeverShort('kite', TS, (id) => PLATFORM.has(id))), 'the NEVER-SHORT line names the order id');

    // partly sold by hand: platform 195, broker net 130 -> only 65 booked, the leg keeps 130
    reset(); book = real();
    b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    brokerNet = 130;
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 1 && b.trades.length === 1 && b.trades[0].quantity === 130, `shortfall 65 only (open left ${b.trades[0]?.quantity})`);

    // two users hold the contract: whose lots went is unknowable -> nothing booked
    reset();
    brokerNet = 0;
    b.trades.push(trade('ContinuousStrategy', 130, 114.77)); b.trades.push(trade('SimpleContinuous', 65, 110));
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 2, 'several holders: ALERT only');

    // the broker holds at least what the platform holds: nothing to do
    reset();
    b.trades.push(trade('ContinuousStrategy', 195, 114.77)); brokerNet = 195;
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1, 'broker net >= platform quantity: nothing booked');
    reset();

    // (4) Kite sell lock: the second sell waits for the first and then runs; a hung first sell makes the second refuse after the bounded wait
    const kite: any = Kite.getInstance();
    const order: string[] = [];
    const r1 = await kite.acquireSellLock('X');
    const p2 = kite.acquireSellLock('X').then((rel: () => void) => { order.push('second'); rel(); });
    await new Promise((r) => setTimeout(r, 50));
    assert(order.length === 0, 'second sell on the same contract waits while the first is in flight');
    const other = await kite.acquireSellLock('Y'); other();
    assert(true, 'another contract is not blocked');
    order.push('first-done'); r1();
    await p2;
    assert(order.join() === 'first-done,second', 'the second sell ran after the first finished');
    (Kite as any).SELL_LOCK_WAIT_MS = 100;
    const hung = await kite.acquireSellLock('Z');
    let refused = '';
    await kite.acquireSellLock('Z').catch((e: any) => { refused = e.message; });
    assert(/did not finish within/.test(refused), `bounded wait then refuse (${refused.slice(0, 60)})`);
    hung();
    const again = await kite.acquireSellLock('Z'); again();
    assert(true, 'the lock is usable again after the timeout');

    // (2b) the 12:00 sync case: an EARLIER manual sell (1755 @109, before the platform bought) must not be booked as the sale of the lots
    reset();
    const early = [f('E0', '10', 'Buy', 1755, 107, -20), f('E1', '11', 'Sell', 1755, 109, 7), ...real()];
    book = early.map((x) => (/^(E|U)/.test(x.orderId) && !PLATFORM.has(x.orderId) ? { ...x, orderId: x.orderId + '-b' + (++seq) } : x));
    const tr = trade('ContinuousStrategy', 195, 114.7667); tr.entryTime = new Date(T0 + 24 * 60_000); // buys from 05:24
    b.trades.push(tr); brokerNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: false, isOwnOrder: (id) => PLATFORM.has(id), graceMs: 0, confirm: false });
    const sold = docs.filter((d) => d.action === 'Sell');
    assert(n === 1 && sold.length === 1 && sold[0].price === 104 && /^U3-/.test(sold[0].brokerOrderId), `booked the 11:06 sell @104, not the 10:37 sell @109 (got ${sold.map((d) => d.price)})`);

    // (5) lock-profits re-price race: the replacement waits until the raced order is no longer tracked (fill booked)
    RACED_FILL_WAIT_MS.step = 20; RACED_FILL_WAIT_MS.max = 300;
    let tracked = [{ orderId: 'R1' }, { orderId: 'other' }];
    setTimeout(() => { tracked = [{ orderId: 'other' }]; }, 100);
    const t0 = Date.now();
    assert(await waitUntilNotResting(() => tracked, ['R1'], 't') === true && Date.now() - t0 >= 80, 'waits until the raced order is untracked, then continues');
    assert(await waitUntilNotResting(() => [{ orderId: 'R2' }], ['R2'], 't') === false, 'bounded: gives up (ALERT) when the fill is never booked');

    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
