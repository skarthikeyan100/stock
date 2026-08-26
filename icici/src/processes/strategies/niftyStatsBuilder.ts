import regression from 'regression';
import { PeriodicStats } from '../../model/model';
import { buildCandle } from '../../lib/candle-builder';
import { calcRSI, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic } from '../../lib/indicators';
import { RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from '../../lib/indicator-config';

// Live-pipeline port of decision.ts's _emitPrice/_computeAndEmitStats (the
// only interval decision.ts itself actually runs today - decision.ts:314,
// "5-min only - matches pipeline --interval 300"). decision.ts's own stats
// pipeline is unreachable in live trading (Decision is only ever
// instantiated inside GET /replay with replayMode forced true). This module
// has none of decision.ts's Prism/Mongo/child_process baggage - matches
// strategiesProcess.ts's own "no Prism/Zerodha dependency at all" design.

const BUCKET_SECONDS = 300;

let startTime: number | null = null;
let bucket: number[] = [];
const closes: number[] = []; // one entry per completed bucket, grows for the session (matches decision.ts's candlesMap-derived `prices` array)
let previousStats: PeriodicStats | null = null;

function determineTrend(prices: number[]): string {
    const data = prices.map((price, index) => [index, price]);
    const result = regression.linear(data as [number, number][]);
    const slope = result.equation[0];
    if (slope > 0) return 'Up';
    if (slope < 0) return 'Down';
    return 'Sideways';
}

// Call on every live NIFTY tick. `ltt` is epoch seconds (matches decision.ts's
// parseInt(quote.ltt) usage). Returns a stats update only when this tick
// closes a 300s bucket, otherwise null.
export function record(ltp: number, ltt: number): { oldStats: PeriodicStats | null; newStats: PeriodicStats } | null {
    if (startTime === null) {
        startTime = ltt;
    }

    bucket.push(ltp);
    const diff = ltt - startTime;
    if (!(diff >= BUCKET_SECONDS && bucket.length >= 2)) {
        return null;
    }

    const candle = buildCandle(bucket, startTime);
    closes.push(candle.close);

    // decision.ts:520-521 builds highs/lows from each completed candle's own
    // high/low, not from closes - this port uses closes for highs/lows too as
    // a deliberate simplification (only affects ADX/Stochastic; RSI/MACD/EMA/
    // Bollinger, what RuleBasedStrategy actually configures per config.yml's
    // indicators: field today, only ever consume closes).
    const highs = closes;
    const lows = closes;

    const rsiResults = RSI_PARAMS.map(p => calcRSI(closes, p.period, p.overbought, p.oversold)).filter(Boolean);
    const macdResults = MACD_PARAMS.map(p => calcMACD(closes, p.shortPeriod, p.longPeriod, p.signalPeriod)).filter(Boolean);
    const bollingerResults = BOLLINGER_PARAMS.map(p => calcBollinger(closes, p.period, p.numDeviations)).filter(Boolean);
    const emaResults = EMA_PARAMS.map(p => calcEMACrossover(closes, p.shortPeriod, p.longPeriod)).filter(Boolean);
    const adxResults = ADX_PARAMS.map(p => calcADX(highs, lows, closes, p.period)).filter(Boolean);
    const stochasticResults = STOCHASTIC_PARAMS.map(p => calcStochastic(highs, lows, closes, p.kPeriod, p.dPeriod)).filter(Boolean);

    const pivot = { S1: candle.S1 ?? 0, R1: candle.R1 ?? 0, S2: candle.S2 ?? 0, R2: candle.R2 ?? 0 };

    const results = {
        eventName: 'priceUpdate_300',
        macd: macdResults, rsi: rsiResults, bollinger: bollingerResults,
        ema: emaResults, adx: adxResults, stochastic: stochasticResults,
        pivot,
    };

    const newStats = new PeriodicStats(
        candle.open, candle.high, candle.low, candle.close,
        candle.average, candle.median, candle.stddev, candle.mad,
        determineTrend(closes), results
    );

    const oldStats = previousStats;
    previousStats = newStats;

    startTime = ltt;
    bucket = [];

    return { oldStats, newStats };
}
