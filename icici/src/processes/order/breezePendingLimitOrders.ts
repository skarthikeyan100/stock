import Log from '../../util/Log';
import Breeze from '../../breeze/Breeze';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';
import { isPastMarketClose } from '../../util/marketHours';

// Mirrors pendingLimitOrders.ts exactly, for limit orders placed via
// placeLimitBuyBareOnBreeze (breezeExecutor.ts) - root-refill re-entries for
// LegManager-driven strategies routed to Breeze. Own Mongo collection (not
// shared with Zerodha's pendingLimitOrders) and tracked by antToken (the
// cross-broker token LegManager's tick routing keys off), not a Breeze-
// specific instrument token - see breezeExecutor.ts's marketBuyBareOnBreeze
// comment on why.
const PENDING_COLLECTION = 'pendingBreezeLimitOrders';

interface PendingBreezeLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    antToken: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

const pending = new Map<string, PendingBreezeLimitOrder>();

type CancelledListener = (userId: string, tradingSymbol: string, antToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: 'breeze', orderId: string, reason: 'CANCELLED' | 'REJECTED') => void;
const cancelledListeners: CancelledListener[] = [];

export function onCancelled(listener: CancelledListener): void {
    cancelledListeners.push(listener);
}

// See pendingLimitOrders.ts's findPendingOrdersForSymbol for why this exists.
export function findPendingOrdersForSymbol(userId: string, tradingSymbol: string): PendingBreezeLimitOrder[] {
    return Array.from(pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);
}

export function trackPendingBreezeLimitOrder(order: PendingBreezeLimitOrder): void {
    pending.set(order.orderId, order);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION)
        .replaceOne({ orderId: order.orderId }, order, { upsert: true })
        .catch((e) => Log.log('[order] breezePendingLimitOrders: Mongo persist failed for', order.orderId, e));
}

// Called after an explicit cancel (cancelOrderOnBreeze) so pollPendingBreezeLimitOrders
// doesn't keep polling an order we just told the broker to drop.
export function untrackPendingBreezeLimitOrder(orderId: string): void {
    pending.delete(orderId);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION).deleteOne({ orderId })
        .catch((e) => Log.log('[order] breezePendingLimitOrders: Mongo delete failed for', orderId, e));
}

// Called once at order-process startup, before pollPendingBreezeLimitOrders'
// interval starts - restores any orders still resting from before the last
// restart, mirroring loadPendingLimitOrdersFromMongo's restart-safety reasoning.
export async function loadPendingBreezeLimitOrdersFromMongo(): Promise<void> {
    const db = Mongo.getInstance()?.db;
    if (!db) return;
    const rows = await db.collection(PENDING_COLLECTION).find({}).toArray();
    for (const row of rows) {
        pending.set(row.orderId, {
            orderId: row.orderId,
            userId: row.userId,
            tradingSymbol: row.tradingSymbol,
            antToken: row.antToken,
            quantity: row.quantity,
            exchange: row.exchange,
            action: row.action ?? 'Buy', // pre-2026-09-22 rows predate this field - all were Buy
        });
    }
    if (rows.length > 0) {
        Log.log(`[order] loadPendingBreezeLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts. Field names/terminal-status
// regex per Breeze.getFillPrice's confirmed-live shape: status "Ordered"
// while pending, average_price populated (and > 0) on fill.
export async function pollPendingBreezeLimitOrders(): Promise<void> {
    if (pending.size === 0) return;
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) return;

    for (const [orderId, order] of pending) {
        try {
            const result = await breeze.getOrderDetail('NFO', orderId);
            const record = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
            if (!record) continue;

            const price = Number(record.average_price);
            if (price > 0) {
                untrackPendingBreezeLimitOrder(orderId);
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.antToken;
                trade.quantity = order.quantity;
                trade.price = price;
                trade.lastTradePrice = price;
                trade.action = order.action;
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.broker = 'breeze';
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending Breeze limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} at ${trade.price}`);
            } else if (record.status && /rejected|cancelled|expired/i.test(String(record.status))) {
                // "Expired" (live incident 2026-09-24): every resting sell
                // chunk is a DAY order, which ICICI reports back with this
                // exact status once the exchange cancels it unfilled at EOD -
                // previously unmatched by this regex, so an EOD-expired
                // chunk sat in `pending` forever and never fired the
                // cancelled-listener that re-places the exit.
                untrackPendingBreezeLimitOrder(orderId);
                const isExpired = /expired/i.test(String(record.status));
                // But firing the cancelled-listener for an EOD expiry means an
                // immediate same-day re-placement attempt (onOrderCancelled ->
                // placeExitSellAtTargetPrice) after the exchange has already
                // closed - that placement will fail, driving the position into
                // phase='error' every single day. Skip the listener call for an
                // after-close expiry and let the next morning's reconcile()
                // (BulkPcrStrategy.ts, its own sellPlacedAt/isPastMarketClose
                // check) re-place it instead. A rejection/manual cancel is still
                // handled immediately regardless of time of day.
                if (isExpired && isPastMarketClose()) {
                    Log.log(`[order] Pending Breeze limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) expired after market close - leaving re-placement to tomorrow's reconcile()`);
                } else {
                    const reason = /rejected/i.test(String(record.status)) ? 'REJECTED' : 'CANCELLED';
                    for (const listener of cancelledListeners) {
                        listener(order.userId, order.tradingSymbol, order.antToken, order.quantity, order.exchange, order.action, 'breeze', orderId, reason);
                    }
                    Log.log(`[order] Pending Breeze limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${record.status}`);
                }
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingBreezeLimitOrders: failed to poll order', orderId, e);
        }
    }
}
