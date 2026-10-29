import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade, PeriodicStats, RSI, MACD, Bollinger, EMACrossOver } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';

const round = (num: number) => Math.round(num * 100) / 100;

class RuleBasedContract {
    contract: string = '';
    token: string = '';
    price: number = 0;
    quantity: number = 0;
    right: string = '';
    entryTime: number = 0;
    buyOrderPlaced: boolean = false;
    sellOrderPlaced: boolean = false;
    ltp: number = 0;
    exitReason: 'win' | 'loss' | 'timeout' | null = null;
    exitPnl: number = 0;
    soldQty: number = 0; // monitor-triggered (target/SL) exit fills accumulated so far
    soldValue: number = 0;

    clear() {
        this.contract = '';
        this.token = '';
        this.price = 0;
        this.quantity = 0;
        this.right = '';
        this.entryTime = 0;
        this.buyOrderPlaced = false;
        this.sellOrderPlaced = false;
        this.ltp = 0;
        this.exitReason = null;
        this.exitPnl = 0;
        this.soldQty = 0;
        this.soldValue = 0;
    }

    async processOptionQuote(quote: OptionQuote, strategy: RuleBasedStrategy): Promise<boolean> {
        if (this.price === 0 || this.token !== quote.token) {
            return false;
        }

        const config = strategy.getConfig();
        this.ltp = quote.ltp;

        const profit = (quote.ltp - this.price) * this.quantity;
        const priceDiff = quote.ltp - this.price;
        const timeElapsed = Date.now() - this.entryTime;

        if (config.logEnabled) {
            Log.log(`[Rule:${strategy.userId}] ${this.contract} P&L=${round(profit)} diff=${round(priceDiff)}`);
        }

        const timeout = config.maxHoldTimeMinutes > 0 && timeElapsed >= config.maxHoldTimeMinutes * 60 * 1000;

        if (timeout && !this.sellOrderPlaced) {
            Log.log(`[Rule:${strategy.userId}] Selling ${this.contract}: TIMEOUT P&L=${round(profit)}`);
            this.sellOrderPlaced = true;
            this.exitReason = 'timeout';
            this.exitPnl = profit;
            await strategy.sellContract(this.contract, this.quantity, quote.ltp);
        }

        return false;
    }

    async updateTrade(trade: Trade, strategy: RuleBasedStrategy): Promise<boolean> {
        if (trade.tsym !== this.contract) {
            return false;
        }

        const config = strategy.getConfig();

        if (this.buyOrderPlaced && trade.action === 'Buy') {
            this.buyOrderPlaced = false;
            this.price = trade.price;
            this.quantity = trade.quantity;
            this.entryTime = Date.now();
            if (config.logEnabled) {
                Log.log(`[Rule:${strategy.userId}] Buy confirmed: ${this.contract} qty=${this.quantity} price=${this.price}`);
            }
            return false;
        }

        // Later chunks of the same (freeze-limit split) buy: fold them into the position so exits are sized for
        // everything held. Only shortly after entry and before any exit has started.
        if (!this.buyOrderPlaced && trade.action === 'Buy' && this.price > 0 && !this.sellOrderPlaced && this.soldQty === 0 && Date.now() - this.entryTime < 120_000) {
            this.price = (this.price * this.quantity + trade.price * trade.quantity) / (this.quantity + trade.quantity);
            this.quantity += trade.quantity;
            return false;
        }

        if (this.sellOrderPlaced && trade.action === 'Sell') {
            this.sellOrderPlaced = false;
            if (config.logEnabled) {
                Log.log(`[Rule:${strategy.userId}] Sell confirmed: ${this.contract}`);
            }
            strategy.recordOutcome(this.exitReason ?? 'loss', this.exitPnl);
            return true;
        }

        // A Sell fill the strategy did not place itself: the broker-side target/stop-loss closed the
        // position. Without this the contract is never cleared and the strategy can never trade again. Chunked exits
        // arrive as several fills - only complete once the held quantity is sold.
        if (!this.sellOrderPlaced && !this.buyOrderPlaced && trade.action === 'Sell' && this.price > 0 && this.quantity > 0) {
            this.soldQty += trade.quantity;
            this.soldValue += trade.quantity * trade.price;
            if (this.soldQty < this.quantity) return false;
            const profit = this.soldValue - this.price * this.soldQty;
            if (config.logEnabled) {
                Log.log(`[Rule:${strategy.userId}] Sell confirmed (monitor): ${this.contract} P&L=${round(profit)}`);
            }
            strategy.recordOutcome(profit >= 0 ? 'win' : 'loss', profit);
            return true;
        }

        return false;
    }
}

