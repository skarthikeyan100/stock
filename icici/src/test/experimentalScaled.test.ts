/**
 * ExperimentalScaledStrategy (copy of ScaledHedgedStrategy + Rule 1 only), against a stubbed OrderClient (no broker):
 *   - rule 1: a same-direction re-buy buys initialQuantity with no opposite leg open, (opposite leg's drop / priceDiff) * initialQuantity otherwise (no
 *     "initialQuantity +" term), in whole lots, never below initialQuantity, capped at the freeze quantity, cut by maxInvestment
 *   - no add mode, no stop: the target is sold through the resting sell at entry + priceDiff and re-bought; slDistance in the config has no effect
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

const baseCfg: any = { type: 'ExperimentalScaledStrategy', userId: 'EXP', initialQuantity: 65, maxInvestment: 200000, priceDiff: 10, maxProfit: 20000, onePositionPerSide: true, brokers: ['kite'] };
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
    leg.sellQty = qty; leg.sellPrice = entry + 10;
    return leg;
};
const peLeg = (s: any, entry = 100, qty = 65, ltp?: number, role: 'root' | 'hedge' = 'hedge') => {
    const leg = s.addLeg(Object.assign(new Trade(), { quantity: qty, price: entry }), { ...PE, premium: entry }, 'PE', role, false);
    s.state.pair = { ...(s.state.pair ?? {}), PE: { ...PE, premium: entry } };
    if (ltp !== undefined) leg.lastLtp = ltp;
    return leg;
};

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

    console.log('rule 1: opposite leg open and down 20 = 2x');
    calls = [];
    s = make({ slDistance: undefined });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    peLeg(s, 100, 65, 80);
    closedCe = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { ...CE, premium: 170 }, 'CE', 'hedge', false);
    closedCe.status = 'closed';
    await s.hedge(closedCe, 'target met', true);
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 130, `PE open 100 -> 80: CE re-buy = 20/10 x 65 = 130 (got ${buys()[0]?.args[3]})`);
    calls = [];
    s = make({ slDistance: undefined, maxInvestment: 15000 });
    s.state.pair = { CE: { ...CE, premium: 180 } };
    peLeg(s, 100, 65, 50); // wants 50/10 x 65 = 325; room = 15000 - 6500 open cost = one lot at 100
    assert(s.rebuyQuantity('CE') === 325, `uncut re-buy would be 325 (got ${s.rebuyQuantity('CE')})`);
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

    console.log('rule 1: opposite leg down less than priceDiff = 1x');
    calls = [];
    s = make();
    s.state.pair = { CE: { ...CE, premium: 180 } };
    peLeg(s, 100, 65, 95);
    closedCe = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { ...CE, premium: 170 }, 'CE', 'hedge', false);
    closedCe.status = 'closed';
    await s.hedge(closedCe, 'target met', true);
    assert(buys().length === 1 && buys()[0].args[3] === 65, `PE down 5 (< priceDiff 10): CE re-buy = 65 (got ${buys()[0]?.args[3]})`);

    console.log('no add mode, no stop: the target is sold via the resting sell and re-bought');
    for (const k of Object.keys(buyPrice)) delete buyPrice[k];
    calls = [];
    s = make({ slDistance: 50 }); // slDistance has no effect in this class
    await s.openRoot('CE', 23900, 65, 200000);
    let leg = Object.values(s.state.legs)[0] as any;
    assert((leg as any).addMode === undefined && restingSells().length === 1 && restingSells()[0].args[1].price === 110, 'the root rests its sell at entry + priceDiff (110)');
    calls = [];
    await s.processOptionQuote(tick('CE23900', 200));
    assert(buys().length === 0 && marketSells().length === 0 && restingSells().length === 0, 'LTP past the target: no add, no market sell (the resting sell does the selling)');
    await s.processOptionQuote(tick('CE23900', 50));
    assert(marketSells().length === 0 && buys().every((b) => b.args[1] === 'N23900PE'), 'slDistance 50 and a deep drop: no stop, only the adverse-move hedge (opposite right)');
    s = make({ slDistance: 50 });
    const hedgeLeg = peLeg(s, 100, 65, undefined, 'hedge');
    hedgeLeg.sellQty = 65;
    calls = [];
    await s.updateTrade(fill('N23900PE', 'Sell', 65, 110));
    assert(hedgeLeg.status === 'closed' && Object.keys(s.state.legs).length === 2, 'the target fill closes the leg and a new leg follows (no add onto the same leg)');
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE' && buys()[0].args[3] === 65, 'sell at the target then re-buy of the same contract (1x, nothing opposite open)');
    s = make();
    leg = ceRoot(s, 180);
    leg.hedged = true;
    calls = [];
    await s.processOptionQuote(tick('CE23900', 190));
    assert(buys().length === 0 && marketSells().length === 0, 'target touch with slDistance absent: nothing is bought or sold by the tick path');

    console.log('rule 1 through a target fill: opposite leg open and down 20 = 2x');
    s = make();
    const ce = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 180 }), { ...CE, premium: 180 }, 'CE', 'hedge', false);
    s.state.pair = { CE: { ...CE, premium: 180 } };
    ce.sellQty = 65;
    peLeg(s, 100, 65, 80);
    calls = [];
    await s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(ce.status === 'closed' && buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 130, `CE sold at its target, re-bought 130 (got ${buys()[0]?.args[3]})`);

    console.log('rule 1: the formula (initialQuantity 130, priceDiff 10, opposite PE bought at 200); the adverse-move hedge on the same leg is unchanged');
    for (const [ltp, rebuy, hedge, why] of [
        [180, 260, 390, '20/10 x 130'],
        [175, 325, 455, '25/10 x 130 = 325'],
        [183, 195, 325, '17/10 x 130 = 221, floored to whole lots'],
        [195, 130, 195, 'drop under priceDiff: never below initialQuantity'],
        [200, 130, 130, 'opposite leg at its entry'],
        [220, 130, 130, 'opposite leg above its entry'],
        [undefined, 130, 130, 'no price for the opposite leg yet'],
        [1, 1755, 1755, 'capped at the freeze quantity'],
    ] as [number | undefined, number, number, string][]) {
        s = make({ initialQuantity: 130, maxInvestment: 10_000_000 });
        const pe = peLeg(s, 200, 130, ltp);
        assert(s.rebuyQuantity('CE') === rebuy && s.hedgeQuantity(pe) === hedge, `PE 200 -> ${ltp ?? 'no tick'}: re-buy ${rebuy}, hedge ${hedge} (${why}) (got ${s.rebuyQuantity('CE')} / ${s.hedgeQuantity(pe)})`);
    }
    s = make({ initialQuantity: 130 });
    assert(s.rebuyQuantity('CE') === 130, 'no opposite leg open: initialQuantity 130');
    peLeg(s, 200, 130, 180);
    assert(s.rebuyQuantity('PE') === 130, 'a same-right leg is not the opposite one: a PE re-buy with only a PE open stays 130');

    console.log(process.exitCode ? 'FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
