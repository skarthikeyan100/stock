/**
 * Verifies squareOffOnAnt guards against a concurrent duplicate square-off
 * for the same trade (e.g. a manual squareoff racing exitMonitor's
 * auto-triggered exit) - only one of two concurrent calls may reach the
 * broker; the other is rejected as a no-op. Also verifies the guard clears
 * after the winning call finishes, so neither a square-off on a DIFFERENT
 * trade nor a later legitimate retry of the SAME trade is permanently
 * blocked.
 * Run: npm run build (compile), then: node ./dist/test/squareOffRace.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import ANT from '../ant/ANT';
import { squareOffOnAnt } from '../processes/order/antExecutor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// Bracket-order-style open trade (antOrderNo set) - squareOffOnAnt exits this
// via ant.exitBracketOrder, which this test stubs out, avoiding any need to
// also stub AntOrderNotifyStream.waitForFill (only exercised by the
// non-bracket "regular order" square-off path, which this test does not use).
function openBracketTrade(user: string, tsym: string, token: string, antOrderNo: string): Trade {
    const t = new Trade();
    t.tsym = tsym;
    t.token = token;
    t.quantity = 65;
    t.price = 100;
    t.lastTradePrice = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.antOrderNo = antOrderNo;
    return t;
}

async function main() {
    const USER = 'SquareOffRaceUser';
    const ant = ANT.getInstance();
    const originalExitBracketOrder = ant.exitBracketOrder.bind(ant);

    let brokerCalls = 0;
    // Stub the live broker call: count invocations and add an artificial
    // delay so two concurrent squareOffOnAnt calls are guaranteed to overlap
    // in-flight - this is exactly the window the race exploits without the
    // guard in place.
    (ant as any).exitBracketOrder = async (_orderNo: string, _orderComplexity: 'BO' | 'CO' = 'BO') => {
        brokerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    try {
        // --- Scenario 1: two concurrent square-offs for the SAME trade ---
        const tradeA = openBracketTrade(USER, 'NIFTY26AUG24100CE', 'tok-race-A', 'bo-order-A');
        bookkeeping.trades.push(tradeA);

        const results = await Promise.allSettled([
            squareOffOnAnt(USER, 'NIFTY26AUG24100CE', 65, 'NFO'),
            squareOffOnAnt(USER, 'NIFTY26AUG24100CE', 65, 'NFO'),
        ]);

        assert(brokerCalls === 1, `only one concurrent square-off call reaches the broker (got ${brokerCalls})`);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        assert(fulfilled.length === 1, `exactly one concurrent call resolves (got ${fulfilled.length})`);
        assert(rejected.length === 1, `exactly one concurrent call is rejected as a duplicate no-op (got ${rejected.length})`);

        const pendingAfterScenario1 = bookkeeping.pendingSquareOffs;
        assert(pendingAfterScenario1.has(`${USER}:NIFTY26AUG24100CE`) === false, 'guard is cleared after the winning call finishes');

        // --- Scenario 2: guard clearing doesn't block a DIFFERENT trade ---
        const tradeB = openBracketTrade(USER, 'NIFTY26AUG24200PE', 'tok-race-B', 'bo-order-B');
        bookkeeping.trades.push(tradeB);

        await squareOffOnAnt(USER, 'NIFTY26AUG24200PE', 65, 'NFO');
        assert(brokerCalls === 2, `a square-off for a different trade proceeds normally and reaches the broker (got ${brokerCalls} total broker calls)`);

        // --- Scenario 3: guard clearing allows a legitimate later retry of the SAME tsym+user ---
        const tradeC = openBracketTrade(USER, 'NIFTY26AUG24300CE', 'tok-race-C', 'bo-order-C');
        bookkeeping.trades.push(tradeC);

        await squareOffOnAnt(USER, 'NIFTY26AUG24300CE', 65, 'NFO');
        assert(brokerCalls === 3, `first square-off of trade C reaches the broker (got ${brokerCalls})`);

        // trade C was fully closed (quantity fully sold) and removed from
        // bookkeeping.trades by recordFill inside the call above - re-add it
        // to simulate a legitimate later, non-concurrent retry and confirm
        // the guard does not wrongly stay latched from the earlier call.
        bookkeeping.trades.push(openBracketTrade(USER, 'NIFTY26AUG24300CE', 'tok-race-C', 'bo-order-C'));
        await squareOffOnAnt(USER, 'NIFTY26AUG24300CE', 65, 'NFO');
        assert(brokerCalls === 4, `a later sequential (non-concurrent) square-off of the same trade is NOT permanently blocked (got ${brokerCalls})`);
    } finally {
        (ant as any).exitBracketOrder = originalExitBracketOrder;
    }

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
