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
import Mongo from '../tools/mongo';
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
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, NaN, 'pub6p'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, NaN, 'pub6p'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, NaN, 'pub6x')); // already booked above: not parked
    assert(c6() === 2, 'unpriced redelivery of an id stays parked (one entry per id)');
    assert(bookkeeping.getUnresolvedFills().find((f) => f.brokerOrderId === 'pub6p')?.seen === 2, 'entry counts times seen');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU6', 50, 110, 'pub6p'));
    assert(c6() === 1, 'a priced delivery of the parked order books it and clears that order id only');
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
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, NaN, 'pub8x')); // parked before the priced delivery claims the id
    const first = bookkeeping.recordFill(fill('Sell', 'NIFTYPU8', 50, 110, 'pub8x')).catch(() => 'threw');
    await new Promise((r) => setTimeout(r, 50));
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

    // 11. A restore never clears a parked entry (it proves nothing about this Sell): the stored-in-Mongo early return leaves it parked unless the id is in bookedFillIds.
    bookkeeping.setUnresolvedSellHandler(() => {});
    const c11 = (t: string) => bookkeeping.getUnresolvedFills().filter((f) => f.tsym === t).length;
    const origStored11 = (bookkeeping as any).fillAlreadyStored;
    try {
        (bookkeeping as any).fillAlreadyStored = async () => true;
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, NaN, 'pub11x'));
        const restoredRow = Object.assign(new Trade(), { tsym: 'NIFTYPU11', token: 'tok-NIFTYPU11', quantity: 50, price: 100, action: 'Buy', user: 'PuUser', broker: 'kite' });
        (bookkeeping as any).mergeRestored([restoredRow]);
        assert(c11('NIFTYPU11') === 1, 'a restore adding a row leaves the parked entry');
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, 110, 'pub11x'));
        assert(c11('NIFTYPU11') === 1, 'stored early return leaves the entry when the id is not in bookedFillIds');
        (bookkeeping as any).markSellBooked('pub11x');
        assert(c11('NIFTYPU11') === 0, 'markSellBooked clears the entry');
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, NaN, 'pub11x'));
        assert(c11('NIFTYPU11') === 0, 'an unpriced redelivery of a booked id (bookedFillIds) is not parked again');
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU11', 50, 110, 'pub11x'));
        assert(c11('NIFTYPU11') === 0, 'stored early return leaves nothing parked when the id is in bookedFillIds');
    } finally {
        (bookkeeping as any).fillAlreadyStored = origStored11;
        bookkeeping.trades.splice(0, bookkeeping.trades.length, ...bookkeeping.trades.filter((t) => !/^NIFTYPU11/.test(t.tsym)));
        (bookkeeping as any).bookedFillIds.delete('kite:pub11x');
    }

    // 12. bookedFillIds holds only Sell ids (a Buy id is never recorded).
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU12', 10, 100, 'pub12b'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU12', 10, 110, 'pub12s'));
    assert(!(bookkeeping as any).bookedFillIds.has('kite:pub12b') && (bookkeeping as any).bookedFillIds.has('kite:pub12s'), 'only the Sell id is recorded as booked');
    (bookkeeping as any).bookedFillIds.delete('kite:pub12s');

    // 14. A Sell against an untracked contract is not recorded in bookedFillIds (it reduced nothing).
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU14', 10, 110, 'pub14s'));
    assert(!(bookkeeping as any).bookedFillIds.has('kite:pub14s'), 'a Sell against an untracked contract is not recorded as booked');

    // 15. A Sell matching an open row only by token (different tsym) reduces nothing, so it records no booked proof.
    bookkeeping.setUnresolvedSellHandler(() => {});
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU15', 50, 100, 'pub15b'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU15', 50, NaN, 'pub15x'));
    const tokSell = fill('Sell', 'NIFTYPU15ALT', 50, 110, 'pub15x');
    tokSell.token = 'tok-NIFTYPU15';
    await bookkeeping.recordFill(tokSell);
    assert(!(bookkeeping as any).bookedFillIds.has('kite:pub15x'), 'a token-only match reduced no row: no booked proof');
    assert(bookkeeping.trades.find((t) => t.tsym === 'NIFTYPU15')?.quantity === 50, 'the token-only Sell did not touch the row');
    bookkeeping.trades.splice(0, bookkeeping.trades.length, ...bookkeeping.trades.filter((t) => !/^NIFTYPU15/.test(t.tsym)));
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 13. Counts in the alerts: id-bearing entries report redeliveries (seen - 1), nothing when delivered once.
    const logs: string[] = [];
    const origLog = Log.log;
    try {
    (Log as any).log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU13', 50, NaN, 'pub13x'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU13', 50, NaN, 'pub13x'));
    bookkeeping.alertStaleUnresolvedFills(Date.now() + 3_600_000);
    const stale = logs.find((l) => l.includes('still NOT booked') && l.includes('pub13x')) ?? '';
    assert(stale.includes('redelivered 1x') && !stale.includes('redelivered 2x'), 'stale ALERT: two deliveries = redelivered 1x');
    const seenText = (bookkeeping.constructor as any).seenText.bind(bookkeeping.constructor);
    assert(seenText({ brokerOrderId: 'a', seen: 1 }) === '' && seenText({ brokerOrderId: 'a', seen: 3 }) === 'redelivered 2x' && seenText({ seen: 3 }) === 'seen 3x', 'seenText: id-bearing seen-1, hidden at 1; id-less seen N');
    const full = "ALERT: Sell fill still NOT booked";
    assert(stale.includes(full) && stale.includes('order pub13x') && stale.includes('this entry clears only when this process books that Sell into a tracked position (a redelivery with a usable price, or a sync from the broker\'s trade book); a restart restore does not clear it, otherwise book it manually'), 'stale ALERT full text');
    } finally { (Log as any).log = origLog; }
    for (const k of Array.from((bookkeeping as any).bookedFillIds as Set<string>)) if (/^kite\|pub/.test(k)) (bookkeeping as any).bookedFillIds.delete(k);
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 16. A redelivery of an ALREADY-BOOKED Sell with an unusable price is not parked (nothing could ever clear it).
    bookkeeping.setUnresolvedSellHandler(() => {});
    await bookkeeping.recordFill(fill('Buy', 'NIFTYPU16', 50, 100, 'pub16b'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU16', 50, 110, 'pub16s'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYPU16', 50, 0 / 0, 'pub16s'));
    assert(bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU16').length === 0, 'unpriced redelivery of a booked Sell is not parked');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 17. Parked Sells are persisted in Mongo (write on park, delete on clear) and reloaded after a restart while the position is open.
    const store = new Map<string, any>();
    const fakeCol = {
        replaceOne: async (q: any, d: any) => { store.set(q._id, { _id: q._id, ...d }); },
        deleteOne: async (q: any) => { store.delete(q._id); },
        find: () => ({ toArray: async () => [...store.values()] }),
    };
    const origGet = Mongo.getInstance;
    (Mongo as any).getInstance = () => ({ db: { collection: (n: string) => (n === 'unresolvedSells' ? fakeCol : undefined) } });
    try {
        bookkeeping.setUnresolvedSellHandler(() => {});
        await bookkeeping.recordFill(fill('Buy', 'NIFTYPU17', 50, 100, 'pub17b'));
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU17', 50, NaN, 'pub17x'));
        assert(store.has('kite:pub17x') && store.get('kite:pub17x').tsym === 'NIFTYPU17', 'parked Sell written to Mongo');
        const mem = (bookkeeping as any).unresolvedFills as Map<string, any>;
        mem.delete('kite:pub17x'); // simulate the restart: memory empty, Mongo row and open position remain
        assert(await bookkeeping.restoreUnresolvedSells() === 1 && bookkeeping.getUnresolvedFills().some((f) => f.brokerOrderId === 'pub17x'), 'parked Sell reloaded after restart');
        // stale-day entry and an entry for a flat contract are dropped, not reloaded
        // a row written before the keys were broker-scoped (_id = the bare order id) is re-keyed broker|id and the old document removed
        store.set('pub17L', { _id: 'pub17L', tsym: 'NIFTYPU17', user: 'PuUser', broker: 'kite', quantity: 50, brokerOrderId: 'pub17L', at: new Date(), seen: 1 });
        await bookkeeping.restoreUnresolvedSells(); await new Promise((r) => setTimeout(r, 10));
        assert(mem.has('kite:pub17L') && !mem.has('pub17L') && store.has('kite:pub17L') && !store.has('pub17L'), 'a legacy bare-id parked row is re-keyed broker|id');
        mem.delete('kite:pub17L'); store.delete('kite:pub17L');
        // the interim 'broker|id' _id (written earlier the same day, before the composite '<broker>:<id>' key) is re-keyed the same way
        store.set('kite|pub17M', { _id: 'kite|pub17M', tsym: 'NIFTYPU17', user: 'PuUser', broker: 'kite', quantity: 50, brokerOrderId: 'pub17M', at: new Date(), seen: 1 });
        await bookkeeping.restoreUnresolvedSells(); await new Promise((r) => setTimeout(r, 10));
        assert(mem.has('kite:pub17M') && !mem.has('kite|pub17M') && store.has('kite:pub17M') && !store.has('kite|pub17M'), 'an interim broker|id parked row is re-keyed to the composite key');
        mem.delete('kite:pub17M'); store.delete('kite:pub17M');
        mem.delete('kite:pub17x');
        store.set('old1', { _id: 'old1', tsym: 'NIFTYPU17', user: 'PuUser', broker: 'kite', quantity: 50, brokerOrderId: 'old1', at: new Date(Date.now() - 3 * 86400000), seen: 1 });
        store.set('flat1', { _id: 'flat1', tsym: 'NIFTYPU17FLAT', user: 'PuUser', broker: 'kite', quantity: 50, brokerOrderId: 'flat1', at: new Date(), seen: 1 });
        await bookkeeping.restoreUnresolvedSells();
        assert(!store.has('old1') && !store.has('flat1') && !bookkeeping.getUnresolvedFills().some((f) => f.brokerOrderId === 'old1' || f.brokerOrderId === 'flat1'), 'stale-day and flat-contract entries dropped');
        await bookkeeping.recordFill(fill('Sell', 'NIFTYPU17', 50, 110, 'pub17x'));
        assert(!store.has('kite:pub17x') && bookkeeping.getUnresolvedFills().filter((f) => f.tsym === 'NIFTYPU17').length === 0, 'booking the Sell deletes the persisted row');
    } finally {
        (Mongo as any).getInstance = origGet;
        bookkeeping.setUnresolvedSellHandler(undefined);
    }
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
