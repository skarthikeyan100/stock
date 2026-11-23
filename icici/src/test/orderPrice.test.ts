/**
 * The pure order-price rule (no broker, no network). Run: npx tsc, then: node ./dist/test/orderPrice.test.js
 */
import { pickOrderPrice, roundDownToTick, roundUpToTick, priceLine } from '../util/orderPriceCore';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

assert(pickOrderPrice('BUY', 100.05, 100.4) === 100.05, 'a bid already on a tick is used as given');
assert(pickOrderPrice('BUY', 100.07, 100.4) === 100.05, 'a buy rounds the bid DOWN');
assert(pickOrderPrice('BUY', 100.099, 100.4) === 100.05, 'a buy never goes above the bid');
assert(pickOrderPrice('BUY', 100.04, 100.4) === 100, 'bid 100.04 -> 100');
assert(pickOrderPrice('SELL', 99.9, 100.4) === 100.4, 'an ask already on a tick is used as given');
assert(pickOrderPrice('SELL', 99.9, 100.41) === 100.45, 'a sell rounds the ask UP');
assert(pickOrderPrice('SELL', 99.9, 100.401) === 100.45, 'a sell never goes below the ask');
assert(pickOrderPrice('BUY', 100.15, 100.2) === 100.15 && pickOrderPrice('SELL', 100.1, 100.15) === 100.15, 'float drift (100.15) does not move a tick-aligned quote');
assert(roundDownToTick(0.07) === 0.05 && roundUpToTick(0.07) === 0.1, 'small prices');
for (let i = 0; i < 2000; i++) {
    const bid = Math.round(Math.random() * 30000) / 100, ask = bid + Math.round(Math.random() * 500) / 100;
    const b = pickOrderPrice('BUY', bid, ask), s = pickOrderPrice('SELL', bid, ask);
    if (b > bid + 1e-9 || s < ask - 1e-9 || bid - b >= 0.05 - 1e-9 || s - ask >= 0.05 - 1e-9) { assert(false, `never through the quote: bid ${bid} ask ${ask} -> ${b}/${s}`); break; }
    if (i === 1999) assert(true, '2000 random quotes: buy <= bid and sell >= ask, each within one tick');
}
assert(priceLine('BUY', 'X', 'ant', { price: 100, bid: 100.02, ask: 100.3, ltp: 100.1, spread: 0.28 }) === '[order] price pick: BUY X broker=ant bid=100.02 ask=100.3 ltp=100.1 spread=0.28 -> 100', 'log line format');
assert(priceLine('SELL', 'X', 'ant', { price: 100.35, bid: 0, ask: 100.3, ltp: 0, spread: null }) === '[order] price pick: SELL X broker=ant bid=n/a ask=100.3 ltp=n/a spread=n/a -> 100.35', 'log line with missing fields');
