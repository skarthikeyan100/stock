import Log from '../../util/Log';
import { recordOrderOwner } from './orderOwners';
import Kite from '../../kite/Kite';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';
import { isPastMarketClose } from '../../util/marketHours';

// In-memory tracker (mirrored to Mongo, see loadPendingLimitOrdersFromMongo)
// for limit orders placed via placeLimitBuyBareOnKite (kiteExecutor.ts)
// - ContinuousStrategy's target-hit re-entries - and, since 2026-09-22, via
// placeLimitSellBareOnKite - BulkPcrStrategy's target-hit exit, which
// needs a resting SELL leg instead of a blind market order. `action`
// distinguishes the two so a fill is recorded as the right side. No
// automatic timeout - a resting order polls indefinitely unless explicitly
// cancelled (see untrackPendingLimitOrder, used by ContinuousStrategy's
// root-refill drift-cancel check).
//
// The Mongo mirror exists specifically so a process restart can't silently
// orphan a resting order's eventual fill: before the mirror was added, a
// restart wiped this Map, pollPendingLimitOrders had nothing left to poll,
// and an order that filled at the broker afterwards never reached
// bookkeeping.recordFill - a real live incident (2026-09-01, a ContinuousStrategy
// root-refill on NIFTY2690124150PE filled ~45min after being placed, during
// which the order process restarted; the fill was never recorded, leaving a
// 65-lot position open at the broker with zero app-side tracking until a
// later restart's loadOpenTradesFromBroker flagged it as untracked).
const PENDING_COLLECTION = 'pendingLimitOrders';

interface PendingLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    instrumentToken: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

const pending = new Map<string, PendingLimitOrder>();

type CancelledListener = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: 'kite', orderId: string, reason: 'CANCELLED' | 'REJECTED') => void;
const cancelledListeners: CancelledListener[] = [];

export function onCancelled(listener: CancelledListener): void {
    cancelledListeners.push(listener);
}

// Used to cancel a resting SELL leg before a force-close path (EOD
// expiry-day squareoff, drawdown-breach auto-squareoff - both in
// orderProcess.ts) also market-sells the same still-open quantity, which
// would otherwise double-sell it (see chunkedSquareOffLimit's "leave it
// resting" design - those force-close paths don't know about it otherwise).
export function findPendingOrdersForSymbol(userId: string, tradingSymbol: string): PendingLimitOrder[] {
    return Array.from(pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);
}

// True while this order is tracked for its owner's fill booking (restored from Mongo after a restart).
export function isTrackedPendingOrder(orderId: string): boolean {
    return pending.has(orderId);
}

export function trackPendingLimitOrder(order: PendingLimitOrder): void {
    recordOrderOwner(order.orderId, order.userId, 'kite');
    pending.set(order.orderId, order);
    // Fire-and-forget, same convention as bookkeeping's Mongo writes - never
    // let a Mongo hiccup block live order placement.
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION)
        .replaceOne({ orderId: order.orderId }, order, { upsert: true })
        .catch((e) => Log.log('[order] pendingLimitOrders: Mongo persist failed for', order.orderId, e));
}

// Called after an explicit cancel (cancelOrderOnKite) so pollPendingLimitOrders
// doesn't keep polling an order we just told the broker to drop.
export function untrackPendingLimitOrder(orderId: string): void {
    pending.delete(orderId);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION).deleteOne({ orderId })
        .catch((e) => Log.log('[order] pendingLimitOrders: Mongo delete failed for', orderId, e));
}

