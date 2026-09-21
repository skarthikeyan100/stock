import Log from '../../util/Log';
import Breeze from '../../breeze/Breeze';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';

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
}

const pending = new Map<string, PendingBreezeLimitOrder>();

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
                trade.action = 'Buy';
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                trade.brokerOrderId = orderId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending Breeze limit order filled: ${order.tradingSymbol} (${order.userId}) at ${trade.price}`);
            } else if (record.status && /rejected|cancelled/i.test(String(record.status))) {
                untrackPendingBreezeLimitOrder(orderId);
                Log.log(`[order] Pending Breeze limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${record.status}`);
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingBreezeLimitOrders: failed to poll order', orderId, e);
        }
    }
}
