/**
 * MandWStrategy against a stubbed OrderClient, tokenRouter and global-latch (no broker, no Mongo, no network).
 * Run: npx tsc, then: node ./dist/test/mandwStrategy.test.js
 */
import '../util/tz';
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import MandWStrategy from '../strategy/MandWStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
const tokenRouter = require('../processes/strategies/tokenRouter');
const latch = require('../strategy/globalMaxProfitLatch');
(configService.getConfig().settings as any).eodCloseTime = '23:59';

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
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
const watched = new Set<string>();
tokenRouter.watchTokenOnSource = (_s: string, token: string) => { watched.add(token); };
tokenRouter.unwatchTokenOnSource = (_s: string, token: string) => { watched.delete(token); };
let latched = false;
latch.isGlobalMaxProfitLatched = async () => latched;

const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
const buys = () => calls.filter((c) => c.fn === 'placeLimitBuyBare');
const resolves = () => calls.filter((c) => c.fn === 'resolveOptionContract').map((c) => c.args[1]);

const midnight = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
let tickSeq = 0;
const nifty = (s: any, ltp = 23500) => s.processNiftyQuote({ ltp, ltt: String(midnight + 10 * 3600 + (tickSeq++)), prevClose: 23400 });
const opt = (s: any, token: string, ltp: number) => s.processOptionQuote({ token, ltp });

