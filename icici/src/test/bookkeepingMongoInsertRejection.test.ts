/**
 * Verifies bookkeeping's fire-and-forget Mongo trade-event insert
 * (_processTradeEvent, invoked via recordFill) does not produce an
 * unhandled promise rejection when Mongo.insert() rejects, and does not
 * make recordFill() itself throw/reject.
 *
 * Regression test for: src/processes/order/bookkeeping.ts's un-awaited
 * `Mongo.getInstance()?.insert(tradeEvent)` call being wrapped in a useless
 * try/catch (a try/catch cannot catch an eventual rejection from a promise
 * that is never awaited). Before the fix, a transient Mongo error during a
 * live trade-event write became an unhandled promise rejection, which (with
 * no process-level handler installed anywhere in the repo) could crash the
 * `order` process and lose in-flight risk state.
 *
 * Run: npx tsc (compile), then: node ./dist/test/bookkeepingMongoInsertRejection.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buy(brokerOrderId: string): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = 65;
    t.price = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'MongoRejectionTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    let unhandledRejectionSeen: unknown = undefined;
    process.on('unhandledRejection', (reason) => {
        unhandledRejectionSeen = reason;
    });

    // Stub Mongo.getInstance() (which just returns the static `instance`
    // field) to return an object whose insert() always rejects - simulates
    // a transient Mongo error during a live trade-event write without
    // needing a real Mongo connection. Only `insert` is stubbed: the Buy
    // path exercised below never touches `.db` (that's only used by the
    // Sell-side persistClosedTrade/checkDrawdownNotification methods).
    (Mongo as any).instance = {
        insert: async () => {
            throw new Error('Simulated Mongo insert failure');
        },
    };

    let recordFillThrew = false;
    try {
        await bookkeeping.recordFill(buy('mongo-reject-order-1'));
    } catch (e) {
        recordFillThrew = true;
    }
    assert(!recordFillThrew, 'recordFill() does not throw/reject when the fire-and-forget Mongo insert rejects');

    // The Mongo insert's rejection is handled asynchronously via .catch(),
    // independently of recordFill's own await chain - give the event loop a
    // turn to let it settle before asserting no unhandledRejection fired.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(unhandledRejectionSeen === undefined, `no unhandledRejection event fired (got: ${unhandledRejectionSeen})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
