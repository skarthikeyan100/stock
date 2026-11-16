/**
 * The pure M / W rules of MandWStrategy (mandwCycle.ts): no broker, no Mongo.
 * Run: npx tsc, then: node ./dist/test/mandwCycle.test.js
 */
import { MwWatch, classifyExit, opposite, patternName, stepWatch } from '../strategy/mandwCycle';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// CE bought at 100, target 110, stop 90.
const watch = (phase: MwWatch['phase'] = 'peak', startedAt = 0): MwWatch => ({ right: 'CE', tsym: 'X', token: 'T', exchange: 'NFO', entry: 100, target: 110, stop: 90, phase, startedAt });
const HOUR = 3_600_000;
const T30 = 30 * 60_000;

console.log('mandwCycle');

console.log('  sides and names');
assert(opposite('CE') === 'PE' && opposite('PE') === 'CE', 'opposite');
assert(patternName('CE') === 'M' && patternName('PE') === 'W', 'a CE shape is an M, a PE shape a W');

console.log('  classifyExit');
assert(classifyExit(100, 110, 110, 90) === 'target', 'sold at the target 110 -> target');
assert(classifyExit(100, 111, 110, 90) === 'target', 'sold above the target (limit sell filled better) -> target');
assert(classifyExit(100, 90, 110, 90) === 'stop', 'sold at the stop 90 -> stop');
assert(classifyExit(100, 88, 110, 90) === 'stop', 'sold below the stop (gap) -> stop');
assert(classifyExit(100, 90.5, 110, 90) === 'stop', 'a market stop that filled a little above the stop price is still a stop');
assert(classifyExit(100, 100, 110, 90) === 'other', 'sold at the entry (end-of-day close) -> other');
assert(classifyExit(100, 102, 110, 90) === 'other', 'sold at 102, short of the half way to the target -> other');
assert(classifyExit(100, 0, 110, 90) === 'other', 'no exit price -> other');

console.log('  the M on a CE: 100 -> 110 sold, back to 100, 110 again');
let w = watch();
let r = stepWatch(w, 108, 1000, T30);
assert(r.event === 'none' && r.phase === 'peak', 'still high, no valley yet -> nothing');
r = stepWatch(w, 110, 1000, T30);
assert(r.event === 'none', 'back at the target before any valley is not a second peak');
r = stepWatch(w, 100.5, 1000, T30);
assert(r.event === 'none', 'a pullback to 100.5 is NOT the valley (no tolerance: it must come to the original price)');
r = stepWatch(w, 100, 1000, T30);
assert(r.event === 'valley' && r.phase === 'valley', 'the price at exactly 100 is the valley');
w = watch('valley');
r = stepWatch(w, 99, 1000, T30);
assert(r.event === 'none' && r.phase === 'valley', 'below the original price after the valley: still waiting');
r = stepWatch(w, 109.9, 1000, T30);
assert(r.event === 'none', '109.9 is not yet the second peak');
r = stepWatch(w, 110, 1000, T30);
assert(r.event === 'pattern', 'the price at exactly 110 after the valley completes the pattern');
r = stepWatch(w, 115, 1000, T30);
assert(r.event === 'pattern', 'above 110 also completes it');

console.log('  a gap straight from a peak to below the original price');
w = watch('peak');
r = stepWatch(w, 95, 1000, T30);
assert(r.event === 'valley', '95 in the peak phase is a valley (between the stop 90 and the entry 100)');

console.log('  failed shape');
r = stepWatch(watch('peak'), 90, 1000, T30);
assert(r.event === 'failed', 'the price at the stop level before any valley -> failed');
r = stepWatch(watch('valley'), 89, 1000, T30);
assert(r.event === 'failed', 'the price below the stop level after the valley -> failed');
r = stepWatch(watch('valley'), 90.01, 1000, T30);
assert(r.event === 'none', 'just above the stop level is not failed');

console.log('  timeout (the whole watch)');
r = stepWatch(watch('peak', 0), 105, T30 - 1, T30);
assert(r.event === 'none', 'one ms before the timeout -> nothing');
r = stepWatch(watch('peak', 0), 105, T30, T30);
assert(r.event === 'timeout', 'at the timeout, no pattern -> timeout');
r = stepWatch(watch('valley', 0), 99, T30, T30);
assert(r.event === 'timeout', 'valley seen but no second peak in time -> timeout');
r = stepWatch(watch('peak', 0), NaN, T30, T30);
assert(r.event === 'timeout', 'no price at all: only the timeout is checked');
r = stepWatch(watch('peak', 0), NaN, 1000, T30);
assert(r.event === 'none', 'no price and no timeout -> nothing');
r = stepWatch(watch('peak', 0), 0, HOUR, T30);
assert(r.event === 'timeout', 'a zero price is no price');
r = stepWatch(watch('valley', 0), 110, T30, T30);
assert(r.event === 'pattern', 'the pattern completing on the same tick as the timeout wins');
r = stepWatch(watch('valley', 0), 85, T30, T30);
assert(r.event === 'failed', 'failed beats the timeout');
