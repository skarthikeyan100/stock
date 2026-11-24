import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { CandleEntryStrategy } from './CandleEntryStrategy';
import { createStatsBuilder, SeedCandle } from '../processes/strategies/niftyStatsBuilder';
import { seededEMA } from '../lib/indicators';
import { BreakoutData, sideVsAverage, Side } from '../lib/breakoutData';
import { loadLiveCandles, saveLiveCandles } from '../lib/yahooCandles';
import { isPastTime, isNiftyExpiryDay } from '../util/marketHours';
import { investmentForBroker } from '../prism/configVocabulary';
import { INDEX_LOT_SIZE } from '../constants';

// GammaBurst: the NextWeekStrategy signal (breakout candle + trend) on 2-MINUTE NIFTY candles with a 9 EMA, traded on THIS week's expiry
// (expiryOffset 0) and ONLY on the NIFTY expiry day itself. Entries only from 14:00.
//   Candles:  2-minute, built from the NIFTY ticks on the 09:15 grid (09:15, 09:17, ... 13:59, 14:01, ...).
//   Trend:    candle close above the 9 EMA = call, below = put.
//   Breakout: BreakoutData.from(c1, c2) - c2 closes above its open and above c1's high = call; below its open and below c1's low = put.
//   Entry:    when a candle closes and BOTH agree, the candle closed at or after 14:00 (the first candle that can trade is 13:59-14:01,
//             closing at 14:01), and it is an expiry day: one limit buy per broker of the ATM option (call = CE, put = PE) at the option's
//             best bid (central order price), sized from the broker's investment (maxInvestment / maxInvestmentByBroker): whole lots that fit the budget at that price.
//   Exit:     target only (2 points on the option by config), no stop: a resting target sell, otherwise the EOD close.
//   One trade at a time. After a trade closes, no new entry for COOLDOWN_MS; the next candle that agrees after that is taken.
//   Entries are evaluated on candle closes only, so the wait matters when a trade closes less than a minute before a candle closes.
//
// History: the 9 EMA is built from today's own 2-minute candles, from 09:15 (about 09:33 before the first has 9 closes). Nothing is seeded
// from Yahoo (its history is 15-minute, and NextWeek's store is 15-minute too). Today's completed candles are kept in Mongo
// `candles2Live` (one document per day), so a mid-day restart restores the EMA instead of starting it again.
//
// The candle plumbing is otherwise NextWeekStrategy's; it is copied rather than shared so that NextWeek, which may hold live legs, is not
// touched by this change.
//
// Config (config.yml):
//   maxInvestment: 100000   - per broker (the 1 lakh budget); maxInvestmentByBroker overrides one broker
//   target: 2 / stopLoss: 'none' - exit rules (block or settings); the stop must be 'none' for this strategy to trade
//   lastEntryTime: '15:00'  - no entry at or after this time (default 15:00)
//   index: NIFTY, brokers: [kite]
const BUCKET_SECONDS = 120;
// IST 09:15 modulo the bucket: the 2-minute grid starts at the market open. (IST midnight is a multiple of 120 s, so this is the offset.)
const CANDLE_ORIGIN_SECONDS = (9 * 3600 + 15 * 60) % BUCKET_SECONDS;
const EMA_PERIOD = 9;
const START_SECONDS = 14 * 3600;
const SESSION_OPEN_SECONDS = 9 * 3600 + 15 * 60;
const SESSION_CLOSE_SECONDS = 15 * 3600 + 30 * 60;
const LATE_CANDLE_SECONDS = 30;   // a candle is traded only if its close was seen within this many seconds (2-minute candles)
const PARTIAL_CANDLE_SECONDS = 30; // a first tick more than this into its candle means the candle is incomplete (a restart mid-candle)
const COOLDOWN_MS = 60_000;
const LIVE_COLLECTION = 'candles2Live';

export default class GammaBurstStrategy extends CandleEntryStrategy {
    protected readonly logTag = `GammaBurst:${this.userId}`;
    protected readonly strategyType = 'GammaBurstStrategy';
    private builder = createStatsBuilder(BUCKET_SECONDS, { aligned: true, originSeconds: CANDLE_ORIGIN_SECONDS });
    private tradingDay: string | null = null;
    private restored = false;
    private liveToday: SeedCandle[] = [];
    private firstTickChecked = false;
    private firstCandlePartial = false;
    private firstCandleSeen = false;
    private incompleteCandles = new Set<number>(); // start times of candles built from a mid-candle restart: never a c1

