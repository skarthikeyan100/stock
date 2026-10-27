import Log from '../../util/Log';
import { recordOrderOwner } from './orderOwners';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';

// One loop for every broker's resting limit orders: track, poll, book the fill, book a partial fill on cancel, tell the
// cancelled listeners, untrack. The per-broker part (where statuses come from) is a BrokerOrderAdapter.

export type TrackerBroker = 'prism' | 'kite' | 'ant' | 'breeze';

export interface PendingOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
}

export interface OrderStatus {
    status: string; // COMPLETE | REJECTED | CANCELLED | CANCELED | anything else = still pending
    fillPrice?: number;
    filledQuantity?: number;
    /** Overrides the adapter's after-close rule: true = do not tell the cancelled listeners for this terminal state. */
    skipListener?: boolean;
}

export interface BrokerOrderAdapter<T extends PendingOrder, Snapshot, B extends TrackerBroker = TrackerBroker> {
    broker: B;
    /** Mongo collection the pending orders persist in (the persisted shape is the order object itself). */
    collection: string;
    /** The token the position is keyed by on the strategy side (Prism/Kite: instrumentId, Breeze: antToken). */
    tokenOf(order: T): string;
    /** False skips the whole poll tick quietly (e.g. no valid broker session). */
    ready?(): Promise<boolean>;
    /** Log prefix, e.g. 'Prism'. */
    label: string;
    /** One broker read per poll tick, shared by every pending order. Throwing skips the tick. */
    fetchSnapshot(): Promise<Snapshot>;
    statusOf(order: T, snapshot: Snapshot): Promise<OrderStatus>;
    /** The snapshot row's own average price, for when statusOf reports no fill price (NaN when unknown). */
    rowPrice(order: T, snapshot: Snapshot): number;
    /** Rebuilds an order from its persisted document. */
    fromDoc(row: any): T;
    /** A cancelled order after the close is left to the next morning's reconcile instead of re-placed. Default: false. */
    isPastClose?(): boolean;
}

export type CancelledListener<B extends TrackerBroker = TrackerBroker> = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: B, orderId: string, reason: 'CANCELLED' | 'REJECTED') => void;

export class PendingOrderTracker<T extends PendingOrder, Snapshot, B extends TrackerBroker = TrackerBroker> {
    private readonly pending = new Map<string, T>();
    // Orders already ALERTed for a missing fill price (logged once, not every poll).
    private readonly noPriceAlerted = new Set<string>();
    private readonly cancelledListeners: CancelledListener<B>[] = [];
    private pollInFlight = false;

    constructor(private readonly adapter: BrokerOrderAdapter<T, Snapshot, B>) {}

    onCancelled = (listener: CancelledListener<B>): void => { this.cancelledListeners.push(listener); };

    get = (orderId: string): T | undefined => this.pending.get(orderId);

    find = (userId: string, tradingSymbol: string): T[] =>
        Array.from(this.pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);

    track = (order: T): void => {
        recordOrderOwner(order.orderId, order.userId, this.adapter.broker);
        this.pending.set(order.orderId, order);
        Mongo.getInstance()?.db.collection(this.adapter.collection)
            .replaceOne({ orderId: order.orderId }, order, { upsert: true })
            .catch((e) => Log.log(`[order] ${this.adapter.collection}: Mongo persist failed for`, order.orderId, e));
    };

    untrack = (orderId: string): void => {
        this.pending.delete(orderId);
        this.noPriceAlerted.delete(orderId);
        Mongo.getInstance()?.db.collection(this.adapter.collection).deleteOne({ orderId })
            .catch((e) => Log.log(`[order] ${this.adapter.collection}: Mongo delete failed for`, orderId, e));
    };

    // Called once at order-process startup, before the poll interval starts - restores orders still resting from before the restart.
    loadFromMongo = async (): Promise<void> => {
        const db = Mongo.getInstance()?.db;
        if (!db) return;
        const rows = await db.collection(this.adapter.collection).find({}).toArray();
        for (const row of rows) this.pending.set(row.orderId, this.adapter.fromDoc(row));
        if (rows.length > 0) {
            Log.log(`[order] ${this.adapter.collection}: restored ${rows.length} pending limit order(s) after restart`);
        }
    };

    poll = async (): Promise<void> => {
        if (this.pollInFlight) return; // overlapping polls would double-process (and double-notify) the same order
        this.pollInFlight = true;
        try {
            await this.pollOnce();
        } finally {
            this.pollInFlight = false;
        }
    };

