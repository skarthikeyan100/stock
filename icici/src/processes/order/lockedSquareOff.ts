import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import Kite from '../../kite/Kite';
import { Trade } from '../../model/model';
import { exchangeForTsym } from '../../util/underlyings';
import { markNotPlaced } from '../../util/notPlaced';
import { NFO_TICK_SIZE } from '../../util/tick';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { TRACKERS } from './pendingTrackers';
import { getExecutorByBroker } from './brokerExecutors';
import { BrokerExecutor, OrderAlreadyFilledError, cancelRestingSellsAheadOfExit, waitUntilNotResting, withSellLock } from './BrokerExecutor';
import { defaultFreezeQty, squareOffLimitChunked } from './chunkedOrder';
import { gttIdsOf, forgetGttIds, pollGttFills, persistGttTriggerId, isReprotecting, isGttGoneError, settleGtts } from './kiteExecutor';
import { placeLimitSellBareOnAnt } from './antExecutor';
import { LockedBroker, isLockedBroker, registerLockedOrder, kickPoll, notifyUser } from './lockedOrders';

// A frontend user's square-off at the price they clicked: a resting LIMIT sell of the position at that price (rounded UP to the tick, so it never
// sells below what was shown). Never short, never sold twice:
//  - one exit operation per position at a time (bookkeeping.pendingSquareOffs, the key the market exits use too);
//  - a Kite GTT is deleted and confirmed gone BEFORE the sell is placed (a GTT bypasses the never-short guard: left live beside a resting sell it
//    could sell the position a second time); the in-app exit monitor holds the same target / stop meanwhile, and a stop or target it hits cancels
//    the resting sell first and then sells, exactly as every other exit does;
//  - a sell already resting for the position is cancelled with a fill re-check before the new one is placed (a second click re-prices);
//  - the broker executors' own never-short guard still applies to the new sell.
// When the sell ends without closing the position (cancelled, rejected, expired), sweepUserExits puts the Kite GTT back; until then the in-app
// monitor protects it. State is durable (Mongo `userExitSells`, one row per user + broker + contract).
// Only the square-off click uses this. Stops, targets, end-of-day, drawdown and max-profit exits are unchanged.

const COLLECTION = 'userExitSells';
const col = () => Mongo.getInstance()?.db?.collection(COLLECTION);
const today = () => new Date().toLocaleDateString('en-CA');

interface ExitRow { userId: string; broker: LockedBroker; tsym: string; token: string; day: string; hadGtt: boolean; orders: { orderId: string; quantity: number; price: number }[]; attempts?: number }

/** The lowest tick at or above `price`: a sell never asks less than the price shown. */
export function ceilToTick(price: number): number {
    return Math.round(Math.ceil(price / NFO_TICK_SIZE - 1e-6) * NFO_TICK_SIZE * 100) / 100;
}

export interface LockedSellResult {
    broker: string; tsym: string; ok: boolean; quantity: number; limitPrice: number; orderIds: string[]; error?: string;
    /** Nothing was left to sell (a target / stop, a fired GTT or an earlier sell had closed it). */
    closed?: boolean;
}

const refuse = (message: string): Error => markNotPlaced(new Error(message));
const keyOf = (broker: string, userId: string, tsym: string) => `${broker}:${userId}:${tsym}`;
const filterOf = (userId: string, broker: string, tsym: string) => ({ userId, broker, tsym });

async function saveRecord(userId: string, broker: LockedBroker, row: Trade, set: Partial<ExitRow>, push: ExitRow['orders'] = []): Promise<void> {
    const c = col();
    if (!c) throw new Error('Mongo not connected');
    await c.updateOne(filterOf(userId, broker, row.tsym), {
        $set: { token: String(row.token), day: today(), updatedAt: new Date(), ...set },
        ...(push.length > 0 ? { $push: { orders: { $each: push } } as any } : {}),
        ...(set.hadGtt === undefined ? { $setOnInsert: { hadGtt: false } } : {}),
    }, { upsert: true });
}

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