export default class RuleBasedStrategy extends Strategy {
    private contract: RuleBasedContract | null = null;
    private indicators: string[] = [];

    constructor(userId?: string) {
        super(userId);
        const config = this.getConfig();
        this.enabled = config.enabled;
        this.indicators = config.indicators || [];

        if (this.indicators.length === 0) {
            console.warn(`[RuleBased:${this.userId}] No indicators configured - strategy will be inactive`);
        } else {
            Log.log(`[RuleBased:${this.userId}] Initialized with indicators: ${this.indicators.join(', ')}`);
        }
    }


    getConfig() {
        const strategiesSingleton = require('./strategies').default;
        let myConfig = strategiesSingleton.getExpandedConfig(this.userId);

        if (!myConfig) {
            const allStrategies = configService.getConfig().strategies || [];
            myConfig = allStrategies.find(s => (s.userId || s.type) === this.userId);
        }

        return {
            enabled: myConfig?.enabled ?? false,
            indicators: myConfig?.indicators || [],
            quantity: myConfig?.quantity ?? 0,
            target: myConfig?.target ?? 10,
            stopLoss: myConfig?.stopLoss ?? 5,
            maxHoldTimeMinutes: myConfig?.maxHoldTimeMinutes ?? 30,
            logEnabled: myConfig?.logEnabled ?? true
        };
    }

    /**
     * Sole decision point. Collects all indicator signals from the current stats snapshot.
     * Only trades when every configured indicator is non-null, non-NEUTRAL, and all agree.
     */
    receive(_oldStats: PeriodicStats, newStats: PeriodicStats) {
        if (!this.enabled || !newStats?.results) return;
        if (!this.isTimeInRange()) return;
        if (this.contract !== null) return;  // position already open

        const config = this.getConfig();
        if (!this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) return;

        const signals: Record<string, string | null> = {};
        for (const name of this.indicators) {
            signals[name] = this.getIndicatorSignal(name, newStats);
        }

        if (config.logEnabled) {
            const str = Object.entries(signals).map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ');
            Log.log(`[Rule:${this.userId}] Signals: ${str}`);
        }

        const direction = this.consensus(signals);
        if (!direction) return;

        Log.log(`[Rule:${this.userId}] Consensus: ${direction}`);
        this.recordTriggerTime();
        this.executeTrade(direction).catch(e =>
            console.error(`[Rule:${this.userId}] Trade execution error:`, e)
        );
    }

    /**
     * All indicators must be present (non-null) and non-NEUTRAL and agree.
     * A single NEUTRAL or missing signal blocks the trade.
     */
    private consensus(signals: Record<string, string | null>): string | null {
        const values = Object.values(signals);

        if (values.some(s => s === null || s === 'NEUTRAL')) return null;

        const upCount = values.filter(s => s === 'UP').length;
        const downCount = values.filter(s => s === 'DOWN').length;

        if (upCount === values.length) return CALL;
        if (downCount === values.length) return PUT;
        return null;
    }

