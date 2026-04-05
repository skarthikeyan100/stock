/**
 * Shared candle builder — identical algorithm to Python CandleBuilder._build_interval.
 *
 * Boundary algorithm (candle_builder.py lines 77–96):
 *   startTime = ltt[0]                        (first tick's actual time — NOT clock-aligned)
 *   for each tick:
 *     bucket.push(price)                       (APPEND FIRST, then check)
 *     if t - startTime >= interval AND bucket.length >= 2:
 *       emit candle, startTime = t            (DRIFT to current tick — NOT fixed-width)
 *       bucket = []
 *   if bucket non-empty: emit final candle
 */

export interface CandleData {
    time: number;
    open: number;
    close: number;
    high: number;
    low: number;
    average: number;
    median: number;
    stddev: number;   // population std (divide by N, matches Python np.std())
    mad: number;
    S1: number;
    R1: number;
    S2: number;
    R2: number;
    rateOfChange: number;
    range: number;
    diff: number;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function mad(prices: number[]): number {
    const med = median(prices);
    const deviations = prices.map(p => Math.abs(p - med));
    return round2(median(deviations));
}

function populationStd(prices: number[]): number {
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
    return round2(Math.sqrt(variance));
}

function pivot(high: number, low: number, close: number): { S1: number; R1: number; S2: number; R2: number } {
    const P = (high + low + close) / 3;
    return {
        S1: round2(2 * P - high),
        R1: round2(2 * P - low),
        S2: round2(P - (high - low)),
        R2: round2(P + (high - low)),
    };
}

export function buildCandle(bucket: number[], startTime: number): CandleData {
    const open  = bucket[0];
    const close = bucket[bucket.length - 1];
    const high  = Math.max(...bucket);
    const low   = Math.min(...bucket);
    const avg   = round2(bucket.reduce((s, p) => s + p, 0) / bucket.length);
    const med   = round2(median(bucket));
    const std   = populationStd(bucket);
    const madVal = mad(bucket);
    const piv   = pivot(high, low, close);
    const roc   = open !== 0 ? round2((close - open) / open * 100) : 0;

    return {
        time: startTime,
        open, close, high, low,
        average: avg,
        median: med,
        stddev: std,
        mad: madVal,
        ...piv,
        rateOfChange: roc,
        range: round2(high - low),
        diff: round2(close - open),
    };
}

export function buildCandles(
    quotes: Array<{ ltp: string | number; ltt: string | number }>,
    intervalSeconds: number
): CandleData[] {
    if (quotes.length === 0) return [];

    const candles: CandleData[] = [];
    let startTime = Number(quotes[0].ltt);
    let bucket: number[] = [];

    for (const q of quotes) {
        const t     = Number(q.ltt);
        const price = Number(q.ltp);

        // Append FIRST (matches Python: bucket_prices.append(ltp[i]) before boundary check)
        bucket.push(price);

        // Require >= 2 prices (matches Python: len(bucket_prices) >= 2)
        if (t - startTime >= intervalSeconds && bucket.length >= 2) {
            candles.push(buildCandle(bucket, startTime));
            // Drift to current tick (matches Python: start_time = ltt[i])
            startTime = t;
            bucket = [];
        }
    }

    if (bucket.length > 0) {
        candles.push(buildCandle(bucket, startTime));
    }

    return candles;
}
