/**
 * Per-trade loss budget on a frontend manual buy (bookkeeping.resolveManualBuyQuantity / lossBudgetStopPoints,
 * settings.levelRules.<level>.maxLossPerTradePercent): the budget does NOT size the order (all capital lots are bought); it tightens the stop.
 * Run: npx tsc && node ./dist/test/manualBuyLossCap.test.js
 */
import bookkeeping from '../processes/order/bookkeeping';
import { NIFTY_FREEZE_QUANTITY } from '../constants';

function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exitCode = 1; }
const LOT = 65;
const TSYM = 'NIFTY26N1725150CE';
const base = { lossLimit: 1e9, lotLimit: 10, maxInvestment: 1e9 };

bookkeeping.updateUserSettings('cap-b', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'beginner' });
const q = (price: number, explicit?: number, stop?: number, user = 'cap-b') => bookkeeping.resolveManualBuyQuantity(user, TSYM, price, explicit, LOT, stop);
const stopFor = (user: string, qty: number, price: number, stop?: number, explicit?: number) => bookkeeping.lossBudgetStopPoints(user, 'kite', TSYM, qty, price, stop, explicit);

// The reported case: capital 100000, price 205.4, lot 65, 10%, stop 100.
const qty = q(205.4, undefined, 100);
assert(qty === 7 * LOT, `the order is sized from the capital: 7 lots = 455 (got ${qty}); the loss budget no longer shrinks it`);
const pts = stopFor('cap-b', qty, 205.4, 100)!;
assert(Math.abs(pts - 21.98) < 0.05 && pts * qty <= 10000, `the stop is tightened to ~21.98 points (${pts}), loss at the stop <= 10000`);
assert(q(20, undefined, 25) === Math.floor(NIFTY_FREEZE_QUANTITY / LOT) * LOT, 'a cheap option with a wide stop: all the capital lots (76), only the freeze clamp applies');
assert(stopFor('cap-b', 65, 205.4, 5) === 5, 'a stop already tighter than the budget distance is kept');
assert(stopFor('cap-b', 455, 205.4, 100, 455) === 100, 'an explicit quantity: nothing changes');
assert(q(205.4, 1000) === 1000, 'an explicit quantity is never changed');
bookkeeping.updateUserSettings('cap-own', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'advanced', stopLossPoints: 50 });
assert(stopFor('cap-own', 455, 205.4, undefined) === 21.95, "no explicit stop: the user's own 50-point stop is tightened to the budget distance");
bookkeeping.updateUserSettings('cap-none', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'advanced' });
assert(stopFor('cap-none', 455, 205.4, undefined) === 10, "no order / user stop: the global settings.stopLossPoints (10 in config.yml) is used and is already tighter than the budget distance");
bookkeeping.updateUserSettings('cap-lot', { ...base, investmentMode: 'lotCount', accountCapital: 100000, proficiencyLevel: 'beginner' });
assert(q(20, undefined, undefined, 'cap-lot') === LOT, 'lotCount mode: one lot, untouched');
assert(stopFor('cap-lot', 455, 205.4, 100) === 100, 'lotCount mode: no loss budget, stop unchanged');
assert(stopFor('nobody', 455, 205.4, 100) === 100, 'an unknown user / strategy pseudo-user: no budget, stop unchanged');
assert(q(0) === LOT && q(NaN) === LOT, 'no usable price: one lot, no crash');
assert(stopFor('cap-b', 455, 0.4, 100)! > 0, 'a tiny price never gives a zero stop');
// Add-more on the same contract: budgeted against the combined position.
(bookkeeping as any).trades.push(Object.assign(new (require('../model/model').Trade)(), { tsym: TSYM, user: 'cap-b', broker: 'kite', quantity: 455, price: 205.4, action: 'Buy', status: 'COMPLETE', stopLossPrice: 183.45, token: 't' }));
assert(stopFor('cap-b', 65, 215.4, 100) === 27.95, 'add-more of 65 on an open 455: 27.95 points against the combined 520');
const row = (bookkeeping as any).trades[(bookkeeping as any).trades.length - 1];
row.quantity = 520; row.price = (455 * 205.4 + 65 * 215.4) / 520; row.stopLossPrice = 100;
assert(bookkeeping.tightenStopToLossBudget('cap-b', 'kite', TSYM) === true && row.stopLossPrice > 150 && (row.price - row.stopLossPrice) * 520 <= 10000, `the merged position's looser stop is raised to the budget (${row.stopLossPrice})`);
assert(bookkeeping.tightenStopToLossBudget('cap-b', 'kite', TSYM) === false, 'idempotent: an already tight stop is not changed');
(bookkeeping as any).trades.pop();
process.exit(process.exitCode ?? 0);
