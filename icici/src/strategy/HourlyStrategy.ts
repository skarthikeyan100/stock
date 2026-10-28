import { isPastTime } from '../util/marketHours';
import { localDayKey } from './dayKey';
import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';
import SerialWriter from './SerialWriter';
import { roundToTick } from '../kite/Kite';
import { sleep } from '../util/sleep';
import { normalizeBrokerName, normalizeBrokerList, normalizePersistedBrokers } from '../util/brokerName';

// Hourly NIFTY support/resistance breakout, confirmed on a 10-minute candle,
// traded independently and in FULL configured quantity on every configured
// broker (config `brokers: [kite, ant, breeze]`, falling back to a single
// legacy `broker:` field) - same multi-broker fan-out shape BulkPcrStrategy
// uses (chunkedBuyIndex/chunkedSquareOffLimit/chunkedSquareOff, Promise.allSettled
// so one broker's failure never touches another's), but single-direction,
// one-shot-per-breakout rather than BulkPcr's PCR-driven opposite-side pair.
//
// Spec (from the shared Gemini conversation this was built from):
//  - Resistance = previous hour's high, support = previous hour's low
//    (clock-hour buckets, snapshotted at the top of every hour from the
//    hour that just finished).
//  - Confirmation: a fully CLOSED 10-minute candle whose entire body (not
//    just a wick) closes above resistance (breakout -> CALL) or below
//    support (breakdown -> PUT). Filters fakeouts.
//  - Entry: on the OPEN of the very next 10-minute candle after the
//    confirming close - never mid-candle, never on the confirming candle
//    itself, and never on a later candle (a stale confirmation is dropped).
//  - Risk management: the stop/invalidation level is the confirming
//    candle's own low (CALL) / high (PUT) - if NIFTY falls back through it,
//    the breakout is invalidated and every broker's position is closed
//    immediately, cancelling the resting target-sell first. (There is no
//    choppy-hour filter: the old isSentimentAligned() gate was a no-op, as ANT
//    ticks carry no buyQty/sellQty, and has been removed.)
//
// Exit has two independent layers per broker, same split RateOfChangeStrategy
// uses for its own simpler single-broker case:
//  - A resting LIMIT sell at (entryAvg + targetPoints), placed right after
//    entry fills, via chunkedSquareOffLimit - broker-side, fire-and-forget
//    until it fills.
//  - The NIFTY-level invalidation check above (processNiftyQuote), which
//    cancels the resting sell (cancelRestingLimitSells) and market-squares
//    off whatever remains (chunkedSquareOff) the instant the breakout fails.
// getMonitorConfig() returns null - self-monitored, no GTT/bracket (Breeze
// doesn't support them anyway, same reason BulkPcrStrategy is self-monitored).
//
// Recurring, not single-shot: once every configured broker's position for a
// trade cycle reaches 'done', state is cleared so the next qualifying
// breakout (later the same hour, once cooldown/isCooldownElapsed allows it,
// or next hour) can trade again - unlike BulkPcrStrategy, which durably
// disables itself after one cycle.
//
// Restart safety: deliberately conservative, not a full LegManager-style
// rebuild. Candle-building/hourly-level state is process-local and NOT
// persisted (same precedent as niftyQuoteHistory.ts/niftyCandleBuilder.ts) -
// a restart mid-hour costs at most that hour's remaining entries, never a
// stuck position. Broker POSITION state (what's actually held/resting at
// the broker) IS persisted to Mongo; reconcile() restores it but never
// guesses whether a resting sell survived the restart - a position still
// open at the broker is flagged 'error' for manual review rather than
// risking a second exit sell stacked on top of one that might already be
// resting.
type BrokerName = 'kite' | 'breeze' | 'ant' | 'prism';

const STATE_COLLECTION = 'hourlyStrategyState';

// Same reject-streak/backoff shape as BulkPcrStrategy's onOrderCancelled -
// see that file's comments for the live incidents these constants guard
// against (2026-10-15: unbounded retry of an identical rejected order;
// a bare "insufficient"/"margin" match too broad for ordinary phrasing).
const MAX_EXIT_REJECT_RETRIES = 5;
const EXIT_REJECT_RETRY_DELAY_MS = 5000;
const EXIT_REJECT_STREAK_RESET_MS = 120_000;
const MARGIN_SHORTFALL_REASON_PATTERN = /margin.{0,30}(shortfall|insufficient|exceed|short)|(?:shortfall|insufficient|exceed|short|enough).{0,30}margin/i;

const TEN_MIN_MS = 10 * 60 * 1000;