    constructor(userId?: string) {
        super(userId);
        this.warnLegacyExitKeys();
    }

    reset(): void {
        super.reset();
        this.tradingDay = null; // the next tick starts the day again
    }

    private newDay(today: string): void {
        this.tradingDay = today;
        this.builder.reset();
        this.restored = false;
        this.liveToday = [];
        this.firstTickChecked = false;
        this.firstCandlePartial = false;
        this.firstCandleSeen = false;
        this.incompleteCandles.clear();
        if (!isNiftyExpiryDay()) Log.log(`[${this.logTag}] not a NIFTY expiry day - no entries today (candles are still built)`);
    }

    // True when every broker of this block is the paper broker: this strategy then keeps nothing in Mongo.
    private memoryOnly(): boolean {
        const b = this.brokers();
        return b.length > 0 && b.every((x) => x === 'paper');
    }

    // Once per day: today's completed 2-minute candles that this strategy stored before a restart (none on a fresh start). Never waits on
    // an external source, so trading is never blocked by one.
    private async ensureRestored(today: string): Promise<void> {
        if (this.restored) return;
        this.restored = true;
        // Paper-only: nothing is stored in Mongo, so there is nothing to restore either (the EMA starts again from today's ticks).
        const live = this.memoryOnly() ? [] : await loadLiveCandles(today, LIVE_COLLECTION);
        if (live.length > 0) this.builder.seed(live);
        this.liveToday = [...live];
        Log.log(`[${this.logTag}] RESTORED ${live.length} of today's ${BUCKET_SECONDS / 60}-minute candles from Mongo (the ${EMA_PERIOD} EMA is built from them and from today's ticks)`);
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const today = localDayKey();
        if (this.tradingDay !== today) this.newDay(today);
        const ltt = Number(quote.ltt);
        const ltp = Number(quote.ltp);
        if (!Number.isFinite(ltt) || !(ltp > 0)) return;
        const sod = this.secondsOfDay(ltt);
        if (sod < SESSION_OPEN_SECONDS || sod >= SESSION_CLOSE_SECONDS) return; // pre-open and closing-auction ticks are not part of a candle
        await this.ensureRestored(today);
        if (!this.firstTickChecked) {
            this.firstTickChecked = true;
            const intoCandle = (ltt - CANDLE_ORIGIN_SECONDS) % BUCKET_SECONDS;
            this.firstCandlePartial = intoCandle > PARTIAL_CANDLE_SECONDS;
            if (this.firstCandlePartial) Log.log(`[${this.logTag}] first tick ${intoCandle}s into its candle - that candle is incomplete and will not trade`);
        }
        const update = this.builder.record(ltp, ltt);
        if (!update) return;
        await this.onCandleClosed(update.oldStats, update.newStats, ltt, ltp);
    }

