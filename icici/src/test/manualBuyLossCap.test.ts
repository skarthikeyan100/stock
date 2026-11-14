/**
 * Per-trade loss cap on the derived manual-buy quantity (bookkeeping.resolveManualBuyQuantity, settings.levelRules.<level>.maxLossPerTradePercent).
 * Run: npx tsc && node ./dist/test/manualBuyLossCap.test.js
 */
import bookkeeping from '../processes/order/bookkeeping';
import { NIFTY_FREEZE_QUANTITY } from '../constants';

function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) process.exitCode = 1; }
const LOT = 65;
const base = { lossLimit: 1e9, lotLimit: 10, maxInvestment: 1e9 };

bookkeeping.updateUserSettings('cap-b', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'beginner' });
const q = (price: number, explicit?: number, stop?: number, user = 'cap-b') => bookkeeping.resolveManualBuyQuantity(user, 'NIFTY26N1725150CE', price, explicit, LOT, stop);

assert(q(131) === 11 * LOT, 'price 131: capital allows 11 lots, 11 x 65 x 10 = 7150 is under the 10000 cap -> unchanged');
assert(q(20) === 15 * LOT, 'price 20: capital would allow 76 lots but one stop-out at 10 points must stay within 10000 -> 15 lots');
assert(q(20, undefined, 25) === 6 * LOT, 'a wider 25-point stop shrinks it further -> 6 lots');
assert(q(20, undefined, 0) === Math.floor(NIFTY_FREEZE_QUANTITY / LOT) * LOT, 'a zero stop gives no loss cap (no division by zero): the 76 capital lots are only clamped by the exchange freeze quantity');
assert(q(20, 1000) === 1000, 'an explicit quantity is never changed');
bookkeeping.updateUserSettings('cap-own', { ...base, investmentMode: 'investmentAmount', accountCapital: 100000, proficiencyLevel: 'advanced', stopLossPoints: 50 });
assert(q(20, undefined, undefined, 'cap-own') === 3 * LOT, "no explicit stop: the user's own 50-point stop is used -> 3 lots");
bookkeeping.updateUserSettings('cap-tiny', { ...base, investmentMode: 'investmentAmount', accountCapital: 5000, proficiencyLevel: 'beginner' });
assert(q(20, undefined, undefined, 'cap-tiny') === 1 * LOT, 'cap smaller than one lot is floored to one lot (never zero)');
bookkeeping.updateUserSettings('cap-lot', { ...base, investmentMode: 'lotCount', accountCapital: 100000, proficiencyLevel: 'beginner' });
assert(q(20, undefined, undefined, 'cap-lot') === LOT, 'lotCount mode: one lot, untouched');
assert(q(0) === LOT && q(NaN) === LOT, 'no usable price: one lot, no crash');
process.exit(process.exitCode ?? 0);
