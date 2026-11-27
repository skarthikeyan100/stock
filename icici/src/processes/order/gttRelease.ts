import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import Kite from '../../kite/Kite';
import { Trade } from '../../model/model';
import { exchangeForTsym } from '../../util/underlyings';
import { markNotPlaced } from '../../util/notPlaced';
import { acquireKeyLock } from '../../util/keyedLock';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { findPendingOrdersForSymbol } from './pendingLimitOrders';
import { gttIdsOf, forgetGttIds, pollGttFills, isReprotecting, isGttGoneError, settleGtts } from './kiteExecutor';

// A Kite GTT bypasses the never-short guard: live beside a platform sell of the same position it can sell the quantity a second time (live
// 2026-11-27 10:18:03-10:18:11: the max-profit lock sell rested for 8 s while GTT 346629657 stayed active). The rule, for EVERY platform sell
// on Kite (market exits, resting limit sells, max-profit locks, lock-profits, square-offs, end of day):
//  - the position's GTTs are deleted and confirmed gone BEFORE the sell is placed; a GTT that cannot be removed refuses the sell (the GTT stays
//    the protection, the caller retries);
//  - from then on the in-app exit monitor holds the same target / stop (a hit cancels the resting sell first, then sells);
//  - no GTT is placed while a platform sell of the position is open (kiteSellBusy), under the same per-position lock (withGttSellLock);
//  - when the sell ends without closing the position, lockedSquareOff.sweepUserExits puts the GTT back (durable record, Mongo `userExitSells`).
// The kiteExecutor import is circular: nothing here may use it while the module is loading.

export const USER_EXITS_COLLECTION = 'userExitSells';
export const userExitsCol = () => Mongo.getInstance()?.db?.collection(USER_EXITS_COLLECTION);
export const today = () => new Date().toLocaleDateString('en-CA');

export interface ExitRow { userId: string; broker: 'kite' | 'ant' | 'breeze'; tsym: string; token: string; day: string; hadGtt: boolean; orders: { orderId: string; quantity: number; price: number }[]; attempts?: number }

const refuse = (message: string): Error => markNotPlaced(new Error(message));

export async function saveExitRecord(userId: string, broker: ExitRow['broker'], row: Trade, set: Partial<ExitRow>, push: ExitRow['orders'] = []): Promise<void> {
    const c = userExitsCol();
    if (!c) throw new Error('Mongo not connected');
    await c.updateOne({ userId, broker, tsym: row.tsym }, {
        $set: { token: String(row.token), day: today(), updatedAt: new Date(), ...set },
        ...(push.length > 0 ? { $push: { orders: { $each: push } } as any } : {}),
        ...(set.hadGtt === undefined ? { $setOnInsert: { hadGtt: false } } : {}),
    }, { upsert: true });
}

// ---- Sells and GTT placements of one position, one at a time ----------------------------------------------------------------------------------

const sellingNow = new Map<string, number>(); // platform sells in flight that are not (yet) on the pending-order tracker; this process only
const keyOf = (userId: string, tsym: string) => `${userId}:${tsym}`;

/** Held while a sell removes the GTTs and is placed, and while a GTT is placed. Not re-entrant. Returns the release function. */
export function acquireGttSellLock(userId: string, tsym: string): Promise<() => void> {
    return acquireKeyLock(`gttsell:${keyOf(userId, tsym)}`);
}

export async function withGttSellLock<T>(userId: string, tsym: string, fn: () => Promise<T>): Promise<T> {
    const release = await acquireGttSellLock(userId, tsym);
    try { return await fn(); } finally { release(); }
}

/** Marks a sell that waits for its own fill (never on the pending tracker) as open; call the returned function when it has ended. */
export function markKiteSelling(userId: string, tsym: string): () => void {
    const key = keyOf(userId, tsym);
    sellingNow.set(key, (sellingNow.get(key) ?? 0) + 1);
    return () => {
        const n = (sellingNow.get(key) ?? 1) - 1;
        if (n > 0) sellingNow.set(key, n); else sellingNow.delete(key);
    };
}

/** A platform sell of the position is resting or in flight. */
export function kiteSellOpen(userId: string, tsym: string): boolean {
    return sellingNow.has(keyOf(userId, tsym)) || findPendingOrdersForSymbol(userId, tsym).some((o) => o.action === 'Sell');
}

/** kiteSellOpen, or an exit operation of the position is running: no GTT may be placed now. */
export function kiteSellBusy(userId: string, tsym: string): boolean {
    return bookkeeping.pendingSquareOffs.has(`kite:${userId}:${tsym}`) || kiteSellOpen(userId, tsym);
}

// ---- Removing the GTTs -------------------------------------------------------------------------------------------------------------------------

