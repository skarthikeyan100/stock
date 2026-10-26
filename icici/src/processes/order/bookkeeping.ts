import Log from '../../util/Log';
import { randomUUID } from 'crypto';
import Mongo from '../../tools/mongo';
import Kite from '../../kite/Kite';
import ANT from '../../ant/ANT';
import Breeze from '../../breeze/Breeze';
import { Trade } from '../../model/model';
import { UserContext, closeUserAccount } from '../../user';
import { PUT, CALL, USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from '../../constants';
import * as exitMonitor from './exitMonitor';
import configService from '../../prism/ConfigService';
import { drawdownLimit, drawdownDecision } from '../../prism/percentConfig';
import { startOfWeek } from '../../util/weekWindow';
import AntContractMaster from '../../ant/AntContractMaster';
import { normalizeBrokerName, normalizeBrokerList } from '../../util/brokerName';

// Open-P&L pricing gets a short budget: it runs inside every buy's drawdown check, so a slow quote must not stall an order.
const OPEN_PNL_TIMEOUT_MS = 4_000;
const OPEN_PNL_LOG_EVERY_MS = 60_000;

// Local YYYY-MM-DD, same key as PnlStop's latch day.
function dayKeyLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Order-process-local replacement for Monitor's bookkeeping (trades/closedTrades,
// risk limits, order<->user attribution, P&L). Ported from src/monitor.ts, with
// everything quote-driven removed: no AntStream subscribe/unsubscribe. Target/SL
// exits are a GTT placed once at entry (see kiteExecutor.ts) for users with
// useGTT=true; for useGTT=false users, exitMonitor.ts watches the tick feed
// piped in from `data` (see orderProcess.ts) and squares off in-app instead.
// Strategy notification (Monitor.strategyMap) is replaced by fillListeners,
// pushed out over the order<->strategies IPC socket by orderProcess.ts.

// Breeze's underlying breezeconnect SDK calls have no configured HTTP
// timeout anywhere (unlike ANT's ANT_HTTP_TIMEOUT_MS-bound axios instance or
// kiteconnect's own default) - a hung/slow Breeze call inside
// reconcileBreezePositions would otherwise never resolve, and since
// orderProcess.ts's canPlaceOrder/squareOff/openTrades/placeOrderWithPendingGuard
// all now await reconcileInFlight (see that file's comment), a stuck Breeze
// reconcile would block every user's order placement AND square-off/
// emergency-stop indefinitely, not just Breeze's own. Bounds the promise so
// reconcileBreezePositions's existing catch-and-continue behavior (see below)
// kicks in on a timeout too, same as a genuine rejection.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type FillListener = (userId: string, trade: Trade) => void;
type PositionsChangedListener = () => void;
type DrawdownBreachListener = (userId: string) => void;

interface UserSettings {
    lossLimit: number;
    lotLimit?: number;
    maxInvestment?: number;
    investmentMode?: string;
    investmentAmount?: number;
    useGTT?: boolean;
    broker?: 'kite' | 'ant' | 'breeze';
    perOrderCap?: number;
    allottedCapital?: number;
    targetPoints?: number;
    stopLossPoints?: number;
    accountClosed?: boolean;
}

// One reservation per in-flight, not-yet-resolved buy request. A Set<string>
// can't represent two concurrent pending orders for the same user (a second
// add() is a no-op, and a single delete() would wipe out both) - that's
// exactly the gap this whole fix closes, so this must be a per-user list.
interface PendingOrder {
    estimatedLots: number;  // always 1: a conservative reservation - real
                             // quantity isn't always known yet (see buyIndex/
                             // antBuyIndex, which resolve it inside the
                             // broker executor)
    estimatedValue: number; // mirrors canPlaceOrder's estimatedOrderValue
                             // param; 0 when the caller didn't have one
                             // (buyIndex/antBuyIndex) - those get lot-limit
                             // protection while pending but not investment-
                             // limit protection
    broker?: string;        // which broker this reservation is for - lets
                             // releasePending/pendingValue scope to the same
                             // (user, broker) pair maxInvestment now gates on
                             // (see canPlaceOrder's own comment); undefined
                             // for a caller that never resolved one (treated
                             // as "any broker" by the broker-scoped filters)
}

// Bound on any Mongo call the fill path awaits. A hung socket must not stall
// fill handling; a timed-out ledger read resolves to the caller's fallback
// (drawdown reads then report 'unknown' - buys blocked, nothing liquidated).
const LEDGER_TIMEOUT_MS = 5_000;
// A closed-trade row that keeps failing is retried until it lands (flushed on every fill and on a timer);
// the failure is logged at error level every this-many attempts rather than on each one.
const CLOSED_ROW_ERROR_LOG_EVERY = 20;
const CLOSED_ROW_FLUSH_INTERVAL_MS = 60_000;
const RECENTLY_LANDED_MS = 30_000;
function withFallbackTimeout<T, F>(p: Promise<T>, ms: number, fallback: F, label: string): Promise<T | F> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<F>((resolve) => {
        timer = setTimeout(() => {
            Log.log(`[order] ${label} timed out after ${ms}ms`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    // Separate ledger for a strategy's legitimate SHORT positions (e.g. ButterflyStrategy's
    // sell-to-open legs) - deliberately NOT `trades` above, which every existing Buy/Sell
    // branch in _processTradeEvent treats as long-only (see recordShortFill's own comment).
    // Keyed identically to `trades`: (tsym, user, broker).
    shortTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingOrders: Map<string, PendingOrder[]> = new Map();
    // Square-off (exit/sell) in-flight guard, keyed by `${userId}:${tsym}` -
    // set synchronously at the very top of squareOffOnAnt (antExecutor.ts),
    // before any await, and released in a finally block there. Prevents a
    // manual square-off and exitMonitor's (or the drawdown-breach handler's)
    // auto-triggered exit from both issuing a live SELL order for the same
    // trade when they fire close together. Entirely separate from
    // pendingUsers/pendingOrders (the BUY-side reservation, unrelated - square-off
    // never goes through canPlaceOrder) - do not merge the two.
    pendingSquareOffs: Set<string> = new Set();
    // brokerOrderId values already processed by recordFill, so a redelivered
    // fill event (reconnect replay, webhook retry) doesn't double-book P&L.
    // In-memory/per-process-lifetime only - matches this file's existing
    // in-memory-state conventions (see CLAUDE.md).
    private processedFillIds: Set<string> = new Set();
    // Per-session, per-user set of drawdown-warning thresholds (80, 100) already
    // notified, so a losing streak doesn't spam a fresh notification per trade.
    private notifiedThresholds: Map<string, Set<number>> = new Map();
    userSettingsCache: Map<string, UserSettings> = new Map();
    private fillListeners: FillListener[] = [];
    private positionsChangedListeners: PositionsChangedListener[] = [];
    private drawdownBreachListeners: DrawdownBreachListener[] = [];

    onFill(listener: FillListener) {
        this.fillListeners.push(listener);
    }

    // Registered from orderProcess.ts (which has access to both broker
    // executors - bookkeeping.ts can't import them, they already import it,
    // same problem exitMonitor.ts's onExit(broker, handler) solves). Fired
    // from _processTradeEvent when a closing trade pushes the user past the
    // daily or weekly drawdown limit, so the listener can square off their
    // remaining open positions.
    onDrawdownBreach(listener: DrawdownBreachListener) {
        this.drawdownBreachListeners.push(listener);
    }

    // Broader than onFill - fires on every trades/closedTrades mutation
    // (fills, closes, and target/SL edits), not just completed fills. Feeds
    // GET /positionstream's per-user SSE push in the frontend process.
    onPositionsChanged(listener: PositionsChangedListener) {
        this.positionsChangedListeners.push(listener);
    }

    private notifyPositionsChanged() {
        for (const l of this.positionsChangedListeners) l();
    }

    // Public entry point for callers outside this class that can't call
    // notifyPositionsChanged() directly (see exitMonitor.ts's onPriceUpdate,
    // wired up in orderProcess.ts - exitMonitor.ts can't import this module
    // directly, since this module already imports exitMonitor.ts).
    triggerPositionsChanged(): void {
        this.notifyPositionsChanged();
    }

    updateUserSettings(user: string, settings: UserSettings) {
        this.userSettingsCache.set(user, settings);
    }

    getUserLossLimit(user: string): number {
        return this.userSettingsCache.get(user)?.lossLimit ?? USER_LOSS_LIMIT;
    }

    getUserLotLimit(user: string): number {
        return this.userSettingsCache.get(user)?.lotLimit ?? DEFAULT_LOT_LIMIT;
    }

    getUserMaxInvestment(user: string): number {
        return this.userSettingsCache.get(user)?.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
    }

    getUserUseGTT(user: string): boolean {
        return this.userSettingsCache.get(user)?.useGTT ?? true;
    }

    // A strategy with no explicit `userId:` in config.yml runs under its own
    // type name as a pseudo-user (StrategyFactory.createStrategy: userId =
    // config.userId || config.type) - there's no real per-email user account
    // for that pseudo-user, so userSettingsCache (populated from the Users
    // collection, keyed by email) never has an entry for it, and every
    // strategy's own `broker:` config field was silently ignored, always
    // falling back to the 'kite' default below regardless of what was
    // configured. Used only as a FALLBACK, after userSettingsCache, in
    // getUserBroker below - a real user's own account-level broker
    // preference must still win over a strategy's config broker if that
    // strategy was ever given an explicit `userId:` equal to a real email
    // (config's broker overriding a human's own setting with no log/error
    // would be a silent, surprising precedence hazard otherwise).
    private getStrategyConfigBroker(user: string): 'kite' | 'ant' | 'breeze' | undefined {
        const strategy = configService.getConfig().strategies?.find((s) => (s.userId || s.type) === user);
        return strategy?.broker ? (normalizeBrokerName(strategy.broker) as 'kite' | 'ant' | 'breeze') : undefined;
    }

    getUserBroker(user: string): 'kite' | 'ant' | 'breeze' {
        const userBroker = this.userSettingsCache.get(user)?.broker;
        return userBroker ? (normalizeBrokerName(userBroker) as 'kite' | 'ant' | 'breeze') : this.getStrategyConfigBroker(user) ?? 'kite';
    }

    getUserPerOrderCap(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.perOrderCap;
    }

    // undefined signals "no per-user override" - callers fall back to their
    // own strategy-level config.yml value (see ContinuousStrategy.capitalCheck).
    getUserAllottedCapital(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.allottedCapital;
    }

    // undefined signals "no per-user override" - callers fall back to
    // config.yml's global settings.targetPriceDiff/stopLossPriceDiff (see
    // kiteExecutor.ts/antExecutor.ts's target/stopLoss point resolution).
    getUserTargetPoints(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.targetPoints;
    }

    getUserStopLossPoints(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.stopLossPoints;
    }

    getUserContext(email: string): UserContext {
        const cache = this.userSettingsCache.get(email);
        const investmentAmount = cache?.investmentAmount ?? 0;
        return {
            email,
            lossLimit: cache?.lossLimit ?? USER_LOSS_LIMIT,
            lotCount: cache?.lotLimit ?? DEFAULT_LOT_LIMIT,
            investmentMode: (cache?.investmentMode ?? 'investmentAmount') as 'lotCount' | 'investmentAmount',
            investmentAmount,
            availableAmount: investmentAmount - this.getCurrentInvestment(email),
        };
    }

    // Fallback only - callers that already resolved a contract from a broker's own contract
    // master (AntContractMaster/KiteContractMaster/BreezeContractMaster) should pass that
    // contract's own lotSize instead (see orderProcess.ts's resolveChunkedBuyQuantity), since
    // this name-based guess doesn't recognize every index and a wrong guess sizes an order to
    // a quantity the broker rejects as not a multiple of the real lot size (live 2026-10-21,
    // SENSEX sized against this 65 default instead of its real 20).
    getInstrumentLotSize(tsym: string): number {
        if (tsym.startsWith('BANKNIFTY')) return 15;
        if (tsym.startsWith('FINNIFTY')) return 25;
        if (tsym.startsWith('SENSEX')) return 20;
        return 65;
    }

    // Broker-agnostic manual-buy sizing: an explicit quantity always wins;
    // otherwise a user on investmentMode='investmentAmount' gets as many
    // lots as their remaining capital covers at the given price (at least
    // one lot if they have any headroom at all), and everyone else falls
    // back to a single lot - unchanged from the prior default behavior.
    resolveManualBuyQuantity(userId: string, tsym: string, price: number, explicitQuantity?: number): number {
        if (explicitQuantity != null) return explicitQuantity;
        const lotSize = this.getInstrumentLotSize(tsym);
        const ctx = this.getUserContext(userId);
        if (ctx.investmentMode === 'investmentAmount' && ctx.availableAmount > 0 && price > 0) {
            const lots = Math.max(1, Math.floor(ctx.availableAmount / (price * lotSize)));
            return lots * lotSize;
        }
        return lotSize;
    }

    // Used by chunkedBuyIndex (orderProcess.ts) when a caller passes
    // quantity: -1, meaning "spend whatever investment headroom is left" -
    // mirrors resolveManualBuyQuantity's lot-sizing-from-available-capital
    // math above, but driven by maxInvestment/getCurrentInvestment (the cap
    // BulkPcrStrategy-style pseudo-users actually use - see canPlaceOrder's
    // own comment) rather than investmentAmount/availableAmount, which only
    // real per-user accounts have configured. Nets out pendingValue() too
    // (not just confirmed trades), same as canPlaceOrder's own check.
    //
    // `broker` scopes getCurrentInvestment/pendingValue to that broker only -
    // maxInvestment is checked per (user, broker), not per user alone (see
    // canPlaceOrder's comment), so two configured brokers for the same
    // strategy pseudo-user (BulkPcrStrategy.enterOnBroker fires every
    // configured broker concurrently via Promise.allSettled) each size
    // against their OWN headroom instead of racing a single shared pool -
    // this closes the "together request up to ~2x maxInvestment" gap this
    // comment used to describe for the multi-broker case. A narrower race
    // remains WITHIN one broker: two concurrent chunkedBuyIndex calls for the
    // same (user, broker) whose own async price-fetches are both in flight
    // before either reaches markPending can still each compute against the
    // same full, undebited per-broker headroom - canPlaceOrder's post-hoc
    // ratchet check only blocks a THIRD such call once pending+current has
    // already reached that broker's cap, it does not shrink an in-flight one.
    // Returns 0 (never negative, never a fraction of a lot) when there's no
    // headroom left or the price/lotSize inputs are non-positive, so callers
    // can treat 0 as "nothing to buy" uniformly instead of special-casing
    // negative/NaN.
    resolveMaxInvestmentQuantity(user: string, pricePerUnit: number, lotSize: number, broker?: string): number {
        if (!(pricePerUnit > 0) || !(lotSize > 0)) return 0;
        const available = this.getUserMaxInvestment(user) - this.getCurrentInvestment(user, broker) - this.pendingValue(user, broker);
        if (available <= 0) return 0;
        const lots = Math.floor(available / (pricePerUnit * lotSize));
        return lots * lotSize;
    }

    getTradedLots(user: string): number {
        return this.trades
            .filter((t) => t.user === user)
            .reduce((sum, t) => sum + Math.ceil(t.quantity / this.getInstrumentLotSize(t.tsym)), 0);
    }

    hasActiveTrade(user: string): boolean {
        return this.trades.some((t) => t.user === user) || (this.pendingOrders.get(user)?.length ?? 0) > 0;
    }

    getOpenTrades(user: string): Trade[] {
        return this.trades.filter((t) => t.user === user);
    }

    // `broker` scopes the sum to this user's trades on that broker only - see
    // canPlaceOrder's own comment for why maxInvestment is now checked per
    // (user, broker). Omitted, sums across every broker (the original,
    // user-wide behavior still used by callers - e.g. getUserContext - that
    // intentionally want the whole-user total).
    getCurrentInvestment(user: string, broker?: string): number {
        return this.trades
            .filter((t) => t.user === user && (broker === undefined || t.broker === broker))
            .reduce((sum, t) => sum + t.price * t.quantity, 0);
    }

    isInvestmentLimitReached(user: string, broker?: string): boolean {
        return this.getCurrentInvestment(user, broker) >= this.getUserMaxInvestment(user);
    }

    // Called by orderProcess.ts immediately after canPlaceOrder() returns
    // allowed:true and before the broker call, so a concurrent canPlaceOrder()
    // call for the same user sees this reservation for the duration of the
    // broker round trip - this is what closes the race where two concurrent
    // requests both read only confirmed trades and both pass. Every
    // markPending() must be paired with exactly one releasePending() call -
    // either from the fill path (_processTradeEvent, already wired) or from
    // orderProcess.ts's failure path (placeOrderWithPendingGuard) - or the
    // reservation leaks and this user is blocked until the next fill.
    markPending(user: string, estimatedOrderValue?: number, broker?: string): void {
        const list = this.pendingOrders.get(user) ?? [];
        list.push({ estimatedLots: 1, estimatedValue: estimatedOrderValue ?? 0, broker });
        this.pendingOrders.set(user, list);
    }

    // Releases exactly one pending reservation for `user` - never all of them -
    // so releasing/resolving one in-flight order can't silently drop a
    // different, still-in-flight order's reservation for the same user. Safe
    // to call when nothing is pending (no-op), so both the fill path and
    // orderProcess's failure path can call it unconditionally.
    //
    // When `broker` is given, releases the oldest reservation tagged with
    // THAT broker, not just the oldest overall - a plain user-wide FIFO would
    // otherwise sometimes release a different broker's reservation (e.g. two
    // concurrent legs for the same strategy pseudo-user on kite and
    // breeze), permanently leaking the broker whose own order this call is
    // actually for while wrongly freeing up headroom for the other. Falls
    // back to the oldest entry overall if no entry tagged with this broker is
    // found (e.g. broker omitted, or every pending caller for this user left
    // it undefined) - matches the old plain-FIFO behavior for single-broker
    // users.
    releasePending(user: string, broker?: string): void {
        const list = this.pendingOrders.get(user);
        if (!list || list.length === 0) return;
        const idx = broker !== undefined ? list.findIndex((p) => p.broker === broker) : 0;
        list.splice(idx === -1 ? 0 : idx, 1);
        if (list.length === 0) this.pendingOrders.delete(user);
    }

    private pendingLots(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedLots, 0);
    }

    // `broker` scopes the sum to reservations tagged with that broker only -
    // see canPlaceOrder's own comment on why maxInvestment is now checked per
    // (user, broker), not per user alone. Omitted (undefined), it sums every
    // pending reservation for this user regardless of broker - the original,
    // user-wide behavior still used by callers that don't need per-broker
    // scoping.
    private pendingValue(user: string, broker?: string): number {
        return (this.pendingOrders.get(user) ?? [])
            .filter((p) => broker === undefined || p.broker === broker)
            .reduce((sum, p) => sum + p.estimatedValue, 0);
    }

    private static startOfDay(): Date {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Realized P&L only (not unrealized/open-position exposure), summed from
    // the closedTrades collection (see persistClosedTrade) rather than the
    // in-memory, never-resetting userPnL map, so the daily/weekly window is
    // correct across process restarts. Returns 0 (never blocks) on a Mongo
    // hiccup - matches this file's existing "don't let Mongo block live
    // trading" convention (see persistClosedTrade's comment).
    // Returns null when the ledger cannot be read. Callers that gate on this
    // (the drawdown checks) must fail closed on null, not treat it as zero loss.
    private async getRealizedPnLSince(user: string, since: Date): Promise<number | null> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db) return null;
            // recentlyLanded keeps just-written rows visible briefly, so a row that commits after the
            // find scanned but leaves unpersistedClosed before the second snapshot is still counted.
            type HeldRow = { user: string; realizedPnL: number; exitTime: Date };
            const snapshotHeld = (): [string, HeldRow][] => {
                const cutoff = Date.now() - RECENTLY_LANDED_MS;
                for (const [id, r] of this.recentlyLanded) if (r.at < cutoff) this.recentlyLanded.delete(id);
                return [...this.unpersistedClosed.entries(), ...this.recentlyLanded.entries()]
                    .filter(([, p]) => p.user === user && p.exitTime >= since);
            };
            // Snapshot held rows both BEFORE and AFTER the read, unioned by _id. Before: covers a row
            // whose insert commits after the find but returns (and leaves the map) before the second
            // snapshot. After: covers a row added while the find was running. Anything in either
            // snapshot that the read also returned is deduped below.
            const before = snapshotHeld();
            const rows = await withFallbackTimeout(
                db.collection('closedTrades').find({ user, exitTime: { $gte: since } }).toArray(),
                LEDGER_TIMEOUT_MS, null, 'closedTrades read');
            if (rows === null) return null;
            const heldSnapshot = [...new Map<string, HeldRow>([...before, ...snapshotHeld()]).entries()];
            // Held rows that have already landed are counted once, by their _id.
            const landed = new Set(rows.map((r) => String(r._id)));
            const held = heldSnapshot
                .filter(([id]) => !landed.has(id))
                .reduce((sum, [, p]) => sum + p.realizedPnL, 0);
            return rows.reduce((sum, r) => sum + (r.realizedPnL || 0), 0) + held;
        } catch (e) {
            Log.log('[order] getRealizedPnLSince failed - drawdown check will block until it can be read:', e);
            return null;
        }
    }

    // Only users with an investmentAmount configured are subject to these -
    // strategy pseudo-users (see orderProcess.ts loadUserLimits) never get
    // investmentAmount populated, and 25%/50% of an unset (0) amount would
    // instantly block every automated strategy.
    // 'unknown' means the ledger could not be read. New buys are blocked on
    // anything other than 'ok'; the sell-side liquidation trigger acts only on
    // a definite 'breached' - an unreadable ledger must never close positions.
    async drawdownState(user: string, window: 'daily' | 'weekly'): Promise<'ok' | 'breached' | 'unknown'> {
        const investmentAmount = this.userSettingsCache.get(user)?.investmentAmount;
        if (!investmentAmount) return 'ok';
        // Once today's daily breach is latched it stays breached for the day, even if the position that caused it closed at a better price.
        if (window === 'daily' && this.drawdownLatched(user)) return 'breached';
        const settings = configService.getConfig().settings as any;
        const limitPercent = window === 'daily'
            ? drawdownLimit(settings, 'maxDailyDrawdownPercent')
            : drawdownLimit(settings, 'maxWeeklyDrawdownPercent');
        const since = window === 'daily' ? OrderBookkeeping.startOfDay() : startOfWeek();
        const pnl = await this.getRealizedPnLSince(user, since);
        // Daily only: open P&L at live prices counts toward the daily loss (maxloss.md B4.2). A failed price adds 0.
        const unrealized = window === 'daily'
            ? await withFallbackTimeout(this.getOpenUnrealizedPnL(user), OPEN_PNL_TIMEOUT_MS, null, 'open P&L pricing')
            : null;
        const total = pnl === null ? null : pnl + (unrealized ?? 0);
        return drawdownDecision(total, investmentAmount, limitPercent);
    }

    // Open P&L of this user's positions at live ANT prices (maxloss.md B4.1). Long: (ltp - price) * qty; short: the reverse.
    // The token comes from the trading symbol via AntContractMaster, not Trade.token: Kite and Breeze rows carry their own
    // broker's instrument token there, which ANT would price as a different contract. Returns null when no row could be priced.
    // Never throws; a row whose quote fails counts as 0 (a failed quote must never by itself breach the limit).
    private openPnlLogAt = 0;
    async getOpenUnrealizedPnL(user: string): Promise<number | null> {
        const rows: Array<{ trade: Trade; sign: 1 | -1 }> = [
            ...this.trades.filter((t) => t.user === user).map((trade) => ({ trade, sign: 1 as const })),
            ...this.shortTrades.filter((t) => t.user === user).map((trade) => ({ trade, sign: -1 as const })),
        ];
        if (rows.length === 0) return 0;
        const quotes = new Map<string, Promise<number>>(); // one live quote per token, shared by every row on it
        let total = 0;
        let priced = 0;
        let failed = 0;
        for (const { trade, sign } of rows) {
            let token: string | undefined;
            try {
                const exch = trade.tsym.startsWith('SENSEX') ? 'BFO' : 'NFO';
                token = AntContractMaster.getInstance().findByTradingSymbol(trade.tsym, exch)?.token;
                if (!token || !Number.isFinite(trade.price) || !(trade.quantity > 0)) { failed++; continue; }
                let ltp = quotes.get(token);
                if (!ltp) {
                    ltp = ANT.getInstance().getLiveQuote(exch, token).then((q) => q.ltp);
                    quotes.set(token, ltp);
                }
                const price = await ltp;
                if (!(price > 0)) { failed++; continue; }
                total += sign * (price - trade.price) * trade.quantity;
                priced++;
            } catch (e) {
                failed++;
                if (token) quotes.delete(token); // a failed quote is retried on the next call, not cached
            }
        }
        if (failed > 0 && Date.now() - this.openPnlLogAt > OPEN_PNL_LOG_EVERY_MS) {
            this.openPnlLogAt = Date.now();
            Log.log(`[order] open P&L for ${user}: ${failed}/${rows.length} position(s) could not be priced live - counted as 0`);
        }
        return priced === 0 ? null : total;
    }

    // Users whose daily drawdown breached today (maxloss.md B4.4). Persisted so a restart keeps buys blocked.
    private drawdownLatchedDay = new Map<string, string>();
    private drawdownLatched(user: string): boolean {
        return this.drawdownLatchedDay.get(user) === dayKeyLocal();
    }

    private latchDrawdown(user: string): void {
        const day = dayKeyLocal();
        this.drawdownLatchedDay.set(user, day);
        Mongo.getInstance()?.db.collection('strategyLatches')
            .updateOne({ ownerType: 'user', userId: user, scope: 'drawdown', day }, { $set: { updatedAt: new Date() } }, { upsert: true })
            .catch((e) => Log.log(`[order] drawdown latch write failed for ${user} (in-memory latch still holds):`, e));
    }

    // Startup: restores today's drawdown latches. A read failure leaves them unset but logs loudly.
    async loadDrawdownLatches(): Promise<void> {
        try {
            const day = dayKeyLocal();
            const rows = await Mongo.getInstance()?.db.collection('strategyLatches')
                .find({ ownerType: 'user', scope: 'drawdown', day }).toArray();
            for (const r of rows ?? []) this.drawdownLatchedDay.set(String(r.userId), day);
            if (rows?.length) Log.log(`[order] drawdown latch restored for today: ${rows.map((r: any) => r.userId).join(', ')}`);
        } catch (e) {
            Log.log('[order] ALERT: could not read drawdown latches - continuing UNLATCHED (realized check still applies):', e);
        }
    }

    // Periodic daily-drawdown evaluation for users with open positions (maxloss.md B4.3): open P&L moves between fills.
    // Per-user in-flight guard so a slow pass never overlaps the next tick for the same user.
    private drawdownEvalInFlight = new Set<string>();
    async evaluateOpenDrawdowns(): Promise<void> {
        const users = new Set([...this.trades, ...this.shortTrades].map((t) => t.user));
        for (const user of users) {
            if (!this.userSettingsCache.get(user)?.investmentAmount) continue; // strategy pseudo-users are skipped by design
            if (this.drawdownEvalInFlight.has(user)) continue;
            this.drawdownEvalInFlight.add(user);
            try {
                await this.checkBreachAndNotify(user);
            } finally {
                this.drawdownEvalInFlight.delete(user);
            }
        }
    }

    // Runs the daily/weekly check after a fill and acts on it. 'breached' fires
    // the liquidation listeners; 'unknown' (ledger unreadable) schedules a
    // re-check. Only a definite breach liquidates.
    private async checkBreachAndNotify(user: string): Promise<void> {
        try {
            // Not awaited: held rows are counted in the read below either way, so a slow flush must not stall the decision.
            this.flushUnpersistedClosed().catch((e) => Log.log('[order] flush of held closedTrades failed:', e));
            const daily = await this.drawdownState(user, 'daily');
            // Evaluated even when the daily limit is breached: the weekly breach closes the account and a latched
            // daily breach would otherwise mask it for the rest of the day.
            const weekly = await this.drawdownState(user, 'weekly');
            if (weekly === 'breached') this.closeAccountForWeeklyBreach(user);
            if (daily === 'breached' || weekly === 'breached') {
                if (daily === 'breached' && !this.drawdownLatched(user)) this.latchDrawdown(user);
                this.cancelDrawdownRecheck(user);
                for (const l of this.drawdownBreachListeners) l(user);
            } else if (daily === 'unknown' || weekly === 'unknown') {
                this.scheduleDrawdownRecheck(user);
            }
        } catch (e) {
            // A failed check must not silently drop enforcement: re-check later.
            Log.log('[order] drawdown check failed for', user, '- re-checking:', e);
            this.scheduleDrawdownRecheck(user);
        }
    }

    // Weekly drawdown breach closes the account: the user document is kept and flagged accountClosed, and
    // canPlaceOrder rejects every new order for a closed account. The cache flag is set synchronously so the
    // block is immediate; the Mongo write is retried on the next breach evaluation if it fails.
    private closeAccountForWeeklyBreach(user: string): void {
        const settings = this.userSettingsCache.get(user);
        if (!settings || settings.accountClosed) return;
        settings.accountClosed = true;
        const reason = `Weekly loss limit of ${drawdownLimit(configService.getConfig().settings as any, 'maxWeeklyDrawdownPercent')}% breached`;
        Log.log(`[order] Account closed for ${user}: ${reason}`);
        closeUserAccount(user, reason).catch((e) => {
            settings.accountClosed = false;
            Log.log(`[order] Failed to persist account closure for ${user} (will retry on the next breach check):`, e);
        });
    }

    private drawdownRecheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private cancelDrawdownRecheck(user: string): void {
        const timer = this.drawdownRecheckTimers.get(user);
        if (timer) clearTimeout(timer);
        this.drawdownRecheckTimers.delete(user);
    }

    // While the ledger is unreadable, re-check every 60s. Does not give up while
    // the user still has open positions - a breach during an outage must still be
    // enforced once reads succeed. Stops once nothing is open.
    private scheduleDrawdownRecheck(user: string): void {
        if (this.drawdownRecheckTimers.has(user)) return;
        const timer = setTimeout(async () => {
            this.drawdownRecheckTimers.delete(user);
            const hasOpen = this.trades.some((t) => t.user === user) || this.shortTrades.some((t) => t.user === user);
            if (!hasOpen) return;
            try {
                await this.checkBreachAndNotify(user);
            } catch (e) {
                Log.log('[order] drawdown re-check failed for', user, e);
                this.scheduleDrawdownRecheck(user);
            }
        }, 60_000);
        this.drawdownRecheckTimers.set(user, timer);
    }

    // Counts trades opened today: closed trades (from Mongo, by entryTime)
    // plus currently-open trades (from in-memory state, also by entryTime) -
    // a trade opened today counts toward the cap whether or not it's closed
    // yet.
    async hasReachedDailyTradeLimit(user: string): Promise<boolean> {
        const settings = configService.getConfig().settings as any;
        const maxTradesPerDay = settings.maxTradesPerDay ?? 10;
        const since = OrderBookkeeping.startOfDay();
        let closedToday = 0;
        try {
            const db = Mongo.getInstance()?.db;
            if (db) closedToday = await db.collection('closedTrades').countDocuments({ user, entryTime: { $gte: since } });
        } catch (e) {
            Log.log('[order] hasReachedDailyTradeLimit count failed (not blocking on this):', e);
        }
        const openToday = this.trades.filter((t) => t.user === user && t.entryTime && t.entryTime >= since).length;
        return closedToday + openToday >= maxTradesPerDay;
    }

    // estimatedOrderValue is necessarily approximate for index-based buys
    // (niftyLtp * quantity - the real option premium isn't known until
    // contract selection) but exact for buyContract's price * quantity.
    // Strategy TYPES (not literal userId strings) that get the capital-only
    // exemption below - resolved via config.yml's own `type` field, keyed by
    // (userId || type), rather than a hardcoded userId literal. A literal
    // check (`user === 'BulkPcrStrategy'`) silently stops matching the
    // moment a second instance of that type is configured under its own
    // `userId` (e.g. 'BulkPcr-NIFTY'/'BulkPcr-SENSEX') - exactly the
    // type-vs-instance gap BulkPcrStrategy.cfg()/ButterflyStrategy.cfg()
    // already guard against for their OWN config reads; this is the same
    // mistake, just inside the shared risk gate instead of a strategy's own
    // config lookup.
    private static readonly CAPITAL_ONLY_EXEMPT_TYPES = ['ContinuousStrategy', 'BulkPcrStrategy', 'HourlyStrategy'];

    private isCapitalOnlyExemptUser(user: string): boolean {
        const cfg = configService.getConfig().strategies?.find((s) => (s.userId || s.type) === user);
        return !!cfg && OrderBookkeeping.CAPITAL_ONLY_EXEMPT_TYPES.includes(cfg.type);
    }

    // `broker`, when given, scopes the maxInvestment check to this user's
    // trades/pending reservations on THAT broker only, instead of pooling
    // every broker a multi-broker strategy pseudo-user trades under one
    // shared cap - e.g. TopStockOptionsOpeningGapStrategy/BulkPcrStrategy
    // running the same userId across kite/breeze/ant, each with its own
    // maxInvestment headroom rather than racing (and potentially starving
    // each other out of) one pooled number. Every OTHER check here (lot
    // limit, per-order cap, drawdown, daily trade count) stays user-wide -
    // only capital usage is broker-scoped, since those others are either
    // already no-ops for strategy pseudo-users (see this function's own
    // exemption comment) or are deliberately meant to bound the user as a
    // whole regardless of which broker a given leg happens to run on.
    async canPlaceOrder(user: string, estimatedOrderValue?: number, broker?: string): Promise<{ allowed: boolean; reason?: string }> {
        // ContinuousStrategy manages its own risk (per-leg averaging/hedging,
        // its own allottedCapital gate in ContinuousStrategy.capitalCheck())
        // and was hitting the shared daily-trade-count limit on ordinary
        // multi-leg activity - at the user's request, only the capital-usage
        // check below still gates it; lot limit, per-order cap, drawdown
        // breach, and the trade-count limit are skipped entirely.
        //
        // BulkPcrStrategy gets the same exemption, at the user's request
        // 2026-09-23 - it hit the same shared trade-count limit purely from
        // live testing (each resting-sell chunk fill writes its own
        // closedTrades doc, so a handful of full buy->sell cycles exhausts
        // maxTradesPerDay fast), and it already self-manages via its own
        // `maxInvestment` config field, same as ContinuousStrategy. Lot
        // limit is a non-issue for it anyway (getTradedLots only counts
        // currently-open trades, which reset to 0 every time a cycle fully
        // sells out), and per-order cap/drawdown are already no-ops for any
        // strategy pseudo-user (see drawdownState's comment - they
        // never have investmentAmount configured).
        // HourlyStrategy gets the same exemption for the same reason - its own
        // `quantity: -1` config sentinel (same value BulkPcrStrategy uses, not
        // a separate per-type magic number) sizes off this same
        // maxInvestment-only gate.
        if (this.isCapitalOnlyExemptUser(user)) {
            const currentInvestment = this.getCurrentInvestment(user, broker) + this.pendingValue(user, broker);
            const maxInvestment = this.getUserMaxInvestment(user);
            if (currentInvestment >= maxInvestment) {
                return { allowed: false, reason: `User '${user}'${broker ? ` (${broker})` : ''} has reached max investment (${currentInvestment}/${maxInvestment}).` };
            }
            return { allowed: true };
        }
        const tradedLots = this.getTradedLots(user) + this.pendingLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        const currentInvestment = this.getCurrentInvestment(user, broker) + this.pendingValue(user, broker);
        const maxInvestment = this.getUserMaxInvestment(user);
        if (currentInvestment >= maxInvestment) {
            return { allowed: false, reason: `User '${user}'${broker ? ` (${broker})` : ''} has reached max investment (${currentInvestment}/${maxInvestment}).` };
        }
        const perOrderCap = this.getUserPerOrderCap(user);
        if (estimatedOrderValue !== undefined && perOrderCap !== undefined && estimatedOrderValue > perOrderCap) {
            return { allowed: false, reason: `Order value ₹${estimatedOrderValue.toFixed(2)} exceeds per-order cap ₹${perOrderCap}.` };
        }
        if (this.userSettingsCache.get(user)?.accountClosed) {
            const reason = `User '${user}' account is closed (weekly loss limit breached).`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        const dailyDrawdown = await this.drawdownState(user, 'daily');
        if (dailyDrawdown !== 'ok') {
            const reason = dailyDrawdown === 'breached'
                ? `User '${user}' has reached the maximum daily drawdown.`
                : `User '${user}' daily drawdown could not be verified (trade ledger unreadable) - buys blocked.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        const weeklyDrawdown = await this.drawdownState(user, 'weekly');
        if (weeklyDrawdown === 'breached') this.closeAccountForWeeklyBreach(user);
        if (weeklyDrawdown !== 'ok') {
            const reason = weeklyDrawdown === 'breached'
                ? `User '${user}' has reached the maximum weekly drawdown.`
                : `User '${user}' weekly drawdown could not be verified (trade ledger unreadable) - buys blocked.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        if (await this.hasReachedDailyTradeLimit(user)) {
            return { allowed: false, reason: `User '${user}' has reached the maximum number of trades for today.` };
        }
        return { allowed: true };
    }

    // `order` writes drawdown notifications directly to Mongo (own connection)
    // but can't push SSE itself - SSE terminates in the `frontend` process,
    // which polls the `notifications` collection for unread items instead
    // (see server.ts's /notificationstream). Only fires once per threshold
    // per session so a losing streak doesn't spam a notification per trade.
    private checkDrawdownNotification(user: string, cumulative: number) {
        const limit = this.getUserLossLimit(user);
        if (limit <= 0 || cumulative >= 0) return;
        const pctOfLimit = (-cumulative / limit) * 100;
        const notified = this.notifiedThresholds.get(user) ?? new Set<number>();
        for (const [threshold, type] of [[100, 'drawdown_breach'], [80, 'drawdown_warning']] as const) {
            if (pctOfLimit >= threshold && !notified.has(threshold)) {
                notified.add(100);
                notified.add(80);
                Mongo.getInstance()?.db.collection('notifications').insertOne({
                    user,
                    type,
                    message: `You've reached ${pctOfLimit.toFixed(0)}% of your session loss limit (₹${(-cumulative).toFixed(2)} of ₹${limit}).`,
                    read: false,
                    createdAt: new Date(),
                }).catch((e) => Log.log('[order] Failed to write drawdown notification for', user, ':', e));
                break; // higher threshold implies the lower one - only notify the highest newly-crossed
            }
        }
        this.notifiedThresholds.set(user, notified);
    }

    // Captures the day/cumulative-P&L/threshold numbers already in the
    // rejection reason string, structured, so a trader-facing "why was this
    // order rejected" screen can be built without re-deriving them later.
    // Fire-and-forget, same-process insert (order has its own Mongo connection).
    private logOrderRejection(user: string, reason: string) {
        Mongo.getInstance()?.db.collection('payoutDecisionLog').insertOne({
            user,
            type: 'order_rejected',
            reason,
            detail: {
                cumulativePnL: this.userPnL.get(user) || 0,
                lossLimitThreshold: this.getUserLossLimit(user),
            },
            createdAt: new Date(),
        }).catch((e) => Log.log('[order] Failed to log order rejection for', user, ':', e));
    }

    trackPendingOrder(tsym: string, user: string) {
        const queue = this.pendingOrdersByTsym.get(tsym) || [];
        queue.push(user);
        this.pendingOrdersByTsym.set(tsym, queue);
    }

    clearPendingOrder(tsym: string, user: string) {
        const queue = this.pendingOrdersByTsym.get(tsym);
        if (!queue) return;
        const idx = queue.indexOf(user);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0) this.pendingOrdersByTsym.delete(tsym);
    }

    trackOrder(orderNo: string, user: string) {
        this.orderUserMap.set(orderNo, user);
    }

    resolveUser(orderNo: string, tsym?: string): string {
        if (orderNo) {
            const user = this.orderUserMap.get(orderNo);
            if (user) return user;
        }
        if (tsym) {
            const queue = this.pendingOrdersByTsym.get(tsym);
            if (queue && queue.length > 0) return queue[0];
        }
        return 'Default';
    }

    clearOrder(orderNo: string) {
        if (orderNo) this.orderUserMap.delete(orderNo);
    }

    refreshTrades(trades: Trade[]) {
        this.trades = trades;
        this.trades.forEach((t) => (t.lastTradePrice = t.price));
    }

    // Records a fill directly (used by the Kite buy/GTT-trigger path, which
    // doesn't go through Prism's websocket 'om' message shape at all).
    async recordFill(tradeEvent: Trade): Promise<void> {
        if (tradeEvent.brokerOrderId) {
            if (this.processedFillIds.has(tradeEvent.brokerOrderId)) {
                Log.log(`[order] Ignoring redelivered fill for broker order ${tradeEvent.brokerOrderId} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            this.processedFillIds.add(tradeEvent.brokerOrderId);
        }
        try {
            await this._processTradeEvent(tradeEvent);
        } catch (e) {
            // Not booked: release the id so a retry is processed instead of silently dropped as a duplicate.
            if (tradeEvent.brokerOrderId) this.processedFillIds.delete(tradeEvent.brokerOrderId);
            throw e;
        }
        for (const l of this.fillListeners) l(tradeEvent.user || 'Default', tradeEvent);
    }

    // Dedicated recorder for a strategy's own SellToOpen/BuyToClose fills (e.g.
    // ButterflyStrategy's short legs). Never routes through _processTradeEvent's Buy/Sell
    // branches: those assume every Buy opens/adds-to a long and every Sell reduces an
    // existing long-trades entry (no-op, zero audit trail, if none exists) - a BuyToClose
    // recorded as a plain 'Buy' there would hit the "no existing entry" case and wrongly
    // create a phantom open-long that nothing ever naturally closes. Additive only - every
    // other strategy's bookkeeping behavior via recordFill/_processTradeEvent is untouched.
    async recordShortFill(tradeEvent: Trade): Promise<void> {
        if (tradeEvent.brokerOrderId) {
            if (this.processedFillIds.has(tradeEvent.brokerOrderId)) {
                Log.log(`[order] Ignoring redelivered short fill for broker order ${tradeEvent.brokerOrderId} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            this.processedFillIds.add(tradeEvent.brokerOrderId);
        }
        Log.log(`[order] ${tradeEvent.action} (short) ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        tradeEvent.entryTime = new Date();
        Mongo.getInstance()?.insert(tradeEvent).catch((e) => {
            Log.log('[order] Mongo insert failed for short fill (continuing without persistence):', tradeEvent.tsym, e);
        });

        if (tradeEvent.action === 'SellToOpen') {
            const idx = this.shortTrades.findIndex((t) => t.tsym === tradeEvent.tsym && t.user === tradeEvent.user && t.broker === tradeEvent.broker);
            if (idx === -1) {
                this.shortTrades.push(tradeEvent);
            } else {
                const t = this.shortTrades[idx];
                const traded = t.quantity * t.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                t.quantity += tradeEvent.quantity;
                t.price = (traded + newTraded) / t.quantity;
            }
        } else if (tradeEvent.action === 'BuyToClose') {
            const idx = this.shortTrades.findIndex((t) => t.tsym === tradeEvent.tsym && t.user === tradeEvent.user && t.broker === tradeEvent.broker);
            if (idx === -1) {
                Log.log(`[order] WARNING: BuyToClose for ${tradeEvent.tsym} (${tradeEvent.user}) has no matching SellToOpen entry - dropping (no phantom position created)`);
                this.notifyPositionsChanged();
                return;
            }
            const shortTrade = this.shortTrades[idx];
            // Clamp, same discipline _processTradeEvent's long-side Sell branch uses - a
            // strategy bug or a desynced close must never go negative here.
            const closeQty = Math.min(tradeEvent.quantity, shortTrade.quantity);
            if (tradeEvent.quantity > shortTrade.quantity) {
                Log.log(`[order] WARNING: BuyToClose qty ${tradeEvent.quantity} for ${tradeEvent.tsym} (${tradeEvent.user}) exceeds tracked short qty ${shortTrade.quantity} - clamping`);
            }
            // Reversed vs. the long P&L formula in _processTradeEvent: a short profits when
            // price falls (sold high, bought back low).
            const realizedPnL = (shortTrade.price - tradeEvent.price) * closeQty;
            const user = shortTrade.user || 'Default';
            const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
            this.userPnL.set(user, cumulative);
            this.checkDrawdownNotification(user, cumulative);

            const closedPortion = new Trade();
            closedPortion.tsym = shortTrade.tsym;
            closedPortion.token = shortTrade.token;
            closedPortion.quantity = closeQty;
            closedPortion.price = shortTrade.price;
            closedPortion.action = 'BuyToClose';
            closedPortion.user = user;
            closedPortion.broker = shortTrade.broker;
            closedPortion.open = false;
            closedPortion.realizedPnL = realizedPnL;
            closedPortion.entryTime = shortTrade.entryTime;
            closedPortion.exitTime = new Date();
            closedPortion.strategy = shortTrade.strategy;
            this.closedTrades.push(closedPortion);
            this.persistClosedTrade(closedPortion, user, tradeEvent.price);

            shortTrade.quantity -= closeQty;
            if (shortTrade.quantity <= 0) this.shortTrades.splice(idx, 1);
        } else {
            Log.log(`[order] WARNING: recordShortFill called with unexpected action '${tradeEvent.action}' for ${tradeEvent.tsym} - ignoring (expected SellToOpen/BuyToClose)`);
            return;
        }
        this.notifyPositionsChanged();
    }

    // Prism/Shoonya websocket 'om' message shape - kept for the legacy order path.
    async updateTradeFromPrismMessage(data: any): Promise<Trade | void> {
        const user = this.resolveUser(data.norenordno, data.tsym);
        if (data.flqty == undefined) return;

        const tradeEvent = new Trade();
        tradeEvent.tsym = data.tsym as string;
        tradeEvent.quantity = parseInt(data.qty);
        tradeEvent.price = parseFloat(data.flprc);
        tradeEvent.action = data.trantype == 'S' ? 'Sell' : 'Buy';
        tradeEvent.status = data.status;
        tradeEvent.right = tradeEvent.tsym.indexOf('P') !== -1 ? PUT : CALL;
        tradeEvent.user = user;
        tradeEvent.broker = 'prism';
        tradeEvent.brokerOrderId = data.norenordno;
        if (tradeEvent.action == 'Buy') tradeEvent.lastTradePrice = tradeEvent.price;

        const isCompleted = data.fillshares == data.qty && data.status == 'COMPLETE';
        if (!isCompleted) return;

        this.clearOrder(data.norenordno);
        await this.recordFill(tradeEvent);
        return tradeEvent;
    }

    private async _processTradeEvent(tradeEvent: Trade) {
        Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        // Every raw fill doc needs a real entryTime, not just a token's first
        // fill - restoreOneOpenTrade's `entryTime: { $gte: startOfDay() }`
        // query otherwise silently excludes later same-day fills (e.g. an
        // averaging buy) from restart recovery.
        tradeEvent.entryTime = new Date();
        // Fire-and-forget, same convention as checkDrawdownNotification/
        // persistClosedTrade elsewhere in this class - never let a Mongo
        // hiccup block live bookkeeping. The .catch() (not a try/catch,
        // which cannot catch a rejection from a promise that isn't awaited)
        // is what actually prevents an unhandled promise rejection from
        // crashing the `order` process on a transient Mongo error.
        Mongo.getInstance()?.insert(tradeEvent).catch((e) => {
            Log.log('[order] Mongo insert failed for trade event (continuing without persistence):', tradeEvent.tsym, e);
        });

        if (tradeEvent.action == 'Buy') {
            this.releasePending(tradeEvent.user || 'Default', tradeEvent.broker);
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user && t.broker == tradeEvent.broker);
            if (index == -1) {
                this.trades.push(tradeEvent);
            } else {
                const trade = this.trades[index];
                const traded = trade.quantity * trade.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                trade.quantity += tradeEvent.quantity;
                trade.price = (traded + newTraded) / trade.quantity;
            }
            // A buy that fills after a breach (a pending order) must not stay open
            // uncovered: the same check that runs on sells liquidates it.
            // Not awaited: the ledger reads must not delay this fill's publication.
            this.checkBreachAndNotify(tradeEvent.user || 'Default').catch((e) => Log.log('[order] breach check failed after buy fill:', e));
        } else {
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user && t.broker == tradeEvent.broker);
            if (index != -1) {
                const buyTrade = this.trades[index];
                const user = buyTrade.user || 'Default';

                // A single tsym+user entry here is an aggregate over every buy
                // seen for that contract (see the Buy branch above) - a strategy
                // that stacks multiple concurrent legs on the same contract
                // (e.g. ContinuousStrategy's spawn levels) can sell less than
                // the full aggregate in one fill. Reduce by the sold quantity
                // instead of closing the whole aggregate, so the remainder
                // stays tracked as open (was previously deleted outright on any
                // sell, silently orphaning the rest of the position from
                // bookkeeping - and therefore from capitalCheck/getCurrentInvestment
                // - even though it was still open at the broker).
                let sellQty = tradeEvent.quantity;
                if (sellQty > buyTrade.quantity) {
                    Log.log(`[order] WARNING: sell qty ${sellQty} for ${tradeEvent.tsym} (${user}) exceeds tracked open qty ${buyTrade.quantity} - clamping; bookkeeping may be desynced from the broker`);
                    sellQty = buyTrade.quantity;
                }

                const realizedPnL = (tradeEvent.price - buyTrade.price) * sellQty;
                const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
                this.userPnL.set(user, cumulative);
                Log.log(`[order] User '${user}' closed. P&L: ${realizedPnL.toFixed(2)}, Cumulative: ${cumulative.toFixed(2)}`);
                this.checkDrawdownNotification(user, cumulative);

                const closedPortion = new Trade();
                closedPortion.tsym = buyTrade.tsym;
                closedPortion.token = buyTrade.token;
                closedPortion.right = buyTrade.right;
                closedPortion.quantity = sellQty;
                closedPortion.price = buyTrade.price;
                closedPortion.action = 'Sell';
                closedPortion.user = user;
                closedPortion.broker = buyTrade.broker;
                closedPortion.open = false;
                closedPortion.realizedPnL = realizedPnL;
                closedPortion.entryTime = buyTrade.entryTime;
                closedPortion.exitTime = new Date();
                closedPortion.strategy = buyTrade.strategy;
                this.closedTrades.push(closedPortion);
                // Position state is updated BEFORE any await: other fills run while
                // this one awaits, and must see this fill's quantity and removal.
                buyTrade.quantity -= sellQty;
                if (buyTrade.quantity <= 0) {
                    this.trades.splice(index, 1);
                    if (buyTrade.token) exitMonitor.unregisterTrade(user, buyTrade.token);
                }

                // Not awaited: the row is counted from memory (unpersistedClosed) while its
                // write is in flight, so the breach check needs no wait on the ledger write.
                this.persistClosedTrade(closedPortion, user, tradeEvent.price);
                this.checkBreachAndNotify(user);
            }
        }
        this.notifyPositionsChanged();
    }

    // Called once at order-process startup: this.closedTrades is in-memory
    // only and doesn't survive a restart, but the 'closedTrades' Mongo
    // collection (see persistClosedTrade) is the durable record of every
    // realized trade. Reloads today's closed trades back into memory so
    // /closedtrades and /positionstream (both served from this.closedTrades,
    // not Mongo) don't go blank on every restart even though the trades were
    // never actually lost. Scoped to today (not all-time) to match the
    // existing "today" convention used elsewhere in this file (drawdown
    // checks, daily trade limit) and to keep the reload bounded.
    async loadClosedTradesFromMongo(): Promise<void> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db) return;
            const rows = await db.collection('closedTrades').find({ exitTime: { $gte: OrderBookkeeping.startOfDay() } }).toArray();
            for (const row of rows) {
                const trade = new Trade();
                trade.tsym = row.tsym;
                trade.token = row.token;
                trade.right = row.right;
                trade.quantity = row.quantity;
                trade.price = row.entryPrice;
                trade.lastTradePrice = row.exitPrice;
                trade.action = 'Sell';
                trade.status = 'COMPLETE';
                trade.user = row.user;
                trade.broker = row.broker;
                trade.open = false;
                trade.realizedPnL = row.realizedPnL;
                trade.entryTime = row.entryTime;
                trade.exitTime = row.exitTime;
                trade.strategy = row.strategy;
                this.closedTrades.push(trade);
            }
            if (rows.length > 0) {
                Log.log(`[order] Reloaded ${rows.length} closed trade(s) from Mongo for today`);
            }
        } catch (e) {
            Log.log('[order] loadClosedTradesFromMongo failed (not blocking startup):', e);
        }
    }

    // Called once at order-process startup, alongside loadClosedTradesFromMongo:
    // this.trades (currently-open positions) is in-memory only and has no
    // closedTrades-style durable "open positions" collection to reload from -
    // every fill, Buy AND Sell, gets its own raw insertOne into Mongo's `Trade`
    // collection (see _processTradeEvent), with no open/closed flag or linkage
    // between them. Not safely queryable as "current open positions" on its
    // own (would require replaying/netting fills, exactly the kind of fragile
    // logic to avoid for a live-money restore path).
    //
    // Design: the broker is ground truth for *which* contracts are actually
    // open right now, immune to any of our own process restarts. For each
    // open broker position, restoreOpenTradesForTsym (below) recovers the
    // app-only fields the broker doesn't know (user/targetPrice/
    // stopLossPrice/gttTriggerId/strategy/antOrderNo/prismCoverOrderNo) from
    // Mongo's raw Buy fills - finalizeEntry (kiteExecutor.ts/
    // antExecutor.ts)/prismExecutor.ts's buyOnPrism always set those on the
    // Trade object before calling recordFill, so the raw Mongo insert
    // already captured them. Split per-user (not just per-tsym) - see that
    // function's own comment for why that split matters once more than one
    // app user can share a broker.
    // Was NIFTY-only ("this app only trades NIFTY index options") until
    // TopStockOptionsOpeningGapStrategy started trading individual stock
    // options over ANT too - a hardcoded NIFTY-prefix filter here silently
    // excluded every one of its positions from reconcileAntPositions,
    // dropping them from bookkeeping.trades on any order-process restart (and
    // from restoreOpenTradesForTsym's resulting Mongo-event processing, which
    // is what feeds the realized-P&L bookkeeping on the eventual exit fill).
    // Broadened to any option contract (CE/PE), relying on
    // restoreOpenTradesForTsym's own per-tsym Mongo lookup (below) - not this
    // filter - as the real guard against the 2026-09-03 incident (unrelated
    // stock-option/other-index positions placed outside the app, e.g. AMBER,
    // BANKNIFTY): a tsym with no matching app-originated Buy doc in Mongo
    // restores nothing and just logs a WARNING (restoreOpenTradesForTsym's
    // `restored.length === 0` branch), so broadening the candidate set here
    // doesn't let a genuinely foreign broker position back in.
    // ANT uses TWO different tsym conventions depending on index, confirmed live
    // 2026-10-21: SENSEX/BFO has a genuine trailing 'CE'/'PE' suffix after the strike
    // (e.g. 'SENSEX26O2274300PE'), but NIFTY embeds the option-type letter right
    // before the strike with nothing after it (e.g. 'NIFTY27OCT26C23000',
    // '...P22950' - ends in digits, never 'CE'/'PE'). The old endsWith-only check
    // silently excluded every NIFTY ANT option position from reconcileAntPositions,
    // dropping them from bookkeeping.trades (and therefore every strategy's own
    // reconcile()/getOpenTrades view) on every order-process restart - the real root
    // cause of a live incident where a naked BulkPcr-NIFTY call was invisible to
    // reconcile() no matter how long the order process had been warm, since this
    // gate ran before any per-tsym Mongo lookup ever got a chance to run.
    private static isOptionContract(tsym: string | undefined): boolean {
        if (typeof tsym !== 'string') return false;
        if (tsym.endsWith('CE') || tsym.endsWith('PE')) return true;
        return /[CP]\d+$/.test(tsym);
    }

    private mergeRestored(restored: Trade[]): void {
        for (const trade of restored) {
            // Same guard as ContinuousStrategy's Fix 4 (legsByToken collision) -
            // never silently merge two broker-reported open positions on the
            // same token into one bookkeeping entry.
            if (this.trades.some((t) => t.token === trade.token && t.user === trade.user && t.broker === trade.broker)) {
                Log.log(`[order] loadOpenTradesFromBroker: REFUSING to add duplicate - token ${trade.token} (${trade.tsym}) already restored for user ${trade.user}`);
                continue;
            }
            this.trades.push(trade);
        }
        if (restored.length > 0) {
            Log.log(`[order] Reloaded ${restored.length} open trade(s) from broker`);
            exitMonitor.reconcileFromTrades(this.trades);
        }
    }

    // Run only by the explicit 'reconcileBrokerPositions' step (POST /reconcile)
    // - not at startup or on login. A stale/expired session at the time of an
    // earlier run must not leave real open positions untracked; the user re-runs
    // it after a login (2026-09-03
    // incident: session was invalid at startup, a same-session re-login later
    // fixed it, but nothing re-ran this, so bookkeeping.trades stayed empty
    // against 4 real open Kite positions).
    // Returns true only when the broker's positions were fetched and restored;
    // false means this broker could not be read (reported back to the
    // POST /reconcile caller).
    async reconcileKitePositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            const positions = await Kite.getInstance().getPositions();
            const open = (positions?.net || []).filter((p: any) => p.quantity !== 0 && OrderBookkeeping.isOptionContract(p.tradingsymbol));
            for (const p of open) {
                restored.push(...(await this.restoreOpenTradesForTsym(p.tradingsymbol, p.quantity, p.instrument_token != null ? String(p.instrument_token) : undefined, 'kite')));
            }
        } catch (e) {
            Log.log('[order] reconcileKitePositions: Kite getPositions failed (continuing without restore):', e);
            return false;
        }
        this.mergeRestored(restored);
        return true;
    }

    // Caveat, not yet live-verified: ANT's getPositions() return shape is
    // untyped/`any` and hasn't been confirmed against a real response - same
    // caveat ToDo.md already carries for AntOrderNotifyStream's norenordno/
    // flprc fields. The field names below were confirmed live 2026-10-21 against a
    // real GET /open-api/od/v1/positions response (ANT.getPositions()): quantity is
    // `netQuantity`, the instrument token is `instrumentId` - NOT `netQty`/`netqty`/
    // `token`, which was this function's previous never-observed guess and meant
    // `Number(p.netQty ?? p.netqty ?? 0)` always fell through to the `?? 0` default,
    // so this filter excluded every single ANT position regardless of quantity or
    // symbol - reconcileAntPositions had never actually restored anything. Called
    // both at startup and reactively after a successful ANT login (see
    // reconcileKitePositions's comment for why).
    async reconcileAntPositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            const positions = await ANT.getInstance().getPositions();
            const list = Array.isArray(positions) ? positions : [];
            const open = list.filter((p: any) => Number(p.netQuantity ?? 0) !== 0 && OrderBookkeeping.isOptionContract(p.tradingSymbol));
            for (const p of open) {
                const tsym = p.tradingSymbol;
                const qty = Number(p.netQuantity);
                const token = p.instrumentId != null ? String(p.instrumentId) : undefined;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, token, 'ant')));
            }
        } catch (e) {
            Log.log('[order] reconcileAntPositions: ANT getPositions failed (continuing without restore):', e);
            return false;
        }
        this.mergeRestored(restored);
        return true;
    }

    // Mirrors reconcileAntPositions's shape exactly. Without this, restarting
    // `order` while a LegManager-driven strategy (ContinuousStrategy/
    // SupportResistanceStrategy) has an open Breeze leg would leave
    // bookkeeping.trades empty for it - the strategy's own restart-reconcile
    // (LegManager.restoreFromOpenTrades) never runs since it only fires when
    // OrderClient.getOpenTrades reports something to restore, so it would
    // silently open a duplicate root leg while the real one sits open and
    // untracked at the broker. Field names (stock_code/expiry_date/
    // strike_price/right/quantity) confirmed live 2026-09-17 against a real
    // open position - see breezeExecutor.ts's getPositionsOnBreeze comment.
    async reconcileBreezePositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            // No valid session = positions can't be read, so this is NOT reconciled
            // (a logged-out Breeze must be logged in before it can be reconciled).
            if (!(await withTimeout(Breeze.getInstance().hasValidSession(), 15000, 'Breeze hasValidSession'))) return false;
            const result = await withTimeout(Breeze.getInstance().getPortfolioPositions(), 15000, 'Breeze getPortfolioPositions');
            const rows = Array.isArray(result?.Success) ? result.Success : [];
            for (const p of rows) {
                const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
                if (!optionType) continue;
                const tsym = `${p.stock_code}${p.strike_price}${optionType}`;
                const qty = Number(p.quantity ?? 0);
                if (qty === 0 || !OrderBookkeeping.isOptionContract(tsym)) continue;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, undefined, 'breeze')));
            }
        } catch (e) {
            Log.log('[order] reconcileBreezePositions: Breeze getPortfolioPositions failed (continuing without restore):', e);
            return false;
        }
        this.mergeRestored(restored);
        return true;
    }

    // Recovers the app-only fields (user/target/stopLoss/gttTriggerId/strategy)
    // for one broker-reported open position, from the most recent Buy fill(s)
    // in Mongo's raw `Trade` collection - one restored Trade PER distinct
    // user who holds it, not one merged Trade for the whole tsym. The broker
    // only reports one aggregate position per contract (it has no concept of
    // "app user" at all), so if two different app users both hold the same
    // contract via the same shared broker, treating it as a single position
    // would attribute the whole thing to whichever user's Buy doc is most
    // recent, silently losing the other user's tracked position - this was a
    // known, deliberately-deferred risk ("very low likelihood on this
    // single-account setup") until the multi-user-per-broker model made it a
    // real, expected scenario. Returns an empty array (logged loudly, not
    // thrown) when no matching doc exists for any user - a manual trade
    // placed outside the app, or a failed insert - so the caller can leave it
    // visibly untracked rather than guessing at its fields.
    // `broker` scopes every query here alongside tsym/user - without it, two
    // brokers holding the identical tsym+user (e.g. BulkPcrStrategy trading
    // NIFTY23450PE on both Kite and Breeze at once) would pool both
    // brokers' Mongo Buy/Sell docs into one blended restored position on
    // restart, corrupting quantity/avgPrice and losing which broker a
    // resting exit order belongs to.
    private async restoreOpenTradesForTsym(tsym: string, brokerQuantity: number, brokerToken: string | undefined, broker: 'kite' | 'ant' | 'breeze' | 'prism'): Promise<Trade[]> {
        const db = Mongo.getInstance()?.db;
        if (!db || !tsym) return [];

        // Matches this broker's own docs, OR any doc with no `broker` field at
        // all - every Trade document written before the broker field existed
        // has no such field, and a strict `{broker}` equality match would
        // silently exclude all of them (confirmed: MongoDB equality never
        // matches a missing field), dropping any position opened before this
        // change from restart recovery entirely. Safe to treat a fieldless
        // doc as belonging to whichever single broker is being reconciled
        // here - multi-broker overlap for one tsym+user is only possible from
        // this change onward, so a legacy fieldless doc can never actually be
        // one half of a genuine two-broker collision.
        const brokerOrLegacy = { $or: [{ broker }, { broker: { $exists: false } }] };

        // Every user who has ever bought this tsym on this broker - each
        // reconciled independently below (including their own last-Sell
        // boundary), so one user's Sell can no longer wrongly close the
        // boundary calculation for a *different* user's still-open position on
        // the same tsym (the previous single-query version scoped the
        // last-Sell boundary globally across all users, not per user - a
        // second latent bug this fixes at the same time).
        const users: string[] = await db.collection('Trade').distinct('user', { tsym, action: 'Buy', ...brokerOrLegacy });

        const restored: Trade[] = [];
        let totalRestoredQty = 0;
        for (const user of users) {
            // A same-tsym position can close and reopen (e.g. ContinuousStrategy's
            // root-refill re-enters the identical contract right after a
            // target-hit sell) - all-time Buy docs for this tsym can therefore
            // span multiple unrelated legs. Scope to only the Buy docs after the
            // most recent Sell (if any), so a closed leg's old fills never bleed
            // into the currently-open leg's restored price/quantity.
            //
            // Deliberately NOT bounded to "today" (startOfDay()) on either query
            // below: this app carries NRML/overnight positions across multiple
            // days (ContinuousStrategy), and a position opened yesterday but
            // still open today has no Buy doc within a same-day window - fixed
            // 2026-09-03 after exactly that scenario left 3 real overnight NIFTY
            // legs untracked despite having been opened by this app the day
            // before. tsym already encodes the specific contract (strike+expiry),
            // so an unbounded search can't cross-match a different contract.
            const lastSell = await db.collection('Trade')
                .find({ tsym, action: 'Sell', user, ...brokerOrLegacy })
                .sort({ entryTime: -1 })
                .limit(1)
                .toArray();
            const rows = lastSell[0]
                ? await db.collection('Trade').find({ tsym, action: 'Buy', user, ...brokerOrLegacy, entryTime: { $gt: lastSell[0].entryTime } }).sort({ entryTime: -1 }).toArray()
                : await db.collection('Trade').find({ tsym, action: 'Buy', user, ...brokerOrLegacy }).sort({ entryTime: -1 }).toArray();
            const row = rows[0];
            if (!row) continue; // this user's position on this tsym is fully closed

            // A multi-fill position (e.g. ContinuousStrategy's tryAverageLevel
            // averaging into an existing leg) has one Buy doc per fill, not one
            // per position - blend them into a single quantity-weighted average
            // price (same formula _processTradeEvent's live merge path uses)
            // instead of trusting just the latest fill's price.
            const totalQty = rows.reduce((sum, r) => sum + r.quantity, 0);
            const blendedPrice = rows.reduce((sum, r) => sum + r.quantity * r.price, 0) / totalQty;
            // The earliest surviving fill (rows is sorted newest-first) is this
            // leg's true original entry - distinct from the blended price/current
            // broker total above. See originalEntryPrice/originalEntryQuantity's
            // doc comments on Trade (model.ts) for why ContinuousStrategy.reconcile()
            // needs both.
            const firstFill = rows[rows.length - 1];
            const trade = new Trade();
            trade.tsym = tsym;
            // Prefer the common/ANT-native token already recorded on the Mongo doc
            // (trade.token is always ANT-native since the 2026-08-27 fix - see
            // ToDo.md) over the broker's own token, which may use a different
            // scheme (e.g. Kite's instrument_token).
            trade.token = row.token ?? brokerToken ?? '';
            trade.right = row.right;
            trade.quantity = totalQty; // this user's own portion, not the broker's aggregate total
            trade.price = blendedPrice;
            trade.lastTradePrice = blendedPrice;
            trade.originalEntryPrice = firstFill.price;
            trade.originalEntryQuantity = firstFill.quantity;
            trade.action = 'Buy';
            trade.status = 'COMPLETE';
            trade.user = user;
            trade.broker = broker;
            trade.open = true;
            trade.targetPrice = row.targetPrice;
            trade.stopLossPrice = row.stopLossPrice;
            trade.gttTriggerId = row.gttTriggerId;
            trade.antOrderNo = row.antOrderNo;
            trade.product = row.product;
            trade.prismCoverOrderNo = row.prismCoverOrderNo;
            trade.strategy = row.strategy;
            trade.entryTime = row.entryTime;

            restored.push(trade);
            totalRestoredQty += totalQty;
        }

        if (restored.length === 0) {
            Log.log(`[order] loadOpenTradesFromBroker: WARNING - broker reports an open position on ${tsym} (qty=${brokerQuantity}) with no matching Mongo Buy doc for any user - leaving untracked`);
        } else if (totalRestoredQty !== brokerQuantity) {
            Log.log(`[order] loadOpenTradesFromBroker: WARNING - broker reports ${brokerQuantity} total on ${tsym} but Mongo reconciliation across ${restored.length} user(s) totals ${totalRestoredQty} - broker is ground truth for aggregate size, but the per-user split above may be stale/wrong`);
        }

        return restored;
    }

    // Additive, purpose-built realized-P&L ledger - distinct from the raw
    // per-fill insert in _processTradeEvent (that's a fill log, this is one
    // row per closed position, with entry/exit timestamps). Feeds payout
    // history and drawdown-breach explanations (see src/payout.ts). Never
    // let a Mongo hiccup block live bookkeeping - the row is held in
    // unpersistedClosed until its write is confirmed, and the breach check
    // counts it from there, so the write is never awaited on the fill path.
    private unpersistedClosed = new Map<string, { user: string; realizedPnL: number; exitTime: Date; row: Record<string, any>; attempts: number; inFlight: boolean }>();

    // Never throws: a failure here must not reject the fill handler after
    // position state has already changed.
    private async persistClosedTrade(trade: Trade, user: string, exitPrice: number): Promise<boolean> {
        const id = randomUUID();
        const row = {
            _id: id,
            user,
            tsym: trade.tsym,
            token: trade.token,
            right: trade.right,
            quantity: trade.quantity,
            entryPrice: trade.price,
            exitPrice,
            realizedPnL: trade.realizedPnL,
            entryTime: trade.entryTime,
            exitTime: trade.exitTime,
            strategy: trade.strategy,
            broker: trade.broker,
            createdAt: new Date(),
        };
        this.unpersistedClosed.set(id, { user, realizedPnL: trade.realizedPnL || 0, exitTime: trade.exitTime, row, attempts: 0, inFlight: false });
        this.ensureClosedRowFlushTimer();
        return this.writeClosedRow(id);
    }

    // Writes one held row. The _id makes this idempotent: a duplicate-key error
    // means an earlier attempt (e.g. one that outlived a timeout) already landed.
    // Never more than one insert in flight per row (a flush and the immediate write
    // would otherwise both send it). A timed-out insert stays in flight until it
    // settles - and clears the row itself if it lands late - and is still safe to
    // retry because _id is unique.
    private async writeClosedRow(id: string): Promise<boolean> {
        const entry = this.unpersistedClosed.get(id);
        if (!entry || entry.inFlight) return !entry;
        try {
            const col = Mongo.getInstance()?.db?.collection('closedTrades');
            if (!col) return false;
            entry.inFlight = true;
            // Promise.resolve().then turns a synchronous throw from insertOne into a rejection,
            // so the settled chain below always runs and clears inFlight.
            const settled = Promise.resolve().then(() => col.insertOne(entry.row)).then(
                () => ({ ok: true as const }),
                (error: any) => ({ ok: false as const, error }),
            ).then((outcome) => {
                entry.inFlight = false;
                // Only a duplicate on _id means this row already landed; a duplicate on any other unique index is a real failure.
                const keys = Object.keys((outcome as any).error?.keyPattern ?? (outcome as any).error?.keyValue ?? {});
                const landed = outcome.ok || ((outcome as any).error?.code === 11000 && keys.length === 1 && keys[0] === '_id');
                if (landed) {
                    this.recentlyLanded.set(id, { user: entry.user, realizedPnL: entry.realizedPnL, exitTime: entry.exitTime, at: Date.now() });
                    this.unpersistedClosed.delete(id);
                }
                return { ...outcome, landed };
            });
            const outcome = await withFallbackTimeout(settled, LEDGER_TIMEOUT_MS, null, 'closedTrades write');
            if (outcome === null) return false; // still in flight - settled by its own promise
            if (outcome.landed) return true;
            entry.attempts += 1;
            const error = (outcome as any).error;
            if (entry.attempts % CLOSED_ROW_ERROR_LOG_EVERY === 0) {
                Log.log('[order] ERROR closedTrade for', entry.user, `still failing after ${entry.attempts} attempts - kept in memory and retried:`, error);
            } else {
                Log.log('[order] Failed to persist closedTrade for', entry.user, '- will retry:', error);
            }
            return false;
        } catch (e) {
            entry.inFlight = false;
            Log.log('[order] closedTrade write threw for', entry.user, '- will retry:', e);
            return false;
        }
    }

    // A held row must keep being retried even when no further fill (and so no flush) happens.
    // Started on the first held row; stops itself once nothing is held.
    private recentlyLanded = new Map<string, { user: string; realizedPnL: number; exitTime: Date; at: number }>();
    private closedRowFlushTimer: ReturnType<typeof setInterval> | undefined;
    private ensureClosedRowFlushTimer(): void {
        if (this.closedRowFlushTimer) return;
        this.closedRowFlushTimer = setInterval(() => {
            if (this.unpersistedClosed.size === 0) {
                clearInterval(this.closedRowFlushTimer);
                this.closedRowFlushTimer = undefined;
                return;
            }
            this.flushUnpersistedClosed().catch((e) => Log.log('[order] periodic flush of held closedTrades failed:', e));
        }, CLOSED_ROW_FLUSH_INTERVAL_MS);
        this.closedRowFlushTimer.unref?.();
    }

    private async flushUnpersistedClosed(): Promise<void> {
        for (const id of [...this.unpersistedClosed.keys()]) await this.writeClosedRow(id);
    }

    // Called after kiteExecutor.setTargetStopLoss (or the Prism-routed
    // equivalent, if ever added) mutates a trade's target/SL fields in place -
    // matches Monitor.setTargetStopLoss's old myEmitter.emit('position', ...).
    notifyTargetStopLossChanged() {
        this.notifyPositionsChanged();
    }
}

export default new OrderBookkeeping();
