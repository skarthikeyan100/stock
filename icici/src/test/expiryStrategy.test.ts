/**
 * ExpiryStrategy against a stubbed OrderClient, tokenRouter and global-latch (no broker, no Mongo, no network).
 * Run: npx tsc, then: node ./dist/test/expiryStrategy.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import ExpiryStrategy from '../strategy/ExpiryStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
const tokenRouter = require('../processes/strategies/tokenRouter');
const latch = require('../strategy/globalMaxProfitLatch');
const settings = configService.getConfig().settings as any;
settings.eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let optionLtp = 100;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: `B${calls.filter((c) => c.fn === 'placeLimitBuyBare').length}` };
            case 'getOptionLtp': return optionLtp;
            case 'attachProtection': return { mode: 'gtt' };
            case 'cancelRestingLimitSells': return { cancelFailed: false, filledQty: 0 };
            case 'cancelRestingLimitBuys': return { cancelFailed: false, filledQty: 0 };
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
const watched = new Set<string>();
tokenRouter.watchTokenOnSource = (_s: string, token: string) => { watched.add(token); };
tokenRouter.unwatchTokenOnSource = (_s: string, token: string) => { watched.delete(token); };
const latchedBrokers = new Set<string>();
latch.isGlobalMaxProfitLatched = async (_u: string, broker?: string) => !!broker && latchedBrokers.has(broker);

const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
const buys = () => calls.filter((c) => c.fn === 'placeLimitBuyBare');
const resolves = () => calls.filter((c) => c.fn === 'resolveOptionContract').map((c) => c.args[1]);

let tickSeq = 0;
const nifty = (s: any, ltp = 23500) => s.processNiftyQuote({ ltp, ltt: String(1_700_000_000 + (tickSeq++)), prevClose: 23400 });
const opt = (s: any, token: string, ltp: number) => s.processOptionQuote({ token, ltp });
const trade = (s: any, tsym: string, action: 'Buy' | 'Sell', price: number, brokerOrderId: string, broker = 'kite') =>
    s.updateTrade({ tsym, broker, action, quantity: 65, price, brokerOrderId });

const files: string[] = [];
function make(userId: string, extra: any = {}): any {
    const cfg: any = { type: 'ExpiryStrategy', userId, right: 'CE', maxInvestment: 6600, target: 10, stopLoss: 10, driftPoints: 10, brokers: ['kite'], index: 'NIFTY', ...extra };
    const s: any = new ExpiryStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, settings, key);
    const file = `/tmp/expiry-test-${userId}-${process.pid}.json`;
    files.push(file);
    s.stateFile = () => file;
    return s;
}

(async () => {
    console.log('ExpiryStrategy');

    console.log('  first entry the moment it is enabled (no time slot)');
    calls = []; optionLtp = 100;
    let s = make('EX-first');
    await nifty(s);
    assert(buys().length === 1 && resolves()[0].right === 'CE' && resolves()[0].strike === 23500, `one CE 23500 order (got ${JSON.stringify(resolves())})`);
    assert(buys()[0].args[3] === 65 && buys()[0].args[4] === 100, 'quantity from maxInvestment (6600 / (100 x 65) = 1 lot = 65) as one limit buy at the option LTP 100');
    assert(resolves()[0].expiryOffset === undefined && resolves()[0].skipNearestExpiryDay === false, 'nearest expiry, also on its own expiry day');
    await nifty(s);
    assert(buys().length === 1, 'no second entry on the next tick (the cycle is persisted)');
    const again = make('EX-first');
    await nifty(again);
    assert(buys().length === 1, 'a restart with the same state file does not place the first entry twice');

    console.log('  sized from maxInvestment (2 lots)');
    calls = [];
    s = make('EX-size', { maxInvestment: 13500 });
    await nifty(s);
    assert(buys()[0]?.args[3] === 130, `13500 / (100 x 65) = 2 lots = 130 (got ${buys()[0]?.args[3]})`);

    console.log('  target hit -> buy again at the SAME bought price on the same contract');
    calls = [];
    s = make('EX-target');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    const prot = calls.find((c) => c.fn === 'attachProtection');
    assert(!!prot && prot.args[1].targetPrice === 110 && prot.args[1].stopLossPrice === 90, 'target 110 / stop 90 attached on the fill');
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    optionLtp = 125;
    await nifty(s, 23620);
    assert(buys().length === 2 && resolves()[1].right === 'CE' && resolves()[1].strike === 23500, `re-buy on the same CE 23500 although NIFTY moved to 23620 (got ${JSON.stringify(resolves()[1])})`);
    assert(buys()[1].args[4] === 100, `at the original bought price 100, not the LTP 125 (got ${buys()[1].args[4]})`);
    optionLtp = 100;

    console.log('  stop hit -> buy the OPPOSITE right at a fresh ATM');
    calls = [];
    s = make('EX-stop');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    optionLtp = 70;
    await nifty(s, 23620);
    assert(buys().length === 2 && resolves()[1].right === 'PE' && resolves()[1].strike === 23600, `PE at the fresh ATM 23600 (got ${JSON.stringify(resolves()[1])})`);
    assert(buys()[1].args[4] === 70, 'limit at the PE\'s LTP');
    optionLtp = 100;

    console.log('  a stop on the opposite side flips back to CE');
    await trade(s, 'NIFTY23600PE', 'Buy', 70, 'B2');
    await trade(s, 'NIFTY23600PE', 'Sell', 60, 'S2');
    await nifty(s, 23400);
    assert(buys().length === 3 && resolves()[2].right === 'CE' && resolves()[2].strike === 23400, 'PE stopped: CE at the fresh ATM 23400');

    console.log('  drift of the FIRST (unfilled) buy -> cancel, buy the opposite');
    calls = [];
    s = make('EX-drift');
    await nifty(s);
    await opt(s, 'CE-T', 110);
    assert(count('cancelRestingLimitBuys') === 0, 'LTP exactly driftPoints above (110 vs 100 + 10): nothing yet');
    await opt(s, 'CE-T', 111);
    assert(count('cancelRestingLimitBuys') === 1, 'LTP 111 > 100 + 10: the unfilled buy is cancelled');
    assert(s.state.ex.brokers.kite.pending?.right === 'PE', 'the opposite right (PE) is pending');
    optionLtp = 80;
    await nifty(s, 23500);
    assert(buys().length === 2 && resolves()[1].right === 'PE' && resolves()[1].strike === 23500 && buys()[1].args[4] === 80, 'the next tick buys the PE at a fresh ATM, limit at its LTP');
    await nifty(s, 23500);
    assert(buys().length === 2, 'and only once (the drift cancel is not read as an unfilled entry to retry)');
    optionLtp = 100;

    console.log('  drift of a re-buy after a target -> cancel, buy the opposite');
    calls = [];
    s = make('EX-drift2');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    await nifty(s);
    assert(buys().length === 2 && buys()[1].args[4] === 100, 're-buy resting at 100');
    await opt(s, 'CE-T', 112);
    assert(count('cancelRestingLimitBuys') === 1 && s.state.ex.brokers.kite.pending?.right === 'PE', 'the market ran to 112 (> 110): re-buy cancelled, PE pending');
    await nifty(s);
    assert(buys().length === 3 && resolves()[2].right === 'PE', 'PE bought');

    console.log('  a partly filled buy is not flipped');
    calls = [];
    s = make('EX-partial', { maxInvestment: 13500 });
    await nifty(s);
    await s.updateTrade({ tsym: 'NIFTY23500CE', broker: 'kite', action: 'Buy', quantity: 65, price: 100, brokerOrderId: 'B1' });
    await opt(s, 'CE-T', 125);
    assert(count('cancelRestingLimitBuys') === 0, 'filled 65 of 130: no drift cancel (what filled is protected normally)');

    console.log('  neither target nor stop (manual / end-of-day close) -> nothing more on that broker');
    calls = [];
    s = make('EX-other');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    await trade(s, 'NIFTY23500CE', 'Sell', 102, 'S1');
    await nifty(s);
    await nifty(s);
    assert(buys().length === 1, 'sold at 102: no re-entry');

    console.log('  nothing after the end-of-day close');
    calls = [];
    s = make('EX-eod');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    settings.eodCloseTime = '00:00';
    await nifty(s);
    assert(buys().length === 1, 'target hit after the EOD close: no re-buy');
    calls = [];
    s = make('EX-eod2');
    await nifty(s);
    assert(buys().length === 0, 'no first entry after the EOD close');
    settings.eodCloseTime = '23:59';

    console.log('  global max-profit latch is checked before each re-entry (per broker)');
    calls = [];
    s = make('EX-latch');
    await nifty(s);
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1');
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    latchedBrokers.add('kite');
    await nifty(s);
    assert(buys().length === 1 && !s.state.ex.brokers.kite.pending, 'latched: the stop flip is dropped');
    latchedBrokers.clear();

    console.log('  unfilled entry is retried (twice), then given up');
    calls = [];
    s = make('EX-retry');
    await nifty(s);
    const cancelled = (id: string) => s.onOrderCancelled({ action: 'Buy', tradingSymbol: 'NIFTY23500CE', broker: 'kite', orderId: id, reason: 'cancelled' });
    await cancelled('B1');
    await nifty(s);
    assert(buys().length === 2, 'cancelled with nothing filled: the same buy is tried again (1/2)');
    await cancelled('B2');
    await nifty(s);
    assert(buys().length === 3, 'again (2/2)');
    await cancelled('B3');
    await nifty(s);
    await nifty(s);
    assert(buys().length === 3, 'then no further entry');

    console.log('  brokers act independently (kite and ant)');
    calls = [];
    s = make('EX-two', { brokers: ['kite', 'ant'] });
    await nifty(s);
    assert(buys().length === 2 && buys().map((c) => c.args[6]).join(',') === 'kite,ant', 'the first entry is placed on each broker');
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B1', 'kite');
    await trade(s, 'NIFTY23500CE', 'Buy', 100, 'B2', 'ant');
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1', 'kite');
    await nifty(s, 23500);
    assert(buys().length === 3 && buys()[2].args[6] === 'kite' && resolves()[2].right === 'PE', 'kite stopped: kite alone flips to PE');
    assert(!s.state.ex.brokers.ant.pending && s.state.legs.ant.soldQty === 0, 'ant is untouched (still holding its CE)');

    console.log('  a disabled strategy does nothing');
    calls = [];
    s = make('EX-off');
    s.enabled = false;
    await nifty(s);
    assert(buys().length === 0, 'no entry');

    console.log('  bad config');
    calls = [];
    s = make('EX-badright', { right: 'XX' });
    await nifty(s);
    assert(buys().length === 0, 'right XX: nothing bought');
    s = make('EX-notarget', { target: 'none' });
    await nifty(s);
    assert(buys().length === 0, "target 'none': nothing bought");

    for (const f of files) { try { require('fs').unlinkSync(f); } catch { /* none */ } }
    process.exit(process.exitCode ?? 0);
})();
