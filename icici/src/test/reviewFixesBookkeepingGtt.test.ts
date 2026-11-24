/**
 * Review fixes: unusable Sell price is not booked; cancelProtection releases extra GTTs and only unsets deleted ids; cancelAndRecheck second
 * read is best-effort; withSellLock chains later sells on the timed-out sell.
 * Run: node ./dist/test/reviewFixesBookkeepingGtt.test.js
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Kite from '../kite/Kite';
import Mongo from '../tools/mongo';
import { cancelProtection } from '../processes/order/attachProtection';
import { cancelAndRecheck, withSellLock, OrderAlreadyFilledError, setSellLockMaxWaitMsForTest } from '../processes/order/BrokerExecutor';

setSellLockMaxWaitMsForTest(300);

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fill = (action: string, tsym: string, qty: number, price: number, oid: string) => {
    const t = new Trade();
    Object.assign(t, { tsym, token: 'tok-' + tsym, quantity: qty, price, action, status: 'COMPLETE', user: 'RvUser', broker: 'kite', brokerOrderId: oid });
    return t;
};

async function main() {
    // 1. Sell with NaN price is not booked.
    await bookkeeping.recordFill(fill('Buy', 'NIFTYRV1', 65, 100, 'rvb1'));
    const pnlBefore = bookkeeping.userPnL.get('RvUser') || 0;
    await bookkeeping.recordFill(fill('Sell', 'NIFTYRV1', 65, NaN, 'rvs1'));
    const row = bookkeeping.trades.find((t) => t.tsym === 'NIFTYRV1' && t.user === 'RvUser');
    assert(!!row && row.quantity === 65, 'unpriced Sell leaves the position open');
    assert((bookkeeping.userPnL.get('RvUser') || 0) === pnlBefore, 'unpriced Sell does not touch userPnL');
    assert(bookkeeping.getUnresolvedFills().some((f) => f.brokerOrderId === 'rvs1'), 'unpriced Sell is listed as unresolved');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYRV1', 65, 110, 'rvs1'));
    assert(!bookkeeping.trades.some((t) => t.tsym === 'NIFTYRV1' && t.user === 'RvUser') && !bookkeeping.getUnresolvedFills().some((f) => f.brokerOrderId === 'rvs1'), 'redelivery with a real price books it and clears the unresolved entry');
    await bookkeeping.recordFill(fill('Buy', 'NIFTYRV2', 65, NaN, 'rvb2'));
    assert(bookkeeping.trades.find((t) => t.tsym === 'NIFTYRV2')?.price === 0, 'unpriced Buy is still tracked (at 0)');

    // 1b. Parked Sell: handler is asked once; stale ALERT after 15 min, repeated once per 15 min.
    const asked: string[] = [];
    bookkeeping.setUnresolvedSellHandler((b, t) => asked.push(`${b}|${t}`));
    await bookkeeping.recordFill(fill('Buy', 'NIFTYRV3', 65, 100, 'rvb3'));
    await bookkeeping.recordFill(fill('Sell', 'NIFTYRV3', 65, NaN, 'rvs3'));
    assert(asked.length === 1 && asked[0] === 'kite|NIFTYRV3', 'parked Sell asks the order process for a sync');
    const tNow = Date.now();
    assert(bookkeeping.alertStaleUnresolvedFills(tNow + 14 * 60_000).length === 0, 'no stale alert before 15 min');
    assert(bookkeeping.alertStaleUnresolvedFills(tNow + 16 * 60_000).length === 1, 'stale alert after 15 min');
    assert(bookkeeping.alertStaleUnresolvedFills(tNow + 20 * 60_000).length === 0, 'not repeated within 15 min');
    assert(bookkeeping.alertStaleUnresolvedFills(tNow + 32 * 60_000).length === 1, 'repeated after 15 min');
    await bookkeeping.recordFill(fill('Sell', 'NIFTYRV3', 65, 105, 'rvs3'));
    assert(bookkeeping.getUnresolvedFills().length === 0, 'booked fill leaves the unresolved list empty');
    bookkeeping.setUnresolvedSellHandler(undefined);

    // 2. cancelProtection
    const deleted: number[] = [];
    let failId = -1;
    (Kite.getInstance() as any).deleteGTT = async (id: number) => { if (id === failId) throw new Error('boom'); deleted.push(id); };
    const updates: any[] = [];
    (Mongo as any).getInstance = () => ({ db: { collection: () => ({ updateMany: async (q: any, u: any) => { updates.push(q); } }) } });
    const r = bookkeeping.trades.find((t) => t.tsym === 'NIFTYRV2')!;
    r.gttTriggerId = 11; r.extraGttTriggerIds = [12, 13];
    await cancelProtection('RvUser', 'kite', 'NIFTYRV2');
    assert(deleted.join() === '11,12,13', 'primary and extra GTTs are all deleted');
    assert(JSON.stringify(updates[0].gttTriggerId) === '{"$in":[11,12,13]}', 'Mongo unset is limited to the deleted ids');
    assert(r.gttTriggerId == null && r.extraGttTriggerIds == null, 'in-memory ids cleared');
    r.gttTriggerId = 21; r.extraGttTriggerIds = [22]; failId = 22; deleted.length = 0;
    let threw = false;
    try { await cancelProtection('RvUser', 'kite', 'NIFTYRV2'); } catch { threw = true; }
    assert(threw && r.gttTriggerId == null && (r.extraGttTriggerIds ?? []).join() === '22', 'failed extra delete throws and keeps that id');

    // 3. cancelAndRecheck
    let untracked = false;
    let n = 0;
    await cancelAndRecheck({ orderId: 'o1', label: 't', cancel: async () => {}, isFilled: async () => { if (++n === 2) throw new Error('net'); return { filledQuantity: 0, terminal: true }; }, untrack: () => { untracked = true; } });
    assert(untracked, 'second read failure after a clean cancel still untracks');
    n = 0; untracked = false;
    let err: any;
    try { await cancelAndRecheck({ orderId: 'o2', label: 't', cancel: async () => {}, isFilled: async () => ({ filledQuantity: ++n === 2 ? 5 : 0, terminal: true }), untrack: () => { untracked = true; } }); } catch (e) { err = e; }
    assert(err instanceof OrderAlreadyFilledError && !untracked, 'a late fill on the second read still propagates');
    err = undefined;
    try { await cancelAndRecheck({ orderId: 'o3', label: 't', cancel: async () => {}, isFilled: async () => { throw new Error('first'); }, untrack: () => {} }); } catch (e) { err = e; }
    assert(!!err && err.message === 'first', 'first read failure is still rethrown');

    // 4. withSellLock
    let release!: () => void;
    const stuck = withSellLock('kite', 'u', 'X', () => new Promise<void>((r) => { release = r; }));
    await sleep(10);
    const t0 = Date.now();
    const times: number[] = [];
    const s2 = withSellLock('kite', 'u', 'X', async () => { times.push(Date.now() - t0); });
    await s2; // waits ~300ms bound
    const t1 = Date.now();
    await withSellLock('kite', 'u', 'X', async () => {});
    assert(times[0] >= 250 && Date.now() - t1 < 150, `a sell after the timed-out one does not wait the bound again (${Date.now() - t1}ms)`);
    release(); await stuck;
}
main().then(() => process.exit(process.exitCode ?? 0));
