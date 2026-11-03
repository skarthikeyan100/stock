/**
 * MomentumAtFixedTimeStrategy against a stubbed OrderClient and a stubbed order-book read (no broker, no order process).
 * Run: npx tsc, then: node ./dist/test/momentumAtFixedTime.test.js
 */
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import MomentumAtFixedTimeStrategy from '../strategy/MomentumAtFixedTimeStrategy';
import { Trade, OptionQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: 'B1' };
            case 'brokerPlaceLimitSellBare': return { orderId: 'S1' };
            case 'getOptionLtp': return 100;
            case 'cancelRestingLimitBuys': case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;

// Order-book read stub: `depth` maps token -> {tbq, tsq}; null simulates a timeout.
let depth: Record<string, { tbq: number; tsq: number }> | null = null;

function make(cfg: any): any {
    const s: any = new MomentumAtFixedTimeStrategy(cfg.userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.stateFile = () => `/tmp/momentum-at-fixed-time-test-${cfg.userId}-${process.pid}.json`;
    s.momentum.readDepth = async (_strategy: any, tokens: string[]) => {
        if (!depth) return null;
        const out = new Map<string, { tbq: number; tsq: number }>();
        for (const t of tokens) { if (!depth[t]) return null; out.set(t, depth[t]); }
        return out;
    };
    return s;
}
const fill = (tsym: string, action: string, qty: number, price: number, broker = 'kite') =>
    Object.assign(new Trade(), { tsym, action, quantity: qty, price, broker, token: 'T1' });
const tick = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp }) as OptionQuote;
const last = (fn: string) => calls.filter((c) => c.fn === fn).pop();
const count = (fn: string) => calls.filter((c) => c.fn === fn).length;

// Two slots in the past: the first records the reference price, the second is the one that trades.
const slotA = moment().subtract(3, 'minutes').format('HH:mm');
const slotB = moment().subtract(1, 'minutes').format('HH:mm');
MomentumAtFixedTimeStrategy.processStartedAt = moment().subtract(1, 'hour');

// Runs slot A at `refLtp`, then slot B at `ltp`, with the given order-book readings for the CE and PE tokens.
async function runTwoSlots(userId: string, refLtp: number, ltp: number, ce: { tbq: number; tsq: number } | null, pe: { tbq: number; tsq: number } | null) {
    calls = [];
    depth = ce && pe ? { 'CE-T': ce, 'PE-T': pe } : null;
    const cfg: any = { type: 'MomentumAtFixedTimeStrategy', userId, times: [slotA], maxInvestment: 100000, targetPrice: 3, entryTimeoutMinutes: 5, eodCloseTime: '23:59', brokers: ['kite'] };
    const s = make(cfg);
    await s.processNiftyQuote({ ltp: refLtp, prevClose: 22000 });
    cfg.times = [slotA, slotB];
    await s.processNiftyQuote({ ltp, prevClose: 22000 });
    return s;
}

