/**
 * maxProfit exit of SimpleContinuousStrategy and ScaledHedgedStrategy (2026-11-13: a trip must LOCK the cap, not dump at the bid):
 *   - a resting sell exactly at clearPrice stays (no cancel, no new order); one above or below it is cancelled and one limit sell is placed at clearPrice
 *   - never a market/bid sell on a trip (chunkedSquareOff); the booked exit is >= the cap
 *   - cancel failed: nothing placed; cancel succeeded but part filled: nothing placed until the next pass, which uses the fills
 *   - partial fills, several legs (the exits together reach the cap), a restart mid-trip, a leg still waiting for its reference tick
 *   - EOD keeps the old cancel-and-sell
 * Run: npx tsc, then: node ./dist/test/maxProfitLock.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { clearPrice, tripSellPrice, tripFloor, keepTripSell, TripGuard } from '../strategy/maxProfitLock';
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
let heldTrades: any[] | 'error' = []; // what the order side holds open (read by heldQuantity)
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        if (fn === 'cancelRestingLimitSells') return cancelResult;
        if (fn === 'getPendingSells') return [];
        if (fn === 'getOpenTrades') { if (heldTrades === 'error') throw new Error('unreadable'); return heldTrades; }
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

    console.log('tripSellPrice / keepTripSell / TripGuard');
    {
        assert(tripSellPrice(41, 126) === 119.7, 'clear 41, ltp 126 -> 119.70');
        assert(tripSellPrice(123.2, 126) === 123.2, 'clear 123.20 above the floor stays');
        assert(tripSellPrice(41, undefined) === 41, 'no LTP: clearPrice');
        assert(tripSellPrice(41, 126, 1) === 123.5 && tripSellPrice(41, 126, 2) === 126 && tripSellPrice(41, 126, 9) === 126, 'attempts tighten the floor to the LTP');
        assert(keepTripSell(150, 150, 140) && keepTripSell(130, 120, 140) && !keepTripSell(145, 120, 140) && !keepTripSell(110, 120, 140), 'keep: at clear, or above clear and at/below the market');
        const g = new TripGuard();
        assert(g.due('a', 0) && g.fail('a', 0) === 1 && !g.due('a', 4000) && g.due('a', 5000), 'first failure backs off 5 s');
        assert(g.fail('a', 5000) === 2 && !g.due('a', 14000) && g.due('a', 15000), 'second 10 s');
        for (let i = 0; i < 10; i++) g.fail('a', 0);
        assert(!g.due('a', 59000) && g.due('a', 60000), 'capped at 60 s');
        g.ok('a'); assert(g.due('a', 0), 'success resets');
    }

    for (const Cls of [SimpleContinuousStrategy, ScaledHedgedStrategy] as any[]) {
        console.log(`\n=== ${Cls.name} ===`);

        console.log('resting sell above clearPrice is replaced at clearPrice (the 2026-11-13 12:14 case: 65 @144.25 resting 154.25, cap 5000)');
        calls = []; cancelResult = { filledQty: 0, cancelFailed: false };
        let s = make(Cls);
        let leg = addLeg(s, 'L1', { tsym: 'NIFTY26N1725100PE', entry: 144.25, pnlRef: 144.25, qty: 65, sellQty: 65, sellPrice: 154.25, lastLtp: 150 });
        s.state.realizedPnl = 4550 - 65 * 0; // realized 4550 as live; clear = 144.25 + 450/65 = 151.17 -> 151.20
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 1, 'the old sell is cancelled');
        assert(limitSells().length === 1 && limitSells()[0].price === 151.2 && limitSells()[0].quantity === 65 && of('chunkedSquareOff').length === 0, `one limit sell of 65 @151.20: ${JSON.stringify(limitSells())}`);
        assert(leg.status === 'open' && leg.sellPrice === 151.2 && leg.sellQty === 65, 'leg open, resting at 151.20');
        const n1 = calls.length;
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === n1, 'equal price: a second pass leaves it untouched');

        console.log('tripped strategy restored with its old sell above clearPrice: the Nifty tick pass re-prices it (no trip event needed)');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { entry: 144.25, pnlRef: 144.25, qty: 65, sellQty: 65, sellPrice: 154.25, lastLtp: 150 }); s.state.realizedPnl = 4550;
        await s.processNiftyQuote(nifty());
        assert(of('cancelRestingLimitSells').length === 1 && limitSells().length === 1 && limitSells()[0].price === 151.2, 'first tick after load: cancel + sell @151.20');
        await s.processNiftyQuote(nifty());
        assert(of('chunkedSquareOffLimit').length === 1, 'later ticks: no churn');

        console.log('resting sell below clearPrice is cancelled and raised to clearPrice, never at the bid');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellPrice: 130, lastLtp: 140 }); // clear = 150, floor 133
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
        heldTrades = [{ token: leg.token, tsym: leg.tsym, quantity: 60 }];
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0, 'next pass, fill event NOT yet booked and the order side holds 60 of 100: still nothing placed');
        await s.updateTrade(sellFill(leg, 40, 130)); // the fill event: realized 1200, 60 left
        await s.closeAllLegs('MAX PROFIT');
        // total: realized 1200 + 60 x (ltp 140 - 100) = 3600 (< cap, still tripped); clear = 100 + 3800/60
        assert(limitSells().length === 1 && limitSells()[0].quantity === 60 && limitSells()[0].price === 163.35, `60 left re-priced @163.35: ${JSON.stringify(limitSells())}`);
        await s.updateTrade(sellFill(leg, 60, 163.35));
        assert(s.state.realizedPnl >= 5000, `booked ${s.state.realizedPnl} >= 5000 in total`);
        heldTrades = [];

        console.log('partial placement: the unplaced rest is placed at the same price on the next pass');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 60, sellShortfall: 40, sellPrice: 150 });
        await s.closeAllLegs('MAX PROFIT');
        assert(of('cancelRestingLimitSells').length === 0 && limitSells().length === 1 && limitSells()[0].quantity === 40 && limitSells()[0].price === 150, 'only the 40 missing, at 150, resting 60 untouched');
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


        console.log('FLOOR (2026-11-13 14:35): other legs already realized more than the cap, clearPrice 41 on a 126 leg -> sold at the marketable floor, never at 41');
        calls = []; cancelResult = { filledQty: 0, cancelFailed: false };
        s = make(Cls); leg = addLeg(s, 'L1', { tsym: 'NIFTY17NOV2625150CE', entry: 124.05, pnlRef: 124.05, qty: 65, sellQty: 0, sellPrice: 0, lastLtp: 126 });
        s.state.realizedPnl = 8450;
        assert(clearPrice(leg, [leg], 8450, 5000) < 90, `clearPrice alone is far below the market: ${clearPrice(leg, [leg], 8450, 5000)}`);
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1 && limitSells()[0].price === tripFloor(126) && limitSells()[0].price > 100 && limitSells()[0].price === 119.7, `placed at the floor 119.70 (126 less 5%), not 41: ${JSON.stringify(limitSells())}`);
        assert(of('chunkedSquareOff').length === 0, 'never a market/bid sell');
        const nf = calls.length;
        s.processNiftyQuote && await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === nf, 'second pass: the floored sell stays');
        leg.lastLtp = 124; // the LTP drifts down but the sell (119.70) is still at/below the market: stays
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === nf, 'LTP 124: resting 119.70 is still marketable, no churn');
        leg.lastLtp = 110; // the market fell under the resting sell: re-priced to the new floor
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 2 && limitSells()[1].price === tripFloor(110) && of('cancelRestingLimitSells').length === 1, `market fell under it: cancelled and re-placed @${tripFloor(110)}`);

        console.log('clearPrice above the market floor: rests at clearPrice as before');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, lastLtp: 140 });
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1 && limitSells()[0].price === 150, 'clear 150 > floor 133: placed at 150');

        console.log('no tick yet (no LTP): placed at clearPrice (no floor can be derived)');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, lastLtp: undefined });
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1 && limitSells()[0].price === 150, 'clearPrice');

        console.log('price-band refusal: backs off (no call every pass), log is throttled, the price tightens toward the LTP, then the sell rests');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, lastLtp: 126, entry: 124.05, pnlRef: 124.05, qty: 65 }); s.state.realizedPnl = 8450;
        let refuse = 2;
        const refusing = new Proxy({}, { get: (_t, fn: string) => async (...args: any[]) => { calls.push({ fn, args }); if (fn === 'chunkedSquareOffLimit' && refuse-- > 0) throw new Error('Breeze placeOrder failed: Your order might get rejected as the order price is outside the price range specified by the exchange'); if (fn === 'cancelRestingLimitSells') return cancelResult; return fake[fn] ? {} : {}; } });
        (OrderClient as any).getInstance = () => refusing;
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1 && leg.sellQty === 0, 'first attempt refused, leg still open and unsold');
        for (let i = 0; i < 5; i++) await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1, 'passes within the backoff place nothing (no call storm)');
        s.tripGuard['failures'].get(leg.id).next = 0; // the 5 s backoff elapsed
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 2 && limitSells()[1].price === tripFloor(126, 1), `retry at the tighter floor ${tripFloor(126, 1)}`);
        s.tripGuard['failures'].get(leg.id).next = 0;
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 3 && limitSells()[2].price === 126 && leg.sellQty === 65 && leg.sellPrice === 126, 'third attempt at the LTP rests');
        (OrderClient as any).getInstance = () => fake;

        console.log('cancel returned FILLED-ALL, fill event lagging (14:35:21/29): the next pass places NOTHING');
        calls = []; cancelResult = { filledQty: 195, cancelFailed: false }; heldTrades = [];
        s = make(Cls); leg = addLeg(s, 'L1', { qty: 195, sellQty: 195, sellPrice: 99, lastLtp: 140 });
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0 && leg.sellQty === 0, 'cancel pass places nothing');
        cancelResult = { filledQty: 0, cancelFailed: false };
        await s.closeAllLegs('MAX PROFIT');
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0, 'later passes: order side holds 0 -> nothing placed while the fill event is awaited');
        await s.updateTrade(sellFill(leg, 195, 130));
        assert(leg.status === 'closed', 'the fill event closes the leg');
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0, 'closed: still nothing placed');

        console.log('fill event never arrives (grace over): the leg is closed neutral, no sell');
        calls = []; cancelResult = { filledQty: 195, cancelFailed: false };
        s = make(Cls); leg = addLeg(s, 'L1', { qty: 195, sellQty: 195, sellPrice: 99, lastLtp: 140 });
        await s.closeAllLegs('MAX PROFIT');
        cancelResult = { filledQty: 0, cancelFailed: false };
        s.tripGuard['fillSince'].set(leg.id, Date.now() - 61000);
        await s.closeAllLegs('MAX PROFIT');
        assert(leg.status === 'closed' && limitSells().length === 0, 'closed outside, nothing placed');

        console.log('cancel returned FILLED-PART (65 of 195), events lagging: waits, then places ONLY the remainder (130)');
        calls = []; cancelResult = { filledQty: 65, cancelFailed: false }; heldTrades = [{ token: 'KL1', tsym: 'TL1', quantity: 130 }];
        s = make(Cls); leg = addLeg(s, 'L1', { qty: 195, sellQty: 195, sellPrice: 99, lastLtp: 140 });
        await s.closeAllLegs('MAX PROFIT');
        cancelResult = { filledQty: 0, cancelFailed: false };
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 0, 'order side holds 130 but the leg still counts 195: wait for the fill events');
        await s.updateTrade(sellFill(leg, 65, 130));
        await s.closeAllLegs('MAX PROFIT');
        assert(limitSells().length === 1 && limitSells()[0].quantity === 130, `only the remaining 130 placed: ${JSON.stringify(limitSells())}`);
        heldTrades = [];

        console.log("'nothing sellable' refusal on a trip sell with nothing held: graced, then the leg is closed (no ALERT retry loop)");
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, lastLtp: 140 });
        const refusing2 = new Proxy({}, { get: (_t, fn: string) => async (...args: any[]) => { calls.push({ fn, args }); if (fn === 'chunkedSquareOffLimit') throw new Error('NEVER-SHORT GUARD refused a sell of 100 TL1 - nothing sellable (live=0)'); if (fn === 'getOpenTrades') return []; return {}; } });
        (OrderClient as any).getInstance = () => refusing2;
        await s.closeAllLegs('MAX PROFIT');
        assert(leg.status === 'open', 'first refusal: the fill event gets its grace');
        s.tripGuard['goneSince'].set(leg.id, Date.now() - 61000);
        await s.closeAllLegs('MAX PROFIT');
        assert(leg.status === 'closed', 'after the grace the leg is closed');
        (OrderClient as any).getInstance = () => fake;

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

        console.log('two legs with stale resting sells (A 200, B 120): repeated passes converge and never oscillate, total stays >= cap');
        calls = [];
        s = make(Cls);
        const A3 = addLeg(s, 'L1', { sellQty: 100, sellPrice: 200, lastLtp: 140 });
        const B3 = addLeg(s, 'L2', { sellQty: 130, qty: 130, sellPrice: 120, lastLtp: 120 });
        const hist: string[] = [];
        for (let i = 0; i < 5; i++) { await s.closeAllLegs('MAX PROFIT'); hist.push(`${A3.sellPrice}/${B3.sellPrice}`); }
        const tot = 100 * (A3.sellPrice - 100) + 130 * (B3.sellPrice - 100);
        assert(tot >= 5000, `both legs filled at ${hist[4]} book ${tot} >= 5000`);
        assert(hist[2] === hist[3] && hist[3] === hist[4], `settled by pass 3: ${hist.join(' ')}`);
        for (let i = 1; i < hist.length; i++) {
            const [pa, pb] = hist[i - 1].split('/').map(Number), [qa, qb] = hist[i].split('/').map(Number);
            assert(qa <= pa + 1e-9 && qb <= pb + 1e-9, `pass ${i + 1} never raises a price: ${hist[i - 1]} -> ${hist[i]}`);
        }
        const nb = calls.length;
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === nb, 'settled: no calls');

        console.log('a leg still waiting for its reference tick is skipped (it counts 0)');
        calls = [];
        s = make(Cls); addLeg(s, 'L1', { sellQty: 0, sellPrice: 0, pnlRef: undefined, pnlRefPending: true });
        await s.closeAllLegs('MAX PROFIT');
        assert(calls.length === 0, 'no order for it');

        console.log('restart mid-trip: profitTripped and the resting sell come back; ticks keep, move or re-place it, never the bid');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 100, sellPrice: 150 }); // restored: resting sell at the 150 clear price
        await s.processNiftyQuote(nifty());
        assert(calls.length === 0, 'restored resting sell exactly at clearPrice: left alone');
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
