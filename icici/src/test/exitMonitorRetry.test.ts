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
    // can't collide with a real zerodha/ant handler if this module were ever
    // imported alongside orderProcess.ts (it isn't, by design - exitMonitor
    // avoids importing the executors to prevent a circular dependency).
    exitMonitor.onExit('zerodha', async (_trade: Trade, _exchange: 'NFO' | 'BFO') => {
        exitCallCount++;
        if (failNextCall) {
            failNextCall = false;
            throw new Error('simulated transient exit failure');
        }
        // second call succeeds - resolves normally
    });

    exitMonitor.registerTrade(trade, 'NFO', 'zerodha', false);

    // Tick 1: crosses target, exit handler throws. Before the fix, this
    // would drop the trade from monitoring permanently.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 1, `first tick triggers the exit attempt (got ${exitCallCount} call(s))`);

    // Tick 2: still above target. If the trade was re-registered after the
    // failure (the fix), this tick retries the exit and the handler is
    // called again (and this time succeeds). If the bug is present, the
    // trade is no longer monitored and this tick is a silent no-op.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 2, `second tick retries the exit after the first failure was re-registered (got ${exitCallCount} call(s))`);

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
