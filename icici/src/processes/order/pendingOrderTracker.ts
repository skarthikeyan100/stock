import Log from '../../util/Log';
import { recordOrderOwner } from './orderOwners';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import { OptionExchange } from './BrokerExecutor';
import Mongo from '../../tools/mongo';

// One loop for every broker's resting limit orders: track, poll, book the fill, book a partial fill on cancel, tell the
// cancelled listeners, untrack. The per-broker part (where statuses come from) is a BrokerOrderAdapter.

export type TrackerBroker = 'prism' | 'kite' | 'ant' | 'breeze';

export interface PendingOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    quantity: number;
    exchange: OptionExchange;
    action: 'Buy' | 'Sell';
}

export interface OrderStatus {
    /** fillPrice is the order's AVERAGE fill price, not the last fill's: it books the whole fill and any partial fill. */
    status: string; // COMPLETE | REJECTED | CANCELLED | CANCELED | anything else = still pending
    fillPrice?: number;
    filledQuantity?: number;
    /** True = do not tell the cancelled listeners about this terminal state (e.g. an after-close cancel/expiry, left to the next morning's reconcile). */
    skipListener?: boolean;
    /** Broker's reason for a REJECTED order, passed on to the cancelled listeners. */
    rejectReason?: string;
}

export interface BrokerOrderAdapter<T extends PendingOrder, Snapshot, B extends TrackerBroker = TrackerBroker> {
    broker: B;
    /** Mongo collection the pending orders persist in (the persisted shape is the order object itself). */
    collection: string;
    /** The token the position is keyed by on the strategy side (Prism/Kite: instrumentId, Breeze: antToken). */
    tokenOf(order: T): string;
    /** False skips the whole poll tick with an ALERT (re-logged every 30 min): the broker cannot be read, e.g. no valid session. */
    ready?(): Promise<boolean>;
    /** Log prefix, e.g. 'Prism'. */
    label: string;
    /** One broker read per poll tick, shared by every pending order. Throwing skips the tick. */
    fetchSnapshot?(): Promise<Snapshot>;
    statusOf(order: T, snapshot: Snapshot): Promise<OrderStatus>;
    /** The snapshot row's own average price, for when statusOf reports no fill price (NaN when unknown). */
    rowPrice?(order: T, snapshot: Snapshot): number;
    /** Books a fill even when the broker reports no usable price (at 0) instead of keeping the order tracked and retrying. Kite's historic behaviour. */
    bookAtAnyPrice?: boolean;
    /**
     * Replaces the generic fill quantity/price when the broker's own status is not enough (ANT reads its trade book).
     * 'complete': the whole fill; 'partial': what filled before a cancel. Returns undefined when no fill can be
     * determined yet (the order stays tracked); throwing retries the order on the next poll.
     */
    resolveFill?(order: T, status: OrderStatus, kind: 'complete' | 'partial'): Promise<{ quantity: number; price: number } | undefined>;
    /** Called after a status call succeeded for an order (ANT clears its verification streaks). */
    onStatusOk?(order: T): void;
    /** Called when polling an order threw. Returns true when it handled the failure (and logged it). */
    onPollError?(order: T, e: unknown): Promise<boolean>;
    /** True = a status whose order was untracked while the status call was out is ignored entirely (ANT: acting on it could re-place a sell). */
    ignoreStaleStatus?: boolean;
    /** Rebuilds an order from its persisted document. */
    fromDoc(row: any): T;
}

export type CancelledListener<B extends TrackerBroker = TrackerBroker> = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: OptionExchange, action: 'Buy' | 'Sell', broker: B, orderId: string, reason: 'CANCELLED' | 'REJECTED', rejectReason?: string) => void;

