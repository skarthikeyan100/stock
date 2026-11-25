/**
 * Same-day realized-P&L reconcile (util/realizedReconcile.ts + tools/reconcileRealized.ts): the broker's own convention per broker (day-average for
 * kite / ant / prism, FIFO for breeze), the 1.5 rupees x lots tolerance, the likely cause, and the book readers.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/realizedReconcile.test.js
 */
process.env.MOCK_BROKER = 'true';
import { brokerRealizedByContract, compareRealized, likelyCause, platformRealizedByContract, lotSizeOfTsym } from '../util/realizedReconcile';
import { reconcileBroker, fillsFromBook } from '../tools/reconcileRealized';
import { orderKey } from '../util/orderKey';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

console.log('(1) conventions');
const F = (action: 'Buy' | 'Sell', qty: number, price: number, at?: number, tsym = 'C') => ({ tsym, action, qty, price, at });
// day-average: buys 100@10 and 100@20 (avg 15), sell 100@30 -> 1500 (FIFO would say 2000)
assert(near(brokerRealizedByContract('ant', [F('Buy', 100, 10), F('Buy', 100, 20), F('Sell', 100, 30)])!.get('C')!, 1500), 'ant / kite / prism: day average (1500)');
assert(near(brokerRealizedByContract('breeze', [F('Buy', 100, 10, 1), F('Buy', 100, 20, 2), F('Sell', 100, 30, 3)])!.get('C')!, 2000), 'breeze: FIFO (2000)');
assert(brokerRealizedByContract('breeze', [F('Buy', 100, 10), F('Sell', 100, 30, 3)]) === null, 'breeze rows without an order cannot be FIFO-ed: not compared');
assert(near(brokerRealizedByContract('ant', [F('Sell', 100, 30), F('Buy', 100, 10)])!.get('C')!, 2000), 'a short round trip (sold first): bought qty x (avg sell - avg buy)');
assert(lotSizeOfTsym('NIFTY01DEC26P25700') === 65 && lotSizeOfTsym('SENSEX26D0185000CE') === 20 && lotSizeOfTsym('RELIANCE26DECCE') === 1, 'lot sizes');

console.log('(2) comparison and tolerance');
const bm = new Map([['NIFTY01DEC26P25700', 100.0], ['NIFTY01DEC26C25750', 50]]);
const pm = new Map([['NIFTY01DEC26P25700', 100.5], ['NIFTY01DEC26C25750', 40]]);
const d = compareRealized('ant', bm, pm, () => 65);
assert(d.length === 1 && d[0].tsym === 'NIFTY01DEC26C25750' && near(d[0].diff, -10) && near(d[0].tolerance, 1.5), 'within 1.5 x lots is silent, 10 rupees on one lot is flagged');
assert(compareRealized('ant', bm, pm, () => 65 * 10).length === 0, 'the tolerance scales with the lots (10 lots = 15 rupees)');
assert(compareRealized('ant', new Map(), new Map([['Z', 500]]), () => 65).length === 1, 'a contract only the platform has is flagged');

console.log('(3) likely cause');
const stored = new Set(['Sell|ant:S1']);
const keyOf = (id: string) => orderKey('ant', id);
const fills = [{ tsym: 'C', action: 'Buy' as const, qty: 195, price: 204.3, orderId: 'B1' }, { tsym: 'C', action: 'Sell' as const, qty: 195, price: 214.3, orderId: 'S1' }];
assert(/order-id collision/.test(likelyCause(fills, stored, keyOf, new Set(['B1']), -1950, [])), 'a missing fill whose id exists on another broker: collision');
assert(/never booked/.test(likelyCause(fills, stored, keyOf, new Set(), -1950, [])) && !/collision/.test(likelyCause(fills, stored, keyOf, new Set(), -1950, [])), 'a missing fill with no other broker: never booked');
assert(/no closedTrades row/.test(likelyCause(fills, new Set(['Buy|ant:B1', 'Sell|ant:S1']), keyOf, new Set(), -1950, ['stored sell qty 195 > closed qty 0'])), 'every fill stored, a Sell without a row');
assert(/pairing/.test(likelyCause(fills, new Set(['Buy|ant:B1', 'Sell|ant:S1']), keyOf, new Set(), -3, [])), 'everything stored: a pairing difference');

console.log('(4) book readers and one broker\'s report');
const day = '2026-11-25';
const antRows = [
    { brokerOrderId: 'B1', exchangeTradeId: '1', transactionType: 'BUY', instrumentId: '47836', tradingSymbol: 'NIFTY', filledQuantity: 195, tradedPrice: 204.3, fillTimestamp: '25-11-2026 13:34:40' },
    { brokerOrderId: 'S1', exchangeTradeId: '2', transactionType: 'SELL', instrumentId: '47836', tradingSymbol: 'NIFTY', filledQuantity: 195, tradedPrice: 214.3, fillTimestamp: '25-11-2026 13:35:24' },
];
// The ANT book names the underlying: the reader resolves the contract through the contract master (not available in a unit test): fills keep 'NIFTY' here.
const prismRows = [
    { norenordno: 'P1', trantype: 'B', tsym: 'NIFTY01DEC26P25700', flqty: '195', flprc: '204.30', fltm: '25-11-2026 13:34:42' },
    { norenordno: 'P2', trantype: 'S', tsym: 'NIFTY01DEC26P25700', flqty: '195', flprc: '214.30', fltm: '25-11-2026 13:35:26' },
    { norenordno: 'OLD', trantype: 'S', tsym: 'NIFTY01DEC26P25700', flqty: '65', flprc: '1', fltm: '24-11-2026 10:00:00' },
];
const pf = fillsFromBook('prism', prismRows, day)!;
assert(pf.length === 2, 'prism: only the day\'s per-fill rows (the earlier-day row is left out)');
const closedPrism = [{ tsym: 'NIFTY01DEC26P25700', realizedPnL: 1950, quantity: 195, entryTime: '2026-11-25T08:04:42Z', exitTime: '2026-11-25T08:05:26Z' }];
assert(reconcileBroker({ broker: 'prism', fills: pf, platformRows: closedPrism }, day).diffs.length === 0, 'prism agrees');
assert(reconcileBroker({ broker: 'prism', fills: pf, platformRows: [] }, day).diffs.length === 1, 'prism with the closed row missing is flagged');
// carried-over contract: not compared
const carried = [{ tsym: 'NIFTY01DEC26P25700', realizedPnL: 5, quantity: 195, entryTime: '2026-11-24T08:04:42Z', exitTime: '2026-11-25T08:05:26Z' }];
const rc = reconcileBroker({ broker: 'prism', fills: pf, platformRows: carried }, day);
assert(rc.diffs.length === 0 && /carried/.test(rc.note ?? ''), 'a contract carried over from an earlier day is left out with a note');
assert(reconcileBroker({ broker: 'ant', fills: null, platformRows: [] }, day).diffs.length === 0, 'an unreadable book is reported, not compared');
const af = fillsFromBook('ant', antRows, day);
assert(!!af && af.length === 2 && af.every((f) => f.qty === 195), 'ant: both rows read (one per execution)');
// the platform's rows of the day for several users on one contract are summed
assert(near(platformRealizedByContract([{ tsym: 'C', realizedPnL: 10, quantity: 1 }, { tsym: 'C', realizedPnL: 5, quantity: 1 }]).get('C')!, 15), 'platform rows are summed per contract');

console.log(failed ? 'FAILED' : 'ALL PASSED');
process.exit(failed ? 1 : 0);
