/**
 * Verifies monitor.ts's sell branch reduces by the sold quantity instead of
 * closing the whole position on a partial sell, and that realizedPnL is only
 * ever set at close (not mislabeled onto live mark-to-market ticks).
 * Run: npm run build (compile), then: node ./dist/test/monitorPartialSell.test.js
 */

import Monitor from '../monitor';
import { Trade, OptionQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buy(qty: number, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tokPartial';
    t.quantity = qty;
    t.price = price;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'PartialSellTestUser';
    return t;
}

function sell(qty: number, price: number): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tokPartial';
    t.quantity = qty;
    t.price = price;
    t.action = 'Sell';
    t.status = 'COMPLETE';
    t.user = 'PartialSellTestUser';
    return t;
}

async function main() {
    const monitor = Monitor.getInstance();
    await (monitor as any)._processTradeEvent(buy(100, 100));

    // Sell only 40 of the 100 - a partial fill.
    await (monitor as any)._processTradeEvent(sell(40, 120));

    const remaining = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    assert(!!remaining, 'the remaining 60 stays tracked as an open position');
    assert(remaining?.quantity === 60, `remaining open quantity is 60 (got ${remaining?.quantity})`);

    const pnl = monitor.userPnL.get('PartialSellTestUser') || 0;
    assert(pnl === 800, `realized P&L is on the 40 actually sold, not the full 100 (got ${pnl})`);

    // Sell the rest - position should now close out.
    await (monitor as any)._processTradeEvent(sell(60, 130));
    const afterFullClose = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    assert(!afterFullClose, 'position is removed once fully closed');

    // A fresh open position must not have realizedPnL set from live ticks -
    // that field means "P&L booked at close", not "current mark-to-market".
    await (monitor as any)._processTradeEvent(buy(50, 100));
    const openTrade = monitor.trades.find((t: Trade) => t.tsym === 'NIFTY26AUG24100CE' && t.user === 'PartialSellTestUser');
    const tickQuote = Object.assign(new OptionQuote(), { token: 'tokPartial', ltp: 150 });
    await monitor.updateQuote(tickQuote);
    assert(openTrade?.realizedPnL === undefined, `realizedPnL stays unset on an open trade after a tick (got ${openTrade?.realizedPnL})`);
    assert(openTrade?.unrealizedPnL === 2500, `unrealizedPnL reflects the live mark-to-market (got ${openTrade?.unrealizedPnL})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
