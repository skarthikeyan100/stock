import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';

// Mirrors pendingLimitOrders.ts (Zerodha) exactly, for ANT limit orders
// placed via placeLimitSellBareOnAnt (antExecutor.ts) - BulkPcrStrategy's
// target-hit exit. ANT can't place true MARKET orders at all ("Market
// orders are not allowed" - confirmed live, see antExecutor.ts's
// enterPosition comment), so this only needs to cover the SELL side added
// 2026-09-22; a Buy variant can be added the same way if a bare ANT limit
// buy primitive is ever needed. Own Mongo collection, not shared with
// Zerodha's/Breeze's pending trackers.
const PENDING_COLLECTION = 'pendingAntLimitOrders';

interface PendingAntLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    instrumentId: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

const pending = new Map<string, PendingAntLimitOrder>();

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
            const { status, fillPrice } = await ant.getOrderStatus(orderId);
            if (status === 'COMPLETE') {
                untrackPendingAntLimitOrder(orderId);
                if (!fillPrice) {
                    Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE but no fill price reported - manual review required`);
                    continue;
                }
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentId;
                trade.quantity = order.quantity;
                trade.price = fillPrice;
                trade.lastTradePrice = fillPrice;
                trade.action = order.action;
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.broker = 'ant';
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending ANT limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} at ${trade.price}`);
            } else if (status === 'REJECTED' || status === 'CANCELLED') {
                untrackPendingAntLimitOrder(orderId);
                Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}`);
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingAntLimitOrders: failed to poll order', orderId, e);
        }
    }
}
