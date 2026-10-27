import ANT from '../../ant/ANT';
import { Trade } from '../../model/model';
import bookkeeping from './bookkeeping';
import Log from '../../util/Log';
import { isPastMarketClose } from '../../util/marketHours';
import { PendingOrder, PendingOrderTracker } from './pendingOrderTracker';

// ANT limit orders placed via placeLimitSellBareOnAnt (antExecutor.ts) - BulkPcrStrategy's target-hit exit, and
// ContinuousStrategy's refills. ANT can't place true MARKET orders at all ("Market orders are not allowed" - confirmed live,
// see antExecutor.ts's enterPosition comment). Own Mongo collection, not shared with Kite's/Breeze's pending trackers.
// The loop itself lives in pendingOrderTracker.ts; what is ANT-specific here is the trade-book fill resolution and the
// give-up fallback for orders AliceBlue's history endpoint can no longer answer for.
export interface PendingAntLimitOrder extends PendingOrder {
    instrumentId: string;
    product?: 'INTRADAY' | 'LONGTERM'; // see Trade.product
    // In-memory only (not persisted to Mongo - a restart gets a fresh count, which is fine, it just re-runs the same give-up
    // check a bit later). Counts consecutive non-transient (order-not-found-in-history) poll failures.
    unverifiableCount?: number;
    // Set once the give-up fallback has ALERTed for this order, so a buy/unknown order that stays tracked doesn't re-log
    // the same ALERT on every poll.
    giveUpAlerted?: boolean;
    // Consecutive polls where the sell's contract is flat at the broker but the trade book shows no fill.
    flatNoFillCount?: number;
}

// Polls (15s apart) a flat-but-no-fill sell must show before it is treated as cancelled. Guards against
// the trade book lagging the position, which would otherwise hide a real fill.
const FLAT_NO_FILL_CONFIRM_POLLS = 5;

// How long a passed session check is trusted (see ready below).
const SESSION_RECHECK_MS = 5 * 60_000;
let sessionValidUntil = 0;

// One place that builds the Trade booked for an ANT fill outside the tracker's own booking.
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

