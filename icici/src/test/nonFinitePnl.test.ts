/**
 * Max-profit / max-loss trips fail SAFE on a non-finite P&L (2026-11-13: `MAX PROFIT TRIPPED - total=NaN` on fake-price legs; `total < cap` is false for NaN).
 *   - SimpleContinuous / ScaledHedged: NaN lastLtp / undefined entry / NaN quantity -> no trip, ONE alert per 10 min; valid legs next to a bad leg still trip
 *     when the finite part meets the cap (the bad leg counts 0, like a leg with no tick); NaN realizedPnl -> no trip
 *   - LegManager (cumulative + open-loss), PnlStop (BulkPcr), the global monitor (checkOne): same rules
 * Does not depend on config.yml's settings.maxProfit (cleared below; caps are explicit).
 * Run: npx tsc, then: node ./dist/test/nonFinitePnl.test.js
 */
process.env.MOCK_BROKER = 'true';
import Log from '../util/Log';
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { LegManager } from '../strategy/LegManager';
import { PnlStop } from '../strategy/PnlStop';
import { NonFiniteAlert, shouldTrip } from '../strategy/finiteGuard';
import { clearPrice } from '../strategy/maxProfitLock';
import * as latch from '../strategy/globalMaxProfitLatch';
import { checkOne } from '../processes/strategies/globalMaxProfit';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
(configService.getConfig().settings as any).maxProfit = undefined;
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let logged: string[] = [];
const realLog = Log.log;
(Log as any).log = (...a: any[]) => { logged.push(a.map(String).join(' ')); };
const say = (m: string) => realLog.call(Log, m);
const alerts = () => logged.filter((l) => l.startsWith('ALERT:') || l.includes('ALERT'));
const tripped = () => logged.filter((l) => l.includes('MAX PROFIT TRIPPED') || l.includes('MAX LOSS TRIPPED'));

let calls: { fn: string; args: any[] }[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        if (fn === 'cancelRestingLimitSells') return { filledQty: 0, cancelFailed: false };
        if (fn === 'getPendingSells') return [];
        if (fn === 'getOptionLtp') return fakeLtp;
        if (fn === 'getOpenTrades') return [];
        return {};
    },
});
let fakeLtp: any = 140;
(OrderClient as any).getInstance = () => fake;

