/**
 * Add-more on a position that already holds a Kite GTT: the loss budget must hold for the MERGED position
 * (kiteExecutor.reprotectToBudget, bookkeeping.tightenStopToLossBudget, exitMonitor hard stop).
 * Run: npx tsc && node ./dist/test/reprotectToBudget.test.js
 */
import { Trade, OptionQuote } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import * as exitMonitor from '../processes/order/exitMonitor';
import { reprotectToBudget, reprotectDelay } from '../processes/order/kiteExecutor';

function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exitCode = 1; }
const TSYM = 'NIFTY26D0125800PE';
const USER = 'reprotect-user';
const kite = Kite.getInstance() as any;
reprotectDelay.sleep = async () => undefined;

let events: string[] = [];
let book: any[] = [];
let failDelete = false;
let failPlace = 0;
let placed: any[] = [];
let nextId = 900;
kite.hasValidSession = async () => false; // the GTT poll the helper may kick returns at once
kite.getGTTs = async () => book;
kite.deleteGTT = async (id: number) => { events.push(`del ${id}`); if (failDelete) throw new Error('network'); book = book.filter((g) => g.id !== id); };
kite.placeTargetStopLossGTT = async (tsym: string, exch: string, qty: number, entry: number, tp: number, sp: number, last: number) => {
    events.push('place');
    if (failPlace > 0) { failPlace--; throw new Error('rejected'); }
    const id = nextId++;
    placed.push({ id, qty, stop: entry - sp, target: entry + tp, last });
    book.push({ id, status: 'active', condition: { tradingsymbol: tsym, trigger_values: [entry - sp, entry + tp] }, orders: [{ quantity: qty }, { quantity: qty }] });
    return id;
};

bookkeeping.updateUserSettings(USER, { lossLimit: 1e9, lotLimit: 100, maxInvestment: 1e9, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'beginner' } as any);
const live = (id: number, qty: number, stop: number, target: number, status = 'active') => ({ id, status, condition: { tradingsymbol: TSYM, trigger_values: [stop, target] }, orders: [{ quantity: qty }, { quantity: qty }] });

function mergedRow(): Trade {
    const t = Object.assign(new Trade(), { tsym: TSYM, token: 'rp-tok', user: USER, broker: 'kite', action: 'Buy', status: 'COMPLETE', quantity: 1040, price: 178.075, lastTradePrice: 178.1,
        stopLossPrice: 160.05, targetPrice: 181.25, gttTriggerId: 346264900, extraGttTriggerIds: [346265018] });
    bookkeeping.trades.push(t);
    return t;
}
function reset(row?: Trade) { events = []; placed = []; failDelete = false; failPlace = 0; if (row) { const i = bookkeeping.trades.indexOf(row); if (i >= 0) bookkeeping.trades.splice(i, 1); } }