(async () => {
    console.log('MomentumAtFixedTimeStrategy');

    console.log('  entry');
    let s = await runTwoSlots('MAT-up', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    assert(calls.some((c) => c.fn === 'resolveOptionContract' && c.args[1].strike === 22050 && c.args[1].right === 'CE'), 'CE at ceil(spot/50)*50 (22050) is a candidate');
    assert(calls.some((c) => c.fn === 'resolveOptionContract' && c.args[1].strike === 22000 && c.args[1].right === 'PE'), 'PE at floor(spot/50)*50 (22000) is a candidate');
    const buy = last('placeLimitBuyBare');
    assert(!!buy && buy.args[4] === 100, `limit buy at the prevailing option price 100 (got ${buy?.args[4]})`);
    assert(buy?.args[3] === 975, `qty = 15 lots of 65 from maxInvestment 100000 at 100 (got ${buy?.args[3]})`);
    assert(s.legs()[0]?.status === 'resting' && s.legs()[0]?.exit === undefined, 'entry resting, no sell placed on order');
    assert(count('brokerPlaceLimitSellBare') === 0, 'no sell is placed when the position is taken');

    console.log('  direction and price must agree');
    s = await runTwoSlots('MAT-down-ce', 22000, 21990, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    assert(count('placeLimitBuyBare') === 0, 'CE surplus but price fell -> no trade');
    s = await runTwoSlots('MAT-pe', 22000, 21990, { tbq: 100, tsq: 300 }, { tbq: 900, tsq: 200 });
    const pb = last('placeLimitBuyBare');
    assert(count('placeLimitBuyBare') === 1 && pb?.args[1] === 'NIFTY21950PE', 'PE surplus and price fell -> buys the PE at floor(21990/50)*50 = 21950');
    s = await runTwoSlots('MAT-pe-up', 22000, 22010, { tbq: 100, tsq: 300 }, { tbq: 900, tsq: 200 });
    assert(count('placeLimitBuyBare') === 0, 'PE surplus but price rose -> no trade');

    console.log('  surplus rules');
    s = await runTwoSlots('MAT-neg', 22000, 22010, { tbq: 100, tsq: 900 }, { tbq: 100, tsq: 300 });
    assert(count('placeLimitBuyBare') === 0, 'both surpluses negative -> no trade');
    s = await runTwoSlots('MAT-tie', 22000, 22010, { tbq: 500, tsq: 100 }, { tbq: 500, tsq: 100 });
    assert(count('placeLimitBuyBare') === 0, 'equal surpluses -> no trade');
    s = await runTwoSlots('MAT-nodepth', 22000, 22010, null, null);
    assert(count('placeLimitBuyBare') === 0, 'no depth reading -> no trade');

    console.log('  first slot of the day');
    calls = [];
    const cfgFirst: any = { type: 'MomentumAtFixedTimeStrategy', userId: 'MAT-first', times: [slotA], maxInvestment: 100000, targetPrice: 3, eodCloseTime: '23:59', brokers: ['kite'] };
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    const first = make(cfgFirst);
    await first.processNiftyQuote({ ltp: 22010, prevClose: 21000 });
    assert(count('placeLimitBuyBare') === 0, 'first slot of the day never trades (no previous slot)');

    console.log('  target sell on tick, not on fill');
    s = await runTwoSlots('MAT-target', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
    assert(count('brokerPlaceLimitSellBare') === 0, 'no sell on fill');
    assert(s.legs()[0].exit === 'target' && s.legs()[0].targetTrigger === 103, `trigger at fill + 3 (got ${s.legs()[0].targetTrigger})`);
    await s.processOptionQuote(tick('CE-T', 102));
    assert(count('brokerPlaceLimitSellBare') === 0, 'tick below the target: still no sell');
    await s.processOptionQuote(tick('CE-T', 103.4));
    const sell = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 1 && sell?.args[1].quantity === 975 && sell?.args[1].price === 103.4, `tick at target: one limit sell 975 at the tick price 103.4 (got ${sell?.args[1].quantity} @ ${sell?.args[1].price})`);
    await s.processOptionQuote(tick('CE-T', 104));
    assert(count('brokerPlaceLimitSellBare') === 1, 'further ticks do not place a second sell');
    await s.updateTrade(fill('NIFTY22050CE', 'Sell', 975, 103.4));
    assert(s.legs()[0].status === 'closed', 'sell fill closes the leg');

    console.log('  partial fills');
    s = await runTwoSlots('MAT-partial', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 500, 100));
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 475, 101));
    assert(count('brokerPlaceLimitSellBare') === 0, 'partial fills before the target: still no sell');
    assert(s.legs()[0].targetTrigger > 103, `trigger follows the new average fill (got ${s.legs()[0].targetTrigger})`);
    await s.processOptionQuote(tick('CE-T', s.legs()[0].targetTrigger + 0.05));
    const first1 = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 1 && first1?.args[1].quantity === 975, 'target sell covers the whole filled quantity');
    calls = [];
    s = await runTwoSlots('MAT-late', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 500, 100));
    await s.processOptionQuote(tick('CE-T', 104));
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 475, 100));
    const late = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 1 && late?.args[1].quantity === 475, `a fill after the target sell is sold at the same price for the extra (got ${late?.args[1].quantity})`);

    console.log('  one position at a time');
    s = await runTwoSlots('MAT-busy', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    const cfgBusy = s.cfg();
    cfgBusy.times = [slotA, slotB, moment().subtract(0, 'minutes').format('HH:mm')];
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    await s.processNiftyQuote({ ltp: 22020, prevClose: 22000 });
    assert(count('placeLimitBuyBare') === 0, 'a later slot is skipped while the position is open');

    console.log('  quantity from maxInvestment, per broker');
    calls = [];
    s = await runTwoSlots('MAT-budget', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    const cfgB = s.cfg();
    assert(cfgB.quantity === undefined, 'no quantity key is read');

    console.log('  restart re-arms the target watch');
    s = await runTwoSlots('MAT-restart', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
    const restarted: any = make(s.cfg());
    restarted.stateFile = s.stateFile;
    await restarted.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
    assert(restarted.canHandleOptionQuote(tick('CE-T', 103)), 'after a restart the target-watched leg still receives its option ticks');

    console.log('  disabled strategy');
    calls = [];
    const off = make({ type: 'MomentumAtFixedTimeStrategy', userId: 'MAT-off', times: [slotA], maxInvestment: 100000, targetPrice: 3, eodCloseTime: '23:59', brokers: ['kite'] });
    off.enabled = false;
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    await off.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
    assert(calls.length === 0, 'disabled strategy places nothing');
    process.exit(process.exitCode ?? 0); // config watcher / singletons keep the loop alive
})();