// Deletes every GTT of the position and confirms it, so none can sell beside the resting sell. Returns 'closed' when a GTT had already sold it.
// Throws (nothing sold) when a GTT has triggered or cannot be deleted; the position keeps a protection either way.
async function removeGtts(userId: string, row: Trade): Promise<'closed' | 'done'> {
    const mayHaveGtt = gttIdsOf(row).length > 0 || (bookkeeping.getUserUseGTT(userId) && (row.targetPrice != null || row.stopLossPrice != null));
    if (!mayHaveGtt) return 'done';
    try { await settleGtts(row.tsym); } catch (e: any) { throw refuse(`The Kite GTT of ${row.tsym} could not be checked - square off not placed, the position is unchanged (${e?.message ?? e})`); }
    if (!bookkeeping.trades.includes(row) || !(row.quantity > 0)) return 'closed';
    if (isReprotecting(userId, row.tsym)) throw refuse(`The target / stop of ${row.tsym} is being updated - try again in a few seconds`);
    const ids = gttIdsOf(row);
    if (ids.length === 0) return 'done';
    const kite = Kite.getInstance();
    let book: any[];
    try { book = await kite.getGTTs(); } catch (e: any) { throw refuse(`The Kite GTT of ${row.tsym} could not be read - square off not placed, the position is unchanged (${e?.message ?? e})`); }
    const triggered = (list: any[]) => ids.some((id) => list.find((g) => g.id === id)?.status === 'triggered');
    const fired = () => { void pollGttFills(); return refuse(`The target / stop of ${row.tsym} has just triggered at Kite and is selling the position - square off not placed`); };
    if (triggered(book)) throw fired();
    // The levels the in-app monitor takes over: those the live GTTs enforce now, none of which the current price has crossed. The row alone can
    // carry an earlier lot's level that the price is already past (its GTT fired), which the monitor would sell at once.
    const levels = handoverLevels(row, ids.map((id) => book.find((g) => g.id === id)).filter((g) => g?.status === 'active'));
    if (levels.stop !== undefined) row.stopLossPrice = levels.stop;
    if (levels.target !== undefined) row.targetPrice = levels.target;
    // Kept on the Buy documents too: a restart while the sell rests must restore the position with its target / stop.
    if (levels.stop !== undefined || levels.target !== undefined) {
        await Mongo.getInstance()?.db?.collection('Trade').updateMany({ user: userId, tsym: row.tsym, action: 'Buy', gttTriggerId: { $in: ids } }, { $set: { ...(row.stopLossPrice != null ? { stopLossPrice: row.stopLossPrice } : {}), ...(row.targetPrice != null ? { targetPrice: row.targetPrice } : {}) } })
            .catch((e) => Log.log(`[order] could not store the target / stop of ${row.tsym} (${userId}):`, e));
    }
    await saveRecord(userId, 'kite', row, { hadGtt: true, attempts: 0 });
    // Lots whose GTT is deleted while another one stays (or has just fired) are covered by an in-app hard stop on the whole position.
    const coverByHardStop = () => {
        if (row.stopLossPrice != null) row.hardStopPrice = Math.max(row.hardStopPrice ?? 0, row.stopLossPrice);
        if (row.token) exitMonitor.registerTrade(row, exchangeForTsym(row.tsym), 'kite', true);
    };
    const gone: number[] = [];
    let failed: number[] = [];
    for (const id of ids) {
        try { await kite.deleteGTT(id); gone.push(id); }
        catch (e) { if (isGttGoneError(e)) gone.push(id); else failed.push(id); }
    }
    let after: any[] | undefined;
    try { after = await kite.getGTTs(); } catch { after = undefined; }
    if (after) {
        const stillActive = failed.filter((id) => after!.find((g) => g.id === id)?.status === 'active');
        if (triggered(after)) { await forgetGttIds(row, gone.filter((id) => after!.find((g) => g.id === id)?.status !== 'triggered')); coverByHardStop(); throw fired(); }
        for (const id of failed) if (!stillActive.includes(id)) gone.push(id);
        failed = stillActive;
    }
    await forgetGttIds(row, gone);
    if (failed.length > 0) {
        coverByHardStop();
        throw refuse(`The Kite GTT of ${row.tsym} could not be cancelled - square off not placed, the position stays protected`);
    }
    return 'done';
}

function sellExecutor(broker: LockedBroker, row: Trade): BrokerExecutor {
    const base = getExecutorByBroker(broker);
    // An ANT exit must be placed under the entry's product, or it opens a new position instead of closing.
    if (broker !== 'ant' || !row.product) return base;
    return { ...base, squareOffLimit: (userId, tsym, token, quantity, exchange, price) => withSellLock('ant', userId, tsym, () => placeLimitSellBareOnAnt(userId, tsym, token, quantity, price, exchange as 'NFO' | 'BFO', row.product)) };
}

