import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { CandleEntryStrategy } from './CandleEntryStrategy';
import { createStatsBuilder } from '../processes/strategies/niftyStatsBuilder';
import { isPastTime } from '../util/marketHours';
import { investmentForBroker } from '../prism/configVocabulary';
import { INDEX_LOT_SIZE } from '../constants';

// HighLow: two consecutive NIFTY candles of `candleMinutes` (default 10; c1 then c2, 09:15 grid: 09:15-09:25, 09:25-09:35, ... for 10; built from the index ticks).
//   c2.close >= c1.high + 10  -> buy CE (c2 closes outside c1's range, above its high, by at least 10 index points)
//   c2.close <= c1.low - 10   -> buy PE (c2 closes outside c1's range, below its low, by at least 10 index points)
//   anything else (c2 closes inside c1's range, or outside it by less than 10 points) -> no trade.
// Entry: when a candle closes and it agrees: one limit buy per broker of the ATM option at its LTP (this/next expiry as the global
//   skipNearestExpiry settings decide). One trade at a time; a candle is handled once (also across a restart).
// Exit (checkpointTrail.ts; needs 2+ whole lots): stopLoss on ticks for the whole leg. `target` is the CHECKPOINT: when a 5-minute candle of the option
//   closes at or above buy + target, half the lots sell at market and the stop of the rest moves to that close - 2; the rest exits at buy + 1.5 x target
//   (second target) or at the new stop. Below 2 lots: a plain target + stop.
// A changed `candleMinutes` (config hot-reload) restarts the candle building at once: the first candle after it never pairs with an older one,
//   so candles of different lengths are never compared.
// Candles are kept in memory only (nothing in Mongo), so a restart starts the pairing again: the first candle after it never pairs with an older one.
//
// Config (config.yml):
//   quantity: 130            - units per broker (whole lots)   -- exactly ONE of quantity / maxInvestment
//   maxInvestment: 100000    - the investment amount: rupee budget per broker (maxInvestmentByBroker overrides one broker); whole lots that fit at the option's price
//   target / stopLoss        - exit rules (target = the checkpoint distance, see Exit)
//   candleMinutes: 10        - candle length in whole minutes (1..375; absent = 10; invalid = ALERT + 10), per strategy block
//   bodyDominance: 60        - c2's body must exceed this % of its range R2 = H2 - L2: CE (c2-o2)/R2*100 > it, PE (o2-c2)/R2*100 > it (absent = 60; invalid = ALERT + 60)
//   closeLocation: 70        - c2's close location value CLV = (c2-l2)/R2*100: CE needs >= it, PE needs <= 100 - it (absent = 70; invalid = ALERT + 70)
//   lastEntryTime: '15:00'   - no entry at or after this time
//   index: NIFTY, brokers: [paper]
const DEFAULT_CANDLE_MINUTES = 10;
const DEFAULT_BODY_DOMINANCE = 60;
const DEFAULT_CLOSE_LOCATION = 70;
const MAX_CANDLE_MINUTES = 375; // the whole 09:15-15:30 session
const SESSION_OPEN_SECONDS = 9 * 3600 + 15 * 60;
const SESSION_CLOSE_SECONDS = 15 * 3600 + 30 * 60;
const LATE_CANDLE_SECONDS = 30;
const PARTIAL_CANDLE_SECONDS = 30;

export interface Ohlc { open: number; high: number; low: number; close: number }
export type HighLowSide = 'CE' | 'PE';

export const MIN_BREAKOUT_POINTS = 10; // c2's close must be outside c1's range by at least this many index points

// The whole signal: c2's close at least MIN_BREAKOUT_POINTS above c1's high = CE; at least that far below c1's low = PE.
export function highLowSignal(c1: Pick<Ohlc, 'high' | 'low'>, c2: Pick<Ohlc, 'close'>): HighLowSide | undefined {
    const vals = [c1.high, c1.low, c2.close];
    if (!vals.every((v) => Number.isFinite(v))) return undefined;
    const eps = 1e-9; // float noise on prices like 25360.85 + 10
    if (c2.close - c1.high >= MIN_BREAKOUT_POINTS - eps) return 'CE';
    if (c1.low - c2.close >= MIN_BREAKOUT_POINTS - eps) return 'PE';
    return undefined;
}

