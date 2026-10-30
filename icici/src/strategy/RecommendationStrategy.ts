import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import { roundToTick } from '../util/tick';
import { isPastTime } from '../util/marketHours';
import { LimitEntryStrategy, Leg, ResolvedEntry } from './LimitEntryStrategy';

// Trades one analyst recommendation given in config.yml: a contract ("22750 CE"), an entry price, a target and a stop loss.
// Places a LIMIT buy at (entryPrice - entryOffset) on every configured broker, sized from maxInvestment (split evenly
// across the brokers), and once it fills attaches the target and stop loss:
//   kite  - one two-leg GTT (OCO) at the broker; if that fails, the in-app exitMonitor.
//   ant   - the in-app exitMonitor (a bracket/cover order must BE the entry order, it cannot be attached to a filled one).
//   other - a resting limit sell at the target plus a tick-driven market stop in this strategy.
// An unfilled entry is cancelled at the end of day (and after entryTimeoutMinutes when set); a held position is closed at eodCloseTime.
// One recommendation per config block (add another block, with its own userId, for another one). Changing the contract/prices of a
// block is a new recommendation and is placed once more; the same recommendation is never placed twice on a day, even across restarts.
// A recommendation arriving while a trade is still open (order or position) is dropped, not held for later. When the trade is finished
// (both buy and sell, or nothing filled and cancelled) the block is set to enabled: false in config.yml.
//
// Config (config.yml):
//   contract: '22750 CE'          - strike and CE/PE
//   entryPrice: 120               - recommended entry; the order goes in at entryPrice - entryOffset
//   targetPrice: 150              - absolute option price
//   stopLoss: 95                  - absolute option price; must be below the order price
//   maxInvestment: 100000   - rupee budget for the whole entry
//   entryOffset: 5                - default 5
//   index: NIFTY                  - default NIFTY
//   brokers: [kite]
//   startTime: '09:20'            - not placed before this; eodCloseTime: '15:10'; entryTimeoutMinutes: optional
export default class RecommendationStrategy extends LimitEntryStrategy {
    protected readonly logTag = `Recommendation:${this.userId}`;
    protected readonly strategyType = 'RecommendationStrategy';
    private invalidLogged = '';


    // Identifies one recommendation (its contract, prices, budget and offset). Persisted per day, so the same one is never placed twice.
    static keyOf(cfg: any): string {
        const offset = cfg.entryOffset == null ? 5 : Number(cfg.entryOffset);
        return `${cfg.contract}|${Number(cfg.entryPrice)}|${Number(cfg.targetPrice)}|${Number(cfg.stopLoss)}|${Number(cfg.maxInvestment)}|${offset}`;
    }

    static parseContract(contract: unknown): { strike: number; right: 'CE' | 'PE' } | null {
        const m = /^\s*(\d{3,6})\s*(CE|PE)\s*$/i.exec(String(contract ?? ''));
        return m ? { strike: Number(m[1]), right: m[2].toUpperCase() as 'CE' | 'PE' } : null;
    }

    protected async onNiftyTick(_quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        if (isPastTime(cfg.eodCloseTime, '15:10') || !isPastTime(cfg.startTime, '09:20')) return;
        const parsed = RecommendationStrategy.parseContract(cfg.contract);
        const entryPrice = Number(cfg.entryPrice);
        const target = Number(cfg.targetPrice);
        const stop = Number(cfg.stopLoss);
        const budget = Number(cfg.maxInvestment);
        const offset = cfg.entryOffset == null ? 5 : Number(cfg.entryOffset);
        const orderPrice = roundToTick(entryPrice - offset);
        const problem = !parsed ? `contract '${cfg.contract}' is not like '22750 CE'`
            : !(entryPrice > 0 && target > 0 && stop > 0 && budget > 0 && Number.isFinite(offset) && offset >= 0) ? 'entryPrice, targetPrice, stopLoss and maxInvestment must be positive numbers'
            : !(stop < orderPrice && orderPrice < target) ? `need stopLoss (${stop}) < order price (${orderPrice} = entryPrice - entryOffset) < targetPrice (${target})`
            : null;
        const key = RecommendationStrategy.keyOf(cfg);
        if (problem || !parsed) {
            if (this.invalidLogged !== key) { this.invalidLogged = key; Log.log(`[${this.logTag}] ALERT: invalid recommendation, not placed: ${problem}`); }
            return;
        }
        if (this.cycleStarted(key)) return;
        if (this.hasActiveLeg()) {
            // A trade is still in progress (open order or position): this recommendation is dropped, not held for later. The key is
            // marked used so it is never picked up after that trade ends either.
            this.markCycle(key);
            Log.log(`[${this.logTag}] ALERT: ${cfg.contract} not started - a trade is still in progress; this recommendation is dropped`);
            return;
        }
        const entry: ResolvedEntry = { index: this.index(), strike: parsed.strike, right: parsed.right };
        await this.startCycle(key, entry, budget, async () => orderPrice);
    }

