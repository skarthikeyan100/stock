/**
 * BreakoutData / sideVsVwap / sideVsAverage, the aligned + seeded stats builder (and that the default builder is unchanged), FutVwapTracker and
 * the Yahoo candle parser. Pure: no broker, no Mongo, no network.
 * Run: npx tsc, then: node ./dist/test/candleLibs.test.js
 */
import '../util/tz';
import { BreakoutData, sideVsVwap, sideVsAverage } from '../lib/breakoutData';
import { createStatsBuilder } from '../processes/strategies/niftyStatsBuilder';
import { FutVwapTracker } from '../lib/futVwap';
import { parseYahooCandles } from '../lib/yahooCandles';
import { seededEMA } from '../lib/indicators';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const c = (open: number, high: number, low: number, close: number) => ({ open, high, low, close });

console.log('BreakoutData');
assert(BreakoutData.from(c(100, 105, 99, 103), c(103, 110, 102, 108)) === 'call', 'close above its open and above c1 high -> call');
assert(BreakoutData.from(c(100, 105, 99, 103), c(103, 106, 95, 97)) === 'put', 'close below its open and below c1 low -> put');
assert(BreakoutData.from(c(100, 105, 99, 103), c(103, 107, 102, 104)) === undefined, 'inside c1 range -> none');
assert(BreakoutData.from(c(100, 105, 99, 103), c(108, 110, 104, 106)) === undefined, 'above c1 high but below its own open -> none (a red candle is not a call)');
assert(BreakoutData.from(c(100, 105, 99, 103), c(98, 99, 94, 96)) === 'put', 'a red candle closing below c1 low -> put');
assert(BreakoutData.from(c(100, 105, 99, 103), c(100, 106, 98, 105)) === undefined, 'close equal to c1 high is not above it -> none');
assert(BreakoutData.from(c(100, 105, 99, 103), c(100, 101, 99, 99)) === undefined, 'close equal to c1 low is not below it -> none');
assert(BreakoutData.from(null, c(1, 2, 0.5, 1.5)) === undefined && BreakoutData.from(c(1, 2, 0.5, 1.5), undefined) === undefined, 'a missing candle -> none');
assert(BreakoutData.from(c(1, 2, 0.5, NaN), c(1, 2, 0.5, 1.5)) === undefined, 'a NaN field -> none');

console.log('sideVsVwap / sideVsAverage');
assert(sideVsVwap(101, 100) === 'call' && sideVsVwap(99, 100) === 'put' && sideVsVwap(100, 100) === undefined, 'above = call, below = put, equal = none');
assert(sideVsVwap(NaN, 100) === undefined && sideVsVwap(100, 0) === undefined, 'unusable numbers -> none');
assert(sideVsAverage(101, 100) === 'call' && sideVsAverage(99, 100) === 'put' && sideVsAverage(100, 100) === undefined, 'trend: above = call, below = put, equal = none');

console.log('stats builder: default (drifting) behaviour is unchanged');
{
    const b = createStatsBuilder(900);
    let emitted = 0;
    const base = 1_800_000_000 - (1_800_000_000 % 900) + 100; // not on a boundary
    for (let i = 0; i < 20; i++) if (b.record(100 + i, base + i * 100)) emitted++;
    assert(emitted === 2, `20 ticks 100 s apart close two 900 s buckets (got ${emitted})`);
    assert(b.closes().length === 2, 'closes() has one entry per candle');
}

console.log('stats builder: aligned');
{
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000 / 1000; // midnight UTC today (epoch s), a multiple of 900
    const open = day + 3 * 3600 + 45 * 60; // 09:15 IST = 03:45 UTC
    const b = createStatsBuilder(900, { aligned: true });
    assert(b.record(100, open + 5) === null && b.record(110, open + 400) === null && b.record(95, open + 899) === null, 'ticks inside the 09:15 bucket close nothing');
    const r = b.record(101, open + 900 + 7);
    assert(!!r && r.newStats.open === 100 && r.newStats.high === 110 && r.newStats.low === 95 && r.newStats.close === 95, 'the tick that crosses the boundary is NOT in the candle it closes (O100 H110 L95 C95)');
    assert(r?.newStats.candleTime === open, 'candleTime is the bucket start (09:15)');
    assert(r?.oldStats === null, 'no previous candle for the first one');
    const r2 = b.record(120, open + 1800 + 1);
    assert(!!r2 && r2.newStats.open === 101 && r2.newStats.close === 101 && r2.newStats.candleTime === open + 900, 'the next candle starts with the crossing tick (09:30, a one-tick candle)');
    assert(r2?.oldStats?.candleTime === open, 'oldStats is the previous candle');
    const gap = b.record(130, open + 1800 + 900 * 4 + 5);
    assert(!!gap && gap.newStats.candleTime === open + 1800, 'a gap of several buckets still emits the candle that was open, and restarts on the tick\'s own boundary');
    assert(b.record(1, open) === null, 'an older tick is ignored');
}

