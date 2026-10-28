import Breeze from '../../breeze/Breeze';
import { isPastMarketClose } from '../../util/marketHours';
import { PendingOrder, PendingOrderTracker, OrderStatus } from './pendingOrderTracker';

// Limit orders placed via placeLimitBuyBareOnBreeze (breezeExecutor.ts) - root-refill re-entries for
// LegManager-driven strategies routed to Breeze. Own Mongo collection (not shared with Kite's pendingLimitOrders) and
// tracked by antToken (the cross-broker token LegManager's tick routing keys off), not a Breeze-specific instrument
// token - see breezeExecutor.ts's marketBuyBareOnBreeze comment on why. The loop itself lives in pendingOrderTracker.ts.
interface PendingBreezeLimitOrder extends PendingOrder {
    antToken: string;
}

// Field names/terminal-status regex per Breeze.getFillPrice's confirmed-live shape: status "Ordered" while pending,
// average_price populated (and > 0) on fill. Breeze reports no order book, so each order is fetched on its own.
function breezeStatus(order: PendingBreezeLimitOrder, record: any): OrderStatus {
    if (!record) return { status: 'PENDING' };
    const price = Number(record.average_price);
    const pendingQty = Number(record.pending_quantity ?? 0);
    const cancelledQty = Number(record.cancelled_quantity ?? 0);
    const brokerQty = Number(record.quantity ?? 0) > 0 ? Number(record.quantity) : order.quantity;
    const isTerminalDead = !!record.status && /rejected|cancelled|expired/i.test(String(record.status));
    if (price > 0 && pendingQty === 0 && !isTerminalDead) {
        if (!(cancelledQty > 0)) return { status: 'COMPLETE', fillPrice: price };
        // Partly filled, the rest cancelled.
        return { status: 'CANCELLED', fillPrice: price, filledQuantity: Math.max(0, brokerQty - cancelledQty), skipListener: false };
    }
    if (isTerminalDead) {
        // "Expired" (live incident 2026-09-24): every resting sell chunk is a DAY order, which ICICI reports back with this
        // exact status once the exchange cancels it unfilled at EOD. Re-placing it immediately after the close would fail
        // and drive the position into phase='error' every day, so an after-close expiry is left to the next morning's
        // reconcile(). A rejection/manual cancel is still handled immediately regardless of time of day.
        const isExpired = /expired/i.test(String(record.status));
        // A cancelled/expired order can still carry a partial fill: it is booked and only the remainder reported.
        const filled = price > 0 ? Math.max(0, brokerQty - (cancelledQty > 0 ? cancelledQty : pendingQty)) : 0;
        return {
            status: /rejected/i.test(String(record.status)) ? 'REJECTED' : 'CANCELLED',
            fillPrice: price,
            filledQuantity: filled,
            skipListener: isExpired && isPastMarketClose(),
        };
    }
    return { status: 'PENDING' };
}

const tracker = new PendingOrderTracker<PendingBreezeLimitOrder, null, 'breeze'>({
    broker: 'breeze',
    collection: 'pendingBreezeLimitOrders',
    label: 'Breeze',
    tokenOf: (order) => order.antToken,
    ready: () => Breeze.getInstance().hasValidSession(),
    statusOf: async (order) => {
        const result = await Breeze.getInstance().getOrderDetail(order.exchange, order.orderId);
        const record = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
        return breezeStatus(order, record);
    },
    fromDoc: (row) => ({
        orderId: row.orderId,
        userId: row.userId,
        tradingSymbol: row.tradingSymbol,
        antToken: row.token ?? row.antToken,
        quantity: row.quantity,
        exchange: row.exchange,
        action: row.action ?? 'Buy', // pre-2026-09-22 rows predate this field - all were Buy
    }),
});

export const onCancelled = tracker.onCancelled;
// Exchange of a still-resting limit order, restored from Mongo across restarts. Lets breezeExecutor's resolveOrderExchange
// resolve a BFO (SENSEX) order placed before an `order` restart instead of defaulting it to NFO.
export const pendingBreezeOrderExchange = (orderId: string): 'NFO' | 'BFO' | undefined => tracker.get(orderId)?.exchange;
export const findPendingOrdersForSymbol = tracker.find;
export const trackPendingBreezeLimitOrder = tracker.track;
// Called after an explicit cancel (cancelOrderOnBreeze) so the poll doesn't keep polling an order we just told the broker to drop.
export const untrackPendingBreezeLimitOrder = tracker.untrack;
export const beginCancelOfBreezePendingLimitOrders = tracker.beginCancel;
export const endCancelOfBreezePendingLimitOrders = tracker.endCancel;
export const silenceListenersOfBreezePendingLimitOrders = tracker.silenceListeners;
export const loadPendingBreezeLimitOrdersFromMongo = tracker.loadFromMongo;
export const pollPendingBreezeLimitOrders = tracker.poll;