/** Tightest stop and nearest target among the active GTTs and the row's own levels that the last price has not crossed. */
export function handoverLevels(row: { lastTradePrice?: number; price: number; stopLossPrice?: number; targetPrice?: number }, activeGtts: any[]): { stop?: number; target?: number } {
    const pairs: number[][] = activeGtts.map((g) => (g?.condition?.trigger_values ?? []).map(Number).filter((n: number) => n > 0)).filter((v: number[]) => v.length === 2);
    if (pairs.length === 0) return {};
    const last = Number(row.lastTradePrice) > 0 ? Number(row.lastTradePrice) : row.price;
    const stops = pairs.map((v) => Math.min(...v));
    const targets = pairs.map((v) => Math.max(...v));
    if (row.stopLossPrice != null && row.stopLossPrice < last) stops.push(row.stopLossPrice);
    if (row.targetPrice != null && row.targetPrice > last) targets.push(row.targetPrice);
    return { stop: Math.max(...stops), target: Math.min(...targets) };
}

// What became of GTTs that have already triggered. Their sell order is an ordinary order the never-short guard counts once the order book shows
// it, so a platform sell may go ahead then. Returns the 'dead' ids (order refused / cancelled with nothing sold, or from an earlier day): they
// protect nothing any more. Throws when the order is not visible yet: selling now could sell the same quantity twice.
async function triggeredOutcome(ids: number[], book: any[], pending: () => Error): Promise<number[]> {
    let orders: any[] | undefined;
    const dead: number[] = [];
    for (const id of ids) {
        const gtt = book.find((g) => g.id === id);
        // Fired on an earlier day: whatever order it placed was a day order, none of it can still be open.
        if (gtt?.updated_at && String(gtt.updated_at).slice(0, 10) < today()) { dead.push(id); continue; }
        const results: any[] = (gtt?.orders ?? []).map((o: any) => o?.result?.order_result).filter(Boolean);
        if (results.length === 0) throw pending();
        const orderIds = results.map((r) => r.order_id).filter((x) => x != null && x !== '').map(String);
        if (orderIds.length === 0) {
            if (!results.every((r) => /fail|reject/i.test(String(r.status)))) throw pending();
            dead.push(id);
            continue;
        }
        if (!orders) {
            try { orders = (await Kite.getInstance().getKiteConnect().getOrders()) as any[]; } catch { throw pending(); }
        }
        const found = orderIds.map((orderId) => orders!.find((o) => String(o.order_id) === orderId));
        if (found.some((o) => !o)) throw pending();
        if (found.every((o) => ['REJECTED', 'CANCELLED'].includes(String(o.status).toUpperCase()) && !(Number(o.filled_quantity) > 0))) dead.push(id);
    }
    return dead;
}

/** 'closed': a fired GTT had already sold the position. 'removed': GTTs were taken off the row (the caller puts it on the in-app monitor). */
export type GttRemoval = 'closed' | 'removed' | 'none';

