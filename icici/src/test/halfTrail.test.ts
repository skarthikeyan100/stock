/**
 * Half-at-target + trail exit: the pure rules (halfTrail.ts) and MandWStrategy with `trailDistance` against a stubbed OrderClient.
 * Run: npx tsc, then: node ./dist/test/halfTrail.test.js
 */
import '../util/tz';
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import MandWStrategy from '../strategy/MandWStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import { splitLots, stepHalfTrail, HalfTrailState } from '../strategy/halfTrail';
const tokenRouter = require('../processes/strategies/tokenRouter');
const latch = require('../strategy/globalMaxProfitLatch');
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// ---- pure rules ----
console.log('splitLots');
assert(splitLots(65, 65) === null, '1 lot: not engaged');
assert(splitLots(130, 65)?.halfQty === 65 && splitLots(130, 65)?.trailQty === 65, '2 lots: 1 + 1');
assert(splitLots(195, 65)?.halfQty === 65 && splitLots(195, 65)?.trailQty === 130, '3 lots: 1 sold at target, 2 trail');
assert(splitLots(325, 65)?.halfQty === 130, '5 lots: 2 + 3');
assert(splitLots(100, 65) === null && splitLots(0, 65) === null, 'not whole lots / zero: null');

console.log('stepHalfTrail');
const st = (): HalfTrailState => ({ halfQty: 65, targetPrice: 110, dist: 4, phase: 'half', sellQty: 65 });
let h = st();
let r = stepHalfTrail(h, 100, 111, 0);
assert(r.action === 'hold' && !r.switched && h.phase === 'half', 'half not sold yet: nothing happens, whatever the price');
r = stepHalfTrail(h, 100, 112, 65);
assert(r.action === 'hold' && r.switched && h.phase === 'trail' && h.trail?.peak === 112, 'half sold at 112: trail starts, peak 112');
r = stepHalfTrail(h, 100, 118, 65);
assert(r.action === 'hold' && h.trail?.peak === 118, 'peak follows to 118');
r = stepHalfTrail(h, 100, 115, 65);
assert(r.action === 'hold', '115 > 118 - 4: hold');
r = stepHalfTrail(h, 100, 114, 65);
assert(r.action === 'exit' && r.exitLevel === 114, 'exit at peak - 4 = 114');
h = st();
r = stepHalfTrail(h, 100, 109, 65);
assert(r.action === 'exit' && r.switched && r.exitLevel === 110, 'half sold but price already below the target: floor 110, exits at once');
h = st();
r = stepHalfTrail(h, 100, 111, 65);
r = stepHalfTrail(h, 100, 110, 65);
assert(r.action === 'exit' && r.exitLevel === 110, 'peak 111 -> level max(110, 107) = 110: never below the target');
h = st(); h.sellQty = undefined;
r = stepHalfTrail(h, 100, 112, 65);
assert(!r.switched && h.phase === 'half', 'sell not yet recorded: phase stays half');
h = st(); stepHalfTrail(h, 100, 120, 65);
const copy: HalfTrailState = JSON.parse(JSON.stringify(h));
r = stepHalfTrail(copy, 100, 116, 65);
assert(r.action === 'exit' && r.peak === 120, 'state survives a JSON round trip (restart): peak 120 kept (exit level 116)');

// ---- MandWStrategy with trailDistance ----
let calls: { fn: string; args: any[] }[] = [];
let sellMode: 'ok' | 'refuse' | 'unknown' = 'ok';
let sellsDone = 0;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: `B${calls.filter((c) => c.fn === 'placeLimitBuyBare').length}` };
            case 'getOptionLtp': return 100;
            case 'attachProtection': return { mode: 'gtt' };
            case 'cancelRestingLimitSells': return { cancelFailed: false, filledQty: 0 };
            case 'brokerPlaceLimitSellBare':
                if (sellMode === 'refuse' && sellsDone++ === 0) throw new Error('[NOT_PLACED] refused');
                if (sellMode === 'unknown') throw new Error('timeout');
                return {};
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
tokenRouter.watchTokenOnSource = () => {};
tokenRouter.unwatchTokenOnSource = () => {};
latch.isGlobalMaxProfitLatched = async () => false;
const count = (fn: string) => calls.filter((c) => c.fn === fn).length;
const sells = () => calls.filter((c) => c.fn === 'brokerPlaceLimitSellBare').map((c) => c.args[1]);

const midnight = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
let seq = 0;
const nifty = (s: any, ltp = 23500) => s.processNiftyQuote({ ltp, ltt: String(midnight + 10 * 3600 + (seq++)), prevClose: 23400 });
const opt = (s: any, ltp: number) => s.processOptionQuote({ token: 'CE-T', ltp });
const fill = (s: any, action: 'Buy' | 'Sell', qty: number, price: number, id = 'B1') => s.updateTrade({ tsym: 'NIFTY23500CE', broker: 'kite', action, quantity: qty, price, brokerOrderId: id });