interface Candle {
    bucket: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

// A confirmed-but-not-yet-entered breakout/breakdown, waiting for the next
// 10-minute candle's open. slLevel is the confirming candle's own low (CALL)
// / high (PUT) - the invalidation level once a position is open.
interface PendingConfirmation {
    direction: string; // CALL | PUT
    slLevel: number;
    confirmedAtBucket: number; // the confirming candle's own bucket - entry must fire on confirmedAtBucket + TEN_MIN_MS, nothing later
}

interface BrokerPosition {
    broker: BrokerName;
    phase: 'buying' | 'selling' | 'error' | 'done';
    // In-memory only (see persistState) - set while a deliberate invalidation
    // close or EOD-style cancel is in flight, so a resulting cancellation
    // notification (onOrderCancelled) isn't mistaken for an unexpected one
    // and re-placed on top of the close that's already happening.
    squaringOff?: boolean;
    // In-memory only. True while the resting exit sell is still being placed (chunked placement takes seconds). A close that fires in
    // that window would find no (or only some) resting chunks to cancel, market-sell the whole remainder, and the chunks placed after
    // would sell it a second time - so it is deferred (closeRequested) until placement finishes.
    placingExit?: boolean;
    closeRequested?: 'invalidation' | 'eod';
    lastCloseAttemptAt?: number; // throttle: a persistently failing close must not retry on every tick
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
    exitRejectCount?: number;
    exitLastRejectAt?: number;
}

interface PersistedState {
    userId: string;
    positions: Partial<Record<BrokerName, BrokerPosition>>;
    // Brokers latched by latchLiveRemainder on `liveRemainderDay`.
    liveRemainderBrokers?: BrokerName[];
    liveRemainderDay?: string;
}

export default class HourlyStrategy extends Strategy {
    private positions: Map<BrokerName, BrokerPosition> = new Map();
    // Brokers where an entry stopped early and the cancel of its unfilled remainder FAILED: that remainder may still fill with no
    // exit on it. A latched broker takes no new entry today (durable for the day, cleared by reset()) until a human has checked it.
    private liveRemainder = new Set<BrokerName>();
    private liveRemainderDay = localDayKey();

    private latchLiveRemainder(broker: BrokerName, what: string, bookedQty: number): void {
        this.liveRemainder.add(broker);
        this.liveRemainderDay = localDayKey();
        this.persistState();
        Log.log(`[Hourly] [${broker}] ALERT: the cancel of the unfilled remainder of the ${what} FAILED - it may still be resting live and fill later; the exit covers only the ${bookedQty} booked qty and this broker takes no new entry today until reviewed (reset)`);
    }
    private writer = new SerialWriter('Hourly');

    // Hourly level tracking.
    private currentHourBucket: number | null = null;
    private hourHigh = 0;
    private hourLow = 0;
    private hourComplete = false;
    private resistance: number | null = null;
    private support: number | null = null;

    // 10-minute candle tracking.
    private currentTenMinBucket: number | null = null;
    private currentCandle: Candle | null = null;
    private pendingConfirmation: PendingConfirmation | null = null;
    private triggeredThisHour = false;

    constructor(userId?: string) {
        super(userId);
        this.enabled = this.instanceConfig().enabled;
    }

    private cfg() {
        return this.instanceConfig() as any;
    }

    receive(oldStats: any, newStats: any) {}

    getMonitorConfig() {
        return null; // self-monitored, no GTT/bracket - see file header
    }

    // `brokers: [kite, ant, breeze]` takes priority when present and
    // non-empty; falls back to the legacy single `broker:` field, same
    // convention as BulkPcrStrategy.configuredBrokers().
    private configuredBrokers(): BrokerName[] {
        const cfg = this.cfg();
        const list: string[] = normalizeBrokerList(Array.isArray(cfg.brokers) && cfg.brokers.length > 0 ? cfg.brokers : [cfg.broker ?? 'kite']);
        return list as BrokerName[];
    }

    isTimeInRange(): boolean {
        // First hourly level isn't available until 10:15 (one hour after the
        // 09:15 open) - same override pattern ContinuousStrategy/GapStrategy use.
        const now = new Date();
        const minutes = now.getHours() * 60 + now.getMinutes();
        return minutes >= 10 * 60 + 15 && minutes < 15 * 60;
    }