console.log('stats builder: seed');
{
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000 / 1000 - 86_400;
    const seed = Array.from({ length: 60 }, (_, i) => ({ time: day + i * 900, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));
    const b = createStatsBuilder(900, { aligned: true });
    b.seed(seed);
    assert(b.closes().length === 60 && b.closes()[59] === 159.5, 'closes() holds the seeded closes');
    const ema = seededEMA(b.closes(), 50);
    assert(ema.length === 60 && Number.isFinite(ema[59]) && ema[59] < 159.5 && ema[59] > 100, `a 50 EMA is available on the first live candle (${ema[59].toFixed(2)})`);
    const open = Math.floor(Date.now() / 86_400_000) * 86_400_000 / 1000 + 3 * 3600 + 45 * 60;
    b.record(200, open + 3);
    const r = b.record(201, open + 905);
    assert(!!r && r.oldStats?.candleTime === seed[59].time && r.oldStats.close === 159.5, 'the last seeded candle is the previous candle of the first live one');
    assert(b.closes().length === 61, 'the live candle is appended to the history');
    b.seed([{ time: 1, open: 0, high: 0, low: 0, close: 0 }]);
    assert(b.closes().length === 0, 'unusable seed rows are dropped, and seeding replaces any history');
}

console.log('FutVwapTracker');
{
    const t = new FutVwapTracker();
    t.update({ lp: '100', v: '1000' }, 'd1');
    assert(t.best() === undefined, 'no VWAP before any volume delta or ap');
    t.update({ lp: '102', v: '1100' }, 'd1');
    t.update({ lp: '104', v: '1300' }, 'd1');
    const own = (102 * 100 + 104 * 200) / 300;
    assert(Math.abs((t.state().ownVwap ?? 0) - own) < 1e-9, `own VWAP = sum(price x delta volume)/sum(delta volume) (${own.toFixed(4)})`);
    assert(t.best()?.source === 'own', 'own VWAP is used when ap is absent');
    t.update({ ap: '101.5' }, 'd1');
    assert(t.best()?.vwap === 101.5 && t.best()?.source === 'ap', 'ap is preferred once it arrives, and a v/ap-only update keeps the price');
    assert(t.state().ltp === 104, 'a tick without lp keeps the last price');
    const issues = t.update({ lp: '105', v: '900' }, 'd1');
    assert(issues.includes('volume-went-backwards'), 'volume going backwards is reported');
    assert(t.state().ownVwap === undefined, 'and the own VWAP restarts from the new base');
    assert(t.update({ ap: '0' }, 'd1').includes('ap-is-zero') && t.state().exchangeVwap === 101.5, 'ap = 0 is reported and does not replace the last good ap');
    t.update({ lp: '99', v: '5000' }, 'd2');
    assert(t.state().exchangeVwap === undefined, 'a new trading day starts clean');
}

console.log('Yahoo candle parser');
{
    const day = (y: number, m: number, d: number, h: number, mi: number) => Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000);
    const ts = [day(2026, 11, 10, 9, 15), day(2026, 11, 10, 9, 30), day(2026, 11, 10, 15, 30), day(2026, 11, 11, 9, 15), day(2026, 11, 12, 9, 15)];
    const json = { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: [1, 2, 3, 4, 5], high: [2, 3, 4, 5, 6], low: [0.5, 1, 2, 3, 4], close: [1.5, null, 3.5, 4.5, 5.5], volume: [0, 0, 0, 0, 0] }] } }] } };
    const out = parseYahooCandles(json, '2026-11-12');
    assert(out.length === 2, `keeps 2 of 5: drops a null row, the 15:30 candle and today's candle (got ${out.length})`);
    assert(out[0].time === ts[0] && out[1].time === ts[3] && out[0].close === 1.5, 'oldest first, fields mapped');
    assert(parseYahooCandles({}, '2026-11-12').length === 0 && parseYahooCandles(null, '2026-11-12').length === 0, 'an unexpected payload gives no candles instead of throwing');
}
process.exit(process.exitCode ?? 0);