async function sellRowAtPrice(userId: string, row: Trade, price: number, requested: number | undefined): Promise<LockedSellResult> {
    const brokerName = row.broker ?? 'kite';
    if (!isLockedBroker(brokerName)) throw refuse(`A square-off at a locked price is not supported on ${brokerName} - use "Sell at market"`);
    const broker = brokerName;
    const tsym = row.tsym;
    if (broker === 'ant' && row.antOrderNo) throw refuse(`${tsym} is an ANT bracket position: its exit lives at the broker, so it cannot be sold at a chosen price - use "Sell at market"`);
    if (!row.token) throw refuse(`${tsym} has no instrument token - use "Sell at market"`);
    const key = keyOf(broker, userId, tsym);
    if (bookkeeping.pendingSquareOffs.has(key) || (broker === 'kite' && isReprotecting(userId, tsym))) throw refuse(`A sell or a target / stop change of ${tsym} is already in progress - try again in a few seconds`);
    bookkeeping.pendingSquareOffs.add(key);
    const result: LockedSellResult = { broker, tsym, ok: true, quantity: 0, limitPrice: price, orderIds: [] };
    const open = () => (bookkeeping.trades.includes(row) ? Math.max(0, row.quantity) : 0);
    const exchange = exchangeForTsym(tsym);
    try {
        if (broker === 'kite' && (await removeGtts(userId, row)) === 'closed') return { ...result, closed: true };
        if (!(open() > 0)) return { ...result, closed: true };
        // From here until the sell is booked, the in-app monitor is the exit (it cancels the resting sell before it sells).
        if (row.targetPrice != null || row.stopLossPrice != null) exitMonitor.registerTrade(row, exchange, broker, false);
        await saveRecord(userId, broker, row, {});
        const executor = sellExecutor(broker, row);
        const raced: string[] = [];
        const settled = await cancelRestingSellsAheadOfExit({
            pending: executor.findPendingOrders(userId, tsym),
            cancel: async (orderId, ex) => {
                try { await executor.cancelOrder(orderId, ex); }
                catch (e) { if (e instanceof OrderAlreadyFilledError) raced.push(orderId); throw e; }
            },
            openQuantity: () => open(),
            requested: Math.min(requested ?? open(), open()),
            label: `square-off at ${price} of ${tsym} (${userId})`,
        });
        const stillTracked = executor.findPendingOrders(userId, tsym).filter((o) => o.action === 'Sell').map((o) => o.orderId);
        if (raced.length > 0 || stillTracked.length > 0) {
            kickPoll(broker);
            // Until the old order's fill / cancel is booked the guard still counts it as resting and would refuse the new sell.
            await waitUntilNotResting(() => executor.findPendingOrders(userId, tsym), stillTracked, `${tsym} (${userId})`);
        }
        const quantity = Math.min(settled.quantity, open());
        if (!(quantity > 0)) return { ...result, closed: true };
        // Lists the new order(s) for the trading page and stores them (the record is what restores the protection later).
        const record = async (orderIds: string[]): Promise<void> => {
            const orders = orderIds.map((orderId) => {
                const tracked = executor.findPendingOrders(userId, tsym).find((o) => o.orderId === orderId);
                const each = tracked?.quantity ?? Math.min(quantity, defaultFreezeQty(tsym, exchange));
                registerLockedOrder({ orderId, broker, userId, action: 'Sell', tsym, token: String(row.token), exchange, quantity: each, price, placedAt: Date.now() });
                return { orderId, quantity: each, price };
            });
            await saveRecord(userId, broker, row, {}, orders).catch((e) => Log.log(`[order] ALERT: could not record the resting sell of ${tsym} (${userId}):`, e));
        };
        try {
            const placed = await squareOffLimitChunked(executor, userId, tsym, String(row.token), quantity, exchange, price);
            result.orderIds = placed.orderIds;
            result.quantity = placed.placedQuantity;
            if (placed.placedQuantity < quantity) result.error = `only ${placed.placedQuantity} of ${quantity} could be placed (never-short guard)`;
        } catch (e: any) {
            const ids: string[] = Array.isArray(e?.orderIds) ? e.orderIds : [];
            if (ids.length === 0) throw e;
            result.orderIds = ids;
            result.quantity = Number(e.placedQuantity) || 0;
            result.error = e.message;
        }
        await record(result.orderIds);
        // A GTT attached while the sell was being placed (a buy that filled meanwhile) sells its own lot only, but re-check the whole position:
        // together with the resting sell it must not exceed what is held.
        if (broker === 'kite' && gttIdsOf(row).length > 0 && result.quantity >= open()) await removeGtts(userId, row).catch((e) => Log.log(`[order] ALERT: ${tsym} (${userId}) has a GTT beside its resting sell and it could not be removed - check Kite:`, e));
        Log.log(`[order] square-off at the clicked price: ${tsym} qty=${result.quantity} @ ${price} for ${userId} on ${broker} resting as ${result.orderIds.join(',')}`);
        return result;
    } finally {
        bookkeeping.pendingSquareOffs.delete(key);
        kickPoll(broker);
    }
}

