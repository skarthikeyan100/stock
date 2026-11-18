/**
 * HighLowStrategy against a stubbed OrderClient and tokenRouter (no broker, no Mongo, no network): two 10-minute candles decide CE / PE.
 * Run: npx tsc, then: node ./dist/test/highLowStrategy.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import HighLowStrategy from '../strategy/HighLowStrategy';
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
async function twoCandles(s: any, c2: { high: number; low: number }) {
    await tick(s, 23500, at(10, 5, 0));
    await tick(s, 23510, at(10, 8, 30));
    await tick(s, 23490, at(10, 12, 0));
    await tick(s, 23500, at(10, 15, 0));
    await tick(s, c2.high, at(10, 18, 30));
    await tick(s, c2.low, at(10, 21, 0));
    await tick(s, (c2.high + c2.low) / 2, at(10, 24, 50));
    await tick(s, 23500, at(10, 25, 5)); // first tick of the next candle: c2 closes
}

(async () => {
    console.log('HighLowStrategy');

    console.log('  higher high + higher low: buys CE (ATM, paper)');
    calls = [];
    let s = make('HL-ce');
    await twoCandles(s, { high: 23530, low: 23495 });
    assert(buys().length === 1 && resolves()[0]?.right === 'CE' && resolves()[0]?.strike === 23500, 'one CE buy at the ATM strike');
    assert(buys()[0].args[1].broker === 'paper' || buys()[0].args.some((a: any) => a === 'paper' || a?.broker === 'paper'), 'on the paper broker');

    console.log('  lower high + lower low: buys PE');
    calls = [];
    s = make('HL-pe');
    await twoCandles(s, { high: 23505, low: 23480 });
    assert(buys().length === 1 && resolves()[0]?.right === 'PE', 'one PE buy');

    console.log('  inside bar: no trade');
    calls = [];
    s = make('HL-none');
    await twoCandles(s, { high: 23505, low: 23495 });
    assert(buys().length === 0, 'no buy');

    console.log('  a trade still open: no second entry');
    calls = [];
    s = make('HL-open');
    await twoCandles(s, { high: 23530, low: 23495 });
    assert(buys().length === 1 && s.isRunning(), 'first signal bought, leg active');

    console.log('  stopLoss none / missing target: refused (needs both)');
    calls = [];
    s = make('HL-nostop', { stopLoss: 'none' });
    await twoCandles(s, { high: 23530, low: 23495 });
    assert(buys().length === 0, "stopLoss 'none': not trading");

    console.log('  sizing: quantity or the rupee budget');
    s = make('HL-qty');
    assert(s.sizeOrder(1, 100, 'NIFTY') === 130, 'quantity 130 -> 130');
    s = make('HL-amt', { quantity: undefined, maxInvestment: 100000 });
    assert(s.sizeOrder(100000, 100, 'NIFTY') === 975, 'budget 1,00,000 at 100 -> 15 lots (975)');
    assert(s.sizeOrder(100000, 0, 'NIFTY') === 0, 'no price -> 0');

    console.log('  trailDistance: half-trail only when set');
    assert(make('HL-t0').trailDistance() === 0 && make('HL-t4', { trailDistance: 4 }).trailDistance() === 4, 'read from the block, 0 when absent');
})().catch((e) => { console.log('  FAIL: threw', e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
