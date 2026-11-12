import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import configService from '../../prism/ConfigService';
import { toPercentNumber } from '../../prism/percentConfig';
import { primaryAdminEmail } from '../../user';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import { getBrokerExecutor } from './brokerExecutors';
import { setTargetStopLoss } from './kiteExecutor';

// Admin mirror trades. Every buy a user starts from the FRONTEND (orderProcess's 'manualBuy') is copied by the admin user as
// its own real order on the same broker, for floor(userLots * settings.mirrorPercentage / 100) lots (0 lots = no trade). The
// admin leg carries the same target/stop-loss points, so it exits on its own, and follows the user's sells proportionally
// (onUserSell) so the two legs never diverge. Strategy pseudo-users never mirror (they are not frontend trades) and the admin's
// own trades never mirror (no recursion).
//
// The admin order goes straight to the broker executor, NOT through placeOrderWithPendingGuard: the admin's own lot/investment/
// drawdown limits must not silently skip the mirror. The broker's own margin check still applies. A failed mirror never fails
// or delays the user's order - it is logged as an ALERT and no leg is recorded.
//
// State is durable (Mongo `mirrorLegs`, one row per user+token) so a restart keeps following the user's exits. Nothing here is an
// in-memory control: mirrorPercentage lives in config.yml and is read at the moment of each buy.

export interface MirrorLeg {
    userId: string;
    broker: 'kite' | 'ant';
    tsym: string;
    token: string;
    exchange: 'NFO' | 'BFO';
    /** The user's lot quantity (units) about to be bought. */
    quantity: number;
    /** Places the admin's order for `qty` units through the SAME executor path the user's buy takes. */
    place: (adminId: string, qty: number) => Promise<Trade>;
}
/** Returns a promise that settles when the mirror attempt is over (never rejects), or nothing when no mirror was started. */
export type MirrorHook = (leg: MirrorLeg) => Promise<void> | void;

const COLLECTION = 'mirrorLegs';
interface MirrorRow { userId: string; token: string; tsym: string; broker: 'kite' | 'ant'; exchange: 'NFO' | 'BFO'; adminQty: number }

/** Mirror percentage from config.yml, clamped to 0-100; absent or unparseable = 0 (no mirror). */
export function mirrorPercentage(): number {
    const n = toPercentNumber((configService.getConfig().settings as any)?.mirrorPercentage);
    return n !== null && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** Units the admin mirrors for a user buy of `userQty` units: floor(lots * pct / 100) whole lots (30%: 1-3 lots -> 0, 4 -> 1). */
export function mirrorQuantityFor(userQty: number, lotSize: number, pct: number): number {
    if (!(userQty > 0) || !(lotSize > 0) || !(pct > 0)) return 0;
    // + 1e-9: 0.3 * 10 style products land a hair below the integer in floating point.
    return Math.floor((userQty / lotSize) * (pct / 100) + 1e-9) * lotSize;
}

function eligibleUser(userId: string): boolean {
    return !!userId && userId.toLowerCase() !== primaryAdminEmail() && !bookkeeping.isStrategyUser(userId);
}

const col = () => Mongo.getInstance()?.db?.collection(COLLECTION);
const openQty = (user: string, token: string) => bookkeeping.trades.filter((t) => t.user === user && t.token === token).reduce((s, t) => s + t.quantity, 0);

// One adjustment at a time per (user, token): a buy-side upsert and a sell-side close must not interleave.
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    chains.set(key, run);
    run.finally(() => { if (chains.get(key) === run) chains.delete(key); }).catch(() => undefined);
    return run;
}

