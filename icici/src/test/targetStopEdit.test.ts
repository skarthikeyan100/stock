/**
 * Editing target / stop-loss of an open position (kiteExecutor.setTargetStopLoss, POST /order/settarget): saved for a restart, held to the
 * loss budget, moves the in-app hard stop, rolled back when the Kite GTT cannot be changed, enforced when only one side is set, and a level
 * the live price has already crossed is refused.
 * Run: npx tsc && node ./dist/test/targetStopEdit.test.js
 */
import { Trade, OptionQuote } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import Mongo from '../tools/mongo';
import * as exitMonitor from '../processes/order/exitMonitor';
import { setTargetStopLoss } from '../processes/order/kiteExecutor';
import { lossBudgetStopPrice } from '../levelLimits';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 'tse-user';

const saved: Array<{ filter: any; set: any }> = [];
(Mongo as any).getInstance = () => ({
    db: { collection: () => ({ findOneAndUpdate: async (filter: any, u: any) => { saved.push({ filter, set: u.$set }); return { value: {} }; }, updateMany: async () => ({ matchedCount: 1 }) }) },
    insert: async () => undefined,
});
const kite = Kite.getInstance() as any;
let modified: Array<{ id: number; qty: number; target: number; stop: number }> = [];
let failModify = false;
kite.hasValidSession = async () => false;
kite.getGTTs = async () => [];
kite.modifyTargetStopLossGTT = async (id: number, _t: string, _e: string, qty: number, target: number, stop: number) => {
    if (failModify) throw new Error('GTT modify refused');
    modified.push({ id, qty, target, stop });
};

// capital 100000, beginner: the budget comes from config.yml settings.levelRules
bookkeeping.updateUserSettings(USER, { lossLimit: 1e9, lotLimit: 100, maxInvestment: 1e9, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'beginner' } as any);

let n = 0;
function position(extra: Partial<Trade> = {}): Trade {
    n++;
    const t = Object.assign(new Trade(), { tsym: `NIFTY26D01${25000 + n * 50}CE`, token: `tse-${n}`, user: USER, broker: 'kite', action: 'Buy', status: 'COMPLETE', quantity: 650, price: 150, lastTradePrice: 150, ...extra });
    bookkeeping.trades.push(t);
    return t;
}
const refusal = async (t: Trade, target: number, stop: number): Promise<string> => {
    try { await setTargetStopLoss(USER, t.token, target, stop, 'kite'); return ''; } catch (e: any) { return String(e?.message ?? e); }
};
let sold: string[] = [];
const tick = async (t: Trade, ltp: number) => { const q = new OptionQuote(); q.token = t.token; q.ltp = ltp; q.ltt = Date.now(); await exitMonitor.handleOptionTick(q); };

