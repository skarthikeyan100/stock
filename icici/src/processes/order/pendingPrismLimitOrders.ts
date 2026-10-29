import Prism from '../../prism';
import { isPastMarketClose } from '../../util/marketHours';
import { PendingOrder, PendingOrderTracker } from './pendingOrderTracker';

// Prism limit orders placed via placeLimitSellBareOnPrism (prismExecutor.ts) - BulkPcrStrategy's target-hit exit. Own
// Mongo collection, not shared with Kite's/Breeze's/ANT's pending trackers. The loop itself lives in pendingOrderTracker.ts.
interface PendingPrismLimitOrder extends PendingOrder {
    instrumentId: string;
}

// The orderbook is fetched ONCE per tick and every pending order is matched against that one snapshot (several resting
// chunks would otherwise each trigger their own get_orderbook call every 15s, a pattern that already hit a broker rate limit).
const tracker = new PendingOrderTracker<PendingPrismLimitOrder, any[], 'prism'>({
    broker: 'prism',
    collection: 'pendingPrismLimitOrders',
    label: 'Prism',
    tokenOf: (order) => order.instrumentId,
    fetchSnapshot: () => Prism.getInstance().getOrderBook(),
    statusOf: async (order, orderBook) => {
        const res = await Prism.getInstance().getOrderStatus(order.orderId, orderBook);
        // A cancelled order after the close is left to tomorrow's reconcile() instead of re-placed.
        const cancelled = res.status === 'CANCELLED' || res.status === 'CANCELED';
        return cancelled && isPastMarketClose() ? { ...res, skipListener: true } : res;
    },
    rowPrice: (order, orderBook) => {
        const row = orderBook.find((o: any) => o.norenordno === order.orderId);
        return Number(row?.avgprc ?? row?.flprc ?? row?.avgPrice);
    },
    fromDoc: (row) => ({
        orderId: row.orderId,
        userId: row.userId,
        tradingSymbol: row.tradingSymbol,
        instrumentId: row.token ?? row.instrumentId,
        quantity: row.quantity,
        exchange: row.exchange,
        action: row.action ?? 'Sell',
    }),
});

export const onCancelled = tracker.onCancelled;
export const findPendingOrdersForSymbol = tracker.find;
export const allPendingOrders = tracker.all;
export const trackPendingPrismLimitOrder = tracker.track;
export const untrackPendingPrismLimitOrder = tracker.untrack;
export const beginCancelOfPendingPrismLimitOrders = tracker.beginCancel;
export const endCancelOfPendingPrismLimitOrders = tracker.endCancel;
export const silenceListenersOfPendingPrismLimitOrders = tracker.silenceListeners;
export const loadPendingPrismLimitOrdersFromMongo = tracker.loadFromMongo;
export const pollPendingPrismLimitOrders = tracker.poll;
