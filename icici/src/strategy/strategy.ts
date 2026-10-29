import { NOT_PLACED_TAG } from '../ipc/orderProtocol';
import Log from '../util/Log';
import { MOCK_BROKER } from "../constants";
import configService from '../prism/ConfigService';
import { NiftyQuote, OptionQuote, OrderInfo, SensexQuote, Trade } from "../model/model";
import { OrderCancelledNotification } from '../ipc/orderProtocol';
import moment from "moment";
import { StrategyInstanceConfig } from '../prism/AppConfig';
import OrderClient from "../processes/strategies/OrderClient";
import { isWithinTradingWindow } from '../util/marketHours';
import { FeedSource } from '../ipc/feedSource';

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

    // Set by strategies whose legs always carry ANT tokens, whatever broker places the orders (LegManager: the Kite and Breeze bare
    // buys store `trade.token = antToken`). Their ticks must come from the ANT feed: routing by the order broker would subscribe an
    // ANT token on the Breeze feed, where it is a different instrument or nothing, and tick-driven exits would never fire (R5-4).
    legTokenFeed?: FeedSource

    // False until the startup (or a manual POST /reconcile) reconcile has run for this strategy. A restarted strategy has no memory of
    // the open positions it held, so a tick before then could open a duplicate or leave a live leg without its stop (review R4-1/R4-2/R5-1).
    // Set by strategiesProcess; a strategy whose reconcile() threw stays false (and is retried) rather than trading blind.
    stateLoaded = false

    // What the dispatcher checks before delivering a tick, fill or cancellation: enabled in config.yml, inside the trading window,
    // and state loaded. The window is a read-only clock test, so `enabled` stays equal to config.yml (it used to be force-cleared in
    // memory at 15:25 and never restored, which silently disabled a strategy that config still said was on).
    receivesEvents(): boolean {
        return this.enabled && this.stateLoaded && isWithinTradingWindow();
    }

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

    protected recordTriggerTime(): void {
        this.lastTriggerTime = Date.now();
    }

    // ANT's raw ft field (which becomes NiftyQuote/OptionQuote.ltt via
    // *.fromAnt) is Unix epoch SECONDS, e.g. "ft": "1789722664" observed on a
    // real live tick 2026-09-18 - not milliseconds. Every backtest/hypothesis-
    // test tool in this codebase already knows this and converts with
    // `Number(r.ltt) * 1000` at its own point of use (see backtestCsvUtils.ts,
    // SupportResistanceHypothesisTest.ts, etc.); the live path never got the
    // same treatment, which silently broke ContinuousStrategy's PCR-recheck
    // throttle (needed ~83 hours to release instead of 5 minutes) until fixed
    // the same day. Any strategy comparing tick timestamps against a
    // millisecond-scale threshold (cooldowns, breach-confirm windows, etc.)
    // needs this same normalization - shared here rather than duplicated per
    // strategy. Backtest tick.ltt already arrives pre-converted to ms (via
    // backtestCsvUtils), so a blind `* 1000` would double-convert and break
    // it - normalize by magnitude instead (a real "seconds" epoch is
    // comfortably under 1e12 for centuries; a real "ms" epoch already exceeds
    // it today).
    protected toMillis(ltt: number | string | undefined): number | undefined {
        if (!ltt) return undefined;
        const n = Number(ltt);
        if (!n) return undefined;
        return n < 1e12 ? n * 1000 : n;
    }

    // This instance's own config block. configService.getStrategyConfig(type) returns only the FIRST block of a
    // type, so a second instance (distinct userId) of Continuous/SR/Hourly/... would silently run on instance #1's
    // quantity/right/limits. Strategies.expandedConfigs is keyed by the same userId the instance was built with.
    // Lazy require: strategies.ts -> StrategyFactory -> concrete strategies -> this file would otherwise be a cycle.
    private static strategiesModule: any;
    private static instanceConfigErrorLogged = false;
    protected instanceConfig(): StrategyInstanceConfig {
        let expanded: StrategyInstanceConfig | undefined;
        try {
            if (!Strategy.strategiesModule) Strategy.strategiesModule = require('./strategies').default;
            expanded = Strategy.strategiesModule.getExpandedConfig(this.userId);
        } catch (e) {
            if (!Strategy.instanceConfigErrorLogged) {
                Strategy.instanceConfigErrorLogged = true;
                Log.log('[Strategy] instanceConfig: could not read this instance\'s expanded config, falling back to the first config block of its type (not initialised, or a real error):', e);
            }
        }
        return expanded ?? configService.getStrategyConfig(this.getClassName());
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

    reset(): void {
        this.lastTriggerTime = 0;
        Log.log(`[${this.userId}] Reset via admin request`);
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

    abstract receive(oldStats, newStats);
    abstract processNiftyQuote(quote: NiftyQuote);
    abstract processOptionQuote(quote: OptionQuote);

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    async processSensexQuote(quote: SensexQuote): Promise<void> {}

    isTimeInRange(): boolean {
        if (MOCK_BROKER) return true;  // bypass time check in mock/test mode
        const now = moment();
        const startTime = moment().hour(10).minute(0).second(0).millisecond(0);
        const endTime = moment().hour(15).minute(0).second(0).millisecond(0);

        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    getClassName(): string {
        return this.constructor.name;
    }

    // buyContract/sellContract take an already-resolved broker contract symbol -
    // the Prism/Shoonya path (src/processes/order/prismExecutor.ts), used by
    // strategies that pick their own contract (e.g. via getContractByPriceRange)
    // rather than an ATM-by-LTP lookup.
    // After buyContract returned null: true when the refusal was definite (the order never reached the broker), false when the outcome
    // is unknown (timeout/transport) and the order may still be live.
    protected lastBuyDefinitelyNotPlaced = false;

    async buyContract(contract: string, quantity: number, price?: number ): Promise<OrderInfo | null> {
        Log.log('Buy Contract by ', this.userId, ' for contract: ', contract)
        this.lastBuyDefinitelyNotPlaced = false; // never carry a previous call's value
        try {
            const response = await OrderClient.getInstance().buyContract(this.userId, contract, quantity, price);
            return { contract: response.contract, price: response.price, qty: response.qty, token: response.token } as any;
        } catch (e) {
            Log.log(this.userId, ' buyContract failed: ', e);
            this.lastBuyDefinitelyNotPlaced = String((e as any)?.message ?? e).includes(NOT_PLACED_TAG);
            return null;
        }
    }

    async sellContract(contract: string, quantity: number, price?: number ) {
        Log.log('Sell Contract by ', this.userId, ' for contract: ', contract, ' for the price ', price)
        return await OrderClient.getInstance().sellContract(this.userId, contract, quantity, price);
    }

    updateTrade = async (trade: Trade) : Promise<void> => {
        Log.log('*******  SHOULD BE OVERRIDDEN ******* ', trade)
    }

    onOrderCancelled = async (notification: OrderCancelledNotification): Promise<void> => {
        // Default no-op - subclasses override if they need to handle order cancellations
        // (e.g. BulkPcrStrategy re-places exit sells when resting orders are cancelled).
    }
}