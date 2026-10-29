import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../kite/Kite';
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

    getMonitorConfig(): null {
        return null; // exits are managed here (and by the order process), not by the generic entry monitor
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
        const key = `${cfg.contract}|${entryPrice}|${target}|${stop}|${budget}|${offset}`;
        if (problem || !parsed) {
            if (this.invalidLogged !== key) { this.invalidLogged = key; Log.log(`[${this.logTag}] ALERT: invalid recommendation, not placed: ${problem}`); }
            return;
        }
        if (this.cycleStarted(key) || this.hasActiveLeg()) return;
        const entry: ResolvedEntry = { index: this.index(), strike: parsed.strike, right: parsed.right };
        await this.startCycle(key, entry, budget, async () => orderPrice);
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
