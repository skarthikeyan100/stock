/**
 * ExperimentalScaledStrategy rules (copy of ScaledHedgedStrategy + rule 1, rule 2, the stop, the gate), against a stubbed OrderClient (no broker):
 *   - rule 1: a same-direction re-buy buys initialQuantity with no opposite leg open, the scale formula of the OPPOSITE open leg otherwise
 *   - rule 2: with slDistance > 0 a leg reaching entry + priceDiff is ADDED to (blended average, new target, no resting sell, no sell) instead of sold + re-bought
 *   - the stop: the whole leg is sold at market at (blended average - slDistance); the loss is a normal close (the opposite right is bought)
 *   - the gate: slDistance absent = ScaledHedgedStrategy behaviour (resting sell, sell and re-buy)
 *   - reconcile of an add-mode leg places no sell; a different contract / a hedged leg keeps the sell flow
 * Run: npx tsc, then: node ./dist/test/experimentalScaled.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import ExperimentalScaledStrategy from '../strategy/ExperimentalScaledStrategy';
import { Trade, OptionQuote } from '../model/model';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
const buyPrice: Record<string, number> = {};
let strikes = [23900, 23850, 23800, 23950];
let openTradesRows: any[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'getContractByPriceRangeBare': {
                const [, , type, , , exclude] = args;
                const strike = strikes.find((k) => !(exclude as number[]).includes(k))!;
                return { tradingSymbol: `N${strike}${type}`, antToken: `${type}${strike}`, exchange: 'NFO', strike, premium: 100, instrumentToken: 1, lotSize: 65 };
            }
            case 'buyContractBare': return { quantity: args[3], price: buyPrice[args[1]] ?? 100 };
            case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            case 'chunkedSquareOffLimit': return {};
            case 'chunkedSquareOff': return { quantity: args[1].quantity };
            case 'getPendingSells': return [];
            case 'getOpenTrades': return openTradesRows;
            case 'platformSells': return [];
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: () => 23900, findByToken: () => undefined });

const fill = (tsym: string, action: string, qty: number, price: number) => Object.assign(new Trade(), { tsym, action, quantity: qty, price, broker: 'kite', token: 'T1' });
const buys = () => calls.filter((c) => c.fn === 'buyContractBare');
const restingSells = () => calls.filter((c) => c.fn === 'chunkedSquareOffLimit');
const marketSells = () => calls.filter((c) => c.fn === 'chunkedSquareOff');
const tick = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp });

const baseCfg: any = { type: 'ExperimentalScaledStrategy', userId: 'EXP', initialQuantity: 65, maxInvestment: 200000, priceDiff: 10, maxProfit: 20000, onePositionPerSide: true, brokers: ['kite'], slDistance: 50 };
let n = 0;
function make(extra: any = {}, direction: 'CE' | 'PE' = 'CE') {
    const cfg = { ...baseCfg, userId: `EXP-${++n}`, ...extra };
    const s: any = new ExperimentalScaledStrategy(cfg.userId);
    s.enabled = true; s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/experimental-scaled-test-${cfg.userId}-${process.pid}.json`;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {};
    s.setPair = function (pair: any) { this.state.pair = pair; };
    s.direction = async () => direction; // the PCR direction the rule-E contract selection would take
    s.state = { day: 'x', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    s.lastNiftyLtp = 23900;
    return s;
}
const CE = { tradingSymbol: 'N23900CE', token: 'CE23900', exchange: 'NFO' as const, strike: 23900 };
const PE = { tradingSymbol: 'N23900PE', token: 'PE23900', exchange: 'NFO' as const, strike: 23900 };
const ceRoot = (s: any, entry = 180, qty = 65) => {
    const leg = s.addLeg(Object.assign(new Trade(), { quantity: qty, price: entry }), { ...CE, premium: entry }, 'CE', 'root', false);
    s.state.pair = { CE: { ...CE, premium: entry } };
    if (!s.isAddLeg(leg)) { leg.sellQty = qty; leg.sellPrice = entry + 10; }
    return leg;
};
const peLeg = (s: any, entry = 100, qty = 65, ltp?: number, role: 'root' | 'hedge' = 'hedge') => {
    const leg = s.addLeg(Object.assign(new Trade(), { quantity: qty, price: entry }), { ...PE, premium: entry }, 'PE', role, false);
    s.state.pair = { ...(s.state.pair ?? {}), PE: { ...PE, premium: entry } };
    if (ltp !== undefined) leg.lastLtp = ltp;
    return leg;
};
const throttleOff = (s: any, leg: any) => s.lastAddAttempt.delete(leg.id); // the 5 s add throttle

(async () => {
    console.log('identity: own name, own state file');
    {
        const s: any = new ExperimentalScaledStrategy('Experimental-Scaled-1');
        assert(s.name === 'ExperimentalScaledStrategy', `name is ExperimentalScaledStrategy (got ${s.name})`);
        assert(/\.ExperimentalScaledStrategy\.Experimental-Scaled-1\.json$/.test(s.stateFile()), `state file ${s.stateFile()} never collides with .ScaledHedgedStrategy.*`);
    }

    console.log('rule 1: re-buy quantity, no opposite leg = 1x');
    calls = [];
    let s = make({ slDistance: undefined });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    let closedCe = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { ...CE, premium: 170 }, 'CE', 'hedge', false);
    closedCe.status = 'closed';
    await s.hedge(closedCe, 'target met', true);
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 65, `no opposite leg open: CE re-buy = initialQuantity 65 (got ${buys()[0]?.args[3]})`);

    console.log('rule 1: opposite leg open and down 20 = 3x');
    calls = [];
    s = make({ slDistance: undefined });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    peLeg(s, 100, 65, 80);
    closedCe = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { ...CE, premium: 170 }, 'CE', 'hedge', false);
    closedCe.status = 'closed';
    await s.hedge(closedCe, 'target met', true);
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 195, `PE open 100 -> 80: CE re-buy = 65 + 20/10 x 65 = 195 (got ${buys()[0]?.args[3]})`);
    calls = [];
    s = make({ slDistance: undefined, maxInvestment: 15000 });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    peLeg(s, 10, 65, 5);
    closedCe = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { ...CE, premium: 170 }, 'CE', 'hedge', false);
    closedCe.status = 'closed';
    s.pairPx.set('CE23900', 100);
    await s.hedge(closedCe, 'target met', true);
    assert(buys().length === 1 && buys()[0].args[3] === 65, `maxInvestment still applies to the re-buy (room for one lot: ${buys()[0]?.args[3]})`);
    s = make({ slDistance: undefined });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    const parent = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 180 }), { ...CE, premium: 180 }, 'CE', 'root', false);
    parent.lastLtp = 169;
    assert(s.hedgeQuantity(parent) === 130, `adverse-move hedge keeps today's formula on the parent leg (CE 180 -> 169: 130, got ${s.hedgeQuantity(parent)})`);

    console.log('rule 2: target touch adds (blended average, new target, no resting sell)');
    calls = [];
    s = make();
    let leg = ceRoot(s, 180);
    assert(leg.addMode === true, 'a leg created with slDistance > 0 is an add-mode leg');
    await s.placeSell(leg);
    assert(restingSells().length === 0 && leg.sellQty === 0, 'no resting sell is placed for an add-mode leg');
    buyPrice.N23900CE = 190;
    await s.processOptionQuote(tick('CE23900', 185));
    assert(buys().length === 0, 'below the target (180 + 10): nothing happens');
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 65, `LTP 190 >= 180 + 10: 65 of the same contract bought (got ${buys()[0]?.args[3]})`);
    assert(leg.qty === 130 && Math.abs(leg.entry - 185) < 1e-9 && leg.added === true, `blended average 185 on qty 130 (got ${leg.qty} @ ${leg.entry})`);
    assert(Object.keys(s.state.legs).length === 1 && leg.status === 'open', 'one leg, still open: no sell, no new leg');
    assert(restingSells().length === 0 && marketSells().length === 0, 'no resting sell and no sell was placed');
    throttleOff(s, leg);
    calls = [];
    await s.processOptionQuote(tick('CE23900', 192));
    assert(buys().length === 0, 'the target moved to 185 + 10 = 195: 192 adds nothing');
    buyPrice.N23900CE = 195;
    await s.processOptionQuote(tick('CE23900', 195));
    assert(buys().length === 1 && leg.qty === 195 && Math.abs(leg.entry - (185 * 130 + 195 * 65) / 195) < 1e-9, `second add at 195: qty ${leg.qty}, average ${leg.entry.toFixed(3)}`);
    assert(restingSells().length === 0, 'still no resting sell');

    console.log('rule 2: the add uses the rule-1 quantity (opposite leg open and down 20 = 3x)');
    calls = [];
    s = make();
    leg = ceRoot(s, 180);
    peLeg(s, 100, 65, 80);
    buyPrice.N23900CE = 190;
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 1 && buys()[0].args[3] === 195 && leg.qty === 260, `add = 195 (got ${buys()[0]?.args[3]}), leg qty ${leg.qty}`);

    console.log('rule 2: maxInvestment, no room = nothing bought');
    calls = [];
    s = make({ maxInvestment: 12000 });
    leg = ceRoot(s, 100);
    s.pairPx.set('CE23900', 100);
    await s.processOptionQuote(tick('CE23900', 110));
    assert(buys().length === 0 && leg.qty === 65, 'cost 6,500 + 6,500 > 12,000: no lot fits, nothing bought');

    console.log('the stop: whole pyramid sold at average - slDistance, loss is a normal close');
    calls = [];
    s = make();
    leg = ceRoot(s, 180);
    buyPrice.N23900CE = 190;
    await s.processOptionQuote(tick('CE23900', 190)); // average 185, qty 130
    calls = [];
    s.hedge = async () => {}; // the adverse-move hedge (CE down 10) is not under test here: keep the leg un-hedged so the stop's loss follow-up is the opposite buy
    await s.processOptionQuote(tick('CE23900', 136));
    delete s.hedge;
    assert(marketSells().length === 0, 'average 185 - 50 = 135: 136 does not stop out');
    await s.processOptionQuote(tick('CE23900', 135));
    assert(marketSells().length === 1 && marketSells()[0].args[1].quantity === 130 && marketSells()[0].args[1].tradingSymbol === 'N23900CE', `135 <= 185 - 50: the WHOLE 130 is sold at market (got ${marketSells()[0]?.args[1]?.quantity})`);
    calls = [];
    await s.updateTrade(fill('N23900CE', 'Sell', 130, 135));
    assert(leg.status === 'closed' && Math.abs(s.state.realizedPnl - 130 * (135 - 185)) < 1e-6, `loss booked as a normal close (realized ${s.state.realizedPnl})`);
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE' && buys()[0].args[3] === 390, `a loss buys the opposite right with today's formula on the parent (65 + 50/10 x 65 = 390; got ${buys()[0]?.args[1]} ${buys()[0]?.args[3]})`);

    console.log('the gate: slDistance absent = ScaledHedgedStrategy behaviour');
    for (const k of Object.keys(buyPrice)) delete buyPrice[k];
    calls = [];
    s = make({ slDistance: undefined });
    await s.openRoot('CE', 23900, 65, 200000);
    leg = Object.values(s.state.legs)[0] as any;
    assert(leg.addMode !== true && restingSells().length === 1 && restingSells()[0].args[1].price === 110, 'the root rests its sell at entry + priceDiff (110)');
    calls = [];
    await s.processOptionQuote(tick('CE23900', 200));
    assert(buys().length === 0 && marketSells().length === 0, 'target touch adds nothing (no slDistance)');
    await s.processOptionQuote(tick('CE23900', 50));
    assert(marketSells().length === 0 && buys().every((b) => b.args[1] === 'N23900PE'), 'a deep drop triggers no stop, only the old adverse-move hedge (opposite right)');
    s = make({ slDistance: undefined });
    const hedgeLeg = peLeg(s, 100, 65, undefined, 'hedge');
    hedgeLeg.sellQty = 65;
    calls = [];
    await s.updateTrade(fill('N23900PE', 'Sell', 65, 110));
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE' && buys()[0].args[3] === 65, 'sell at the target then re-buy of the same contract (old flow, 1x)');
    s = make({ slDistance: 50 });
    leg = ceRoot(s, 180);
    s.cfg = () => ({ ...baseCfg, userId: 'x', slDistance: undefined }); // the gate switched off after the leg was created
    calls = [];
    await s.processOptionQuote(tick('CE23900', 185));
    assert(restingSells().length === 1, 'gate off: an add-mode leg is given its resting sell by the tick path');

    console.log('reconcile of an add-mode leg places no sell');
    calls = [];
    s = make();
    leg = ceRoot(s, 185, 130);
    leg.added = true;
    openTradesRows = [{ token: 'CE23900', tsym: 'N23900CE', quantity: 130, price: 185 }];
    await s.reconcile(1, 1);
    assert(restingSells().length === 0 && leg.sellQty === 0 && !leg.sellShortfall, 'reconcile: no sell, no shortfall for the add-mode leg');
    assert(leg.qty === 130 && leg.addMode === true, 'the add-mode flag and the blended quantity survive the reconcile');
    await s.processOptionQuote(tick('CE23900', 186));
    assert(restingSells().length === 0 && buys().length === 0, 'the next tick places no sell either');
    openTradesRows = [];

    console.log('a different contract / a hedged leg keeps the old flow (sell at the target)');
    calls = [];
    s = make({}, 'PE'); // the selection would now pick the other right: not the same contract
    leg = ceRoot(s, 180);
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 0 && leg.addMode === false && restingSells().length === 1 && restingSells()[0].args[1].price === 190, 'rule E picks another right: no add, resting sell at 190 placed');
    calls = [];
    s = make({}, 'CE');
    strikes = [23950, 23900];
    leg = ceRoot(s, 180);
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 0 && leg.addMode === false && restingSells().length === 1, 'rule E picks another strike: no add, resting sell placed');
    strikes = [23900, 23850, 23800, 23950];
    calls = [];
    s = make();
    leg = ceRoot(s, 180);
    leg.hedged = true;
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 0 && leg.addMode === false && restingSells().length === 1, 'a hedged leg: nothing same-direction follows its sale, so it is sold at the target');
    calls = [];
    s = make();
    const pe = peLeg(s, 100, 65, undefined, 'hedge');
    s.state.pair.PE = { ...PE, tradingSymbol: 'N23900PEX', token: 'OTHER', premium: 100 };
    await s.processOptionQuote(tick('PE23900', 110));
    assert(buys().length === 0 && pe.addMode === false && restingSells().length === 1, 'a leg that is not the fixed pair contract of its right is sold, not added to');
    calls = [];
    s = make();
    const pe2 = peLeg(s, 100, 65, undefined, 'hedge');
    await s.processOptionQuote(tick('PE23900', 110));
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE' && pe2.qty === 130 && restingSells().length === 0, 'a hedge leg on the fixed pair contract is added to (target-met re-buy of the same contract)');

    console.log('guards: manual review / disabled');
    calls = [];
    s = make();
    leg = ceRoot(s, 180);
    s.manualReview = true;
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 0 && leg.addMode === true && restingSells().length === 0, 'manual review: no add and no sell (retried later)');
    s.manualReview = false;
    s.enabled = false;
    throttleOff(s, leg);
    await s.targetAdd(leg);
    assert(buys().length === 0, 'disabled: no add');

    console.log(process.exitCode ? 'FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
