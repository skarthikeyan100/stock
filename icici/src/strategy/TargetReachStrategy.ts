import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { watchToken, unwatchToken } from '../processes/strategies/tokenRouter';
import { CALL, PUT } from '../constants';
import { exchangeForIndex } from '../util/underlyings';
import { localDayKey } from './dayKey';
import fs from 'fs';
import path from 'path';

// Watches a single option contract specified in config (symbol+strike+expiry+
// optionType) and buys it once its own LTP reaches a configured target price -
// unlike other strategies, which react to NIFTY moves and pick a contract
// afterwards, this one is told exactly which contract to watch up front.
// Resolves the contract to an ANT token at construction time (via
// AntContractMaster, synchronous/local) and registers as a Monitor "watcher"
// for that token (see Monitor.watchToken) so it receives live ticks before it
// holds any position - normal quote routing only fires for tokens with an
// open trade. Reuses GoodMorningStrategy's Kite entry+GTT exit; fires at
// most once per arming, until reset() re-arms the watch (see GET /strategies/:type/reset).
export default class TargetReachStrategy extends Strategy {
    private fired = false;
    private symbol: string;
    private strike: number;
    private expiry: string;
    private optionType: 'CE' | 'PE';
    private exchange: 'NFO' | 'BFO' = 'NFO';
    private watching = false;

    // "Fired today" survives a restart: the block stays enabled after it buys, so a restart used to re-arm it and buy again at once while
    // the option was still above the target. Keyed by day + contract + target, so a new contract/target in config arms it again.
    private firedFile(): string {
        return path.join(__dirname, `../../.TargetReachStrategy.${this.userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.fired.json`);
    }
    private firedKey(config: any): string {
        return `${localDayKey()}|${config.symbol || 'NIFTY'}|${config.strike}|${config.expiry}|${config.optionType}|${config.targetPrice}`;
    }
    private hasFiredToday(config: any): boolean {
        try { return JSON.parse(fs.readFileSync(this.firedFile(), 'utf8')) === this.firedKey(config); } catch { return false; }
    }
    // false = could not persist: the caller must not buy (a restart would buy again)
    private recordFired(config: any): boolean {
        try { fs.writeFileSync(this.firedFile(), JSON.stringify(this.firedKey(config))); return true; }
        catch (e: any) { Log.log(`[TargetReach] ALERT: could not persist the fired marker - NOT buying: ${e?.message ?? e}`); return false; }
    }

    constructor(userId?: string) {
        super(userId);
        this.enabled = this.instanceConfig().enabled;
        this.symbol = 'NIFTY';
        this.strike = 0;
        this.expiry = '';
        this.optionType = 'CE';
        this.ensureArmed();
    }

    // Resolves the contract from the CURRENT config and registers the tick watch, once the strategy is enabled. This used to run only
    // in the constructor and only if the strategy was already enabled then, so arming it later (admin toggle, config save) flipped
    // `enabled` but never subscribed: it looked armed and could never fire. Also re-reads strike/expiry/optionType, which were frozen
    // at construction. Called from the constructor and on every NIFTY tick (cheap when already watching and unchanged).
    private ensureArmed(): void {
        if (!this.enabled || this.fired) return;
        const config = this.instanceConfig();
        if (this.hasFiredToday(config)) { this.fired = true; Log.log('[TargetReach] already bought today for this contract/target - not arming again (reset() re-arms)'); return; }
        const symbol = config.symbol || 'NIFTY';
        const changed = symbol !== this.symbol || config.strike !== this.strike || config.expiry !== this.expiry || config.optionType !== this.optionType;
        if (this.watching && !changed) return;
        if (!(config.strike && config.expiry && config.optionType)) return;
        if (this.watching && this.token) {
            unwatchToken(this.token, this, this.exchange);
            this.watching = false;
        }
        this.symbol = symbol;
        this.strike = config.strike;
        this.expiry = config.expiry;
        this.optionType = config.optionType;
        try {
            this.exchange = exchangeForIndex(this.symbol);
            const contract = AntContractMaster.getInstance().findOption({
                symbol: this.symbol,
                exch: this.exchange,
                strike: String(this.strike),
                optionType: this.optionType,
                expiryEpochMs: new Date(this.expiry).getTime(),
            });
            this.token = contract.token;
            watchToken(this.token, this, this.exchange);
            this.watching = true;
            Log.log(`[TargetReach] Watching ${this.symbol} ${this.strike} ${this.optionType} exp ${this.expiry} token=${this.token}`);
        } catch (e) {
            Log.log('[TargetReach] Failed to resolve contract - disabling:', e);
            this.enabled = false;
        }
    }

    receive(oldStats: any, newStats: any) {}
    async processNiftyQuote(quote: NiftyQuote) { this.ensureArmed(); }
    updateTrade = async (trade: Trade): Promise<void> => {};

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return !this.fired && quote.token === this.token;
    }

    reset(): void {
        super.reset();
        try { fs.rmSync(this.firedFile(), { force: true }); } catch { /* nothing to clear */ }
        this.fired = false;
        this.watching = false; // fired() unregistered the watch; ensureArmed() re-arms it from the current config
    }

    async processOptionQuote(quote: OptionQuote) {
        if (!this.enabled || this.fired || !quote?.ltp) return;

        const config = this.instanceConfig();
        if (quote.ltp >= config.targetPrice) {
            this.fired = true;
            unwatchToken(this.token, this, this.exchange);
            this.watching = false;
            if (!this.recordFired(config)) return; // not persisted -> no buy
            Log.log(`[TargetReach] Target reached: ${quote.ltp} >= ${config.targetPrice} - buying`);
            await this.executeTrade(config);
        }
    }

    private async executeTrade(config: any) {
        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                niftyLtp: 0, // unused when strike/expiry are set (exact-contract path)
                index: this.symbol === 'SENSEX' ? 'SENSEX' : 'NIFTY',
                right: this.optionType === 'CE' ? CALL : PUT,
                quantity: config.quantity,
                targetPoints: config.targetPoints,
                stopLossPoints: config.stopLossPoints,
                strike: this.strike,
                expiry: this.expiry,
            });
            if (config.logEnabled) {
                Log.log(`[TargetReach] Bought ${trade.tsym} qty=${config.quantity} at ${trade.price} (GTT placed by order process)`);
            }
        } catch (e) {
            Log.log('[TargetReach] executeTrade failed:', e);
        }
    }
}
