/**
 * MomentumAtFixedTimeStrategy against a stubbed OrderClient and a stubbed order-book read (no broker, no order process).
 * Run: npx tsc, then: node ./dist/test/momentumAtFixedTime.test.js
 */
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import MomentumAtFixedTimeStrategy from '../strategy/MomentumAtFixedTimeStrategy';
import { Trade, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import { validateConfigFile } from '../prism/configValidation';
// eodCloseTime is a global setting (not a strategy key): 23:59 so the end-of-day close never fires during a test, whatever time it is run.
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
// getOptionLtp stub: a number, or a function (args) => number that may throw, to model an unreadable quote for one broker's contract.
let optionLtp: number | ((args: any[]) => number) = 100;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: 'B1' };
            case 'brokerPlaceLimitSellBare': return { orderId: 'S1' };
            case 'getOptionLtp': return typeof optionLtp === 'function' ? optionLtp(args) : optionLtp;
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
    // Exits are read through Strategy.setting(): this block's own target/stopLoss, else settings (the same lookup the strategy uses).
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
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
    const cfg: any = { type: 'MomentumAtFixedTimeStrategy', userId, times: [slotA], maxInvestment: 100000, target: 3, stopLoss: 'none', entryTimeoutMinutes: 5, brokers: ['kite'] };
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
    const cfgFirst: any = { type: 'MomentumAtFixedTimeStrategy', userId: 'MAT-first', times: [slotA], maxInvestment: 100000, target: 3, stopLoss: 'none', brokers: ['kite'] };
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    const first = make(cfgFirst);
    await first.processNiftyQuote({ ltp: 22010, prevClose: 21000 });
    assert(count('placeLimitBuyBare') === 0, 'first slot of the day never trades (no previous slot)');

    console.log('  resting target sell placed on fill');
    s = await runTwoSlots('MAT-target', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
    const sell = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 1 && sell?.args[1].quantity === 975 && sell?.args[1].price === 103, `the fill places one resting limit sell of 975 at fill + 3 (got ${sell?.args[1].quantity} @ ${sell?.args[1].price})`);
    assert(s.legs()[0].exit === 'resting', 'leg exit is a resting sell');
    assert(count('attachProtection') === 0, 'no stop configured -> nothing attached');
    await s.processOptionQuote(tick('CE-T', 103.4));
    assert(count('brokerPlaceLimitSellBare') === 1, 'ticks place nothing more (the resting sell is at the broker)');
    await s.updateTrade(fill('NIFTY22050CE', 'Sell', 975, 103));
    assert(s.legs()[0].status === 'closed', 'sell fill closes the leg');

    console.log('  partial fills');
    s = await runTwoSlots('MAT-partial', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 500, 100));
    const p1 = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 1 && p1?.args[1].quantity === 500 && p1.args[1].price === 103, 'the first 500 get a resting sell at once');
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 475, 101));
    const p2 = last('brokerPlaceLimitSellBare');
    assert(count('brokerPlaceLimitSellBare') === 2 && p2?.args[1].quantity === 475 && p2.args[1].price > 103, `the later 475 gets its own sell at the new average + 3 (got ${p2?.args[1].quantity} @ ${p2?.args[1].price})`);
    assert(s.legs()[0].exitQty === 975, `the exit covers the whole filled quantity (got ${s.legs()[0].exitQty})`);

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

    console.log('  restart keeps a stop-protected leg watched');
    s = await runTwoSlots('MAT-restart', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    s.cfg().stopLoss = '25%';
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
    s.legs()[0].stop = 75; // a self-managed stop (no broker-side protection): the tick watch must survive a restart
    s.save();
    const restarted: any = make(s.cfg());
    restarted.stateFile = s.stateFile;
    await restarted.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
    assert(restarted.canHandleOptionQuote(tick('CE-T', 103)), 'after a restart a leg with a tick-driven stop still receives its option ticks');

    console.log('  30% stop is sent with the target');
    s = await runTwoSlots('MAT-stop30', 22000, 22010, { tbq: 900, tsq: 100 }, { tbq: 300, tsq: 200 });
    s.cfg().target = 5;
    s.cfg().stopLoss = '30%';
    calls = [];
    await s.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
    const prot = last('attachProtection');
    assert(!!prot && prot.args[1].targetPrice === 105 && prot.args[1].stopLossPrice === 70, `fill 100: target 105 and a 30% stop at 70 go in together (got ${prot?.args[1].targetPrice} / ${prot?.args[1].stopLossPrice})`);

    console.log('  no-gain timeout');
    const ngCfg = (id: string, extra: any = {}) => ({ type: 'MomentumAtFixedTimeStrategy', userId: id, times: [slotA], maxInvestment: 100000, target: 3, stopLoss: 'none', entryTimeoutMinutes: 5, brokers: ['kite'], noGainTimeoutMinutes: 30, ...extra });
    const filledLeg = async (id: string, extra: any = {}, minutesOld = 31) => {
        calls = [];
        depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
        const cfg: any = ngCfg(id, extra);
        const st = make(cfg);
        await st.processNiftyQuote({ ltp: 22000, prevClose: 22000 });
        cfg.times = [slotA, slotB];
        await st.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
        await st.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100));
        for (const l of st.legs()) l.placedAt = Date.now() - minutesOld * 60_000;
        calls = [];
        st.lastNoGainCheck = 0;
        return st;
    };
    const sold = () => calls.filter((c) => c.fn === 'chunkedSquareOff');

    optionLtp = 100; // not above the fill of 100
    s = await filledLeg('MAT-ng-flat');
    await s.checkNoGainTimeouts();
    assert(sold().length === 1 && sold()[0].args[1].quantity === 975, `31 min old, LTP 100 <= fill 100 -> closed at market, all 975 sold (got ${sold().map((c) => c.args[1].quantity)})`);
    assert(count('cancelRestingLimitSells') === 1, 'the resting target sell is cancelled before the market sell');

    optionLtp = 90;
    s = await filledLeg('MAT-ng-down');
    await s.checkNoGainTimeouts();
    assert(sold().length === 1, 'LTP below the fill -> closed');

    optionLtp = 100.05;
    s = await filledLeg('MAT-ng-up');
    await s.checkNoGainTimeouts();
    assert(sold().length === 0 && count('getOptionLtp') === 1, 'LTP above the fill -> kept (LTP was read, nothing sold)');

    optionLtp = 90;
    s = await filledLeg('MAT-ng-early', {}, 29);
    await s.checkNoGainTimeouts();
    assert(sold().length === 0 && count('getOptionLtp') === 0, '29 min old -> not due: the LTP is not even read');

    s = await filledLeg('MAT-ng-off', { noGainTimeoutMinutes: 'none' });
    await s.checkNoGainTimeouts();
    assert(sold().length === 0 && count('getOptionLtp') === 0, "noGainTimeoutMinutes 'none' -> off");

    s = await filledLeg('MAT-ng-bad', { noGainTimeoutMinutes: 'abc' });
    let threw = false;
    try { await s.checkNoGainTimeouts(); } catch { threw = true; }
    assert(threw && sold().length === 0, 'a bad value is an error and sells nothing');
    await s.processNiftyQuote({ ltp: 22010, prevClose: 22000 }); // the tick path swallows it (logs an ALERT) and keeps working
    assert(sold().length === 0, 'a bad value on a tick logs and does not crash the tick handler');

    optionLtp = 0;
    s = await filledLeg('MAT-ng-noquote');
    await s.checkNoGainTimeouts();
    assert(sold().length === 0, 'an unreadable LTP (0) keeps the leg: no exit on a guess');

    optionLtp = 90;
    s = await filledLeg('MAT-ng-throttle');
    await s.checkNoGainTimeouts();
    await s.checkNoGainTimeouts();
    assert(count('getOptionLtp') === 1, 'checks are throttled to one per 30 s');

    s = await filledLeg('MAT-ng-closed');
    s.legs()[0].soldQty = 975; // the target sell already filled
    await s.checkNoGainTimeouts();
    assert(sold().length === 0 && count('getOptionLtp') === 0, 'a fully sold leg is skipped');

    // Two brokers: an LTP failure on the first leg must not stop the second from being closed.
    calls = [];
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    const cfg2: any = ngCfg('MAT-ng-two', { brokers: ['kite', 'ant'] });
    const two = make(cfg2);
    await two.processNiftyQuote({ ltp: 22000, prevClose: 22000 });
    cfg2.times = [slotA, slotB];
    await two.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
    await two.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100, 'kite'));
    await two.updateTrade(fill('NIFTY22050CE', 'Buy', 975, 100, 'ant'));
    for (const l of two.legs()) l.placedAt = Date.now() - 31 * 60_000;
    calls = [];
    two.lastNoGainCheck = 0;
    optionLtp = (a: any[]) => { if (calls.filter((c) => c.fn === 'getOptionLtp').length === 1) throw new Error('quote down'); return 90; };
    await two.checkNoGainTimeouts();
    assert(two.legs().length === 2 && sold().length === 1, `first leg's LTP read fails, the second broker's leg is still closed (legs ${two.legs().length}, sells ${sold().length})`);
    assert(two.noGainBusy === false, 'the busy flag is released after a failure');
    optionLtp = 100;

    console.log('  config validation of noGainTimeoutMinutes');
    const baseCfg = (extra: any) => ({ settings: { target: 10, stopLoss: 'none', eodCloseTime: '15:50' }, strategies: [{ type: 'MomentumAtFixedTimeStrategy', enabled: true, userId: 'MAT-v', times: ['10:10'], maxInvestment: 50000, minMovePoints: 10, target: 5, stopLoss: '30%', index: 'NIFTY', brokers: ['kite'], ...extra }] });
    // The validator skips disabled blocks by design (a stale value in a block that is not running must not stop startup), so test an enabled one.
    const errs = (extra: any) => validateConfigFile(baseCfg(extra)).filter((e: string) => e.includes('noGainTimeoutMinutes'));
    assert(errs({ noGainTimeoutMinutes: 30 }).length === 0, '30 is accepted');
    assert(errs({ noGainTimeoutMinutes: 'none' }).length === 0, "'none' is accepted");
    assert(errs({}).length === 0, 'absent is accepted (off)');
    assert(errs({ noGainTimeoutMinutes: 0 }).length === 1, '0 is rejected');
    assert(errs({ noGainTimeoutMinutes: -5 }).length === 1, 'a negative value is rejected');
    assert(errs({ noGainTimeoutMinutes: 'abc' }).length === 1, 'a string other than none is rejected');

    console.log('  disabled strategy');
    calls = [];
    const off = make({ type: 'MomentumAtFixedTimeStrategy', userId: 'MAT-off', times: [slotA], maxInvestment: 100000, target: 3, stopLoss: 'none', brokers: ['kite'] });
    off.enabled = false;
    depth = { 'CE-T': { tbq: 900, tsq: 100 }, 'PE-T': { tbq: 300, tsq: 200 } };
    await off.processNiftyQuote({ ltp: 22010, prevClose: 22000 });
    assert(calls.length === 0, 'disabled strategy places nothing');
    process.exit(process.exitCode ?? 0); // config watcher / singletons keep the loop alive
})();
