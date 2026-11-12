/**
 * NextWeekStrategy against a stubbed OrderClient and a stubbed Yahoo seed (no broker, no Mongo, no network).
 * Run: npx tsc, then: node ./dist/test/nextWeekStrategy.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import NextWeekStrategy from '../strategy/NextWeekStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
const yahoo = require('../lib/yahooCandles');
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
const prevDay = midnight - 86_400;

// 60 previous-day candles around 23900 -> EMA50 about 23900.
const seedCandles = (n = 60) => Array.from({ length: n }, (_, i) => ({ time: prevDay + 3 * 3600 + 45 * 60 + i * 900, open: 23900, high: 23905, low: 23895, close: 23900, volume: 0 }));
let seed: any[] = seedCandles();
let seedCalls = 0;
let seedFails = false;
yahoo.loadSeedCandles = async () => { seedCalls++; if (seedFails) throw new Error('Yahoo down'); return { candles: seed, source: 'yahoo' }; };
yahoo.loadLiveCandles = async () => [];
yahoo.saveLiveCandles = async () => {};

function make(userId: string, extra: any = {}): any {
    const cfg: any = { type: 'NextWeekStrategy', userId, quantity: 65, target: 10, stopLoss: 20, lastEntryTime: '23:59', entryTimeoutMinutes: 5, brokers: ['kite'], index: 'NIFTY', ...extra };
    const s: any = new NextWeekStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/next-week-test-${userId}-${process.pid}.json`;
    return s;
}
const tickAt = (s: any, t: number, ltp: number) => s.processNiftyQuote({ ltp, ltt: String(t), prevClose: 23900 });

// Feeds: 09:15 candle A (24000..24005), 09:30 candle B (a breakout above A's high), then one tick of 09:45 that closes B.
async function feed(s: any, b: { open: number; mid: number; close: number }, next = 24042) {
    for (const [sec, p] of [[5, 24000], [200, 24010], [400, 23995], [800, 24005]] as [number, number][]) await tickAt(s, at(9, 15, sec), p);
    await tickAt(s, at(9, 30, 5), b.open);
    await tickAt(s, at(9, 30, 400), b.mid);
    await tickAt(s, at(9, 30, 800), b.close);
    await tickAt(s, at(9, 45, 3), next);
}

(async () => {
    console.log('NextWeekStrategy');

    console.log('  both agree: call');
    calls = [];
    let s = make('NW-call');
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(seedCalls === 1, 'the seed is loaded once');
    const resolve = last('resolveOptionContract');
    assert(count('resolveOptionContract') === 1 && resolve?.args[1].right === 'CE' && resolve?.args[1].strike === 24050 && resolve?.args[1].expiryOffset === 1, `CE at the ATM strike 24050 on the NEXT expiry (expiryOffset 1) (got ${JSON.stringify(resolve?.args[1])})`);
    const buy = last('placeLimitBuyBare');
    assert(count('placeLimitBuyBare') === 1 && buy?.args[3] === 65 && buy?.args[4] === 100, `one limit buy of exactly 65 at the option price 100 (qty ${buy?.args[3]} @ ${buy?.args[4]})`);
    assert(count('getOptionLtp') >= 1, 'the entry price comes from the option LTP');

    console.log('  the first candle of the day never trades (its predecessor is yesterday)');
    calls = [];
    s = make('NW-first');
    for (const [sec, p] of [[5, 24000], [200, 24500], [800, 24600]] as [number, number][]) await tickAt(s, at(9, 15, sec), p);
    await tickAt(s, at(9, 30, 3), 24600);
    assert(count('placeLimitBuyBare') === 0, 'the 09:15 candle closed far above the EMA but has no same-day c1 -> no trade');

    console.log('  both agree: put');
    calls = [];
    s = make('NW-put');
    seed = seedCandles().map((c) => ({ ...c, open: 24200, high: 24205, low: 24195, close: 24200 })); // EMA 24200, price below
    seedCalls = 0;
    for (const [sec, p] of [[5, 24000], [200, 24010], [400, 23995], [800, 24005]] as [number, number][]) await tickAt(s, at(9, 15, sec), p);
    await tickAt(s, at(9, 30, 5), 23990);
    await tickAt(s, at(9, 30, 800), 23980);
    await tickAt(s, at(9, 45, 3), 23978);
    const put = last('resolveOptionContract');
    assert(count('placeLimitBuyBare') === 1 && put?.args[1].right === 'PE' && put?.args[1].strike === 24000, 'close below c1 low and below the EMA -> PE at 24000 (round(23978/50)*50)');
    seed = seedCandles();

    console.log('  disagreement or no breakout: no trade');
    calls = [];
    s = make('NW-nobreak');
    await feed(s, { open: 24006, mid: 24008, close: 24009 }); // closes inside A's range
    assert(count('placeLimitBuyBare') === 0, 'trend call but no breakout -> no trade');
    calls = [];
    s = make('NW-disagree');
    seed = seedCandles().map((c) => ({ ...c, open: 24200, high: 24205, low: 24195, close: 24200 })); // EMA above price: trend put
    await feed(s, { open: 24006, mid: 24030, close: 24040 }); // breakout call
    assert(count('placeLimitBuyBare') === 0, 'breakout call while price is below the EMA (trend put) -> no trade');
    seed = seedCandles();

    console.log('  fewer than 50 closes: no trade');
    calls = [];
    seed = seedCandles(20);
    s = make('NW-warm');
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(count('placeLimitBuyBare') === 0, '20 seeded + 2 live candles (< 50) -> warming up, no trade');
    seed = seedCandles();

    console.log('  seed failure: no trade, retried later');
    calls = [];
    seedFails = true;
    s = make('NW-seedfail');
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(count('placeLimitBuyBare') === 0, 'Yahoo down -> no trade');
    seedFails = false;

    console.log('  a candle is handled once (restart)');
    calls = [];
    s = make('NW-restart');
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(count('placeLimitBuyBare') === 1, 'first run buys');
    const restarted: any = make('NW-restart');
    restarted.stateFile = s.stateFile;
    await feed(restarted, { open: 24006, mid: 24030, close: 24040 });
    assert(count('placeLimitBuyBare') === 1, 'a restarted strategy replaying the same candle does not buy again');

    console.log('  one position at a time');
    calls = [];
    s = make('NW-one');
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    // the 09:45 candle also breaks out upward while the first position is still resting
    await tickAt(s, at(9, 45, 400), 24080);
    await tickAt(s, at(9, 45, 800), 24100);
    await tickAt(s, at(10, 0, 3), 24101);
    assert(count('placeLimitBuyBare') === 1, 'a second signal while the first position is open does not buy');

    console.log('  quantity must be a whole number of lots');
    calls = [];
    s = make('NW-qty', { quantity: 50 });
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(count('placeLimitBuyBare') === 0, 'quantity 50 is not a multiple of the lot size 65 -> no order');

    console.log('  stale candle is not traded late');
    calls = [];
    s = make('NW-late');
    for (const [sec, p] of [[5, 24000], [200, 24010], [400, 23995], [800, 24005]] as [number, number][]) await tickAt(s, at(9, 15, sec), p);
    await tickAt(s, at(9, 30, 5), 24006);
    await tickAt(s, at(9, 30, 800), 24040);
    await tickAt(s, at(9, 52, 0), 24042); // the first tick after the candle comes 7 minutes late
    assert(count('placeLimitBuyBare') === 0, 'candle closed 7 minutes before the tick that reports it -> not traded');

    console.log('  a restart in the middle of a candle: that candle is incomplete');
    calls = [];
    s = make('NW-partial');
    await tickAt(s, at(9, 22, 0), 24000); // first tick 7 minutes into the 09:15 candle
    await tickAt(s, at(9, 29, 0), 24010);
    await tickAt(s, at(9, 30, 5), 24006);
    await tickAt(s, at(9, 44, 0), 24040);
    await tickAt(s, at(9, 45, 3), 24042);
    assert(count('placeLimitBuyBare') === 0, 'no trade: the 09:15 candle is incomplete and cannot be c1 of the 09:30 candle');

    console.log('  the candle after an incomplete one has no complete c1 either; the one after that does');
    calls = [];
    s = make('NW-partial2');
    await tickAt(s, at(9, 22, 0), 24000);
    await tickAt(s, at(9, 29, 0), 24010);
    await tickAt(s, at(9, 30, 5), 24006);
    await tickAt(s, at(9, 44, 0), 24040);
    await tickAt(s, at(9, 45, 3), 24042); // closes 09:30 with the incomplete 09:15 candle as c1
    assert(count('placeLimitBuyBare') === 0, 'c1 incomplete -> no trade on the 09:30 candle');
    await tickAt(s, at(9, 59, 0), 24100);
    await tickAt(s, at(10, 0, 3), 24101); // closes 09:45 (O24042 C24100) with the complete 09:30 candle (H24040) as c1
    assert(count('placeLimitBuyBare') === 1, 'the next candle has a complete c1 and trades (close 24100 > c1 high 24040, above the EMA)');

    console.log('  disabled strategy');
    calls = [];
    s = make('NW-off');
    s.enabled = false;
    await feed(s, { open: 24006, mid: 24030, close: 24040 });
    assert(calls.length === 0, 'a disabled strategy does nothing, not even the seed');
    process.exit(process.exitCode ?? 0);
})();