    // True while any broker position is still buying/selling/needs review -
    // gates a new entry so there is never more than one open trade cycle at
    // a time, across hour boundaries, regardless of the once-per-hour cap.
    private hasOpenPosition(): boolean {
        for (const pos of this.positions.values()) {
            if (pos.phase === 'buying' || pos.phase === 'selling' || pos.phase === 'error') return true;
        }
        return false;
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled || !quote?.ltp) return;
        const ms = this.toMillis(quote.ltt) ?? Date.now();
        const ltp = quote.ltp;

        // Hourly levels and position protection run on EVERY tick, not only inside the 10:15-15:00 entry window:
        // the previous hour's high/low must include the ticks before 10:15, and an open position's invalidation
        // stop and end-of-day flatten must still be evaluated after 15:00.
        this.rollHourIfNeeded(ms, ltp);
        this.checkInvalidation(ltp);
        this.checkEod();
        if (!this.isTimeInRange()) return;
        await this.updateTenMinCandle(ms, ltp, quote);
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        // No tick-driven exit - the target sell is a resting broker-side
        // limit order and the invalidation exit is NIFTY-tick-driven
        // (processNiftyQuote). canHandleOptionQuote() defaults to false, so
        // this is never actually called; kept only to satisfy the abstract
        // base method.
    }

    // Local wall-clock hour bucket (year/month/day/hour folded into one
    // integer), NOT Math.floor(ms / HOUR_MS) - IST is UTC+5:30, not a whole
    // number of hours, so a raw epoch-ms hour-floor rolls over on UTC hour
    // boundaries (XX:30 IST) instead of real IST clock hours (XX:00 IST),
    // silently misaligning "the previous hour's high/low" from the actual
    // market hour. (10-minute candle buckets don't have this problem - 5:30
    // is an exact multiple of 10 minutes, so epoch-ms flooring already lands
    // on the same boundaries as IST wall-clock 10-minute marks.) Assumes the
    // server's local clock is IST, same assumption strategy.ts's own
    // isTimeInRange() (moment().hour(10)) and this class's own
    // isTimeInRange() override already make.
    private static hourBucketOf(ms: number): number {
        const d = new Date(ms);
        return ((d.getFullYear() * 100 + (d.getMonth() + 1)) * 100 + d.getDate()) * 100 + d.getHours();
    }

    // True when the hour's first observed tick is within ~2 minutes of the hour's start (or of the 09:15 open for the
    // first session hour). An hour first seen later (restart, strategy enabled mid-hour) has a high/low built from a
    // partial hour and must not be used as support/resistance.
    private static isCompleteHourStart(firstMs: number): boolean {
        const start = new Date(firstMs);
        start.setMinutes(0, 0, 0);
        const open = new Date(firstMs);
        open.setHours(9, 15, 0, 0);
        const reference = Math.max(start.getTime(), open.getTime());
        return firstMs >= reference && firstMs - reference <= 120_000;
    }

    private rollHourIfNeeded(ms: number, ltp: number): void {
        // Pre-open / auction ticks (before 09:15) are indicative prices, not traded ones: keep them out of the hour range.
        const d = new Date(ms);
        if (d.getHours() * 60 + d.getMinutes() < 9 * 60 + 15) return;
        const bucket = HourlyStrategy.hourBucketOf(ms);
        if (this.currentHourBucket === null) {
            this.currentHourBucket = bucket;
            this.hourHigh = ltp;
            this.hourLow = ltp;
            this.hourComplete = HourlyStrategy.isCompleteHourStart(ms);
            return;
        }
        if (bucket === this.currentHourBucket) {
            this.hourHigh = Math.max(this.hourHigh, ltp);
            this.hourLow = Math.min(this.hourLow, ltp);
            return;
        }
        // Hour rolled over - the just-finished hour's high/low become the
        // new hour's resistance/support.
        this.resistance = this.hourComplete ? this.hourHigh : null;
        this.support = this.hourComplete ? this.hourLow : null;
        this.currentHourBucket = bucket;
        this.hourHigh = ltp;
        this.hourLow = ltp;
        this.hourComplete = HourlyStrategy.isCompleteHourStart(ms);
        this.triggeredThisHour = false;
        this.pendingConfirmation = null;
        if (this.cfg().logEnabled) {
            Log.log(`[Hourly] New hour - resistance=${this.resistance} support=${this.support}`);
        }
    }

