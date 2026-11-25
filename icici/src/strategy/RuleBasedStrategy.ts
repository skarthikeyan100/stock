import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade, PeriodicStats, RSI } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';
import { registerTrade } from '../processes/strategies/tokenRouter';
import { BROKER_TO_FEED_SOURCE, DEFAULT_FEED_SOURCE } from '../ipc/feedSource';
import { exchangeForTsym } from '../util/underlyings';
import { ExitRule, ExitRules, exitDistance, exitRulesFrom, legacyExitKeysIn, timeoutFrom } from './exitRules';
import { BrokerName, configuredBrokersOf, normalizeBrokerName } from '../util/brokerName';
import { brokerLegOps, chunkedLegSell } from './LegBrokerOps';
import { expiryDayOverrideOf } from '../util/expirySkip';
import { RuleIndicator, parseRuleIndicator, ruleSignal, consensusOf, parseRuleLines, combineRules } from './ruleIndicators';

const round = (num: number) => Math.round(num * 100) / 100;

// Keys a RuleBased block carried before target/stopLoss became global. They are ignored; the constructor reports them.
const LEGACY_EXIT_KEYS = ['targetProfitPercent', 'stopLossPercent', 'targetPoints', 'stopLossPoints'];

interface RuleEntry { tsym: string; token: string; exchange: 'NFO' | 'BFO'; premium: number }

class RuleBasedContract {
    contract: string = '';
    token: string = '';
    price: number = 0;
    quantity: number = 0;
    right: string = '';
    // The broker this position is held on: the instance's own broker for a new entry, the trade row's broker for a restored one
    // (a position opened on another broker than the config now lists is still exited where it is held).
    broker: BrokerName = 'kite';
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
        this.broker = 'kite';
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
            try {
                await strategy.sellPosition(this.broker, this.contract, this.quantity, quote.ltp);
            } catch (e: any) {
                // sellOrderPlaced stays set: the sell may be live at the broker, a blind retry could stack a second one (the order side's
                // NEVER-SHORT guard and the sell fill / reconcile settle it).
                Log.log(`[Rule:${strategy.userId}] ALERT: exit sell of ${this.contract} (${this.broker}) failed or is unconfirmed - check the broker: ${e?.message ?? e}`);
            }
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
            // The instance's own broker (expanded per `brokers:` entry by util/strategyInstances.ts); a block not expanded yet falls back to its first listed broker, default kite.
            broker: (normalizeBrokerName(myConfig?.broker) || configuredBrokersOf(myConfig)[0] || 'kite') as BrokerName,
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

    private lastNiftyLtp = 0;

    // Decisions happen in receive(); the quote only keeps the underlying LTP the entry's contract pick needs.
    async processNiftyQuote(quote: NiftyQuote) {
        if (Number(quote?.ltp) > 0) this.lastNiftyLtp = Number(quote.ltp);
    }

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

