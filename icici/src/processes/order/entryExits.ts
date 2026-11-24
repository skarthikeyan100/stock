import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import { attachProtection } from './attachProtection';

// Resting limit ENTRIES with a target and stop-loss to attach once they fill (a contractor's approved recommendation, and the admin's mirror of it).
// A plain manualBuy waits about a minute for its fill and then cancels, which is wrong for "buy at the recommended price": that order must be
// allowed to rest. The entry is placed as a tracked pending limit buy (pendingLimitOrders.ts: persisted in Mongo, polled, its fill booked even after a
// restart) and the exits wait here, in Mongo `entryExits` (one row per resting order). When the fill is booked (bookkeeping.onFill) the row is
// claimed and attachProtection puts the target/stop on the position: a broker GTT on Kite, the in-app exit monitor otherwise. Not an in-memory control:
// the row is durable, so a restart between placement and fill still protects the position. An order the broker never fills (day order, expires at the
// close) leaves a row that onEntryCancelled removes, or that is ignored once its day is over.

export interface EntryExit {
    userId: string; orderId: string; tsym: string; token: string; exchange: 'NFO' | 'BFO'; broker: 'kite' | 'ant';
    targetPrice: number; stopLossPrice: number; day: string; createdAt: Date;
}
const col = () => Mongo.getInstance()?.db?.collection('entryExits');
const today = () => new Date().toLocaleDateString('en-CA');

export async function registerEntryExit(row: Omit<EntryExit, 'day' | 'createdAt'>): Promise<void> {
    const c = col();
    if (!c) throw new Error('Mongo not connected - the target/stop of the resting entry could not be recorded, so it is not placed');
    await c.insertOne({ ...row, day: today(), createdAt: new Date() });
}

/** bookkeeping.onFill listener: a filled resting entry gets its target and stop. Claims the row first (delete), so a repeated fill event attaches once. */
export async function onEntryFill(userId: string, trade: Trade): Promise<void> {
    if (trade.action !== 'Buy' || !trade.brokerOrderId) return;
    const c = col();
    if (!c) return;
    try {
        const row = (await c.findOne({ userId, orderId: String(trade.brokerOrderId) })) as EntryExit | null;
        if (!row) return;
        if ((await c.deleteOne({ userId, orderId: row.orderId })).deletedCount !== 1) return; // another event claimed it
        // The row is already claimed, so a transient failure (Mongo/GTT call) would lose the exits for good: retry a few times first.
        let r: Awaited<ReturnType<typeof attachProtection>> | undefined;
        for (let attempt = 1; !r; attempt++) {
            try { r = await attachProtection(userId, row.broker, row.tsym, row.targetPrice, row.stopLossPrice); }
            catch (err) {
                if (attempt >= 3) throw err;
                Log.log(`[order] resting entry ${row.tsym} (${userId}): attaching target/stop failed (attempt ${attempt}/3), retrying in 5s:`, (err as any)?.message ?? err);
                await new Promise((res) => setTimeout(res, 5000));
            }
        }
        Log.log(`[order] resting entry ${row.tsym} (${userId}) filled at ${trade.price}: target ${row.targetPrice} / stop ${row.stopLossPrice} attached (${r.mode})`);
    } catch (e) {
        Log.log(`[order] ALERT: resting entry ${trade.tsym} (${userId}) filled at ${trade.price} but its target/stop could NOT be attached - the position has no exit:`, e);
    }
}

/** A resting entry that ended without a fill (cancelled, rejected, expired at the close): its exits are no longer wanted. */
export async function onEntryCancelled(userId: string, orderId: string): Promise<void> {
    try { await col()?.deleteOne({ userId, orderId }); } catch (e) { Log.log('[order] entryExits cleanup failed:', e); }
}