function make(userId: string, extra: any = {}): any {
    const cfg: any = {
        type: 'MandWStrategy', userId, quantity: 65, target: 10, stopLoss: 10, startSide: 'CE', startTime: moment().format('HH:mm'), lastEntryTime: '23:59',
        patternTimeoutMinutes: 30, entryTimeoutMinutes: 5, brokers: ['kite'], index: 'NIFTY', ...extra,
    };
    const s: any = new MandWStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/mandw-test-${userId}-${process.pid}.json`;
    return s;
}
const trade = (s: any, tsym: string, action: 'Buy' | 'Sell', price: number, brokerOrderId = 'B1') => s.updateTrade({ tsym, broker: 'kite', action, quantity: 65, price, brokerOrderId });

// First entry: CE bought at 100, filled.
async function enterAndFill(s: any, tsym = 'NIFTY23500CE') {
    await nifty(s);
    await trade(s, tsym, 'Buy', 100);
}

(async () => {
    console.log('MandWStrategy');

    console.log('  every broker is its own instance');
    const { expandBrokerInstances } = require('../util/strategyInstances');
    const inst = expandBrokerInstances({ type: 'MandWStrategy', userId: 'MandW-NIFTY', brokers: ['kite', 'ant', 'breeze'], quantity: 65 });
    assert(inst.length === 3 && inst.map((c: any) => c.userId).join(',') === 'MandW-NIFTY,MandW-NIFTY-ANT,MandW-NIFTY-Breeze' && inst.every((c: any) => c.brokers.length === 1), 'one instance per broker, each with its own userId and a single broker');

    MandWStrategy.processStartedAt = moment().subtract(1, 'hour');

    console.log('  first entry at the start time');
    calls = [];
    let s = make('MW-first');
    await nifty(s);
    assert(buys().length === 1 && resolves()[0].right === 'CE' && resolves()[0].strike === 23500, `one CE 23500 order (got ${JSON.stringify(resolves())})`);
    assert(buys()[0].args[3] === 65 && buys()[0].args[4] === 100, 'quantity 65 at the option price 100');
    assert(resolves()[0].expiryOffset === undefined, 'the nearest expiry');
    await nifty(s);
    assert(buys().length === 1, 'no second entry on the next tick (the cycle is persisted)');

    console.log('  startSide PE');
    calls = [];
    s = make('MW-pe', { startSide: 'PE' });
    await nifty(s, 23520);
    assert(resolves()[0]?.right === 'PE' && resolves()[0]?.strike === 23500, 'PE at the ATM strike round(23520/50)*50 = 23500');

    console.log('  no first entry before the process start, or after the 5 minute window, or before the start time');
    calls = [];
    MandWStrategy.processStartedAt = moment().add(1, 'hour');
    await nifty(make('MW-early-start'));
    MandWStrategy.processStartedAt = moment().subtract(1, 'hour');
    await nifty(make('MW-late', { startTime: moment().subtract(10, 'minutes').format('HH:mm') }));
    await nifty(make('MW-future', { startTime: moment().add(10, 'minutes').format('HH:mm') }));
    assert(count('placeLimitBuyBare') === 0, 'none of the three bought');

    console.log('  target hit -> watch -> valley -> second peak -> buy the PE (the M)');
    calls = []; watched.clear();
    s = make('MW-m');
    await enterAndFill(s);
    assert(count('attachProtection') === 1 && calls.find((c) => c.fn === 'attachProtection')!.args[1].targetPrice === 110 && calls.find((c) => c.fn === 'attachProtection')!.args[1].stopLossPrice === 90, 'target 110 / stop 90 attached');
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    let w = s.state.mw?.watch;
    assert(!!w && w.right === 'CE' && w.entry === 100 && w.target === 110 && w.stop === 90 && w.phase === 'peak', `the sold CE is watched (${JSON.stringify(w)})`);
    await nifty(s, 23510);
    assert(watched.has('CE-T'), 'the tick feed of the watched contract is switched on');
    assert(s.canHandleOptionQuote({ token: 'CE-T', ltp: 105 }) === true, 'its ticks are accepted though nothing is held');
    await opt(s, 'CE-T', 106);
    assert(s.state.mw.watch.phase === 'peak', '106: nothing');
    await opt(s, 'CE-T', 100);
    assert(s.state.mw.watch.phase === 'valley', '100 (the original price): valley');
    await opt(s, 'CE-T', 104);
    assert(s.state.mw.watch && !s.state.mw.pending, '104: still waiting');
    await opt(s, 'CE-T', 110);
    assert(!s.state.mw.watch && s.state.mw.pending?.right === 'PE', 'second peak at 110: the pattern is identified, a PE is pending');
    await nifty(s, 23490);
    assert(buys().length === 2 && resolves()[1].right === 'PE' && resolves()[1].strike === 23500, `the PE is bought on the next NIFTY tick (got ${JSON.stringify(resolves())})`);
    assert(!watched.has('CE-T'), 'the watched contract is no longer subscribed');

    console.log('  stop hit -> reverse at once (CE -> PE)');
    calls = []; watched.clear();
    s = make('MW-stop');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    assert(!s.state.mw.watch && s.state.mw.pending?.right === 'PE', 'sold at the stop 90: no watch, PE pending');
    await nifty(s, 23400);
    assert(buys().length === 2 && resolves()[1].right === 'PE' && resolves()[1].strike === 23400, 'PE at the new ATM strike 23400');

    console.log('  the PE cycle is the mirror: PE target -> W -> buy the CE');
    optionLtp = 100;
    await trade(s, 'NIFTY23400PE', 'Buy', 100, 'B2');
    await trade(s, 'NIFTY23400PE', 'Sell', 110, 'S2');
    assert(s.state.mw.watch?.right === 'PE', 'the PE is watched');
    await opt(s, 'PE-T', 99);
    await opt(s, 'PE-T', 110);
    assert(s.state.mw.pending?.right === 'CE', 'a W on the PE -> CE pending');
    await nifty(s, 23600);
    assert(buys().length === 3 && resolves()[2].right === 'CE' && resolves()[2].strike === 23600, 'CE at 23600');

    console.log('  failed shape: the watched price falls to the stop level -> reverse at once');
    calls = []; watched.clear();
    s = make('MW-fail');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    await nifty(s);
    await opt(s, 'CE-T', 90);
    assert(!s.state.mw.watch && s.state.mw.pending?.right === 'PE', 'price 90 during the watch: PE pending');
    await nifty(s);
    assert(buys().length === 2 && resolves()[1].right === 'PE', 'PE bought');

    console.log('  timeout: the same side is bought again');
    calls = []; watched.clear();
    s = make('MW-timeout');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    s.state.mw.watch.startedAt = Date.now() - 31 * 60_000;
    await nifty(s);
    assert(buys().length === 2 && resolves()[1].right === 'CE', 'no pattern in 30 min: CE again');

    console.log('  an exit that is neither the target nor the stop ends it (end-of-day / manual close)');
    calls = []; watched.clear();
    s = make('MW-other');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 101, 'S1');
    await nifty(s);
    assert(!s.state.mw.watch && !s.state.mw.pending && buys().length === 1, 'sold at 101: no watch, no new entry');

    console.log('  a reversal waits while a position is held');
    calls = []; watched.clear();
    s = make('MW-wait');
    await enterAndFill(s);
    s.state.mw.pending = { right: 'PE', reason: 'test', at: Date.now() };
    await nifty(s);
    assert(buys().length === 1 && !!s.state.mw.pending, 'CE still held: PE not bought, still pending');

    console.log('  a stale reversal is dropped, never placed late');
    calls = []; watched.clear();
    s = make('MW-stale');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    s.state.mw.pending.at = Date.now() - 5 * 60_000;
    await nifty(s);
    assert(buys().length === 1 && !s.state.mw.pending, 'pending older than 2 minutes: dropped');

    console.log('  no reversal after lastEntryTime');
    calls = []; watched.clear();
    s = make('MW-lastentry', { lastEntryTime: '23:59' });
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    s.cfg = () => ({ ...(make('x').cfg()), lastEntryTime: '00:01', startTime: '00:00' });
    await nifty(s);
    assert(buys().length === 1 && !s.state.mw.pending, 'past lastEntryTime: the pending PE is dropped');

    console.log('  global max profit hit: no reversal');
    calls = []; watched.clear(); latched = true;
    s = make('MW-latch');
    await enterAndFill(s).catch(() => {});
    await trade(s, 'NIFTY23500CE', 'Sell', 90, 'S1');
    await nifty(s);
    assert(buys().length <= 1 && !s.state.mw?.pending, 'latched on every broker: no new buy');
    latched = false;

    console.log('  an entry that never fills is tried again, twice at most');
    calls = []; watched.clear();
    s = make('MW-nofill');
    await nifty(s);
    const cancel = (orderId: string, tsym = 'NIFTY23500CE') => s.onOrderCancelled({ tradingSymbol: tsym, broker: 'kite', action: 'Buy', orderId, reason: 'cancelled' });
    await cancel('B1');
    assert(s.state.mw.pending?.right === 'CE' && s.state.mw.retries === 1, 'cancelled with nothing filled: CE pending again (1/2)');
    await nifty(s);
    assert(buys().length === 2, 'second entry placed');
    await cancel(`B${buys().length}`);
    await nifty(s);
    assert(buys().length === 3, 'third entry placed (2/2)');
    await cancel(`B${buys().length}`);
    await nifty(s);
    assert(buys().length === 3 && !s.state.mw.pending, 'a third failure: no further entry today');

    console.log('  a restart resumes the watch and does not buy again');
    calls = []; watched.clear();
    s = make('MW-restart');
    await enterAndFill(s);
    await trade(s, 'NIFTY23500CE', 'Sell', 110, 'S1');
    await opt(s, 'CE-T', 100);
    const re: any = make('MW-restart');
    await nifty(re);
    assert(buys().length === 1, 'the restarted strategy does not buy again');
    assert(re.state.mw?.watch?.phase === 'valley' && watched.has('CE-T'), 'the watch (valley phase) is restored and its feed re-armed');
    await opt(re, 'CE-T', 110);
    assert(re.state.mw.pending?.right === 'PE', 'the restored watch completes the pattern');

    console.log('  disabled strategy');
    calls = [];
    s = make('MW-off');
    s.enabled = false;
    await nifty(s);
    await opt(s, 'CE-T', 100);
    assert(calls.length === 0, 'a disabled strategy does nothing');

    console.log('  target and stop both required');
    calls = [];
    s = make('MW-notarget', { target: 'none' });
    await nifty(s);
    assert(buys().length === 0, "target 'none' -> no order");

    console.log('  quantity must be a whole number of lots');
    calls = [];
    s = make('MW-qty', { quantity: 50 });
    await nifty(s);
    assert(buys().length === 0, 'quantity 50 -> no order');
    process.exit(process.exitCode ?? 0);
})();
