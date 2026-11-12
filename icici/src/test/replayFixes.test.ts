/**
 * 2026-11-04 trade-report fixes, against a stubbed OrderClient (no broker, no order process):
 *   - entryStopPrice / minMovePoints (percentage stop, minimum-move threshold)
 *   - NiftyChange: minMovePoints, entry at the LTP itself (default limitOffset 0), percentage stop
 *   - MomentumAtFixedTime: minMovePoints, percentage stop, up/down sampling instead of per-tick counting
 *   - SimpleContinuous: one open leg per side, unconfirmed hedge buy resolved against the broker, double-up flag set only when it happens
 * Run: npx tsc, then: node ./dist/test/replayFixes.test.js
 */
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import NiftyChangeStrategy from '../strategy/NiftyChangeStrategy';
import MomentumAtFixedTimeStrategy from '../strategy/MomentumAtFixedTimeStrategy';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import { entryStopPrice, minMovePoints } from '../strategy/entryStop';
import { Trade, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
// eodCloseTime is a global setting (not a strategy key): 23:59 so the end-of-day close never fires during a test, whatever time it is run.
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let buyMode: 'ok' | 'timeout' | 'notPlaced' = 'ok';
let liveQty = 0;
let cancelFails = false;
let openTrades: any[] = [];
const STRIKES = [23900, 23850, 23800, 23750, 23950, 24000];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: 'B1' };
            case 'brokerPlaceLimitSellBare': return { orderId: 'S1' };
            case 'getOptionLtp': return 100;
            case 'attachProtection': return { mode: 'gtt', gttTriggerId: 7 };
            case 'cancelRestingLimitBuys': return { filledQty: 0, cancelFailed: cancelFails };
            case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            case 'getLiveQuantity': return liveQty;
            case 'getOpenTrades': return openTrades;
            case 'getContractByPriceRangeBare': {
                const [, , type, , , exclude] = args;
                const strike = STRIKES.find((k) => !(exclude as number[]).includes(k))!;
                return { tradingSymbol: `N${strike}${type}`, antToken: `${type}${strike}`, exchange: 'NFO', strike, premium: 100, instrumentToken: 1, lotSize: 65 };
            }
            case 'buyContractBare': {
                if (buyMode === 'timeout') throw new Error('[ORDER_MAY_BE_LIVE] fill wait timed out');
                if (buyMode === 'notPlaced') throw new Error('[NOT_PLACED] refused');
                return { quantity: args[3], price: 100 };
            }
            case 'chunkedSquareOffLimit': return {};
            case 'getPendingSells': return [];
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: (_ltp: number, right: string) => (right === 'CE' ? 22750 : 22650) });

const fill = (tsym: string, action: string, qty: number, price: number, broker = 'kite') =>
    Object.assign(new Trade(), { tsym, action, quantity: qty, price, broker, token: 'T1' });
const last = (fn: string) => calls.filter((c) => c.fn === fn).pop();
const count = (fn: string) => calls.filter((c) => c.fn === fn).length;

