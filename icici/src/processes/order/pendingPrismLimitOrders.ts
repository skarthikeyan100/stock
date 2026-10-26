import Log from '../../util/Log';
import Prism from '../../prism';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';
import { isPastMarketClose } from '../../util/marketHours';

// Mirrors pendingAntLimitOrders.ts exactly, for Prism limit orders placed
// via placeLimitSellBareOnPrism (prismExecutor.ts) - BulkPcrStrategy's
// target-hit exit, now also supported on Prism. Own Mongo collection, not
// shared with Kite's/Breeze's/ANT's pending trackers.
const PENDING_COLLECTION = 'pendingPrismLimitOrders';

interface PendingPrismLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    instrumentId: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

const pending = new Map<string, PendingPrismLimitOrder>();

// See pendingLimitOrders.ts's cancelledListeners for why this exists.
type CancelledListener = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: 'prism', orderId: string, reason: 'CANCELLED' | 'REJECTED') => void;
const cancelledListeners: CancelledListener[] = [];
export function onCancelled(listener: CancelledListener): void { cancelledListeners.push(listener); }

// See pendingLimitOrders.ts's findPendingOrdersForSymbol for why this exists.
export function findPendingOrdersForSymbol(userId: string, tradingSymbol: string): PendingPrismLimitOrder[] {
    return Array.from(pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);
}

export function trackPendingPrismLimitOrder(order: PendingPrismLimitOrder): void {
    pending.set(order.orderId, order);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION)
        .replaceOne({ orderId: order.orderId }, order, { upsert: true })
        .catch((e) => Log.log('[order] pendingPrismLimitOrders: Mongo persist failed for', order.orderId, e));
}

export function untrackPendingPrismLimitOrder(orderId: string): void {
    pending.delete(orderId);
    Mongo.getInstance()?.db.collection(PENDING_COLLECTION).deleteOne({ orderId })
        .catch((e) => Log.log('[order] pendingPrismLimitOrders: Mongo delete failed for', orderId, e));
}

// Called once at order-process startup, before pollPendingPrismLimitOrders'
// interval starts - restores any orders still resting from before the last
// restart, mirroring loadPendingAntLimitOrdersFromMongo's restart-safety reasoning.
export async function loadPendingPrismLimitOrdersFromMongo(): Promise<void> {
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
        Log.log(`[order] loadPendingPrismLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts. Fetches the orderbook ONCE per
// tick (Prism.getOrderBook) and matches every pending order against that one
// snapshot (Prism.getOrderStatus's optional `orders` param) - several
// resting chunks (BulkPcrStrategy's freeze-quantity chunking) would
// otherwise each trigger their own full get_orderbook call every 15s, the
// same redundant-call pattern that's already caused a live broker-API rate
// limit elsewhere in this codebase.
let pollInFlight = false;
export async function pollPendingPrismLimitOrders(): Promise<void> {
    if (pollInFlight) return; // overlapping polls would double-process (and double-notify) the same order
    pollInFlight = true;
    try {
        await pollPendingPrismLimitOrdersOnce();
    } finally {
        pollInFlight = false;
    }
}

async function pollPendingPrismLimitOrdersOnce(): Promise<void> {
    if (pending.size === 0) return;
    const prism = Prism.getInstance();
    let orderBook: any[];
    try {
        orderBook = await prism.getOrderBook();
    } catch (e) {
        Log.log('[order] pollPendingPrismLimitOrders: orderbook fetch failed:', e);
        return;
    }

    for (const [orderId, order] of Array.from(pending)) {
        if (!pending.has(orderId)) continue;
        try {
            const { status, fillPrice, filledQuantity } = (await prism.getOrderStatus(orderId, orderBook)) as { status: string; fillPrice?: number; filledQuantity?: number };
            // Books `qty` filled at `price`. The order is untracked only AFTER the fill is booked, so a recordFill
            // failure is retried on the next poll (recordFill dedupes on brokerOrderId).
            const bookFill = async (qty: number, price: number) => {
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentId;
                trade.quantity = qty;
                trade.price = price;
                trade.lastTradePrice = price;
                trade.action = order.action;
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.broker = 'prism';
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending Prism limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} qty=${qty} at ${trade.price}`);
            };
            if (status === 'COMPLETE') {
                if (!fillPrice) {
                    untrackPendingPrismLimitOrder(orderId);
                    Log.log(`[order] Pending Prism limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE but no fill price reported - manual review required`);
                    continue;
                }
                await bookFill(order.quantity, fillPrice);
                untrackPendingPrismLimitOrder(orderId);
            } else if (status === 'REJECTED' || status === 'CANCELLED' || status === 'CANCELED') {
                // A cancelled order can carry a partial fill (fillshares > 0): book it, report only the remainder.
                const filledQty = Math.min(order.quantity, Number(filledQuantity ?? 0));
                if (filledQty > 0) {
                    const row = orderBook.find((o: any) => o.norenordno === orderId);
                    const partialPrice = Number(row?.avgprc ?? row?.flprc ?? row?.avgPrice);
                    if (partialPrice > 0) {
                        await bookFill(filledQty, partialPrice);
                    } else {
                        Log.log(`[order] ALERT: Prism order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled with ${filledQty} filled but no fill price - not booked, manual review required`);
                    }
                }
                untrackPendingPrismLimitOrder(orderId);
                const remainingQty = order.quantity - filledQty;
                if (remainingQty <= 0) continue;
                const isCancelled = status === 'CANCELLED' || status === 'CANCELED';
                if (isCancelled && isPastMarketClose()) {
                    Log.log(`[order] Pending Prism limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close - leaving re-placement to tomorrow's reconcile()`);
                } else {
                    const reason = status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                    for (const listener of cancelledListeners) {
                        listener(order.userId, order.tradingSymbol, order.instrumentId, remainingQty, order.exchange, order.action, 'prism', orderId, reason);
                    }
                    Log.log(`[order] Pending Prism limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}`);
                }
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingPrismLimitOrders: failed to poll order', orderId, e);
        }
    }
}
