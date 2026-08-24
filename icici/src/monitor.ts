import Log from './util/Log';
import { NiftyQuote, OptionQuote, OrderInfo, SensexQuote, Trade, Order } from './model/model';
import { UserContext } from './user';
import myEmitter from './tools/emitter';
import Mongo from './tools/mongo'
import Prism from './prism';
import AntStream from './ant/AntStream';
import Config from './prism/config';
import configService from './prism/ConfigService';
import {  PUT, CALL, USER_LOSS_LIMIT,  DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT} from './constants'
import strategies from './strategy/strategies';
import { Strategy } from './strategy/strategy';



export default class Monitor {

    static instance: Monitor = null

    static getInstance() {
        if (!Monitor.instance) {
            Monitor.instance = new Monitor();
        }
        return Monitor.instance;
    }

    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingUsers: Set<string> = new Set();
    userSettingsCache: Map<string, { lossLimit: number; lotLimit?: number; maxInvestment?: number; investmentMode?: string; investmentAmount?: number }> = new Map();
    private strategyMap: Map<string, Strategy> = new Map();
    private watchTokens: Map<string, Set<Strategy>> = new Map();
    private niftyQuoteHistory: NiftyQuote[] = [];
    static QUOTE_HISTORY_MAX_SIZE = 100;

    // --- Strategy Registration ---

    registerStrategy(strategy: Strategy) {
        this.strategyMap.set(strategy.userId, strategy);
        Log.log(`[Monitor] Registered strategy: ${strategy.userId}`);
    }

    unregisterStrategy(userId: string) {
        this.strategyMap.delete(userId);
        Log.log(`[Monitor] Unregistered strategy: ${userId}`);
    }

    watchToken(token: string, strategy: Strategy) {
        if (!this.watchTokens.has(token)) this.watchTokens.set(token, new Set());
        this.watchTokens.get(token)!.add(strategy);
        Log.log(`[Monitor] Watching token ${token} for strategy ${strategy.userId}`);
        try { AntStream.getInstance()?.subscribeOption(token); } catch (e) { /* AntStream not available */ }
    }

    unwatchToken(token: string, strategy: Strategy) {
        const watchers = this.watchTokens.get(token);
        if (!watchers) return;
        watchers.delete(strategy);
        if (watchers.size === 0) this.watchTokens.delete(token);
        Log.log(`[Monitor] Unwatched token ${token} for strategy ${strategy.userId}`);
    }

    // --- Order Gateway (strategies call these instead of Prism directly) ---

    async requestBuy(userId: string, contract: string, qty: number, price?: number): Promise<OrderInfo | null> {
        const validation = this.canPlaceOrder(userId);
        if (!validation.allowed) {
            Log.log(`[Monitor] Order rejected for ${userId}: ${validation.reason}`);
            return null;
        }
        this.pendingUsers.add(userId);
        Log.log(`[Monitor] Placing buy order for ${userId}: ${contract} qty=${qty} price=${price}`);
        const response = await Prism.getInstance().buyContract(contract, qty, price, this.getUserContext(userId));
        return response;
    }

    async requestSell(userId: string, contract: string, qty: number, price?: number) {
        Log.log(`[Monitor] Placing sell order for ${userId}: ${contract} qty=${qty} price=${price}`);
        return await Prism.getInstance().sellContract(contract, qty, price, userId);
    }

    async requestBuyIndex(userId: string, index: string, ltp?: number, right?: string, qty?: number) {
        const validation = this.canPlaceOrder(userId);
        if (!validation.allowed) {
            Log.log(`[Monitor] Order rejected for ${userId}: ${validation.reason}`);
            return null;
        }
        this.pendingUsers.add(userId);
        Log.log(`[Monitor] Placing buyIndex order for ${userId}: ${index} right=${right} qty=${qty}`);
        return await Prism.getInstance().buyIndex({ userContext: this.getUserContext(userId), index, ltp, right, qty });
    }

