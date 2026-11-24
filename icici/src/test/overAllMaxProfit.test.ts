/**
 * settings.overAllMaxProfit: combined P&L over all strategies/brokers (paper excluded), the setting reader and the config validation.
 * Run: npx tsc, then: node ./dist/test/overAllMaxProfit.test.js
 */
import { combinedPnl, overAllMaxProfit } from '../processes/strategies/overAllMaxProfit';
import { validateNumericRanges } from '../prism/configValidation';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

(async () => {
    const open = [
        { user: 'S1', broker: 'kite', tsym: 'A', token: '1', price: 100, quantity: 10, lastTradePrice: 120, realizedPnL: 50 },   // +200 unrealized, +50 realized
        { user: 'S2', broker: 'ant', tsym: 'B', token: '2', price: 100, quantity: 10, lastTradePrice: 90 },  // -100
        { user: 'S3', broker: 'paper', tsym: 'A', token: '1', price: 100, quantity: 10, lastTradePrice: 500 }, // not counted
        { user: 'S4', broker: 'kite', tsym: 'D', token: '4', price: 100, quantity: 10 },                       // no tick yet: 0
    ];
    const closed = [{ user: 'S1', broker: 'kite', tsym: 'C', realizedPnL: 300 }, { user: 'S3', broker: 'paper', tsym: 'C', realizedPnL: 999 }];
    assert(Math.round(combinedPnl({ trades: open, closedTrades: closed })) === 450, 'combined = 50 + 200 - 100 + 300, paper left out');
    assert(overAllMaxProfit({ overAllMaxProfit: 20000 }) === 20000, 'reads a positive number');
    assert(overAllMaxProfit({}) === 0 && overAllMaxProfit({ overAllMaxProfit: 0 }) === 0 && overAllMaxProfit({ overAllMaxProfit: '5%' }) === 0, 'absent / 0 / non-number = off');
    assert(validateNumericRanges('settings', { overAllMaxProfit: 20000 }).length === 0, 'valid value accepted');
    assert(validateNumericRanges('settings', { overAllMaxProfit: -5 }).length === 1 && validateNumericRanges('settings', { overAllMaxProfit: '10%' }).length === 1, 'negative / percent rejected');
    process.exit(process.exitCode ?? 0);
})();
