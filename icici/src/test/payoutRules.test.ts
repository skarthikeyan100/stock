/**
 * Verifies the pure payout-blocking rules extracted from src/payout.ts.
 * Run: npm run build (compile), then: node ./dist/test/payoutRules.test.js
 */

import { isNonPositiveProfitBlocked } from '../payout';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

console.log('isNonPositiveProfitBlocked:');
assert(isNonPositiveProfitBlocked(-100) === true, 'blocks a net loss');
assert(isNonPositiveProfitBlocked(0) === true, 'blocks exactly zero profit');
assert(isNonPositiveProfitBlocked(50) === false, 'allows a positive profit through');