/** Called by the executors right before a frontend user's buy is placed. Fire-and-forget: never throws into the user's order. */
export const startMirrorBuy: MirrorHook = (leg) => {
    try {
        const pct = mirrorPercentage();
        if (pct <= 0 || !eligibleUser(leg.userId)) return;
        const qty = mirrorQuantityFor(leg.quantity, bookkeeping.getInstrumentLotSize(leg.tsym), pct);
        if (qty <= 0) {
            Log.log(`[order] mirror: ${leg.userId} ${leg.tsym} qty=${leg.quantity} at ${pct}% -> no whole lot to mirror`);
            return;
        }
        const admin = primaryAdminEmail();
        return serialized(`${leg.userId}|${leg.token}`, async () => {
            Log.log(`[order] mirror: ${admin} buys ${leg.tsym} qty=${qty} (${pct}% of ${leg.userId}'s ${leg.quantity})`);
            await leg.place(admin, qty);
            const c = col();
            if (!c) throw new Error('Mongo not connected - the mirror leg is open but not recorded, close it by hand');
            await c.updateOne(
                { userId: leg.userId, token: leg.token },
                { $inc: { adminQty: qty }, $set: { tsym: leg.tsym, broker: leg.broker, exchange: leg.exchange, updatedAt: new Date() } },
                { upsert: true },
            );
            // The user may have sold while the admin order was filling: that sell found no row to follow, so close now.
            if (openQty(leg.userId, leg.token) <= 0) await closeMirror(leg.userId, leg.token, undefined);
        }).then(() => undefined, (e) => { Log.log(`[order] ALERT: mirror buy of ${leg.tsym} for ${leg.userId} (qty=${qty}) failed - the user's order is unaffected:`, e); });
    } catch (e) {
        Log.log('[order] ALERT: mirror buy could not start:', e);
    }
};

// Closes `fraction` of the user's sold quantity on the admin leg (`sold`/`before`), or all of it when `sold` is undefined or the
// user is flat. Caps to what the admin really holds (its own target/SL may already have exited it).
// `brokerOwned`: the user's exit was a broker-side GTT fill. The admin leg carries its own GTT with the same target/stop (+/-0.10), so the broker
// closes it by itself: placing a sell here would race that GTT (the 2026-11-12 10:50 false ALERT: both GTTs hit, the mirror sell was refused
// as NEVER-SHORT). The row is still reduced, and a bounded check (verifyAdminClosed) alerts once if the admin leg is not closed by then.
async function closeMirror(userId: string, token: string, sold: { qty: number; before: number } | undefined, exactQty?: number, brokerOwned = false): Promise<void> {
    const c = col();
    const row = (await c?.findOne({ userId, token })) as MirrorRow | null | undefined;
    if (!c || !row) return;
    const admin = primaryAdminEmail();
    const adminHeld = openQty(admin, token);
    const lot = bookkeeping.getInstrumentLotSize(row.tsym);
    const userFlat = exactQty === undefined && openQty(userId, token) <= 0;
    let closeQty = exactQty !== undefined ? exactQty : userFlat || !sold ? row.adminQty : Math.floor((row.adminQty * sold.qty) / sold.before / lot + 1e-9) * lot;
    closeQty = Math.min(closeQty, row.adminQty, adminHeld);
    let verify = false;
    if (closeQty > 0 && brokerOwned) {
        Log.log(`[order] mirror: ${userId}'s ${row.tsym} exit was a broker GTT fill - ${admin}'s own GTT closes the admin share (qty=${closeQty}); no mirror sell placed`);
        verify = true;
    } else if (closeQty > 0) {
        Log.log(`[order] mirror: ${admin} sells ${row.tsym} qty=${closeQty} following ${userId}`);
        try {
            await getBrokerExecutor(admin, row.broker).squareOff(admin, row.tsym, closeQty, row.exchange);
        } catch (e) {
            // Nothing sellable at the broker: the admin leg is already gone there (its own GTT sold it; the GTT poll books it next). Not retried.
            if (!/NEVER-SHORT GUARD: nothing sellable/.test(String((e as any)?.message ?? e))) throw e;
            Log.log(`[order] mirror: ${admin}'s ${row.tsym} share is already closed at the broker (nothing sellable) - no mirror sell needed`);
            verify = true;
        }
    }
    const left = userFlat || adminHeld <= closeQty ? 0 : row.adminQty - Math.max(closeQty, 0);
    if (left <= 0) await c.deleteOne({ userId, token });
    else await c.updateOne({ userId, token }, { $set: { adminQty: left, updatedAt: new Date() } });
    if (verify) verifyAdminClosed(row.tsym, token);
}

