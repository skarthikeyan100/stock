/**
 * Verifies exitMonitor.handleOptionTick re-registers a trade for monitoring
 * when its exit (target/SL squareoff) attempt fails, instead of silently
 * dropping protection for the rest of the day (bug-04).
 *
 * Uses only exitMonitor's public API (registerTrade/onExit/handleOptionTick)
 * - it does not reach into the internal `monitored` map, so it stays valid
 * regardless of the map's internal key structure (see bug-03, which changed
 * that structure to a composite `monitorKey(user, token)` key independently
 * of this fix).
 *
 * Run: npx tsc (compile), then: node ./dist/test/exitMonitorRetry.test.js
 */

import { Trade, OptionQuote } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function makeTrade(): Trade {
    const t = new Trade();
    t.tsym = 'TESTOPT26AUG24100CE';
    t.token = 'exitmonitor-retry-tok1';
    t.quantity = 1;
    t.user = 'ExitMonitorRetryTestUser';
    t.targetPrice = 100;
    t.stopLossPrice = 50;
    return t;
}

function makeQuote(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.token = token;
    q.ltp = ltp;
    q.ltt = Date.now();
    return q;
}

async function main() {
    const trade = makeTrade();

    let exitCallCount = 0;
    let failNextCall = true;

    // Register the exit handler for a broker name unique to this test so it
    // can't collide with a real kite/ant handler if this module were ever
    // imported alongside orderProcess.ts (it isn't, by design - exitMonitor
    // avoids importing the executors to prevent a circular dependency).
    exitMonitor.onExit('kite', async (_trade: Trade, _exchange: 'NFO' | 'BFO') => {
        exitCallCount++;
        if (failNextCall) {
            failNextCall = false;
            throw new Error('simulated transient exit failure');
        }
        // second call succeeds - resolves normally
    });

    exitMonitor.registerTrade(trade, 'NFO', 'kite', false);

    // Tick 1: crosses target, exit handler throws. Before the fix, this
    // would drop the trade from monitoring permanently.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 1, `first tick triggers the exit attempt (got ${exitCallCount} call(s))`);

    // Tick 2, immediately: the failed exit is behind its retry backoff (5 s), so it must NOT be retried at tick rate.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 1, `an immediate second tick does not retry (backoff) (got ${exitCallCount} call(s))`);

    // After the backoff the trade (re-registered after the failure) is retried and this time succeeds. If the trade had been dropped
    // after the failure this tick would be a silent no-op.
    await new Promise((r) => setTimeout(r, exitMonitor.RETRY_BASE_MS + 200));
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 2, `a tick after the backoff retries the exit (got ${exitCallCount} call(s))`);

    // Tick 3: exit already succeeded on tick 2, so the trade should have
    // been unregistered normally (not re-registered) - a further tick must
    // NOT trigger another exit attempt.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 2, `no further exit attempts after a successful exit (got ${exitCallCount} call(s))`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