// Every broker call in a poll is bounded, so one stalled socket cannot hold pollInFlight (and every later tick) forever.
const BROKER_CALL_TIMEOUT_MS = 45_000;
// A whole poll gives up starting new orders after this long, so N slow orders cannot hold pollInFlight for N x the call timeout.
const POLL_BUDGET_MS = 120_000;
// A not-ready broker is re-alerted at most this often.
const NOT_READY_REALERT_MS = 30 * 60_000;
function bounded<V>(what: string, call: Promise<V>): Promise<V> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${BROKER_CALL_TIMEOUT_MS}ms`)), BROKER_CALL_TIMEOUT_MS); });
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

export class PendingOrderTracker<T extends PendingOrder, Snapshot, B extends TrackerBroker = TrackerBroker> {
    private readonly pending = new Map<string, T>();
    // Orders already ALERTed for a missing fill price (logged once, not every poll).
    private readonly noPriceAlerted = new Set<string>();
    private readonly cancelledListeners: CancelledListener<B>[] = [];
    private pollInFlight = false;
    private pollOffset = 0;
    // Orders an executor is in the middle of cancelling (see beginCancel): a poll must not untrack or notify for them.
    private readonly cancelling = new Map<string, number>();
    // Orders whose CANCELLED/REJECTED outcome must not reach the listeners (see silenceListeners); cleared by untrack.
    private readonly silenced = new Set<string>();
    private notReadyAlertedAt = 0;

    constructor(private readonly adapter: BrokerOrderAdapter<T, Snapshot, B>) {}

    onCancelled = (listener: CancelledListener<B>): void => { this.cancelledListeners.push(listener); };

    // Bracket an explicit cancel (cancelOrderWithFillRecheck): fills are still booked meanwhile, but a CANCELLED/REJECTED poll
    // result neither untracks nor tells the cancelled listeners - the cancelling caller owns both.
    silenceListeners = (orderId: string): void => { if (this.pending.has(orderId)) this.silenced.add(orderId); };
    beginCancel = (orderId: string): void => { this.cancelling.set(orderId, (this.cancelling.get(orderId) ?? 0) + 1); };
    endCancel = (orderId: string): void => {
        const n = (this.cancelling.get(orderId) ?? 0) - 1;
        if (n > 0) this.cancelling.set(orderId, n); else this.cancelling.delete(orderId);
    };

    get = (orderId: string): T | undefined => this.pending.get(orderId);

    find = (userId: string, tradingSymbol: string): T[] =>
        Array.from(this.pending.values()).filter((o) => o.userId === userId && o.tradingSymbol === tradingSymbol);
    // Every order this tracker is watching, any user and symbol (lock-profits cancels resting refill buys it cannot name by symbol).
    all = (): T[] => Array.from(this.pending.values());

    track = (order: T): void => {
        recordOrderOwner(order.orderId, order.userId, this.adapter.broker);
        this.pending.set(order.orderId, order);
        // `token` is the canonical name of the position's token (REFACTOR_PLAN.md section 3); the broker-specific field (instrumentId /
        // instrumentToken / antToken) is still stored too, for builds that read it, and either is accepted on load (fromDoc).
        Mongo.getInstance()?.db.collection(this.adapter.collection)
            .replaceOne({ orderId: order.orderId }, { ...order, token: this.adapter.tokenOf(order) }, { upsert: true })
            .catch((e) => Log.log(`[order] ${this.adapter.collection}: Mongo persist failed for`, order.orderId, e));
    };

    untrack = (orderId: string): void => {
        // Cancelled/rejected resting buys never fill, so nothing else would free the reservation they took (no-op after a fill).
        bookkeeping.releaseReservationForOrder(orderId);
        this.pending.delete(orderId);
        this.noPriceAlerted.delete(orderId);
        this.silenced.delete(orderId);
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
        if (this.pending.size === 0) {
            this.notReadyAlertedAt = 0;
            return;
        }
        const { label } = this.adapter;
        try {
            if (this.adapter.ready && !(await bounded('ready', this.adapter.ready()))) {
                if (Date.now() - this.notReadyAlertedAt >= NOT_READY_REALERT_MS) {
                    this.notReadyAlertedAt = Date.now();
                    Log.log(`[order] ALERT: ${label} not ready (no valid session?) - ${this.pending.size} pending limit order(s) are NOT being monitored`);
                }
                return;
            }
            this.notReadyAlertedAt = 0;
        } catch (e) {
            if (Date.now() - this.notReadyAlertedAt >= NOT_READY_REALERT_MS) {
                this.notReadyAlertedAt = Date.now();
                Log.log(`[order] ALERT: poll pending ${label} limit orders: readiness check failed - ${this.pending.size} order(s) NOT monitored:`, e);
            }
            return;
        }
        let snapshot: Snapshot;
        try {
            snapshot = (this.adapter.fetchSnapshot ? await bounded('fetchSnapshot', this.adapter.fetchSnapshot()) : undefined) as Snapshot;
        } catch (e) {
            Log.log(`[order] poll pending ${label} limit orders: fetch failed:`, e);
            return;
        }
        const pollStartedAt = Date.now();
        // Resumes where the previous poll's budget ran out, so orders behind a slow one are not starved.
        const entries = Array.from(this.pending);
        const start = entries.length > 0 ? this.pollOffset % entries.length : 0;
        let nextOffset = start + 1;
        const ordered = [...entries.slice(start), ...entries.slice(0, start)];
        for (let i = 0; i < ordered.length; i++) {
            const [orderId, order] = ordered[i];
            if (!this.pending.has(orderId)) continue;
            if (Date.now() - pollStartedAt > POLL_BUDGET_MS) {
                Log.log(`[order] poll pending ${label} limit orders: budget of ${POLL_BUDGET_MS}ms spent - the remaining orders are polled next tick`);
                nextOffset = start + i; // the next poll starts at the first order not reached
                break;
            }
            try {
                await this.pollOrder(orderId, order, snapshot);
            } catch (e) {
                if (this.adapter.ignoreStaleStatus && !this.pending.has(orderId)) {
                    // Untracked meanwhile: nothing left to verify - but a failure here may be a fill that was not booked, so it is not silent.
                    Log.log(`[order] poll pending ${label} limit orders: ${orderId} (${order.tradingSymbol}, ${order.userId}) failed after being untracked (usually harmless - a caller cancelled it; reconcile if a fill looks unbooked):`, e);
                    continue;
                }
                if (this.adapter.onPollError && (await bounded('onPollError', this.adapter.onPollError(order, e)).catch(() => false))) continue;
                Log.log(`[order] poll pending ${label} limit orders: failed to poll order`, orderId, e);
            }
        }
        this.pollOffset = nextOffset % Math.max(1, ordered.length || 1);
    }

    private async pollOrder(orderId: string, order: T, snapshot: Snapshot): Promise<void> {
        const { label, broker } = this.adapter;
        const orderStatus = await bounded('statusOf', this.adapter.statusOf(order, snapshot));
        const { status, fillPrice, filledQuantity, skipListener, rejectReason } = orderStatus;
        this.adapter.onStatusOk?.(order);
        if (this.adapter.ignoreStaleStatus && !this.pending.has(orderId)) return;
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
            // Deliberately not time-bounded: an abandoned recordFill keeps running with its fill id claimed, so a retry would see it as
        // booked and untrack the order even if the original then failed. A stuck recordFill is the bookkeeping layer's to bound.
        await bookkeeping.recordFill(trade);
            Log.log(`[order] Pending ${label} limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} qty=${qty} at ${trade.price}`);
        };
        if (status === 'COMPLETE' && this.adapter.resolveFill) {
            const fill = await bounded('resolveFill', this.adapter.resolveFill(order, orderStatus, 'complete'));
            if (!fill) return;
            await bookFill(fill.quantity, fill.price);
            this.untrack(orderId); // only once booked - a failed read above leaves it to retry
        } else if (status === 'COMPLETE') {
            const price = fillPrice && fillPrice > 0 ? fillPrice : (this.adapter.rowPrice?.(order, snapshot) ?? NaN);
            if (!(price > 0) && !this.adapter.bookAtAnyPrice) {
                // Kept tracked, never dropped: the fill is real and unbooked, so the next poll retries once the book carries a price.
                if (!this.noPriceAlerted.has(orderId)) {
                    this.noPriceAlerted.add(orderId);
                    Log.log(`[order] ALERT: Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE but no fill price reported - KEPT in tracking, retrying each poll, manual review required`);
                }
                return;
            }
            if (!(price > 0)) Log.log(`[order] ALERT: ${label} order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE with no usable fill price - booked at 0, manual review required`);
            await bookFill(order.quantity, price > 0 ? price : 0);
            this.noPriceAlerted.delete(orderId);
            this.untrack(orderId);
        } else if (status === 'REJECTED' || status === 'CANCELLED' || status === 'CANCELED') {
            // A cancelled order can carry a partial fill: book it, report only the remainder.
            let filledQty = Math.min(order.quantity, Number(filledQuantity ?? 0));
            if (filledQty > 0 && this.adapter.resolveFill) {
                const fill = await bounded('resolveFill', this.adapter.resolveFill(order, orderStatus, 'partial'));
                filledQty = fill?.quantity ?? 0;
                if (fill && fill.quantity > 0) await bookFill(fill.quantity, fill.price);
                // Untracked while the book was being read: the partial is booked above, but a notification would re-place a sell.
                if (this.adapter.ignoreStaleStatus && !this.pending.has(orderId)) {
                    Log.log(`[order] ALERT: ${label} order ${orderId} (${order.tradingSymbol}, ${order.userId}) was untracked while its cancelled partial fill was being booked (${filledQty} booked of ${Math.min(order.quantity, Number(filledQuantity ?? 0))} reported) - listeners NOT notified, verify the remaining quantity`);
                    return;
                }
            } else if (filledQty > 0) {
                const partialPrice = fillPrice && fillPrice > 0 ? fillPrice : (this.adapter.rowPrice?.(order, snapshot) ?? NaN);
                if (partialPrice > 0 || this.adapter.bookAtAnyPrice) {
                    if (!(partialPrice > 0)) Log.log(`[order] ALERT: ${label} order ${orderId} (${order.tradingSymbol}, ${order.userId}) partial fill of ${filledQty} with no usable price - booked at 0, manual review required`);
                    await bookFill(filledQty, partialPrice > 0 ? partialPrice : 0);
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
            // An explicit cancel is in flight for this order: its partial fill is booked above, and the caller untracks (or leaves it
            // tracked on a confirmed fill) and owns the follow-up - telling the listeners would re-place a sell it is closing.
            if (this.cancelling.has(orderId)) return;
            const silencedOrder = this.silenced.has(orderId);
            this.untrack(orderId);
            const remainingQty = order.quantity - filledQty;
            if (remainingQty <= 0) return;
            if (silencedOrder) {
                Log.log(`[order] Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status} after a fill in the cancel race - the cancelling caller owns the remainder, listeners not notified`);
            } else if (skipListener) {
                Log.log(`[order] Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close (or expired) - leaving re-placement to tomorrow's reconcile()`);
            } else {
                const reason = status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                // Isolated: the order is already untracked, so one throwing listener must not stop the others being told.
                for (const listener of this.cancelledListeners) {
                    try {
                        listener(order.userId, order.tradingSymbol, this.adapter.tokenOf(order), remainingQty, order.exchange, order.action, broker, orderId, reason, rejectReason);
                    } catch (e) {
                        Log.log(`[order] ${label} cancelled listener failed for ${orderId}:`, e);
                    }
                }
                Log.log(`[order] Pending ${label} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}${rejectReason ? ` (${rejectReason})` : ''}`);
            }
        }
        // else: still pending, leave in map for the next poll
    }
}
