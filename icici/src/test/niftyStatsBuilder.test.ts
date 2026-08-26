/**
 * Verifies niftyStatsBuilder.record() only emits a stats update once a
 * 300-second bucket boundary is crossed (matching decision.ts's existing
 * 5-min cadence), and that the emitted PeriodicStats carries real RSI/MACD/etc
 * results usable by strategy.receive().
 * Run: npm run build (compile), then: node ./dist/test/niftyStatsBuilder.test.js
 */

import * as niftyStatsBuilder from '../processes/strategies/niftyStatsBuilder';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const baseTime = 1_700_000_000; // arbitrary fixed epoch-seconds start

// Ticks within the same 300s bucket must not emit.
let lastResult: any = null;
for (let i = 0; i < 5; i++) {
    lastResult = niftyStatsBuilder.record(24000 + i, baseTime + i * 10);
}
assert(lastResult === null, 'no stats emitted before a 300s boundary is crossed');

// A tick past the 300s boundary (with >= 2 prices already in the bucket) must emit.
const crossing = niftyStatsBuilder.record(24100, baseTime + 305);
assert(crossing !== null, 'emits a stats update once the 300s boundary is crossed');
assert(crossing!.newStats?.results?.rsi !== undefined, 'emitted stats include rsi results usable by RuleBasedStrategy.receive()');
assert(crossing!.newStats?.results?.pivot?.S1 !== undefined, 'emitted stats include pivot results usable by BiDirectionStrategy/PivotStrategy');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
