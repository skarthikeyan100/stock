/**
 * Verifies bookkeeping.recordFill ignores a redelivered fill for the same
 * brokerOrderId instead of double-booking P&L.
 * Run: npm run build (compile), then: node ./dist/test/bookkeepingDedup.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';

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
    t.user = 'DedupTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

function sell(brokerOrderId: string, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = 65;
    t.price = price;
    t.action = 'Sell';
    t.status = 'COMPLETE';
    t.user = 'DedupTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    await bookkeeping.recordFill(buy('order-1'));
    await bookkeeping.recordFill(sell('order-2', 120));
    const pnlAfterOneSell = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterOneSell === 1300, `first sell books real P&L (got ${pnlAfterOneSell})`);

    // Redeliver the exact same sell fill (same brokerOrderId) - must be ignored.
    await bookkeeping.recordFill(sell('order-2', 120));
    const pnlAfterRedelivery = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterRedelivery === 1300, `redelivered fill is not double-booked (got ${pnlAfterRedelivery})`);

    // A genuinely new order id must still be processed normally.
    await bookkeeping.recordFill(buy('order-3'));
    await bookkeeping.recordFill(sell('order-4', 110));
    const pnlAfterSecondTrade = bookkeeping.userPnL.get('DedupTestUser') || 0;
    assert(pnlAfterSecondTrade === 1950, `a new brokerOrderId is processed normally (got ${pnlAfterSecondTrade})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
