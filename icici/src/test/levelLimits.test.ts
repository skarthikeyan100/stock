/**
 * Per-trade loss cap: how many lots keep one stop-out within a % of capital (src/levelLimits.ts).
 * Run: npx tsc && node ./dist/test/levelLimits.test.js
 */
import { maxLotsForLossCap } from '../levelLimits';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

const base = { capital: 100000, maxLossPercent: 10, stopPoints: 10, lotSize: 65 };
assert(maxLotsForLossCap(base) === 15, '10% of 1L = 10000; one lot of 65 loses 650 at a 10-point stop -> 15 lots');
assert(maxLotsForLossCap({ ...base, stopPoints: 0 }) === undefined, 'zero stop -> no cap');
assert(maxLotsForLossCap({ ...base, stopPoints: NaN }) === undefined, 'NaN stop -> no cap');
assert(maxLotsForLossCap({ ...base, lotSize: -65 }) === undefined, 'negative lot size -> no cap');
assert(maxLotsForLossCap({ ...base, capital: 0 }) === undefined, 'no capital -> no cap');
assert(maxLotsForLossCap({ ...base, maxLossPercent: Infinity }) === undefined, 'non-finite percent -> no cap');
assert(maxLotsForLossCap({ ...base, lotSize: 1000 }) === 1, 'exactly one lot fits');
assert(maxLotsForLossCap({ capital: 1000, maxLossPercent: 10, stopPoints: 10, lotSize: 65 }) === 0, 'cap smaller than one lot -> 0 (caller floors to one lot)');
assert(maxLotsForLossCap({ ...base, stopPoints: 25 }) === 6, 'a wider 25-point stop -> 6 lots (10000/1625)');

if (!failed) console.log('ALL PASS');
process.exit(process.exitCode ?? 0);