// Called once at order-process startup, before pollPendingLimitOrders' interval
// starts (see orderProcess.ts main()) - restores any orders still resting from
// before the last restart, so the very next poll tick can pick up a fill (or
// cancellation/rejection) that happened while this process was down.
export async function loadPendingLimitOrdersFromMongo(): Promise<void> {
    const db = Mongo.getInstance()?.db;
    if (!db) return;
    const rows = await db.collection(PENDING_COLLECTION).find({}).toArray();
    for (const row of rows) {
        pending.set(row.orderId, {
            orderId: row.orderId,
            userId: row.userId,
            tradingSymbol: row.tradingSymbol,
            instrumentToken: row.instrumentToken,
            quantity: row.quantity,
            exchange: row.exchange,
            action: row.action ?? 'Buy', // pre-2026-09-22 rows predate this field - all were Buy
        });
    }
    if (rows.length > 0) {
        Log.log(`[order] loadPendingLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts (shorter than pollGttFills' 60s -
// a re-entry filling promptly matters more to a live chain).
let pollInFlight = false;
export async function pollPendingLimitOrders(): Promise<void> {
    if (pollInFlight) return; // overlapping polls would double-process (and double-notify) the same order
    pollInFlight = true;
    try {
        await pollPendingLimitOrdersOnce();
    } finally {
        pollInFlight = false;
    }
}

async function pollPendingLimitOrdersOnce(): Promise<void> {
    if (pending.size === 0) return;
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) return;

    for (const [orderId, order] of Array.from(pending)) {
        if (!pending.has(orderId)) continue; // untracked (cancelled/booked) while an earlier iteration awaited
        try {
            const history = await kite.getKiteConnect().getOrderHistory(orderId);
            const latest = history[history.length - 1];
            if (!latest) continue;

            // Books `qty` filled at `price`. Untracking happens only AFTER the fill is booked: if recordFill throws
            // the order stays tracked and the next poll retries (recordFill dedupes on brokerOrderId).
            const bookFill = async (qty: number, price: number) => {
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentToken;
                trade.quantity = qty;
                trade.price = price;
                trade.lastTradePrice = price;
                trade.action = order.action;
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.broker = 'kite';
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} qty=${qty} at ${trade.price}`);
            };

            if (latest.status === 'COMPLETE') {
                await bookFill(order.quantity, latest.average_price);
                untrackPendingLimitOrder(orderId);
            } else if (latest.status === 'REJECTED' || latest.status === 'CANCELLED') {
                // A cancelled order can carry a genuine partial fill: book it, and tell the listeners only about
                // the unfilled remainder.
                const filledQty = Math.min(order.quantity, Number(latest.filled_quantity ?? 0));
                if (filledQty > 0) await bookFill(filledQty, latest.average_price);
                untrackPendingLimitOrder(orderId);
                const remainingQty = order.quantity - filledQty;
                if (remainingQty <= 0) continue;
                // Kite Connect has no separate "EXPIRED" status - an unfilled
                // DAY order the exchange auto-cancels at EOD is reported back
                // as plain 'CANCELLED'. Unlike breezePendingLimitOrders.ts
                // (ICICI's API does report a distinct "Expired" string,
                // letting that guard target EOD expiry specifically), Kite
                // gives no way to tell an EOD auto-cancel apart from a
                // genuine same-day manual/API cancel once status is already
                // 'CANCELLED' - this time-based gate is a deliberate, known
                // imprecision: a real manual cancel that happens to land
                // after isPastMarketClose() also gets deferred to tomorrow
                // instead of firing immediately. Accepted trade-off - that
                // window is narrow (the exchange itself stops accepting
                // order actions at close, so a genuine manual cancel this
                // late is rare) and deferring is always safe (re-placement
                // simply happens next reconcile() instead of now), whereas
                // NOT deferring reproduces the live incident below on every
                // single EOD, which is the common case. Firing the
                // cancelled-listener after market close means an immediate
                // same-day re-placement attempt (e.g.
                // BulkPcrStrategy.onOrderCancelled ->
                // placeExitSellAtTargetPrice) against a closed exchange,
                // which will fail and drive the position into phase='error'
                // every single EOD (live incident 2026-09-24, both the
                // Kite and Breeze legs expired unfilled at EOD). Skip the
                // listener call here and let the next morning's reconcile()
                // (BulkPcrStrategy.ts's sellPlacedAt/
                // isStillWithinSameTradingSession check) re-place it instead.
                if (latest.status === 'CANCELLED' && isPastMarketClose()) {
                    Log.log(`[order] Pending limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close - leaving re-placement to tomorrow's reconcile()`);
                } else {
                    const reason = latest.status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                    for (const listener of cancelledListeners) {
                        listener(order.userId, order.tradingSymbol, order.instrumentToken, remainingQty, order.exchange, order.action, 'kite', orderId, reason);
                    }
                    Log.log(`[order] Pending limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${latest.status}`);
                }
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingLimitOrders: failed to poll order', orderId, e);
        }
    }
}
