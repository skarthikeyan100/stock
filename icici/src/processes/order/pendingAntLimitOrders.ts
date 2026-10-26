import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Mongo from '../../tools/mongo';
import { isPastMarketClose } from '../../util/marketHours';

// Mirrors pendingLimitOrders.ts (Kite) exactly, for ANT limit orders
// placed via placeLimitSellBareOnAnt (antExecutor.ts) - BulkPcrStrategy's
// target-hit exit. ANT can't place true MARKET orders at all ("Market
// orders are not allowed" - confirmed live, see antExecutor.ts's
// enterPosition comment), so this only needs to cover the SELL side added
// 2026-09-22; a Buy variant can be added the same way if a bare ANT limit
// buy primitive is ever needed. Own Mongo collection, not shared with
// Kite's/Breeze's pending trackers.
const PENDING_COLLECTION = 'pendingAntLimitOrders';

export interface PendingAntLimitOrder {
    orderId: string;
    userId: string;
    tradingSymbol: string;
    instrumentId: string;
    quantity: number;
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
    product?: 'INTRADAY' | 'LONGTERM'; // see Trade.product
    // In-memory only (not persisted to Mongo - a restart gets a fresh count,
    // which is fine, it just re-runs the same give-up check a bit later).
    // Counts consecutive non-transient (order-not-found-in-history) poll
    // failures - see pollPendingAntLimitOrders's use of this below.
    unverifiableCount?: number;
    // Set once the give-up fallback has ALERTed for this order, so a buy/unknown order that
    // stays tracked doesn't re-log the same ALERT on every poll.
    giveUpAlerted?: boolean;
    // Consecutive polls where the sell's contract is flat at the broker but the trade book shows no fill.
    flatNoFillCount?: number;
}

// Polls (15s apart) a flat-but-no-fill sell must show before it is treated as cancelled. Guards against
// the trade book lagging the position, which would otherwise hide a real fill.
const FLAT_NO_FILL_CONFIRM_POLLS = 5;

const pending = new Map<string, PendingAntLimitOrder>();

// How long a passed session check is trusted by pollPendingAntLimitOrders (see its use there).
const SESSION_RECHECK_MS = 5 * 60_000;
let sessionValidUntil = 0;

// One place that builds the Trade booked for an ANT fill, so every booking path records the same shape.
function buildAntFillTrade(order: PendingAntLimitOrder, orderId: string, quantity: number, price: number, action: 'Buy' | 'Sell'): Trade {
    const trade = new Trade();
    trade.tsym = order.tradingSymbol;
    trade.token = order.instrumentId;
    trade.quantity = quantity;
    trade.price = price;
    trade.lastTradePrice = price;
    trade.action = action;
    trade.status = 'COMPLETE';
    trade.user = order.userId;
    trade.broker = 'ant';
    trade.brokerOrderId = orderId;
    return trade;
}

// See pendingLimitOrders.ts's cancelledListeners for why this exists.
type CancelledListener = (userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', action: 'Buy' | 'Sell', broker: 'ant', orderId: string, reason: 'CANCELLED' | 'REJECTED', rejectReason?: string) => void;
const cancelledListeners: CancelledListener[] = [];
export function onCancelled(listener: CancelledListener): void { cancelledListeners.push(listener); }

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

export function pendingAntSellsFor(userId: string, tradingSymbol: string): PendingAntLimitOrder[] {
    return findPendingOrdersForSymbol(userId, tradingSymbol).filter((o) => o.action === 'Sell');
}

export function isPendingAntOrder(orderId: string): boolean {
    return pending.has(orderId);
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
            product: row.product,
        });
    }
    if (rows.length > 0) {
        Log.log(`[order] loadPendingAntLimitOrdersFromMongo: restored ${rows.length} pending limit order(s) after restart`);
    }
}

