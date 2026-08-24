import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import { Trade } from '../../model/model';
import { UserContext } from '../../user';
import { PUT, CALL, USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from '../../constants';
import * as exitMonitor from './exitMonitor';

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

interface UserSettings {
    lossLimit: number;
    lotLimit?: number;
    maxInvestment?: number;
    investmentMode?: string;
    investmentAmount?: number;
    useGTT?: boolean;
    broker?: 'zerodha' | 'ant';
    perOrderCap?: number;
}

class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingUsers: Set<string> = new Set();
    // Per-session, per-user set of drawdown-warning thresholds (80, 100) already
    // notified, so a losing streak doesn't spam a fresh notification per trade.
    private notifiedThresholds: Map<string, Set<number>> = new Map();
    userSettingsCache: Map<string, UserSettings> = new Map();
    private fillListeners: FillListener[] = [];
    private positionsChangedListeners: PositionsChangedListener[] = [];

    onFill(listener: FillListener) {
        this.fillListeners.push(listener);
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

    getTradedLots(user: string): number {
        return this.trades
            .filter((t) => t.user === user)
            .reduce((sum, t) => sum + Math.ceil(t.quantity / this.getInstrumentLotSize(t.tsym)), 0);
    }

    hasActiveTrade(user: string): boolean {
        return this.trades.some((t) => t.user === user) || this.pendingUsers.has(user);
    }

    isLossLimitReached(user: string): boolean {
        return (this.userPnL.get(user) || 0) <= -this.getUserLossLimit(user);
    }

    getCurrentInvestment(user: string): number {
        return this.trades.filter((t) => t.user === user).reduce((sum, t) => sum + t.price * t.quantity, 0);
    }

    isInvestmentLimitReached(user: string): boolean {
        return this.getCurrentInvestment(user) >= this.getUserMaxInvestment(user);
    }

    // estimatedOrderValue is necessarily approximate for index-based buys
    // (niftyLtp * quantity - the real option premium isn't known until
    // contract selection) but exact for buyContract's price * quantity.
    canPlaceOrder(user: string, estimatedOrderValue?: number): { allowed: boolean; reason?: string } {
        const tradedLots = this.getTradedLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        if (this.isLossLimitReached(user)) {
            const reason = `User '${user}' has reached the session loss limit. P&L: ${this.userPnL.get(user) || 0}, Limit: ${this.getUserLossLimit(user)}`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        if (this.isInvestmentLimitReached(user)) {
            return { allowed: false, reason: `User '${user}' has reached max investment (${this.getCurrentInvestment(user)}/${this.getUserMaxInvestment(user)}).` };
        }
        const perOrderCap = this.getUserPerOrderCap(user);
        if (estimatedOrderValue !== undefined && perOrderCap !== undefined && estimatedOrderValue > perOrderCap) {
            return { allowed: false, reason: `Order value ₹${estimatedOrderValue.toFixed(2)} exceeds per-order cap ₹${perOrderCap}.` };
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
        if (tradeEvent.action == 'Buy') tradeEvent.lastTradePrice = tradeEvent.price;

        const isCompleted = data.fillshares == data.qty && data.status == 'COMPLETE';
        if (!isCompleted) return;

        this.clearOrder(data.norenordno);
        await this.recordFill(tradeEvent);
        return tradeEvent;
    }

    private async _processTradeEvent(tradeEvent: Trade) {
        Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        try {
            Mongo.getInstance()?.insert(tradeEvent);
        } catch (e) {
            /* Mongo not available */
        }

        if (tradeEvent.action == 'Buy') {
            this.pendingUsers.delete(tradeEvent.user || 'Default');
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
                const realizedPnL = (tradeEvent.price - buyTrade.price) * buyTrade.quantity;
                buyTrade.open = false;
                buyTrade.realizedPnL = realizedPnL;
                buyTrade.exitTime = new Date();
                const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
                this.userPnL.set(user, cumulative);
                Log.log(`[order] User '${user}' closed. P&L: ${realizedPnL.toFixed(2)}, Cumulative: ${cumulative.toFixed(2)}`);
                this.checkDrawdownNotification(user, cumulative);
                this.closedTrades.push(buyTrade);
                this.persistClosedTrade(buyTrade, user, tradeEvent.price);
                this.trades.splice(index, 1);
                if (buyTrade.token) exitMonitor.unregisterTrade(buyTrade.token);
            }
        }
        this.notifyPositionsChanged();
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
