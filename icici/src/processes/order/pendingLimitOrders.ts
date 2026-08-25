import Log from '../../util/Log';
import Zerodha from '../../zerodha/Zerodha';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';

// In-memory tracker for limit orders placed via placeLimitBuyBareOnZerodha
// (zerodhaExecutor.ts) - ContinuousStrategy's target-hit re-entries. No
// timeout/cancellation (confirmed decision: poll indefinitely) - state is
// in-memory only, so a process restart loses tracking of it, but the
// broker-side order is unaffected and will still fill/show up in Kite's own
// order book. Same limitation as exitMonitor/AntStream's in-memory-only
// patterns (see CLAUDE.md).

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
                pending.delete(orderId);
                const trade = new Trade();
                trade.tsym = order.tradingSymbol;
                trade.token = order.instrumentToken;
                trade.quantity = order.quantity;
                trade.price = latest.average_price;
                trade.lastTradePrice = latest.average_price;
                trade.action = 'Buy';
                trade.status = 'COMPLETE';
                trade.user = order.userId;
                await bookkeeping.recordFill(trade);
                Log.log(`[order] Pending limit order filled: ${order.tradingSymbol} (${order.userId}) at ${trade.price}`);
            } else if (latest.status === 'REJECTED' || latest.status === 'CANCELLED') {
                pending.delete(orderId);
                Log.log(`[order] Pending limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${latest.status}`);
            }
            // else: still pending, leave in map for the next poll
        } catch (e) {
            Log.log('[order] pollPendingLimitOrders: failed to poll order', orderId, e);
        }
    }
}
