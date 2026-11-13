/**
 * maxProfit exit of SimpleContinuousStrategy and ScaledHedgedStrategy (2026-11-13: a trip must LOCK the cap, not dump at the bid):
 *   - a resting sell already at or above clearPrice stays (no cancel, no new order); a lower one is cancelled and one limit sell is placed at clearPrice
 *   - never a market/bid sell on a trip (chunkedSquareOff); the booked exit is >= the cap
 *   - cancel failed: nothing placed; cancel succeeded but part filled: nothing placed until the next pass, which uses the fills
 *   - partial fills, several legs (the exits together reach the cap), a restart mid-trip, a leg still waiting for its reference tick
 *   - EOD keeps the old cancel-and-sell
 * Run: npx tsc, then: node ./dist/test/maxProfitLock.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { clearPrice } from '../strategy/maxProfitLock';
import { Trade, NiftyQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let cancelResult: any = { filledQty: 0, cancelFailed: false };
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        if (fn === 'cancelRestingLimitSells') return cancelResult;
        if (fn === 'getPendingSells') return [];
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;
const of = (fn: string) => calls.filter((c) => c.fn === fn);
const limitSells = () => of('chunkedSquareOffLimit').map((c) => c.args[1]);

let n = 0;
function make(Cls: any, cap = 5000) {
    const cfg: any = { type: Cls.name, userId: `MPL-${++n}`, initialQuantity: 65, maxInvestment: 200000, priceDiff: 10, maxProfit: cap, onePositionPerSide: true, brokers: ['breeze'], broker: 'breeze' };
    const s: any = new Cls(cfg.userId);
    s.enabled = true; s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/max-profit-lock-test-${cfg.userId}-${process.pid}.json`;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {};
    s.setPair = function (pair: any) { this.state.pair = pair; };
    s.state = { day: 'x', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: true };
    return s;
}
function addLeg(s: any, id: string, o: any = {}) {
    const leg = {
        id, tsym: `T${id}`, token: `K${id}`, exchange: 'NFO', strike: 25000, right: id === 'L1' ? 'PE' : 'CE', role: 'root', entry: 100, qty: 100, soldQty: 0, soldValue: 0,
        hedged: false, doubled: true, status: 'open', sellQty: 100, sellShortfall: 0, sellPrice: 110, pnlRef: 100, lastLtp: 140, ...o,
    };
    s.state.legs[id] = leg;
    return leg;
}
const sellFill = (leg: any, qty: number, price: number) => Object.assign(new Trade(), { tsym: leg.tsym, token: leg.token, action: 'Sell', quantity: qty, price, broker: 'breeze' });
const nifty = () => Object.assign(new NiftyQuote(), { ltp: 25000 });

(async () => {
    console.log('clearPrice');
    {
        const leg: any = { qty: 520, soldQty: 0, entry: 158.3, pnlRef: 158.3, sellQty: 520, sellPrice: 168.3, lastLtp: 168 };
        assert(clearPrice(leg, [leg], 0, 5000) === 167.95, `the 2026-11-13 leg (520 @158.30, cap 5000) clears at 167.95: ${clearPrice(leg, [leg], 0, 5000)}`);
        assert(520 * (clearPrice(leg, [leg], 0, 5000) - 158.3) >= 5000, 'selling at clearPrice books at least the cap');
    }

    for (const Cls of [SimpleContinuousStrategy, ScaledHedgedStrategy] as any[]) {
        console.log(`\n=== ${Cls.name} ===`);

        console.log('resting sell above clearPrice is kept (the 2026-11-13 case: 168.30 resting, 167.95 clears)');
        calls = []; cancelResult = { filledQty: 0, cancelFailed: false };
        let s = make(Cls);
        let leg = addLeg(s, 'L1', { tsym: 'NIFTY17NOV2625250PE', entry: 158.3, pnlRef: 158.3, qty: 520, sellQty: 520, sellPrice: 168.3, lastLtp: 168 });
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 0 && of('chunkedSquareOffLimit').length === 0 && of('chunkedSquareOff').length === 0, 'no cancel, no new order');
        assert(leg.status === 'open' && leg.sellPrice === 168.3, 'leg stays open with its sell at 168.30 (books 5200 >= 5000 when it fills)');
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === 0, 'a second pass changes nothing');

        console.log('resting sell below clearPrice is cancelled and re-placed at clearPrice, never at the bid');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellPrice: 130, lastLtp: 160 }); // total 6000, clear = 150
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 1, 'the old sell is cancelled');
        assert(limitSells().length === 1 && limitSells()[0].price === 150 && limitSells()[0].quantity === 100, `one limit sell of 100 @150: ${JSON.stringify(limitSells())}`);
        assert(of('chunkedSquareOff').length === 0, 'no sell at the bid');
        assert(leg.status === 'open' && leg.sellQty === 100 && leg.sellPrice === 150, 'leg open, resting at 150');
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === 2, 'the next pass leaves the new sell alone');
        await s.updateTrade(sellFill(leg, 100, 150));
        assert(s.state.realizedPnl >= 5000 && leg.status === 'closed', `filled at 150: realized ${s.state.realizedPnl} >= 5000, leg closed`);

        console.log('no resting sell: placed at clearPrice (nothing to cancel)');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0 });
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 0 && limitSells().length === 1 && limitSells()[0].price === 150, 'limit sell @150, no cancel call');

        console.log('cancel failed: nothing is placed');
        calls = []; cancelResult = { filledQty: 0, cancelFailed: true };
        s = make(Cls); leg = addLeg(s, 'L1', { sellPrice: 130 });
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0 && of('chunkedSquareOff').length === 0 && leg.sellQty === 100, 'no order, the leg still counts its resting sell');

        console.log('cancel succeeded but part filled: no placement now, the next pass prices what is left from the fills');
        calls = []; cancelResult = { filledQty: 40, cancelFailed: false };
        s = make(Cls); leg = addLeg(s, 'L1', { sellPrice: 130 });
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0 && leg.sellQty === 0, 'nothing placed on the pass that saw the fill');
        cancelResult = { filledQty: 0, cancelFailed: false };
        await s.updateTrade(sellFill(leg, 40, 130)); // the fill event: realized 1200, 60 left
        await s.closeAllLegs('MAX PROFIT');
        // total: realized 1200 + 60 x (ltp 140 - 100) = 3600 (< cap, still tripped); clear = 100 + 3800/60
        assert(limitSells().length === 1 && limitSells()[0].quantity === 60 && limitSells()[0].price === 163.35, `60 left re-priced @163.35: ${JSON.stringify(limitSells())}`);
        await s.updateTrade(sellFill(leg, 60, 163.35));
        assert(s.state.realizedPnl >= 5000, `booked ${s.state.realizedPnl} >= 5000 in total`);

        console.log('partial placement: the unplaced rest is placed at the same price on the next pass');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 60, sellShortfall: 40, sellPrice: 160 });
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 0 && limitSells().length === 1 && limitSells()[0].quantity === 40 && limitSells()[0].price === 160, 'only the 40 missing, at 160, resting 60 untouched');
        assert(leg.sellQty === 100 && leg.sellShortfall === 0, 'leg now fully covered');

        console.log('placement refused: retried on the next pass, never falls to the bid');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0 });
        const real = fake.chunkedSquareOffLimit;
        const prox = new Proxy({}, { get: (_t, fn: string) => async (...args: any[]) => { calls.push({ fn, args }); if (fn === 'chunkedSquareOffLimit') throw new Error('refused'); if (fn === 'cancelRestingLimitSells') return cancelResult; return {}; } });
        (OrderClient as any).getInstance = () => prox;
        await s.closeAllLegs('MAX PROFIT');
        (OrderClient as any).getInstance = () => fake;
        assert(of('chunkedSquareOff').length === 0 && leg.status === 'open' && leg.sellQty === 0, 'leg open, no sell, no bid dump');
        void real;

        console.log('two legs (CE and PE): the exits together reach the cap, and a second pass is stable');
        calls = [];
        s = make(Cls); // A gains 4000 at 140, B gains 2000 at 120: total 6000
        const A = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, lastLtp: 140 });
        const B = addLeg(s, 'L2', { sellQty: 0, sellPrice: 0, lastLtp: 120 });
        await s.closeAllLegs('MAX PROFIT');
        const sells = limitSells();
        assert(sells.length === 2, 'one limit sell per leg');
        const booked = 100 * (A.sellPrice - 100) + 100 * (B.sellPrice - 100);
        assert(booked >= 5000, `both legs filled at their sell prices (${A.sellPrice}, ${B.sellPrice}) book ${booked} >= 5000`);
        const before = calls.length;
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === before, 'second pass: no cancel, no re-place (stable)');

        console.log('two legs, one already resting above its clear price: kept; the other covers the cap with the real exit price');
        calls = [];
        s = make(Cls);
        addLeg(s, 'L1', { sellQty: 100, sellPrice: 200, lastLtp: 140 });
        const B2 = addLeg(s, 'L2', { sellQty: 0, sellPrice: 0, lastLtp: 120 });
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 0 && limitSells().length === 1, 'L1 untouched, L2 placed');
        assert(B2.sellPrice === 50, `L2 only needs ${B2.sellPrice} because L1 rests at 200`);

        console.log('a leg still waiting for its reference tick is skipped (it counts 0)');
        calls = [];
        s = make(Cls); addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, pnlRef: undefined, pnlRefPending: true });
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === 0, 'no order for it');

        console.log('restart mid-trip: profitTripped and the resting sell come back; ticks keep or re-place, never the bid');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 100, sellPrice: 160 }); // restored: resting sell above the 150 clear price
        await s.processNiftyQuote(nifty());
        assert(calls.length === 0, 'restored resting sell above clearPrice: left alone');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0 }); // the restart found nothing resting
        await s.processNiftyQuote(nifty());
        assert(limitSells().length === 1 && limitSells()[0].price === 150 && of('chunkedSquareOff').length === 0, 're-placed from the tick at clearPrice');

        console.log('EOD still cancels and sells');
        calls = []; cancelResult = { filledQty: 0, cancelFailed: false };
        s = make(Cls); leg = addLeg(s, 'L1');
        await s.closeAllLegs('EOD');
        assert(of('cancelRestingLimitSells').length === 1 && of('chunkedSquareOff').length === 1 && leg.status === 'closed', 'EOD closes the leg at the bid as before');
    }
    console.log(process.exitCode ? '\nFAILED' : '\nALL PASSED');
    process.exit(process.exitCode ?? 0);
})();
