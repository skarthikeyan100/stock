import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import Breeze from '../../breeze/Breeze';
import Kite from '../../kite/Kite';
import bookkeeping from './bookkeeping';
import { TRACKERS } from './pendingTrackers';
import { BUY_FILL_WAIT } from '../../util/fillWait';
import { OptionExchange, OrderAlreadyFilledError } from './BrokerExecutor';

// The resting limit orders a frontend user placed at the price they clicked (a buy: lockedEntry.ts, a square-off: lockedSquareOff.ts), as the
// trading page needs them: what is still pending, what happened to the ones that left, and cancel. The durable records are Mongo `entryExits`
// (buys) and `userExitSells` (sells) plus the brokers' pending-order trackers; the maps here are only an index of them, rebuilt at startup, and
// the outcome list is display only. Nothing here controls trading.

export type LockedBroker = 'kite' | 'ant' | 'breeze';
export const LOCKED_BROKERS: readonly LockedBroker[] = ['kite', 'ant', 'breeze'];
export const isLockedBroker = (b: string): b is LockedBroker => (LOCKED_BROKERS as readonly string[]).includes(b);

export interface LockedOrder {
    orderId: string;
    broker: LockedBroker;
    userId: string;
    action: 'Buy' | 'Sell';
    tsym: string;
    token: string;
    exchange: OptionExchange;
    quantity: number;
    price: number;
    placedAt: number;
    clickId?: string;
    mirrorOf?: { userId: string; clickId: string };
}

export interface OrderOutcome {
    id: string; userId: string; at: number; broker: string; tsym: string; action: 'Buy' | 'Sell'; quantity: number; price: number;
    status: 'filled' | 'cancelled' | 'rejected'; reason?: string;
}

export interface PendingOrderRow {
    orderId: string; broker: LockedBroker; userId: string; tsym: string; token: string; action: 'Buy' | 'Sell';
    quantity: number; filled: number; price: number; placedAt: number;
}

const ours = new Map<string, LockedOrder>();
const outcomes: OrderOutcome[] = [];
const OUTCOME_KEEP_MS = 30 * 60_000;
const OUTCOME_MAX = 300;
const keyOf = (broker: string, orderId: string) => `${broker}:${orderId}`;

export function registerLockedOrder(o: LockedOrder): void { ours.set(keyOf(o.broker, o.orderId), o); }
export const allLockedOrders = (): LockedOrder[] => Array.from(ours.values());

type Tracked = { orderId: string; userId: string; quantity: number; exchange: OptionExchange; seenFilled?: number };
export function trackedOrder(broker: LockedBroker, orderId: string): Tracked | undefined {
    return (TRACKERS[broker].all() as Tracked[]).find((o) => o.orderId === orderId);
}

export function pendingLockedOrders(): PendingOrderRow[] {
    const rows: PendingOrderRow[] = [];
    for (const broker of LOCKED_BROKERS) {
        for (const t of TRACKERS[broker].all() as Tracked[]) {
            const o = ours.get(keyOf(broker, t.orderId));
            if (!o) continue;
            rows.push({ orderId: o.orderId, broker, userId: o.userId, tsym: o.tsym, token: o.token, action: o.action, quantity: t.quantity, filled: Number(t.seenFilled) || 0, price: o.price, placedAt: o.placedAt });
        }
    }
    return rows;
}

/** Everything the trading page's price stream needs from the order process (read-only; also how it learns that locked-price orders are supported). */
export function userOrderState() {
    const cutoff = Date.now() - OUTCOME_KEEP_MS;
    return {
        lockedPrice: true,
        pending: pendingLockedOrders(),
        positions: bookkeeping.trades.filter((t) => t.quantity > 0 && !!t.token).map((t) => ({ user: t.user, broker: t.broker ?? 'kite', tsym: t.tsym, token: String(t.token) })),
        outcomes: outcomes.filter((o) => o.at >= cutoff),
    };
}

/** A bell notification for the owner of the order (the frontend process polls the `notifications` collection and pushes it). */
export function notifyUser(user: string, message: string): void {
    Mongo.getInstance()?.db?.collection('notifications').insertOne({ user, type: 'order', message, read: false, createdAt: new Date() })
        .catch((e) => Log.log('[order] locked order notification failed:', e));
}

