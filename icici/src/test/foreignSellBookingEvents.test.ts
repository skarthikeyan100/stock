/**
 * Event-driven booking of a non-platform sell (user decision 2026-11-20) and the NEVER-SHORT repair, on the real 2026-11-20 rows
 * (NIFTY26NOV25550CE: ContinuousStrategy 195, the user's buy 1755 and sells 1755 + 195 @104 -> order U3).
 *  (1) the scheduler: a burst runs once, a refusal storm runs once per window, one run per broker at a time, nothing runs before it is enabled;
 *  (2) a non-platform SELL event books the sell (strategy told, once), the platform's own order / booked order / ledger order does not trigger anything,
 *      any booked platform trade re-checks the contract, a sell booked by the check does not re-trigger it;
 *  (3) the NEVER-SHORT refusal is the trigger of a repair and the one-line report says what happened (booked / flat / not explained + one ALERT per 10 min);
 *  (4) several holders: resolved by the evidence (resting sells, exact free quantity) or ALERT naming the candidates;
 *  (5) an order-stream fill time completes a trade-book row without a time; a GTT contract waits for the GTT poll.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/foreignSellBookingEvents.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';
import Log from '../util/Log';
import { ForeignSellWatch } from '../processes/order/foreignSellWatch';
import type { TimedFill } from '../processes/order/foreignSells';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const docs: any[] = [];
const fakeDb = {
    collection: (name: string) => ({
        find: (f: any) => { const rows = name === 'Trade' ? docs : []; const c: any = { sort: () => c, toArray: async () => rows, project: () => c }; return c; },
        findOne: async (f: any) => (name === 'Trade' ? docs.find((d) => d.brokerOrderId === f?.brokerOrderId && d.action === f?.action) ?? null : null),
        insertOne: async () => ({}), createIndex: async () => ({}),
        updateOne: async () => ({ upsertedCount: 1 }), updateMany: async () => ({}), deleteOne: async () => ({}), replaceOne: async () => ({}), countDocuments: async () => 0,
    }),
};
(Mongo as any).instance = { db: fakeDb, insert: async (obj: any) => { docs.push({ ...obj }); } };

const logs: string[] = [];
const realLog = Log.log;
Log.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
const out = (m: string) => console.log(m);

const TS = 'NIFTY26NOV25550CE';
const T0 = Date.UTC(2026, 10, 20, 5, 0);
const f = (orderId: string, tradeId: string, action: 'Buy' | 'Sell', qty: number, price: number, min: number, tsym = TS): TimedFill => ({ orderId, tradeId, action, tsym, qty, price, at: T0 + min * 60_000 });
function trade(user: string, qty: number, price: number, tsym = TS): Trade {
    const t = new Trade(); t.tsym = tsym; t.token = '55555'; t.quantity = qty; t.price = price; t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = 'kite'; t.open = true; t.right = 'CE' as any;
    return t;
}
const b: any = bookkeeping;
let brokerNet = 0;
let book: TimedFill[] = [];
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`; // the owner ledger is process-wide
b.readBrokerRows = async () => [{ tsyms: [TS], tokens: ['55555'], qty: brokerNet }];
b.readTimedFillsRaw = async () => ({ fills: book, untimed: [] });
b.mongoFillKeys = async () => ({ keys: new Set(docs.filter((d) => d.brokerOrderId).map((d) => `${d.action}|${d.brokerOrderId}`)), tsyms: new Set([TS]) });
const notified: Trade[] = [];
bookkeeping.onFill((_u, t) => { notified.push(t); });
let pending: { orderId: string; userId: string; tradingSymbol: string; action: 'Buy' | 'Sell'; quantity: number }[] = [];
bookkeeping.registerOwnOrderTest('kite', (id) => /^P\d$/.test(id) || id === 'OWN1'); // the platform's own buys P1-P3 and one own order
bookkeeping.setPendingOrderSource(() => pending);
// the real rows: platform buys P1-P3 (195), the user's buy 1755, sells 1755 + 195 -> excess 195 in order U3
const realBook = (): { rows: TimedFill[]; u3: string } => {
    const k = uid('x'); const u1 = `U1-${k}`, u2 = `U2-${k}`, u3 = `U3-${k}`;
    return { u3, rows: [
        f('P1', '1', 'Buy', 65, 124.45, 25), f('P2', '2', 'Buy', 65, 114.25, 27), f('P3', '3', 'Buy', 65, 105.6, 29),
        f(u1, 'a', 'Buy', 1625, 103, 34), f(u1, 'b', 'Buy', 65, 103, 34), f(u1, 'c', 'Buy', 65, 103, 34),
        f(u2, 'd', 'Sell', 1105, 104, 36), f(u2, 'e', 'Sell', 650, 104, 36), f(u3, 'f', 'Sell', 195, 104, 36),
    ] };
};
const reset = () => { docs.length = 0; notified.length = 0; b.trades.length = 0; b.closedTrades.length = 0; b.processedFillIds.clear(); b.foreignOutcomes.clear(); b.refusalAlertAt.clear(); b.foreignShortfallAlerted.clear(); pending = []; logs.length = 0; };
// a fast watch (production values are 5 s settle / 15 s window): same class, same wiring to runForeignCheck
const useFastWatch = (settleMs = 30, minGapMs = 400) => {
    b.foreignWatch.stop();
    b.foreignWatch = new ForeignSellWatch((br, ts, reasons) => b.runForeignCheck(br, ts, reasons), { settleMs, maxWaitMs: 300, minGapMs });
    b.foreignWatch.enable();
    return b.foreignWatch as ForeignSellWatch;
};

async function main() {
    // (1) scheduler ---------------------------------------------------------------------------------------------------------------------------------
    {
        let runs: string[] = [];
        const w = new ForeignSellWatch(async (br, ts, r) => { runs.push(`${br}|${ts}|${r.join('+')}`); await sleep(20); }, { settleMs: 40, maxWaitMs: 200, minGapMs: 300 });
        w.request('kite', 'X', 'foreign-sell-event');
        assert(runs.length === 0 && w.pending() === 0, 'nothing runs (or is scheduled) before the watch is enabled');
        w.enable();
        for (let i = 0; i < 30; i++) { w.request('kite', 'X', 'foreign-sell-event'); await sleep(5); } // 1755 lots arriving as 30 trade rows
        await sleep(150);
        assert(runs.length === 1, `a burst of 30 rows runs ONE check (got ${runs.length})`);
        for (let i = 0; i < 50; i++) w.request('kite', 'X', 'refusal', 10); // a refusal storm right after
        await sleep(100);
        assert(runs.length === 1, `inside the window a storm of 50 refusals has not run again yet (runs ${runs.length})`);
        await sleep(350);
        assert(runs.length === 2 && /refusal/.test(runs[1]), `the storm ran exactly once when the window ended (runs ${runs.length})`);
        w.request('kite', 'Y', 'own-trade'); w.request('ant', 'Y', 'own-trade'); w.request('kite', 'Z', 'poll');
        await sleep(250);
        assert(runs.length === 5, 'different (broker, contract) keys each run once');
        w.stop();
    }
    {
        let active = 0, maxActive = 0;
        const w = new ForeignSellWatch(async () => { active++; maxActive = Math.max(maxActive, active); await sleep(60); active--; }, { settleMs: 5, maxWaitMs: 50, minGapMs: 10 });
        w.enable(); w.request('kite', 'A', 'poll'); w.request('kite', 'B', 'poll'); w.request('kite', 'C', 'poll');
        await sleep(400);
        assert(maxActive === 1, `one run per broker at a time (max concurrent ${maxActive})`);
        w.stop();
    }

    // (2) events ---------------------------------------------------------------------------------------------------------------------------------------
    reset();
    const w = useFastWatch();
    const runLog: string[] = [];
    const origRun = b.runForeignCheck.bind(b);
    b.runForeignCheck = async (br: any, ts: string, r: any) => { runLog.push(`${br}|${ts}|${r.join('+')}`); return origRun(br, ts, r); };
    b.foreignWatch.stop(); const w2 = useFastWatch(); void w2;
    brokerNet = 0;
    let rb = realBook(); book = rb.rows;
    b.trades.push(trade('ContinuousStrategy', 195, (124.45 + 114.25 + 105.6) / 3));
    // an event of the platform's own order (placed by this process / tracked pending) triggers nothing
    assert(await bookkeeping.noteBrokerOrderEvent('kite', { orderId: 'OWN1', side: 'Sell', tsym: TS, filled: true }) === false, 'an own order event is not foreign');
    pending = [{ orderId: 'PEND1', userId: 'ContinuousStrategy', tradingSymbol: TS, action: 'Sell', quantity: 65 }];
    assert(await bookkeeping.noteBrokerOrderEvent('kite', { orderId: 'PEND1', side: 'Sell', tsym: TS, filled: true }) === false, 'a tracked pending order is not foreign');
    pending = [];
    b.processedFillIds.add('kite|BOOKED1');
    assert(await bookkeeping.noteBrokerOrderEvent('kite', { orderId: 'BOOKED1', side: 'Sell', tsym: TS, filled: true }) === false, 'an already booked order is not foreign');
    await sleep(100);
    assert(runLog.length === 0, 'none of those triggered a check');
    // a foreign BUY, and a foreign sell of a contract the platform does not hold: no check
    assert(await bookkeeping.noteBrokerOrderEvent('kite', { orderId: 'FB1', side: 'Buy', tsym: TS, filled: true }) === true, 'a foreign buy is foreign');
    assert(await bookkeeping.noteBrokerOrderEvent('kite', { orderId: 'FS0', side: 'Sell', tsym: 'OTHER', filled: true }) === true, 'a foreign sell of another contract is foreign');
    await sleep(100);
    assert(runLog.length === 0, 'a foreign buy / a sell of a contract the platform does not hold schedule nothing');
    // the user's sell of the platform's lots: the stream rows arrive (several rows of one order), the check books it once
    for (let i = 0; i < 5; i++) await bookkeeping.noteBrokerOrderEvent('kite', { orderId: rb.u3, side: 'Sell', tsym: TS, filled: true });
    await sleep(3800); // settle + the 3 s confirm read
    const sells = docs.filter((d) => d.action === 'Sell');
    assert(runLog.length === 1 && /foreign-sell-event/.test(runLog[0]), `5 rows of the same sell = one check (${runLog.join(',')})`);
    assert(sells.length === 1 && sells[0].brokerOrderId === rb.u3 && sells[0].price === 104 && sells[0].quantity === 195 && sells[0].user === 'ContinuousStrategy', 'booked at the trade-book price under the broker order id');
    assert(notified.length === 1 && notified[0].action === 'Sell' && b.trades.length === 0, 'the strategy was told (leg closes) and the platform book is flat');
    assert(!docs.some((d) => /^U2/.test(d.brokerOrderId)), "the user's own 1755 sell is not booked");
    await sleep(600);
    assert(runLog.length === 1, 'the sell the check booked did not re-trigger a check');
    // a second event, a poll and a restart's memory: nothing more
    b.trades.push(trade('ContinuousStrategy', 195, 114.77)); b.processedFillIds.clear();
    await bookkeeping.noteBrokerOrderEvent('kite', { orderId: rb.u3, side: 'Sell', tsym: TS, filled: true });
    await sleep(3800);
    assert(docs.filter((d) => d.action === 'Sell').length === 1, 'a second event / a restart book nothing more (idempotent by order id)');

    // any booked platform trade re-checks the contract
    reset(); runLog.length = 0; useFastWatch(); b.runForeignCheck = async (br: any, ts: string, r: any) => { runLog.push(`${br}|${ts}|${r.join('+')}`); };
    brokerNet = 195; b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    const buy = trade('SimpleContinuous', 65, 100); buy.brokerOrderId = uid('BUY');
    await bookkeeping.recordFill(buy);
    await sleep(200);
    assert(runLog.length === 1 && /kite\|NIFTY26NOV25550CE\|own-trade/.test(runLog[0]), `a booked platform buy schedules the check (${runLog.join(',')})`);
    b.runForeignCheck = origRun;

    // GTT contract: a foreign sell newer than 2 min waits for the GTT poll
    reset(); useFastWatch();
    brokerNet = 0;
    const gt = trade('ContinuousStrategy', 195, 114.77); gt.gttTriggerId = 99 as any; b.trades.push(gt);
    const k = uid('g');
    book = [f('P1', '1', 'Buy', 195, 114, 25), { orderId: `G-${k}`, tradeId: 't', action: 'Sell', tsym: TS, qty: 195, price: 104, at: Date.now() - 30_000 }];
    let n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, graceMs: 5000, confirm: false, quiet: true });
    assert(n === 0 && b.trades.length === 1, 'a sell on a contract with a live GTT is left to the GTT poll for 2 minutes');
    book = [f('P1', '1', 'Buy', 195, 114, 25), { orderId: `G-${k}`, tradeId: 't', action: 'Sell', tsym: TS, qty: 195, price: 104, at: Date.now() - 130_000 }];
    n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, graceMs: 5000, confirm: false, quiet: true });
    assert(n === 1 && b.trades.length === 0, 'after 2 minutes it is booked');

    // (3) NEVER-SHORT refusal = trigger of a repair + one line ------------------------------------------------------------------------------------------
    reset(); useFastWatch(30, 400);
    brokerNet = 0; rb = realBook(); book = rb.rows;
    b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    for (let i = 0; i < 20; i++) bookkeeping.requestNeverShortRepair('kite', TS); // a retry storm
    await sleep(3800);
    const repairLines = logs.filter((l) => /NEVER-SHORT repair kite/.test(l));
    assert(docs.filter((d) => d.action === 'Sell').length === 1 && notified.length === 1, 'a refusal storm booked the sell once and told the strategy');
    assert(repairLines.some((l) => /a sell made outside the platform took the platform's lots.*U3-/.test(l) && /now matches the broker/.test(l)), `one line says what happened (a): ${repairLines[0]?.slice(0, 160)}`);
    assert(b.foreignWatch.runs === 1, `the storm of 20 refusals ran the repair once (${b.foreignWatch.runs})`);
    // flat: the platform holds nothing, the caller's leg is stale
    reset(); useFastWatch(30, 400);
    bookkeeping.requestNeverShortRepair('kite', TS); await sleep(200);
    assert(logs.some((l) => /NEVER-SHORT repair kite .*holds nothing on this contract/.test(l)) && logs.filter((l) => /ALERT: NEVER-SHORT refusal/.test(l)).length === 1, '(b) platform flat: stale leg named, one ALERT');
    bookkeeping.requestNeverShortRepair('kite', TS); await sleep(700);
    assert(logs.filter((l) => /ALERT: NEVER-SHORT refusal/.test(l)).length === 1, 'the ALERT is once per contract per 10 min');
    // lots missing at the broker but no non-platform sell explains it (stale leg / lock)
    reset(); useFastWatch(30, 400);
    brokerNet = 0; book = [f('P1', '1', 'Buy', 195, 114, 25)]; b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    bookkeeping.requestNeverShortRepair('kite', TS); await sleep(3800);
    assert(logs.some((l) => /NEVER-SHORT repair kite .*NOT explained by a booked non-platform sell/.test(l)) && b.trades.length === 1, '(b) not explained: nothing booked, line says a human/reconcile must fix it');
    // covered by resting sells at the broker (the opposite mismatch): no lots missing
    reset(); useFastWatch(30, 400);
    brokerNet = 195; b.trades.push(trade('ContinuousStrategy', 195, 114.77));
    bookkeeping.requestNeverShortRepair('kite', TS); await sleep(300);
    assert(logs.some((l) => /broker holds at least that.*RESTING sells/.test(l)) && b.trades.length === 1, 'resting-sell mismatch: reported, nothing booked, nothing cancelled');

    // (4) several holders ------------------------------------------------------------------------------------------------------------------------------
    const multi = async (holders: [string, number][], rests: [string, number][], excess: number) => {
        reset(); const kk = uid('m');
        const total = holders.reduce((a, h) => a + h[1], 0);
        brokerNet = total - excess;
        for (const [u, q] of holders) b.trades.push(trade(u, q, 110));
        pending = rests.map(([u, q], i) => ({ orderId: `R${i}-${kk}`, userId: u, tradingSymbol: TS, action: 'Sell' as const, quantity: q }));
        book = [f(`MS-${kk}`, '1', 'Sell', excess, 104, 36)];
        const n = await bookkeeping.bookForeignSellShortfall('kite', { notifyStrategies: true, graceMs: 0, confirm: false });
        return { n, kk };
    };
    let r = await multi([['A', 130], ['B', 65]], [['A', 130]], 65);
    assert(r.n === 1 && b.trades.length === 1 && b.trades[0].user === 'A' && notified[0].user === 'B', 'A holds 130 all under a resting sell, B 65 free: booked against B (strategy B told)');
    r = await multi([['A', 130], ['B', 65]], [], 65);
    assert(r.n === 1 && notified[0].user === 'B' && b.trades.find((t: Trade) => t.user === 'A').quantity === 130, 'no resting sells, excess 65 = exactly B\'s quantity: booked against B');
    r = await multi([['A', 65], ['B', 65]], [], 65);
    assert(r.n === 0 && b.trades.length === 2 && logs.some((l) => /ALERT.*cannot be told from the evidence.*A holds 65.*B holds 65/.test(l)), 'equal quantities, no resting sells: ALERT naming the candidates, nothing booked');
    r = await multi([['A', 130], ['B', 65]], [['A', 130], ['B', 65]], 65);
    assert(r.n === 0 && b.trades.length === 2 && logs.some((l) => /ALERT.*cannot be told from the evidence/.test(l)), 'every holder covered by a resting sell: ALERT, nothing booked');
    // (the last case: two candidates with free 65 each)
    r = await multi([['A', 130], ['B', 65]], [['A', 65]], 65);
    assert(r.n === 0, 'two candidates with the same free quantity: not booked');

    // (5) a fill time from the order-update stream completes a trade-book row without one
    reset();
    b.eventFillTimes.set('ant|ANT1', T0 + 36 * 60_000);
    const merged = b.applyEventFillTimes('ant', { fills: [], untimed: [{ orderId: 'ANT1', tsym: TS, action: 'Sell', qty: 195, price: 104, tradeId: 'ANT1#0' }, { orderId: 'ANT2', tsym: TS, action: 'Sell', qty: 5, price: 104 }] });
    assert(merged.fills.length === 1 && merged.fills[0].at === T0 + 36 * 60_000 && merged.untimed.length === 1 && merged.untimed[0].orderId === 'ANT2', 'untimed row takes the stream fill time; a row with no stream time stays untimed (nothing booked on a guess)');

    Log.log = realLog;
    out(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { Log.log = realLog; console.error(e); process.exit(1); });
