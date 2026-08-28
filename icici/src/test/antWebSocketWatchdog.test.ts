/**
 * Verifies AntWebSocket's zombie-connection watchdog logic: isStale() must
 * flag a connection as dead once its last message/pong is older than the
 * configured threshold, and must NOT flag a connection that is still being
 * heard from (ticks or pongs arriving within the threshold) - including
 * during a quiet market period with no ticks, as long as pongs keep
 * arriving. A real WebSocket connection can't be exercised in this repo's
 * hand-rolled test harness (no live server, no mocking infra for `ws`), so
 * this tests the extracted pure function directly instead - see
 * plans/bug-07-zombie-websocket-undetectable.md for why this is the
 * feasible test given the constraints.
 * Run: npm run build (compile), then: node ./dist/test/antWebSocketWatchdog.test.js
 */

import { isStale } from '../ant/AntWebSocket';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const THRESHOLD_MS = 12000;

    // Fresh message just arrived - not stale.
    const now1 = 1_000_000;
    assert(isStale(now1 - 1000, now1, THRESHOLD_MS) === false, 'a message 1s ago is not stale (threshold 12s)');

    // Right at the boundary (exactly threshold ms old) - not stale (strictly greater-than semantics).
    const now2 = 2_000_000;
    assert(isStale(now2 - THRESHOLD_MS, now2, THRESHOLD_MS) === false, 'a message exactly at the threshold age is not stale');

    // Just past the boundary - stale.
    const now3 = 3_000_000;
    assert(isStale(now3 - THRESHOLD_MS - 1, now3, THRESHOLD_MS) === true, 'a message 1ms past the threshold age is stale');

    // Long-idle zombie (the 12-minute observed incident) - stale.
    const now4 = 4_000_000;
    assert(isStale(now4 - 12 * 60 * 1000, now4, THRESHOLD_MS) === true, 'a 12-minute-old connection is flagged stale');

    // A quiet market with no ticks, but pongs still arriving every ~3s
    // (heartbeat cadence), never exceeds the threshold - not a false positive.
    const lastPong = 5_000_000;
    assert(isStale(lastPong, lastPong + 3000, THRESHOLD_MS) === false, 'a quiet market with regular pongs is not flagged stale');

    // Zero elapsed time - never stale.
    const now5 = 6_000_000;
    assert(isStale(now5, now5, THRESHOLD_MS) === false, 'zero elapsed time is not stale');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