// Deletes every GTT of the position and confirms it, so none can sell beside a platform sell. Throws (nothing may be sold) when one cannot be
// removed; the position keeps a protection either way. `platformSell`: an exit of the platform's own (stop, end of day, max-profit lock ...) goes
// ahead past a GTT whose sell order is already in the order book, and past an unreadable GTT book when the row has no known GTT; the user's
// square-off click is refused instead. Call inside withGttSellLock.
export async function removeGtts(userId: string, row: Trade, opts: { platformSell?: boolean } = {}): Promise<GttRemoval> {
    const mayHaveGtt = gttIdsOf(row).length > 0 || (bookkeeping.getUserUseGTT(userId) && (row.targetPrice != null || row.stopLossPrice != null));
    if (!mayHaveGtt) return 'none';
    try { await settleGtts(row.tsym); } catch (e: any) {
        if (opts.platformSell && gttIdsOf(row).length === 0) { Log.log(`[order] GTT check of ${row.tsym} (${userId}) before a sell failed (no GTT is known for it):`, e?.message ?? e); return 'none'; }
        throw refuse(`The Kite GTT of ${row.tsym} could not be checked - square off not placed, the position is unchanged (${e?.message ?? e})`);
    }
    if (!bookkeeping.trades.includes(row) || !(row.quantity > 0)) return 'closed';
    // A re-protection's cancel phase may run beside a platform exit (its placement waits on the lock): refusing would delay a stop for its whole back-off.
    if (!opts.platformSell && isReprotecting(userId, row.tsym)) throw refuse(`The target / stop of ${row.tsym} is being updated - try again in a few seconds`);
    const ids = gttIdsOf(row);
    if (ids.length === 0) return 'none';
    const kite = Kite.getInstance();
    let book: any[];
    try { book = await kite.getGTTs(); } catch (e: any) { throw refuse(`The Kite GTT of ${row.tsym} could not be read - square off not placed, the position is unchanged (${e?.message ?? e})`); }
    const triggered = (list: any[], of: number[]) => of.filter((id) => list.find((g) => g.id === id)?.status === 'triggered');
    const fired = () => { void pollGttFills(); return refuse(`The target / stop of ${row.tsym} has just triggered at Kite and is selling the position - square off not placed`); };
    const spent = triggered(book, ids);
    let dead: number[] = [];
    if (spent.length > 0) {
        if (!opts.platformSell) throw fired();
        dead = await triggeredOutcome(spent, book, fired);
        void pollGttFills();
    }
    const toDelete = ids.filter((id) => !spent.includes(id));
    if (toDelete.length === 0 && dead.length === 0) return 'none';
    // The levels the in-app monitor takes over: those the live GTTs enforce now, none of which the current price has crossed. The row alone can
    // carry an earlier lot's level that the price is already past (its GTT fired), which the monitor would sell at once.
    const levels = handoverLevels(row, toDelete.map((id) => book.find((g) => g.id === id)).filter((g) => g?.status === 'active'));
    if (levels.stop !== undefined) row.stopLossPrice = levels.stop;
    if (levels.target !== undefined) row.targetPrice = levels.target;
    // Kept on the Buy documents too: a restart while the sell rests must restore the position with its target / stop.
    if (row.stopLossPrice != null || row.targetPrice != null) {
        await Mongo.getInstance()?.db?.collection('Trade').updateMany({ user: userId, tsym: row.tsym, action: 'Buy', gttTriggerId: { $in: ids } }, { $set: { ...(row.stopLossPrice != null ? { stopLossPrice: row.stopLossPrice } : {}), ...(row.targetPrice != null ? { targetPrice: row.targetPrice } : {}) } })
            .catch((e) => Log.log(`[order] could not store the target / stop of ${row.tsym} (${userId}):`, e));
    }
    try { await saveExitRecord(userId, 'kite', row, { hadGtt: true, attempts: 0 }); } catch (e) {
        if (!opts.platformSell) throw e;
        Log.log(`[order] ALERT: could not record the GTT removal of ${row.tsym} (${userId}) - it will not be put back if the sell dies; the in-app monitor protects the position:`, e);
    }
    if (dead.length > 0) {
        Log.log(`[order] ALERT: GTT(s) ${dead.join(',')} of ${row.tsym} (${userId}) triggered earlier and no sell of theirs can still fill (refused, cancelled or from an earlier day) - dropping them`);
        await forgetGttIds(row, dead);
    }
    // Lots whose GTT is deleted while another one stays (or has just fired) are covered by an in-app hard stop on the whole position. Registered
    // only when the hard stop rises: a retried exit must not reset the exit monitor's back-off every time.
    const coverByHardStop = () => {
        if (row.stopLossPrice == null || (row.hardStopPrice ?? 0) >= row.stopLossPrice) return;
        row.hardStopPrice = row.stopLossPrice;
        if (row.token) exitMonitor.registerTrade(row, exchangeForTsym(row.tsym), 'kite', true);
    };
    // A fired GTT whose sell is still unbooked stays on the row, which keeps the in-app monitor watch-only: the lots losing their GTT need the hard stop.
    if (spent.length > dead.length) coverByHardStop();
    const gone: number[] = [];
    let failed: number[] = [];
    for (const id of toDelete) {
        try { await kite.deleteGTT(id); gone.push(id); }
        catch (e) { if (isGttGoneError(e)) gone.push(id); else failed.push(id); }
    }
    let after: any[] | undefined;
    try { after = await kite.getGTTs(); } catch { after = undefined; }
    if (after) {
        const stillActive = failed.filter((id) => after!.find((g) => g.id === id)?.status === 'active');
        const firedNow = triggered(after, toDelete);
        if (firedNow.length > 0) { await forgetGttIds(row, gone.filter((id) => !firedNow.includes(id))); coverByHardStop(); throw fired(); }
        for (const id of failed) if (!stillActive.includes(id)) gone.push(id);
        failed = stillActive;
    }
    await forgetGttIds(row, gone);
    if (failed.length > 0) {
        coverByHardStop();
        throw refuse(`The Kite GTT of ${row.tsym} could not be cancelled - square off not placed, the position stays protected`);
    }
    if (gone.length > 0) Log.log(`[order] GTT(s) ${gone.join(',')} of ${row.tsym} (${userId}) removed ahead of a sell - the in-app monitor holds stop ${row.stopLossPrice ?? 'none'} / target ${row.targetPrice ?? 'none'}`);
    return 'removed';
}

/** Ahead of a platform sell: removes the GTTs of `userId`'s Kite position(s) in `tsym`. True when any was removed. Call inside withGttSellLock. */
export async function releaseGttsForSell(userId: string, tsym: string): Promise<boolean> {
    let removed = false;
    for (const row of bookkeeping.trades.filter((t) => t.user === userId && t.tsym === tsym && (t.broker ?? 'kite') === 'kite' && t.quantity > 0)) {
        if (!bookkeeping.trades.includes(row)) continue;
        if ((await removeGtts(userId, row, { platformSell: true })) === 'removed') removed = true;
    }
    return removed;
}

/** After releaseGttsForSell removed a GTT: the in-app exit monitor holds the target / stop of what is still open. */
export function watchInApp(userId: string, tsym: string): void {
    for (const row of bookkeeping.trades) {
        if (row.user !== userId || row.tsym !== tsym || (row.broker ?? 'kite') !== 'kite' || !(row.quantity > 0) || !row.token) continue;
        if (row.targetPrice == null && row.stopLossPrice == null) continue;
        exitMonitor.registerTrade(row, exchangeForTsym(row.tsym), 'kite', gttIdsOf(row).length > 0);
    }
}
