/**
 * BreakoutStrategy against a stubbed OrderClient (no broker, no Mongo).
 * Run: npx tsc, then: node ./dist/test/breakoutStrategy.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import BreakoutStrategy from '../strategy/BreakoutStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import { FutQuote } from '../model/model';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}-W${args[1].expiryOffset ?? 0}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: 'B1' };
            case 'getOptionLtp': return 100;
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
const last = (fn: string) => calls.filter((c) => c.fn === fn).pop();

const midnight = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
const at = (h: number, m: number, s = 0) => midnight + h * 3600 + m * 60 + s;

function make(userId: string, extra: any = {}): any {
    const cfg: any = { type: 'BreakoutStrategy', userId, quantity: 65, target: 10, stopLoss: 20, lastEntryTime: '23:59', entryTimeoutMinutes: 5, brokers: ['kite'], index: 'NIFTY', ...extra };
    const s: any = new BreakoutStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/breakout-test-${userId}-${process.pid}.json`;
    return s;
}
const fut = (t: number, ltp: number, vwap?: number) => Object.assign(new FutQuote(), { ltp, ltt: String(t), token: '61471', volume: 1000, vwap, vwapSource: vwap === undefined ? undefined : 'ap' }) as FutQuote;
const niftyTick = (s: any, ltp: number) => s.processNiftyQuote({ ltp, ltt: String(at(9, 20)), prevClose: 24000 });

// Candle 1 (09:15-09:30) of the future closes at `close`; its VWAP is `vwap`. A 09:30 tick closes it.
async function candle1(s: any, close: number, vwap: number | undefined, lateTickAt = at(9, 30, 3)) {
    await s.processFutQuote(fut(at(9, 15, 5), 24100, vwap));
    await s.processFutQuote(fut(at(9, 20, 0), 24120, vwap));
    await s.processFutQuote(fut(at(9, 29, 50), close, vwap));
    await s.processFutQuote(fut(lateTickAt, close + 1, vwap));
}

(async () => {
    console.log('BreakoutStrategy');

    console.log('  close above the VWAP -> CE');
    calls = [];
    let s = make('BO-call');
    await niftyTick(s, 24037);
    await candle1(s, 24140, 24110);
    const r = last('resolveOptionContract');
    assert(count('placeLimitBuyBare') === 1 && r?.args[1].right === 'CE' && r?.args[1].strike === 24050, `CE at the ATM strike of the INDEX (24037 -> 24050), not of the future (got ${JSON.stringify(r?.args[1])})`);
    assert(r?.args[1].expiryOffset === undefined, 'the nearest expiry (no expiry offset)');
    const buy = last('placeLimitBuyBare');
    assert(buy?.args[3] === 65 && buy?.args[4] === 100, `exactly 65 at the option price 100 (got ${buy?.args[3]} @ ${buy?.args[4]})`);

    console.log('  close below the VWAP -> PE');
    calls = [];
    s = make('BO-put');
    await niftyTick(s, 23988);
    await candle1(s, 24090, 24110);
    const p = last('resolveOptionContract');
    assert(count('placeLimitBuyBare') === 1 && p?.args[1].right === 'PE' && p?.args[1].strike === 24000, 'PE at 24000 (23988 -> 24000)');

    console.log('  no trade');
    calls = [];
    s = make('BO-eq');
    await niftyTick(s, 24037);
    await candle1(s, 24110, 24110);
    assert(count('placeLimitBuyBare') === 0, 'close equal to the VWAP -> no trade');
    calls = [];
    s = make('BO-novwap');
    await niftyTick(s, 24037);
    await candle1(s, 24140, undefined);
    assert(count('placeLimitBuyBare') === 0, 'no VWAP from the feed -> no trade');
    calls = [];
    s = make('BO-late');
    await niftyTick(s, 24037);
    await candle1(s, 24140, 24110, at(9, 40, 0));
    assert(count('placeLimitBuyBare') === 0, 'candle 1 reported 10 minutes after it closed -> not traded late');
    calls = [];
    s = make('BO-nonifty');
    await candle1(s, 24140, 24110);
    assert(count('placeLimitBuyBare') === 0, 'no index price for the ATM strike -> no trade');
    calls = [];
    s = make('BO-partial');
    await s.processFutQuote(fut(at(9, 24, 0), 24100, 24110)); // first tick 9 minutes into candle 1 (restart)
    await niftyTick(s, 24037);
    await s.processFutQuote(fut(at(9, 29, 50), 24140, 24110));
    await s.processFutQuote(fut(at(9, 30, 3), 24141, 24110));
    assert(count('placeLimitBuyBare') === 0, 'a first tick 9 minutes into candle 1 (restart) -> the candle is incomplete, no trade');
    calls = [];
    s = make('BO-qty', { quantity: 100 });
    await niftyTick(s, 24037);
    await candle1(s, 24140, 24110);
    assert(count('placeLimitBuyBare') === 0, 'quantity 100 is not a multiple of 65 -> no order');

    console.log('  candle 2 never trades');
    calls = [];
    s = make('BO-c2');
    await niftyTick(s, 24037);
    await candle1(s, 24090, 24110); // put at the end of candle 1
    const before = count('placeLimitBuyBare');
    await s.processFutQuote(fut(at(9, 35, 0), 24150, 24112));
    await s.processFutQuote(fut(at(9, 44, 50), 24200, 24115)); // candle 2 closes far above c1's high and the VWAP
    await s.processFutQuote(fut(at(9, 45, 3), 24201, 24115));
    assert(before === 1 && count('placeLimitBuyBare') === 1, 'one entry at the end of candle 1; candle 2 (a strong call) places nothing');
    assert(count('resolveOptionContract') === 1, 'candle 2 does not even look up a contract');
    await s.processFutQuote(fut(at(10, 0, 3), 24300, 24120));
    assert(count('placeLimitBuyBare') === 1, 'nothing after the analysis either (one trade a day)');

    console.log('  one trade a day, also across a restart');
    calls = [];
    s = make('BO-restart');
    await niftyTick(s, 24037);
    await candle1(s, 24140, 24110);
    assert(count('placeLimitBuyBare') === 1, 'first run buys');
    const again: any = make('BO-restart');
    again.stateFile = s.stateFile;
    await niftyTick(again, 24037);
    await candle1(again, 24140, 24110);
    assert(count('placeLimitBuyBare') === 1, 'a restarted strategy seeing candle 1 again does not buy again');

    console.log('  wants future ticks');
    assert(s.wantsFutQuotes() === true, 'the dispatcher sends it future ticks');

    console.log('  disabled strategy');
    calls = [];
    s = make('BO-off');
    s.enabled = false;
    await niftyTick(s, 24037);
    await candle1(s, 24140, 24110);
    assert(calls.length === 0, 'a disabled strategy places and looks up nothing');
    process.exit(process.exitCode ?? 0);
})();
