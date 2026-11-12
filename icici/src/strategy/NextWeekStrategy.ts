import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { CandleEntryStrategy } from './CandleEntryStrategy';
import { createStatsBuilder, SeedCandle } from '../processes/strategies/niftyStatsBuilder';
import { seededEMA } from '../lib/indicators';
import { BreakoutData, sideVsAverage, Side } from '../lib/breakoutData';
import { loadSeedCandles, loadLiveCandles, saveLiveCandles } from '../lib/yahooCandles';
import { isPastTime } from '../util/marketHours';

// 15-minute NIFTY candles + a 50 EMA trend + the breakout candle pattern, traded on the NEXT-week expiry (expiryOffset 1).
//   Trend:    candle close above the 50 EMA = call, below = put.
//   Breakout: BreakoutData.from(c1, c2) - c2 closes above its open and above c1's high = call; below its open and below c1's low = put.
//   Entry:    when a candle closes and BOTH agree: one limit buy per broker of the ATM option (call = CE, put = PE) at the option's prevailing LTP,
//             `quantity` units (config), next-week expiry. Otherwise nothing.
//   Exit:     target / stopLoss (block or settings), else the EOD close - see CandleEntryStrategy.
// One position at a time. A candle is evaluated once (persisted key), so a restart never re-fires it.
//
// History: the 50 EMA needs 50 closed candles. At the first tick of the day the previous days' candles come from Yahoo Finance (^NSEI, one call
// per day, cached in Mongo - see lib/yahooCandles.ts), then today's own candles are built from the NIFTY ticks (clock-aligned: 09:15, 09:30, ...)
// and each one is stored in Mongo so a mid-day restart keeps them. Until 50 closes exist, or while the seed cannot be loaded, it does not trade.
//
// A signal needs c1 and c2 to be consecutive candles of the same day, so the 09:15-09:30 candle (whose predecessor is yesterday's last candle) never
// trades; the first possible entry is at 09:45, the close of the 09:30 candle. A candle that started from a tick more than 60 s after its boundary (a restart mid-candle)
// is incomplete and does not trade either, and a candle that closed more than 5 minutes ago is not traded late.
//
// Config (config.yml):
//   quantity: 65            - per broker, whole lots
//   target: 20 / stopLoss: 12 - exit rules (block or settings)
//   lastEntryTime: '15:00'  - no entry at or after this time (default 15:00)
//   index: NIFTY, brokers: [kite]
const BUCKET_SECONDS = 900;
const EMA_PERIOD = 50;
const SESSION_OPEN_SECONDS = 9 * 3600 + 15 * 60;
const SESSION_CLOSE_SECONDS = 15 * 3600 + 30 * 60;
const LATE_CANDLE_SECONDS = 300;
const PARTIAL_CANDLE_SECONDS = 60;
const SEED_RETRY_MS = 60_000;

