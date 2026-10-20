/**
 * Verifies bookkeeping.recordShortFill: SellToOpen opens/averages a short-ledger entry,
 * BuyToClose realizes P&L with the short-side-reversed formula and clamps an over-sized
 * close, a BuyToClose with no matching SellToOpen is dropped (no phantom position), and a
 * redelivered fill (same brokerOrderId) is not double-booked.
 * Run: npm run build (compile), then: node ./dist/test/bookkeepingShortFill.test.js
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

function sellToOpen(brokerOrderId: string, price: number, quantity = 65): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = quantity;
    t.price = price;
    t.action = 'SellToOpen';
    t.status = 'COMPLETE';
    t.user = 'ShortFillTestUser';
    t.broker = 'zerodha';
    t.brokerOrderId = brokerOrderId;
    return t;
}

function buyToClose(brokerOrderId: string, price: number, quantity = 65): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = quantity;
    t.price = price;
    t.action = 'BuyToClose';
    t.status = 'COMPLETE';
    t.user = 'ShortFillTestUser';
    t.broker = 'zerodha';
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    // --- BuyToClose with no matching SellToOpen is dropped, not a phantom position ---
    const orphan = buyToClose('orphan-1', 100);
    await bookkeeping.recordShortFill(orphan);
    assert(bookkeeping.shortTrades.length === 0, 'orphan BuyToClose creates no shortTrades entry');
    assert(bookkeeping.closedTrades.find((t) => t.tsym === orphan.tsym && t.realizedPnL != null) === undefined, 'orphan BuyToClose records no closedTrade');

    // --- SellToOpen opens a new short-ledger entry ---
    await bookkeeping.recordShortFill(sellToOpen('short-1', 120));
    const opened = bookkeeping.shortTrades.find((t) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'ShortFillTestUser');
    assert(opened !== undefined && opened.quantity === 65 && opened.price === 120, `SellToOpen opens short entry at 120 qty 65 (got ${JSON.stringify(opened)})`);

    // --- BuyToClose realizes P&L with the short-reversed formula: sold @120, bought back @100 -> profit ---
    const pnlBefore = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    await bookkeeping.recordShortFill(buyToClose('close-1', 100));
    const pnlAfter = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    assert(pnlAfter - pnlBefore === 1300, `short profits when price falls: (120-100)*65=1300 (got ${pnlAfter - pnlBefore})`);
    assert(bookkeeping.shortTrades.find((t) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'ShortFillTestUser') === undefined, 'fully closed short is removed from shortTrades');

    // --- Over-sized BuyToClose is clamped to the tracked short quantity, not booked beyond it ---
    await bookkeeping.recordShortFill(sellToOpen('short-2', 50, 10));
    const pnlBeforeClamp = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    await bookkeeping.recordShortFill(buyToClose('close-2', 40, 999)); // way over the 10 actually short
    const pnlAfterClamp = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    assert(pnlAfterClamp - pnlBeforeClamp === 100, `over-sized close clamps to tracked qty: (50-40)*10=100 (got ${pnlAfterClamp - pnlBeforeClamp})`);
    assert(bookkeeping.shortTrades.find((t) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'ShortFillTestUser') === undefined, 'clamped close still fully removes the short entry');

    // --- Redelivered fill (same brokerOrderId) is not double-booked ---
    await bookkeeping.recordShortFill(sellToOpen('short-3', 80, 20));
    const pnlBeforeDupe = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    await bookkeeping.recordShortFill(buyToClose('close-3', 70, 20));
    const pnlAfterFirst = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    await bookkeeping.recordShortFill(buyToClose('close-3', 70, 20)); // redelivered, same brokerOrderId
    const pnlAfterRedelivery = bookkeeping.userPnL.get('ShortFillTestUser') || 0;
    assert(pnlAfterFirst - pnlBeforeDupe === 200, `first close books real P&L: (80-70)*20=200 (got ${pnlAfterFirst - pnlBeforeDupe})`);
    assert(pnlAfterRedelivery === pnlAfterFirst, `redelivered close-3 is not double-booked (got delta ${pnlAfterRedelivery - pnlAfterFirst})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
