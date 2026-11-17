import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import bookkeeping from './bookkeeping';
import { OptionExchange } from './BrokerExecutor';
import { squareOffLimitChunked } from './chunkedOrder';
import { getBrokerExecutor } from './brokerExecutors';

// The LOCKED-PRICE sell of a max-profit trip (SimpleContinuousStrategy / ScaledHedgedStrategy / global max-profit) is owned by the ORDER process
// from the moment it is placed (user's rule 2026-11-17: "the goal is to sell at the locked price"; a locked sell that is cancelled leaves the
// position unmanaged). The strategy tags the placement (`locked: true`); every resting order id is recorded here, in Mongo `lockedSells`, so it
// survives a restart. When the broker cancels or rejects it (or a person cancels it in the broker app), the pending-order tracker reports it and
// this module re-places the remainder at the SAME price, whether or not any strategy is enabled: a disabled strategy takes no action, and none is
// needed. An explicit cancel by the platform itself (a strategy re-pricing, lock-profits, a force-close) is silenced in the tracker and never
// arrives here: that caller owns the follow-up. Not an in-memory control: the ledger is durable.
// Not re-placed: after the market close (the tracker skips listeners), a position that is no longer held (nothing sellable), and a chain that
// has already been re-placed MAX_REPLACEMENTS times (a price the broker keeps refusing: an ALERT, and the strategy is told as before).

export interface LockedSell {
    orderId: string; userId: string; broker: string; tsym: string; token: string; exchange: OptionExchange;
    price: number; replacements: number; day: string;
}
export const MAX_REPLACEMENTS = 5;
const PLACE_TRIES = 3;
const RETRY_DELAY_MS = 5_000;
const today = () => new Date().toLocaleDateString('en-CA');
const col = () => Mongo.getInstance()?.db?.collection('lockedSells');
const ledger = new Map<string, LockedSell>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function loadLockedSellsFromMongo(): Promise<void> {
    const c = col();
    if (!c) return;
    const rows = (await c.find({}).toArray()) as unknown as LockedSell[];
    for (const r of rows) {
        if (r.day !== today()) { void c.deleteOne({ orderId: r.orderId }).catch(() => undefined); continue; } // a day order does not outlive its day
        ledger.set(r.orderId, r);
    }
    if (ledger.size > 0) Log.log(`[order] lockedSells: restored ${ledger.size} locked-price sell(s) after restart`);
}

export function isLockedSell(orderId: string): boolean { return ledger.has(orderId); }

async function record(rows: LockedSell[]): Promise<void> {
    for (const r of rows) ledger.set(r.orderId, r);
    const c = col();
    if (!c) { Log.log('[order] ALERT: lockedSells: Mongo not connected - the locked sell is guarded until a restart only'); return; }
    for (const r of rows) await c.replaceOne({ orderId: r.orderId }, r, { upsert: true }).catch((e) => Log.log('[order] lockedSells: Mongo persist failed for', r.orderId, e));
}

/** Called right after a `locked` limit sell was placed: one ledger row per resting order. */
export async function recordLockedSells(userId: string, broker: string, tsym: string, token: string, exchange: OptionExchange, price: number, orderIds: string[], replacements = 0): Promise<void> {
    await record(orderIds.filter(Boolean).map((orderId) => ({ orderId: String(orderId), userId, broker, tsym, token, exchange, price, replacements, day: today() })));
}

function forget(orderId: string): void {
    ledger.delete(orderId);
    void col()?.deleteOne({ orderId }).catch((e) => Log.log('[order] lockedSells: Mongo delete failed for', orderId, e));
}

/**
 * A tracked resting order was cancelled or rejected for a reason the platform did not cause. Returns true when it was a locked sell and the
 * order side dealt with it (re-placed, or nothing left to sell), so the strategies are not told (their resting-sell bookkeeping stays right);
 * false when it is not a locked sell, or the re-placement could not be done (the listeners are then told as before).
 */
export async function onLockedSellCancelled(userId: string, tsym: string, quantity: number, action: 'Buy' | 'Sell', broker: string, orderId: string, reason: string, rejectReason?: string): Promise<boolean> {
    if (action !== 'Sell') return false;
    const row = ledger.get(orderId);
    if (!row) return false;
    forget(orderId); // exactly one handler per order id
    if (quantity <= 0) return true;
    if (row.replacements >= MAX_REPLACEMENTS) {
        Log.log(`[order] ALERT: locked sell ${tsym} (${userId}, ${broker}) @${row.price} was ${reason}${rejectReason ? ` (${rejectReason})` : ''} again after ${row.replacements} re-placements - NOT re-placed, the position may be unmanaged`);
        return false;
    }
    const heldBefore = bookkeeping.getOpenTrades(userId).filter((t) => t.tsym === tsym).reduce((s, t) => s + Math.max(0, Number(t.quantity) || 0), 0);
    if (heldBefore <= 0) { Log.log(`[order] lockedSells: ${tsym} (${userId}) ${reason} but the position is no longer open - nothing to re-place`); return true; }
    Log.log(`[order] lockedSells: locked sell ${orderId} ${tsym} (${userId}, ${broker}) @${row.price} was ${reason}${rejectReason ? ` (${rejectReason})` : ''} - re-placing ${quantity} at the locked price (replacement ${row.replacements + 1}/${MAX_REPLACEMENTS})`);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PLACE_TRIES; attempt++) {
        if (reason === 'REJECTED' || attempt > 1) await sleep(RETRY_DELAY_MS);
        try {
            const res = await squareOffLimitChunked(getBrokerExecutor(userId, broker as any), userId, tsym, row.token, quantity, row.exchange, row.price);
            await recordLockedSells(userId, broker, tsym, row.token, row.exchange, row.price, res.orderIds, row.replacements + 1);
            Log.log(`[order] lockedSells: re-placed ${res.placedQuantity}/${quantity} of ${tsym} (${userId}) @${row.price} as ${res.orderIds.join(',')}`);
            return true;
        } catch (e: any) {
            if (Array.isArray(e?.orderIds) && e.orderIds.length > 0) await recordLockedSells(userId, broker, tsym, row.token, row.exchange, row.price, e.orderIds, row.replacements + 1);
            if (/nothing sellable/.test(String(e?.message ?? e))) { Log.log(`[order] lockedSells: ${tsym} (${userId}) has nothing sellable after the ${reason} (closed, or another resting sell covers it) - nothing re-placed`); return true; }
            if (e?.partial) { Log.log(`[order] ALERT: lockedSells: re-placement of ${tsym} (${userId}) placed only part (${e.placedQuantity}/${quantity}):`, e); return true; }
            lastErr = e;
        }
    }
    Log.log(`[order] ALERT: lockedSells: could not re-place the locked sell of ${tsym} (${userId}, ${broker}) @${row.price} after ${PLACE_TRIES} tries - the position may be unmanaged:`, lastErr);
    return false;
}
