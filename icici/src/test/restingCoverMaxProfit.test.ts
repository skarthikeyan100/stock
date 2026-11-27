/**
 * Max-profit totals value quantity covered by a resting limit sell at no more than that price (live 2026-11-26 10:00:31, SimpleContinuous kite: 455 @194.95
 * resting at 204.95 was valued at LTP 206.45, tripped on 5233 and booked only 4550 of a 5000 cap):
 *   - restingCover helpers (excess, shortfall, partial fills, state files without the record, reconcile with / without a stored price)
 *   - SimpleContinuous, ScaledHedged, ExperimentalScaled: no false trip; uncovered quantity still counts at the LTP; CE and PE; several legs;
 *     placement in flight; clamped placement; restart / adopted legs; an already-tripped latch stays
 *   - the global and combined monitors: pending sells and a Kite GTT target cap the total; no price = LTP; a fill between the reads is not counted twice
 * Run: npx tsc, then: node ./dist/test/restingCoverMaxProfit.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import ExperimentalScaledStrategy from '../strategy/ExperimentalScaledStrategy';
import { restingExcess, legRestingSells, noteRestingPlaced, noteRestingFilled, restingFromPending } from '../strategy/restingCover';
import { checkOne } from '../processes/strategies/globalMaxProfit';
import { combinedPnl } from '../processes/strategies/combinedMaxProfit';
import { restingByContract } from '../processes/strategies/restingMarks';
import { recordTick, __setLiveFetch } from '../processes/strategies/markPrice';
import Mongo from '../tools/mongo';
import AntContractMaster from '../ant/AntContractMaster';
import { Trade, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let pendingSells: Record<string, any[]> = {};
let openTrades: any[] = [];
let sellGate: Promise<unknown> | null = null; // holds a limit sell "in flight"
let placedQuantity: number | undefined;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        if (fn === 'cancelRestingLimitSells') return { filledQty: 0, cancelFailed: false };
        if (fn === 'getPendingSells') return pendingSells[args[2]] ?? [];
        if (fn === 'getOpenTrades') return openTrades;
        if (fn === 'chunkedSquareOffLimit') { if (sellGate) await sellGate; return placedQuantity === undefined ? {} : { placedQuantity }; }
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ findByToken: () => ({ optionType: 'CE', exch: 'NFO', strike: 25850 }) });
const tripSells = () => calls.filter((c) => c.fn === 'chunkedSquareOffLimit' && c.args[1].locked);

let n = 0;
function make(Cls: any, cap = 5000) {
    const cfg: any = { type: Cls.name, userId: `RCV-${++n}`, initialQuantity: 65, maxInvestment: 900000, priceDiff: 10, maxProfit: cap, brokers: ['kite'], broker: 'kite' };
    const s: any = new Cls(cfg.userId);
    s.enabled = true; s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/resting-cover-test-${cfg.userId}-${process.pid}.json`;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {};
    s.hedge = async () => {};
    s.state = { day: 'x', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false, sellIdsTracked: true, seenSells: [] };
    return s;
}
// The 2026-11-26 leg, resting at 204.95, in a state file with no `resting` record unless one is given.
function addLeg(s: any, id: string, o: any = {}) {
    const leg = {
        id, tsym: `T${id}`, token: `K${id}`, exchange: 'NFO', strike: 25850, right: 'CE', role: 'root', entry: 194.95, qty: 455, soldQty: 0, soldValue: 0,
        hedged: true, status: 'open', sellQty: 455, sellShortfall: 0, sellPrice: 204.95, ...o,
    };
    s.state.legs[leg.id] = leg;
    return leg;
}
const tick = (s: any, leg: any, ltp: number) => s.processOptionQuote(Object.assign(new OptionQuote(), { token: leg.token, ltp }));
const sellFill = (leg: any, qty: number, price: number, id?: string) => Object.assign(new Trade(), { tsym: leg.tsym, token: leg.token, action: 'Sell', quantity: qty, price, broker: 'kite', brokerOrderId: id });
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

(async () => {
    console.log('restingCover');
    {
        assert(near(restingExcess(206.45, 455, [{ qty: 455, price: 204.95 }]), 682.5), 'excess = qty x (ltp - sell)');
        assert(restingExcess(200, 455, [{ qty: 455, price: 204.95 }]) === 0, 'ltp under the sell: nothing taken off');
        assert(near(restingExcess(210, 100, [{ qty: 40, price: 205 }]), 200), 'partly covered: only the covered 40');
        assert(near(restingExcess(210, 100, [{ qty: 80, price: 208 }, { qty: 80, price: 205 }]), 5 * 80 + 2 * 20), 'never more than held, cheapest sells first');
        assert(restingExcess(210, 100, [{ qty: 100, price: 0 }, { qty: NaN, price: 5 }]) === 0 && restingExcess(210, 100, undefined) === 0, 'unusable / absent = nothing covered');
        const l: any = { qty: 650, soldQty: 0, sellQty: 325, sellShortfall: 325, sellPrice: 110 };
        assert(legRestingSells(l).length === 1 && legRestingSells(l)[0].qty === 325, 'state without the record: sellQty at sellPrice');
        l.soldQty = 325;
        assert(legRestingSells(l).length === 0, 'the resting half filled: the unplaced half is not covered');
        assert(legRestingSells({ qty: 100, soldQty: 0, sellQty: 0, sellPrice: 110, resting: [{ qty: 100, price: 110 }] }).length === 0, 'sellQty 0: nothing rests whatever the record says');
        assert(legRestingSells({ qty: 100, soldQty: 0, sellQty: 100, sellPrice: 0 }).every((r) => !(r.price > 0)), 'no recorded price: not covered');
        const m: any = { qty: 100, soldQty: 0, sellQty: 0, sellShortfall: 0, sellPrice: 0 };
        noteRestingPlaced(m, 60, 110, false); m.sellQty = 60; m.sellShortfall = 40;
        noteRestingPlaced(m, 40, 120, true); m.sellQty = 100; m.sellShortfall = 0;
        assert(JSON.stringify(legRestingSells(m)) === JSON.stringify([{ qty: 60, price: 110 }, { qty: 40, price: 120 }]), 'two placements kept apart');
        noteRestingFilled(m, 60); m.soldQty = 60;
        assert(JSON.stringify(legRestingSells(m)) === JSON.stringify([{ qty: 40, price: 120 }]), 'a fill consumes the cheapest first');
        assert(JSON.stringify(restingFromPending({ qty: 100, soldQty: 0, sellQty: 100, sellPrice: 109 }, [{ quantity: 100, price: 111 }])) === JSON.stringify([{ qty: 100, price: 111 }]), 'reconcile: the order side price');
        assert(restingFromPending({ qty: 100, soldQty: 0, sellQty: 100, sellPrice: 109 }, [{ quantity: 100 }])[0].price === 109, 'reconcile: old order, the recorded price');
        assert(restingFromPending({ qty: 100, soldQty: 0, sellQty: 100, sellPrice: 109, resting: [] }, [{ quantity: 100 }]).length === 0, 'reconcile: an assumed price is never used');
        assert(restingFromPending({ qty: 100, soldQty: 0, sellQty: 0, sellPrice: 0 }, [{ quantity: 100 }]).length === 0, 'reconcile: adopted leg with an unpriced order stays uncovered');
    }

    for (const Cls of [SimpleContinuousStrategy, ScaledHedgedStrategy, ExperimentalScaledStrategy] as any[]) {
        console.log(`\n=== ${Cls.name} ===`);
        calls = []; pendingSells = {}; sellGate = null; placedQuantity = undefined; openTrades = [];

        console.log('the 2026-11-26 case: no trip above the resting sell, nor after it fills at it');
        let s = make(Cls);
        let leg = addLeg(s, 'L1');
        await tick(s, leg, 206.45);
        assert(near(s.profitTotal(), 4550) && !s.state.profitTripped && tripSells().length === 0, `total ${s.profitTotal()} = 4550, not 5233: no trip`);
        await tick(s, leg, 260);
        assert(near(s.profitTotal(), 4550) && !s.state.profitTripped, 'however far above');
        await s.updateTrade(sellFill(leg, 455, 204.95, 'o1'));
        assert(near(s.state.realizedPnl, 4550) && !s.state.profitTripped && leg.status === 'closed', 'booked 4550: still trading');

        console.log('PE and CE together: each capped at its own sell; the sum can still trip');
        calls = [];
        s = make(Cls); const ce = addLeg(s, 'L1'); const pe = addLeg(s, 'L2', { right: 'PE', entry: 200, qty: 130, sellQty: 130, sellPrice: 210, lastLtp: 204 });
        await tick(s, ce, 215);
        assert(near(s.profitTotal(), 4550 + 520) && s.state.profitTripped, `4550 capped + 520 below its sell = ${s.profitTotal()} >= 5000 trips`);
        assert(ce.status === 'open' && pe.status === 'open', 'legs stay open until their sells fill');
        s = make(Cls); const a = addLeg(s, 'L1'); addLeg(s, 'L2', { right: 'PE', entry: 200, qty: 130, sellQty: 130, sellPrice: 203, lastLtp: 230 });
        await tick(s, a, 215);
        assert(near(s.profitTotal(), 4550 + 390) && !s.state.profitTripped, 'both above their sells: 4940, no trip');

        console.log('uncovered quantity still counts at the LTP');
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 204.95 }); s.busy.add('L1'); // no resting sell
        await tick(s, leg, 206.45);
        assert(s.state.profitTripped, 'sellQty 0: LTP, trips');
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 130, sellShortfall: 325, resting: [{ qty: 130, price: 204.95 }] }); s.busy.add('L1');
        leg.lastLtp = 206.45;
        assert(near(s.profitTotal(), 130 * 10 + 325 * 11.5), `shortfall at the LTP: ${s.profitTotal()}`);
        s = make(Cls); leg = addLeg(s, 'L1', { resting: [], lastLtp: 206.45 });
        assert(near(s.profitTotal(), 455 * 11.5), 'unknown resting price: LTP');

        console.log('a resting sell below the entry caps too');
        s = make(Cls); leg = addLeg(s, 'L1', { sellPrice: 190, lastLtp: 210 });
        assert(near(s.profitTotal(), 455 * (190 - 194.95)), `${s.profitTotal()}`);

        console.log('placement: booked price recorded; clamped placement covers only what was placed; in flight counts as resting');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0 });
        let release: () => void = () => {};
        sellGate = new Promise<void>((r) => { release = r; });
        const placing = s.placeSell(leg);
        leg.lastLtp = 206.45;
        assert(near(s.profitTotal(), 4550), `in flight: ${s.profitTotal()}`);
        await tick(s, leg, 206.45);
        assert(!s.state.profitTripped, 'no trip while the placement is in flight');
        release(); await placing; sellGate = null;
        assert(JSON.stringify(leg.resting) === JSON.stringify([{ qty: 455, price: 204.95 }]) && near(s.profitTotal(), 4550), 'recorded and capped');
        s = make(Cls, 100000); leg = addLeg(s, 'L1', { sellQty: 0, sellPrice: 0 }); placedQuantity = 130;
        await s.placeSell(leg); leg.lastLtp = 206.45;
        assert(near(s.profitTotal(), 130 * 10 + 325 * 11.5), `clamped to 130: ${s.profitTotal()}`);
        await s.placeShortfall(leg); // the next placement is clamped to 130 again
        assert(near(s.profitTotal(), 260 * 10 + 195 * 11.5), `shortfall part placed: ${s.profitTotal()}`);
        placedQuantity = undefined;
        await s.updateTrade(sellFill(leg, 130, 204.95, 'p1'));
        assert(near(s.state.realizedPnl, 1300) && near(s.profitTotal(), 1300 + 130 * 10 + 195 * 11.5), `partial fill consumes a resting chunk: ${s.profitTotal()}`);
        assert(s.placing.size === 0, 'nothing left in flight');

        console.log('restart: a state file without the record, and the reconcile with an unpriced / priced order');
        calls = [];
        s = make(Cls); leg = addLeg(s, 'L1', { lastLtp: 206.45 }); openTrades = [{ token: 'KL1', tsym: 'TL1', quantity: 455, price: 194.95 }];
        s.rolloverCheck = Promise.resolve(); pendingSells = { TL1: [{ quantity: 455, action: 'Sell' }] };
        await s.reconcile(1, 1);
        assert(near(s.profitTotal(), 4550) && JSON.stringify(leg.resting) === JSON.stringify([{ qty: 455, price: 204.95 }]), `recorded price kept: ${s.profitTotal()}`);
        pendingSells = { TL1: [{ quantity: 455, price: 203, action: 'Sell' }] };
        await s.reconcile(1, 1);
        assert(near(s.profitTotal(), 455 * (203 - 194.95)) && leg.sellPrice === 203, `a re-priced order wins: ${s.profitTotal()}`);
        s = make(Cls); openTrades = [{ token: '999999999', tsym: 'ADOPT', quantity: 455, price: 194.95 }]; s.rolloverCheck = Promise.resolve();
        pendingSells = { ADOPT: [{ quantity: 455, action: 'Sell' }] };
        await s.reconcile(1, 1);
        const adopted: any = Object.values(s.state.legs)[0];
        adopted.lastLtp = 206.45;
        assert(adopted.sellQty === 455 && near(s.profitTotal(), 455 * 11.5), 'adopted, price unknown: LTP');
        await s.reconcile(1, 1);
        assert(near(s.profitTotal(), 455 * 11.5), 'a second reconcile does not turn the assumed price into a known one');
        pendingSells = { ADOPT: [{ quantity: 455, price: 204.95, action: 'Sell' }] };
        await s.reconcile(1, 1);
        assert(near(s.profitTotal(), 4550), 'adopted with a priced order: capped');
        assert(calls.every((c) => !['chunkedSquareOffLimit', 'cancelRestingLimitSells', 'chunkedSquareOff'].includes(c.fn)), 'reconcile placed and cancelled nothing');

        console.log('an already-tripped latch stays, even though the capped total is under the cap');
        s = make(Cls); leg = addLeg(s, 'L1', { lastLtp: 206.45 }); s.state.profitTripped = true;
        await tick(s, leg, 206.45);
        assert(s.state.profitTripped && near(s.profitTotal(), 4550), 'latched');

        console.log('log lines name the instance');
        assert(s.tag === `[${Cls.name}] [${s.userId}]`, s.tag);
    }

    console.log('\n=== global monitor ===');
    {
        const latches: any[] = [];
        (Mongo as any).getInstance = () => ({ db: { collection: () => ({ updateOne: async (k: any) => { latches.push(k); }, find: () => ({ toArray: async () => [] }), findOne: async () => null }) } });
        __setLiveFetch(async () => { throw new Error('no live call'); });
        recordTick('ant', '7', 206.45);
        const row = (o: any = {}) => ({ user: 'HL', broker: 'kite', tsym: 'X', token: '7', price: 194.95, quantity: 455, entryTime: new Date(), ...o });
        const run = async (trades: any[], closedTrades: any[] = [], fresh?: any) => {
            calls = []; latches.length = 0;
            const latched = new Set<string>();
            await checkOne('HL', 'kite', 5000, { trades, closedTrades }, latched, fresh);
            return latched.has('kite');
        };
        pendingSells = { X: [{ quantity: 455, price: 204.95, action: 'Sell' }] };
        assert(!(await run([row()])) && tripSells().length === 0, 'resting sell below the LTP: no trip');
        pendingSells = {};
        assert(await run([row()]), 'no resting sell: trips at the LTP');
        pendingSells = { X: [{ quantity: 455, action: 'Sell' }] };
        assert(await run([row()]), 'order without a price: LTP');
        pendingSells = { X: [{ quantity: 65, price: 204.95, action: 'Sell' }] };
        assert(await run([row()]), 'partly covered, the uncovered rest carries it over the cap');
        pendingSells = {};
        assert(!(await run([row({ gttTriggerId: 5, targetPrice: 204.95 })])), 'Kite GTT target caps');
        assert(await run([row({ targetPrice: 204.95 })]), 'a target the app watches (nothing resting) does not cap');
        pendingSells = { X: [{ quantity: 455, price: 204.95, action: 'Sell' }] };
        assert(!(await run([row({ quantity: 260 }), row({ quantity: 195 })])), 'two rows of one contract share the cover');
        assert(await run([row()], [{ user: 'HL', broker: 'kite', tsym: 'Y', realizedPnL: 500, entryTime: new Date() }]), 'realized + capped open >= cap still trips');
        pendingSells = {};
        assert(!(await run([row()], [], async () => ({ trades: [], closedTrades: [{ user: 'HL', broker: 'kite', tsym: 'X', realizedPnL: 4550, entryTime: new Date() }] }))), 'the sell filled between the reads: judged on the fresh snapshot');

        console.log('the lock price counts the others as the total did');
        recordTick('ant', '8', 130);
        pendingSells = { X: [{ quantity: 455, price: 204.95, action: 'Sell' }] };
        assert(await run([row(), row({ tsym: 'Z', token: '8', price: 100, quantity: 65 })]), '4550 + 1950 trips');
        const z = tripSells().find((c) => c.args[1].tradingSymbol === 'Z');
        assert(!!z && z.args[1].price === 123.5, `Z locks at max(clear 106.95, floor 123.50): ${z?.args[1].price}`);

        console.log('combined monitor');
        const stats = { trades: [row()], closedTrades: [] };
        assert(near(await combinedPnl(stats), 455 * 11.5), 'raw total');
        assert(near(await combinedPnl(stats, await restingByContract(stats.trades)), 4550), 'capped total');
    }
    process.exit(process.exitCode ?? 0);
})();
