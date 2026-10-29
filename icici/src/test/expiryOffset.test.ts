/**
 * Verifies entry-strike shifting by trading days to expiry (Tuesday Nifty expiry: Wed 4 ... Mon 1, Tue 0 steps OTM).
 * Run: npx tsc, then: node ./dist/test/expiryOffset.test.js
 */

import { tradingDaysToExpiry, shiftedStrike, otmSteps } from '../util/expiryOffset';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const expiry = Date.UTC(2026, 10, 3); // Tue 2026-11-03, midnight UTC as in the master
const at = (y: number, m: number, d: number) => new Date(y, m, d, 11, 0).getTime();

console.log('Days to the Tuesday expiry');
assert([4, 3, 2, 1, 0].map(otmSteps).join() === '2,2,1,1,0', 'otmSteps = ceil(days/2)');
assert(tradingDaysToExpiry(expiry, at(2026, 9, 28)) === 4, 'Wed 28 Oct -> 4');
assert(tradingDaysToExpiry(expiry, at(2026, 9, 29)) === 3, 'Thu 29 Oct -> 3');
assert(tradingDaysToExpiry(expiry, at(2026, 9, 30)) === 2, 'Fri 30 Oct -> 2');
assert(tradingDaysToExpiry(expiry, at(2026, 10, 2)) === 1, 'Mon 2 Nov -> 1');
assert(tradingDaysToExpiry(expiry, at(2026, 10, 3)) === 0, 'Tue 3 Nov (expiry day) -> 0');
assert(tradingDaysToExpiry(Date.UTC(2026, 10, 2), at(2026, 10, 2)) === 0, 'holiday-shifted Monday expiry, on Monday -> 0');

console.log('Strike shift');
assert(shiftedStrike(25000, 'CE', 50, 3) === 25150, 'CE moves up');
assert(shiftedStrike(25000, 'PE', 50, 3) === 24850, 'PE moves down');
assert(shiftedStrike(25000, 'CE', 50, 0) === 25000, '0 days -> ATM');
