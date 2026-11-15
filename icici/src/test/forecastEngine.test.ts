/** Forecast rules, candles/trend, the two filters, scoring, the pass-through alarm and Beginner fees (pure). Run: npx tsc, then node ./dist/test/forecastEngine.test.js */
import { checkSubmission, istParts, ForecastConfig } from '../forecast/rules';
import { CandleBuilder, ema, evaluateTrend } from '../forecast/candles';
import { OrderBookImbalanceFilter, TrendFilter, assertEngineFilters, evaluateAll, PassThroughAlarm } from '../forecast/filters';
import { scoreForecast, scoreFromTicks, tickNear } from '../forecast/scorer';
import { monthlyRetainer, weeklyAccuracyFee } from '../forecast/fees';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }
const cfg: ForecastConfig = { hours: { start: '09:20', end: '15:00', expiryEnd: '14:30' }, dailyLimit: 3, windowMinutes: 15, neutralThresholdPoints: 5, holidays: ['2026-11-19'] };
const ist = (s: string) => new Date(`${s}+05:30`);
const base = { cfg, isExpiryDay: false, todaysCount: 0, hasOpenWindow: false };

console.log('submission rules:');
assert(istParts(ist('2026-11-16T09:20:00')).hhmm === '09:20' && istParts(ist('2026-11-16T09:20:00')).weekday === 1, 'IST time parts');
assert(checkSubmission({ ...base, now: ist('2026-11-16T10:00:00') }).ok, 'inside hours on a trading day');
assert(!checkSubmission({ ...base, now: ist('2026-11-16T09:19:00') }).ok && !checkSubmission({ ...base, now: ist('2026-11-16T15:01:00') }).ok, 'outside 09:20 to 15:00');
assert(checkSubmission({ ...base, now: ist('2026-11-16T15:00:00') }).ok, 'the end of the window is inclusive');
assert(!checkSubmission({ ...base, isExpiryDay: true, now: ist('2026-11-17T14:31:00') }).ok && checkSubmission({ ...base, isExpiryDay: true, now: ist('2026-11-17T14:30:00') }).ok, 'expiry day closes at 14:30');
assert(!checkSubmission({ ...base, now: ist('2026-11-14T10:00:00') }).ok, 'a Saturday is refused');
assert(!checkSubmission({ ...base, now: ist('2026-11-19T10:00:00') }).ok, 'a listed holiday is refused');
let v: any = checkSubmission({ ...base, hasOpenWindow: true, now: ist('2026-11-16T10:00:00') });
assert(!v.ok && /still open/.test(v.error), 'one open window at a time');
v = checkSubmission({ ...base, todaysCount: 3, now: ist('2026-11-16T10:00:00') });
assert(!v.ok && /all 3/.test(v.error), 'the daily limit');
assert(checkSubmission({ ...base, todaysCount: 2, now: ist('2026-11-16T10:00:00') }).ok, 'the third is allowed');

console.log('candles and trend:');
const cb = new CandleBuilder();
const t0 = Date.UTC(2026, 10, 16, 4, 0, 0);
for (let m = 0; m < 12; m++) { cb.add(t0 + m * 60_000 + 1000, 100 + m); cb.add(t0 + m * 60_000 + 30_000, 100 + m + 0.5); }
assert(cb.all().length === 12 && cb.all()[0].o === 100 && cb.all()[0].c === 100.5 && cb.all()[0].h === 100.5, 'ticks build OHLC per minute');
assert(cb.closed(t0 + 11 * 60_000 + 10_000).length === 11, 'the forming candle is not closed');
cb.add(t0 - 60_000, 1); assert(cb.all().length === 12, 'a tick from an older minute is ignored');
assert(ema([10, 10, 10], 9).every((x) => x === 10) && ema([1, 2], 3)[1] > 1 && ema([1, 2], 3)[1] < 2, 'EMA basics');
const closedUp = cb.closed(t0 + 12 * 60_000 + 5000);
let tr = evaluateTrend('UP', closedUp, t0 + 12 * 60_000 + 5000);
assert(tr.pass && evaluateTrend('DOWN', closedUp, t0 + 12 * 60_000 + 5000).pass === false, 'a rising series passes UP and fails DOWN');
const down = new CandleBuilder(); for (let m = 0; m < 12; m++) down.add(t0 + m * 60_000, 200 - m);
assert(evaluateTrend('DOWN', down.closed(t0 + 12 * 60_000 + 5000), t0 + 12 * 60_000 + 5000).pass && !evaluateTrend('UP', down.closed(t0 + 12 * 60_000 + 5000), t0 + 12 * 60_000 + 5000).pass, 'a falling series passes DOWN and fails UP');
assert(!evaluateTrend('UP', closedUp.slice(0, 5), t0 + 12 * 60_000).pass, 'too few candles fails closed');
assert(!evaluateTrend('UP', closedUp, t0 + 30 * 60_000).pass, 'a stale newest candle fails closed');
const flat = new CandleBuilder(); for (let m = 0; m < 12; m++) flat.add(t0 + m * 60_000, 100);
assert(!evaluateTrend('UP', flat.closed(t0 + 12 * 60_000 + 5000), t0 + 12 * 60_000 + 5000).pass && !evaluateTrend('DOWN', flat.closed(t0 + 12 * 60_000 + 5000), t0 + 12 * 60_000 + 5000).pass, 'a flat market passes neither direction');

