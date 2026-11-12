import { localDayKey } from '../../strategy/dayKey';
import regression from 'regression';
import { PeriodicStats } from '../../model/model';
import { buildCandle } from '../../lib/candle-builder';
import { calcRSI, calcRSIReversed, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic } from '../../lib/indicators';
import { RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from '../../lib/indicator-config';

// Live-pipeline port of decision.ts's _emitPrice/_computeAndEmitStats (the
// only interval decision.ts itself actually runs today - decision.ts:314,
// "5-min only - matches pipeline --interval 300"). decision.ts's own stats
// pipeline is unreachable in live trading (Decision is only ever
// instantiated inside GET /replay with replayMode forced true). This module
// has none of decision.ts's Prism/Mongo/child_process baggage - matches
// strategiesProcess.ts's own "no Prism/Kite dependency at all" design.
//
// createStatsBuilder(bucketSeconds) gives an independent builder for any interval (the backtest uses 300/900/1800). The module-level
// record()/reset() are the live 300-second builder and are unchanged.

const LIVE_BUCKET_SECONDS = 300;

function determineTrend(prices: number[]): string {
    const data = prices.map((price, index) => [index, price]);
    const result = regression.linear(data as [number, number][]);
    const slope = result.equation[0];
    if (slope > 0) return 'Up';
    if (slope < 0) return 'Down';
    return 'Sideways';
}

// `ltt` is epoch seconds (matches decision.ts's parseInt(quote.ltt) usage).
function dayOf(epochSeconds: number): string {
    return localDayKey(new Date(epochSeconds * 1000));
}

export interface StatsBuilder {
    record(ltp: number, ltt: number): { oldStats: PeriodicStats | null; newStats: PeriodicStats } | null;
    reset(): void;
    // The close of every completed (or seeded) candle, oldest first. A copy.
    closes(): number[];
    // Loads already-completed candles (oldest first) as history, so indicators that need many candles (a 50 EMA) work from the first live
    // candle. The last seeded candle becomes the "previous" candle of the first live one. Replaces any earlier history.
    seed(candles: SeedCandle[]): void;
}

export interface SeedCandle { time: number; open: number; high: number; low: number; close: number }

export interface StatsBuilderOptions {
    // true: buckets start on clock boundaries (epoch multiples of bucketSeconds, which for 900 are IST 09:15, 09:30, ...) and the tick that
    // crosses a boundary belongs to the NEW candle. false (default, every existing caller): a bucket starts at its first tick and closes on
    // the first tick at least bucketSeconds later, which then drifts the next bucket's start (decision.ts's algorithm).
    aligned?: boolean;
}

// Returns a builder with its own state. record() returns a stats update only when a tick closes a bucket, otherwise null.
export function createStatsBuilder(bucketSeconds: number, options: StatsBuilderOptions = {}): StatsBuilder {
    const aligned = options.aligned === true;
    let startTime: number | null = null;
    let bucket: number[] = [];
    const closes: number[] = []; // one entry per completed bucket, grows for the session (matches decision.ts's candlesMap-derived `prices` array)
    let previousStats: PeriodicStats | null = null;

    // Test/rollover hook: forget every bucket, close and previous-stats so the next tick starts fresh.
    function reset(): void {
        startTime = null;
        bucket = [];
        closes.length = 0;
        previousStats = null;
    }

    function record(ltp: number, ltt: number): { oldStats: PeriodicStats | null; newStats: PeriodicStats } | null {
        // A bad tick (NaN ltt from parseInt of a missing/garbled field, zero/NaN ltp) must never reach the bucket:
        // a NaN startTime would make every later `diff >= bucketSeconds` comparison false and freeze stats for the session.
        if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(ltt) || ltt <= 0) return null;
        // Day rollover (process left running overnight): yesterday's closes/bucket must not feed today's indicators.
        if (startTime !== null && dayOf(ltt) !== dayOf(startTime)) reset();
        // A tick older than the bucket start (out-of-order/replayed) would corrupt the bucket's time base.
        if (startTime !== null && ltt < startTime) return null;
        if (startTime === null) {
            startTime = aligned ? Math.floor(ltt / bucketSeconds) * bucketSeconds : ltt;
        }

        // Aligned: the tick that crosses the boundary starts the next candle, it is not part of the one it closes.
        if (aligned && bucket.length > 0 && ltt - startTime >= bucketSeconds) {
            const closing = completeBucket(startTime);
            startTime = Math.floor(ltt / bucketSeconds) * bucketSeconds;
            bucket = [ltp];
            return closing;
        }

        bucket.push(ltp);
        if (aligned) return null;
        const diff = ltt - startTime;
        if (!(diff >= bucketSeconds && bucket.length >= 2)) {
            return null;
        }

        const result = completeBucket(startTime);
        startTime = ltt;
        bucket = [];
        return result;
    }

    // Builds the candle for the current bucket, appends its close and returns the stats update. Does not touch startTime/bucket.
    function completeBucket(candleStart: number): { oldStats: PeriodicStats | null; newStats: PeriodicStats } {
        const candle = buildCandle(bucket, candleStart);
        closes.push(candle.close);

        // decision.ts:520-521 builds highs/lows from each completed candle's own
        // high/low, not from closes - this port uses closes for highs/lows too as
        // a deliberate simplification (only affects ADX/Stochastic; RSI/MACD/EMA/
        // Bollinger, what RuleBasedStrategy actually configures per config.yml's
        // indicators: field today, only ever consume closes).
        const highs = closes;
        const lows = closes;

        const rsiResults = RSI_PARAMS.map(p => calcRSI(closes, p.period, p.overbought, p.oversold)).filter(Boolean);
        // Contrarian RSI (RSI_p_ob_os_REV): same periods, trend inverted by calcRSIReversed. Read by RuleBasedStrategy only.
        const rsiReversedResults = RSI_PARAMS.map(p => calcRSIReversed(closes, p.period, p.overbought, p.oversold)).filter(Boolean);
        const macdResults = MACD_PARAMS.map(p => calcMACD(closes, p.shortPeriod, p.longPeriod, p.signalPeriod)).filter(Boolean);
        const bollingerResults = BOLLINGER_PARAMS.map(p => calcBollinger(closes, p.period, p.numDeviations)).filter(Boolean);
        const emaResults = EMA_PARAMS.map(p => calcEMACrossover(closes, p.shortPeriod, p.longPeriod)).filter(Boolean);
        const adxResults = ADX_PARAMS.map(p => calcADX(highs, lows, closes, p.period)).filter(Boolean);
        const stochasticResults = STOCHASTIC_PARAMS.map(p => calcStochastic(highs, lows, closes, p.kPeriod, p.dPeriod)).filter(Boolean);

        const pivot = { S1: candle.S1 ?? 0, R1: candle.R1 ?? 0, S2: candle.S2 ?? 0, R2: candle.R2 ?? 0 };

        const results = {
            eventName: `priceUpdate_${bucketSeconds}`,
            macd: macdResults, rsi: rsiResults, rsiReversed: rsiReversedResults, bollinger: bollingerResults,
            ema: emaResults, adx: adxResults, stochastic: stochasticResults,
            pivot,
        };

        const newStats = new PeriodicStats(
            candle.open, candle.high, candle.low, candle.close,
            candle.average, candle.median, candle.stddev, candle.mad,
            determineTrend(closes), results
        );

        newStats.candleTime = candle.time;
        const oldStats = previousStats;
        previousStats = newStats;
        return { oldStats, newStats };
    }

    function seed(candles: SeedCandle[]): void {
        reset();
        for (const c of candles) {
            if (![c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0)) continue;
            closes.push(c.close);
            const mid = (c.high + c.low) / 2;
            previousStats = new PeriodicStats(c.open, c.high, c.low, c.close, mid, mid, 0, 0, 'Sideways', { eventName: `priceUpdate_${bucketSeconds}` } as any);
            (previousStats as any).time = c.time;
            previousStats.candleTime = c.time;
        }
    }

    return { record, reset, closes: () => closes.slice(), seed };
}

// The live 5-minute builder (used by strategiesProcess.ts).
const liveBuilder = createStatsBuilder(LIVE_BUCKET_SECONDS);
export const reset = liveBuilder.reset;
export const record = liveBuilder.record;
