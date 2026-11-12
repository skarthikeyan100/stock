import Log from '../util/Log';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { INDEX_LOT_SIZE } from '../constants';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';
import { exitDistance, exitRulesFrom, legacyExitKeysIn, ExitRules } from './exitRules';

// Base of the 15-minute-candle strategies (NextWeekStrategy, BreakoutStrategy): one LIMIT buy per broker at the option's prevailing LTP, a
// FIXED quantity (config `quantity`, per broker) and the target / stopLoss exit that MomentumAtFixedTimeStrategy uses (same keys, same
// semantics: the block's value, else settings.target / settings.stopLoss; points, "N%" of the fill, or 'none'; see exitRules.ts).
//
// Config shared by both:
//   quantity: 65            - units per broker, must be a whole number of lots (NIFTY lot = INDEX_LOT_SIZE); above the freeze quantity it is split
//   target / stopLoss       - exit rules (block or settings)
//   entryTimeoutMinutes     - not set on the block: settings.entryTimeoutMinutes (global) cancels an unfilled entry after that long; a block key overrides it
//   index: NIFTY, brokers: [kite]
export abstract class CandleEntryStrategy extends LimitEntryStrategy {
    // Called from each subclass's constructor (logTag is only readable there): the old per-leg exit keys are ignored.
    protected warnLegacyExitKeys(): void {
        const legacy = legacyExitKeysIn(this.instanceConfig() as any, ['targetPoints', 'stopLossPoints', 'stopLossPercent', 'maxLossPerLeg']);
        if (legacy.length > 0) Log.log(`[${this.logTag}] ALERT: ${legacy.join(', ')} ignored - exits come from target / stopLoss (this block or settings)`);
    }

    protected index(): 'NIFTY' {
        return 'NIFTY';
    }

    // True while any leg is placing, resting an entry, or still holding unsold quantity: no new entry may start.
    isRunning(): boolean {
        return this.hasActiveLeg();
    }

    // The configured quantity, or null when it is missing / not a positive whole number of lots (the caller then does not trade).
    protected configuredQuantity(): number | null {
        const q = Number((this.cfg() as any).quantity);
        const lot = INDEX_LOT_SIZE.NIFTY;
        if (!Number.isFinite(q) || q <= 0 || !Number.isInteger(q) || q % lot !== 0) return null;
        return q;
    }

    // LimitEntryStrategy sizes from a rupee budget; these strategies use the fixed quantity instead (the budget argument is ignored).
    protected sizeOrder(_budget: number, price: number, _index: 'NIFTY' | 'SENSEX'): number {
        const q = this.configuredQuantity();
        if (q === null) {
            Log.log(`[${this.logTag}] ALERT: quantity (${(this.cfg() as any).quantity}) must be a positive multiple of the lot size ${INDEX_LOT_SIZE.NIFTY} - not trading`);
            return 0;
        }
        return price > 0 ? q : 0;
    }

    // target / stopLoss from this block, else the global settings. Throws when either is absent or invalid.
    protected exitRules(): ExitRules {
        return exitRulesFrom(this.setting('target'), this.setting('stopLoss'), this.logTag);
    }

    // Absolute target and stop prices for a leg whose average fill is `avg`. Throws when the stop would not be above zero.
    private exitFor(avg: number): { targetDist: number | null; target: number | null; stop: number | undefined } {
        const rules = this.exitRules();
        const targetDist = rules.target ? exitDistance(rules.target, avg) : null;
        const stopDist = rules.stop ? exitDistance(rules.stop, avg) : null;
        if (stopDist !== null && avg - stopDist <= 0) throw new Error(`stopLoss of ${stopDist} points is not below zero for a fill of ${avg}`);
        return {
            targetDist,
            target: targetDist === null ? null : roundToTick(avg + targetDist),
            stop: stopDist === null ? undefined : Math.max(roundToTick(avg - stopDist), 0.05),
        };
    }

    // The exit a freshly filled leg gets: target and stop together (protectLeg), a resting target sell alone, a tick-watched stop alone, or
    // nothing (the EOD close is the only exit). Same as MomentumAtFixedTimeStrategy.placeExit.
    protected async placeExit(leg: Leg): Promise<void> {
        const avg = this.avgPrice(leg);
        const ex = this.exitFor(avg);
        if (ex.target !== null && ex.stop !== undefined) {
            await this.protectLeg(leg, ex.target, ex.stop);
            return;
        }
        if (ex.target !== null) {
            await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
                broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: leg.filledQty, price: ex.target, exchange: leg.exchange,
            });
            leg.exit = 'resting';
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: bought ${leg.filledQty} @ avg ${avg.toFixed(2)} - resting sell @ ${ex.target} (no stop)`);
            return;
        }
        if (ex.stop !== undefined) {
            leg.stop = ex.stop;
            this.save();
            this.armSelfStop(leg);
            leg.exit = 'self';
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: bought ${leg.filledQty} @ avg ${avg.toFixed(2)} - no target, stop ${ex.stop} watched on ticks`);
            return;
        }
        leg.exit = 'none';
        this.save();
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: bought ${leg.filledQty} @ avg ${avg.toFixed(2)} - no target and no stop: left to the EOD close`);
    }

    // A later partial fill is covered the way the exit was placed (see MomentumAtFixedTimeStrategy.topUpExit).
    protected async topUpExit(leg: Leg, delta: number): Promise<void> {
        if (leg.exit === 'exitMonitor' || leg.exit === 'none') return;
        const ex = this.exitFor(this.avgPrice(leg));
        if (leg.exit === 'target') { if (ex.targetDist !== null) await this.topUpTargetSell(leg, ex.targetDist); return; }
        if (leg.exit === 'gtt') {
            await OrderClient.getInstance().cancelProtection(this.userId, { broker: leg.broker as any, tradingSymbol: leg.tsym });
            leg.exit = undefined;
            leg.exitQty = 0;
            await this.placeExit(leg);
            return;
        }
        if (ex.target === null) return; // stop-only: the tick stop applies to the whole leg (leg.stop), nothing rests at the broker
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: delta, price: ex.target, exchange: leg.exchange,
        });
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: extra resting sell ${delta} @ ${ex.target} for the later fill`);
    }

    // Rounds a NIFTY level to its ATM strike.
    protected atmStrike(ltp: number): number {
        return Math.round(ltp / 50) * 50;
    }

    // Seconds-of-day (local, IST) of an epoch-seconds tick time.
    protected secondsOfDay(epochSeconds: number): number {
        const d = new Date(epochSeconds * 1000);
        return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    }
}
