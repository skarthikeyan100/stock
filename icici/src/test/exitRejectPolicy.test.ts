/**
 * The exit-sell reject policy BulkPcr and Hourly share (live incidents 2026-10-15): a margin/shortfall rejection stops re-placement at
 * once, the sixth rejection in one streak stops it, a streak older than the reset window starts over.
 * Run: node ./dist/test/exitRejectPolicy.test.js
 */
import { recordExitReject, MAX_EXIT_REJECT_RETRIES, EXIT_REJECT_STREAK_RESET_MS } from '../strategy/exitRejectPolicy';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const pos: { exitRejectCount?: number; exitLastRejectAt?: number } = {};
const t0 = 1_000_000;
for (let i = 1; i <= MAX_EXIT_REJECT_RETRIES; i++) {
    assert(recordExitReject(pos, 'RMS:Rule: price out of range', t0 + i * 1000) === 'retry', `rejection ${i} of a streak still gets a re-placement`);
}
assert(recordExitReject(pos, 'RMS:Rule: price out of range', t0 + 10_000) === 'tooMany' && pos.exitRejectCount === 6, 'rejection 6 stops re-placement');

const fresh: { exitRejectCount?: number; exitLastRejectAt?: number } = {};
assert(recordExitReject(fresh, 'Margin is insufficient', t0) === 'marginShortfall', '"Margin is insufficient" is a margin shortfall (connector words between the two)');
assert(recordExitReject({}, 'Not enough margin to cover order', t0) === 'marginShortfall', '"Not enough margin to cover order" is too');
assert(recordExitReject({}, 'liquidity: order book thin', t0) === 'retry', 'an unrelated rejection is retried');
assert(recordExitReject({}, undefined, t0) === 'retry', 'no reason given: retried');

const old: { exitRejectCount?: number; exitLastRejectAt?: number } = { exitRejectCount: 5, exitLastRejectAt: t0 };
assert(recordExitReject(old, 'x', t0 + EXIT_REJECT_STREAK_RESET_MS + 1) === 'retry' && old.exitRejectCount === 1, 'a rejection after the reset window starts a new streak');
console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