    // The recommendation is finished (bought and sold, or never filled and cancelled, or refused): its config block is set to
    // enabled: false, so nothing trades it again - not tomorrow, and not a later same-day re-entry. config.yml is the switch: written here
    // and hot-reloaded. Runs only while enabled (a disabled block takes no action).
    protected async onCycleEnded(): Promise<void> {
        if (!this.enabled) return;
        try {
            const cfg = configService.getConfig();
            const block = (cfg.strategies || []).find((s) => s.type === this.strategyType && (s.userId || s.type) === this.userId);
            if (!block || !block.enabled) return;
            // Only the recommendation this block holds: a block re-enabled with a new recommendation after an earlier one traded today
            // has not been started yet, and must not be switched off before it is.
            if (!this.cycleStarted(RecommendationStrategy.keyOf(block))) return;
            block.enabled = false;
            configService.writeConfig(cfg);
            configService.reloadNow();
            Log.log(`[${this.logTag}] recommendation finished - set enabled: false in config.yml`);
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: recommendation finished but could not set enabled: false in config.yml - set it by hand: ${e?.message ?? e}`);
        }
    }

    protected async topUpExit(leg: Leg, delta: number): Promise<void> {
        if (leg.exit === 'exitMonitor' || leg.exit === 'none') return; // sized off the position when it triggers: later fills are covered already
        if (leg.exit === 'gtt') {
            // A GTT is sized when placed: drop it and attach a new one over the whole filled quantity. If the re-attach throws, exit is
            // cleared so the housekeeping retry places a fresh exit.
            await OrderClient.getInstance().cancelProtection(this.userId, { broker: leg.broker as any, tradingSymbol: leg.tsym });
            leg.exit = undefined;
            leg.exitQty = 0;
            await this.placeExit(leg);
            return;
        }
        const target = roundToTick(Number((this.cfg() as any).targetPrice));
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: delta, price: target, exchange: leg.exchange,
        });
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: extra resting sell ${delta} @ ${target} for the later fill`);
    }

    protected async placeExit(leg: Leg): Promise<void> {
        const cfg = this.cfg() as any;
        const target = roundToTick(Number(cfg.targetPrice));
        const stop = roundToTick(Number(cfg.stopLoss));
        const avg = this.avgPrice(leg);
        if (!(stop < avg && avg < target)) {
            // Filled outside the recommended band (e.g. the limit filled and price already ran through the stop or the target).
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: fill avg ${avg.toFixed(2)} is not inside stop ${stop} / target ${target} - closing at market`);
            leg.exit = 'none';
            await this.closeLeg(leg, 'fill outside stop/target band');
            return;
        }
        try {
            const res = await OrderClient.getInstance().attachProtection(this.userId, { broker: leg.broker as any, tradingSymbol: leg.tsym, targetPrice: target, stopLossPrice: stop });
            leg.exit = res.mode;
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym} qty=${leg.filledQty} avg=${avg.toFixed(2)}: target ${target} / stop ${stop} protected via ${res.mode}${res.gttTriggerId ? ' (GTT ' + res.gttTriggerId + ')' : ''}`);
            return;
        } catch (e: any) {
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: no broker-side protection (${e?.message ?? e}) - using a resting target sell + tick-driven stop here`);
        }
        // Self-managed: the stop is armed first (it needs only ticks), then the target sell. If the sell cannot be placed the stop
        // still protects the downside and the error is thrown so the sell is retried.
        leg.stop = stop;
        this.save();
        this.armSelfStop(leg);
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: leg.filledQty, price: target, exchange: leg.exchange,
        });
        leg.exit = 'self';
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: resting sell ${leg.filledQty} @ ${target}, stop ${stop} watched on ticks`);
    }
}
