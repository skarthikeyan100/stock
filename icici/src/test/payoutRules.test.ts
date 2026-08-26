/**
 * Verifies the pure payout-blocking rules extracted from src/payout.ts.
 * Run: npm run build (compile), then: node ./dist/test/payoutRules.test.js
 */

import { isNonPositiveProfitBlocked, computeConsistencyBreach } from '../payout';

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

console.log('computeConsistencyBreach:');

const bigWinAndLoss = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: 10000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: -6000 },
];
const r1 = computeConsistencyBreach(bigWinAndLoss, 4000, 90);
assert(r1.worstPercent <= 100, `worstPercent never exceeds 100% (got ${r1.worstPercent})`);
assert(r1.worstPercent === 100, 'a single winning day among a loss is 100% of gross winnings');
assert(r1.breached === true, 'breaches a 90% limit since it is the only winning day');

const twoEvenWins = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: 5000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: 5000 },
];
const r2 = computeConsistencyBreach(twoEvenWins, 10000, 90);
assert(r2.worstPercent === 50, `two even winning days split 50/50 (got ${r2.worstPercent})`);
assert(r2.breached === false, 'does not breach a 90% limit when no day dominates');

const allLosses = [
    { exitTime: '2026-08-01T10:00:00Z', realizedPnL: -1000 },
    { exitTime: '2026-08-02T10:00:00Z', realizedPnL: -500 },
];
const r3 = computeConsistencyBreach(allLosses, -1500, 90);
assert(r3.breached === false, 'never breaches when there are no winning days at all');