    // Restores the one open position from Mongo after a restart (2026-11-11: the position lived only in `contract`, so a restart left a live
    // RuleBased position with no tick watch and no exit). State only - a reconcile never trades: the position is rebuilt from the user's open
    // trade (entry price, quantity, entry time), its exit rules are re-resolved from the current config exactly as at entry, and its token is
    // registered for ticks so the tick-driven exit in RuleBasedContract.processOptionQuote runs again. A restart cannot know the target/stop
    // levels the position was entered with, so a config edit between entry and restart moves them (logged).
    async reconcile(): Promise<void> {
        if (this.contract) return; // a position already tracked in memory (POST /reconcile while running)
        let open: any[];
        try {
            open = await OrderClient.getInstance().getOpenTrades(this.userId);
        } catch (e) {
            Log.log(`[Rule:${this.userId}] reconcile: could not read the open trades:`, e);
            return;
        }
        const held = (open ?? []).filter((t: any) => Number(t.quantity) > 0 && t.tsym && t.token);
        if (held.length === 0) return;
        held.sort((a: any, b: any) => new Date(b.entryTime ?? 0).getTime() - new Date(a.entryTime ?? 0).getTime());
        const t = held[0];
        if (held.length > 1) Log.log(`[Rule:${this.userId}] ALERT: reconcile: ${held.length} open positions (${held.map((h: any) => h.tsym).join(', ')}); RuleBased tracks one - managing ${t.tsym}, the others are unmanaged`);
        const exits = this.resolveExits();
        const maxHoldMinutes = this.resolveTimeout();
        if (!exits || maxHoldMinutes === null) {
            Log.log(`[Rule:${this.userId}] ALERT: reconcile: ${t.tsym} is held but the exit rules are not valid in config - NOT restored, no exit will run (check target / stopLoss / maxHoldTimeMinutes)`);
            return;
        }
        const c = new RuleBasedContract();
        c.contract = t.tsym;
        c.token = String(t.token);
        c.price = Number(t.price);
        c.quantity = Number(t.quantity);
        c.right = /CE$|C\d+$/.test(String(t.tsym)) ? CALL : PUT;
        // The row's own broker, not the config's: a position opened on another broker (e.g. Prism, before the block listed kite only) is exited there.
        const broker = (normalizeBrokerName(t.broker ?? 'kite') || 'kite') as BrokerName;
        c.broker = broker;
        const entryMs = t.entryTime ? new Date(t.entryTime).getTime() : NaN;
        c.entryTime = Number.isFinite(entryMs) ? entryMs : Date.now();
        c.maxHoldMinutes = maxHoldMinutes;
        c.targetRule = exits.target;
        c.stopRule = exits.stop;
        c.applyLevels();
        this.contract = c;
        registerTrade(c.token, this, BROKER_TO_FEED_SOURCE[broker] ?? DEFAULT_FEED_SOURCE, exchangeForTsym(c.contract));
        Log.log(`[Rule:${this.userId}] reconcile: restored the open position ${c.contract} (${broker}) qty=${c.quantity} avg=${c.price} entered ${new Date(c.entryTime).toISOString()}; target=${c.targetDist ?? 'none'} stop=${c.stopDist ?? 'none'} timeout=${c.maxHoldMinutes || 'none'} min - its exit runs from ticks`);
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

    // The contract to buy on this instance's broker: ATM-first strike walk from the live NIFTY LTP with a premium floor of settings.minPrice
    // (the same range the Prism-only lookup used, settings.minPrice..maxPrice), in the broker's own symbology. null = none in range.
    protected async pickEntry(right: string): Promise<RuleEntry | null> {
        if (!(this.lastNiftyLtp > 0)) throw new Error('no NIFTY LTP yet');
        const settings = (configService.getConfig().settings ?? {}) as any;
        const minPremium = Number(settings.minPrice) > 0 ? Number(settings.minPrice) : 1;
        const maxPrice = Number(settings.maxPrice);
        const ops = brokerLegOps(() => this.getConfig().broker);
        const c = await ops.pickContract(this.userId, this.lastNiftyLtp, right === CALL ? 'CE' : 'PE', minPremium, [], expiryDayOverrideOf(this.instanceConfig()));
        if (Number.isFinite(maxPrice) && maxPrice > 0 && c.premium > maxPrice) return null;
        return { tsym: c.tradingSymbol, token: c.token, exchange: c.exchange, premium: c.premium };
    }

    // Market buy on this instance's broker only (never another broker's path). Returns null on any failure: the caller verifies what is held.
    protected async buyEntry(entry: RuleEntry, quantity: number): Promise<{ quantity: number; price: number } | null> {
        Log.log('Buy Contract by ', this.userId, ' for contract: ', entry.tsym, ' on ', this.getConfig().broker);
        try {
            const ops = brokerLegOps(() => this.getConfig().broker);
            const t = await ops.buy(this.userId, entry.tsym, entry.token, quantity, entry.exchange, entry.premium);
            return { quantity: Number(t?.quantity), price: Number(t?.price) };
        } catch (e) {
            Log.log(this.userId, ' buy failed: ', e);
            return null;
        }
    }

    // Exit sell on the broker the position is held on (the instance's own for a new entry, the trade row's for a restored one).
    async sellPosition(broker: BrokerName, contract: string, quantity: number, _price?: number): Promise<void> {
        Log.log('Sell Contract by ', this.userId, ' for contract: ', contract, ' on ', broker);
        await chunkedLegSell(this.userId, contract, quantity, broker);
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
        const broker = config.broker;
        this.contract.broker = broker;

        if (!(Number(config.quantity) > 0)) {
            Log.log(`[Rule:${this.userId}] ALERT: quantity ${config.quantity} is not a positive number - not buying`);
            this.contract = null;
            return;
        }

        let entry: RuleEntry | null;
        try {
            entry = await this.pickEntry(right);
        } catch (e: any) {
            Log.log(`[Rule:${this.userId}] No ${broker} contract found: ${e?.message ?? e}`);
            this.contract = null;
            return;
        }
        if (!entry) {
            Log.log(`[Rule:${this.userId}] No contract found in price range`);
            this.contract = null;
            return;
        }
        const contract = entry.tsym;
        const token = entry.token;

        Log.log(`[Rule:${this.userId}] TRIGGERED: ${right}, buying ${contract} (${broker}) qty=${config.quantity} token=${token}`);

        this.contract.contract = contract;
        this.contract.token = token;
        this.contract.buyOrderPlaced = true;

        const order = await this.buyEntry(entry, config.quantity);
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
