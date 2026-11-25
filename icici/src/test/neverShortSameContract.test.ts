/**
 * NEVER-SHORT guard when several owners / GTTs / exits touch ONE contract (2026-11-25 user report: "no-one has attempted to short").
 * Covers: cause classes, owner-aware cap, a merged row's extra GTT firing (live 2026-11-25 12:29:40 NIFTY26D0125800PE), a GTT firing while a
 * manual/in-app sell is booked, the exit monitor + GTT duplicate exit, brokers sharing a token, a duplicate resting exit (no ALERT).
 * Run: npx tsc && node ./dist/test/neverShortSameContract.test.js
 */
import { Trade, OptionQuote } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import Log from '../util/Log';
import * as exitMonitor from '../processes/order/exitMonitor';
import { pollGttFills, squareOffOnKite } from '../processes/order/kiteExecutor';
import { neverShortSellable } from '../processes/order/BrokerExecutor';
import { classifyRefusal, ownerSellCap } from '../processes/order/neverShortClass';

function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exitCode = 1; }

const lines: string[] = [];
const origLog = Log.log.bind(Log);
(Log as any).log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
const say = (m: string) => origLog(m);

const TSYM = 'NIFTY26D0125800PE';
const USER = 'skarthikeyan100@gmail.com';
const kite = Kite.getInstance() as any;
let gttBook: any[] = [];
let orderBook: any[] = [];
const deleted: number[] = [];
kite.hasValidSession = async () => true;
kite.getGTTs = async () => gttBook;
kite.getKiteConnect = () => ({ getOrders: async () => orderBook });
kite.deleteGTT = async (id: number) => { const g = gttBook.find((x) => x.id === id); if (g && g.status !== 'active') throw new Error('Trigger not found'); deleted.push(id); gttBook = gttBook.filter((x) => x.id !== id); };

const gtt = (id: number, status: string, target: number, stop: number, orderId?: string) => ({
    id, status, condition: { tradingsymbol: TSYM, trigger_values: [stop, target] },
    orders: [{ quantity: 520 }, { quantity: 520, ...(orderId ? { result: { order_result: { order_id: orderId, status: 'COMPLETE' } } } : {}) }],
});
const sellOrder = (id: string, qty: number, price: number) => ({ order_id: id, tradingsymbol: TSYM, transaction_type: 'SELL', status: 'COMPLETE', filled_quantity: qty, average_price: price, order_timestamp: new Date().toISOString() });

function mergedRow(user = USER): Trade {
    const t = Object.assign(new Trade(), { tsym: TSYM, token: '47846', user, broker: 'kite', action: 'Buy', status: 'COMPLETE', quantity: 1040, price: 178.075, lastTradePrice: 181.4,
        entryTime: new Date(Date.now() - 3 * 60_000), stopLossPrice: 168.5, targetPrice: 181.25, gttTriggerId: 346264900, extraGttTriggerIds: [346265018] });
    bookkeeping.trades.push(t);
    return t;
}
function dropRows() { for (let i = bookkeeping.trades.length - 1; i >= 0; i--) if (bookkeeping.trades[i].tsym === TSYM) bookkeeping.trades.splice(i, 1); }