function addOutcome(o: LockedOrder, status: OrderOutcome['status'], quantity: number, price: number, reason?: string): void {
    outcomes.push({ id: `${o.broker}:${o.orderId}:${status}:${outcomes.length}:${Date.now()}`, userId: o.userId, at: Date.now(), broker: o.broker, tsym: o.tsym, action: o.action, quantity, price, status, ...(reason ? { reason } : {}) });
    if (outcomes.length > OUTCOME_MAX) outcomes.splice(0, outcomes.length - OUTCOME_MAX);
}

/** bookkeeping.onFill listener. */
export function onLockedFill(_userId: string, trade: { broker?: string; brokerOrderId?: string; quantity: number; price: number }): void {
    if (!trade.brokerOrderId) return;
    const o = ours.get(keyOf(trade.broker ?? 'kite', String(trade.brokerOrderId)));
    if (o) addOutcome(o, 'filled', trade.quantity, trade.price);
}

type CancelledHook = (o: LockedOrder) => void;
const buyEndedHooks: CancelledHook[] = [];
/** lockedEntry.ts: a user's resting buy ended without (the rest of) its fill, so the admin's copy of it is cancelled too. */
export function onLockedBuyEnded(hook: CancelledHook): void { buyEndedHooks.push(hook); }
function buyEnded(o: LockedOrder): void {
    for (const h of buyEndedHooks) { try { h(o); } catch (e) { Log.log('[order] locked buy-ended hook failed:', e); } }
}

/** A pending-order tracker reports an order cancelled or rejected at the broker (not by a cancel of ours). */
export function onLockedTrackerCancel(broker: string, orderId: string, remaining: number, reason: 'CANCELLED' | 'REJECTED', rejectReason?: string): void {
    const o = ours.get(keyOf(broker, orderId));
    if (!o) return;
    const status = reason === 'REJECTED' ? 'rejected' : 'cancelled';
    const report = (why?: string) => {
        addOutcome(o, status, remaining, o.price, why);
        notifyUser(o.userId, `Limit ${o.action.toLowerCase()} of ${remaining} ${o.tsym} at ${o.price} was ${status} by the broker${why ? `: ${why}` : ''}.${o.action === 'Sell' ? ' The position is still open.' : ''}`);
    };
    // Kite's pending-order status carries no reason: read the rejection message from the order itself, so the user is told why.
    if (status === 'rejected' && !rejectReason && o.broker === 'kite') {
        kiteRejectMessage(orderId).then(report, () => report());
    } else {
        report(rejectReason);
    }
    if (o.action === 'Buy') buyEnded(o);
}

async function kiteRejectMessage(orderId: string): Promise<string | undefined> {
    const history: any[] = await Kite.getInstance().getKiteConnect().getOrderHistory(orderId) as any;
    return history[history.length - 1]?.status_message || undefined;
}

/** Polls the broker's pending orders a few times right after a placement, so a fill that comes at once is booked (and protected) in seconds, not at the next 15 s tick. */
export function kickPoll(broker: LockedBroker): void {
    for (const delay of [700, 2000, 4500, 8000]) {
        const t = setTimeout(() => { TRACKERS[broker].poll().catch((e) => Log.log(`[order] early poll of ${broker} pending orders failed:`, e)); }, delay);
        t.unref?.();
    }
}

export interface CancelResult { status: 'cancelled' | 'filled' | 'unconfirmed'; filledQuantity?: number }

type AfterCancel = (o: LockedOrder, r: CancelResult) => Promise<void>;
const afterCancel: AfterCancel[] = [];
export function onLockedCancelDone(hook: AfterCancel): void { afterCancel.push(hook); }

type CancelFn = (broker: LockedBroker, userId: string, orderId: string, exchange: OptionExchange) => Promise<void>;
let cancelAtBroker: CancelFn | undefined;
/** Wired by orderProcess (the executors import too much to be imported here). */
export function setLockedCanceller(fn: CancelFn): void { cancelAtBroker = fn; }

