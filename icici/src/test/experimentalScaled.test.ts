/**
 * ExperimentalScaledStrategy (copy of ScaledHedgedStrategy + Rule 1 only), against a stubbed OrderClient (no broker):
 *   - rule 1: a same-direction re-buy buys initialQuantity with no opposite leg open, the scale formula of the OPPOSITE open leg otherwise
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

    console.log('rule 1 through a target fill: opposite leg open and down 20 = 3x');
    s = make();
    const ce = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 180 }), { ...CE, premium: 180 }, 'CE', 'hedge', false);
    s.state.pair = { CE: { ...CE, premium: 180 } };
    ce.sellQty = 65;
    peLeg(s, 100, 65, 80);
    calls = [];
    await s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(ce.status === 'closed' && buys().length === 1 && buys()[0].args[1] === 'N23900CE' && buys()[0].args[3] === 195, `CE sold at its target, re-bought 195 (got ${buys()[0]?.args[3]})`);

    console.log(process.exitCode ? 'FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