    // Invalidation: if a position is open and NIFTY falls back through the
    // confirming candle's low (CALL) / rises back through its high (PUT),
    // the breakout failed - close every open broker position immediately.
    private checkInvalidation(ltp: number): void {
        if (!this.hasOpenPosition()) return;
        const level = this.activeInvalidationLevel;
        const direction = this.activeDirection;
        if (level == null || direction == null) return;
        const invalidated = direction === CALL ? ltp <= level : ltp >= level;
        if (!invalidated) return;
        Log.log(`[Hourly] Invalidation: NIFTY=${ltp} crossed back through ${level} (${direction}) - closing all broker positions`);
        for (const pos of this.positions.values()) {
            if (pos.phase !== 'selling' || pos.squaringOff) continue;
            if (pos.placingExit) { pos.closeRequested = 'invalidation'; continue; }
            if (!this.closeAttemptAllowed(pos)) continue;
            this.invalidateClose(pos).catch((e) => Log.log(`[Hourly] [${pos.broker}] invalidation close failed:`, e));
        }
    }

    // At most one close attempt per position every 5s (these checks run on every NIFTY tick).
    private closeAttemptAllowed(pos: BrokerPosition): boolean {
        const now = Date.now();
        if (pos.lastCloseAttemptAt !== undefined && now - pos.lastCloseAttemptAt < 5000) return false;
        pos.lastCloseAttemptAt = now;
        return true;
    }

    // End of day: flatten any live position at cfg.eodCloseTime (default 15:10) instead of carrying it past the close.
    private checkEod(): void {
        if (!this.hasOpenPosition()) return;
        if (!isPastTime(this.cfg().eodCloseTime)) return;
        for (const pos of this.positions.values()) {
            if (pos.phase !== 'selling' || pos.squaringOff) continue;
            if (pos.placingExit) { pos.closeRequested = 'eod'; continue; }
            if (!this.closeAttemptAllowed(pos)) continue;
            Log.log(`[Hourly] [${pos.broker}] EOD flatten of ${pos.heldTsym}`);
            this.invalidateClose(pos).catch((e) => Log.log(`[Hourly] [${pos.broker}] EOD close failed:`, e));
        }
    }

    // Set only while a trade cycle is live (an entry has fired and no
    // broker position has finished closing yet) - the invalidation level
    // and direction for THIS cycle.
    private activeInvalidationLevel: number | null = null;
    private activeDirection: string | null = null;

    private async updateTenMinCandle(ms: number, ltp: number, quote: NiftyQuote): Promise<void> {
        const bucket = Math.floor(ms / TEN_MIN_MS) * TEN_MIN_MS;
        if (this.currentTenMinBucket === null) {
            this.currentTenMinBucket = bucket;
            this.currentCandle = { bucket, open: ltp, high: ltp, low: ltp, close: ltp };
            return;
        }
        if (bucket === this.currentTenMinBucket) {
            const c = this.currentCandle!;
            c.high = Math.max(c.high, ltp);
            c.low = Math.min(c.low, ltp);
            c.close = ltp;
            return;
        }

        // A new 10-minute candle started - the previous one just closed.
        const closed = this.currentCandle!;

        // Entry check FIRST, using the confirmation from the candle that
        // just finished (i.e. exactly one bucket after the confirming
        // close) - before this new candle's confirmation check can overwrite
        // pendingConfirmation.
        if (this.pendingConfirmation && this.pendingConfirmation.confirmedAtBucket + TEN_MIN_MS === bucket) {
            await this.tryEnter(this.pendingConfirmation, quote);
        }
        this.pendingConfirmation = null; // either consumed above, or stale (more than one bucket late) - drop it either way

        // Confirmation check on the candle that just closed, for the NEXT candle's open.
        if (!this.triggeredThisHour && !this.hasOpenPosition() && this.resistance != null && this.support != null) {
            const bodyLow = Math.min(closed.open, closed.close);
            const bodyHigh = Math.max(closed.open, closed.close);
            if (bodyLow > this.resistance) {
                this.pendingConfirmation = { direction: CALL, slLevel: closed.low, confirmedAtBucket: closed.bucket };
                if (this.cfg().logEnabled) Log.log(`[Hourly] Breakout confirmed above resistance=${this.resistance} (candle ${bodyLow}-${bodyHigh}) - entering CALL on next candle's open`);
            } else if (bodyHigh < this.support) {
                this.pendingConfirmation = { direction: PUT, slLevel: closed.high, confirmedAtBucket: closed.bucket };
                if (this.cfg().logEnabled) Log.log(`[Hourly] Breakdown confirmed below support=${this.support} (candle ${bodyLow}-${bodyHigh}) - entering PUT on next candle's open`);
            }
        }

        this.currentTenMinBucket = bucket;
        this.currentCandle = { bucket, open: ltp, high: ltp, low: ltp, close: ltp };
    }