/** Places the limit sell(s) for the user's open row(s) of `token` (one per broker; `broker` limits it to that one). A failing row does not stop the others. */
export async function squareOffAtPrice(userId: string, p: { token: string; broker?: string; price: number; quantity?: number }): Promise<{ results: LockedSellResult[] }> {
    const asked = Number(p.price);
    if (!(Number.isFinite(asked) && asked > 0)) throw refuse('no usable price for this square-off - not placed');
    const price = ceilToTick(asked);
    const rows = bookkeeping.trades.filter((t) => t.user === userId && t.token === String(p.token) && t.quantity > 0 && (!p.broker || (t.broker ?? 'kite') === p.broker));
    if (rows.length === 0) throw refuse('No open position found for this square-off');
    const results: LockedSellResult[] = [];
    for (const row of rows) {
        try {
            results.push(await sellRowAtPrice(userId, row, price, p.quantity));
        } catch (e: any) {
            if (rows.length === 1) throw e;
            results.push({ broker: row.broker ?? 'kite', tsym: row.tsym, ok: false, quantity: 0, limitPrice: price, orderIds: [], error: e?.message ?? String(e) });
        }
    }
    return { results };
}

// ---- After the sell ----------------------------------------------------------------------------------------------------------------------------

// Two passes at least this far apart must find no resting sell before protection is put back: an exit that has just cancelled the sell to place its
// own (a stop, a force-close, lock-profits) needs those seconds.
export const RESTORE_AFTER_MS = 8_000;
const RESTORE_ATTEMPTS = 3;
const nothingRestingSince = new Map<string, number>();

async function restoreGtt(record: ExitRow, row: Trade): Promise<boolean> {
    const exchange = exchangeForTsym(row.tsym);
    const stop = Number(row.stopLossPrice);
    const target = Number(row.targetPrice);
    const last = row.lastTradePrice > 0 ? row.lastTradePrice : row.price;
    const quantity = row.quantity;
    if (quantity > defaultFreezeQty(row.tsym, exchange) || !(stop > 0 && stop < last && last < target)) return true; // stays with the in-app monitor
    // No GTT on a position the broker does not hold (sold outside the platform, say): it would open a short when it triggered. The in-app monitor,
    // whose sell the never-short guard checks, stays the exit.
    const sellable = await Kite.getInstance().getSellableQuantity(row.tsym);
    if (sellable < quantity) {
        Log.log(`[order] ALERT: ${row.tsym} (${record.userId}): no GTT restored - Kite shows ${sellable} sellable, the books hold ${quantity}`);
        return true;
    }
    const id = await Kite.getInstance().placeTargetStopLossGTT(row.tsym, exchange, quantity, stop, target - stop, 0, last);
    if (!bookkeeping.trades.includes(row) || row.quantity !== quantity || gttIdsOf(row).length > 0) {
        await Kite.getInstance().deleteGTT(id).catch((e) => Log.log(`[order] ALERT: GTT ${id} of ${row.tsym} (${record.userId}) is stale and could NOT be deleted - delete it by hand in Kite:`, e));
        return false;
    }
    row.gttTriggerId = id;
    row.hardStopPrice = undefined;
    persistGttTriggerId(row);
    exitMonitor.registerTrade(row, exchange, 'kite', true);
    bookkeeping.notifyTargetStopLossChanged();
    Log.log(`[order] ${row.tsym} (${record.userId}): the limit sell is gone and the position is open - GTT ${id} restored for ${quantity}, stop ${stop} target ${target}`);
    return true;
}

