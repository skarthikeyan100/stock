/**
 * Per-trade loss budget helpers (src/levelLimits.ts): the budget is an EXIT (stop distance), never a size cap.
 * Run: npx tsc && node ./dist/test/levelLimits.test.js
 */
import { lossBudgetRupees, lossBudgetStop, lossBudgetStopPrice } from '../levelLimits';

function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exitCode = 1; }
const near = (a: number | undefined, b: number, eps = 0.051) => a !== undefined && Math.abs(a - b) < eps;

assert(lossBudgetRupees(100000, 10) === 10000, '10% of 100000 = 10000');
assert(lossBudgetRupees(0, 10) === undefined && lossBudgetRupees(100000, NaN) === undefined && lossBudgetRupees(100000, Infinity) === undefined, 'unusable capital / percent -> no budget');

// The reported case: capital 100000, price 205.4, lot 65, 10%, stop 100 -> 7 lots = 455, stop ~21.98 points (21.95 on the 0.05 tick).
const r = lossBudgetStop({ budget: 10000, newQty: 455, price: 205.4, stopPoints: 100 })!;
assert(near(r.points, 21.98) && r.points === 21.95 && r.tightened && !r.belowTick, `7 lots (455) at a 100-point stop -> ${r.points} points (10000 / 455 = 21.978, floored to the tick)`);
assert(r.points * 455 <= 10000, 'the loss at that stop never exceeds the budget');
assert(lossBudgetStop({ budget: 10000, newQty: 65, price: 205.4, stopPoints: 10 })!.points === 10 && !lossBudgetStop({ budget: 10000, newQty: 65, price: 205.4, stopPoints: 10 })!.tightened, 'a stop already tighter than the budget distance is kept');
assert(near(lossBudgetStop({ budget: 10000, newQty: 455, price: 205.4 })!.points, 21.98), 'no stop configured: the budget distance is the stop');
assert(near(lossBudgetStop({ budget: 10000, newQty: 455, price: 205.4, stopPoints: 0 })!.points, 21.98) && near(lossBudgetStop({ budget: 10000, newQty: 455, price: 205.4, stopPoints: NaN })!.points, 21.98), 'a zero / NaN stop is treated as unset');
const cheap = lossBudgetStop({ budget: 10000, newQty: 1000000, price: 0.5, stopPoints: 100 })!;
assert(cheap.points === 0.05 && cheap.belowTick, 'budget per share under one tick: held at one tick, flagged');
// SENSEX lot 20: 100000 / (price 300 x 20) = 16 lots = 320 qty -> 10000 / 320 = 31.25.
assert(lossBudgetStop({ budget: 10000, newQty: 320, price: 300, stopPoints: 100 })!.points === 31.25, 'SENSEX lot size 20: 320 qty -> 31.25 points');
// Add-more: 455 @ 205.4 open, 65 more @ 215.4 -> combined 520 @ 206.65; stop at 206.65 - 10000/520 = 187.42; from 215.4 that is 27.98 -> floor 27.95.
const add = lossBudgetStop({ budget: 10000, newQty: 65, price: 215.4, stopPoints: 100, existingQty: 455, existingAvg: 205.4 })!;
assert(add.points === 27.95, `add-more is budgeted against the combined position (${add.points})`);
assert(lossBudgetStop({ budget: 0, newQty: 65, price: 100 }) === undefined && lossBudgetStop({ budget: 100, newQty: 0, price: 100 }) === undefined, 'unusable inputs -> undefined');
// Position stop price (merged row / restart restore).
assert(lossBudgetStopPrice(10000, 455, 205.4) === 183.45, 'whole-position stop price: 205.4 - 21.978 = 183.42, rounded UP to the tick 183.45');
assert(lossBudgetStopPrice(10000, 455, 205.4)! * 0 + (205.4 - lossBudgetStopPrice(10000, 455, 205.4)!) * 455 <= 10000, 'its loss is within the budget');
assert(lossBudgetStopPrice(10000, 1000000, 0.5) === 0.45, 'cheap option: at most one tick below the average');
process.exit(process.exitCode ?? 0);
