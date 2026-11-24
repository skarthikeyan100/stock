/**
 * cancelProtection unregisters the exit watch and notifies BEFORE rethrowing a GTT delete failure; a parked Sell without a broker order id
 * is cleared when the Sell is later booked.
 * Run: node ./dist/test/reviewFixesProtectionUnresolved.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import * as exitMonitor from '../processes/order/exitMonitor';
import Log from '../util/Log';
import { cancelProtection } from '../processes/order/attachProtection';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }
const fill = (action: string, tsym: string, qty: number, price: number, oid?: string) => {
    const t = new Trade();
    Object.assign(t, { tsym, token: 'tok-' + tsym, quantity: qty, price, action, status: 'COMPLETE', user: 'PuUser', broker: 'kite', brokerOrderId: oid });
    return t;
};

async function main() {
    // 1. cancelProtection: failed delete still unregisters + notifies, then throws.
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU1', 65, 100, 'pub1'));
    const row = bookkeeping.trades.find((t) => t.tsym === 'NIFTYPU1')!;
    row.gttTriggerId = 31;
    (Kite.getInstance() as any).deleteGTT = async () => { throw new Error('boom'); };
    const unreg: string[] = [];
    const origUnreg = exitMonitor.unregisterTrade;
    (exitMonitor as any).unregisterTrade = (u: string, tok: string) => { unreg.push(`${u}|${tok}`); };
    let notified = 0;
    const origNotify = bookkeeping.notifyTargetStopLossChanged.bind(bookkeeping);
    (bookkeeping as any).notifyTargetStopLossChanged = () => { notified++; };
    let threw = false;
    try { await cancelProtection('PuUser', 'kite', 'NIFTYPU1'); } catch { threw = true; }
    (exitMonitor as any).unregisterTrade = origUnreg;
    (bookkeeping as any).notifyTargetStopLossChanged = origNotify;
    assert(threw, 'failed GTT delete still throws');
    assert(unreg.join() === 'PuUser|tok-NIFTYPU1', 'exit monitor unregistered before the throw');
    assert(notified === 1, 'target/SL change notified before the throw');
    assert(row.gttTriggerId === 31, 'the live GTT id is kept');

    // 2. Parked Sell with no order id is cleared once a Sell is booked.
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU2', 65, 100, 'pub2'));
    bookkeeping.setUnresolvedSellHandler(() => {});
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU2', 65, NaN, undefined));
    assert(bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU2').length === 1, 'id-less unpriced Sell is parked');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU2', 65, 110, undefined));
    assert(!bookkeeping.trades.some((t) => t.tsym === 'NIFTYPU2'), 'later Sell books the position');
    assert(bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU2').length === 0, 'parked id-less entry is cleared');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 3. Two id-less parked Sells of one tsym are both kept; a Buy / other-qty Sell does not clear them; a matching priced Sell clears one each.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const cnt = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU3').length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU3', 200, 100, 'pub3'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU3', 50, NaN, undefined));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU3', 75, NaN, undefined));
    assert(cnt() === 2, 'two id-less parked sells both reported');
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU3', 10, 100, 'pub3b'));
    assert(cnt() === 2, 'booking a Buy leaves parked sells');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU3', 30, 110, 'pub3s30'));
    assert(cnt() === 2, 'Sell of a different quantity leaves parked sells');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU3', 50, 110, 'pub3s50'));
    assert(cnt() === 1 && bookkeeping.getUnresolvedFills().some((f) => f.tsym === 'NIFTYPU3' && f.quantity === 75), 'matching Sell clears only its own parked entry');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU3', 75, 110, 'pub3s75'));
    assert(cnt() === 0, 'second matching Sell clears the other');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 4. Redelivery of the same id-less unpriced Sell does not add entries; a redelivered BOOKED Sell does not clear another parked entry.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const c4 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU4').length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU4', 300, 100, 'pub4'));
    for (let i = 0; i < 5; i++) await bookkeeping.recordFill(fill('Sell', 'NIFTYPU4', 75, NaN, undefined));
    assert(c4() === 1, 'redelivered id-less unpriced Sell is one entry');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU4', 40, NaN, 'pub4p'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU4', 50, 110, 'pub4s50'));
    assert(c4() === 2, 'unrelated booked Sell leaves both parked');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU4', 50, 110, 'pub4s50'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU4', 75, 110, 'pub4s50'));
    assert(c4() === 2, 'redelivery of an already-booked Sell does not clear a parked entry');

    // 5. Parked 75 booked later as pieces 50 + 25 is cleared once the position is flat (not before).
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU5', 75, 100, 'pub5'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU5', 75, NaN, undefined));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU5', 50, 110, 'pub5a'));
    const c5 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU5').length;
    assert(c5() === 1, 'after piece 50 (position not flat) the parked entry stays');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU5', 25, 110, 'pub5b'));
    assert(c5() === 0, 'after piece 25 (flat) the parked entry is cleared');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 6. A parked entry whose order id is later seen on an early-return (already processed) path is cleared by id only; an unpriced redelivery stays parked.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const c6 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU6').length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU6', 200, 100, 'pub6'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, 110, 'pub6x'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 40, NaN, undefined));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, NaN, 'pub6x'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, NaN, 'pub6x'));
    assert(c6() === 2, 'unpriced redelivery of an id stays parked (one entry per id)');
    assert(bookkeeping.getUnresolvedFills().find((f) => f.brokerOrderId === 'pub6x')?.seen === 2, 'entry counts times seen');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, 110, 'pub6x'));
    assert(c6() === 1, 'already-processed redelivery with a price clears that order id only');
    assert(bookkeeping.getUnresolvedFills().some((f) => f.tsym === 'NIFTYPU6' && f.quantity === 40), 'the other (id-less) entry is untouched');

    // 7. A Sell against an untracked contract (no row) does not flat-clear parked entries of that contract.
    const c7 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU7').length;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU7', 75, NaN, undefined));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU7', 30, 110, 'pub7'));
    assert(c7() === 1, 'untracked contract: booked Sell does not flat-clear the parked entry');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 8. An id claimed by a delivery still mid-booking is NOT proof of booking: the early return leaves the parked entry; it goes only once booked.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const c8 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU8').length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU8', 100, 100, 'pub8'));
    const origProc = (bookkeeping as any)._processTradeEvent.bind(bookkeeping);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (bookkeeping as any)._processTradeEvent = async (ev: Trade, skip?: boolean) => { await gate; throw new Error('booking failed'); };
    const first = bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, 110, 'pub8x')).catch(() => 'threw');
    await new Promise((r) => setTimeout(r, 50));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, NaN, 'pub8x')); // parked while the first delivery is mid-booking
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, 110, 'pub8x')); // early return: already claimed
    assert(c8() === 1, 'redelivery of an id mid-booking does not clear the parked entry');
    release();
    assert(await first === 'threw', 'the in-flight booking failed');
    assert(c8() === 1, 'parked entry still there after the booking threw');
    (bookkeeping as any)._processTradeEvent = origProc;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, 110, 'pub8x')); // retry books for real
    assert(c8() === 0, 'parked entry cleared once the Sell is verifiably booked');

    // 9. "Already stored in Mongo" does not prove memory was reduced: the parked entry stays.
    const c9 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU9').length;
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU9', 100, 100, 'pub9'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU9', 50, NaN, 'pub9x'));
    const origStored = (bookkeeping as any).fillAlreadyStored;
    (bookkeeping as any).fillAlreadyStored = async () => true;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU9', 50, 110, 'pub9x'));
    (bookkeeping as any).fillAlreadyStored = origStored;
    assert(c9() === 1, 'stored-in-Mongo early return leaves the parked entry');
    assert(bookkeeping.trades.find((t) => t.tsym === 'NIFTYPU9')?.quantity === 100, 'and memory was not reduced by it');

    // 10. A zero-quantity row is not an open position: a Sell booked against it does not flat-clear parked entries.
    const c10 = () => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU10').length;
    const zero = Object.assign(new Trade(), { tsym: 'NIFTYPU10', token: 'tok-NIFTYPU10', quantity: 0, price: 100, action: 'Buy', user: 'PuUser', broker: 'kite' });
    bookkeeping.trades.push(zero);
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU10', 75, NaN, undefined));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU10', 30, 110, 'pub10'));
    assert(c10() === 1, 'zero-quantity row: booked Sell does not flat-clear the parked entry');
    bookkeeping.trades.splice(bookkeeping.trades.indexOf(zero), 1);
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 11. A restore that netted a stored Sell into a row it really added marks it booked: the stored-in-Mongo early return then clears the parked entry.
    // A restore row refused as a duplicate (already tracked) proves nothing: that entry stays.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const c11 = (t: string) => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === t).length;
    const origStored11 = (bookkeeping as any).fillAlreadyStored;
    (bookkeeping as any).fillAlreadyStored = async () => true;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, NaN, 'pub11x'));
    const restoredRow = Object.assign(new Trade(), { tsym: 'NIFTYPU11', token: 'tok-NIFTYPU11', quantity: 50, price: 100, action: 'Buy', user: 'PuUser', broker: 'kite' });
    (bookkeeping as any).restoredSellIds.set(restoredRow, ['pub11x']);
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, 110, 'pub11x'));
    assert(c11('NIFTYPU11') === 1, 'before the restore adds the row: stored early return leaves the entry');
    (bookkeeping as any).mergeRestored([restoredRow]);
    assert(c11('NIFTYPU11') === 0, 'restore adding the row clears the parked entry of the Sell it netted');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, NaN, 'pub11x'));
    assert(c11('NIFTYPU11') === 1, 'an unpriced redelivery parks again');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, 110, 'pub11x'));
    assert(c11('NIFTYPU11') === 0, 'stored early return now clears it (id is in bookedFillIds)');
    // duplicate row refused: not marked booked
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11B', 50, NaN, 'pub11bx'));
    bookkeeping.trades.push(Object.assign(new Trade(), { tsym: 'NIFTYPU11B', token: 'tok-NIFTYPU11B', quantity: 80, price: 100, action: 'Buy', user: 'PuUser', broker: 'kite' }));
    const dup = Object.assign(new Trade(), { tsym: 'NIFTYPU11B', token: 'tok-NIFTYPU11B', quantity: 30, price: 100, action: 'Buy', user: 'PuUser', broker: 'kite' });
    (bookkeeping as any).restoredSellIds.set(dup, ['pub11bx']);
    (bookkeeping as any).mergeRestored([dup]);
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11B', 50, 110, 'pub11bx'));
    assert(c11('NIFTYPU11B') === 1, 'a refused duplicate restore row does not clear the entry');
    (bookkeeping as any).fillAlreadyStored = origStored11;
    bookkeeping.trades.splice(0, bookkeeping.trades.length, ...bookkeeping.trades.filter((t) => !/^NIFTYPU11/.test(t.tsym)));

    // 12. bookedFillIds holds only Sell ids (a Buy id is never recorded).
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU12', 10, 100, 'pub12b'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU12', 10, 110, 'pub12s'));
    assert(!(bookkeeping as any).bookedFillIds.has('pub12b') && (bookkeeping as any).bookedFillIds.has('pub12s'), 'only the Sell id is recorded as booked');

    // 13. Counts in the alerts: id-bearing entries report redeliveries (seen - 1), nothing when delivered once.
    const logs: string[] = [];
    const origLog = Log.log;
    (Log as any).log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU13', 50, NaN, 'pub13x'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU13', 50, NaN, 'pub13x'));
    bookkeeping.alertStaleUnresolvedFills(Date.now() + 3_600_000);
    const stale = logs.find((l) => l.includes('still NOT booked') && l.includes('pub13x')) ?? '';
    assert(stale.includes('redelivered 1x') && !stale.includes('redelivered 2x'), 'stale ALERT: two deliveries = redelivered 1x');
    const seenText = (bookkeeping.constructor as any).seenText.bind(bookkeeping.constructor);
    assert(seenText({ brokerOrderId: 'a', seen: 1 }) === '' && seenText({ brokerOrderId: 'a', seen: 3 }) === 'redelivered 2x' && seenText({ seen: 3 }) === 'seen 3x', 'seenText: id-bearing seen-1, hidden at 1; id-less seen N');
    (Log as any).log = origLog;
    bookkeeping.setUnresolvedSellHandler(undefined);
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
