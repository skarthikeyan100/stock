/**
 * RecommendationStrategy and NiftyChangeStrategy against a stubbed OrderClient (no broker, no order process).
 * Run: npx tsc, then: node ./dist/test/limitEntryStrategies.test.js
 */
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import RecommendationStrategy from '../strategy/RecommendationStrategy';
import NiftyChangeStrategy from '../strategy/NiftyChangeStrategy';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let attachFails = false;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: 'T1', exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: 'B1' };
            case 'brokerPlaceLimitSellBare': return { orderId: 'S1' };
            case 'getOptionLtp': return 100;
            case 'attachProtection': if (attachFails) throw new Error('no protection primitive'); return { mode: 'gtt', gttTriggerId: 7 };
            case 'cancelRestingLimitBuys': case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: (_ltp: number, right: string) => (right === 'CE' ? 22750 : 22650) });

function make<T>(Cls: new (id: string) => T, cfg: any): any {
    const s: any = new Cls(cfg.userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.stateFile = () => `/tmp/limit-entry-test-${cfg.userId}-${process.pid}.json`;
    return s;
}
const fill = (tsym: string, action: string, qty: number, price: number, broker = 'kite') =>
    Object.assign(new Trade(), { tsym, action, quantity: qty, price, broker, token: 'T1' });
const last = (fn: string) => calls.filter((c) => c.fn === fn).pop();

(async () => {
    console.log('RecommendationStrategy');
    assert(JSON.stringify(RecommendationStrategy.parseContract('22750 CE')) === '{"strike":22750,"right":"CE"}', 'parses "22750 CE"');
    assert(RecommendationStrategy.parseContract('22750') === null, 'rejects a contract with no CE/PE');

    const recCfg = { type: 'RecommendationStrategy', userId: 'Rec-test', contract: '22750 CE', entryPrice: 120, targetPrice: 150, stopLoss: 95, entryOffset: 5, maxInvestmentAmount: 100000, brokers: ['kite'], startTime: '00:00', eodCloseTime: '23:59' };
    let rec = make(RecommendationStrategy, recCfg);
    await rec.processNiftyQuote({ ltp: 22700 });
    const buy = last('placeLimitBuyBare');
    assert(!!buy && buy.args[4] === 115, `limit buy at entryPrice - 5 (got ${buy?.args[4]})`);
    assert(buy?.args[3] === 845, `qty = 13 lots of 65 from 100000 at 115 (got ${buy?.args[3]})`);
    await rec.processNiftyQuote({ ltp: 22700 });
    assert(calls.filter((c) => c.fn === 'placeLimitBuyBare').length === 1, 'the same recommendation is not placed twice');

    await rec.updateTrade(fill('NIFTY22750CE', 'Buy', 845, 115));
    const att = last('attachProtection');
    assert(att?.args[1].targetPrice === 150 && att?.args[1].stopLossPrice === 95, 'target and stop attached after the fill');
    assert(rec.legs()[0].exit === 'gtt', 'leg is protected via GTT');
    await rec.updateTrade(fill('NIFTY22750CE', 'Sell', 845, 150));
    assert(rec.legs()[0].status === 'closed', 'sell fill closes the leg');

    calls = []; attachFails = true;
    rec = make(RecommendationStrategy, { ...recCfg, userId: 'Rec-test-b', brokers: ['breeze'] });
    await rec.processNiftyQuote({ ltp: 22700 });
    await rec.updateTrade(fill('NIFTY22750CE', 'Buy', 845, 115, 'breeze'));
    const sell = last('brokerPlaceLimitSellBare');
    assert(sell?.args[1].price === 150 && sell?.args[1].quantity === 845, 'no broker protection -> resting sell at target');
    assert(rec.legs()[0].stop === 95 && rec.legs()[0].exit === 'self', 'tick-driven stop armed');
    await rec.processOptionQuote({ token: 'T1', ltp: 94 });
    assert(calls.some((c) => c.fn === 'chunkedSquareOff' && c.args[1].quantity === 845), 'stop hit -> market close of the whole quantity');

    calls = []; attachFails = false;
    rec = make(RecommendationStrategy, { ...recCfg, userId: 'Rec-test-c', stopLoss: 116 });
    await rec.processNiftyQuote({ ltp: 22700 });
    assert(!calls.some((c) => c.fn === 'placeLimitBuyBare'), 'stop above the order price is refused');

    calls = [];
    rec = make(RecommendationStrategy, recCfg); rec.enabled = false;
    await rec.processNiftyQuote({ ltp: 22700 });
    assert(calls.length === 0, 'disabled strategy places nothing');

    console.log('NiftyChangeStrategy');
    NiftyChangeStrategy.processStartedAt = moment().subtract(1, 'hour');
    const slot = moment().format('HH:mm');
    const ncCfg = { type: 'NiftyChangeStrategy', userId: 'NC-test', times: [slot], maxInvestment: 100000, limitOffset: 3, targetPoints: 5, entryTimeoutMinutes: 5, eodCloseTime: '23:59', brokers: ['kite'] };
    calls = [];
    let nc = make(NiftyChangeStrategy, ncCfg);
    await nc.processNiftyQuote({ ltp: 22710, prevClose: 22650 });
    assert(last('resolveOptionContract')?.args[1].right === 'CE', 'Nifty up -> CE');
    const b2 = last('placeLimitBuyBare');
    assert(b2?.args[4] === 97, `limit = option LTP 100 - 3 (got ${b2?.args[4]})`);
    assert(b2?.args[3] === 975 && b2.args[3] % 65 === 0, `qty = 15 lots from 100000 at 97 (got ${b2?.args[3]})`);
    await nc.updateTrade(fill('NIFTY22750CE', 'Buy', 975, 96.5));
    const t = last('brokerPlaceLimitSellBare');
    assert(t?.args[1].price === 101.5 && t.args[1].quantity === 975, `target sell at fill + 5 (got ${t?.args[1].price})`);

    calls = [];
    nc = make(NiftyChangeStrategy, { ...ncCfg, userId: 'NC-test-b' });
    await nc.processNiftyQuote({ ltp: 22600, prevClose: 22650 });
    assert(last('resolveOptionContract')?.args[1].right === 'PE', 'Nifty down -> PE');

    calls = [];
    nc = make(NiftyChangeStrategy, { ...ncCfg, userId: 'NC-test-c' });
    await nc.processNiftyQuote({ ltp: 22650, prevClose: 22650 });
    assert(!calls.some((c) => c.fn === 'placeLimitBuyBare'), 'flat Nifty -> no trade');

    calls = [];
    NiftyChangeStrategy.processStartedAt = moment().add(1, 'hour');
    nc = make(NiftyChangeStrategy, { ...ncCfg, userId: 'NC-test-d' });
    await nc.processNiftyQuote({ ltp: 22710, prevClose: 22650 });
    assert(!calls.some((c) => c.fn === 'placeLimitBuyBare'), 'slot before process start is not fired');

    for (const id of ['Rec-test', 'Rec-test-b', 'Rec-test-c', 'NC-test', 'NC-test-b', 'NC-test-c', 'NC-test-d']) {
        try { require('fs').unlinkSync(`/tmp/limit-entry-test-${id}-${process.pid}.json`); } catch { /* none written */ }
    }
    process.exit(process.exitCode ?? 0); // config watcher / singletons keep the loop alive
})();