export async function sweepUserExits(now: number = Date.now()): Promise<void> {
    const c = col();
    if (!c) return;
    const records = (await c.find({}).toArray()) as unknown as ExitRow[];
    for (const r of records) {
        const filter = filterOf(r.userId, r.broker, r.tsym);
        if (r.day !== today()) { await c.deleteOne(filter); continue; } // a day order does not outlive its day; the position is restored with the in-app monitor
        const key = keyOf(r.broker, r.userId, r.tsym);
        if (bookkeeping.pendingSquareOffs.has(key)) { nothingRestingSince.delete(key); continue; }
        const row = bookkeeping.trades.find((t) => t.user === r.userId && t.tsym === r.tsym && (t.broker ?? 'kite') === r.broker && t.quantity > 0);
        if (!row) continue; // not restored yet after a restart, or closed (onExitFill removes the record)
        if (TRACKERS[r.broker].find(r.userId, r.tsym).some((o) => o.action === 'Sell')) {
            nothingRestingSince.delete(key);
            // A broker exit attached beside the resting sell (a later buy) makes the monitor watch-only: the earlier quantity keeps a hard stop.
            if (gttIdsOf(row).length > 0 && row.stopLossPrice != null && row.hardStopPrice == null) {
                row.hardStopPrice = row.stopLossPrice;
                exitMonitor.registerTrade(row, exchangeForTsym(row.tsym), r.broker, true);
            }
            continue;
        }
        const since = nothingRestingSince.get(key);
        if (since === undefined) { nothingRestingSince.set(key, now); continue; }
        if (now - since < RESTORE_AFTER_MS) continue;
        if (r.broker === 'kite' && r.hadGtt && gttIdsOf(row).length === 0 && bookkeeping.getUserUseGTT(r.userId)) {
            bookkeeping.pendingSquareOffs.add(key);
            try {
                if (!(await restoreGtt(r, row))) continue;
            } catch (e) {
                const attempts = (r.attempts ?? 0) + 1;
                Log.log(`[order] ALERT: restoring the GTT of ${r.tsym} (${r.userId}) failed (${attempts}/${RESTORE_ATTEMPTS}) - the in-app monitor protects the position:`, (e as any)?.message ?? e);
                if (attempts < RESTORE_ATTEMPTS) { await c.updateOne(filter, { $set: { attempts } }); continue; }
            } finally {
                bookkeeping.pendingSquareOffs.delete(key);
            }
        }
        nothingRestingSince.delete(key);
        await c.deleteOne(filter);
        const protection = gttIdsOf(row).length > 0 ? 'Its target / stop is back at the broker.' : row.targetPrice != null || row.stopLossPrice != null ? 'The platform watches its target / stop.' : 'It has no target / stop.';
        if ((r.orders ?? []).length > 0) notifyUser(r.userId, `Your limit sell of ${r.tsym} is no longer resting and ${row.quantity} is still open. ${protection}`);
    }
}

/** bookkeeping.onFill listener: a Sell that closed the position ends its record. */
export function onExitFill(userId: string, trade: Trade): void {
    if (trade.action !== 'Sell') return;
    const broker = trade.broker ?? 'kite';
    if (bookkeeping.trades.some((t) => t.user === userId && t.tsym === trade.tsym && (t.broker ?? 'kite') === broker && t.quantity > 0)) return;
    nothingRestingSince.delete(keyOf(broker, userId, trade.tsym));
    col()?.deleteOne(filterOf(userId, broker, trade.tsym)).catch((e) => Log.log('[order] userExitSells cleanup failed:', e));
}

/** Startup (after the pending-order trackers are loaded): resting square-off sells are listed again. */
export async function loadUserExits(): Promise<void> {
    const c = col();
    if (!c) return;
    const records = (await c.find({ day: today() }).toArray()) as unknown as ExitRow[];
    for (const r of records) {
        for (const o of r.orders ?? []) {
            const tracked = TRACKERS[r.broker].find(r.userId, r.tsym).find((t) => t.orderId === o.orderId);
            if (tracked) registerLockedOrder({ orderId: o.orderId, broker: r.broker, userId: r.userId, action: 'Sell', tsym: r.tsym, token: r.token, exchange: tracked.exchange, quantity: tracked.quantity, price: o.price, placedAt: Date.now() });
        }
    }
}
