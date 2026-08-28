/**
 * Verifies bookkeeping.canPlaceOrder accounts for in-flight (pending) orders,
 * not just confirmed trades - closing the race where two concurrent order
 * requests for the same user could both pass canPlaceOrder before either
 * fill landed, exceeding the user's lot/investment limit - and that a
 * pending reservation is correctly released both on order failure (the
 * leak fix) and on a real fill (the existing _processTradeEvent path).
 * Run: npm run build (compile), then: node ./dist/test/bookkeepingRace.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import { USER_LOSS_LIMIT, DEFAULT_MAX_INVESTMENT } from '../constants';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buyFill(user: string, brokerOrderId: string): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok-race';
    t.quantity = 65;
    t.price = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    // (a) A pending reservation blocks a second concurrent order for the same
    // user, reproducing orderProcess.ts's exact call order: canPlaceOrder,
    // then (only if allowed) markPending, before the broker call resolves.
    const RACE_USER = 'RaceTestUser';
    bookkeeping.updateUserSettings(RACE_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    const before = await bookkeeping.canPlaceOrder(RACE_USER);
    assert(before.allowed === true, 'first order is allowed when nothing is traded or pending');

    bookkeeping.markPending(RACE_USER); // request A passed canPlaceOrder and reserved its slot
    const during = await bookkeeping.canPlaceOrder(RACE_USER); // request B, concurrent, before A's fill
    assert(during.allowed === false, 'a second concurrent order for the same user is blocked while the first is still pending');
    assert(/lot limit/i.test(during.reason || ''), `rejection reason mentions the lot limit (got "${during.reason}")`);

    // (b) A failed/thrown order releases its reservation (the leak fix), so a
    // subsequent legitimate order is allowed again. This exercises the exact
    // bookkeeping primitives orderProcess.ts's placeOrderWithPendingGuard
    // calls in its catch block - the IPC/orderProcess.ts wiring itself isn't
    // unit-testable here and must be verified by code review + tsc.
    const LEAK_USER = 'LeakTestUser';
    bookkeeping.updateUserSettings(LEAK_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(LEAK_USER); // request A reserved its slot...
    const blocked = await bookkeeping.canPlaceOrder(LEAK_USER);
    assert(blocked.allowed === false, 'pending reservation blocks a second order (sanity check before releasing)');

    bookkeeping.releasePending(LEAK_USER); // ...then A's broker call threw - orderProcess.ts's catch releases it
    const afterRelease = await bookkeeping.canPlaceOrder(LEAK_USER);
    assert(afterRelease.allowed === true, 'releasePending clears the reservation so a later legitimate order is allowed again');

    // (c) A real fill clears the pending marker via the existing
    // _processTradeEvent path (recordFill -> releasePending), and canPlaceOrder
    // then reflects the real, confirmed trade - not a stale pending entry.
    const FILL_USER = 'FillTestUser';
    bookkeeping.updateUserSettings(FILL_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(FILL_USER, 6500); // as buyContract/manualBuy would pass an estimatedOrderValue
    const blockedWhilePending = await bookkeeping.canPlaceOrder(FILL_USER);
    assert(blockedWhilePending.allowed === false, 'pending reservation blocks a second order before the fill lands');

    await bookkeeping.recordFill(buyFill(FILL_USER, 'race-fill-order-1'));

    const pendingAfterFill = bookkeeping.pendingOrders.get(FILL_USER) ?? [];
    assert(pendingAfterFill.length === 0, `fill clears the pending reservation (got ${pendingAfterFill.length} still pending)`);

    const tradedLots = bookkeeping.getTradedLots(FILL_USER);
    assert(tradedLots === 1, `confirmed fill counts toward getTradedLots (got ${tradedLots})`);

    const afterFill = await bookkeeping.canPlaceOrder(FILL_USER);
    assert(afterFill.allowed === false, 'still blocked after the fill, but now by the real confirmed lot limit');
    assert(/lot limit/i.test(afterFill.reason || ''), `rejection reason reflects the confirmed trade (got "${afterFill.reason}")`);

    // (d) Releasing one of two concurrent reservations for the same user must
    // not drop the other still-in-flight one - this is the specific failure
    // mode a plain Set<string> (delete-by-user) could not avoid, and the
    // reason pendingOrders is a per-user list rather than a boolean flag.
    const MULTI_USER = 'MultiPendingTestUser';
    bookkeeping.updateUserSettings(MULTI_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(MULTI_USER); // order A
    bookkeeping.markPending(MULTI_USER); // order B, also concurrently in flight
    assert((bookkeeping.pendingOrders.get(MULTI_USER)?.length ?? 0) === 2, 'two concurrent pending orders for the same user are both tracked');

    bookkeeping.releasePending(MULTI_USER); // order A fails and is released
    const stillBlocked = await bookkeeping.canPlaceOrder(MULTI_USER);
    assert(stillBlocked.allowed === false, 'order B (still pending) still counts toward the lot limit after releasing A alone');

    bookkeeping.releasePending(MULTI_USER); // order B fails too
    const clearNow = await bookkeeping.canPlaceOrder(MULTI_USER);
    assert(clearNow.allowed === true, 'once both reservations are released the user can order again');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