export default class NextWeekStrategy extends CandleEntryStrategy {
    protected readonly logTag = `NextWeek:${this.userId}`;
    protected readonly strategyType = 'NextWeekStrategy';
    private builder = createStatsBuilder(BUCKET_SECONDS, { aligned: true });
    private tradingDay: string | null = null;
    private seeded = false;
    private seeding = false;
    private nextSeedAttemptAt = 0;
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
        this.tradingDay = null; // the next tick re-seeds
    }

    private newDay(today: string): void {
        this.tradingDay = today;
        this.builder.reset();
        this.seeded = false;
        this.nextSeedAttemptAt = 0;
        this.liveToday = [];
        this.firstTickChecked = false;
        this.firstCandlePartial = false;
        this.firstCandleSeen = false;
        this.incompleteCandles.clear();
    }

    // Loads the history once per day: the previous days (Yahoo, cached) + today's candles already stored by this strategy. False = not ready (logged).
    private async ensureSeed(today: string): Promise<boolean> {
        if (this.seeded) return true;
        if (this.seeding || Date.now() < this.nextSeedAttemptAt) return false;
        this.seeding = true;
        try {
            const { candles, source } = await loadSeedCandles(today);
            const live = await loadLiveCandles(today);
            const lastSeedTime = candles.length > 0 ? candles[candles.length - 1].time : 0;
            const todays = live.filter((c) => c.time > lastSeedTime);
            const all: SeedCandle[] = [...candles, ...todays];
            this.builder.seed(all);
            this.liveToday = todays;
            this.seeded = true;
            const fmt = (t?: number) => (t ? new Date(t * 1000).toLocaleString('en-GB', { hour12: false }) : 'n/a');
            Log.log(`[${this.logTag}] SEED loaded: ${candles.length} candles from ${source} (${fmt(candles[0]?.time)} .. ${fmt(lastSeedTime)}) + ${todays.length} of today from Mongo = ${all.length} closes (the ${EMA_PERIOD} EMA needs ${EMA_PERIOD})`);
            return true;
        } catch (e: any) {
            this.nextSeedAttemptAt = Date.now() + SEED_RETRY_MS;
            Log.log(`[${this.logTag}] ALERT: SEED failed (${e?.message ?? e}) - not trading, retrying in ${SEED_RETRY_MS / 1000}s`);
            return false;
        } finally {
            this.seeding = false;
        }
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const today = localDayKey();
        if (this.tradingDay !== today) this.newDay(today);
        const ltt = Number(quote.ltt);
        const ltp = Number(quote.ltp);
        if (!Number.isFinite(ltt) || !(ltp > 0)) return;
        const sod = this.secondsOfDay(ltt);
        if (sod < SESSION_OPEN_SECONDS || sod >= SESSION_CLOSE_SECONDS) return; // pre-open and closing-auction ticks are not part of a candle
        if (!(await this.ensureSeed(today))) return;
        if (!this.firstTickChecked) {
            this.firstTickChecked = true;
            this.firstCandlePartial = ltt % BUCKET_SECONDS > PARTIAL_CANDLE_SECONDS;
            if (this.firstCandlePartial) Log.log(`[${this.logTag}] first tick ${ltt % BUCKET_SECONDS}s into its candle - that candle is incomplete and will not trade`);
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
            void saveLiveCandles(this.liveToday, today);
        }

        const ema = closes.length >= EMA_PERIOD ? seededEMA(closes, EMA_PERIOD)[closes.length - 1] : undefined;
        const c1text = c1 ? `c1 O ${c1.open} H ${c1.high} L ${c1.low} C ${c1.close} (starts ${new Date(Number(c1.candleTime) * 1000).toTimeString().slice(0, 5)})` : 'c1 none';
        const head = `candle ${label} closed: O ${c2.open} H ${c2.high} L ${c2.low} C ${c2.close} | ${c1text} | closes ${closes.length}/${EMA_PERIOD} | EMA${EMA_PERIOD} ${ema === undefined ? 'n/a' : ema.toFixed(2)}`;
        const skip = (why: string) => Log.log(`[${this.logTag}] ${head} -> no trade: ${why}`);

        if (ema === undefined) return skip(`warming up ${closes.length}/${EMA_PERIOD} candles`);
        if (partial) return skip('incomplete candle (started mid-candle after a restart)');
        if (!c1 || Number(c1.candleTime) + BUCKET_SECONDS !== start) return skip('c1 is not the immediately preceding candle of the same day');
        if (this.incompleteCandles.has(Number(c1.candleTime))) return skip('c1 is an incomplete candle (started mid-candle after a restart)');
        const late = tickLtt - (start + BUCKET_SECONDS);
        if (late > LATE_CANDLE_SECONDS) return skip(`candle closed ${late}s ago (more than ${LATE_CANDLE_SECONDS}s) - not traded late`);

        const trend: Side | undefined = sideVsAverage(c2.close, ema);
        const breakout: Side | undefined = BreakoutData.from(c1, c2);
        const verdict = `trend ${trend ?? 'none'} (close ${c2.close} vs EMA ${ema.toFixed(2)}), breakout ${breakout ?? 'none'}`;
        if (!trend || !breakout || trend !== breakout) return skip(`${verdict} - they do not agree`);
        if (isPastTime(String((this.cfg() as any).lastEntryTime ?? '15:00'), '15:00')) return skip(`${verdict} - past lastEntryTime ${(this.cfg() as any).lastEntryTime ?? '15:00'}`);
        if (this.isRunning()) return skip(`${verdict} - a previous position is still open`);
        const key = `${today} ${start}`;
        if (this.cycleStarted(key)) return skip(`${verdict} - this candle was already handled (restart)`);
        if (this.configuredQuantity() === null) { Log.log(`[${this.logTag}] ALERT: ${head} -> ${verdict} but quantity (${(this.cfg() as any).quantity}) is not a positive multiple of the lot size - not trading`); return; }
        try {
            this.exitRules();
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${head} -> ${verdict} but ${e?.message ?? e} - not trading`);
            return;
        }

        const right = trend === 'call' ? 'CE' : 'PE';
        const strike = this.atmStrike(niftyLtp);
        Log.log(`[${this.logTag}] ${head} -> ${verdict} -> BUY ${right} ${strike} on the next-week expiry, quantity ${this.configuredQuantity()} per broker`);
        await this.startCycle(key, { index: 'NIFTY', strike, right, expiryOffset: 1 }, () => 1, async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp);
        });
    }
}