/** Cancels one resting locked-price order of `userId`. A fill that raced the cancel is reported ('filled') and booked by the poller. */
export async function cancelLockedOrder(userId: string, broker: string, orderId: string, why: string): Promise<CancelResult> {
    if (!isLockedBroker(broker)) throw new Error(`cancel is not supported on ${broker}`);
    const o = ours.get(keyOf(broker, orderId));
    if (!o || o.userId !== userId) throw new Error('No such pending order');
    if (!trackedOrder(broker, orderId)) throw new Error('This order is no longer pending (it filled, or was cancelled already)');
    if (!cancelAtBroker) throw new Error('cancel is not available');
    Log.log(`[order] cancelling the resting limit ${o.action} ${o.tsym} qty=${o.quantity} @ ${o.price} (${orderId}, ${userId}, ${broker}): ${why}`);
    let result: CancelResult;
    try {
        await cancelAtBroker(broker, userId, orderId, o.exchange);
        result = trackedOrder(broker, orderId) ? { status: 'unconfirmed' } : { status: 'cancelled' };
    } catch (e) {
        if (!(e instanceof OrderAlreadyFilledError)) throw e;
        result = { status: 'filled', filledQuantity: e.filledQuantity };
    }
    if (result.status !== 'cancelled') kickPoll(broker); // books what filled
    if (result.status === 'cancelled') addOutcome(o, 'cancelled', o.quantity, o.price);
    // A complete fill leaves nothing to cancel anywhere else; anything short of it ended (part of) the order.
    if (o.action === 'Buy' && !(result.status === 'filled' && (result.filledQuantity ?? 0) >= o.quantity)) buyEnded(o);
    for (const h of afterCancel) await h(o, result).catch((e) => Log.log('[order] after-cancel step failed for', orderId, e));
    return result;
}

// A partly filled resting BUY books (and gets its target / stop) only once the order is over, so the rest is not left waiting: once it has been
// partly filled this long AND the order is at least BUY_FILL_WAIT old (a buy is never cancelled for not filling before that, user's rule
// 2026-11-27), it is cancelled, and the filled part is booked and protected.
export const PARTIAL_FILL_GRACE_MS = 20_000;
const partialSince = new Map<string, number>();

async function filledSoFar(o: LockedOrder, t: Tracked): Promise<number> {
    if (o.broker !== 'breeze') return Number(t.seenFilled) || 0;
    // Breeze's pending status carries no filled quantity in the tracker: read it from the order itself.
    const r: any = await Breeze.getInstance().getOrderDetail(o.exchange, o.orderId);
    const rec = Array.isArray(r?.Success) ? r.Success[0] : r?.Success;
    if (!rec) return 0;
    const quantity = Number(rec.quantity) > 0 ? Number(rec.quantity) : t.quantity;
    const pending = Number(rec.pending_quantity);
    if (!Number.isFinite(pending)) return 0;
    return Math.max(0, quantity - pending - (Number(rec.cancelled_quantity) || 0));
}

export async function sweepPartialBuys(now: number = Date.now()): Promise<void> {
    const live = new Set<string>();
    for (const row of pendingLockedOrders()) {
        if (row.action !== 'Buy') continue;
        const key = keyOf(row.broker, row.orderId);
        const o = ours.get(key)!;
        const t = trackedOrder(row.broker, row.orderId);
        if (!t) continue;
        live.add(key);
        let filled = 0;
        try { filled = await filledSoFar(o, t); } catch (e: any) { Log.log(`[order] partial-fill check of ${row.orderId} failed:`, e?.message ?? e); continue; }
        if (!(filled > 0 && filled < t.quantity)) { partialSince.delete(key); continue; }
        const since = partialSince.get(key);
        if (since === undefined) { partialSince.set(key, now); continue; }
        if (now - since < PARTIAL_FILL_GRACE_MS || now - o.placedAt < BUY_FILL_WAIT.ms) continue;
        partialSince.delete(key);
        try {
            const r = await cancelLockedOrder(o.userId, o.broker, o.orderId, `partly filled (${filled}/${t.quantity}) ${Math.round((now - o.placedAt) / 60_000)} min after placement`);
            notifyUser(o.userId, `Limit buy of ${o.tsym} at ${o.price} filled only partly (${r.filledQuantity ?? filled} of ${t.quantity}); the rest was cancelled and the bought quantity gets your target / stop-loss.`);
        } catch (e) {
            Log.log(`[order] ALERT: partly filled limit buy ${o.orderId} (${o.tsym}, ${o.userId}) could not be cancelled - the filled part has no target / stop until the order ends:`, e);
        }
    }
    for (const key of Array.from(partialSince.keys())) if (!live.has(key)) partialSince.delete(key);
}