console.log('order-book filter:');
const ob = new OrderBookImbalanceFilter();
const now = 1_000_000;
const depth = (buy: number, sell: number, age = 500) => ({ buyQty: buy, sellQty: sell, ts: now - age, instrument: 'NIFTY-FUT' });
assert(ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(130000, 100000), candles: [] }).pass, 'buy 1,30,000 / sell 1,00,000 passes UP');
assert(!ob.evaluate({ direction: 'DOWN', nowMs: now, depth: depth(130000, 100000), candles: [] }).pass, '...and rejects DOWN');
assert(ob.evaluate({ direction: 'DOWN', nowMs: now, depth: depth(100000, 130000), candles: [] }).pass, 'sell 1,30,000 / buy 1,00,000 passes DOWN');
assert(!ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(119000, 100000), candles: [] }).pass && ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(120000, 100000), candles: [] }).pass, 'the threshold 1.2 is inclusive');
const stale = ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(130000, 100000, 3001), candles: [] });
assert(!stale.pass && /old/.test(stale.reason) && stale.values.ageMs === 3001, 'a snapshot older than 3 s rejects');
assert(ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(130000, 100000, 3000), candles: [] }).pass, '...3 s exactly is still fresh');
assert(!ob.evaluate({ direction: 'UP', nowMs: now, depth: null, candles: [] }).pass && !ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(0, 5), candles: [] }).pass, 'missing / zero depth rejects');
const logged = ob.evaluate({ direction: 'UP', nowMs: now, depth: depth(130000, 100000), candles: [] });
assert(logged.values.buyQty === 130000 && logged.values.sellQty === 100000 && Math.abs((logged.values.ratio as number) - 1.3) < 1e-9 && logged.values.threshold === 1.2 && logged.values.snapshotTs === now - 500, 'the result carries buy qty, sell qty, ratio, threshold and snapshot time');

console.log('decisions and the engine guard:');
const filters = [new OrderBookImbalanceFilter(), new TrendFilter()];
const candlesNow = t0 + 12 * 60_000 + 5000;
let d = evaluateAll(filters, { direction: 'UP', nowMs: candlesNow, depth: { buyQty: 130000, sellQty: 100000, ts: candlesNow - 100, instrument: 'F' }, candles: cb.all() });
assert(d.accepted && d.results.length === 2, 'both pass: accepted');
d = evaluateAll(filters, { direction: 'UP', nowMs: candlesNow, depth: { buyQty: 100000, sellQty: 130000, ts: candlesNow - 100, instrument: 'F' }, candles: cb.all() });
assert(!d.accepted && d.results.length === 2 && d.results[1].pass, 'one fails: rejected, and BOTH results are still recorded');
d = evaluateAll(filters, { direction: 'DOWN', nowMs: candlesNow, depth: { buyQty: 100000, sellQty: 130000, ts: candlesNow - 100, instrument: 'F' }, candles: cb.all() });
assert(!d.accepted && !d.results[1].pass && d.results[0].pass, 'the other fails: rejected');
let threw = false; try { assertEngineFilters([new TrendFilter()]); } catch { threw = true; }
assert(threw, 'the engine refuses to start without the order-book filter');
threw = false; try { assertEngineFilters([new OrderBookImbalanceFilter()]); } catch { threw = true; }
assert(threw, 'the engine refuses to start without the trend filter');
threw = false; try { assertEngineFilters(filters); } catch { threw = true; }
assert(!threw, 'both present: starts');
const bad: any = { name: 'x', evaluate() { throw new Error('boom'); } };
assert(!evaluateAll([bad], { direction: 'UP', nowMs: 0, depth: null, candles: [] }).accepted, 'a filter that throws counts as a rejection');

console.log('pass-through alarm:');
const al = new PassThroughAlarm(30, 0.1);
for (let i = 0; i < 29; i++) al.record(false);
assert(!al.firing() && al.rate() === null, 'no verdict before 30 evaluations');
al.record(false);
assert(al.firing(), '0 of 30 rejected: fires');
const al2 = new PassThroughAlarm(30, 0.1); for (let i = 0; i < 30; i++) al2.record(i < 3);
assert(!al2.firing() && al2.rate() === 0.1, '3 of 30 rejected (10%): does not fire');
const al3 = new PassThroughAlarm(30, 0.1); for (let i = 0; i < 30; i++) al3.record(i < 2);
assert(al3.firing(), '2 of 30 (6.7%): fires');
for (let i = 0; i < 28; i++) al3.record(true);
assert(!al3.firing(), 'the window rolls: recent rejections clear it');

