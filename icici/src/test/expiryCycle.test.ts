/**
 * The pure rules of ExpiryStrategy (expiryCycle.ts): no broker, no Mongo.
 * Run: npx tsc, then: node ./dist/test/expiryCycle.test.js
 */
import { atmStrike, classifyExit, drifted, nextAfterExit, opposite } from '../strategy/expiryCycle';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

console.log('expiryCycle');

console.log('  opposite / atmStrike');
assert(opposite('CE') === 'PE' && opposite('PE') === 'CE', 'opposite flips the right');
assert(atmStrike(23524) === 23500 && atmStrike(23526) === 23550 && atmStrike(23500) === 23500, 'ATM rounds to the nearest 50');

console.log('  classifyExit (entry 100, target 110, stop 90)');
assert(classifyExit(100, 110, 110, 90) === 'target', 'sold at the target: target');
assert(classifyExit(100, 112, 110, 90) === 'target', 'sold above the target: target');
assert(classifyExit(100, 90, 110, 90) === 'stop', 'sold at the stop: stop');
assert(classifyExit(100, 92, 110, 90) === 'stop', 'a market stop that filled a little above the stop price: stop');
assert(classifyExit(100, 88, 110, 90) === 'stop', 'sold below the stop: stop');
assert(classifyExit(100, 102, 110, 90) === 'other', 'sold between (end-of-day / manual): other');
assert(classifyExit(100, 98, 110, 90) === 'other', 'sold a little below entry (manual): other');
assert(classifyExit(0, 110, 110, 90) === 'other' && classifyExit(100, 0, 110, 90) === 'other', 'no price: other');

console.log('  nextAfterExit');
const t = nextAfterExit('target', 'CE', 23500, 100);
assert(t?.right === 'CE' && t.price === 100 && t.strike === 23500, 'target: the same right, same strike, at the bought price');
const s = nextAfterExit('stop', 'CE', 23500, 100);
assert(s?.right === 'PE' && s.price === undefined && s.strike === undefined, 'stop: the opposite right, no fixed price or strike (fresh ATM at its LTP)');
const sp = nextAfterExit('stop', 'PE', 23500, 100);
assert(sp?.right === 'CE', 'stop on a PE: CE');
assert(nextAfterExit('other', 'CE', 23500, 100) === null, 'other: nothing');

console.log('  drifted (buy limit 100, driftPoints 10)');
assert(!drifted(100, 100, 10) && !drifted(110, 100, 10), 'at the price, or exactly driftPoints above: not drifted');
assert(drifted(110.05, 100, 10), 'more than driftPoints above: drifted');
assert(!drifted(80, 100, 10), 'below the limit (it fills): not drifted');
assert(!drifted(NaN, 100, 10) && !drifted(0, 100, 10) && !drifted(120, 100, 0) && !drifted(120, 0, 10), 'no price / no limit / driftPoints 0: not drifted');
