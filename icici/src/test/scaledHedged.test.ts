/**
 * ScaledHedgedStrategy rules, against a stubbed OrderClient (no broker, no order process):
 *   - the root buys initialQuantity (not the whole maxInvestment)
 *   - a hedge buys initialQuantity + drop / priceDiff x initialQuantity (whole lots)
 *   - one CE and one PE contract per cycle: a leg falling priceDiff buys the OTHER contract again, ADDED to its open leg
 *     (blended entry, resting sell cancelled and re-placed at the new average + priceDiff, trigger re-armed)
 *   - no double-up; a same-direction re-buy after a target fill buys initialQuantity of the same contract, never when it is open
 *   - maxInvestment cuts or holds back every buy
 *   - the first order at a profit restarts the contract selection
 * Run: npx tsc, then: node ./dist/test/scaledHedged.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { roundToTick } from '../util/tick';
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
const STRIKES = [23900, 23850, 23800, 23950];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'getContractByPriceRangeBare': {
                const [, , type, , , exclude] = args;
                const strike = STRIKES.find((k) => !(exclude as number[]).includes(k))!;
                return { tradingSymbol: `N${strike}${type}`, antToken: `${type}${strike}`, exchange: 'NFO', strike, premium: 100, instrumentToken: 1, lotSize: 65 };
            }
            case 'buyContractBare': return { quantity: args[3], price: buyPrice[args[1]] ?? 100 };
            case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            case 'chunkedSquareOffLimit': return {};
            case 'getPendingSells': return [];
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: (_ltp: number, right: string) => (right === 'CE' ? 23900 : 23900) });

const fill = (tsym: string, action: string, qty: number, price: number) => Object.assign(new Trade(), { tsym, action, quantity: qty, price, broker: 'kite', token: 'T1' });
const buys = () => calls.filter((c) => c.fn === 'buyContractBare');
const last = (fn: string) => calls.filter((c) => c.fn === fn).pop();
const tick = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp });

const baseCfg: any = { type: 'ScaledHedgedStrategy', userId: 'SHC', initialQuantity: 65, maxInvestment: 200000, priceDiff: 10, maxProfit: 20000, onePositionPerSide: true, brokers: ['kite'] };
let n = 0;
function make(extra: any = {}) {
    const cfg = { ...baseCfg, userId: `SHC-${++n}`, ...extra };
    const s: any = new ScaledHedgedStrategy(cfg.userId);
    s.enabled = true; s.stateLoaded = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/scaled-hedged-test-${cfg.userId}-${process.pid}.json`;
    s.watch = () => {}; s.unwatch = () => {}; s.isEod = () => false; s.ensureLoaded = () => {};
    s.setPair = function (pair: any) { this.state.pair = pair; }; // the real one subscribes the feed
    s.state = { day: 'x', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    s.lastNiftyLtp = 23900;
    return s;
}
const ceRoot = (s: any, entry = 180) => {
    const leg = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: entry }), { tradingSymbol: 'N23900CE', token: 'CE23900', exchange: 'NFO', strike: 23900, premium: entry }, 'CE', 'root', false);
    s.state.pair = { CE: { tradingSymbol: 'N23900CE', token: 'CE23900', exchange: 'NFO', strike: 23900, premium: entry } };
    leg.sellQty = 65; leg.sellPrice = entry + 10;
    return leg;
};

(async () => {
    console.log('one open leg per side is always on');
    assert(make({ onePositionPerSide: false }).onePerSide() === true && make({ onePositionPerSide: undefined }).onePerSide() === true, 'onePositionPerSide false / absent changes nothing: the strategy always keeps one open leg per side');
    {
        const g = make({ onePositionPerSide: false });
        ceRoot(g);
        assert(g.sideBlocked('CE') === true && g.sideBlocked('PE') === false, 'an open CE blocks a second CE leg, the PE side is free');
        g.pendingSides.add('PE');
        assert(g.sideBlocked('PE') === true, 'a PE buy in flight blocks a second PE buy');
    }

    console.log('root = initialQuantity');
    calls = [];
    let s = make();
    await s.openRoot('CE', 23900, 65, 200000);
    assert(buys().length === 1 && buys()[0].args[3] === 65, `onePositionPerSide on, maxInvestment 200000: the root buys 65, not the whole budget (got ${buys()[0]?.args[3]})`);
    assert(s.state.pair?.CE?.token === 'CE23900' && !s.state.pair?.PE, 'the root contract is the CE of the pair');

    console.log('hedge quantity scales with the drop');
    for (const [ltp, want] of [[169, 130], [160, 195], [175, 65]] as [number, number][]) {
        calls = [];
        s = make();
        ceRoot(s);
        await s.processOptionQuote(tick('CE23900', ltp));
        const b = buys()[0];
        assert(ltp === 175 ? buys().length === 0 : !!b && b.args[1] === 'N23900PE' && b.args[3] === want, `CE 180 -> ${ltp}: ${ltp === 175 ? 'no hedge yet (drop 5 < 10)' : `PE hedge qty ${want} (got ${b?.args[3]})`}`);
    }

    console.log('a falling hedge leg buys the CE again: the same contract, added to its open leg');
    calls = [];
    s = make();
    const root = ceRoot(s);
    await s.processOptionQuote(tick('CE23900', 169));
    const pe: any = Object.values(s.state.legs).find((l: any) => l.right === 'PE');
    assert(!!pe && pe.qty === 130 && s.state.pair.PE.tsym === undefined && s.state.pair.PE.tradingSymbol === 'N23900PE', 'PE hedge 130 bought, its contract fixed as the PE of the pair');
    pe.sellQty = 130;
    calls = [];
    await s.processOptionQuote(tick('PE23900', 85)); // PE 100 -> 85: drop 15 -> 65 + 1.5 x 65 = 162.5 -> 130
    const addBuy = buys()[0];
    const legsNow = Object.values(s.state.legs).length;
    const avg = (180 * 65 + 100 * 130) / 195;
    assert(!!addBuy && addBuy.args[1] === 'N23900CE' && addBuy.args[3] === 130, `the SAME CE contract is bought again, qty 130 (got ${addBuy?.args[1]} ${addBuy?.args[3]})`);
    assert(legsNow === 2 && root.qty === 195 && Math.abs(root.entry - avg) < 1e-9, `no new leg: added to the open CE leg (qty ${root.qty}, average ${root.entry.toFixed(2)} vs ${avg.toFixed(2)})`);
    const order = calls.map((c) => c.fn);
    assert(order.indexOf('cancelRestingLimitSells') >= 0 && order.indexOf('cancelRestingLimitSells') < order.indexOf('buyContractBare') && order.indexOf('buyContractBare') < order.lastIndexOf('chunkedSquareOffLimit'), 'resting sell cancelled, then the buy, then a new resting sell');
    const sell = last('chunkedSquareOffLimit');
    assert(sell?.args[1].quantity === 195 && sell?.args[1].price === roundToTick(avg + 10), `the new resting sell covers all 195 at the new average + 10 (${sell?.args[1].price} vs ${roundToTick(avg + 10)})`);
    assert(pe.hedged === true && root.hedged === false && root.added === true, 'the falling PE stays hedged; the CE leg is re-armed from its new average');
    calls = [];
    await s.processOptionQuote(tick('CE23900', root.entry - 11)); // the re-armed CE leg falls 10 below its NEW average
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE', 'the re-armed CE leg hedges again by buying the PE contract of the pair');

    console.log('no double-up; same-direction re-buy only when the contract is not open');
    calls = [];
    s = make();
    ceRoot(s);
    await s.processOptionQuote(tick('CE23900', 169));
    const pe2: any = Object.values(s.state.legs).find((l: any) => l.right === 'PE');
    pe2.sellQty = 130;
    calls = [];
    await s.updateTrade(fill('N23900PE', 'Sell', 130, 110));
    assert(!buys().some((b) => b.args[1] === 'N23900CE'), 'the hedge leg sold at a profit does NOT double the parent CE');
    assert(buys().length === 1 && buys()[0].args[1] === 'N23900PE' && buys()[0].args[3] === 65, `it re-buys the same PE contract at initialQuantity (got ${buys()[0]?.args[1]} ${buys()[0]?.args[3]})`);
    calls = [];
    s = make();
    const open = ceRoot(s);
    s.state.pair.CE = { tradingSymbol: 'N23900CE', token: 'CE23900', exchange: 'NFO', strike: 23900, premium: 180 };
    const closedSame = s.addLeg(Object.assign(new Trade(), { quantity: 65, price: 170 }), { tradingSymbol: 'N23900CE', token: 'CE23900', exchange: 'NFO', strike: 23900, premium: 170 }, 'CE', 'hedge', false);
    closedSame.status = 'closed';
    await s.hedge(closedSame, 'target met', true);
    assert(buys().length === 0 && closedSame.hedged === true && open.qty === 65, 'a re-buy of a contract that already has an open leg buys nothing');

    console.log('maxInvestment is honoured');
    calls = [];
    s = make({ maxInvestment: 15000 });
    ceRoot(s, 100);
    await s.processOptionQuote(tick('CE23900', 89)); // wants 130 (13,000) but only 8,500 is left: 1 lot
    assert(buys().length === 1 && buys()[0].args[3] === 65, `wanted 130, room for one lot -> 65 (got ${buys()[0]?.args[3]})`);
    calls = [];
    s = make({ maxInvestment: 8000 });
    const tight = ceRoot(s, 100);
    await s.processOptionQuote(tick('CE23900', 89)); // room 1,500: not one lot
    assert(buys().length === 0 && tight.hedged === false && tight.hedgeWaiting === true, 'no room for one lot: nothing bought, the hedge is held back and retried');
    s.cfg = () => ({ ...baseCfg, userId: 'x', maxInvestment: 200000 });
    await s.processOptionQuote(tick('CE23900', 89));
    assert(buys().length === 1 && tight.hedged === true, 'once there is room the held-back hedge is bought');

    console.log('the first order at a profit restarts the contract selection');
    s = make();
    const first = ceRoot(s);
    calls = [];
    await s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(buys().length === 0 && first.restarted === true && first.hedged === true, 'sold at a profit with no hedge: nothing bought, marked restarted');
    s = make();
    const added = ceRoot(s);
    added.added = true;
    calls = [];
    await s.updateTrade(fill('N23900CE', 'Sell', 65, 190));
    assert(added.restarted !== true && buys().length === 1, 'a root that had quantity added is not a never-hedged first order: it re-buys the same contract');

    console.log(process.exitCode ? 'FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
