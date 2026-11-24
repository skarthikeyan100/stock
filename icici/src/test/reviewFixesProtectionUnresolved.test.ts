/**
 * cancelProtection unregisters the exit watch and notifies BEFORE rethrowing a GTT delete failure; a parked Sell without a broker order id
 * is cleared when the Sell is later booked.
 * Run: node ./dist/test/reviewFixesProtectionUnresolved.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import * as exitMonitor from '../processes/order/exitMonitor';
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
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
