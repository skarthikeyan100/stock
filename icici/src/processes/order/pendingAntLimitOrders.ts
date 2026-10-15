import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';
import { isPastMarketClose } from '../../util/marketHours';

// Mirrors pendingLimitOrders.ts (Zerodha) exactly, for ANT limit orders
// placed via placeLimitSellBareOnAnt (antExecutor.ts) - BulkPcrStrategy's
// target-hit exit. ANT can't place true MARKET orders at all ("Market
// orders are not allowed" - confirmed live, see antExecutor.ts's
// enterPosition comment), so this only needs to cover the SELL side added
// 2026-09-22; a Buy variant can be added the same way if a bare ANT limit
// buy primitive is ever needed. Own Mongo collection, not shared with
// Zerodha's/Breeze's pending trackers.
const PENDING_COLLECTION = 'pendingAntLimitOrders';

export interface PendingAntLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    instrumentId: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

const pending = new Map<string, PendingAntLimitOrder>();

// See pendingLimitOrders.ts's cancelledListeners for why this exists.
type CancelledListener = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: 'ant', orderId: string, reason: 'CANCELLED' | 'REJECTED', rejectReason?: string) => void;
const cancelledListeners: CancelledListener[] = [];
export function onCancelled(listener: CancelledListener): void { cancelledListeners.push(listener); }

// See pendingLimitOrders.ts's findPendingOrdersForSymbol for why this exists.
export function findPendingOrdersForSymbol(userId: string, tradingSymbol: string): PendingAntLimitOrder[] {
    return Array.from(pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);
}

export function trackPendingAntLimitOrder(order: PendingAntLimitOrder): void {
    pending.set(order.orderId, order);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION)
        .replaceOne({ orderId: order.orderId }, order, { upsert: true })
        .catch((e) => Log.log('[order] pendingAntLimitOrders: Mongo persist failed for', order.orderId, e));
}

export function pendingAntSellsFor(userId: string, tradingSymbol: string): PendingAntLimitOrder[] {
    return findPendingOrdersForSymbol(userId, tradingSymbol).filter((o) => o.action === 'Sell');
}

export function isPendingAntOrder(orderId: string): boolean {
    return pending.has(orderId);
}

export function untrackPendingAntLimitOrder(orderId: string): void {
    pending.delete(orderId);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION).deleteOne({ orderId })
        .catch((e) => Log.log('[order] pendingAntLimitOrders: Mongo delete failed for', orderId, e));
}

// Called once at order-process startup, before pollPendingAntLimitOrders'
// interval starts - restores any orders still resting from before the last
// restart, mirroring loadPendingLimitOrdersFromMongo's restart-safety reasoning.
export async function loadPendingAntLimitOrdersFromMongo(): Promise<void> {
    const db = Mongo.getInstance()?.db;
    if (!db) return;
    const rows = await db.collection(PENDING_COLLECTION).find({}).toArray();
    for (const row of rows) {
        pending.set(row.orderId, {
            orderId: row.orderId,
            userId: row.userId,
            tradingSymbol: row.tradingSymbol,
            instrumentId: row.instrumentId,
            quantity: row.quantity,
            exchange: row.exchange,
            action: row.action ?? 'Sell',
        });
    }
    if (rows.length > 0) {
        Log.log(`[order] loadPendingAntLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts, using ANT.getOrderStatus's
// single-shot check (unlike Zerodha's kc.getOrderHistory/Breeze's
// getOrderDetail, ANT has no separate "poll status" vs "poll until fill"
// distinction in this codebase yet - getOrderStatus is the one-shot form
// added specifically for this poller, see ANT.ts).
export async function pollPendingAntLimitOrders(): Promise<void> {
    if (pending.size === 0) return;
    const ant = ANT.getInstance();
    if (!(await ant.hasValidSession())) return;

    for (const [orderId, order] of pending) {
        try {
            const { status, fillPrice, filledQuantity, rejectReason } = await ant.getOrderStatus(orderId);
            // A square-off or re-price may have taken this order off the book while the status call was in
            // flight. Acting on that stale status could re-place a sell for quantity already sold.
            if (!pending.has(orderId)) continue;
            if (status === 'COMPLETE') {
                // No price on a COMPLETE record: take the fill from the trade book rather than dropping it.
                let price = fillPrice;
                let quantity = order.quantity;
                if (!price) {
                    const book = await ant.getFilledFromTradeBook(orderId);
                    if (!(book.quantity > 0 && book.avgPrice > 0)) {
                        Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE with no fill price or trade-book fill - manual review required`);
                        continue;
                    }
                    price = book.avgPrice;
                    quantity = book.quantity;
                }
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentId;
                trade.quantity = quantity;
                trade.price = price;
                trade.lastTradePrice = price;
                trade.action = order.action;
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.broker = 'ant';
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                untrackPendingAntLimitOrder(orderId); // only once booked - a failed read above leaves it to retry
                Log.log(`[order] Pending ANT limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} at ${trade.price}`);
            } else if (status === 'REJECTED' || status === 'CANCELLED') {
                // Book any partial fill BEFORE taking the order off the book. If the book read or the booking
                // throws, the order stays tracked and the next poll retries it - nothing is lost.
                let remaining = order.quantity;
                if (order.action === 'Sell' && (filledQuantity ?? 0) > 0) {
                    const book = await ant.getFilledFromTradeBook(orderId);
                    // The status shows fills the trade book doesn't have yet: wait for the book, don't guess.
                    if (book.quantity < (filledQuantity ?? 0)) {
                        throw new Error(`cancelled sell ${orderId}: status shows ${filledQuantity} filled, trade book ${book.quantity} - retrying on next poll`);
                    }
                    if (book.quantity > 0) {
                        const partial = new Trade();
                        partial.tsym = order.tradingSymbol;
                        partial.token = order.instrumentId;
                        partial.quantity = book.quantity;
                        partial.price = book.avgPrice;
                        partial.lastTradePrice = book.avgPrice;
                        partial.action = 'Sell';
                        partial.status = 'COMPLETE';
                        partial.user = order.userId;
                        partial.broker = 'ant';
                        partial.brokerOrderId = orderId;
                        await bookkeeping.recordFill(partial);
                    }
                    remaining = order.quantity - book.quantity;
                    Log.log(`[order] Pending ANT sell ${orderId} (${order.tradingSymbol}) cancelled after ${book.quantity} filled - ${remaining} unfilled`);
                }
                untrackPendingAntLimitOrder(orderId);
                // ANT has no separate EOD-expiry status either (same gap as Kite - see pendingLimitOrders.ts):
                // an unfilled DAY order auto-cancelled at exchange close reports back as plain 'CANCELLED'.
                // Defer the listener past market close to avoid re-placing against a closed exchange
                // (live incident 2026-09-24) - tomorrow's reconcile() handles it. Fills are already booked above.
                if (status === 'CANCELLED' && isPastMarketClose()) {
                    Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close - leaving re-placement to tomorrow's reconcile()`);
                } else if (remaining > 0) {
                    const reason = status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                    for (const listener of cancelledListeners) {
                        listener(order.userId, order.tradingSymbol, order.instrumentId, remaining, order.exchange, order.action, 'ant', orderId, reason, rejectReason);
                    }
                    Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}${rejectReason ? ` (${rejectReason})` : ''}`);
                }
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingAntLimitOrders: failed to poll order', orderId, e);
        }
    }
}