    // --- Quote Broadcasting ---

    async onNiftyQuote(quote: NiftyQuote) {
        // Store a snapshot copy (quote object is mutated in-place by _updateQuote)
        this.niftyQuoteHistory.push({ ...quote } as NiftyQuote);
        if (this.niftyQuoteHistory.length > Monitor.QUOTE_HISTORY_MAX_SIZE) {
            this.niftyQuoteHistory.shift();  // Remove oldest
        }

        // Broadcast to strategies
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) {
                await strategy.processNiftyQuote(quote);
            }
        }
    }

    async onSensexQuote(quote: SensexQuote) {
        // Broadcast to strategies
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) {
                await strategy.processSensexQuote(quote);
            }
        }
    }

    getRecentNiftyQuotes(count: number): NiftyQuote[] {
        // Return last N quotes (most recent first)
        return this.niftyQuoteHistory.slice(-count).reverse();
    }

    getNiftyQuoteHistory(): NiftyQuote[] {
        return [...this.niftyQuoteHistory];  // Return copy to prevent mutation
    }

    // --- User Settings ---

    getUserLossLimit(user: string): number {
        const cached = this.userSettingsCache.get(user);
        return cached ? cached.lossLimit : USER_LOSS_LIMIT;
    }

    getUserLotLimit(user: string): number {
        const cached = this.userSettingsCache.get(user);
        
        return cached?.lotLimit ?? DEFAULT_LOT_LIMIT;
    }

    getUserMaxInvestment(user: string): number {
        const cached = this.userSettingsCache.get(user);
        return cached?.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
    }

    updateUserSettings(user: string, settings: { lossLimit: number; lotLimit?: number; maxInvestment?: number; investmentMode?: string; investmentAmount?: number }) {
        this.userSettingsCache.set(user, settings);
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
        return 65; // NIFTY default
    }

    getTradedLots(user: string): number {
        return this.trades
            .filter(t => t.user === user)
            .reduce((sum, t) => sum + Math.ceil(t.quantity / this.getInstrumentLotSize(t.tsym)), 0);
    }

    hasActiveTrade(user: string): boolean {
        return this.trades.some(t => t.user === user) || this.pendingUsers.has(user);
    }

    isLossLimitReached(user: string): boolean {
        const limit = this.getUserLossLimit(user);
        Log.log(`[Limit] ${user} limit=${limit} pnl=${this.userPnL.get(user) ?? 0}`)
        return (this.userPnL.get(user) || 0) <= -limit;
    }

    getCurrentInvestment(user: string): number {
        return this.trades
            .filter(t => t.user === user)
            .reduce((sum, t) => sum + (t.price * t.quantity), 0);
    }

    isInvestmentLimitReached(user: string): boolean {
        return this.getCurrentInvestment(user) >= this.getUserMaxInvestment(user);
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
        if (orderNo) {
            this.orderUserMap.delete(orderNo);
        }
    }

    canPlaceOrder(user: string): { allowed: boolean; reason?: string } {
        const tradedLots = this.getTradedLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        if (this.isLossLimitReached(user)) {
            const pnl = this.userPnL.get(user) || 0;
            return { allowed: false, reason: `User '${user}' has reached the session loss limit. P&L: ${pnl}, Limit: ${this.getUserLossLimit(user)}` };
        }
        if (this.isInvestmentLimitReached(user)) {
            const current = this.getCurrentInvestment(user);
            const max = this.getUserMaxInvestment(user);
            return { allowed: false, reason: `User '${user}' has reached max investment (${current}/${max}).` };
        }
        return { allowed: true };
    }

    getClosedTrades(): Trade[] {
        return this.closedTrades;
    }


    refreshTrades(trades: Trade[]) {
        this.trades = trades
        const antStream = AntStream.getInstance();
        this.trades.forEach(async trade => {
            trade.lastTradePrice = trade.price
            Log.log('In refresh trades, subscribe to ', trade.tsym, ' token: ', trade.token)
            await antStream.subscribeOption(trade.token);
        });
    }

    refreshPendingOrders(orders: Order[]) {
        const antStream = AntStream.getInstance();
        orders.forEach(async order => {
            await antStream.subscribeOption(order.token);
        });
    }

    subscribeTrades = (trades: Trade[]) => {
        const antStream = AntStream.getInstance();
        this.trades.forEach(trade => {
            antStream.subscribeOption(trade.token);
        });
    }

    round = (num) => Math.round(num * 10) / 10;
    percent = (price, num) => (price * num/100)

    async updateTrade(data): Promise<Trade|void>{
        const user = this.resolveUser(data.norenordno, data.tsym);
        Log.log('User: ', user, ' Trade data: ', data)

        const prism = Prism.getInstance();
        if (data.flqty != undefined) {
            const tradeEvent = new Trade();
            tradeEvent.tsym = data.tsym as string;
            tradeEvent.quantity = parseInt(data.qty)
            tradeEvent.price = parseFloat(data.flprc)
            tradeEvent.token = await prism.getToken(tradeEvent.tsym);
            tradeEvent.action = data.trantype == 'S' ? 'Sell' : 'Buy'
            tradeEvent.status = data.status
            tradeEvent.right = tradeEvent.tsym.indexOf('P') !== -1 ? PUT : CALL;
            tradeEvent.user = user;

            if (tradeEvent.action == 'Buy') {
                tradeEvent.lastTradePrice = tradeEvent.price
            }
            let isCompleted = data.fillshares == data.qty && data.status == 'COMPLETE';

            if (isCompleted) {
                this._processTradeEvent(tradeEvent)
                this.clearOrder(data.norenordno);
                // Route confirmation to the owning strategy
                const strategy = this.strategyMap.get(tradeEvent.user);
                if (strategy) {
                    await strategy.updateTrade(tradeEvent);
                }
                return tradeEvent

            }
        }
    }

    setTargetStopLoss(token: string, targetPoints: number, stopLossPoints: number, trailingDistance: number, user?: string) {
        const trade = this.trades.find(t => t.token === token && (!user || t.user === user));
        if (!trade) {
            Log.log(`[Monitor] setTargetStopLoss: trade not found for token ${token} user ${user}`);
            return;
        }
        if (targetPoints > 0) {
            trade.targetPrice = trade.price + targetPoints;
            trade.targetPoints = targetPoints;
        }
        if (stopLossPoints > 0) trade.stopLossPrice = trade.price - stopLossPoints;
        trade.trailingDistance = targetPoints >= 5 ? trailingDistance : 0;
        trade.highWaterMark = trade.price;
        trade.trailingActive = false;
        Log.log(`[Monitor] Set target=${trade.targetPrice} SL=${trade.stopLossPrice} trail=${trailingDistance} for ${trade.tsym}`);
        myEmitter.emit('position', this.trades);
    }

    // WARNING: If price reaches target, but sell is not made, then there is possibility of more loss
    updateQuote = async (optionQuote: OptionQuote) => {
        const matchingTrades = this.trades.filter(trade => trade.token === optionQuote.token);
        if (matchingTrades.length > 0) {
            for (const matchingTrade of matchingTrades) {
                matchingTrade.lastTradePrice = optionQuote.ltp;
                matchingTrade.realizedPnL = (matchingTrade.lastTradePrice - matchingTrade.price) * matchingTrade.quantity;

                // Phase 1: activate trailing when first target is hit (only if trailingDistance > 0)
                if (!matchingTrade.trailingActive && matchingTrade.targetPrice && matchingTrade.targetPoints && matchingTrade.trailingDistance) {
                    if (matchingTrade.lastTradePrice >= matchingTrade.targetPrice) {
                        matchingTrade.trailingActive = true;
                        matchingTrade.highWaterMark = matchingTrade.lastTradePrice;
                        matchingTrade.targetPrice = matchingTrade.highWaterMark + matchingTrade.targetPoints;
                        matchingTrade.stopLossPrice = matchingTrade.highWaterMark - matchingTrade.trailingDistance;
                        Log.log(`[Monitor] Trailing started for ${matchingTrade.tsym} HWM=${matchingTrade.highWaterMark} target=${matchingTrade.targetPrice} SL=${matchingTrade.stopLossPrice}`);
                    }
                }

                // Phase 2: trailing active — raise HWM, move target and SL upward only
                if (matchingTrade.trailingActive && matchingTrade.lastTradePrice > matchingTrade.highWaterMark) {
                    matchingTrade.highWaterMark = matchingTrade.lastTradePrice;
                    if (matchingTrade.targetPoints) {
                        matchingTrade.targetPrice = matchingTrade.highWaterMark + matchingTrade.targetPoints;
                    }
                    if (matchingTrade.trailingDistance) {
                        const newSL = matchingTrade.highWaterMark - matchingTrade.trailingDistance;
                        if (newSL > (matchingTrade.stopLossPrice ?? 0)) {
                            matchingTrade.stopLossPrice = newSL;
                        }
                    }
                }

                // Auto square-off on target or stop loss
                if (!matchingTrade.isSellPending) {
                    if (matchingTrade.targetPrice && matchingTrade.lastTradePrice >= matchingTrade.targetPrice) {
                        Log.log(`[Monitor] Target hit for ${matchingTrade.tsym} at ${matchingTrade.lastTradePrice}, auto square off`);
                        matchingTrade.isSellPending = true;
                        await Prism.getInstance().squareOffOrder(matchingTrade.token, matchingTrade.quantity, matchingTrade.user, matchingTrade.lastTradePrice);
                    } else if (matchingTrade.stopLossPrice && matchingTrade.lastTradePrice <= matchingTrade.stopLossPrice) {
                        Log.log(`[Monitor] Stop loss hit for ${matchingTrade.tsym} at ${matchingTrade.lastTradePrice}, auto square off`);
                        matchingTrade.isSellPending = true;
                        await Prism.getInstance().squareOffOrder(matchingTrade.token, matchingTrade.quantity, matchingTrade.user, matchingTrade.lastTradePrice);
                    }
                }
            }
        } else if (!this.watchTokens.has(optionQuote.token)) {
            Log.log(`[MOCK] No active trade for token ${optionQuote.token}, unsubscribing`);
            try { await AntStream.getInstance()?.unsubscribeOption(optionQuote.token) } catch (e) { /* AntStream not available */ }
        }

        this._processQuoteForStrategies(optionQuote)
        // Emit trades only if at least there is one open trade
        if (this.trades.some(trade => trade.open)) {
            myEmitter.emit('position', this.trades)
        }
    };

    _processTradeEvent = async (tradeEvent: Trade) => {
        Log.log(`[Trade] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`)
        try { Mongo.getInstance()?.insert(tradeEvent); } catch (e) { /* Mongo not available */ }
        if (tradeEvent.action == 'Buy') {
            this.pendingUsers.delete(tradeEvent.user || 'Default');
            // Match by tsym AND user so different strategies can hold the same contract independently
            const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user);
            if (index == -1) {
                this.trades.push(tradeEvent)
                // Subscribe to live price updates for this new position
                Log.log(`[MOCK] New trade added: user=${tradeEvent.user} tsym=${tradeEvent.tsym} token=${tradeEvent.token} right=${tradeEvent.right}`);
                Log.log('[Monitor] Subscribing to option for live prices:', tradeEvent.token);
                try { await AntStream.getInstance()?.subscribeOption(tradeEvent.token); } catch (e) { /* AntStream not available */ }
                // Auto-set target/SL if strategy provides monitor config
                const strategy = this.strategyMap.get(tradeEvent.user);
                if (strategy) {
                    const monitorConfig = strategy.getMonitorConfig();
                    if (monitorConfig) {
                        this.setTargetStopLoss(tradeEvent.token, monitorConfig.targetPoints, monitorConfig.stopLossPoints, monitorConfig.trailingDistance, tradeEvent.user);
                    }
                }
            } else {
                const trade = this.trades[index];
                const traded = trade.quantity * trade.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                trade.quantity += tradeEvent.quantity;
                const totalTraded = traded + newTraded
                trade.price = totalTraded / trade.quantity
                // Clear stale target/SL since average price has changed, then re-apply
                trade.targetPrice = undefined;
                trade.stopLossPrice = undefined;
                trade.isSellPending = false;
                Log.log(`[MOCK] Trade averaged: user=${trade.user} tsym=${trade.tsym} qty=${trade.quantity} avgPrice=${trade.price.toFixed(2)}`);
                const avgStrategy = this.strategyMap.get(tradeEvent.user);
                if (avgStrategy) {
                    const monitorConfig = avgStrategy.getMonitorConfig();
                    if (monitorConfig) {
                        this.setTargetStopLoss(tradeEvent.token, monitorConfig.targetPoints, monitorConfig.stopLossPoints, monitorConfig.trailingDistance, tradeEvent.user);
                    }
                }

            }
        } else {
            // Match by tsym AND user so each strategy's sell only closes its own trade
            const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user);

            if (index != -1) {
                const buyTrade = this.trades[index];
                Log.log('buyTrade: ', buyTrade)
                const user = buyTrade.user || 'Default';
                const realizedPnL = (tradeEvent.price - buyTrade.price) * buyTrade.quantity;
                buyTrade.open = false;
                buyTrade.realizedPnL = realizedPnL
                const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
                this.userPnL.set(user, cumulative);
                Log.log(`[Monitor] User '${user}' closed. P&L: ${realizedPnL.toFixed(2)}, Cumulative: ${cumulative.toFixed(2)}`);

                Log.log('Trade is closed ', tradeEvent.tsym, ' ', tradeEvent.quantity, ' Enabled auto trade: ', Config.auto)
                // Move to closedTrades before removing from active trades
                this.closedTrades.push(buyTrade);
                this.trades.splice(index, 1)
                // Only unsubscribe if no other strategy still holds this token
                const stillHeld = this.trades.some(t => t.token === tradeEvent.token);
                if (!stillHeld) {
                    Log.log(`[MOCK] Unsubscribing token ${tradeEvent.token} (no more holders)`);
                    try { await AntStream.getInstance()?.unsubscribeOption(tradeEvent.token); } catch (e) { /* AntStream not available */ }
                } else {
                    Log.log(`[MOCK] Keeping subscription for token ${tradeEvent.token} (other strategies still hold it)`);
                }
            }
        }
        Log.log('_processTradeEvent Emit ', this.trades)
        myEmitter.emit('position', this.trades)
    }

    async _processQuoteForStrategies(optionQuote: OptionQuote) {
        if (configService.getConfig().settings?.logQuotes) {
            try { Mongo.getInstance()?.insert(optionQuote); } catch (e) { /* Mongo not available */ }
        }
        const dispatched = new Set<Strategy>();

        // Find ALL trades for this token (multiple users can hold the same contract)
        const matchingTrades = this.trades.filter(t => t.token === optionQuote.token);
        for (const trade of matchingTrades) {
            const strategy = this.strategyMap.get(trade.user);
            if (strategy && !dispatched.has(strategy) && strategy.canHandleOptionQuote(optionQuote)) {
                dispatched.add(strategy);
                await strategy.processOptionQuote(optionQuote);
            }
        }

        // Also dispatch to strategies watching this token pre-trade (see watchToken)
        const watchers = this.watchTokens.get(optionQuote.token);
        if (watchers) {
            for (const strategy of watchers) {
                if (!dispatched.has(strategy) && strategy.canHandleOptionQuote(optionQuote)) {
                    dispatched.add(strategy);
                    await strategy.processOptionQuote(optionQuote);
                }
            }
        }
    }


}
