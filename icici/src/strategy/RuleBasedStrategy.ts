import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade, PeriodicStats, RSI } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';
import { ExitRule, ExitRules, exitDistance, exitRulesFrom, legacyExitKeysIn, timeoutFrom } from './exitRules';
import { RuleIndicator, parseRuleIndicator, ruleSignal, consensusOf, parseRuleLines, combineRules } from './ruleIndicators';

const round = (num: number) => Math.round(num * 100) / 100;

// Keys a RuleBased block carried before target/stopLoss became global. They are ignored; the constructor reports them.
const LEGACY_EXIT_KEYS = ['targetProfitPercent', 'stopLossPercent', 'targetPoints', 'stopLossPoints'];

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
    maxHoldMinutes: number = 0; // timeout resolved when the entry was placed; 0 = no timeout
    soldValue: number = 0;
    // Exit rules resolved when the entry was placed (so a config edit mid-trade does not move the levels of an open position).
    targetRule: ExitRule | null = null;
    stopRule: ExitRule | null = null;
    // Distances in points from the average entry price, recomputed by applyLevels() whenever that price changes. null = none.
    targetDist: number | null = null;
    stopDist: number | null = null;

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
        this.maxHoldMinutes = 0;
        this.targetRule = null;
        this.stopRule = null;
        this.targetDist = null;
        this.stopDist = null;
    }

    applyLevels() {
        this.targetDist = this.targetRule && this.price > 0 ? exitDistance(this.targetRule, this.price) : null;
        this.stopDist = this.stopRule && this.price > 0 ? exitDistance(this.stopRule, this.price) : null;
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

        // Timeout first, then target, then stop. Each closes the whole position once; the sell fill is booked in updateTrade.
        const timeout = this.maxHoldMinutes > 0 && timeElapsed >= this.maxHoldMinutes * 60 * 1000;
        let reason: 'timeout' | 'win' | 'loss' | null = null;
        if (!this.sellOrderPlaced) {
            if (timeout) reason = 'timeout';
            else if (this.targetDist !== null && quote.ltp >= this.price + this.targetDist) reason = 'win';
            else if (this.stopDist !== null && quote.ltp <= this.price - this.stopDist) reason = 'loss';
        }

        if (reason) {
            Log.log(`[Rule:${strategy.userId}] Selling ${this.contract}: ${reason.toUpperCase()} P&L=${round(profit)}`);
            this.sellOrderPlaced = true;
            this.exitReason = reason;
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
            this.applyLevels();
            if (config.logEnabled) {
                Log.log(`[Rule:${strategy.userId}] Buy confirmed: ${this.contract} qty=${this.quantity} price=${this.price} target=${this.targetDist ?? 'none'} stop=${this.stopDist ?? 'none'} (points)`);
            }
            return false;
        }

        // Later chunks of the same (freeze-limit split) buy: fold them into the position so exits are sized for
        // everything held. Only shortly after entry and before any exit has started.
        if (!this.buyOrderPlaced && trade.action === 'Buy' && this.price > 0 && !this.sellOrderPlaced && this.soldQty === 0 && Date.now() - this.entryTime < 120_000) {
            this.price = (this.price * this.quantity + trade.price * trade.quantity) / (this.quantity + trade.quantity);
            this.quantity += trade.quantity;
            this.applyLevels();
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

        // A Sell fill the strategy did not place itself (a resting broker-side sell filled): without this the contract is never
        // cleared and the strategy can never trade again. Chunked exits arrive as several fills - only complete once the held quantity is sold.
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
    // One entry per rule (a line of `indicators`); each rule is its indicators, all of which must agree (requireAllIndicators) or a majority.
    private ruleNames: string[][] = [];
    private parsed: RuleIndicator[][] = [];
    // Set when a listed indicator is unknown or not computed live: the block then never trades (reported once, in the constructor).
    private indicatorError: string | null = null;
    // The `indicators` value the current rules were parsed from; a different value in config.yml re-parses them (see loadRules).
    private rulesSource = '';

    constructor(userId?: string) {
        super(userId);
        const config = this.getConfig();
        this.enabled = config.enabled;
        this.loadRules(config.indicators);

        const legacy = legacyExitKeysIn(this.instanceConfig() as any, LEGACY_EXIT_KEYS);
        if (legacy.length > 0) {
            Log.log(`[RuleBased:${this.userId}] ALERT: ${legacy.join(', ')} ignored - exits come from target / stopLoss (this block or settings)`);
        }
    }


    // (Re)parses the rule list. Called at construction and again whenever config.yml's `indicators` changes, so an edit applies to the
    // running strategy (config is hot-read) instead of only after a restart. A parse failure blocks trading with an ALERT, as at startup.
    private loadRules(indicators: unknown): void {
        this.rulesSource = JSON.stringify(indicators ?? []);
        this.indicatorError = null;
        this.parsed = [];
        this.ruleNames = parseRuleLines(indicators as any);

        if (this.ruleNames.length === 0) {
            console.warn(`[RuleBased:${this.userId}] No rules configured - strategy will be inactive`);
            return;
        }
        try {
            this.parsed = this.ruleNames.map((names) => names.map((name) => parseRuleIndicator(name)));
            Log.log(`[RuleBased:${this.userId}] Initialized with ${this.ruleNames.length} rule(s): ${this.ruleNames.map((r) => r.join(',')).join(' | ')}`);
        } catch (e: any) {
            this.indicatorError = e?.message ?? String(e);
            Log.log(`[RuleBased:${this.userId}] ALERT: ${this.indicatorError} - this block will not trade`);
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
            logEnabled: myConfig?.logEnabled ?? true,
            // true: every indicator in a rule must agree. false: a majority of a rule's indicators must agree (NEUTRAL / no value casts no vote).
            requireAllIndicators: myConfig?.requireAllIndicators !== false,
        };
    }

    /**
     * Sole decision point. Each rule gives UP, DOWN or nothing. Any rule that fires buys; rules that disagree (one UP and one DOWN on the same
     * candle) give no trade.
     */
    receive(_oldStats: PeriodicStats, newStats: PeriodicStats) {
        if (!this.enabled || !newStats?.results) return;
        // Before the error check, so fixing a bad indicator name in config.yml clears the block without a restart.
        const latest = this.getConfig().indicators;
        if (JSON.stringify(latest ?? []) !== this.rulesSource) this.loadRules(latest);
        if (this.indicatorError) return;
        if (!this.isTimeInRange()) return;
        if (this.contract !== null) return;  // position already open

        const config = this.getConfig();
        if (!this.isCooldownElapsed(this.setting<number>('cooldownSeconds') ?? 0)) return;

        const ruleDirections = this.parsed.map((rule) => {
            const signals = rule.map((ind) => this.getIndicatorSignal(ind, newStats));
            const d = consensusOf(signals, config.requireAllIndicators);
            return d;
        });

        if (config.logEnabled) {
            const str = this.ruleNames.map((names, i) => `[${names.join(',')}]=${ruleDirections[i] ?? 'none'}`).join(' ');
            Log.log(`[Rule:${this.userId}] Rules: ${str}`);
        }

        const { direction, conflict } = combineRules(ruleDirections);
        if (conflict) {
            Log.log(`[Rule:${this.userId}] Rules disagree (one UP, one DOWN) - no trade`);
            return;
        }
        if (!direction) return;
        const side = direction === 'UP' ? CALL : PUT;

        const exits = this.resolveExits();
        if (!exits) return;
        const maxHoldMinutes = this.resolveTimeout();
        if (maxHoldMinutes === null) return;

        Log.log(`[Rule:${this.userId}] Consensus: ${side}`);
        this.recordTriggerTime();
        this.executeTrade(side, exits, maxHoldMinutes).catch(e =>
            console.error(`[Rule:${this.userId}] Trade execution error:`, e)
        );
    }

    // Target and stop from this block, else settings. An absent or invalid value stops the trade (ALERT), it is never read as "none".
    private resolveExits(): ExitRules | null {
        try {
            return exitRulesFrom(this.setting('target'), this.setting('stopLoss'), `RuleBased:${this.userId}`);
        } catch (e: any) {
            Log.log(`[Rule:${this.userId}] ALERT: ${e?.message ?? e} - not trading`);
            return null;
        }
    }

    // Timeout from settings.maxHoldTimeMinutes (or this block's override). 0 = no timeout. null = absent or invalid: the block does not trade (ALERT).
    private resolveTimeout(): number | null {
        try {
            return timeoutFrom(this.setting('maxHoldTimeMinutes'), `RuleBased:${this.userId}`) ?? 0;
        } catch (e: any) {
            Log.log(`[Rule:${this.userId}] ALERT: ${e?.message ?? e} - not trading`);
            return null;
        }
    }

    private getIndicatorSignal(ind: RuleIndicator, stats: PeriodicStats): string | null {
        return ruleSignal(ind, stats.results);
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

    private async executeTrade(right: string, exits: ExitRules, maxHoldMinutes: number) {
        // Set sentinel immediately to block re-entry from concurrent receive() calls
        this.contract = new RuleBasedContract();
        this.contract.right = right;
        this.contract.maxHoldMinutes = maxHoldMinutes;
        this.contract.targetRule = exits.target;
        this.contract.stopRule = exits.stop;

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
                this.contract.applyLevels();
            } else {
                Log.log(`[Rule:${this.userId}] ALERT: outcome of the buy of ${contract} unknown - keeping the entry lock, check the broker`);
            }
        }
    }
}