async function main() {
    exitMonitor.onExit('kite', async (t) => { sold.push(t.tsym); });
    const budgetStop = lossBudgetStopPrice(bookkeeping.lossBudgetFor(USER)!, 650, 150)!;
    assert(budgetStop > 100 && budgetStop < 149, `test setup: the budget stop of 650 @ 150 is ${budgetStop}`);

    // 1. an edit is saved on the newest Buy document, so a restart keeps it
    let t = position({ targetPrice: 153, stopLossPrice: 145 });
    saved.length = 0;
    await setTargetStopLoss(USER, t.token, 8, 4, 'kite');
    await sleep(20);
    assert(t.targetPrice === 158 && t.stopLossPrice === 146, `the edit replaces both levels (${t.targetPrice} / ${t.stopLossPrice})`);
    assert(saved.length === 1 && saved[0].set.targetPrice === 158 && saved[0].set.stopLossPrice === 146 && saved[0].filter.tsym === t.tsym && saved[0].filter.user === USER && saved[0].filter.action === 'Buy',
        `both levels are saved for a restart (${JSON.stringify(saved)})`);

    // 2. a wider stop than the loss budget allows is capped at the budget stop
    await setTargetStopLoss(USER, t.token, 0, 120, 'kite');
    assert(t.stopLossPrice === budgetStop && t.targetPrice === 158, `the stop is held to the loss budget (${t.stopLossPrice}), the target stays`);
    // a strategy position is not budgeted
    t = position({ strategy: 'SomeStrategy' } as any);
    await setTargetStopLoss(USER, t.token, 0, 120, 'kite');
    assert(t.stopLossPrice === 30, `a strategy position keeps the asked stop (${t.stopLossPrice})`);

    // 3. the in-app hard stop follows a changed stop, and stays when the stop is not changed
    t = position({ targetPrice: 160, stopLossPrice: 148, hardStopPrice: 148, gttTriggerId: 501 });
    await setTargetStopLoss(USER, t.token, 12, 5, 'kite');
    assert(t.stopLossPrice === 145 && t.hardStopPrice === 145, `a loosened stop moves the hard stop with it (${t.hardStopPrice})`);
    assert(modified.some((m) => m.id === 501 && m.stop === 145 && m.target === 162), 'the Kite GTT is changed to the new levels');
    t = position({ targetPrice: 160, stopLossPrice: 140, hardStopPrice: 146, gttTriggerId: 502 });
    await setTargetStopLoss(USER, t.token, 12, 10, 'kite');
    assert(t.hardStopPrice === 146 && t.targetPrice === 162, `a target-only change (stop resent unchanged) leaves a tighter hard stop alone (${t.hardStopPrice})`);

    // 4. a GTT that cannot be changed leaves the previous levels
    t = position({ targetPrice: 160, targetPoints: 10, stopLossPrice: 145, hardStopPrice: 145, gttTriggerId: 503 });
    failModify = true;
    saved.length = 0;
    const err = await refusal(t, 20, 3);
    failModify = false;
    await sleep(20);
    assert(/GTT modify refused/.test(err), `the failure is reported (${err})`);
    assert(t.targetPrice === 160 && t.targetPoints === 10 && t.stopLossPrice === 145 && t.hardStopPrice === 145, `the previous levels are kept (${t.targetPrice} / ${t.stopLossPrice} / ${t.hardStopPrice})`);
    assert(saved.length === 0, 'nothing is saved');

    // 5. one side only is enforced by the in-app monitor
    t = position();
    await setTargetStopLoss(USER, t.token, 0, 5, 'kite');
    sold = [];
    await tick(t, 144.9);
    assert(sold.join() === t.tsym, 'a stop alone is watched and sells');
    t = position();
    await setTargetStopLoss(USER, t.token, 5, 0, 'kite');
    sold = [];
    await tick(t, 155.1);
    assert(sold.join() === t.tsym, 'a target alone is watched and sells');

    // 6. a level the live price has already crossed would sell at once: refused, nothing changed
    t = position({ targetPrice: 170, stopLossPrice: 140, lastTradePrice: 146 });
    const e1 = await refusal(t, 0, 3);
    assert(/at once/.test(e1) && t.stopLossPrice === 140, `a stop at or above the live price is refused (${e1})`);
    t = position({ targetPrice: 170, stopLossPrice: 140, lastTradePrice: 156 });
    const e2 = await refusal(t, 5, 0);
    assert(/at once/.test(e2) && t.targetPrice === 170, `a target at or below the live price is refused (${e2})`);
    // an unchanged level resent with the other one is not refused
    t = position({ targetPrice: 155, stopLossPrice: 140, lastTradePrice: 156 });
    assert((await refusal(t, 5, 8)) === '' && t.stopLossPrice === 142, 'an unchanged target does not block a stop change');

    // 7. the route says why a change was refused
    const session = require('../routes/session');
    const users = require('../user');
    session.resolveUser = () => 'admin@test';
    users.getUser = async () => ({ role: 'admin' });
    const OrderClient = require('../processes/strategies/OrderClient').default;
    OrderClient.getInstance().setTargetStopLoss = async () => { throw new Error('the stop 149 is at or above the live price 146: it would sell at once'); };
    const routes = require('../routes/trading');
    const router = routes.default ?? routes.router;
    const layer = router.stack.find((l: any) => l.route?.path === '/order/settarget');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const reply: any = {};
    const res: any = { status: (c: number) => { reply.status = c; return res; }, json: (b: any) => { reply.body = b; return res; }, sendStatus: (c: number) => { reply.status = c; return res; } };
    await handler({ body: { token: 'x', targetPoints: 0, stopLossPoints: 1 }, headers: {}, query: {} }, res);
    await sleep(50);
    assert(reply.status === 409 && /sell at once/.test(reply.body?.error ?? ''), `the reason reaches the page (${reply.status} ${JSON.stringify(reply.body)})`);
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.log('FAIL:', e); process.exit(1); });
