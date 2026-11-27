/**
 * An open position row lists the buy order ids booked into it, so the trading page can drop that order's "Pending" card in the same update
 * that shows the position (two cards used to show for a moment after a buy).
 * Run: npx tsc && node ./dist/test/buyOrderIds.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }
const TSYM = 'NIFTYBOI1';
const USER = 'boi-user';
const buy = (oid: string | undefined, qty = 65) => Object.assign(new Trade(), { tsym: TSYM, token: 'boi-tok', quantity: qty, price: 100, action: 'Buy', status: 'COMPLETE', user: USER, broker: 'paper', brokerOrderId: oid });
const row = () => bookkeeping.trades.find((t) => t.tsym === TSYM && t.user === USER);

async function main() {
    // The ids must be on the row when the page is told that positions changed.
    const seen: string[] = [];
    bookkeeping.onPositionsChanged(() => { seen.push((row()?.buyOrderIds ?? []).join(',')); });
    const first = buy('boi-1');
    await bookkeeping.recordFill(first);
    assert(row()?.buyOrderIds?.join(',') === 'boi-1', `a new row lists its buy order (${row()?.buyOrderIds})`);
    assert(seen[0] === 'boi-1', `the id is there at the first position update (${seen[0]})`);
    const second = buy('boi-2');
    await bookkeeping.recordFill(second);
    assert(row()?.quantity === 130 && row()?.buyOrderIds?.join(',') === 'boi-1,boi-2', `an added buy is listed on the merged row (${row()?.buyOrderIds})`);
    assert(first.buyOrderIds === undefined && second.buyOrderIds === undefined, 'the fill objects themselves are not changed');
    await bookkeeping.recordFill(buy('boi-2'));
    assert(row()?.quantity === 130 && row()?.buyOrderIds?.length === 2, 'a redelivered fill adds nothing');
    await bookkeeping.recordFill(buy(undefined));
    assert(row()?.quantity === 195 && row()?.buyOrderIds?.length === 2, 'a fill without an order id adds no id');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.log('FAIL:', e); process.exit(1); });