let n = 0;
function make(Cls: any, cap = 5000) {
    const cfg: any = { type: Cls.name, userId: `NFP-${++n}`, initialQuantity: 65, maxInvestment: 200000, priceDiff: 10, maxProfit: cap, onePositionPerSide: true, brokers: ['breeze'], broker: 'breeze' };
    const s: any = new Cls(cfg.userId);
    s.enabled = true; s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/non-finite-pnl-test-${cfg.userId}-${process.pid}.json`;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {}; s.save = () => {};
    s.state = { day: 'x', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    return s;
}
function addLeg(s: any, id: string, o: any = {}) {
    const leg = {
        id, tsym: `T${id}`, token: `K${id}`, exchange: 'NFO', strike: 25000, right: id === 'L1' ? 'PE' : 'CE', role: 'root', entry: 100, qty: 100, soldQty: 0, soldValue: 0,
        hedged: false, doubled: true, status: 'open', sellQty: 0, sellShortfall: 0, sellPrice: 0, pnlRef: 100, lastLtp: 100, ...o,
    };
    s.state.legs[id] = leg;
    return leg;
}

(async () => {
    console.log('shouldTrip / NonFiniteAlert');
    {
        const a = new NonFiniteAlert(1000);
        logged = [];
        assert(!shouldTrip('X', NaN, 5000, a) && !shouldTrip('X', Infinity, 5000, a) && !shouldTrip('X', -Infinity, 5000, a), 'NaN / +-Infinity never trip');
        assert(shouldTrip('X', 5000, 5000, a) && !shouldTrip('X', 4999.9, 5000, a), 'finite: trips at total >= cap, not below');
        assert(alerts().length === 1, `one alert for three non-finite calls (${alerts().length})`);
        assert(a.report('k', 'a', 0) && !a.report('k', 'b', 999) && a.report('k', 'c', 1000) && a.report('other', 'd', 1), 'throttle per key, re-alerts after the interval');
    }

    console.log('clearPrice never returns NaN');
    {
        const leg: any = { qty: 100, soldQty: 0, entry: undefined, pnlRef: undefined, sellQty: 0, sellPrice: 0, lastLtp: 100 };
        const other: any = { qty: 100, soldQty: 0, entry: undefined, sellQty: 0, sellPrice: 0, lastLtp: 120 };
        const p = clearPrice(leg, [leg, other], 0, 5000);
        assert(Number.isFinite(p) && p > 0, `unusable entry -> a finite price (${p})`);
    }

    for (const Cls of [SimpleContinuousStrategy, ScaledHedgedStrategy] as any[]) {
        console.log(`\n=== ${Cls.name} ===`);
        const bads: Array<[string, any]> = [['NaN lastLtp', { lastLtp: NaN }], ['undefined entry and pnlRef', { entry: undefined, pnlRef: undefined }],
            ['NaN quantity', { qty: NaN }], ['string lastLtp', { lastLtp: 'abc' }]];
        for (const [name, o] of bads) {
            logged = []; calls = [];
            const s = make(Cls);
            addLeg(s, 'L1', { lastLtp: 400, ...o }); // a bad leg alone: with a good price the old code would trip on NaN
            for (let i = 0; i < 5; i++) await s.checkMaxProfit();
            assert(!s.state.profitTripped && tripped().length === 0 && calls.length === 0, `${name}: no trip, no order`);
            assert(alerts().length === 1 && alerts()[0].includes('L1'), `${name}: exactly one alert naming the leg over 5 checks (${alerts().length})`);
        }

        logged = []; calls = [];
        let s = make(Cls);
        addLeg(s, 'L1', { lastLtp: NaN });
        addLeg(s, 'L2', { lastLtp: 160 }); // (160-100)*100 = 6000 >= 5000
        await s.checkMaxProfit();
        assert(s.state.profitTripped && tripped().length === 1, 'a good leg meeting the cap next to a bad leg still trips (bad leg counts 0)');
        assert(alerts().length === 1 && alerts()[0].includes('L1') && !alerts()[0].includes('L2'), 'the alert names only the bad leg');

        logged = [];
        s = make(Cls);
        addLeg(s, 'L1', { lastLtp: NaN });
        addLeg(s, 'L2', { lastLtp: 120 }); // 2000 < 5000
        await s.checkMaxProfit();
        assert(!s.state.profitTripped, 'a good leg below the cap next to a bad leg does not trip');

        logged = [];
        s = make(Cls);
        s.state.realizedPnl = NaN; addLeg(s, 'L1', { lastLtp: 400 });
        for (let i = 0; i < 3; i++) await s.checkMaxProfit();
        assert(!s.state.profitTripped && alerts().length === 1, 'NaN realizedPnl: no trip, one alert');

        logged = [];
        s = make(Cls);
        addLeg(s, 'L1', { lastLtp: 150 }); // 5000 exactly
        await s.checkMaxProfit();
        assert(s.state.profitTripped, 'all-valid legs at exactly the cap trip (>=)');
        logged = [];
        s = make(Cls);
        addLeg(s, 'L1', { lastLtp: 149.9 });
        await s.checkMaxProfit();
        assert(!s.state.profitTripped, 'just below the cap does not trip');
    }

    console.log('\n=== LegManager ===');
    {
        const mkLm = (cfgOver: any) => {
            const cfg: any = { maxInvestment: 200000, maxProfit: '2.5%', maxLoss: '2.5%', ...cfgOver };
            const lm: any = new LegManager({ userId: 'LM', ownerType: 'LMTest', strategyRef: {} as any, getConfig: () => cfg, getLastUnderlyingLtp: () => 25000, recordOutcome: () => {} });
            lm.rollDayIfNeeded = () => {}; lm.persistProfitState = () => {}; lm.persistLossState = () => {};
            return { lm, cfg };
        };
        const leg = (token: string, o: any) => ({ token, avgPrice: 100, totalQuantity: 100, lastLtp: 100, ...o });
        let { lm, cfg } = mkLm({});
        logged = [];
        lm.legsByToken.set('a', leg('a', { lastLtp: NaN, avgPrice: undefined }));
        lm.legsByToken.set('b', leg('b', { lastLtp: 400 }));
        // b alone is +30000 >= 5000: the bad leg is skipped, b still trips; with the OLD sum NaN it would have been skipped silently or (inverted) tripped
        lm.checkAndMaybeTripMaxProfit(cfg);
        assert(lm.maxProfitTripped && alerts().length === 1 && alerts()[0].includes('a:'), 'bad leg skipped + alerted once, the good leg trips the cap');
        ({ lm, cfg } = mkLm({})); logged = [];
        lm.legsByToken.set('a', leg('a', { totalQuantity: NaN, lastLtp: 400 }));
        for (let i = 0; i < 4; i++) { lm.checkAndMaybeTripMaxProfit(cfg); lm.checkAndMaybeTripMaxLoss(cfg); }
        assert(!lm.maxProfitTripped && !lm.maxLossTripped && tripped().length === 0 && alerts().length === 1, `NaN quantity alone: no trip either side, one alert (${alerts().length})`);
        ({ lm, cfg } = mkLm({})); logged = [];
        lm.realizedPnL = NaN; lm.legsByToken.set('b', leg('b', { lastLtp: 400 }));
        lm.checkAndMaybeTripMaxProfit(cfg); lm.checkAndMaybeTripMaxProfit(cfg);
        assert(!lm.maxProfitTripped && alerts().length === 1, 'NaN realized: no trip, one alert');
        ({ lm, cfg } = mkLm({})); logged = [];
        lm.legsByToken.set('a', leg('a', { lastLtp: NaN })); lm.legsByToken.set('b', leg('b', { lastLtp: 40 })); // loss -6000 <= -5000
        lm.checkAndMaybeTripMaxLoss(cfg);
        assert(lm.maxLossTripped, 'max-loss: a good losing leg trips next to a bad leg');
    }

    console.log('\n=== PnlStop ===');
    {
        for (const kind of ['profit', 'loss'] as const) {
            const st = new PnlStop({ ownerType: 'P', userId: 'u', scope: 's', kind, getCapPct: () => '2.5%', getMaxInvestment: () => 200000 });
            logged = [];
            assert(!st.evaluate(NaN) && !st.evaluate(NaN) && !st.evaluate(-Infinity) && !st.isLatched() && alerts().length === 1, `${kind}: NaN / -Infinity never trip, one alert`);
            assert(st.evaluate(kind === 'profit' ? 5000 : -5000), `${kind}: a finite breach still trips`);
        }
    }

    console.log('\n=== global monitor (checkOne) ===');
    {
        let latched = 0;
        (latch as any).latchGlobalMaxProfit = async () => { latched++; return true; };
        const stats = (trades: any[], closed: any[] = []) => ({ trades, closedTrades: closed });
        const T = (o: any) => ({ user: 'G1', broker: 'kite', entryTime: new Date().toISOString(), tsym: 'NIFTYX', token: '1', quantity: 100, price: 100, realizedPnL: 0, ...o });
        fakeLtp = 150;
        // undefined price: the old num() made it 0 -> a fake +15000 profit and a trip
        logged = []; calls = []; latched = 0;
        await checkOne('G1', 'kite', 5000, stats([T({ price: undefined }), T({ price: 'x', tsym: 'B', token: '2' })]) as any, new Set());
        assert(latched === 0 && tripped().length === 0 && !calls.some((c) => c.fn === 'chunkedSquareOffLimit'), 'open trades with an unusable price: no trip, no sell');
        assert(alerts().length === 1, 'one alert for them');
        logged = []; latched = 0;
        await checkOne('G1', 'kite', 5000, stats([T({ price: undefined }), T({ tsym: 'B', token: '2', price: 90 })]) as any, new Set()); // good: 100*(150-90)=6000
        assert(latched === 1 && tripped().length === 1, 'a good trade meeting the cap next to a bad one still trips');
        logged = []; latched = 0;
        await checkOne('G1', 'kite', 5000, stats([T({})], [T({ realizedPnL: NaN })]) as any, new Set()); // 5000 unrealized... exactly 100*(150-100)=5000
        assert(latched === 1, 'NaN realizedPnL of a closed trade counts 0, the finite part (5000) trips');
        logged = []; latched = 0; fakeLtp = 120;
        await checkOne('G2', 'kite', 5000, stats([T({ user: 'G2' })], [T({ user: 'G2', realizedPnL: 'junk' })]) as any, new Set()); // other user: the alert throttle is per user+broker
        assert(latched === 0 && alerts().length === 1, 'below the cap with a junk realizedPnL: no trip, one alert');
    }

    (Log as any).log = realLog;
    say(process.exitCode ? '\nFAILED' : '\nALL PASSED');
    process.exit(process.exitCode ?? 0);
})();
