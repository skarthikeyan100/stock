import Log from '../util/Log';
import { NIFTY, MOCK_BROKER, CALL, PUT } from "../constants";
import configService from '../prism/ConfigService';
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import moment from "moment";
import Monitor from "../monitor";

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

export abstract class Strategy {
    userId: string
    tradeMap : Map<String, Trade> = new Map()
    orderMap : Map<String, OrderInfo> = new Map()
    name: string
    BUY = 'Buy'
    SELL = 'Sell'
    ordered = false
    enabled = false
    token: string
    multipleTradesAllowed: true

    // Win/loss tracking
    wins = 0
    losses = 0
    timeouts = 0
    totalPnL = 0
    timeoutPnL = 0

    // Cooldown tracking (shared across all strategies)
    protected lastTriggerTime: number = 0

    protected isCooldownElapsed(cooldownSeconds: number): boolean {
        if (cooldownSeconds <= 0) return true;
        return Date.now() - this.lastTriggerTime >= cooldownSeconds * 1000;
    }

    protected isSentimentAligned(quote: NiftyQuote, right: string): boolean {
        if (!quote?.buyQty || !quote?.sellQty) return true; // skip in mock mode (data absent)
        if (right === CALL) return quote.buyQty > quote.sellQty;
        if (right === PUT)  return quote.sellQty > quote.buyQty;
        return true;
    }

    protected recordTriggerTime(): void {
        this.lastTriggerTime = Date.now();
    }

    getMonitorConfig(): { targetPoints: number; stopLossPoints: number; trailingDistance: number } | null {
        return {
            targetPoints: configService.getConfig().settings.targetPriceDiff,
            stopLossPoints: configService.getConfig().settings.stopLossPriceDiff,
            trailingDistance: configService.getConfig().settings.trailingDistance,
        };
    }

    recordOutcome(outcome: 'win' | 'loss' | 'timeout', pnl: number) {
        this.totalPnL += pnl;
        if (outcome === 'win') this.wins++;
        else if (outcome === 'loss') this.losses++;
        else { this.timeouts++; this.timeoutPnL += pnl; }
        const total = this.wins + this.losses;
        const winRate = total > 0 ? ((this.wins / total) * 100).toFixed(1) : 'N/A';
        Log.log(`[${this.userId}] Outcome=${outcome} PnL=${Math.round(pnl)} | W=${this.wins} L=${this.losses} T=${this.timeouts} WinRate=${winRate}% TotalPnL=${Math.round(this.totalPnL)}`);
    }

    getStats() {
        const total = this.wins + this.losses;
        return {
            userId: this.userId,
            type: this.getClassName(),
            wins: this.wins,
            losses: this.losses,
            timeouts: this.timeouts,
            totalTrades: this.wins + this.losses + this.timeouts,
            winRate: total > 0 ? Math.round((this.wins / total) * 1000) / 10 : null,
            totalPnL: Math.round(this.totalPnL),
            timeoutPnL: Math.round(this.timeoutPnL),
        };
    }

    constructor(userId?: string) {
        this.userId = userId || this.constructor.name;
    }

    getUserContext() {
        return Monitor.getInstance().getUserContext(this.userId);
    }

    abstract receive(oldStats, newStats);
    abstract processNiftyQuote(quote: NiftyQuote);
    abstract processOptionQuote(quote: OptionQuote);

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    isTimeInRange(): boolean {
        if (MOCK_BROKER) return true;  // bypass time check in mock/test mode
        const now = moment();
        const startTime = moment().hour(10).minute(0);
        const endTime = moment().hour(15).minute(0);

        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    getClassName(): string {
        return this.constructor.name;
    }

    async addOrder(price, right, quantity?: number) {
        const order = await Monitor.getInstance().requestBuyIndex(this.userId, NIFTY, price, right, quantity);
        if (!order) return null;
        Log.log(this.userId, ' In add order ', order)
        this.orderMap.set(order.contract, order);
        this.ordered = true;
        return {
            contract: order.contract,
            price: order.price,
            qty: order.qty,
            token: order.token
        }
    }

    async buyContract(contract: string, quantity: number, price?: number ): Promise<OrderInfo | null> {
        Log.log('Buy Contract by ', this.userId, ' for contract: ', contract)
        const response = await Monitor.getInstance().requestBuy(this.userId, contract, quantity, price);
        return response;
    }

    async sellContract(contract: string, quantity: number, price?: number ) {
        Log.log('Sell Contract by ', this.userId, ' for contract: ', contract, ' for the price ', price)
        const response = await Monitor.getInstance().requestSell(this.userId, contract, quantity, price);
        return response;
    }

    updateTrade = async (trade: Trade) : Promise<void> => {
        Log.log('*******  SHOULD BE OVERRIDDEN ******* ', trade)
    }
}