    private async pollOnce(): Promise<void> {
        if (this.pending.size === 0) return;
        const { label } = this.adapter;
        if (this.adapter.ready && !(await this.adapter.ready())) return;
        let snapshot: Snapshot;
        try {
            snapshot = await this.adapter.fetchSnapshot();
        } catch (e) {
            Log.log(`[order] poll pending ${label} limit orders: fetch failed:`, e);
            return;
        }
        for (const [orderId, order] of Array.from(this.pending)) {
            if (!this.pending.has(orderId)) continue;
            try {
                await this.pollOrder(orderId, order, snapshot);
            } catch (e) {
                Log.log(`[order] poll pending ${label} limit orders: failed to poll order`, orderId, e);
            }
        }
    }

    private async pollOrder(orderId: string, order: T, snapshot: Snapshot): Promise<void> {
        const { label, broker } = this.adapter;
        const { status, fillPrice, filledQuantity, skipListener } = await this.adapter.statusOf(order, snapshot);
        // Books `qty` filled at `price`. The order is untracked only AFTER the fill is booked, so a recordFill
        // failure is retried on the next poll (recordFill dedupes on brokerOrderId).
        const bookFill = async (qty: number, price: number) => {
            const trade = new Trade();
            trade.tsym = order.tradingSymbol;
            trade.token = this.adapter.tokenOf(order);
            trade.quantity = qty;
            trade.price = price;
            trade.lastTradePrice = price;
            trade.action = order.action;
            trade.status = 'COMPLETE';
            trade.user = order.userId;
            trade.broker = broker;
            trade.brokerOrderId = orderId;
            await bookkeeping.recordFill(trade);
            Log.log(`[order] Pending ${label} limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} qty=${qty} at ${trade.price}`);
        };
        if (status === 'COMPLETE') {
            const price = fillPrice && fillPrice > 0 ? fillPrice : this.adapter.rowPrice(order, snapshot);
            if (!(price > 0)) {
                // Kept tracked, never dropped: the fill is real and unbooked, so the next poll retries once the book carries a price.
                if (!this.noPriceAlerted.has(orderId)) {
                    this.noPriceAlerted.add(orderId);
                    Log.log(`[order] ALERT: Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE but no fill price reported - KEPT in tracking, retrying each poll, manual review required`);
                }
                return;
            }
            await bookFill(order.quantity, price);
            this.noPriceAlerted.delete(orderId);
            this.untrack(orderId);
        } else if (status === 'REJECTED' || status === 'CANCELLED' || status === 'CANCELED') {
            // A cancelled order can carry a partial fill: book it, report only the remainder.
            const filledQty = Math.min(order.quantity, Number(filledQuantity ?? 0));
            if (filledQty > 0) {
                const partialPrice = fillPrice && fillPrice > 0 ? fillPrice : this.adapter.rowPrice(order, snapshot);
                if (partialPrice > 0) {
                    await bookFill(filledQty, partialPrice);
                    this.noPriceAlerted.delete(orderId);
                } else {
                    // Kept tracked so a later poll can book the partial once a price shows; untracking here lost the fill.
                    if (!this.noPriceAlerted.has(orderId)) {
                        this.noPriceAlerted.add(orderId);
                        Log.log(`[order] ALERT: ${label} order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled with ${filledQty} filled but no fill price - KEPT in tracking, retrying each poll, manual review required`);
                    }
                    return;
                }
            }
            this.untrack(orderId);
            const remainingQty = order.quantity - filledQty;
            if (remainingQty <= 0) return;
            const isCancelled = status === 'CANCELLED' || status === 'CANCELED';
            if (skipListener ?? (isCancelled && !!this.adapter.isPastClose?.())) {
                Log.log(`[order] Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close (or expired) - leaving re-placement to tomorrow's reconcile()`);
            } else {
                const reason = status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                // Isolated: the order is already untracked, so one throwing listener must not stop the others being told.
                for (const listener of this.cancelledListeners) {
                    try {
                        listener(order.userId, order.tradingSymbol, this.adapter.tokenOf(order), remainingQty, order.exchange, order.action, broker, orderId, reason);
                    } catch (e) {
                        Log.log(`[order] ${label} cancelled listener failed for ${orderId}:`, e);
                    }
                }
                Log.log(`[order] Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}`);
            }
        }
        // else: still pending, leave in map for the next poll
    }
}
