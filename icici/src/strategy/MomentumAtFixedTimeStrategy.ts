import moment from 'moment';
import { expiryDayOverrideOf } from '../util/expirySkip';
import Log from '../util/Log';
import { NiftyQuote, OptionQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { investmentForBroker, resolveMaxInvestment } from '../prism/configVocabulary';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';
import MomentumSignal from './MomentumSignal';
import { minMovePoints } from './entryStop';
import { exitDistance, exitRulesFrom, legacyExitKeysIn, ExitRules } from './exitRules';

// Revived from the deleted Minutes5Decision prototype (commit 9765032), rebuilt on LimitEntryStrategy. At each configured HH:mm slot:
//   1. Order-book surplus: read tbq - tsq (AntDepth) for the CE at ceil(spot/50)*50 and the PE at floor(spot/50)*50. The contract with
//      the larger surplus must be positive; its side gives the direction (CE = up, PE = down).
//   2. Price check: Nifty now minus Nifty at the previous slot today must match that direction (CE needs a rise, PE a fall) and be at
//      least minMovePoints in size (config; 0 / omitted = any move). Otherwise no trade. The first slot of the day has no previous slot
//      and never trades.
//   3. Entry: one LIMIT buy per broker at the option's prevailing LTP, sized from maxInvestment (per broker) at runtime.
//   4. Exit: target and stop come from the global settings `target` / `stopLoss` (points, "N%" of the fill, or 'none'), overridable in this
//      block with the same keys (see exitRules.ts). With a target: a resting LIMIT sell at the target is placed as soon as the entry fills,
//      and the stop goes in with it when one is set (protectLeg). Without a target but with a stop: the stop is watched on ticks. With
//      neither: the position leaves only at the EOD close (settings.eodCloseTime).
//
// Only one position at a time (a slot is skipped while the previous slot's position is still open; that slot is consumed).
// Slot rules: each slot fires at most once a day (persisted); a slot earlier than this process's start is never fired (no catch-up);
// a slot more than 5 minutes old is missed. Every slot seen updates the previous-slot price, whether or not it trades.
//
// Logging only: the Nifty up/down counts since the previous slot are logged at every slot. They are SAMPLED, not counted per tick: every
// upDownSampleMinutes (default 1) the current Nifty LTP is compared with the previous sample (up / down / flat), so a slot ten minutes
// after the last holds about ten samples. (Counting every delivered tick gave ~5,400 per slot, up + down = the tick count, and a
// near-constant 51-54% downs share that said nothing about direction.) They are kept in memory and are not used for any decision.
//
// Config (config.yml):
//   times: ['10:40', '11:40', '12:30', '13:40', '14:30']
//   maxInvestment: 100000   - per broker; the lot count is computed at runtime (no quantity key)
//   minMovePoints: 10       - skip a slot whose |Nifty move since the previous slot| is below this (0 / omitted: any move)
//   target: 5               - take-profit: points above the fill, or "5%" (overrides settings.target; 'none' = no target)
//   stopLoss: none          - stop: points below the fill, or "25%" (overrides settings.stopLoss; 'none' = no stop)
//   upDownSampleMinutes: 1  - interval of the logged up/down sampling
//   entryTimeoutMinutes: 5  - cancel an unfilled entry after this long
//   index: NIFTY
//   brokers: [kite]
const LATE_WINDOW_MINUTES = 5;
const STRIKE_STEP = 50;
const DEPTH_TIMEOUT_MS = 3000;

export default class MomentumAtFixedTimeStrategy extends LimitEntryStrategy {
    // When this process came up (a static so a test can move it): slots before it are never fired.
    static processStartedAt = moment();
    protected readonly logTag = `MomentumAtFixedTime:${this.userId}`;
    protected readonly strategyType = 'MomentumAtFixedTimeStrategy';
    private tradingDay: string | null = null;
    private seenToday = new Set<string>();
    private momentum = new MomentumSignal();
    private lastLtp: number | null = null;
    private ups = 0;
    private downs = 0;
    private flats = 0;
    private lastSampleAt = 0; // ms of the last up/down sample

    constructor(userId?: string) {
        super(userId);
        const legacy = legacyExitKeysIn(this.instanceConfig() as any, ['targetPoints', 'stopLossPoints', 'stopLossPercent', 'maxLossPerLeg']);
        if (legacy.length > 0) Log.log(`[${this.logTag}] ALERT: ${legacy.join(', ')} ignored - exits come from target / stopLoss (this block or settings)`);
    }

    protected index(): 'NIFTY' {
        return 'NIFTY';
    }

    // True while any leg is placing, resting an entry, or still holding unsold quantity: the next slot must not start.
    isRunning(): boolean {
        return this.hasActiveLeg();
    }

    reset(): void {
        super.reset();
        this.seenToday.clear();
        this.setSlotPrice(null);
        this.lastLtp = null;
        this.ups = 0;
        this.downs = 0;
        this.flats = 0;
        this.lastSampleAt = 0;
    }

    private slotMoment(timeStr: string): moment.Moment | null {
        const [h, m] = String(timeStr).split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return moment().hour(h).minute(m).second(0);
    }

    private sampleIntervalMs(): number {
        const m = Number((this.cfg() as any).upDownSampleMinutes);
        return (Number.isFinite(m) && m > 0 ? m : 1) * 60_000;
    }

    // Samples Nifty once per upDownSampleMinutes: up when the LTP is above the previous sample, down when below, flat when equal. A tick that
    // arrives before the interval has passed is ignored. Logging only.
    private countTick(ltp: number, nowMs: number = Date.now()): void {
        if (this.lastLtp === null) { this.lastLtp = ltp; this.lastSampleAt = nowMs; return; }
        if (nowMs - this.lastSampleAt < this.sampleIntervalMs()) return;
        if (ltp > this.lastLtp) this.ups++;
        else if (ltp < this.lastLtp) this.downs++;
        else this.flats++;
        this.lastLtp = ltp;
        this.lastSampleAt = nowMs;
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        const today = localDayKey();
        if (this.tradingDay !== today) {
            // The first tick after a (re)start keeps the persisted slot price (the state file is per-day). Only a real rollover in a running
            // process clears it.
            const rolledOver = this.tradingDay !== null;
            this.tradingDay = today;
            this.seenToday.clear();
            this.lastLtp = null;
            this.ups = 0;
            this.downs = 0;
            this.flats = 0;
            this.lastSampleAt = 0;
            if (rolledOver) this.setSlotPrice(null);
        }
        const ltp = Number(quote.ltp);
        const now = moment();
        const times: string[] = Array.isArray(cfg.times) ? cfg.times : [];
        for (const timeStr of times) {
            if (this.seenToday.has(timeStr)) continue;
            const slotTime = this.slotMoment(timeStr);
            if (!slotTime) continue;
            if (now.isBefore(slotTime)) continue;
            this.seenToday.add(timeStr); // each slot is evaluated once, whether it trades, skips or is too late
            const key = `${today} ${timeStr}`;
            const counts = `ups ${this.ups} / downs ${this.downs} / flat ${this.flats} (sampled every ${this.sampleIntervalMs() / 60_000} min) since the previous slot`;
            this.ups = 0;
            this.downs = 0;
            this.flats = 0;
            if (this.cycleStarted(key)) { Log.log(`[${this.logTag}] ${timeStr} slot already handled earlier today - skipping (a restart does not redo it)`); continue; }
            this.markCycle(key);
            if (slotTime.isBefore(MomentumAtFixedTimeStrategy.processStartedAt)) {
                Log.log(`[${this.logTag}] ${timeStr} slot skipped - process started at ${MomentumAtFixedTimeStrategy.processStartedAt.format('HH:mm:ss')}, after it`);
                this.setSlotPrice(ltp > 0 ? ltp : null);
                continue;
            }
            if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[${this.logTag}] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`);
                this.setSlotPrice(null);
                continue;
            }
            // Reference: the price at the previous slot today. The first slot of the day has none and does not trade.
            const earlierSlotToday = times.some((t) => this.slotMoment(t)?.isBefore(slotTime) === true);
            const reference = earlierSlotToday ? this.getSlotPrice() : null;
            this.setSlotPrice(ltp > 0 ? ltp : null); // this slot's price is the reference for the next slot
            Log.log(`[${this.logTag}] ${timeStr} slot: Nifty ${ltp}, previous slot ${reference ?? 'none'}, ${counts}`);
            if (!earlierSlotToday) { Log.log(`[${this.logTag}] ${timeStr}: first slot of the day - no previous slot to compare, not trading`); continue; }
            if (reference == null) { Log.log(`[${this.logTag}] ALERT: ${timeStr}: no price recorded for the previous slot today (process started after it, it was missed, or no tick) - not trading`); continue; }
            if (this.isRunning()) { Log.log(`[${this.logTag}] ${timeStr} slot: previous slot's position already running - skipping`); continue; }
            await this.fireSlot(timeStr, key, ltp, reference);
        }
        this.countTick(ltp);
    }

    private async fireSlot(timeStr: string, key: string, ltp: number, reference: number): Promise<void> {
        const cfg = this.cfg() as any;
        if (!(ltp > 0) || !(reference > 0)) { Log.log(`[${this.logTag}] ${timeStr}: Nifty ltp/reference unusable (${ltp}/${reference}) - skipping`); return; }
        if (!(resolveMaxInvestment(cfg) > 0)) {
            Log.log(`[${this.logTag}] ALERT: ${timeStr}: maxInvestment (${cfg.maxInvestment}) invalid - not trading`);
            return;
        }
        try {
            this.exitRules(); // a missing or invalid target/stopLoss stops the slot here, before any order
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${timeStr}: ${e?.message ?? e} - not trading`);
            return;
        }

        const minMove = minMovePoints(cfg);
        if (Math.abs(ltp - reference) < minMove) {
            Log.log(`[${this.logTag}] ${timeStr}: Nifty move ${ltp - reference > 0 ? '+' : ''}${(ltp - reference).toFixed(2)} since previous slot is below minMovePoints ${minMove} - not trading`);
            return;
        }

        // 1. Order-book surplus on the two candidate contracts (ANT tokens, depth feed).
        const ceStrike = Math.ceil(ltp / STRIKE_STEP) * STRIKE_STEP;
        const peStrike = Math.floor(ltp / STRIKE_STEP) * STRIKE_STEP;
        const lookup = (strike: number, right: 'CE' | 'PE') => OrderClient.getInstance().resolveOptionContract(this.userId, { broker: 'ant', index: 'NIFTY', strike, right, skipNearestExpiryDay: expiryDayOverrideOf(this.cfg()) });
        const [ce, pe] = await Promise.all([lookup(ceStrike, 'CE'), lookup(peStrike, 'PE')]).catch((e: any) => {
            Log.log(`[${this.logTag}] ${timeStr}: contract lookup failed (${e?.message ?? e}) - not trading`);
            return null;
        }) ?? [];
        if (!ce || !pe) return;
        const depth = await this.momentum.readDepth(this, [ce.token, pe.token], 'NFO', DEPTH_TIMEOUT_MS);
        if (!depth) { Log.log(`[${this.logTag}] ${timeStr}: no order-book depth for CE ${ceStrike} / PE ${peStrike} - not trading`); return; }
        const ceD = depth.get(ce.token)!;
        const peD = depth.get(pe.token)!;
        const ceSurplus = ceD.tbq - ceD.tsq;
        const peSurplus = peD.tbq - peD.tsq;
        const chosen = ceSurplus === peSurplus ? null : ceSurplus > peSurplus ? { right: 'CE' as const, strike: ceStrike, surplus: ceSurplus } : { right: 'PE' as const, strike: peStrike, surplus: peSurplus };
        const surplusText = `CE ${ceStrike} surplus ${ceSurplus} | PE ${peStrike} surplus ${peSurplus}`;
        if (!chosen || !(chosen.surplus > 0)) {
            Log.log(`[${this.logTag}] ${timeStr}: no positive surplus winner (${surplusText}) - not trading`);
            return;
        }
        const direction = chosen.right === 'CE' ? 'up' : 'down';

        // 2. The price move since the previous slot must match the direction.
        const move = ltp - reference;
        const priceMatches = chosen.right === 'CE' ? move > 0 : move < 0;
        Log.log(`[${this.logTag}] ${timeStr}: ${surplusText} -> ${chosen.right} (${direction}); Nifty move ${move > 0 ? '+' : ''}${move.toFixed(2)} since previous slot -> ${priceMatches ? 'matches' : 'does NOT match'}`);
        if (!priceMatches) { Log.log(`[${this.logTag}] ${timeStr}: price move does not match ${direction} - no trade`); return; }

        // 3. Entry: one limit buy per broker at the prevailing option price, sized from maxInvestment.
        await this.startCycle(key, { index: 'NIFTY', strike: chosen.strike, right: chosen.right }, (b) => investmentForBroker(cfg, b), async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp);
        });
    }

    // Option ticks: depth ticks for the order-book read go to MomentumSignal; leg ticks go to the target logic in LimitEntryStrategy.
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.momentum.isTracking(String(quote.token)) || super.canHandleOptionQuote(quote);
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (this.momentum.isTracking(String(quote.token))) {
            this.momentum.onTick(quote);
            return;
        }
        await super.processOptionQuote(quote);
    }

    // target / stopLoss from this block, else the global settings. Throws when either is absent or invalid.
    private exitRules(): ExitRules {
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

    // The exit a freshly filled leg gets: target and stop together (protectLeg, Kite GTT / ANT exitMonitor / Breeze and Prism resting sell +
    // tick stop), a resting target sell alone, a tick-watched stop alone, or nothing (the EOD close is the only exit).
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

    // A later partial fill is covered the way the exit was placed: a resting-sell exit sells the extra quantity at the same target, a GTT is
    // re-attached over the whole quantity, an in-app exit monitor is sized when it triggers, a stop-only leg is covered by its tick stop.
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
}