// c2 quality filters on top of the signal. R2 = H2 - L2 (R2 <= 0 or a non-numeric candle: not ok). Returns a reason when c2 fails, else undefined.
export function c2QualityFailure(c2: Ohlc, side: HighLowSide, bodyDominance: number, closeLocation: number): string | undefined {
    const vals = [c2.open, c2.high, c2.low, c2.close];
    if (!vals.every((v) => Number.isFinite(v))) return 'c2 has no complete open/high/low/close';
    const r2 = c2.high - c2.low;
    if (!(r2 > 0)) return 'c2 has no range (H2 = L2)';
    const eps = 1e-9;
    const body = (side === 'CE' ? c2.close - c2.open : c2.open - c2.close) / r2 * 100;
    if (!(body > bodyDominance + eps)) return `c2 body dominance ${body.toFixed(1)}% is not above ${bodyDominance}%`;
    const clv = (c2.close - c2.low) / r2 * 100;
    if (side === 'CE' && clv < closeLocation - eps) return `c2 close location ${clv.toFixed(1)}% is below ${closeLocation}% (CE)`;
    if (side === 'PE' && clv > 100 - closeLocation + eps) return `c2 close location ${clv.toFixed(1)}% is above ${100 - closeLocation}% (PE)`;
    return undefined;
}

export default class HighLowStrategy extends CandleEntryStrategy {
    protected readonly logTag = `HighLow:${this.userId}`;
    protected readonly strategyType = 'HighLowStrategy';
    private builder: ReturnType<typeof createStatsBuilder> | null = null;
    private bucketSeconds = DEFAULT_CANDLE_MINUTES * 60;
    private originSeconds = 0;
    private candleMinutes = 0;
    private invalidMinutesAlerted: string | null = null;
    private invalidPctAlerted: string | null = null;
    private tradingDay: string | null = null;
    private firstTickChecked = false;
    private firstCandlePartial = false;
    private firstCandleSeen = false;
    private incompleteCandles = new Set<number>();

    constructor(userId?: string) {
        super(userId);
        this.warnLegacyExitKeys();
    }

    reset(): void {
        super.reset();
        this.tradingDay = null;
    }

