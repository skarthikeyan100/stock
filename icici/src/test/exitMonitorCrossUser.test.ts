/**
 * Verifies exitMonitor tracks multiple users' trades on the SAME option
 * token independently - see bugs.md "Cross-user protection loss on shared
 * contracts". Before the fix, `monitored` was keyed by token alone, so a
 * second user's registerTrade() for a token already held by another user
 * silently overwrote the first user's entry (no error, no self-healing).
 * Run: npm run build (compile), then: node ./dist/test/exitMonitorCrossUser.test.js
 */

import { OptionQuote, Trade } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function makeTrade(user: string, token: string, targetPrice: number, stopLossPrice: number): Trade {
    const t = new Trade();
    t.tsym = `TEST${token}`;
    t.token = token;
    t.quantity = 65;
    t.price = 100;
    t.lastTradePrice = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.targetPrice = targetPrice;
    t.stopLossPrice = stopLossPrice;
    return t;
}

function tick(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.token = token;
    q.ltp = ltp;
    return q;
}

async function main() {
    const zerodhaExits: Trade[] = [];
    const antExits: Trade[] = [];
    exitMonitor.onExit('zerodha', async (trade) => { zerodhaExits.push(trade); });
    exitMonitor.onExit('ant', async (trade) => { antExits.push(trade); });

    // --- Scenario 1: two users, same token, different brokers - both must
    // fire independently, and one firing must not affect the other. ---
    const TOKEN_1 = 'SHARED_TOK_1';
    const userA = makeTrade('UserA', TOKEN_1, /*target*/ 150, /*sl*/ 90);
    const userB = makeTrade('UserB', TOKEN_1, /*target*/ 200, /*sl*/ 80);
    exitMonitor.registerTrade(userA, 'NFO', 'zerodha');
    exitMonitor.registerTrade(userB, 'NFO', 'ant');

    // Tick hits UserA's target (150) but is nowhere near UserB's target/SL (200/80).
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 155));
    assert(zerodhaExits.length === 1, 'UserA (zerodha) fires when its target is hit');
    assert(zerodhaExits[0]?.user === 'UserA', 'the fired zerodha trade belongs to UserA');
    assert(antExits.length === 0, 'UserB (ant) does not fire on a tick that only hits UserA target');

    // A further tick in the same range must not re-fire UserA (already
    // unregistered on exit) and must not have collaterally dropped UserB's
    // monitoring for the shared token.
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 156));
    assert(zerodhaExits.length === 1, 'UserA does not fire a second time after its own exit');
    assert(antExits.length === 0, 'UserB is still unaffected by the repeat tick');

    // Now hit UserB's target (200) - UserB must still be monitored and fire,
    // proving UserA's earlier registration/unregistration on the same token
    // never touched UserB's entry.
    await exitMonitor.handleOptionTick(tick(TOKEN_1, 210));
    assert(antExits.length === 1, 'UserB (ant) fires when its own target is hit, after UserA already exited');
    assert(antExits[0]?.user === 'UserB', 'the fired ant trade belongs to UserB');
    assert(zerodhaExits.length === 1, 'UserA still shows exactly one exit (unaffected by UserB firing)');

    // --- Scenario 2: explicit unregisterTrade for one user must not affect
    // another user's still-open monitoring on the same token. ---
    const TOKEN_2 = 'SHARED_TOK_2';
    const userC = makeTrade('UserC', TOKEN_2, /*target*/ 150, /*sl*/ 90);
    const userD = makeTrade('UserD', TOKEN_2, /*target*/ 200, /*sl*/ 80);
    exitMonitor.registerTrade(userC, 'NFO', 'zerodha');
    exitMonitor.registerTrade(userD, 'NFO', 'zerodha');

    exitMonitor.unregisterTrade('UserC', TOKEN_2);

    // A tick that would have hit UserC's target must not fire (UserC was
    // explicitly unregistered).
    const zerodhaCountBeforeC = zerodhaExits.length;
    await exitMonitor.handleOptionTick(tick(TOKEN_2, 155));
    assert(zerodhaExits.length === zerodhaCountBeforeC, 'unregistered UserC does not fire even though the tick is within its old target range');

    // UserD must still be monitored and fire on its own target, proving
    // unregistering UserC did not collaterally drop UserD from the shared token.
    await exitMonitor.handleOptionTick(tick(TOKEN_2, 210));
    assert(zerodhaExits.length === zerodhaCountBeforeC + 1, 'UserD still fires on its own target after UserC was unregistered');
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserD', 'the newly fired trade belongs to UserD, not UserC');

    // --- Scenario 3: reconcileFromTrades (restart path) must also register
    // both users independently instead of the second clobbering the first. ---
    const TOKEN_3 = 'SHARED_TOK_3';
    const userE = makeTrade('UserE', TOKEN_3, /*target*/ 150, /*sl*/ 90);
    const userF = makeTrade('UserF', TOKEN_3, /*target*/ 200, /*sl*/ 80);
    exitMonitor.reconcileFromTrades([userE, userF]);

    await exitMonitor.handleOptionTick(tick(TOKEN_3, 155));
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserE', 'reconcileFromTrades: UserE fires on its own target');

    await exitMonitor.handleOptionTick(tick(TOKEN_3, 210));
    assert(zerodhaExits[zerodhaExits.length - 1]?.user === 'UserF', 'reconcileFromTrades: UserF still fires on its own target after UserE exited, not clobbered by UserE registration');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
