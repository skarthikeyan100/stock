/** /strategyPnl ?closed=1 row shaping. Run: npx tsc, then: node ./dist/test/closedTradeRows.test.js */
import assert from 'assert';
import { closedTradeRows } from '../util/closedTradeRows';

const now = new Date('2026-11-13T06:00:00Z').getTime();
const rows = [
    { user: 'a@x.com', broker: 'ant', tsym: 'NIFTY1', quantity: 75, entryPrice: 100, exitPrice: 110, realizedPnL: 750, entryTime: '2026-11-13T04:00:00Z', exitTime: '2026-11-13T05:00:00Z' },
    { user: 'a@x.com', tsym: 'NIFTY2', quantity: 75, price: 50, exitPrice: 40, realizedPnL: -750, entryTime: '2026-11-12T04:00:00Z', exitTime: '2026-11-13T03:50:00Z' },
    { user: 'Default', strategy: 'Bulk', broker: 'kite', tsym: 'NIFTY3', quantity: 75, entryPrice: 1, exitPrice: 2, realizedPnL: 75, entryTime: '2026-11-13T04:00:00Z', exitTime: '2026-11-13T04:30:00Z' },
];
const at = /@/;
let r = closedTradeRows(rows, at, true, now);
assert.strictEqual(r.length, 1, 'today only drops the trade opened yesterday; match drops the strategy');
assert.strictEqual(r[0].tsym, 'NIFTY1');
r = closedTradeRows(rows, at, false, now);
assert.deepStrictEqual(r.map((x) => x.tsym), ['NIFTY2', 'NIFTY1'], 'all keeps both, ordered by exit time');
assert.strictEqual(r[0].broker, 'kite', 'no broker = kite');
assert.strictEqual(r[0].entryPrice, 50, 'price is the entry when entryPrice is absent');
assert.strictEqual(closedTradeRows(rows, null, false, now).length, 3);
assert.strictEqual(closedTradeRows([{ user: 'u', tsym: 't', quantity: 1, realizedPnL: 1 }], null, true, now)[0].exitPrice, null, 'missing exit price stays null');
console.log('closedTradeRows tests passed');
