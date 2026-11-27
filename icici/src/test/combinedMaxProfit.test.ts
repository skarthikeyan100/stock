/**
 * settings.combinedMaxProfit: combined P&L over all strategies/brokers (paper excluded), the setting reader and the config validation.
 * Run: npx tsc, then: node ./dist/test/combinedMaxProfit.test.js
 */
import { combinedPnl, combinedMaxProfit } from '../processes/strategies/combinedMaxProfit';
import { validateNumericRanges } from '../prism/configValidation';
import { recordTick, __setLiveFetch } from '../processes/strategies/markPrice';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

(async () => {
    __setLiveFetch(async () => { throw new Error('a live call must not be needed here'); });
    recordTick('ant', '1', 120); recordTick('ant', '2', 90); recordTick('ant', '4', 100); // ticks; D has price 100 so its tick adds 0
    const open = [
        { user: 'S1', broker: 'kite', tsym: 'A', token: '1', price: 100, quantity: 10, realizedPnL: 50 },   // +200 unrealized, +50 realized
        { user: 'S2', broker: 'ant', tsym: 'B', token: '2', price: 100, quantity: 10, },  // -100
        { user: 'S3', broker: 'paper', tsym: 'A', token: '1', price: 100, quantity: 10 }, // not counted
        { user: 'S4', broker: 'kite', tsym: 'D', token: '4', price: 100, quantity: 10 },                       // tick at cost: 0
    ];
    const closed = [{ user: 'S1', broker: 'kite', tsym: 'C', realizedPnL: 300 }, { user: 'S3', broker: 'paper', tsym: 'C', realizedPnL: 999 }];
    assert(Math.round(await combinedPnl({ trades: open, closedTrades: closed })) === 450, 'combined = 50 + 200 - 100 + 300, paper left out');
    assert(combinedMaxProfit({ combinedMaxProfit: 20000 }) === 20000, 'reads a positive number');
    assert(combinedMaxProfit({}) === 0 && combinedMaxProfit({ combinedMaxProfit: 0 }) === 0 && combinedMaxProfit({ combinedMaxProfit: '5%' }) === 0, 'absent / 0 / non-number = off');
    assert(validateNumericRanges('settings', { combinedMaxProfit: 20000 }).length === 0, 'valid value accepted');
    assert(validateNumericRanges('settings', { combinedMaxProfit: -5 }).length === 1 && validateNumericRanges('settings', { combinedMaxProfit: '10%' }).length === 1, 'negative / percent rejected');
    process.exit(process.exitCode ?? 0);
})();
