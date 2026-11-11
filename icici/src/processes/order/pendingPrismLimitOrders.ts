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
// A 401 ("Session Expired: Invalid Session Key") means the loaded token is dead and every retry fails the same way, so the poll
// stops after the first one and stays idle until a DIFFERENT token is loaded (a fresh login: reloadToken re-reads it).
// No token at all (not logged in yet) makes no request either. A passed probe is trusted for SESSION_RECHECK_MS.
const SESSION_RECHECK_MS = 5 * 60_000;
let sessionValidUntil = 0;
let rejectedToken = '';
const is401 = (e: any) => e?.response?.status === 401;

const tracker = new PendingOrderTracker<PendingPrismLimitOrder, any[], 'prism'>({
    broker: 'prism',
    collection: 'pendingPrismLimitOrders',
    label: 'Prism',
    tokenOf: (order) => order.instrumentId,
    ready: async () => {
        const prism = Prism.getInstance();
        const token = prism.currentToken();
        if (!token || token === rejectedToken) return false;
        if (Date.now() < sessionValidUntil) return true;
        try {
            await prism.getPositions({ strict: true });
        } catch (e) {
            if (is401(e)) { rejectedToken = token; return false; }
            throw e; // transient (network, 5xx): reported as "readiness check failed" and retried next poll
        }
        sessionValidUntil = Date.now() + SESSION_RECHECK_MS;
        return true;
    },
    fetchSnapshot: async () => {
        const prism = Prism.getInstance();
        const token = prism.currentToken();
        try {
            return await prism.getOrderBook();
        } catch (e) {
            sessionValidUntil = 0; // may be a dead session: re-verify before the next poll acts
            if (is401(e)) rejectedToken = token;
            throw e;
        }
    },
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