console.log('scoring:');
assert(scoreForecast('UP', 24000, 24010, 5) === 'CORRECT' && scoreForecast('UP', 24000, 23990, 5) === 'INCORRECT' && scoreForecast('DOWN', 24000, 23990, 5) === 'CORRECT' && scoreForecast('DOWN', 24000, 24010, 5) === 'INCORRECT', 'direction decides CORRECT / INCORRECT');
assert(scoreForecast('UP', 24000, 24004.9, 5) === 'NEUTRAL' && scoreForecast('UP', 24000, 24005, 5) === 'CORRECT' && scoreForecast('DOWN', 24000, 23995, 5) === 'CORRECT', 'a move below the threshold is NEUTRAL, the threshold itself counts');
assert(scoreForecast('UP', null, 24010, 5) === 'VOID' && scoreForecast('UP', 24000, null, 5) === 'VOID', 'a missing reference is VOID');
const f = { direction: 'UP' as const, submittedAtMs: 1_000_000, windowMinutes: 15, neutralThresholdPoints: 5 };
const tk = (ts: number, ltp: number) => ({ ts, ltp });
assert(scoreFromTicks(f, [tk(1_000_000 + 2000, 24000), tk(1_000_000 + 900_000 - 3000, 24020)]).outcome === 'CORRECT', 'ticks within 5 s of both points score CORRECT');
assert(scoreFromTicks(f, [tk(1_000_000 + 6000, 24000), tk(1_000_000 + 900_000, 24020)]).outcome === 'VOID', 'no tick within 5 s of the start is VOID');
assert(scoreFromTicks(f, [tk(1_000_000, 24000), tk(1_000_000 + 900_000 + 5001, 24020)]).outcome === 'VOID', 'no tick within 5 s of the end is VOID');
assert(tickNear([tk(100, 1), tk(103, 2), tk(110, 3)], 104, 5)?.ltp === 2, 'the closest tick wins');
assert(scoreFromTicks({ ...f, direction: 'DOWN' }, [tk(1_000_000, 24000), tk(1_000_000 + 900_000, 24001)]).outcome === 'NEUTRAL', 'a flat window is NEUTRAL');

console.log('fees:');
assert(weeklyAccuracyFee(4, { feePerCorrect: 100, monthlyCap: 1000 }, 0).gross === 400, 'correct x fee');
let w = weeklyAccuracyFee(4, { feePerCorrect: 100, monthlyCap: 1000 }, 800);
assert(w.gross === 200 && w.cappedBy === 'monthlyCap', 'capped by what is left of the monthly cap');
assert(weeklyAccuracyFee(4, { feePerCorrect: 100, monthlyCap: 1000 }, 1000).gross === 0 && weeklyAccuracyFee(4, { feePerCorrect: 100, monthlyCap: 1000 }, 5000).gross === 0, 'a spent cap pays zero, never negative');
assert(weeklyAccuracyFee(0, { feePerCorrect: 100, monthlyCap: 1000 }, 0).gross === 0 && weeklyAccuracyFee(-3, { feePerCorrect: 100, monthlyCap: 1000 }, 0).gross === 0 && weeklyAccuracyFee(3, { feePerCorrect: -100, monthlyCap: 1000 }, 0).gross === 0, 'zero correct / negative inputs give zero');
assert(weeklyAccuracyFee(NaN, { feePerCorrect: 100, monthlyCap: 1000 }, 0).gross === 0, 'NaN gives zero');
assert(weeklyAccuracyFee(2, { feePerCorrect: 100, monthlyCap: 0 }, 0).gross === 200, 'a cap of 0 means no cap');
const rates = { retainerMonthly: 3000, minParticipationDays: 15 };
assert(monthlyRetainer(rates, 30, 30, 20).gross === 3000, 'a full month with enough participation');
assert(monthlyRetainer(rates, 15, 30, 15).gross === 1500, 'pro-rated by active days');
assert(monthlyRetainer(rates, 30, 30, 14).gross === 0 && /minimum/.test(monthlyRetainer(rates, 30, 30, 14).reason), 'zero below the minimum participation');
assert(monthlyRetainer(rates, 40, 30, 20).gross === 3000 && monthlyRetainer(rates, -5, 30, 20).gross === 0, 'active days are clamped');
assert(weeklyAccuracyFee.length === 3 && monthlyRetainer.length === 4, 'no fee function takes trading P&L (their parameter lists have no such input)');

console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
process.exit(failed ? 1 : 0);
