import Log from '../../util/Log';
import Zerodha from '../../zerodha/Zerodha';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';

// In-memory tracker (mirrored to Mongo, see loadPendingLimitOrdersFromMongo)
// for limit orders placed via placeLimitBuyBareOnZerodha (zerodhaExecutor.ts)
// - ContinuousStrategy's target-hit re-entries. No automatic timeout - a
// resting order polls indefinitely unless explicitly cancelled (see
// untrackPendingLimitOrder, used by ContinuousStrategy's root-refill
// drift-cancel check).
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
}

const pending = new Map<string, PendingLimitOrder>();

export function trackPendingLimitOrder(order: PendingLimitOrder): void {
    pending.set(order.orderId, order);
    // Fire-and-forget, same convention as bookkeeping's Mongo writes - never
    // let a Mongo hiccup block live order placement.
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION)
        .replaceOne({ orderId: order.orderId }, order, { upsert: true })
        .catch((e) => Log.log('[order] pendingLimitOrders: Mongo persist failed for', order.orderId, e));
}

// Called after an explicit cancel (cancelOrderOnZerodha) so pollPendingLimitOrders
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
        });
    }
    if (rows.length > 0) {
        Log.log(`[order] loadPendingLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts (shorter than pollGttFills' 60s -
// a re-entry filling promptly matters more to a live chain).
export async function pollPendingLimitOrders(): Promise<void> {
    if (pending.size === 0) return;
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) return;

    for (const [orderId, order] of pending) {
        try {
            const history = await zerodha.getKiteConnect().getOrderHistory(orderId);
            const latest = history[history.length - 1];
            if (!latest) continue;

            if (latest.status === 'COMPLETE') {
                untrackPendingLimitOrder(orderId);
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentToken;
                trade.quantity = order.quantity;
                trade.price = latest.average_price;
                trade.lastTradePrice = latest.average_price;
                trade.action = 'Buy';
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending limit order filled: ${order.tradingSymbol} (${order.userId}) at ${trade.price}`);
            } else if (latest.status === 'REJECTED' || latest.status === 'CANCELLED') {
                untrackPendingLimitOrder(orderId);
                Log.log(`[order] Pending limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${latest.status}`);
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingLimitOrders: failed to poll order', orderId, e);
        }
    }
}