function make<T>(Cls: new (id: string) => T, cfg: any): any {
    const s: any = new Cls(cfg.userId);
    s.enabled = true;
    s.stateLoaded = true;
    s.cfg = () => cfg;
    // Exits are read through Strategy.setting() (this block's target/stopLoss, else settings): point it at the stubbed block, as the strategy tests do.
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/replay-fixes-test-${cfg.userId}-${process.pid}.json`;
    return s;
}

(async () => {
    console.log('entryStopPrice / minMovePoints');
    assert(entryStopPrice({ stopLossPercent: 10 }, 130, 780) === 117, 'stopLossPercent 10 on a 130 fill -> 117');
    assert(entryStopPrice({ stopLossPercent: '10%' }, 130, 780) === 117, '"10%" string accepted');
    assert(entryStopPrice({ stopLossPercent: 10, stopLossPoints: 8 }, 130, 780) === 117, 'stopLossPercent wins over stopLossPoints');
    assert(entryStopPrice({ stopLossPoints: 8 }, 130, 780) === 122, 'stopLossPoints used without a percentage');
    assert(entryStopPrice({ stopLossPercent: 20, maxLossPerLeg: 1000 }, 130, 100) === 120, 'maxLossPerLeg tightens a wider percentage stop (130 - 1000/100)');
    assert(entryStopPrice({}, 130, 780) === undefined, 'nothing configured -> no stop');
    assert(entryStopPrice({ stopLossPercent: 100 }, 130, 780) === undefined, 'stopLossPercent 100 = no stop');
    assert(entryStopPrice({ stopLossPercent: 100, stopLossPoints: 8 }, 130, 780) === 122, '100% is ignored, stopLossPoints still applies');
    assert(minMovePoints({ minMovePoints: 10 }) === 10 && minMovePoints({}) === 0 && minMovePoints({ minMovePoints: -3 }) === 0, 'minMovePoints: set / unset / negative');

    console.log('NiftyChangeStrategy');
    NiftyChangeStrategy.processStartedAt = moment().subtract(1, 'hour');
    const slot = moment().format('HH:mm');
    const ncCfg = { type: 'NiftyChangeStrategy', userId: 'NCF-a', times: [slot], maxInvestment: 100000, targetPoints: 10, entryTimeoutMinutes: 5, brokers: ['kite'], minMovePoints: 10, stopLossPercent: 10, stopLossPoints: 8 };
    calls = [];
    let nc = make(NiftyChangeStrategy, ncCfg);
    await nc.processNiftyQuote({ ltp: 22655, prevClose: 22650 });
    assert(!calls.some((c) => c.fn === 'placeLimitBuyBare'), 'a +5 move is below minMovePoints 10 -> no trade');
    calls = [];
    nc = make(NiftyChangeStrategy, { ...ncCfg, userId: 'NCF-b' });
    await nc.processNiftyQuote({ ltp: 22680, prevClose: 22650 });
    const b = last('placeLimitBuyBare');
    assert(!!b && b.args[4] === 100, `no limitOffset configured -> limit buy at the option LTP itself (got ${b?.args[4]})`);
    await nc.updateTrade(fill('NIFTY22750CE', 'Buy', 975, 100));
    const att = last('attachProtection');
    assert(att?.args[1].targetPrice === 110 && att?.args[1].stopLossPrice === 90, `target 110 / stop 90 (10% of 100, not 8 points) (got ${att?.args[1].targetPrice}/${att?.args[1].stopLossPrice})`);
    calls = [];
    nc = make(NiftyChangeStrategy, { ...ncCfg, userId: 'NCF-c', minMovePoints: undefined, limitOffset: 3 });
    await nc.processNiftyQuote({ ltp: 22651, prevClose: 22650 });
    assert(last('placeLimitBuyBare')?.args[4] === 97, 'without minMovePoints a +1 move trades, and an explicit limitOffset 3 still applies');

    console.log('MomentumAtFixedTimeStrategy');
    MomentumAtFixedTimeStrategy.processStartedAt = moment().subtract(1, 'hour');
    const slotA = moment().subtract(3, 'minutes').format('HH:mm');
    const slotB = moment().subtract(1, 'minutes').format('HH:mm');
    const mom = (userId: string, extra: any = {}) => {
        const cfg: any = { type: 'MomentumAtFixedTimeStrategy', userId, times: [slotA], maxInvestment: 100000, target: 10, stopLoss: 'none', entryTimeoutMinutes: 5, brokers: ['kite'], minMovePoints: 10, ...extra }; // exits are target / stopLoss (the old targetPoints / stopLossPercent keys are ignored)
        const s = make(MomentumAtFixedTimeStrategy, cfg);
        s.momentum.readDepth = async (_x: any, tokens: string[]) => new Map(tokens.map((t) => [t, t === 'PE-T' ? { tbq: 900, tsq: 100 } : { tbq: 300, tsq: 200 }]));
        return { s, cfg };
    };
    calls = [];
    let m = mom('MF-a');
    await m.s.processNiftyQuote({ ltp: 22000, prevClose: 22000 });
    m.cfg.times = [slotA, slotB];
    await m.s.processNiftyQuote({ ltp: 21995, prevClose: 22000 });
    assert(!calls.some((c) => c.fn === 'placeLimitBuyBare') && !calls.some((c) => c.fn === 'resolveOptionContract'), 'a -5 move is below minMovePoints 10 -> no trade (and no order-book read)');
    calls = [];
    m = mom('MF-b', { stopLoss: '25%' });
    await m.s.processNiftyQuote({ ltp: 22000, prevClose: 22000 });
    m.cfg.times = [slotA, slotB];
    await m.s.processNiftyQuote({ ltp: 21985, prevClose: 22000 });
    assert(!!last('placeLimitBuyBare'), 'a -15 move trades');
    await m.s.updateTrade(fill('NIFTY21950PE', 'Buy', 975, 100));
    const matt = last('attachProtection');
    assert(matt?.args[1].targetPrice === 110 && matt?.args[1].stopLossPrice === 75, `stopLoss 25% -> target 110 / stop 75 attached (got ${matt?.args[1].targetPrice}/${matt?.args[1].stopLossPrice})`);
    calls = [];
    m = mom('MF-c');
    await m.s.processNiftyQuote({ ltp: 22000, prevClose: 22000 });
    m.cfg.times = [slotA, slotB];
    await m.s.processNiftyQuote({ ltp: 21985, prevClose: 22000 });
    await m.s.updateTrade(fill('NIFTY21950PE', 'Buy', 975, 100));
    assert(!calls.some((c) => c.fn === 'attachProtection') && last('brokerPlaceLimitSellBare')?.args[1].price === 110, 'no stop configured -> resting target sell only, as before');

    // Up/down sampling: one sample per minute, not one per tick.
    m = mom('MF-d');
    const c = m.s;
    c.countTick(100, 0);          // baseline
    for (let i = 1; i <= 50; i++) c.countTick(100 + (i % 2 ? 1 : -1), i * 1000); // 50 ticks inside the first minute: ignored
    assert(c.ups === 0 && c.downs === 0 && c.flats === 0, `ticks inside the sampling interval are not counted (ups ${c.ups}, downs ${c.downs})`);
    c.countTick(102, 61_000); c.countTick(101, 125_000); c.countTick(101, 190_000); c.countTick(103, 200_000);
    assert(c.ups === 1 && c.downs === 1 && c.flats === 1, `one sample per minute: up, down, flat (ups ${c.ups}, downs ${c.downs}, flats ${c.flats}); the 200s tick is inside the interval and ignored`);

    console.log('SimpleContinuousStrategy');
    const scCfg: any = { type: 'SimpleContinuousStrategy', userId: 'SCF', initialQuantity: 65, maxInvestment: 100000, priceDiff: 10, brokers: ['kite'] };
    const newSc = (userId: string, extra: any = {}) => {
        const cfg = { ...scCfg, userId, ...extra };
        const s = make(SimpleContinuousStrategy, cfg);
        s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {};
        s.state = { day: 'x', legs: {}, seq: 0 };
        s.lastNiftyLtp = 23900;
        return { s, cfg };
    };
    const addLeg = (s: any, tsym: string, right: 'CE' | 'PE', strike: number, entry: number, extra: any = {}) => {
        const leg = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: entry }), { tradingSymbol: tsym, token: `${right}${strike}`, exchange: 'NFO', strike, premium: entry }, right, 'root', false);
        Object.assign(leg, extra);
        return leg;
    };

    console.log('  unconfirmed hedge buy (Breeze 10:22 case)');
    buyMode = 'timeout'; liveQty = 0; cancelFails = false; calls = [];
    let sc = newSc('SCF-a');
    let root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('cancelRestingLimitBuys') === 1 && count('getLiveQuantity') === 1, 'the broker is asked: resting buy cancelled, live position read');
    assert(root.hedged === false && sc.s.manualReview === false, 'cancelled with 0 filled -> hedge flag cleared, no manual review');
    buyMode = 'ok';
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(root.hedged === true && Object.values<any>(sc.s.state.legs).some((l) => l.role === 'hedge' && l.right === 'PE'), 'the next tick retries and buys the PE hedge');

    buyMode = 'timeout'; liveQty = 65; calls = [];
    sc = newSc('SCF-b');
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    openTrades = [{ tsym: 'N23900PE', quantity: 65, originalEntryPrice: 101.5 }];
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    const adopted = Object.values<any>(sc.s.state.legs).find((l) => l.role === 'hedge');
    assert(!!adopted && adopted.qty === 65 && adopted.entry === 101.5 && root.hedged === true && sc.s.manualReview === false, 'bought after all -> adopted as the hedge leg at the broker price, no manual review');
    assert(!!last('chunkedSquareOffLimit'), 'and its resting sell is placed');

    buyMode = 'timeout'; liveQty = 0; cancelFails = true; calls = [];
    sc = newSc('SCF-c');
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(sc.s.manualReview === true && root.hedged === true, 'cancel failed -> manual review, flag stays (unchanged safe behaviour)');
    cancelFails = false;

    buyMode = 'notPlaced'; calls = [];
    sc = newSc('SCF-d');
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(root.hedged === false && sc.s.manualReview === false && count('cancelRestingLimitBuys') === 0, 'a refused (NOT_PLACED) buy just retries; the broker is not asked');
    buyMode = 'ok';

    console.log('  one open leg per side (onePositionPerSide: true)');
    calls = [];
    sc = newSc('SCF-e', { onePositionPerSide: true });
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180, { hedged: false });
    const openPe = addLeg(sc.s, 'N23850PE', 'PE', 23850, 150, { hedged: true });
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('buyContractBare') === 0 && root.hedged === false && root.hedgeWaiting === true, 'a PE is open -> the PE hedge waits (no second PE order)');
    openPe.status = 'closed'; sc.s.lastWaitingHedgeRetry = 0;
    await sc.s.retryWaitingHedges();
    assert(count('buyContractBare') === 1 && root.hedged === true && root.hedgeWaiting === false, 'the PE closed -> the waiting hedge is bought from a Nifty tick (open leg too)');

    calls = [];
    sc = newSc('SCF-f', { onePositionPerSide: true });
    addLeg(sc.s, 'N23950CE', 'CE', 23950, 150, { hedged: true });
    const ceLeg = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    sc.s.state.legs[ceLeg.id].sellQty = 65;
    await sc.s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(ceLeg.status === 'closed' && ceLeg.hedged === false && ceLeg.hedgeWaiting === true && count('buyContractBare') === 0, 'a profit exit would follow with a CE, but another CE is open -> waits');
    for (const l of Object.values<any>(sc.s.state.legs)) if (l.tsym === 'N23950CE') l.status = 'closed';
    sc.s.lastWaitingHedgeRetry = 0;
    await sc.s.retryWaitingHedges();
    assert(count('buyContractBare') === 1 && ceLeg.hedged === true, 'the other CE closed -> the same-right hedge is bought');

    calls = [];
    sc = newSc('SCF-g', { onePositionPerSide: true }); // CE and PE coexist; two legs trigger on the same free side at once
    const c1 = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    const c2 = addLeg(sc.s, 'N23950CE', 'CE', 23950, 150, { token: 'CE23950' });
    await Promise.all([
        sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 })),
        sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23950', ltp: 139 })),
    ]);
    assert(count('buyContractBare') === 1 && [c1, c2].filter((l) => l.hedged).length === 1 && [c1, c2].filter((l) => l.hedgeWaiting).length === 1, 'two simultaneous PE hedges -> only one PE order, the other waits');

    console.log('  stacking guard (maxLegsPerSide)');
    calls = [];
    sc = newSc('SCF-s1', { maxLegsPerSide: 2, stackRecoveryPoints: 20 });
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180, { hedged: false });
    addLeg(sc.s, 'N23850PE', 'PE', 23850, 150, { hedged: true, niftyAt: 23900 });
    addLeg(sc.s, 'N23800PE', 'PE', 23800, 120, { hedged: true, niftyAt: 23905 });
    sc.s.lastNiftyLtp = 23900;
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('buyContractBare') === 0 && root.hedged === false && root.hedgeWaiting === true, 'two PE legs open and Nifty has not come back -> the PE hedge waits (leg stays un-hedged)');
    sc.s.lastNiftyLtp = 23890; // PE stacked up to 23905: needs Nifty at least 20 below that
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('buyContractBare') === 0, 'Nifty 15 below the high -> still waiting');
    sc.s.lastNiftyLtp = 23880;
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('buyContractBare') === 1 && root.hedged === true && root.hedgeWaiting === false, 'Nifty 25 below the high -> the hedge is bought');

    calls = [];
    sc = newSc('SCF-s2', { maxLegsPerSide: 2 });
    addLeg(sc.s, 'N23950CE', 'CE', 23950, 150, { hedged: true, niftyAt: 23900 });
    addLeg(sc.s, 'N24000CE', 'CE', 24000, 120, { hedged: true, niftyAt: 23900 });
    const ceLegS = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    sc.s.state.legs[ceLegS.id].sellQty = 65;
    await sc.s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(ceLegS.status === 'closed' && ceLegS.hedged === false && ceLegS.hedgeWaiting === true && count('buyContractBare') === 0, 'a target-met hedge held back by the guard stays pending on the closed leg');
    sc.s.lastNiftyLtp = 23930; sc.s.lastWaitingHedgeRetry = 0; // profit -> same right (CE), which is stacked: needs Nifty 20+ above its lowest entry level
    await sc.s.retryWaitingHedges();
    assert(count('buyContractBare') === 1 && ceLegS.hedged === true, 'and is bought from a Nifty tick once Nifty has moved back');

    calls = [];
    sc = newSc('SCF-s3'); // no maxLegsPerSide, no onePositionPerSide: unchanged behaviour
    for (const k of [23850, 23800, 23750]) addLeg(sc.s, `N${k}PE`, 'PE', k, 150, { hedged: true, niftyAt: 23900 });
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(count('buyContractBare') === 1, 'without either setting nothing is held back');

    console.log('  double-up flag');
    buyMode = 'ok'; calls = [];
    sc = newSc('SCF-h', { maxInvestment: 5000 }); // maxInvestment does not gate the double-up
    const parent = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    const hedgeLeg = addLeg(sc.s, 'N23850PE', 'PE', 23850, 150, {});
    hedgeLeg.role = 'hedge'; hedgeLeg.parentId = parent.id; hedgeLeg.hedged = true; hedgeLeg.sellQty = 65;
    await sc.s.updateTrade(fill('N23850PE', 'Sell', 65, 160));
    assert(count('buyContractBare') === 1 && parent.doubled === true && parent.doubleDue === false && parent.qty === 130, `the double-up is not capped by maxInvestment (qty ${parent.qty})`);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 181 }));
    assert(count('buyContractBare') === 1, 'and it is never doubled twice');

    buyMode = 'timeout'; calls = [];
    sc = newSc('SCF-i');
    const p2 = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    const h2 = addLeg(sc.s, 'N23850PE', 'PE', 23850, 150, {});
    h2.role = 'hedge'; h2.parentId = p2.id; h2.hedged = true; h2.sellQty = 65;
    await sc.s.updateTrade(fill('N23850PE', 'Sell', 65, 160));
    assert(p2.doubled === true && sc.s.manualReview === true, 'a double-up buy that may be live is never retried blind (doubled set, manual review)');
    buyMode = 'ok';

    console.log('  profit -> same direction, stop/adverse -> opposite)');
    buyMode = 'ok';
    const closeAt = async (_f: string | undefined, role: 'root' | 'hedge', sellPx: number) => {
        calls = [];
        const x = newSc('SCF-j' + Math.random());
        const l = addLeg(x.s, 'N23900CE', 'CE', 23900, 180);
        l.role = role; l.sellQty = 65; l.parentId = undefined;
        await x.s.updateTrade(fill('N23900CE', 'Sell', 65, sellPx));
        return String(last('buyContractBare')?.args[1] ?? '');
    };
    assert((await closeAt(undefined, 'hedge', 190)).endsWith('CE'), 'default: a hedge leg sold at a profit is followed by the SAME right (CE)');
    assert((await closeAt(undefined, 'root', 190)).endsWith('CE'), 'the root sold at a profit follows its direction too');
    assert((await closeAt(undefined, 'hedge', 170)).endsWith('PE'), 'a hedge leg sold at a loss -> the opposite right');
    calls = [];
    sc = newSc('SCF-k');
    root = addLeg(sc.s, 'N23900CE', 'CE', 23900, 180);
    await sc.s.processOptionQuote(Object.assign(new OptionQuote(), { token: 'CE23900', ltp: 169 }));
    assert(String(last('buyContractBare')?.args[1]).endsWith('PE'), 'adverse move (stop-like) -> the opposite right');

    console.log(process.exitCode ? 'FAILED' : 'ALL PASSED');
    process.exit(process.exitCode ?? 0);
})();