    private getIndicatorSignal(indicatorName: string, stats: PeriodicStats): string | null {
        const parts = indicatorName.split('_');
        if (!stats.results) return null;

        if (parts[0] === 'RSI' && parts.length >= 4) {
            const match = (stats.results.rsi || []).find((rsi: RSI) =>
                rsi.period === parseInt(parts[1]) &&
                rsi.overbought === parseInt(parts[2]) &&
                rsi.oversold === parseInt(parts[3])
            );
            return match?.trend || null;
        }

        if (parts[0] === 'MACD' && parts.length === 4) {
            const match = (stats.results.macd || []).find((macd: MACD) =>
                macd.shortPeriod === parseInt(parts[1]) &&
                macd.longPeriod === parseInt(parts[2]) &&
                macd.signalPeriod === parseInt(parts[3])
            );
            return match?.trend || null;
        }

        if (parts[0] === 'EMA' && parts.length === 3) {
            const match = (stats.results.ema || []).find((ema: EMACrossOver) =>
                ema.shortPeriod === parseInt(parts[1]) &&
                ema.longPeriod === parseInt(parts[2])
            );
            return match?.trend || null;
        }

        if (parts[0] === 'Bollinger' && parts.length === 3) {
            const match = (stats.results.bollinger || []).find((bb: Bollinger) =>
                bb.period === parseInt(parts[1]) &&
                bb.numDeviations === parseFloat(parts[2])
            );
            return match?.trend || null;
        }

        if (parts[0] === 'ADX' && parts.length === 2) {
            const match = (stats.results.adx || []).find((adx: any) =>
                adx.period === parseInt(parts[1])
            );
            return match?.trend || null;
        }

        if (parts[0] === 'Stoch' && parts.length === 3) {
            const match = (stats.results.stochastic || []).find((stoch: any) =>
                stoch.kPeriod === parseInt(parts[1]) &&
                stoch.dPeriod === parseInt(parts[2])
            );
            return match?.trend || null;
        }

        console.warn(`[Rule:${this.userId}] Unknown indicator format: ${indicatorName}`);
        return null;
    }

    // No-op: all decisions happen in receive()
    async processNiftyQuote(_quote: NiftyQuote) {}

    async processOptionQuote(quote: OptionQuote) {
        if (this.contract) {
            const closed = await this.contract.processOptionQuote(quote, this);
            if (closed) {
                this.contract.clear();
                this.contract = null;
            }
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.contract !== null && this.contract.token === quote.token;
    }

    reset(): void {
        super.reset();
        this.contract = null;
    }

    updateTrade = async (trade: Trade): Promise<void> => {
        if (this.contract) {
            const closed = await this.contract.updateTrade(trade, this);
            if (closed) {
                this.contract.clear();
                this.contract = null;
            }
        }
    }

    private async executeTrade(right: string) {
        // Set sentinel immediately to block re-entry from concurrent receive() calls
        this.contract = new RuleBasedContract();
        this.contract.right = right;

        const config = this.getConfig();
        const orderClient = OrderClient.getInstance();

        const contract = await orderClient.getContractByPriceRange(this.userId, right);
        if (!contract) {
            Log.log(`[Rule:${this.userId}] No contract found in price range`);
            this.contract = null;
            return;
        }

        const token = await orderClient.getToken(this.userId, contract);
        if (!token) {
            Log.log(`[Rule:${this.userId}] Token not found for contract ${contract}`);
            this.contract = null;
            return;
        }

        Log.log(`[Rule:${this.userId}] TRIGGERED: ${right}, buying ${contract} qty=${config.quantity} token=${token}`);

        this.contract.contract = contract;
        this.contract.token = token;
        this.contract.buyOrderPlaced = true;

        const order = await this.buyContract(contract, config.quantity);
        if (!order && this.contract && this.contract.price === 0) {
            // buyContract swallows every error, including a timeout where the order may have filled. Only release the
            // sentinel once the order process confirms the contract is NOT held; if it is held (or the check fails)
            // keep the lock so a second buy cannot stack on top.
            let held: any | undefined;
            let known = true;
            try {
                const open = await orderClient.getOpenTrades(this.userId);
                held = open.find((t: any) => t.tsym === contract && Number(t.quantity) > 0);
            } catch (e) {
                known = false;
                Log.log(`[Rule:${this.userId}] could not verify whether the failed buy of ${contract} filled:`, e);
            }
            if (known && !held) {
                Log.log(`[Rule:${this.userId}] Buy of ${contract} failed and nothing is held - releasing the entry lock`);
                this.contract = null;
            } else if (held && this.contract && this.contract.price === 0) {
                Log.log(`[Rule:${this.userId}] ALERT: buy of ${contract} reported failure but ${held.quantity} is held - adopting it`);
                this.contract.price = Number(held.price);
                this.contract.quantity = Number(held.quantity);
                this.contract.entryTime = Date.now();
                this.contract.buyOrderPlaced = false;
            } else {
                Log.log(`[Rule:${this.userId}] ALERT: outcome of the buy of ${contract} unknown - keeping the entry lock, check the broker`);
            }
        }
    }
}
