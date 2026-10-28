import Kite from '../../kite/Kite';
import { isPastMarketClose } from '../../util/marketHours';
import { PendingOrder, PendingOrderTracker } from './pendingOrderTracker';

// Kite limit orders placed via placeLimitBuyBareOnKite (kiteExecutor.ts) - ContinuousStrategy's target-hit re-entries -
// and, since 2026-09-22, via placeLimitSellBareOnKite - BulkPcrStrategy's target-hit exit, which needs a resting SELL leg
// instead of a blind market order. `action` distinguishes the two so a fill is recorded as the right side. No automatic
// timeout - a resting order polls indefinitely unless explicitly cancelled (see untrackPendingLimitOrder, used by
// ContinuousStrategy's root-refill drift-cancel check). The loop itself lives in pendingOrderTracker.ts.
//
// The Mongo mirror exists so a process restart can't silently orphan a resting order's eventual fill (live incident
// 2026-09-01: a root-refill filled ~45min after placement across an order-process restart, was never recorded, and left a
// 65-lot position open at the broker with zero app-side tracking).
interface PendingLimitOrder extends PendingOrder {
    instrumentToken: string;
}

// One getOrders() call per tick (every order's latest state) instead of a getOrderHistory call per pending order: N resting chunks
// would otherwise cost N REST calls every 15s, the pattern that already hit a broker rate limit. An order missing from the snapshot
// (very new, or the list is truncated) falls back to its own history.
type KiteOrderRow = { order_id: string; status: string; average_price: number; filled_quantity: number };
const tracker = new PendingOrderTracker<PendingLimitOrder, Map<string, KiteOrderRow>, 'kite'>({
    broker: 'kite',
    collection: 'pendingLimitOrders',
    label: 'Kite',
    bookAtAnyPrice: true,
    tokenOf: (order) => order.instrumentToken,
    ready: () => Kite.getInstance().hasValidSession(),
    fetchSnapshot: async () => {
        const orders: KiteOrderRow[] = await Kite.getInstance().getKiteConnect().getOrders() as any;
        return new Map(orders.map((o) => [String(o.order_id), o]));
    },
    statusOf: async (order, snapshot) => {
        let latest: KiteOrderRow | undefined = snapshot.get(order.orderId);
        if (!latest) {
            const history = await Kite.getInstance().getKiteConnect().getOrderHistory(order.orderId);
            latest = history[history.length - 1];
        }
        if (!latest) return { status: 'PENDING' };
        // Kite Connect has no separate "EXPIRED" status - an unfilled DAY order the exchange auto-cancels at EOD comes back as
        // plain 'CANCELLED', indistinguishable from a same-day manual cancel. Re-placing after the close fails and drives the
        // position into phase='error' every EOD (live incident 2026-09-24), so a CANCELLED after the close is deferred to the next
        // morning's reconcile(). A manual cancel landing that late is rare and deferring is always safe.
        return {
            status: latest.status,
            fillPrice: latest.average_price,
            filledQuantity: Number(latest.filled_quantity ?? 0),
            skipListener: latest.status === 'CANCELLED' && isPastMarketClose(),
        };
    },
    fromDoc: (row) => ({
        orderId: row.orderId,
        userId: row.userId,
        tradingSymbol: row.tradingSymbol,
        instrumentToken: row.instrumentToken,
        quantity: row.quantity,
        exchange: row.exchange,
        action: row.action ?? 'Buy', // pre-2026-09-22 rows predate this field - all were Buy
    }),
});

export const onCancelled = tracker.onCancelled;
// Used to cancel a resting SELL leg before a force-close path (EOD expiry-day squareoff, drawdown-breach auto-squareoff -
// both in orderProcess.ts) also market-sells the same still-open quantity, which would otherwise double-sell it.
export const findPendingOrdersForSymbol = tracker.find;
// True while this order is tracked for its owner's fill booking (restored from Mongo after a restart).
export const isTrackedPendingOrder = (orderId: string): boolean => tracker.get(orderId) !== undefined;
export const trackPendingLimitOrder = tracker.track;
// Called after an explicit cancel (cancelOrderOnKite) so the poll doesn't keep polling an order we just told the broker to drop.
export const untrackPendingLimitOrder = tracker.untrack;
export const beginCancelOfPendingLimitOrders = tracker.beginCancel;
export const endCancelOfPendingLimitOrders = tracker.endCancel;
export const loadPendingLimitOrdersFromMongo = tracker.loadFromMongo;
export const pollPendingLimitOrders = tracker.poll;
