/**
 * Checkpoint exit (checkpointTrail.ts + LimitEntryStrategy.placeCheckpointExit / onCheckpointTick) with a stubbed OrderClient.
 * Run: npx tsc, then: node ./dist/test/checkpointTrail.test.js
 */
import '../util/tz';
import OrderClient from '../processes/strategies/OrderClient';
import HighLowStrategy from '../strategy/HighLowStrategy';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import { FiveMinuteCloses, checkpointTrigger, lockedStop } from '../strategy/checkpointTrail';
const tokenRouter = require('../processes/strategies/tokenRouter');
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }

let calls: { fn: string; args: any[] }[] = [];
let failSell: string | null = null;
const fake: any = new Proxy({}, { get: (_t, fn: string) => async (...args: any[]) => {
    calls.push({ fn, args });
    if (fn === 'chunkedSquareOff' && failSell) { const m = failSell; failSell = null; throw new Error(m); }
    if (fn === 'cancelRestingLimitSells') return { filledQty: 0, cancelFailed: false };
    return {};
} });
(OrderClient as any).getInstance = () => fake;
tokenRouter.watchTokenOnSource = () => undefined;
tokenRouter.unwatchTokenOnSource = () => undefined;
const sells = () => calls.filter((c) => c.fn === 'chunkedSquareOff').map((c) => c.args[1].quantity);

let now = Date.UTC(2026, 10, 19, 5, 0, 0); // a 5-minute boundary
Date.now = () => now;
const MIN = 60_000;

function make(): any {
    const cfg: any = { type: 'HighLowStrategy', userId: 'CP', quantity: 130, target: 10, stopLoss: 8, brokers: ['paper'], index: 'NIFTY' };
    const s: any = new HighLowStrategy('CP');
    s.enabled = true;
    s.cfg = () => cfg;
    s.setting = (key: string) => settingFor(cfg, configService.getConfig().settings as any, key);
    s.stateFile = () => `/tmp/checkpoint-test-${process.pid}.json`;
    s.ensureLoaded();
    return s;
}
const leg = (): any => ({ broker: 'paper', tsym: 'NIFTY23500CE', token: 'T', exchange: 'NFO', qty: 130, price: 100, status: 'filled', placedAt: 0, filledQty: 130, boughtValue: 13000, soldQty: 0, soldValue: 0 });
const q = (s: any, ltp: number) => s.processOptionQuote({ ltp, ltt: '0', token: 'T' });

(async () => {
    console.log('FiveMinuteCloses');
    const f = new FiveMinuteCloses();
    assert(f.onTick(100, now) === undefined && f.onTick(105, now + MIN) === undefined, 'first (partial) candle: no close');
    assert(f.onTick(106, now + 5 * MIN) === undefined, 'rollover after the partial candle: skipped');
    assert(f.onTick(111, now + 7 * MIN) === undefined, 'inside the second candle');
    assert(f.onTick(112, now + 10 * MIN) === 111, 'second candle close = its last tick');
    assert(lockedStop(110) === 108, 'stop = close - 2');
    assert(checkpointTrigger({ halfQty: 65, checkpoint: 110, target2: 115, phase: 'watch' }, 110) && !checkpointTrigger({ halfQty: 65, checkpoint: 110, target2: 115, phase: 'watch' }, 109.95), 'close >= checkpoint');

    console.log('checkpoint flow: buy 100, target 10, stop 8, qty 130 (2 lots)');
    let s = make();
    let l = leg();
    s.state.legs['x'] = l;
    await s.placeExit(l);
    assert(l.exit === 'self' && l.stop === 92 && l.checkpoint?.checkpoint === 110 && l.checkpoint?.target2 === 115 && l.checkpoint?.halfQty === 65, 'stop 92, checkpoint 110, second target 115, half 65');
    now += 0; await q(s, 100);                  // partial candle
    now += 5 * MIN; await q(s, 111);            // rolls over: partial skipped
    assert(sells().length === 0, 'partial candle never judged');
    now += 2 * MIN; await q(s, 114);            // touches above 110 inside a candle: no sell on a tick
    now += 3 * MIN; await q(s, 113);            // rollover: the candle's last tick was 114 -> close 114 >= 110
    assert(sells().length === 1 && sells()[0] === 65, 'candle close 114 >= 110: half (65) sold at market');
    assert(l.checkpoint.phase === 'moved' && l.stop === 112, 'stop of the rest = 114 - 2');
    l.soldQty = 65; l.soldValue = 65 * 114;
    await q(s, 111);
    assert(sells().length === 2 && sells()[1] === 65, 'tick <= new stop: the remaining 65 closed');

    console.log('close below the checkpoint: nothing sold; stop still applies');
    calls = []; s = make(); l = leg(); s.state.legs['y'] = l; await s.placeExit(l);
    now += 5 * MIN; await q(s, 100); now += 5 * MIN; await q(s, 105); now += 5 * MIN; await q(s, 109.9); now += 5 * MIN; await q(s, 108);
    assert(sells().length === 0 && l.checkpoint.phase === 'watch', 'closes 105 and 109.9 < 110: no sell');
    await q(s, 92);
    assert(sells().length === 1 && sells()[0] === 130, 'tick at 92: whole leg out at the stop');

    console.log('second target after the checkpoint');
    calls = []; s = make(); l = leg(); s.state.legs['z'] = l; await s.placeExit(l);
    now += 5 * MIN; await q(s, 100); now += 5 * MIN; await q(s, 111); now += 5 * MIN; await q(s, 111);
    assert(l.checkpoint.phase === 'moved' && sells()[0] === 65 && l.stop === 109, 'close 111 -> half sold, stop 109');
    l.soldQty = 65; l.soldValue = 65 * 111;
    await q(s, 115);
    assert(sells()[1] === 65, 'tick >= 115: the rest (65) closed');

    console.log('refused sell is retried; one lot is not halved');
    calls = []; s = make(); l = leg(); s.state.legs['r'] = l; await s.placeExit(l);
    now += 5 * MIN; await q(s, 100); now += 5 * MIN; await q(s, 111);
    failSell = 'not placed [NOT_PLACED]';
    const { NOT_PLACED_TAG } = require('../ipc/orderProtocol');
    failSell = `x ${NOT_PLACED_TAG}`;
    now += 5 * MIN; await q(s, 111);
    assert(l.checkpoint.phase === 'watch' && l.checkpoint.sellQty === undefined && l.checkpoint.trigger === 111, 'refused: still watching, trigger kept');
    await q(s, 111);
    assert(l.checkpoint.phase === 'moved' && sells().length === 2, 'retried on the next tick and moved');
    calls = []; s = make(); l = { ...leg(), qty: 65, filledQty: 65, boughtValue: 6500 }; s.state.legs['o'] = l; await s.placeExit(l);
    assert(!l.checkpoint, 'one lot: no checkpoint exit (plain target / stop)');
})().catch((e) => { console.log('  FAIL: threw', e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
