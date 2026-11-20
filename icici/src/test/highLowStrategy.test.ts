/**
 * HighLowStrategy against a stubbed OrderClient and tokenRouter (no broker, no Mongo, no network): two 10-minute candles decide CE / PE.
 * Run: npx tsc, then: node ./dist/test/highLowStrategy.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import HighLowStrategy, { c2QualityFailure, completelyOutside, breakoutConfirmed } from '../strategy/HighLowStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
const tokenRouter = require('../processes/strategies/tokenRouter');
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
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: `${args[1].right}-T`, exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: `B${calls.filter((c) => c.fn === 'placeLimitBuyBare').length}` };
            case 'getOptionLtp': return 100;
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
tokenRouter.watchTokenOnSource = () => undefined;
tokenRouter.unwatchTokenOnSource = () => undefined;
const buys = () => calls.filter((c) => c.fn === 'placeLimitBuyBare');
const resolves = () => calls.filter((c) => c.fn === 'resolveOptionContract').map((c) => c.args[1]);

const midnight = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
// 10-minute candles on the 09:15 grid start at :05, :15, :25, :35, :45, :55 plus 0 s, e.g. 10:05, 10:15, 10:25 (09:15 + n x 10 min).
const at = (h: number, m: number, sec = 0) => midnight + h * 3600 + m * 60 + sec;
const tick = (s: any, ltp: number, ltt: number) => s.processNiftyQuote({ ltp, ltt: String(ltt), prevClose: 23400 });

function make(userId: string, extra: any = {}): any {
    const cfg: any = { type: 'HighLowStrategy', userId, quantity: 130, target: 10, stopLoss: 8, lastEntryTime: '23:59', brokers: ['paper'], index: 'NIFTY', ...extra };
    const s: any = new HighLowStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/highlow-test-${userId}-${process.pid}.json`;
    return s;
}

// c1 = 10:05-10:15 (H 23510 L 23490), c2 = 10:15-10:25 as given, then a tick in 10:25 closes c2.
async function twoCandles(s: any, c2: { high: number; low: number; close: number }) {
    await tick(s, 23500, at(10, 5, 0));
    await tick(s, 23510, at(10, 8, 30));
    await tick(s, 23490, at(10, 12, 0));
    await tick(s, 23500, at(10, 15, 0));
    await tick(s, c2.high, at(10, 18, 30));
    await tick(s, c2.low, at(10, 21, 0));
    await tick(s, c2.close, at(10, 24, 50)); // last tick of c2 = its close
    await tick(s, 23500, at(10, 25, 5)); // first tick of the next candle: c2 closes
}

(async () => {
    console.log('HighLowStrategy');

    console.log('  c2 closes above c1 high: buys CE (ATM, paper)');
    calls = [];
    let s = make('HL-ce');
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 1 && resolves()[0]?.right === 'CE' && resolves()[0]?.strike === 23500, 'one CE buy at the ATM strike');
    assert(buys()[0].args[1].broker === 'paper' || buys()[0].args.some((a: any) => a === 'paper' || a?.broker === 'paper'), 'on the paper broker');

    console.log('  c2 closes below c1 low: buys PE');
    calls = [];
    s = make('HL-pe');
    await twoCandles(s, { high: 23505, low: 23480, close: 23478 });
    assert(buys().length === 1 && resolves()[0]?.right === 'PE', 'one PE buy');

    console.log('  c2 closes inside c1 range (even with a higher high): no trade');
    calls = [];
    s = make('HL-none');
    await twoCandles(s, { high: 23530, low: 23480, close: 23500 });
    assert(buys().length === 0, 'no buy');

    console.log('  c2 closes outside c1 range by less than 10 points: no trade');
    calls = [];
    s = make('HL-small');
    await twoCandles(s, { high: 23530, low: 23495, close: 23519 });
    assert(buys().length === 0, 'close 9 above c1 high: no buy');

    console.log('  c2 quality filters: body dominance and close location');
    const ok = { open: 100, high: 110, low: 100, close: 108 };
    assert(c2QualityFailure(ok, 'CE', 60, 70) === undefined, 'CE body 80%, CLV 80% passes');
    assert(c2QualityFailure({ ...ok, close: 106 }, 'CE', 60, 70) !== undefined, 'CE body 60% is not above 60');
    assert(c2QualityFailure({ open: 100, high: 110, low: 94, close: 108 }, 'CE', 60, 70) !== undefined, 'CE CLV 87.5% ok but body 50% fails');
    assert(c2QualityFailure({ open: 95, high: 110, low: 90, close: 108 }, 'CE', 60, 70) === undefined, 'CE body 65%, CLV 90% passes');
    assert(c2QualityFailure({ open: 100, high: 120, low: 99, close: 112 }, 'CE', 50, 70) !== undefined, 'CE CLV 61.9% below 70 fails');
    assert(c2QualityFailure({ open: 110, high: 110, low: 100, close: 102 }, 'PE', 60, 70) === undefined, 'PE body 80%, CLV 20% passes');
    assert(c2QualityFailure({ open: 110, high: 110, low: 100, close: 104 }, 'PE', 50, 70) !== undefined, 'PE CLV 40% above 30 fails');
    assert(c2QualityFailure({ open: 100, high: 100, low: 100, close: 100 }, 'CE', 60, 70) !== undefined, 'R2 = 0: no trade');
    console.log('  c2 filters in the strategy: weak body blocks the buy');
    calls = [];
    s = make('HL-body');
    await twoCandles(s, { high: 23560, low: 23495, close: 23525 }); // body 25/65 = 38%
    assert(buys().length === 0, 'no buy on a weak c2 body');
    calls = [];
    s = make('HL-body0', { bodyDominance: 30 });
    await twoCandles(s, { high: 23560, low: 23495, close: 23525 });
    assert(buys().length === 0, 'bodyDominance 30 passes the body but CLV 46% < 70 still blocks');
    calls = [];
    s = make('HL-body-off', { bodyDominance: 30, closeLocation: 40 });
    await twoCandles(s, { high: 23560, low: 23495, close: 23525 });
    assert(buys().length === 1, 'both relaxed: buys');

    console.log('  completelyOutside / breakoutConfirmed helpers');
    assert(completelyOutside({ high: 110, low: 90 }, { high: 130, low: 111 }, 'CE') === true, 'CE: c2 low 111 > c1 high 110');
    assert(completelyOutside({ high: 110, low: 90 }, { high: 130, low: 110 }, 'CE') === false, 'CE: c2 low 110 = c1 high is not completely outside');
    assert(completelyOutside({ high: 110, low: 90 }, { high: 89, low: 70 }, 'PE') === true, 'PE: c2 high 89 < c1 low 90');
    assert(completelyOutside({ high: 110, low: 90 }, { high: 90, low: 70 }, 'PE') === false, 'PE: c2 high 90 = c1 low is not completely outside');
    assert(completelyOutside({ high: 110, low: 90 }, { high: NaN, low: 111 }, 'CE') === false, 'non-numeric: false');
    assert(breakoutConfirmed({ high: 110, low: 90 }, { close: 111 }, 'CE') === true && breakoutConfirmed({ high: 110, low: 90 }, { close: 110 }, 'CE') === false, 'CE: c3 close must be above c1 high');
    assert(breakoutConfirmed({ high: 110, low: 90 }, { close: 89 }, 'PE') === true && breakoutConfirmed({ high: 110, low: 90 }, { close: 90 }, 'PE') === false, 'PE: c3 close must be below c1 low');

    console.log('  fullyOutside: c2 whole range above c1 high');
    // c1 = 10:05-10:15 (H 23510 L 23490); c2 opens at 23515 (above c1 high), low 23512, high 23530, close 23528
    const outsideC2 = async (st: any, open: number) => {
        await tick(st, 23500, at(10, 5, 0)); await tick(st, 23510, at(10, 8, 30)); await tick(st, 23490, at(10, 12, 0));
        await tick(st, open, at(10, 15, 0)); await tick(st, 23530, at(10, 18, 30)); await tick(st, 23512, at(10, 21, 0)); await tick(st, 23528, at(10, 24, 50));
        await tick(st, 23520, at(10, 25, 5));
    };
    calls = [];
    s = make('HL-fo-on', { fullyOutside: true });
    await outsideC2(s, 23515);
    assert(buys().length === 1 && resolves()[0]?.right === 'CE', 'fullyOutside on, c2 completely outside: buys CE');
    calls = [];
    s = make('HL-fo-block', { fullyOutside: true });
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 0, 'fullyOutside on, c2 low 23495 below c1 high 23510: no buy');
    calls = [];
    s = make('HL-fo-off');
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 1, 'fullyOutside off (default): same candles buy');
    calls = [];
    s = make('HL-fo-bad', { fullyOutside: 'yes' });
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 1, "fullyOutside 'yes' (not a boolean) is treated as false");

    console.log('  confirmCandle: the next candle must still close beyond c1');
    const c3 = async (st: any, close: number) => { // c3 = 10:25-10:35: opens 23500 (twoCandles), then ticks, then a tick in 10:35 closes it
        await tick(st, 23520, at(10, 28, 0)); await tick(st, close, at(10, 34, 50)); await tick(st, close, at(10, 35, 5));
    };
    calls = [];
    s = make('HL-cc-ok', { confirmCandle: true });
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 0, 'signal held after c2: no buy yet');
    await c3(s, 23515);
    assert(buys().length === 1 && resolves()[0]?.right === 'CE', 'c3 closes 23515 > c1 high 23510: CE bought at c3 close');
    calls = [];
    s = make('HL-cc-fail', { confirmCandle: true });
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    await c3(s, 23505);
    assert(buys().length === 0, 'c3 closes back inside c1 range: false breakout, no buy');
    calls = [];
    s = make('HL-cc-pe', { confirmCandle: true });
    await twoCandles(s, { high: 23505, low: 23480, close: 23478 });
    assert(buys().length === 0, 'PE signal held');
    await c3(s, 23485);
    assert(buys().length === 1 && resolves()[0]?.right === 'PE', 'PE confirmed: c3 close 23485 < c1 low 23490');
    calls = [];
    s = make('HL-cc-off');
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 1, 'confirmCandle off (default): buys at c2 close');

    console.log('  a trade still open: no second entry');
    calls = [];
    s = make('HL-open');
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 1 && s.isRunning(), 'first signal bought, leg active');

    console.log('  stopLoss none / missing target: refused (needs both)');
    calls = [];
    s = make('HL-nostop', { stopLoss: 'none' });
    await twoCandles(s, { high: 23530, low: 23495, close: 23525 });
    assert(buys().length === 0, "stopLoss 'none': not trading");

    console.log('  sizing: quantity or the rupee budget');
    s = make('HL-qty');
    assert(s.sizeOrder(1, 100, 'NIFTY') === 130, 'quantity 130 -> 130');
    s = make('HL-amt', { quantity: undefined, maxInvestment: 100000 });
    assert(s.sizeOrder(100000, 100, 'NIFTY') === 975, 'budget 1,00,000 at 100 -> 15 lots (975)');
    assert(s.sizeOrder(100000, 0, 'NIFTY') === 0, 'no price -> 0');

    console.log('  checkpoint exit is on for HighLow');
    assert(make('HL-cp').checkpointExit() === true, 'checkpointExit true');
})().catch((e) => { console.log('  FAIL: threw', e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