// AliceBlue's orders/history endpoint only covers the current trading day - confirmed live 2026-10-16: a 2-day-old resting
// sell polled every 15s, every single poll throwing "ANT orders/history not Ok... EC915 Failed to retrieve the order book"
// (postOrderHistory's envelope check, e.nonTransient=true). That order can NEVER be confirmed this way. After a few
// consecutive non-transient failures, fall back to live broker positions as ground truth. Returns true when it handled the
// failure (including keeping the order tracked with an ALERT), false to let the tracker log it as a plain poll failure.
async function onPollError(order: PendingAntLimitOrder, e: any): Promise<boolean> {
    const orderId = order.orderId;
    const ant = ANT.getInstance();
    sessionValidUntil = 0; // may be a dead session - re-verify it before the next poll acts on anything
    if (e?.nonTransient) {
        order.unverifiableCount = (order.unverifiableCount ?? 0) + 1;
        const UNVERIFIABLE_GIVE_UP_AFTER = 3;
        if (order.unverifiableCount >= UNVERIFIABLE_GIVE_UP_AFTER) {
            // Drop ONLY a SELL whose contract is provably flat at the broker (the sell is gone:
            // filled or cancelled). Everything else stays tracked and is re-checked next poll:
            // a BUY with no position yet may still fill and then needs its exit, and a failed or
            // non-Ok positions call tells us nothing. The strict flag makes a non-Ok envelope throw
            // instead of reading as "no positions". ALERT once per order to avoid per-poll noise.
            // Every ANT order goes through the one ANT session, whatever app-level user (or strategy pseudo-user) placed it, so the
            // broker's own positions/trade book answer for this order. (The old check compared ANT's account id with the app
            // userId, which never matches - it kept every unverifiable order tracked forever.)
            let dropOrder = false;
            try {
                const positions = await ant.getPositions({ strict: true });
                const stillOpen = (positions || []).some((p: any) =>
                    (p.tradingSymbol ?? p.tsym ?? p.symbol) === order.tradingSymbol && Number(p.netQuantity ?? p.netQty ?? p.netqty ?? 0) !== 0
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
            if (dropOrder) tracker.untrack(orderId);
            return true;
        }
    }
    return false;
}

const tracker = new PendingOrderTracker<PendingAntLimitOrder, null, 'ant'>({
    broker: 'ant',
    collection: 'pendingAntLimitOrders',
    label: 'ANT',
    tokenOf: (order) => order.instrumentId,
    // hasValidSession() is a full positions fetch (ANT has no lighter auth check), so it is not run on every 15s poll. A failed
    // status call clears the window (onPollError) so the next poll re-checks at once.
    ready: async () => {
        if (Date.now() < sessionValidUntil) return true;
        if (!(await ANT.getInstance().hasValidSession())) return false;
        sessionValidUntil = Date.now() + SESSION_RECHECK_MS;
        return true;
    },
    statusOf: async (order) => {
        const res = await ANT.getInstance().getOrderStatus(order.orderId);
        // ANT has no separate EOD-expiry status either (same gap as Kite): an unfilled DAY order auto-cancelled at exchange
        // close reports back as plain 'CANCELLED'. Defer the listener past market close to avoid re-placing against a closed
        // exchange (live incident 2026-09-24) - tomorrow's reconcile() handles it.
        return { ...res, skipListener: res.status === 'CANCELLED' && isPastMarketClose() };
    },
    // A successful history lookup means this order IS findable: clear the non-transient and flat-no-fill streaks.
    onStatusOk: (order) => {
        order.unverifiableCount = 0;
        order.flatNoFillCount = 0;
    },
    // A square-off or re-price may have taken this order off the book while the status call was in flight. Acting on that
    // stale status could re-place a sell for quantity already sold.
    ignoreStaleStatus: true,
    resolveFill: async (order, status, kind) => {
        const ant = ANT.getInstance();
        if (kind === 'complete') {
            // No price on a COMPLETE record: take the fill from the trade book rather than dropping it.
            if (status.fillPrice) return { quantity: order.quantity, price: status.fillPrice };
            const book = await ant.getFilledFromTradeBook(order.orderId);
            if (!(book.quantity > 0 && book.avgPrice > 0)) {
                Log.log(`[order] Pending ANT limit order ${order.orderId} (${order.tradingSymbol}, ${order.userId}) COMPLETE with no fill price or trade-book fill - manual review required`);
                return undefined;
            }
            return { quantity: book.quantity, price: book.avgPrice };
        }
        // Partial fill before a cancel, both sides (an ANT Buy partial otherwise left an untracked, unprotected position).
        const book = await ant.getFilledFromTradeBook(order.orderId);
        // The status shows fills the trade book doesn't have yet: wait for the book, don't guess.
        if (book.quantity < (status.filledQuantity ?? 0)) {
            throw new Error(`cancelled ${order.action.toLowerCase()} ${order.orderId}: status shows ${status.filledQuantity} filled, trade book ${book.quantity} - retrying on next poll`);
        }
        // Quantity without a price is an incomplete book read: retry next poll, never book a zero price.
        if (book.quantity > 0 && !(book.avgPrice > 0)) throw new Error(`cancelled ${order.action.toLowerCase()} ${order.orderId}: trade book shows ${book.quantity} with no average price - retrying on next poll`);
        Log.log(`[order] Pending ANT ${order.action.toLowerCase()} ${order.orderId} (${order.tradingSymbol}) cancelled after ${book.quantity} filled - ${order.quantity - book.quantity} unfilled`);
        return { quantity: book.quantity, price: book.avgPrice };
    },
    onPollError,
    fromDoc: (row) => ({
        orderId: row.orderId,
        userId: row.userId,
        tradingSymbol: row.tradingSymbol,
        instrumentId: row.instrumentId,
        quantity: row.quantity,
        exchange: row.exchange,
        action: row.action ?? 'Sell',
        product: row.product,
    }),
});

export const onCancelled = tracker.onCancelled;
export const findPendingOrdersForSymbol = tracker.find;
export const trackPendingAntLimitOrder = tracker.track;
export const untrackPendingAntLimitOrder = tracker.untrack;
export const loadPendingAntLimitOrdersFromMongo = tracker.loadFromMongo;
export const pollPendingAntLimitOrders = tracker.poll;
export const pendingAntSellsFor = (userId: string, tradingSymbol: string): PendingAntLimitOrder[] =>
    tracker.find(userId, tradingSymbol).filter((o) => o.action === 'Sell');
export const isPendingAntOrder = (orderId: string): boolean => tracker.get(orderId) !== undefined;