    private async onCandleClosed(c1: any, c2: any, tickLtt: number, niftyLtp: number): Promise<void> {
        const today = localDayKey();
        const closes = this.builder.closes();
        const partial = this.firstCandlePartial && !this.firstCandleSeen;
        this.firstCandleSeen = true;
        const start = Number(c2.candleTime);
        if (partial) this.incompleteCandles.add(start);
        const label = `${new Date(start * 1000).toTimeString().slice(0, 5)}-${new Date((start + BUCKET_SECONDS) * 1000).toTimeString().slice(0, 5)}`;

        // Today's candle goes to Mongo (a complete candle only: a partial one would poison a restart's EMA).
        if (!partial) {
            this.liveToday.push({ time: start, open: c2.open, high: c2.high, low: c2.low, close: c2.close });
            if (!this.memoryOnly()) void saveLiveCandles(this.liveToday, today, LIVE_COLLECTION);
        }

        const ema = closes.length >= EMA_PERIOD ? seededEMA(closes, EMA_PERIOD)[closes.length - 1] : undefined;
        const c1text = c1 ? `c1 O ${c1.open} H ${c1.high} L ${c1.low} C ${c1.close} (starts ${new Date(Number(c1.candleTime) * 1000).toTimeString().slice(0, 5)})` : 'c1 none';
        const head = `candle ${label} closed: O ${c2.open} H ${c2.high} L ${c2.low} C ${c2.close} | ${c1text} | closes ${closes.length}/${EMA_PERIOD} | EMA${EMA_PERIOD} ${ema === undefined ? 'n/a' : ema.toFixed(2)}`;
        const skip = (why: string) => Log.log(`[${this.logTag}] ${head} -> no trade: ${why}`);

        // Only on the NIFTY expiry day (the candles and EMA are still built on other days). Silent here: newDay logs it once.
        if (!isNiftyExpiryDay()) return;
        // Entries start at 14:00: a candle that closes before 14:00 never trades (the first one that can is 13:59-14:01, closing 14:01).
        const closeSod = this.secondsOfDay(start + BUCKET_SECONDS);
        if (closeSod < START_SECONDS) return skip('before 14:00 (GammaBurst starts at 14:00)');
        if (ema === undefined) return skip(`warming up ${closes.length}/${EMA_PERIOD} candles`);
        if (partial) return skip('incomplete candle (started mid-candle after a restart)');
        if (!c1 || Number(c1.candleTime) + BUCKET_SECONDS !== start) return skip('c1 is not the immediately preceding candle of the same day');
        if (this.incompleteCandles.has(Number(c1.candleTime))) return skip('c1 is an incomplete candle (started mid-candle after a restart)');
        const late = tickLtt - (start + BUCKET_SECONDS);
        if (late > LATE_CANDLE_SECONDS) return skip(`candle closed ${late}s ago (more than ${LATE_CANDLE_SECONDS}s) - not traded late`);

        const trend: Side | undefined = sideVsAverage(c2.close, ema);
        const breakout: Side | undefined = BreakoutData.from(c1, c2);
        const verdict = `trend ${trend ?? 'none'} (close ${c2.close} vs EMA${EMA_PERIOD} ${ema.toFixed(2)}), breakout ${breakout ?? 'none'}`;
        if (!trend || !breakout || trend !== breakout) return skip(`${verdict} - they do not agree`);
        const lastEntry = String((this.cfg() as any).lastEntryTime ?? '15:00');
        if (isPastTime(lastEntry, '15:00')) return skip(`${verdict} - past lastEntryTime ${lastEntry}`);
        if (this.isRunning()) return skip(`${verdict} - a trade is still open`);
        const endedAt = this.cycleEndedAt();
        if (endedAt !== undefined && Date.now() - endedAt < COOLDOWN_MS) {
            return skip(`${verdict} - waiting ${Math.ceil((COOLDOWN_MS - (Date.now() - endedAt)) / 1000)}s after the last trade closed`);
        }
        const key = `${today} ${start}`;
        if (this.cycleStarted(key)) return skip(`${verdict} - this candle was already handled (restart)`);
        try {
            // Target only: a stop (block or inherited from settings) or a missing target means this strategy must not trade.
            const rules = this.exitRules();
            if (rules.stop !== null) throw new Error(`stopLoss must be 'none' on this block (GammaBurst has no stop; got a stop)`);
            if (rules.target === null) throw new Error(`target must be a value (GammaBurst exits at the target)`);
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${head} -> ${verdict} but ${e?.message ?? e} - not trading`);
            return;
        }

        const right = trend === 'call' ? 'CE' : 'PE';
        const strike = this.atmStrike(niftyLtp);
        Log.log(`[${this.logTag}] ${head} -> ${verdict} -> BUY ${right} ${strike} on this week's expiry, investment ${this.brokers().map((b) => `${b} ${investmentForBroker(this.cfg() as any, b)}`).join(', ')}`);
        await this.startCycle(key, { index: 'NIFTY', strike, right, expiryOffset: 0 }, (b) => investmentForBroker(this.cfg() as any, b), undefined);
    }

    // Budget-sized, not a fixed quantity: whole lots of NIFTY that fit the rupee budget at the option's price (LimitEntryStrategy's rule).
    protected sizeOrder(budget: number, price: number, _index: 'NIFTY' | 'SENSEX'): number {
        const lot = INDEX_LOT_SIZE.NIFTY;
        if (!(price > 0) || !(budget > 0)) return 0;
        return Math.floor(budget / (price * lot)) * lot;
    }

    // This week's expiry, always: the global settings.skipNearestExpiryOnExpiryDay would move a buy on the expiry day to next week's contract.
    protected skipNearestExpiryDay(): boolean | undefined {
        return false;
    }

    // A trade that filled and has now fully closed starts the 1-minute wait. A cycle that never filled (refused / cancelled) does not.
    protected async onCycleEnded(): Promise<void> {
        if (!this.legs().some((l) => l.filledQty > 0)) return;
        this.markCycleEndedAt(Date.now());
        Log.log(`[${this.logTag}] trade closed - no new entry for ${COOLDOWN_MS / 1000}s`);
    }
}