// Called on an interval from orderProcess.ts, using ANT.getOrderStatus's
// single-shot check (unlike Kite's kc.getOrderHistory/Breeze's
// getOrderDetail, ANT has no separate "poll status" vs "poll until fill"
// distinction in this codebase yet - getOrderStatus is the one-shot form
// added specifically for this poller, see ANT.ts).
export async function pollPendingAntLimitOrders(): Promise<void> {
    if (pending.size === 0) return;
    const ant = ANT.getInstance();
    // hasValidSession() is a full positions fetch (ANT has no lighter auth check), so it is not run on
    // every 15s poll. A failed status call below clears the window so the next poll re-checks at once.
    if (Date.now() >= sessionValidUntil) {
        if (!(await ant.hasValidSession())) return;
        sessionValidUntil = Date.now() + SESSION_RECHECK_MS;
    }

    for (const [orderId, order] of pending) {
        try {
            const { status, fillPrice, filledQuantity, rejectReason } = await ant.getOrderStatus(orderId);
            order.unverifiableCount = 0; // a successful history lookup means this order IS findable - clear any earlier non-transient streak
            order.flatNoFillCount = 0; // ...and the flat-no-fill streak is broken by a verifiable poll too
            // A square-off or re-price may have taken this order off the book while the status call was in
            // flight. Acting on that stale status could re-place a sell for quantity already sold.
            if (!pending.has(orderId)) continue;
            if (status === 'COMPLETE') {
                // No price on a COMPLETE record: take the fill from the trade book rather than dropping it.
                let price = fillPrice;
                let quantity = order.quantity;
                if (!price) {
                    const book = await ant.getFilledFromTradeBook(orderId);
                    if (!(book.quantity > 0 && book.avgPrice > 0)) {
                        Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE with no fill price or trade-book fill - manual review required`);
                        continue;
                    }
                    price = book.avgPrice;
                    quantity = book.quantity;
                }
                const trade = buildAntFillTrade(order, orderId, quantity, price, order.action);
                await bookkeeping.recordFill(trade);
                untrackPendingAntLimitOrder(orderId); // only once booked - a failed read above leaves it to retry
                Log.log(`[order] Pending ANT limit order filled: ${order.tradingSymbol} (${order.userId}) ${order.action} at ${trade.price}`);
            } else if (status === 'REJECTED' || status === 'CANCELLED') {
                // Book any partial fill BEFORE taking the order off the book. If the book read or the booking
                // throws, the order stays tracked and the next poll retries it - nothing is lost.
                let remaining = order.quantity;
                if (order.action === 'Sell' && (filledQuantity ?? 0) > 0) {
                    const book = await ant.getFilledFromTradeBook(orderId);
                    // The status shows fills the trade book doesn't have yet: wait for the book, don't guess.
                    if (book.quantity < (filledQuantity ?? 0)) {
                        throw new Error(`cancelled sell ${orderId}: status shows ${filledQuantity} filled, trade book ${book.quantity} - retrying on next poll`);
                    }
                    if (book.quantity > 0) {
                        await bookkeeping.recordFill(buildAntFillTrade(order, orderId, book.quantity, book.avgPrice, 'Sell'));
                    }
                    remaining = order.quantity - book.quantity;
                    Log.log(`[order] Pending ANT sell ${orderId} (${order.tradingSymbol}) cancelled after ${book.quantity} filled - ${remaining} unfilled`);
                }
                untrackPendingAntLimitOrder(orderId);
                // ANT has no separate EOD-expiry status either (same gap as Kite - see pendingLimitOrders.ts):
                // an unfilled DAY order auto-cancelled at exchange close reports back as plain 'CANCELLED'.
                // Defer the listener past market close to avoid re-placing against a closed exchange
                // (live incident 2026-09-24) - tomorrow's reconcile() handles it. Fills are already booked above.
                if (status === 'CANCELLED' && isPastMarketClose()) {
                    Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) cancelled after market close - leaving re-placement to tomorrow's reconcile()`);
                } else if (remaining > 0) {
                    const reason = status === 'REJECTED' ? 'REJECTED' : 'CANCELLED';
                    for (const listener of cancelledListeners) {
                        listener(order.userId, order.tradingSymbol, order.instrumentId, remaining, order.exchange, order.action, 'ant', orderId, reason, rejectReason);
                    }
                    Log.log(`[order] Pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) ${status}${rejectReason ? ` (${rejectReason})` : ''}`);
                }
            }
            // else: still pending, leave in map for the next poll
        } catch (e: any) {
            sessionValidUntil = 0; // may be a dead session - re-verify it before the next poll acts on anything
            // AliceBlue's orders/history endpoint only covers the current trading
            // day - confirmed live 2026-10-16: a 2-day-old resting sell polled
            // every 15s, every single poll throwing "ANT orders/history not Ok...
            // EC915 Failed to retrieve the order book" (postOrderHistory's
            // envelope check, e.nonTransient=true). That order can NEVER be
            // confirmed this way - without a give-up path, this just logs
            // identical noise forever. After a few consecutive non-transient
            // failures, fall back to live broker positions as ground truth:
            // if the underlying contract isn't open at all, the order is
            // provably no longer live (filled/cancelled/expired some other way)
            // and safe to drop; if a position IS still open, dropping the
            // tracking entry doesn't lose anything either - this specific
            // order id was never going to resolve via history regardless, so
            // continuing to poll it contributes nothing - but it's logged as
            // an ALERT instead of a silent drop so it still gets manual review.
            if (e?.nonTransient) {
                order.unverifiableCount = (order.unverifiableCount ?? 0) + 1;
                const UNVERIFIABLE_GIVE_UP_AFTER = 3;
                if (order.unverifiableCount >= UNVERIFIABLE_GIVE_UP_AFTER) {
                    // Drop ONLY a SELL whose contract is provably flat at the broker (the sell is gone:
                    // filled or cancelled). Everything else stays tracked and is re-checked next poll:
                    // a BUY with no position yet may still fill and then needs its exit, and a failed or
                    // non-Ok positions call tells us nothing. The strict flag makes a non-Ok envelope throw
                    // instead of reading as "no positions". ALERT once per order to avoid per-poll noise.
                    // The singleton ANT session belongs to ONE user. Only when it is this order's own account can
                    // the positions/trade-book checks say anything about the order; for any other account the order
                    // stays tracked with a single ALERT (no per-poll position calls) until a human resolves it.
                    if (ant.getUserId() !== order.userId) {
                        if (!order.giveUpAlerted) {
                            order.giveUpAlerted = true;
                            Log.log(`[order] ALERT: pending ANT ${order.action} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) unverifiable via order history and the ANT session belongs to another account - KEPT in tracking, manual review required.`);
                        }
                        continue;
                    }
                    let dropOrder = false;
                    try {
                        const positions = await ant.getPositions({ strict: true });
                        const stillOpen = (positions || []).some((p: any) =>
                            (p.tradingSymbol ?? p.tsym ?? p.symbol) === order.tradingSymbol && Number(p.netQty ?? p.netqty ?? 0) !== 0
                        );
                        if (order.action === 'Sell' && !stillOpen) {
                            // The sell may have FILLED while history was unavailable, and the fill-booking path
                            // above never ran. Book whatever the trade book shows before dropping it. A book read
                            // that throws leaves the order tracked (caught below) and it is retried next poll.
                            const book = await ant.getFilledFromTradeBook(orderId);
                            if (book.quantity > 0 && !(book.avgPrice > 0)) {
                                // Quantity without a price is an incomplete book read - same rule as the cancel path:
                                // retry, never book a zero price and never count it as "no fill".
                                throw new Error(`sell ${orderId}: trade book shows ${book.quantity} with no average price - retrying on next poll`);
                            }
                            if (book.quantity > 0) {
                                await bookkeeping.recordFill(buildAntFillTrade(order, orderId, book.quantity, book.avgPrice, order.action));
                                Log.log(`[order] pending ANT sell ${orderId} (${order.tradingSymbol}, ${order.userId}) not verifiable via order history - booked ${book.quantity} @ ${book.avgPrice} from the trade book`);
                                dropOrder = true;
                            } else {
                                // Flat with no fill in the book: either cancelled, or the trade book is lagging the
                                // position. Only drop after several consecutive polls agree, so a lagging book can't
                                // hide a real fill.
                                order.flatNoFillCount = (order.flatNoFillCount ?? 0) + 1;
                                if (order.flatNoFillCount >= FLAT_NO_FILL_CONFIRM_POLLS) {
                                    dropOrder = true;
                                } else {
                                    Log.log(`[order] pending ANT sell ${orderId} (${order.tradingSymbol}, ${order.userId}) flat at the broker with no trade-book fill yet (${order.flatNoFillCount}/${FLAT_NO_FILL_CONFIRM_POLLS}) - waiting for the book to confirm`);
                                }
                            }
                        } else {
                            order.flatNoFillCount = 0; // the streak is only "consecutive" while the sell is flat
                        }
                        if (dropOrder) {
                            Log.log(`[order] pending ANT limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) unverifiable via order history ${order.unverifiableCount} times in a row (likely too old for AliceBlue's order-book endpoint) and no open position exists - dropping stale tracking entry.`);
                        } else if (order.action === 'Sell' && !stillOpen) {
                            // Still in the no-fill confirmation window - not an alert yet.
                        } else if (!order.giveUpAlerted) {
                            order.giveUpAlerted = true;
                            const why = stillOpen ? 'a position IS open at the broker'
                                : order.action === 'Sell' ? 'the trade book has no fill yet (waiting for it to confirm)' : 'no position is open yet';
                            Log.log(`[order] ALERT: pending ANT ${order.action} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) unverifiable via order history ${order.unverifiableCount} times in a row and ${why} - KEPT in tracking, manual review required.`);
                        }
                    } catch (posErr: any) {
                        if (!order.giveUpAlerted) {
                            order.giveUpAlerted = true;
                            Log.log(`[order] ALERT: pending ANT ${order.action} limit order ${orderId} (${order.tradingSymbol}, ${order.userId}) unverifiable via order history and the position-check fallback failed - KEPT in tracking, will retry, manual review required: ${posErr?.message ?? posErr}`);
                        }
                    }
                    // Only now, after any fill is booked, may the order leave tracking.
                    if (dropOrder) untrackPendingAntLimitOrder(orderId);
                    continue;
                }
            }
            Log.log('[order] pollPendingAntLimitOrders: failed to poll order', orderId, e);
        }
    }
}