    private async tryEnter(confirmation: PendingConfirmation, quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg();
        if (this.triggeredThisHour || this.hasOpenPosition()) return;
        if (!this.isCooldownElapsed(cfg.cooldownSeconds ?? 60)) {
            Log.log('[Hourly] Entry skipped - cooldown not elapsed, dropping stale confirmation');
            return;
        }

        this.triggeredThisHour = true;
        this.activeDirection = confirmation.direction;
        this.activeInvalidationLevel = confirmation.slLevel;
        this.recordTriggerTime();

        // `quantity: -1` in config.yml means "use the full configured
        // maxInvestment" - the same universal sentinel chunkedBuyIndex
        // itself understands (see resolveChunkedBuyQuantity/bookkeeping.
        // resolveMaxInvestmentQuantity, orderProcess.ts) and the identical
        // value BulkPcrStrategy/BulkPcrAutoStartStrategy configure for the
        // same effect - deliberately the SAME sentinel across every strategy
        // that supports this convention, not a per-type value, so arming one
        // doesn't require remembering a different magic number per type.
        // Requires a `maxInvestment` key in this instance's own config.yml
        // block (and `'HourlyStrategy'` in bookkeeping.canPlaceOrder's
        // maxInvestment-only exemption, alongside ContinuousStrategy/
        // BulkPcrStrategy) or it falls back to DEFAULT_MAX_INVESTMENT.
        // CAUTION with 2+ configured brokers (this strategy's default): each
        // broker's chunkedBuyIndex independently resolves "max quantity for
        // the FULL maxInvestment" at roughly the same instant
        // (Promise.allSettled below), so N concurrently-entering brokers can
        // together request up to N x maxInvestment before any fill reduces
        // headroom - same accepted gap BulkPcrStrategy's own enterOnBroker
        // documents, size maxInvestment (or trim `brokers`) with that in
        // mind.
        const quantity = cfg.quantity ?? 65;
        const brokers = this.configuredBrokers();
        Log.log(`[Hourly] Entering ${confirmation.direction} qty=${quantity} independently on: ${brokers.join(', ')}`);
        // allSettled, not all - one broker's entry failing must not abort a
        // different broker's already-in-flight buy, same reasoning as
        // BulkPcrStrategy's entry fan-out.
        await Promise.allSettled(brokers.map((broker) => this.enterOnBroker(broker, confirmation.direction, quantity, quote.ltp)));
    }

