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
}
main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
