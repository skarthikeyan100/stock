import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import { Trade } from '../../model/model';
import { UserContext } from '../../user';
import { PUT, CALL, USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from '../../constants';
import * as exitMonitor from './exitMonitor';
import configService from '../../prism/ConfigService';

// Order-process-local replacement for Monitor's bookkeeping (trades/closedTrades,
// risk limits, order<->user attribution, P&L). Ported from src/monitor.ts, with
// everything quote-driven removed: no AntStream subscribe/unsubscribe. Target/SL
// exits are a GTT placed once at entry (see zerodhaExecutor.ts) for users with
// useGTT=true; for useGTT=false users, exitMonitor.ts watches the tick feed
// piped in from `data` (see orderProcess.ts) and squares off in-app instead.
// Strategy notification (Monitor.strategyMap) is replaced by fillListeners,
// pushed out over the order<->strategies IPC socket by orderProcess.ts.

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
    broker?: 'zerodha' | 'ant';
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
    // daily or monthly drawdown limit, so the listener can square off their
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

    getUserBroker(user: string): 'zerodha' | 'ant' {
        return this.userSettingsCache.get(user)?.broker ?? 'zerodha';
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

    private static startOfMonth(): Date {
        const d = new Date();
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Realized P&L only (not unrealized/open-position exposure), summed from
    // the closedTrades collection (see persistClosedTrade) rather than the
    // in-memory, never-resetting userPnL map, so the daily/monthly window is
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

    async isMonthlyDrawdownBreached(user: string): Promise<boolean> {
        const investmentAmount = this.userSettingsCache.get(user)?.investmentAmount;
        if (!investmentAmount) return false;
        const settings = configService.getConfig().settings as any;
        const limitPercent = settings.maxMonthlyDrawdownPercent ?? 50;
        const pnl = await this.getRealizedPnLSince(user, OrderBookkeeping.startOfMonth());
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
        if (await this.isMonthlyDrawdownBreached(user)) {
            const reason = `User '${user}' has reached the maximum monthly drawdown.`;
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
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user);
            if (index == -1) {
                tradeEvent.entryTime = new Date();
                this.trades.push(tradeEvent);
            } else {
                const trade = this.trades[index];
                const traded = trade.quantity * trade.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                trade.quantity += tradeEvent.quantity;
                trade.price = (traded + newTraded) / trade.quantity;
            }
        } else {
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user);
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

                if ((await this.isDailyDrawdownBreached(user)) || (await this.isMonthlyDrawdownBreached(user))) {
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