    private async enterOnBroker(broker: BrokerName, right: string, quantity: number, niftyLtp: number): Promise<void> {
        if (this.liveRemainder.has(broker) && this.liveRemainderDay === localDayKey()) {
            Log.log(`[Hourly] [${broker}] entry skipped: an earlier entry's unfilled remainder may still be live at this broker - manual review required`);
            return;
        }
        this.positions.set(broker, {
            broker,
            phase: 'buying',
            heldTsym: null,
            heldToken: null,
            entryAvg: 0,
            targetQuantity: 0,
            soldQty: 0,
            soldValue: 0,
        });
        try {
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, {
                right, quantity, niftyLtp, broker, driftCancelPoints: this.cfg().driftCancelPoints ?? 10,
            });
            const pos = this.positions.get(broker)!;
            pos.heldTsym = result.tsym;
            pos.heldToken = String(result.token);
            pos.entryAvg = result.avgPrice;
            Log.log(`[Hourly] [${broker}] Entry complete: ${pos.heldTsym} qty=${result.quantity} avg=${pos.entryAvg}`);
            if (result.orderMayBeLive) this.latchLiveRemainder(broker, `${pos.heldTsym} entry`, result.quantity);
            await this.placeExitSellAtTargetPrice(broker, result.quantity, true);
        } catch (e) {
            Log.log(`[Hourly] [${broker}] Entry failed - manual review required:`, e);
            const pos = this.positions.get(broker);
            if (pos) { pos.phase = 'error'; this.persistState(); }
        }
    }

    private async placeExitSellAtTargetPrice(broker: BrokerName, quantity: number, resetProgress: boolean): Promise<void> {
        const pos = this.positions.get(broker);
        if (!pos || !pos.heldTsym || !pos.heldToken) return;

        const targetPoints = this.cfg().targetPrice ?? 15;
        // entryAvg is a chunked weighted average and rarely lands on an
        // exact tick multiple - must round before using it as an order
        // price, same reasoning/helper as BulkPcrStrategy's
        // placeExitSellAtTargetPrice (live 2026-09-23 rejection otherwise).
        const targetPrice = roundToTick(pos.entryAvg + targetPoints);

        if (resetProgress) {
            pos.soldQty = 0;
            pos.soldValue = 0;
            pos.targetQuantity = quantity;
        }
        pos.phase = 'selling';
        pos.placingExit = true;
        this.persistState();

        try {
            await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tsym: pos.heldTsym, instrumentId: pos.heldToken, quantity, price: targetPrice, broker,
            });
            Log.log(`[Hourly] [${broker}] Resting limit sell placed for ${pos.heldTsym} qty=${quantity} @ ${targetPrice}`);
        } catch (e) {
            Log.log(`[Hourly] [${broker}] Resting limit-sell placement failed - manual review required:`, e);
            pos.phase = 'error';
            this.persistState();
        } finally {
            pos.placingExit = false;
            // A stop/EOD fired while the chunks were still being placed: run it now that every chunk is resting and can be cancelled.
            const deferred = pos.closeRequested;
            pos.closeRequested = undefined;
            if (deferred && (pos.phase === 'selling' || pos.phase === 'error') && pos.heldTsym && !pos.squaringOff) {
                Log.log(`[Hourly] [${broker}] Running the ${deferred} close that was deferred while the exit was being placed`);
                if (pos.phase === 'error') pos.phase = 'selling'; // a later chunk failed, but earlier chunks may be resting: cancel and flatten them
                this.invalidateClose(pos).catch((e) => Log.log(`[Hourly] [${broker}] deferred ${deferred} close failed:`, e));
            }
        }
    }

    // NIFTY-level invalidation: cancel the resting target sell and
    // market-square-off whatever remains, same two-step shape
    // BulkPcrStrategy's eodSquareOff uses, generalized to any broker via
    // chunkedSquareOff.
    private async invalidateClose(pos: BrokerPosition): Promise<void> {
        // squaringOff stays set for the WHOLE close (cancel + market square-off), not just the cancel: the cancel's
        // own cancellation notification can arrive after the cancel call returns, and must not re-place the sell.
        pos.squaringOff = true;
        try {
            await this.invalidateCloseInner(pos);
        } finally {
            pos.squaringOff = false;
        }
    }

    private async invalidateCloseInner(pos: BrokerPosition): Promise<void> {
        const tsym = pos.heldTsym!;
        const broker = pos.broker;
        let cancelResult: { filledQty: number; cancelFailed: boolean };
        try {
            cancelResult = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tsym, broker });
        } catch (e) {
            cancelResult = { filledQty: 0, cancelFailed: true };
            Log.log(`[Hourly] [${broker}] Invalidation cancel request failed for ${tsym}:`, e);
        }
        // Chunks that filled during the cancel race filled at the resting
        // target price - book them first, same accounting BulkPcrStrategy's
        // eodSquareOff uses.
        const targetPoints = this.cfg().targetPrice ?? 15;
        const targetPrice = roundToTick(pos.entryAvg + targetPoints);
        pos.soldQty += cancelResult.filledQty;
        pos.soldValue += cancelResult.filledQty * targetPrice;
        this.persistState();

        if (pos.soldQty >= pos.targetQuantity) {
            pos.phase = 'done';
            Log.log(`[Hourly] [${broker}] Invalidation: ${tsym} already fully sold (${pos.soldQty}/${pos.targetQuantity}) via the cancel-window fill - nothing to square off`);
            this.afterPositionDone();
            return;
        }
        if (cancelResult.cancelFailed) {
            pos.phase = 'error';
            Log.log(`[Hourly] [${broker}] ALERT: invalidation close of ${tsym} aborted, resting sell cancel failed - manual review required`);
            this.persistState();
            return;
        }
        const remaining = pos.targetQuantity - pos.soldQty;
        try {
            if (remaining > 0) {
                const result = await OrderClient.getInstance().chunkedSquareOff(this.userId, { tsym, quantity: remaining, broker: broker as 'kite' | 'ant' | 'breeze' });
                pos.soldQty += remaining;
                pos.soldValue += remaining * (result?.avgPrice ?? targetPrice);
            }
            if (pos.phase === 'selling') pos.phase = 'done'; // a fill notification may already have completed it via updateTrade
            Log.log(`[Hourly] [${broker}] Invalidation close: ${tsym} squared off qty=${Math.max(remaining, 0)}`);
            this.recordOutcome((pos.soldValue / Math.max(pos.soldQty, 1)) >= pos.entryAvg ? 'win' : 'loss', pos.soldValue - pos.entryAvg * pos.soldQty);
        } catch (e) {
            if (pos.phase === 'selling') pos.phase = 'error';
            Log.log(`[Hourly] [${broker}] ALERT: invalidation square-off failed for ${tsym} - manual review required:`, e);
        }
        this.persistState();
        this.afterPositionDone();
    }

    // Fills for the resting target sell arrive here asynchronously, one
    // chunk at a time - same accumulation BulkPcrStrategy's updateTrade uses.
    updateTrade = async (trade: Trade): Promise<void> => {
        const broker = trade.broker as BrokerName | undefined;
        if (!broker) return; // untagged fill - can't attribute to a position, ignore defensively
        const pos = this.positions.get(broker);
        if (!pos || pos.phase !== 'selling' || pos.squaringOff) return;
        if (trade.action !== 'Sell' || trade.tsym !== pos.heldTsym) return;

        pos.soldQty += trade.quantity;
        pos.soldValue += trade.quantity * trade.price;
        Log.log(`[Hourly] [${broker}] Exit fill: ${trade.tsym} qty=${trade.quantity} @ ${trade.price} (sold ${pos.soldQty}/${pos.targetQuantity})`);
        this.persistState();
        if (pos.soldQty < pos.targetQuantity) return;

        pos.phase = 'done';
        const avgExit = pos.soldValue / pos.soldQty;
        Log.log(`[Hourly] [${broker}] Exit complete (target hit): ${pos.heldTsym} qty=${pos.soldQty} avgExit=${avgExit}`);
        this.recordOutcome(avgExit >= pos.entryAvg ? 'win' : 'loss', (avgExit - pos.entryAvg) * pos.soldQty);
        this.persistState();
        this.afterPositionDone();
    };

    // Once every configured broker's position for this cycle has reached
    // 'done', clear state so the next qualifying breakout can trade again -
    // recurring, unlike BulkPcrStrategy's single-shot durable disable.
    private afterPositionDone(): void {
        const brokers = this.configuredBrokers();
        const allDone = brokers.every((b) => {
            const pos = this.positions.get(b);
            return !pos || pos.phase === 'done';
        });
        if (!allDone) return;
        this.positions.clear();
        this.activeDirection = null;
        this.activeInvalidationLevel = null;
        this.persistState();
    }

    // Called when a resting limit sell is cancelled/rejected unexpectedly
    // (e.g. a DAY-validity order expiring at session end) - re-places it at
    // the same target price, bounded, same shape as BulkPcrStrategy's
    // onOrderCancelled (see that file's comments for the live incidents
    // these guards were added for).
    onOrderCancelled = async (notification: any): Promise<void> => {
        const broker = notification.broker as BrokerName | undefined;
        if (!broker) return;
        const pos = this.positions.get(broker);
        if (!pos || pos.phase !== 'selling' || pos.heldTsym !== notification.tradingSymbol || pos.squaringOff) return;

        const rejectReason: string | undefined = notification.rejectReason;
        if (notification.reason === 'REJECTED') {
            const now = Date.now();
            const withinStreak = pos.exitLastRejectAt != null && now - pos.exitLastRejectAt <= EXIT_REJECT_STREAK_RESET_MS;
            pos.exitRejectCount = (withinStreak ? pos.exitRejectCount ?? 0 : 0) + 1;
            pos.exitLastRejectAt = now;

            if (rejectReason && MARGIN_SHORTFALL_REASON_PATTERN.test(rejectReason)) {
                Log.log(`[Hourly] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED (${rejectReason}) - looks like a margin/shortfall rejection, likely because the position is already closed at the broker. NOT re-placing - manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }
            if (pos.exitRejectCount > MAX_EXIT_REJECT_RETRIES) {
                Log.log(`[Hourly] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED ${pos.exitRejectCount} times in a row (${rejectReason ?? 'no reason given'}) - giving up on auto re-placement. Manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }
        } else {
            pos.exitRejectCount = 0;
            pos.exitLastRejectAt = undefined;
        }

        Log.log(`[Hourly] [${broker}] Order cancelled: ${notification.tradingSymbol} qty=${notification.quantity} (${notification.reason}${rejectReason ? `: ${rejectReason}` : ''}) - re-placing resting sell`);
        if ((pos.exitRejectCount ?? 0) > 1) {
            await sleep(EXIT_REJECT_RETRY_DELAY_MS);
        }
        await this.placeExitSellAtTargetPrice(broker, notification.quantity, false);
    };

    private persistState(): void {
        const positions: Partial<Record<BrokerName, BrokerPosition>> = {};
        for (const [broker, pos] of this.positions) {
            const { squaringOff: _inFlight, placingExit: _placing, closeRequested: _deferred, lastCloseAttemptAt: _last, ...durable } = pos;
            positions[broker] = durable as BrokerPosition;
        }
        const doc = { userId: this.userId, positions, liveRemainderBrokers: Array.from(this.liveRemainder), liveRemainderDay: this.liveRemainderDay };
        this.writer.enqueue(() => Mongo.getInstance()?.db.collection(STATE_COLLECTION)
            .replaceOne({ userId: this.userId }, doc, { upsert: true }));
    }

    private async loadState(): Promise<PersistedState | null> {
        try {
            const doc = await Mongo.getInstance()?.db.collection(STATE_COLLECTION).findOne({ userId: this.userId });
            return doc ? normalizePersistedBrokers(doc as any) : null;
        } catch (e) {
            Log.log('[Hourly] loadState failed:', e);
            return null;
        }
    }

    // Restart safety - deliberately conservative (see file header). Candle/
    // hourly-level state is never persisted and simply rebuilds over the
    // next hour's ticks. Broker position state IS persisted: any position
    // not yet 'done' is restored, then checked against the broker's live
    // open trades - closed at the broker while this process was down is
    // marked 'done'; still open is flagged 'error' for manual review rather
    // than guessing whether its resting sell survived the restart.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        const persisted = await this.loadState();
        if (persisted?.liveRemainderDay === localDayKey()) {
            for (const broker of persisted.liveRemainderBrokers ?? []) {
                this.liveRemainder.add(broker);
                this.liveRemainderDay = persisted.liveRemainderDay;
                Log.log(`[Hourly] [${broker}] ALERT: restored a possibly-live entry remainder latch - no new entry today until reset`);
            }
        }
        if (persisted?.positions) {
            for (const [broker, pos] of Object.entries(persisted.positions)) {
                if (pos && pos.phase !== 'done') this.positions.set(broker as BrokerName, pos as BrokerPosition);
            }
        }
        if (this.positions.size === 0) return;

        let openTrades: any[] | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                openTrades = await OrderClient.getInstance().getOpenTrades(this.userId);
                break;
            } catch (e) {
                Log.log(`[Hourly] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                if (attempt === maxAttempts) {
                    Log.log('[Hourly] reconcile: order query exhausted retries - flagging every restored position for manual review');
                    for (const pos of this.positions.values()) pos.phase = 'error';
                    this.persistState();
                    return;
                }
                await sleep(retryDelayMs);
            }
        }

        for (const pos of this.positions.values()) {
            // Only this slot's own broker counts: the same contract held on another broker is a different position.
            const brokerTrades = openTrades!.filter((t) => !t.broker || normalizeBrokerName(t.broker) === pos.broker);
            if (pos.phase === 'buying' || !pos.heldTsym) {
                // The entry was still in flight when the process went down: chunks may have filled under a
                // contract this slot never recorded. Never assume flat - closed only if the broker holds nothing.
                if (brokerTrades.length > 0) {
                    Log.log(`[Hourly] [${pos.broker}] reconcile: entry was in flight at restart and the broker holds ${brokerTrades.length} open trade(s) - flagging for manual review`);
                    pos.phase = 'error';
                } else {
                    pos.phase = 'done';
                }
                continue;
            }
            const stillOpen = brokerTrades.some((t) => t.tsym === pos.heldTsym);
            if (!stillOpen) {
                Log.log(`[Hourly] [${pos.broker}] reconcile: ${pos.heldTsym} no longer open at the broker - assuming fully closed`);
                pos.phase = 'done';
                continue;
            }
            if (pos.phase === 'selling') {
                Log.log(`[Hourly] [${pos.broker}] reconcile: ${pos.heldTsym} still open after restart - cannot safely confirm the resting exit sell survived, flagging for manual review`);
                pos.phase = 'error';
            }
        }
        this.afterPositionDone();
        this.persistState();
    }

    reset(): void {
        super.reset();
        this.positions.clear();
        this.liveRemainder.clear();
        // Only the latch is cleared durably - the persisted positions stay, so a restart can still restore a live resting exit.
        this.writer.enqueue(() => Mongo.getInstance()?.db.collection(STATE_COLLECTION).updateOne({ userId: this.userId }, { $set: { liveRemainderBrokers: [] } }));
        this.currentHourBucket = null;
        this.hourComplete = false;
        this.resistance = null;
        this.support = null;
        this.currentTenMinBucket = null;
        this.currentCandle = null;
        this.pendingConfirmation = null;
        this.triggeredThisHour = false;
        this.activeDirection = null;
        this.activeInvalidationLevel = null;
    }
}
