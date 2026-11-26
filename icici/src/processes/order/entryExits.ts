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
    userId: string; orderId: string; tsym: string; token: string; exchange: 'NFO' | 'BFO'; broker: 'kite' | 'ant' | 'breeze';
    targetPrice: number; stopLossPrice: number; day: string; createdAt: Date;
    /** A frontend buy at the locked (clicked) price (order/lockedEntry.ts): protected lot by lot by the registered lot protector, not by attachProtection.
     *  targetPrice / stopLossPrice are 0 when that side is not set. */
    lot?: boolean;
    quantity?: number;
    limitPrice?: number;
    targetPoints?: number;
    stopPoints?: number;
    /** One of several orders of a buy above the freeze quantity: exits are watched in-app on the whole position. */
    inAppExit?: boolean;
    clickId?: string;
    /** The admin's mirror of a user's resting entry: the user and click it copies (cancelled together). */
    mirrorOf?: { userId: string; clickId: string };
}
const col = () => Mongo.getInstance()?.db?.collection('entryExits');
const today = () => new Date().toLocaleDateString('en-CA');

export async function registerEntryExit(row: Omit<EntryExit, 'day' | 'createdAt'>): Promise<void> {
    const c = col();
    if (!c) throw new Error('Mongo not connected - the target/stop of the resting entry could not be recorded, so it is not placed');
    await c.insertOne({ ...row, day: today(), createdAt: new Date() });
}

type LotProtector = (userId: string, trade: Trade, row: EntryExit) => Promise<void>;
let lotProtector: LotProtector | undefined;
/** Wired by order/lockedEntry.ts (it imports the executors, which import this module). */
export function registerLotProtector(fn: LotProtector): void { lotProtector = fn; }

// A fill and the cancel of the same order's remainder arrive back to back (a partly filled entry that is then cancelled). They are handled one after
// the other, fill first, so the cancel cannot delete the row before the fill has claimed it (which would leave the filled part without its exits).
const perOrder = new Map<string, Promise<void>>();
function serialized(orderId: string, fn: () => Promise<void>): Promise<void> {
    const run = (perOrder.get(orderId) ?? Promise.resolve()).then(fn, fn);
    perOrder.set(orderId, run);
    const done = () => { if (perOrder.get(orderId) === run) perOrder.delete(orderId); };
    run.then(done, done);
    return run;
}

/** bookkeeping.onFill listener: a filled resting entry gets its target and stop. Claims the row first (delete), so a repeated fill event attaches once. */
export function onEntryFill(userId: string, trade: Trade): Promise<void> {
    if (trade.action !== 'Buy' || !trade.brokerOrderId) return Promise.resolve();
    return serialized(String(trade.brokerOrderId), () => attachOnFill(userId, trade));
}

async function attachOnFill(userId: string, trade: Trade): Promise<void> {
    const c = col();
    if (!c) return;
    try {
        const row = (await c.findOne({ userId, orderId: String(trade.brokerOrderId), ...(trade.broker ? { broker: trade.broker } : {}) })) as EntryExit | null;
        if (!row) return;
        if ((await c.deleteOne({ userId, orderId: row.orderId })).deletedCount !== 1) return; // another event claimed it
        if (row.lot) {
            if (!lotProtector) throw new Error('no lot protector registered');
            await lotProtector(userId, trade, row);
            return;
        }
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
export function onEntryCancelled(userId: string, orderId: string): Promise<void> {
    return serialized(String(orderId), async () => {
        try { await col()?.deleteOne({ userId, orderId }); } catch (e) { Log.log('[order] entryExits cleanup failed:', e); }
    });
}

/** Today's rows of the locked-price entries (startup: their reservations and the pending-order list are rebuilt from them). */
export async function lotEntriesOfToday(): Promise<EntryExit[]> {
    const c = col();
    if (!c) return [];
    return (await c.find({ day: today(), lot: true }).toArray()) as unknown as EntryExit[];
}
