import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import Zerodha from '../../zerodha/Zerodha';
import ANT from '../../ant/ANT';
import Breeze from '../../breeze/Breeze';
import { Trade } from '../../model/model';
import { UserContext } from '../../user';
import { PUT, CALL, USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from '../../constants';
import * as exitMonitor from './exitMonitor';
import configService from '../../prism/ConfigService';
import { startOfWeek } from '../../util/weekWindow';

// Order-process-local replacement for Monitor's bookkeeping (trades/closedTrades,
// risk limits, order<->user attribution, P&L). Ported from src/monitor.ts, with
// everything quote-driven removed: no AntStream subscribe/unsubscribe. Target/SL
// exits are a GTT placed once at entry (see zerodhaExecutor.ts) for users with
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
    broker?: 'zerodha' | 'ant' | 'breeze';
    perOrderCap?: number;
    allottedCapital?: number;
    targetPoints?: number;
    stopLossPoints?: number;
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
}

class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
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
    // falling back to the 'zerodha' default below regardless of what was
    // configured. Used only as a FALLBACK, after userSettingsCache, in
    // getUserBroker below - a real user's own account-level broker
    // preference must still win over a strategy's config broker if that
    // strategy was ever given an explicit `userId:` equal to a real email
    // (config's broker overriding a human's own setting with no log/error
    // would be a silent, surprising precedence hazard otherwise).
    private getStrategyConfigBroker(user: string): 'zerodha' | 'ant' | 'breeze' | undefined {
        const strategy = configService.getConfig().strategies?.find((s) => (s.userId || s.type) === user);
        return strategy?.broker;
    }

    getUserBroker(user: string): 'zerodha' | 'ant' | 'breeze' {
        return this.userSettingsCache.get(user)?.broker ?? this.getStrategyConfigBroker(user) ?? 'zerodha';
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
    // zerodhaExecutor.ts/antExecutor.ts's target/stopLoss point resolution).
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

    getInstrumentLotSize(tsym: string): number {
        if (tsym.startsWith('BANKNIFTY')) return 15;
        if (tsym.startsWith('FINNIFTY')) return 25;
        return 65;
    }

    // Broker-agnostic manual-buy sizing: an explicit quantity always wins;
    // otherwise a user on investmentMode='investmentAmount' gets as many
    // lots as their remaining capital covers at the given price (at least
    // one lot if they have any headroom at all), and everyone else falls
    // back to a single lot - unchanged from the prior default behavior.
    resolveManualBuyQuantity(userId: string, tsym: string, price: number, explicitQuantity?: number): number {
        if (explicitQuantity !== undefined) return explicitQuantity;
        const lotSize = this.getInstrumentLotSize(tsym);
        const ctx = this.getUserContext(userId);
        if (ctx.investmentMode === 'investmentAmount' && ctx.availableAmount > 0 && price > 0) {
            const lots = Math.max(1, Math.floor(ctx.availableAmount / (price * lotSize)));
            return lots * lotSize;
        }
        return lotSize;
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

    getCurrentInvestment(user: string): number {
        return this.trades.filter((t) => t.user === user).reduce((sum, t) => sum + t.price * t.quantity, 0);
    }

    isInvestmentLimitReached(user: string): boolean {
        return this.getCurrentInvestment(user) >= this.getUserMaxInvestment(user);
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
    markPending(user: string, estimatedOrderValue?: number): void {
        const list = this.pendingOrders.get(user) ?? [];
        list.push({ estimatedLots: 1, estimatedValue: estimatedOrderValue ?? 0 });
        this.pendingOrders.set(user, list);
    }

    // Releases exactly one pending reservation for `user` (oldest first) -
    // never all of them - so releasing/resolving one in-flight order can't
    // silently drop a different, still-in-flight order's reservation for the
    // same user. Safe to call when nothing is pending (no-op), so both the
    // fill path and orderProcess's failure path can call it unconditionally.
    releasePending(user: string): void {
        const list = this.pendingOrders.get(user);
        if (!list || list.length === 0) return;
        list.shift();
        if (list.length === 0) this.pendingOrders.delete(user);
    }

    private pendingLots(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedLots, 0);
    }

    private pendingValue(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedValue, 0);
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
    private async getRealizedPnLSince(user: string, since: Date): Promise<number> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db) return 0;
            const rows = await db.collection('closedTrades').find({ user, exitTime: { $gte: since } }).toArray();
            return rows.reduce((sum, r) => sum + (r.realizedPnL || 0), 0);
        } catch (e) {
            Log.log('[order] getRealizedPnLSince failed (not blocking on this):', e);
            return 0;
        }
    }

    // Only users with an investmentAmount configured are subject to these -
    // strategy pseudo-users (see orderProcess.ts loadUserLimits) never get
    // investmentAmount populated, and 25%/50% of an unset (0) amount would
    // instantly block every automated strategy.
    async isDailyDrawdownBreached(user: string): Promise<boolean> {
        const investmentAmount = this.userSettingsCache.get(user)?.investmentAmount;
        if (!investmentAmount) return false;
        const settings = configService.getConfig().settings as any;
        const limitPercent = settings.maxDailyDrawdownPercent ?? 25;
        const pnl = await this.getRealizedPnLSince(user, OrderBookkeeping.startOfDay());
        return pnl <= -(investmentAmount * limitPercent) / 100;
    }

    async isWeeklyDrawdownBreached(user: string): Promise<boolean> {
        const investmentAmount = this.userSettingsCache.get(user)?.investmentAmount;
        if (!investmentAmount) return false;
        const settings = configService.getConfig().settings as any;
        const limitPercent = settings.maxWeeklyDrawdownPercent ?? 50;
        const pnl = await this.getRealizedPnLSince(user, startOfWeek());
        return pnl <= -(investmentAmount * limitPercent) / 100;
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
    async canPlaceOrder(user: string, estimatedOrderValue?: number): Promise<{ allowed: boolean; reason?: string }> {
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
        // strategy pseudo-user (see isDailyDrawdownBreached's comment - they
        // never have investmentAmount configured).
        if (user === 'ContinuousStrategy' || user === 'BulkPcrStrategy') {
            const currentInvestment = this.getCurrentInvestment(user) + this.pendingValue(user);
            const maxInvestment = this.getUserMaxInvestment(user);
            if (currentInvestment >= maxInvestment) {
                return { allowed: false, reason: `User '${user}' has reached max investment (${currentInvestment}/${maxInvestment}).` };
            }
            return { allowed: true };
        }
        const tradedLots = this.getTradedLots(user) + this.pendingLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        const currentInvestment = this.getCurrentInvestment(user) + this.pendingValue(user);
        const maxInvestment = this.getUserMaxInvestment(user);
        if (currentInvestment >= maxInvestment) {
            return { allowed: false, reason: `User '${user}' has reached max investment (${currentInvestment}/${maxInvestment}).` };
        }
        const perOrderCap = this.getUserPerOrderCap(user);
        if (estimatedOrderValue !== undefined && perOrderCap !== undefined && estimatedOrderValue > perOrderCap) {
            return { allowed: false, reason: `Order value ₹${estimatedOrderValue.toFixed(2)} exceeds per-order cap ₹${perOrderCap}.` };
        }
        if (await this.isDailyDrawdownBreached(user)) {
            const reason = `User '${user}' has reached the maximum daily drawdown.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        if (await this.isWeeklyDrawdownBreached(user)) {
            const reason = `User '${user}' has reached the maximum weekly drawdown.`;
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

    // Records a fill directly (used by the Zerodha buy/GTT-trigger path, which
    // doesn't go through Prism's websocket 'om' message shape at all).
    async recordFill(tradeEvent: Trade): Promise<void> {
        if (tradeEvent.brokerOrderId) {
            if (this.processedFillIds.has(tradeEvent.brokerOrderId)) {
                Log.log(`[order] Ignoring redelivered fill for broker order ${tradeEvent.brokerOrderId} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            this.processedFillIds.add(tradeEvent.brokerOrderId);
        }
        await this._processTradeEvent(tradeEvent);
        for (const l of this.fillListeners) l(tradeEvent.user || 'Default', tradeEvent);
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
            this.releasePending(tradeEvent.user || 'Default');
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
                this.persistClosedTrade(closedPortion, user, tradeEvent.price);

                buyTrade.quantity -= sellQty;
                if (buyTrade.quantity <= 0) {
                    this.trades.splice(index, 1);
                    if (buyTrade.token) exitMonitor.unregisterTrade(user, buyTrade.token);
                }

                if ((await this.isDailyDrawdownBreached(user)) || (await this.isWeeklyDrawdownBreached(user))) {
                    for (const l of this.drawdownBreachListeners) l(user);
                }
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
    // Mongo's raw Buy fills - finalizeEntry (zerodhaExecutor.ts/
    // antExecutor.ts)/prismExecutor.ts's buyOnPrism always set those on the
    // Trade object before calling recordFill, so the raw Mongo insert
    // already captured them. Split per-user (not just per-tsym) - see that
    // function's own comment for why that split matters once more than one
    // app user can share a broker.
    // This app only trades NIFTY index options - the broker account can (and,
    // per the 2026-09-03 incident, does) also carry unrelated stock-option/
    // other-index positions placed outside the app (e.g. AMBER, BANKNIFTY).
    // Restoring those into bookkeeping.trades would hand them to exitMonitor/
    // strategies as if this app were managing their target/SL, which it never
    // set. Scope every broker restore to plain NIFTY options only.
    private static isNiftyOption(tsym: string | undefined): boolean {
        return typeof tsym === 'string' && tsym.startsWith('NIFTY') && (tsym.endsWith('CE') || tsym.endsWith('PE'));
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

    // Called both at order-process startup and reactively whenever `order`
    // is told a Zerodha login just succeeded (see orderProcess.ts's
    // 'reloadSession' handler) - a stale/expired session on disk at startup
    // otherwise means this never gets a second chance until the next process
    // restart, silently leaving real open positions untracked (2026-09-03
    // incident: session was invalid at startup, a same-session re-login later
    // fixed it, but nothing re-ran this, so bookkeeping.trades stayed empty
    // against 4 real open Zerodha positions).
    async reconcileZerodhaPositions(): Promise<void> {
        const restored: Trade[] = [];
        try {
            const positions = await Zerodha.getInstance().getPositions();
            const open = (positions?.net || []).filter((p: any) => p.quantity !== 0 && OrderBookkeeping.isNiftyOption(p.tradingsymbol));
            for (const p of open) {
                restored.push(...(await this.restoreOpenTradesForTsym(p.tradingsymbol, p.quantity, p.instrument_token != null ? String(p.instrument_token) : undefined, 'zerodha')));
            }
        } catch (e) {
            Log.log('[order] reconcileZerodhaPositions: Zerodha getPositions failed (continuing without restore):', e);
            return;
        }
        this.mergeRestored(restored);
    }

    // Caveat, not yet live-verified: ANT's getPositions() return shape is
    // untyped/`any` and hasn't been confirmed against a real response - same
    // caveat ToDo.md already carries for AntOrderNotifyStream's norenordno/
    // flprc fields. The field names below (netQty/token/tradingSymbol/
    // exchange) are a best guess from AliceBlue's v2 REST conventions, not
    // observed - verify against a live response before trusting this in
    // production. Called both at startup and reactively after a successful
    // ANT login (see reconcileZerodhaPositions's comment for why).
    async reconcileAntPositions(): Promise<void> {
        const restored: Trade[] = [];
        try {
            const positions = await ANT.getInstance().getPositions();
            const list = Array.isArray(positions) ? positions : [];
            const open = list.filter((p: any) => Number(p.netQty ?? p.netqty ?? 0) !== 0 && OrderBookkeeping.isNiftyOption(p.tradingSymbol ?? p.tsym ?? p.symbol));
            for (const p of open) {
                const tsym = p.tradingSymbol ?? p.tsym ?? p.symbol;
                const qty = Number(p.netQty ?? p.netqty);
                const token = p.token != null ? String(p.token) : undefined;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, token, 'ant')));
            }
        } catch (e) {
            Log.log('[order] reconcileAntPositions: ANT getPositions failed (continuing without restore):', e);
            return;
        }
        this.mergeRestored(restored);
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
    async reconcileBreezePositions(): Promise<void> {
        const restored: Trade[] = [];
        try {
            if (!(await withTimeout(Breeze.getInstance().hasValidSession(), 15000, 'Breeze hasValidSession'))) return;
            const result = await withTimeout(Breeze.getInstance().getPortfolioPositions(), 15000, 'Breeze getPortfolioPositions');
            const rows = Array.isArray(result?.Success) ? result.Success : [];
            for (const p of rows) {
                const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
                if (!optionType) continue;
                const tsym = `${p.stock_code}${p.strike_price}${optionType}`;
                const qty = Number(p.quantity ?? 0);
                if (qty === 0 || !OrderBookkeeping.isNiftyOption(tsym)) continue;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, undefined, 'breeze')));
            }
        } catch (e) {
            Log.log('[order] reconcileBreezePositions: Breeze getPortfolioPositions failed (continuing without restore):', e);
            return;
        }
        this.mergeRestored(restored);
    }

    async loadOpenTradesFromBroker(): Promise<void> {
        await this.reconcileZerodhaPositions();
        await this.reconcileAntPositions();
        await this.reconcileBreezePositions();
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
    // NIFTY23450PE on both Zerodha and Breeze at once) would pool both
    // brokers' Mongo Buy/Sell docs into one blended restored position on
    // restart, corrupting quantity/avgPrice and losing which broker a
    // resting exit order belongs to.
    private async restoreOpenTradesForTsym(tsym: string, brokerQuantity: number, brokerToken: string | undefined, broker: 'zerodha' | 'ant' | 'breeze' | 'prism'): Promise<Trade[]> {
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
            // scheme (e.g. Zerodha's instrument_token).
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
    // let a Mongo hiccup block live bookkeeping - fire and forget.
    private persistClosedTrade(trade: Trade, user: string, exitPrice: number) {
        Mongo.getInstance()?.db.collection('closedTrades').insertOne({
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
        }).catch((e) => Log.log('[order] Failed to persist closedTrade for', user, ':', e));
    }

    // Called after zerodhaExecutor.setTargetStopLoss (or the Prism-routed
    // equivalent, if ever added) mutates a trade's target/SL fields in place -
    // matches Monitor.setTargetStopLoss's old myEmitter.emit('position', ...).
    notifyTargetStopLossChanged() {
        this.notifyPositionsChanged();
    }
}

export default new OrderBookkeeping();