function make(userId: string, extra: any = {}): any {
    const cfg: any = {
        type: 'MandWStrategy', userId, quantity: 195, target: 10, stopLoss: 10, trailDistance: 4, startSide: 'CE', startTime: moment().format('HH:mm'), lastEntryTime: '23:59',
        patternTimeoutMinutes: 30, entryTimeoutMinutes: 5, brokers: ['kite'], index: 'NIFTY', ...extra,
    };
    const s: any = new MandWStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/halftrail-test-${userId}-${process.pid}.json`;
    return s;
}

(async () => {
    MandWStrategy.processStartedAt = moment().subtract(1, 'hour');

    console.log('MandW, 3 lots: half at the target, rest trails');
    calls = []; sellMode = 'ok';
    let s = make('HT-3');
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    assert(count('attachProtection') === 0, 'no broker GTT / exitMonitor (they cover the whole quantity only)');
    assert(sells().length === 1 && sells()[0].quantity === 65 && sells()[0].price === 110, `one resting sell of 65 @ 110 (got ${JSON.stringify(sells())})`);
    const leg = () => Object.values(s.state.legs)[0] as any;
    assert(leg().stop === 90 && leg().halfTrail?.phase === 'half', 'stop 90 covers the whole leg meanwhile');
    await opt(s, 105);
    assert(count('chunkedSquareOff') === 0, '105: nothing');
    await fill(s, 'Sell', 65, 110, 'S1');
    await opt(s, 112);
    assert(leg().stop === undefined && leg().halfTrail.phase === 'trail', 'half filled: stop dropped, trail phase');
    await opt(s, 118);
    await opt(s, 115);
    assert(count('chunkedSquareOff') === 0, '115 with peak 118: hold');
    await opt(s, 114);
    const sq = calls.filter((c) => c.fn === 'chunkedSquareOff');
    assert(sq.length === 1 && sq[0].args[1].quantity === 130, `trail exit sells the remaining 130 (got ${JSON.stringify(sq.map((c) => c.args[1]))})`);
    await fill(s, 'Sell', 130, 114, 'S2');
    assert(s.state.mw?.watch?.right === 'CE' && s.state.mw.watch.target === 110, 'sold at an average above the target: classified as a target, the M watch starts');

    console.log('MandW, 3 lots: stop before the target sells everything');
    calls = [];
    s = make('HT-stop');
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    await opt(s, 90);
    const sq2 = calls.filter((c) => c.fn === 'chunkedSquareOff');
    assert(sq2.length === 1 && sq2[0].args[1].quantity === 195 && count('cancelRestingLimitSells') === 1, 'stop at 90: resting half cancelled, all 195 sold');

    console.log('MandW, 1 lot: trailing not engaged');
    calls = [];
    s = make('HT-1', { quantity: 65 });
    await nifty(s);
    await fill(s, 'Buy', 65, 100);
    assert(count('attachProtection') === 1 && sells().length === 0 && !leg().halfTrail, 'normal target / stop protection, no half sell');

    console.log('no trailDistance: unchanged');
    calls = [];
    s = make('HT-off', { trailDistance: undefined });
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    assert(count('attachProtection') === 1 && sells().length === 0, 'normal exit for 3 lots when the key is absent');

    console.log('sell refused once, then retried; unknown outcome is never retried');
    calls = []; sellMode = 'refuse'; sellsDone = 0;
    s = make('HT-refuse');
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    assert(leg().exit === undefined && leg().halfTrail?.sellQty === undefined && leg().stop === 90, 'refused: stop armed, no claim left, exit retried later');
    (leg() as any).exitRetryAt = undefined;
    await nifty(s);
    await new Promise((r) => setTimeout(r, 1100));
    await nifty(s);
    assert(sells().length === 2 && leg().exit === 'self', `the retry placed it (sell calls ${sells().length})`);
    calls = []; sellMode = 'unknown';
    s = make('HT-unknown');
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    await new Promise((r) => setTimeout(r, 1100));
    await nifty(s);
    assert(sells().length === 1 && leg().exit === 'self', 'unknown outcome: one attempt only, recorded as placed');

    console.log('restart in the trail phase keeps the peak');
    calls = []; sellMode = 'ok';
    s = make('HT-restart');
    await nifty(s);
    await fill(s, 'Buy', 195, 100);
    await fill(s, 'Sell', 65, 110, 'S1');
    await opt(s, 120);
    await new Promise((r) => setTimeout(r, 1100));
    await opt(s, 121);
    const re: any = make('HT-restart');
    await nifty(re);
    calls = [];
    await re.processOptionQuote({ token: 'CE-T', ltp: 118 });
    assert(count('chunkedSquareOff') === 0, 'restored peak 121 (level 117): 118 holds');
    await re.processOptionQuote({ token: 'CE-T', ltp: 117 });
    assert(count('chunkedSquareOff') === 1, '117 exits: the peak survived the restart');
    process.exit(process.exitCode ?? 0);
})();
