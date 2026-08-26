/**
 * Verifies BuySellStrategy's order-in-flight flags are per-instance (per
 * Contract), not shared module-level state across every configured instance.
 * Run: npm run build (compile), then: node ./dist/test/buySellStrategyState.test.js
 */

import BuySellStrategy from '../strategy/BuySellStrategy';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const userA = new BuySellStrategy('UserA') as any;
const userB = new BuySellStrategy('UserB') as any;

userA.contract.buyOrderPlaced = true;
assert(userB.contract.buyOrderPlaced !== true, 'a second instance does not see the first instance\'s in-flight flag');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
