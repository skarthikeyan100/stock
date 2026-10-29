/**
 * Any Sell fill that reduces a position carrying a Kite GTT releases that GTT (review R5-2): a GTT bypasses the app's never-short
 * guard, so one left live after a manual / timeout / lock-profits / chunked exit could sell a flat account short.
 * Run: node ./dist/test/gttCleanupOnExit.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const deleted: number[] = [];
let failDelete = false;
let liveGtts: any[] = [];
const kite = Kite.getInstance() as any;
kite.deleteGTT = async (id: number) => { if (failDelete) throw new Error('boom'); deleted.push(id); };
kite.getGTTs = async () => liveGtts;

function fill(action: 'Buy' | 'Sell', tsym: string, qty: number, price: number, oid: string): Trade {
    const t = new Trade();
    Object.assign(t, { tsym, token: 'tok-' + tsym, quantity: qty, price, action, status: 'COMPLETE', user: 'GttUser', broker: 'kite', brokerOrderId: oid });
    return t;
}
const rowOf = (tsym: string) => bookkeeping.trades.find((t) => t.tsym === tsym && t.user === 'GttUser');

async function main() {
    // Two chunks bought, one GTT on the aggregate row; the first partial sell must drop the (now oversized) GTT, the second must not retry it.
    await bookkeeping.recordFill(fill('Buy', 'NIFTYA', 130, 100, 'b1'));
    rowOf('NIFTYA')!.gttTriggerId = 111;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYA', 65, 105, 's1'));
    await bookkeeping.whenGttReleased();
    assert(deleted.length === 1 && deleted[0] === 111, 'a partial sell deletes the position\'s GTT once');
    assert(rowOf('NIFTYA')!.gttTriggerId == null && rowOf('NIFTYA')!.quantity === 65, 'the remaining 65 no longer references a GTT');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYA', 65, 106, 's2'));
    await bookkeeping.whenGttReleased();
    assert(deleted.length === 1 && rowOf('NIFTYA') === undefined, 'the closing chunk does not delete again and the row is gone');

    // Full close in one sell.
    await bookkeeping.recordFill(fill('Buy', 'NIFTYB', 65, 100, 'b2'));
    rowOf('NIFTYB')!.gttTriggerId = 222;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYB', 65, 99, 's3'));
    await bookkeeping.whenGttReleased();
    assert(deleted.includes(222), 'a full manual close deletes the GTT');

    // A position with no GTT is untouched.
    const before = deleted.length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYC', 65, 100, 'b3'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYC', 65, 101, 's4'));
    await bookkeeping.whenGttReleased();
    assert(deleted.length === before, 'a position without a GTT triggers no delete');

    // A failing delete never breaks the fill and never throws out of bookkeeping.
    failDelete = true;
    liveGtts = [{ id: 333, status: 'active' }];
    await bookkeeping.recordFill(fill('Buy', 'NIFTYD', 65, 100, 'b4'));
    rowOf('NIFTYD')!.gttTriggerId = 333;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYD', 65, 101, 's5'));
    await bookkeeping.whenGttReleased();
    assert(rowOf('NIFTYD') === undefined, 'the sell is still booked when the GTT delete fails');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