    // candleMinutes of this block, read from the live config each tick: absent = 10; not a whole number of minutes in 1..375 = ALERT (once per value) and 10.
    private configuredCandleMinutes(): number {
        const raw = (this.cfg() as any).candleMinutes;
        if (raw === undefined || raw === null) return DEFAULT_CANDLE_MINUTES;
        if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_CANDLE_MINUTES) return raw;
        const shown = JSON.stringify(raw);
        if (this.invalidMinutesAlerted !== shown) {
            this.invalidMinutesAlerted = shown;
            Log.log(`[${this.logTag}] ALERT: candleMinutes ${shown} must be a whole number of minutes from 1 to ${MAX_CANDLE_MINUTES} - using ${DEFAULT_CANDLE_MINUTES}`);
        }
        return DEFAULT_CANDLE_MINUTES;
    }

    // A 0..100 percentage key of this block, read from the live config: absent = `dflt`; anything else invalid = ALERT (once per value) and `dflt`.
    private pctKey(key: 'bodyDominance' | 'closeLocation', dflt: number): number {
        const raw = (this.cfg() as any)[key];
        if (raw === undefined || raw === null) return dflt;
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw;
        const shown = `${key}=${JSON.stringify(raw)}`;
        if (this.invalidPctAlerted !== shown) {
            this.invalidPctAlerted = shown;
            Log.log(`[${this.logTag}] ALERT: ${key} ${JSON.stringify(raw)} must be a number from 0 to 100 - using ${dflt}`);
        }
        return dflt;
    }

    // (Re)builds the candle builder for `minutes` on today's 09:15 grid (origin = today's 09:15 epoch modulo the bucket, so any length stays on the grid).
    private newBuilder(minutes: number, ltt: number, sod: number): void {
        this.candleMinutes = minutes;
        this.bucketSeconds = minutes * 60;
        this.originSeconds = (ltt - sod + SESSION_OPEN_SECONDS) % this.bucketSeconds;
        this.builder = createStatsBuilder(this.bucketSeconds, { aligned: true, originSeconds: this.originSeconds });
    }

    private newDay(today: string): void {
        this.tradingDay = today;
        this.builder = null;
        this.firstTickChecked = false;
        this.firstCandlePartial = false;
        this.firstCandleSeen = false;
        this.incompleteCandles.clear();
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const today = localDayKey();
        if (this.tradingDay !== today) this.newDay(today);
        const ltt = Number(quote.ltt);
        const ltp = Number(quote.ltp);
        if (!Number.isFinite(ltt) || !(ltp > 0)) return;
        const sod = this.secondsOfDay(ltt);
        if (sod < SESSION_OPEN_SECONDS || sod >= SESSION_CLOSE_SECONDS) return;
        const minutes = this.configuredCandleMinutes();
        if (!this.builder || minutes !== this.candleMinutes) {
            if (this.builder) Log.log(`[${this.logTag}] candleMinutes ${this.candleMinutes} -> ${minutes}: candles restart, the first new candle will not trade`);
            this.newBuilder(minutes, ltt, sod);
            this.firstTickChecked = false;
            this.firstCandlePartial = false;
            this.firstCandleSeen = false;
            this.incompleteCandles.clear();
        }
        if (!this.firstTickChecked) {
            this.firstTickChecked = true;
            const intoCandle = (ltt - this.originSeconds) % this.bucketSeconds;
            this.firstCandlePartial = intoCandle > PARTIAL_CANDLE_SECONDS;
            if (this.firstCandlePartial) Log.log(`[${this.logTag}] first tick ${intoCandle}s into its candle - that candle is incomplete and will not trade`);
        }
        const update = this.builder!.record(ltp, ltt);
        if (!update) return;
        await this.onCandleClosed(update.oldStats, update.newStats, ltt, ltp);
    }

    private async onCandleClosed(c1: any, c2: any, tickLtt: number, niftyLtp: number): Promise<void> {
        const today = localDayKey();
        const partial = this.firstCandlePartial && !this.firstCandleSeen;
        this.firstCandleSeen = true;
        const start = Number(c2.candleTime);
        if (partial) this.incompleteCandles.add(start);
        const label = `${new Date(start * 1000).toTimeString().slice(0, 5)}-${new Date((start + this.bucketSeconds) * 1000).toTimeString().slice(0, 5)}`;
        const c1text = c1 ? `c1 H ${c1.high} L ${c1.low}` : 'c1 none';
        const head = `candle ${label} closed: C ${c2.close} | ${c1text}`;
        const skip = (why: string) => Log.log(`[${this.logTag}] ${head} -> no trade: ${why}`);

        if (partial) return skip('incomplete candle (started mid-candle after a restart)');
        if (!c1 || Number(c1.candleTime) + this.bucketSeconds !== start) return skip('c1 is not the immediately preceding candle of the same day');
        if (this.incompleteCandles.has(Number(c1.candleTime))) return skip('c1 is an incomplete candle (started mid-candle after a restart)');
        const late = tickLtt - (start + this.bucketSeconds);
        if (late > LATE_CANDLE_SECONDS) return skip(`candle closed ${late}s ago (more than ${LATE_CANDLE_SECONDS}s) - not traded late`);
        const right = highLowSignal(c1, c2);
        if (!right) return skip(`c2 did not close outside c1's range by ${MIN_BREAKOUT_POINTS}+ points (above c1 high or below c1 low)`);
        const bad = c2QualityFailure(c2, right, this.pctKey('bodyDominance', DEFAULT_BODY_DOMINANCE), this.pctKey('closeLocation', DEFAULT_CLOSE_LOCATION));
        if (bad) return skip(`${right} signal but ${bad}`);
        const lastEntry = String((this.cfg() as any).lastEntryTime ?? '15:00');
        if (isPastTime(lastEntry, '15:00')) return skip(`${right} signal but past lastEntryTime ${lastEntry}`);
        if (this.isRunning()) return skip(`${right} signal but a trade is still open`);
        const key = `${today} ${start}`;
        if (this.cycleStarted(key)) return skip(`${right} signal but this candle was already handled (restart)`);
        try {
            const rules = this.exitRules();
            if (rules.target === null || rules.stop === null) throw new Error('target and stopLoss must both be set (HighLow exits at the target or the stop)');
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${head} -> ${right} but ${e?.message ?? e} - not trading`);
            return;
        }
        const strike = this.atmStrike(niftyLtp);
        Log.log(`[${this.logTag}] ${head} -> BUY ${right} ${strike}`);
        await this.startCycle(key, { index: 'NIFTY', strike, right }, (b) => investmentForBroker(this.cfg() as any, b), async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp);
        });
    }

    // `quantity` when set (fixed lots), else whole lots that fit the broker's rupee budget at the option's price.
    protected sizeOrder(budget: number, price: number, index: 'NIFTY' | 'SENSEX'): number {
        const hasQty = (this.cfg() as any).quantity !== undefined && (this.cfg() as any).quantity !== null;
        if (hasQty) return super.sizeOrder(budget, price, index);
        const lot = INDEX_LOT_SIZE.NIFTY;
        if (!(price > 0) || !(budget > 0)) return 0;
        return Math.floor(budget / (price * lot)) * lot;
    }

    protected checkpointExit(): boolean {
        return true;
    }
}