async function main() {
    // 1. the live case: two lots of 520, GTT stops 160.05 / 157.7, budget stop of the merged 1040 is 168.5
    let row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    assert(bookkeeping.tightenStopToLossBudget(USER, 'kite', TSYM) === true && row.stopLossPrice === 168.5, 'tighten: the merged stop is raised to 168.5');
    assert(row.hardStopPrice === 168.5, 'the in-app hard stop is armed at once at the budget stop');
    await reprotectToBudget(USER, TSYM);
    assert(events.join(',') === 'del 346264900,del 346265018,place', `both old GTTs are deleted before the single new placement (${events.join(',')})`);
    assert(placed.length === 1 && placed[0].qty === 1040 && placed[0].stop === 168.5 && placed[0].target === 181.25, 'ONE new GTT for the merged qty 1040 at the budget stop 168.5 and the target');
    assert(row.gttTriggerId === placed[0].id && row.extraGttTriggerIds === undefined && row.hardStopPrice === undefined, 'the row holds only the new GTT id; the hard backup is cleared');
    assert(book.filter((g) => g.status === 'active').length === 1, 'exactly one live GTT remains at the broker');
    reset(row);

    // 2. an old GTT cannot be cancelled (still active in the book): kept, nothing placed, in-app hard stop acts at the budget stop
    row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    bookkeeping.tightenStopToLossBudget(USER, 'kite', TSYM);
    failDelete = true;
    await reprotectToBudget(USER, TSYM);
    assert(!events.includes('place') && placed.length === 0, 'cancel failed: no second GTT is placed');
    assert(row.gttTriggerId === 346264900 && row.extraGttTriggerIds?.[0] === 346265018, 'the still-live GTT ids are kept on the row');
    assert(row.hardStopPrice === 168.5, 'the in-app hard stop stays armed at 168.5');
    let sold = 0;
    exitMonitor.onExit('kite', async () => { sold++; });
    const q = (ltp: number) => { const o = new OptionQuote(); o.token = 'rp-tok'; o.ltp = ltp; o.ltt = Date.now(); return o; };
    await exitMonitor.handleOptionTick(q(170));
    assert(sold === 0, 'above the budget stop the watch-only monitor does not sell');
    await exitMonitor.handleOptionTick(q(168.4));
    assert(sold === 1, 'at/below the budget stop the in-app hard stop sells although the broker GTT is looser');
    exitMonitor.unregisterTrade(USER, 'rp-tok', 'kite');
    reset(row);

    // 3. a GTT triggered meanwhile is never replaced
    row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25, 'triggered'), live(346265018, 520, 157.7, 178.9)];
    await reprotectToBudget(USER, TSYM);
    assert(events.length === 0, 'a triggered GTT: nothing deleted, nothing placed (the GTT poll books the exit)');
    reset(row);

    // 4. the cancel reports an error but the book shows the GTT gone: confirmed at the broker, then the new GTT is placed
    row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    bookkeeping.tightenStopToLossBudget(USER, 'kite', TSYM);
    kite.deleteGTT = async (id: number) => { events.push(`del ${id}`); book = book.filter((g) => g.id !== id); throw new Error('timeout after the broker applied it'); };
    await reprotectToBudget(USER, TSYM);
    assert(placed.length === 1 && placed[0].qty === 1040, 'a failed cancel that the book shows as gone is treated as cancelled, then one GTT is placed');
    kite.deleteGTT = async (id: number) => { events.push(`del ${id}`); if (failDelete) throw new Error('network'); book = book.filter((g) => g.id !== id); };
    reset(row);

    // 5. the new placement keeps failing: ALERT, no GTT, the in-app monitor owns the exit (the old GTTs are already gone)
    row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    bookkeeping.tightenStopToLossBudget(USER, 'kite', TSYM);
    failPlace = 99;
    await reprotectToBudget(USER, TSYM);
    assert(events.filter((e) => e === 'place').length === 4, 'the placement is retried with backoff (4 attempts)');
    assert(row.gttTriggerId == null && row.stopLossPrice === 168.5, 'no GTT: the in-app monitor (active, stop 168.5) owns the exit');
    reset(row);

    // 6. already aligned (one GTT, full quantity, budget stop): untouched
    row = mergedRow();
    row.extraGttTriggerIds = undefined; row.stopLossPrice = 168.5;
    book = [live(346264900, 1040, 168.5, 181.25)];
    await reprotectToBudget(USER, TSYM);
    assert(events.length === 0, 'a GTT that already covers the quantity at the budget stop is left alone');
    reset(row);

    // 7. position sold while the cancels run: no GTT placed for a closed position
    row = mergedRow();
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    bookkeeping.tightenStopToLossBudget(USER, 'kite', TSYM);
    kite.deleteGTT = async (id: number) => { events.push(`del ${id}`); book = book.filter((g) => g.id !== id); const i = bookkeeping.trades.indexOf(row); if (i >= 0) bookkeeping.trades.splice(i, 1); };
    await reprotectToBudget(USER, TSYM);
    assert(placed.length === 0, 'the position closed meanwhile: no GTT placed');
    reset(row);

    // 8. a user without a budget (lotCount) and a strategy row are untouched
    bookkeeping.updateUserSettings('nobudget', { lossLimit: 1e9, lotLimit: 100, maxInvestment: 1e9, investmentMode: 'lotCount' } as any);
    const other = Object.assign(mergedRow(), { user: 'nobudget' });
    book = [live(346264900, 520, 160.05, 181.25), live(346265018, 520, 157.7, 178.9)];
    await reprotectToBudget('nobudget', TSYM);
    assert(events.length === 0, 'a user with no loss budget is not touched');
    reset(other);
    process.exit(process.exitCode ?? 0);
}
main();