const VERIFY_AFTER_MS = 3 * 60_000;
const verifying = new Set<string>();
/** Alert-only check (nothing is sold, no control state): a few minutes after a broker-owned exit, the admin must hold no more than the other
 *  users' mirror rows account for. One timer per token; a timer lost to a restart only loses this alert (the admin leg keeps its own GTT). */
function verifyAdminClosed(tsym: string, token: string): void {
    if (verifying.has(token)) return;
    verifying.add(token);
    const t = setTimeout(async () => {
        verifying.delete(token);
        try {
            const rows = (await col()?.find({ token }).toArray()) as MirrorRow[] | undefined;
            const expected = (rows ?? []).reduce((s, r) => s + r.adminQty, 0);
            const admin = primaryAdminEmail();
            const held = openQty(admin, token);
            if (held > expected) Log.log(`[order] ALERT: ${tsym}: the user's GTT exit closed the position but ${admin} still holds ${held} (other mirror rows account for ${expected}) ${VERIFY_AFTER_MS / 60000} min later - the admin leg's own GTT has not fired; it is still open`);
            else Log.log(`[order] mirror: ${tsym} admin share closed as expected`);
        } catch (e) {
            Log.log(`[order] mirror: admin-closed check for ${tsym} failed:`, e);
        }
    }, VERIFY_AFTER_MS);
    t.unref?.();
}

/** The user's own buy failed after the mirror started: take back the admin's matching quantity (never the leg of an earlier user buy). */
export function undoMirrorBuy(leg: MirrorLeg, started: Promise<void> | void): void {
    const qty = mirrorQuantityFor(leg.quantity, bookkeeping.getInstrumentLotSize(leg.tsym), mirrorPercentage());
    if (!started || qty <= 0) return;
    // started resolves after the admin order is placed and recorded, so the row and the admin position exist by now.
    started.then(() => serialized(`${leg.userId}|${leg.token}`, () => closeMirror(leg.userId, leg.token, undefined, qty)))
        .catch((e) => Log.log(`[order] ALERT: mirror undo for ${leg.userId} ${leg.tsym} failed - the admin leg may be open without the user's:`, e));
}

/** bookkeeping.onFill listener: a frontend user's sell (manual squareoff, target/stop, force-close, expiry) closes the matching admin share. */
export function onUserSell(userId: string, trade: Trade): void {
    if (trade.action !== 'Sell' || !(trade.quantity > 0) || !eligibleUser(userId)) return;
    const token = trade.token;
    const before = openQty(userId, token) + trade.quantity; // listeners run after booking: the sold units are already out of trades
    const brokerOwned = !!trade.brokerOrderId && bookkeeping.brokerOwnedExitOrderIds.has(String(trade.brokerOrderId));
    serialized(`${userId}|${token}`, () => closeMirror(userId, token, { qty: trade.quantity, before }, undefined, brokerOwned))
        .catch((e) => Log.log(`[order] ALERT: mirror close for ${userId} ${trade.tsym} failed - the admin leg may still be open:`, e));
}

/** The user changed target/stop-loss on a position: the admin leg gets the same points. */
export async function mirrorSetTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
    if (!eligibleUser(userId)) return;
    try {
        if (!(await col()?.findOne({ userId, token }))) return;
        await setTargetStopLoss(primaryAdminEmail(), token, targetPoints, stopLossPoints);
    } catch (e) {
        Log.log(`[order] ALERT: mirror target/stop-loss update for ${userId} ${token} failed:`, e);
    }
}