async function main() {
    // ---- 1. cause classes ----
    say('classes');
    assert(classifyRefusal({ requested: 130, live: 130, ownResting: 130, othersResting: 0, ownHeld: 130 }).cls === 'already-resting', 'a duplicate exit (own resting == live, 2026-11-04 Breeze 130/130) is already-resting');
    assert(classifyRefusal({ requested: 130, live: 130, ownResting: 130, othersResting: 0 }).real === false, 'already-resting is not a data fault (no ALERT)');
    assert(classifyRefusal({ requested: 195, live: 0, ownResting: 0, othersResting: 0, ownHeld: 0 }).cls === 'stale-leg', '2026-11-25 12:10 ANT (live 0, platform holds nothing): stale-leg');
    assert(classifyRefusal({ requested: 780, live: 0, ownResting: 780, othersResting: 0, ownHeld: 780 }).cls === 'stale-resting', '2026-11-16 Breeze live 0 with 780 tracked resting: stale-resting');
    assert(classifyRefusal({ requested: 520, live: 0, ownResting: 0, othersResting: 0, ownHeld: 520 }).cls === 'unbooked-sell', 'broker flat, platform holds 520: unbooked-sell (the 12:30 case)');
    assert(classifyRefusal({ requested: 65, live: 585, ownResting: 520, othersResting: 65 }).cls === 'other-owner-resting', '2026-11-18 live 585 / own 520 / others 65: other-owner-resting');
    assert(ownerSellCap({ own: 65, others: 65 }, 0) === 65 && ownerSellCap({ own: 130, others: 0 }, 0) === undefined && ownerSellCap({ own: 0, others: 65 }, 0) === undefined, 'owner cap only with another owner on the contract');

    // ---- 2. the guard: duplicate exit = no ALERT; real = ALERT with class; owner-aware cap ----
    say('guard');
    lines.length = 0;
    let threw = false;
    try { await neverShortSellable({ label: 'NIFTY23900CE (SimpleContinuousStrategy-Breeze, Breeze)', quantity: 130, livePosition: async () => 130, restingSellQuantity: 130 }); } catch { threw = true; }
    assert(threw, 'the duplicate exit is still refused');
    assert(lines.some((l) => /refused a sell of 130/.test(l) && !/ALERT/.test(l) && /cause class: already-resting/.test(l)), 'refused WITHOUT an ALERT and with its cause class');
    lines.length = 0; threw = false;
    try { await neverShortSellable({ label: 'NIFTY01DEC26C25950 (SimpleContinuousStrategy-ANT, ANT)', quantity: 195, livePosition: async () => 0, restingSellQuantity: 0, ownerHeld: 0, othersHeld: 0 }); } catch { threw = true; }
    assert(threw && lines.some((l) => /ALERT: NEVER-SHORT GUARD refused/.test(l) && /cause class: stale-leg/.test(l)), 'a real inconsistency still ALERTs and names stale-leg');
    // two strategies, one Breeze account, one contract: A holds 65, B holds 65, broker net 130
    lines.length = 0;
    let q = await neverShortSellable({ label: 'X (A, Breeze)', quantity: 130, livePosition: async () => 130, restingSellQuantity: 0, ownerHeld: 65, othersHeld: 65 });
    assert(q === 65 && lines.some((l) => /clamped a sell of X \(A, Breeze\) from 130 to 65/.test(l) && /other-owner-lots/.test(l)), 'A cannot sell B\'s lots: 130 clamped to A\'s own 65');
    q = await neverShortSellable({ label: 'X (A, Breeze)', quantity: 65, livePosition: async () => 130, restingSellQuantity: 0, ownerHeld: 65, othersHeld: 65 });
    assert(q === 65, 'A\'s own 65 is sold untouched while B holds its 65 (partial close of one while the other rests)');
    q = await neverShortSellable({ label: 'X (A, Breeze)', quantity: 65, livePosition: async () => 130, restingSellQuantity: 65, ownerHeld: 65, othersHeld: 65 }).catch(() => -1);
    assert(q === -1, 'A whose own 65 already rest is refused a second sell (does not eat B\'s lots)');
    q = await neverShortSellable({ label: 'X (A, Breeze)', quantity: 130, livePosition: async () => 130, restingSellQuantity: 0, ownerHeld: 130, othersHeld: 0 });
    assert(q === 130, 'a single owner is unaffected (no cap)');
    q = await neverShortSellable({ label: 'X (A, Breeze)', quantity: 195, livePosition: async () => 65, restingSellQuantity: 0, ownerHeld: 195, othersHeld: 0 }).catch(() => -1);
    assert(q === 65, 'the broker-net floor still clamps a real over-sell (195 vs live 65)');

    // ownerHoldings keys (broker, contract, owner): ANT and Prism with one token never share a row
    bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTY25D0225800PE', token: '47893', user: 'SimpleContinuousStrategy-ANT', broker: 'ant', quantity: 65 }));
    bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTY25D0225800PE', token: '47893', user: 'SimpleContinuousStrategy-Prism', broker: 'prism', quantity: 130 }));
    const hAnt = bookkeeping.ownerHoldings('ant', 'NIFTY25D0225800PE', 'SimpleContinuousStrategy-ANT');
    const hPrism = bookkeeping.ownerHoldings('prism', 'NIFTY25D0225800PE', 'SimpleContinuousStrategy-Prism');
    assert(hAnt.own === 65 && hAnt.others === 0 && hPrism.own === 130 && hPrism.others === 0, 'same token on two brokers: separate accounts, no other owner on either');
    bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTY25D0225800PE', token: '47893', user: 'ScaledHedgedStrategy-ANT', broker: 'ant', quantity: 65 }));
    assert(bookkeeping.ownerHoldings('ant', 'NIFTY25D0225800PE', 'SimpleContinuousStrategy-ANT').others === 65 && bookkeeping.ownerHoldings('prism', 'NIFTY25D0225800PE', 'SimpleContinuousStrategy-Prism').others === 0, 'two ANT owners see each other; Prism does not');
    for (let i = bookkeeping.trades.length - 1; i >= 0; i--) if (bookkeeping.trades[i].tsym === 'NIFTY25D0225800PE') bookkeeping.trades.splice(i, 1);

    // ---- 3. the live case: a merged row's EXTRA GTT fires, then the primary ----
    say('merged-row GTTs');
    let row = mergedRow();
    exitMonitor.registerTrade(row, 'NFO', 'kite', true);
    let exitSells = 0;
    exitMonitor.onExit('kite', async () => { exitSells++; });
    gttBook = [gtt(346264900, 'active', 181.25, 160.05), gtt(346265018, 'triggered', 178.9, 157.7, '2125484549093126144')];
    orderBook = [sellOrder('2125484549093126144', 520, 178.9)];
    // before the poll: the platform does not know the order id yet, but the GTT book says it is the platform's own
    const gttSupport = (bookkeeping as any).gttSupport;
    const own = await gttSupport.exitOrderIds();
    assert(own.has('2125484549093126144'), 'the fired extra GTT\'s sell order is known as the platform\'s own before the poll books it (never "outside the platform")');
    lines.length = 0;
    await pollGttFills();
    assert(row.quantity === 520, `the extra GTT's 520 are booked as a platform sell (row now ${row.quantity})`);
    assert(row.gttTriggerId === 346264900 && row.extraGttTriggerIds === undefined, 'the live primary GTT stays on the row, the fired id is gone');
    await bookkeeping.whenGttReleased();
    assert(deleted.length === 0, 'the other lot\'s live GTT is NOT deleted by the fired GTT\'s booking');
    assert(bookkeeping.isFillProcessed('2125484549093126144') && bookkeeping.brokerOwnedExitOrderIds.has('2125484549093126144'), 'the fired order is registered as the platform\'s own');
    assert(!lines.some((l) => /outside the platform|NEVER-SHORT/.test(l)), 'no NEVER-SHORT / foreign-sell line');
    // the exit monitor stays watch-only above the target: no duplicate exit
    const quote = (ltp: number) => { const o = new OptionQuote(); o.token = '47846'; o.ltp = ltp; o.ltt = Date.now(); return o; };
    await exitMonitor.handleOptionTick(quote(181.4));
    assert(exitSells === 0, 'the exit monitor does not fire a second exit on top of the live GTT');
    // the primary fires too
    gttBook = [gtt(346264900, 'triggered', 181.25, 160.05, '2125484549093126999')];
    orderBook.push(sellOrder('2125484549093126999', 520, 181.6));
    await pollGttFills();
    assert(!bookkeeping.trades.includes(row) && row.quantity === 0, 'the primary GTT closes the rest: the row is flat');
    await exitMonitor.handleOptionTick(quote(181.4));
    assert(exitSells === 0, 'no exit attempt after the row is flat (no refusal to produce)');
    dropRows();

    // ---- 4. a manual/in-app sell is booked while an extra GTT has fired: the fired GTT is booked, not lost ----
    say('sell vs fired GTT');
    row = mergedRow();
    exitMonitor.registerTrade(row, 'NFO', 'kite', true);
    gttBook = [gtt(346264900, 'active', 181.25, 160.05), gtt(346265018, 'triggered', 178.9, 157.7, 'GT1')];
    orderBook = [sellOrder('GT1', 520, 178.9)];
    const manual = Object.assign(new Trade(), { tsym: TSYM, token: '47846', quantity: 520, price: 179, action: 'Sell', status: 'COMPLETE', user: USER, broker: 'kite', brokerOrderId: 'M1' });
    await bookkeeping.recordFill(manual);
    await bookkeeping.whenGttReleased();
    assert(bookkeeping.isFillProcessed('GT1'), 'the fired GTT\'s sell was booked when the row\'s GTTs were released');
    assert(!bookkeeping.trades.includes(row) || row.quantity <= 0 ? true : false, 'the two sells (520 + 520) close the 1040 row');
    dropRows();
    // both sold the same lots (nothing open to book against): a REAL inconsistency, ALERTed with its class
    row = mergedRow(); row.quantity = 520;
    gttBook = [gtt(346264900, 'active', 181.25, 160.05), gtt(346265018, 'triggered', 178.9, 157.7, 'GT2')];
    orderBook = [sellOrder('GT2', 520, 178.9)];
    lines.length = 0;
    await bookkeeping.recordFill(Object.assign(new Trade(), { tsym: TSYM, token: '47846', quantity: 520, price: 179, action: 'Sell', status: 'COMPLETE', user: USER, broker: 'kite', brokerOrderId: 'M2' }));
    await bookkeeping.whenGttReleased();
    assert(lines.some((l) => /ALERT: GTT 346265018/.test(l) && /gtt-and-exit-both-sold/.test(l)), 'GTT fired AND the platform sold the same lots: ALERT naming gtt-and-exit-both-sold');
    dropRows();

    // ---- 5. squareOff with a fired GTT on the row: the exit settles the GTT first (no duplicate sell) ----
    say('squareOff after a fired GTT');
    row = mergedRow(); row.quantity = 520; row.extraGttTriggerIds = undefined; row.gttTriggerId = 346265018;
    gttBook = [gtt(346265018, 'triggered', 178.9, 157.7, 'GT3')];
    orderBook = [sellOrder('GT3', 520, 178.9)];
    const r = await squareOffOnKite(USER, TSYM, 520);
    assert(r.quantity === 0 && !bookkeeping.trades.includes(row), 'the exit books the fired GTT and sells nothing more (520 already sold by the GTT)');
    dropRows();

    (Log as any).log = origLog;
    say(process.exitCode ? 'FAILED' : 'ALL PASSED');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { (Log as any).log = origLog; console.error(e); process.exit(1); });
