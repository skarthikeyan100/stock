/**
 * Shared indicator engine — identical algorithms to Python analysis/indicators.py.
 *
 * All functions use seeded EMA (result[0] = prices[0]) instead of the
 * technicalindicators library, to match Python _ema() exactly.
 *
 * Population std is used for Bollinger (divide by N, matches Python np.std()).
 */

// ── Result types ──────────────────────────────────────────────────────────────

export interface RSIResult {
    header: string;
    period: number;
    overbought: number;
    oversold: number;
    value: number;
    trend: string;
}

export interface EMAResult {
    header: string;
    shortPeriod: number;
    longPeriod: number;
    trend: string;
}

export interface MACDResult {
    header: string;
    shortPeriod: number;
    longPeriod: number;
    signalPeriod: number;
    macd: number;
    signal: number;
    trend: string;
}

export interface BollingerResult {
    header: string;
    period: number;
    numDeviations: number;
    upper: number;
    middle: number;
    lower: number;
    stdDev: number;
    trend: string;
}

export interface ADXResult {
    header: string;
    period: number;
    trend: string;
}

export interface StochasticResult {
    header: string;
    kPeriod: number;
    dPeriod: number;
    trend: string;
}

// ── Name helpers (match Python column names) ──────────────────────────────────

export function rsiName(period: number, ob: number, os: number): string {
    return `RSI_${period}_${ob}_${os}`;
}

export function emaName(short: number, long: number): string {
    return `EMA_${short}_${long}`;
}

export function macdName(s: number, l: number, sig: number): string {
    return `MACD_${s}_${l}_${sig}`;
}

export function bollingerName(period: number, dev: number): string {
    return `Bollinger_${period}_${dev}`;
}

export function adxName(period: number): string {
    return `ADX_${period}`;
}

export function stochasticName(k: number, d: number): string {
    return `Stoch_${k}_${d}`;
}

export function rsiNameReversed(period: number, ob: number, os: number): string {
    return `RSI_${period}_${ob}_${os}_REV`;
}

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Seeded EMA — result[0] = prices[0], then exponential smoothing.
 * Matches Python _ema() in indicators.py exactly.
 */
export function seededEMA(prices: number[], period: number): number[] {
    const mult = 2 / (period + 1);
    const result = new Array<number>(prices.length);
    result[0] = prices[0];
    for (let i = 1; i < prices.length; i++) {
        result[i] = (prices[i] - result[i - 1]) * mult + result[i - 1];
    }
    return result;
}

// ── RSI (Wilder smoothing) ────────────────────────────────────────────────────

/**
 * Matches Python rsi_trend() in indicators.py.
 * Manual Wilder smoothing: seed with simple average, then iterate.
 */
export function calcRSI(
    closes: number[],
    period: number,
    overbought: number,
    oversold: number
): RSIResult | null {
    if (closes.length < period + 1) return null;

    const deltas: number[] = [];
    for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);

    const gains  = deltas.map(d => d > 0 ? d : 0);
    const losses = deltas.map(d => d < 0 ? -d : 0);

    let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    const value = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    const trend = value > overbought ? 'DOWN' : value < oversold ? 'UP' : 'NEUTRAL';

    return { header: rsiName(period, overbought, oversold), period, overbought, oversold, value, trend };
}

// ── RSI Reversed (contrarian) ─────────────────────────────────────────────────

/**
 * Matches Python rsi_trend_reversed() in indicators.py.
 * Uses simple mean RSI (NOT Wilder smoothing) over the last `period` bars.
 * Reversed interpretation: overbought → UP (buy strength), oversold → DOWN.
 */
export function calcRSIReversed(
    closes: number[],
    period: number,
    overbought: number,
    oversold: number
): RSIResult | null {
    if (closes.length < period + 1) return null;

    // Simple mean over last `period` deltas (matches Python rsi_trend_reversed)
    let totalGain = 0, totalLoss = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const delta = closes[i] - closes[i - 1];
        if (delta > 0) totalGain += delta;
        else            totalLoss += -delta;
    }

    const avgGain = totalGain / period;
    const avgLoss = totalLoss / period;

    // No losses = strong uptrend → contrarian buy signal
    if (avgLoss === 0) {
        return { header: rsiNameReversed(period, overbought, oversold), period, overbought, oversold, value: 100, trend: 'UP' };
    }

    const value = 100 - (100 / (1 + avgGain / avgLoss));
    // REVERSED: overbought → UP, oversold → DOWN (contrarian)
    const trend = value > overbought ? 'UP' : value < oversold ? 'DOWN' : 'NEUTRAL';

    return { header: rsiNameReversed(period, overbought, oversold), period, overbought, oversold, value, trend };
}

// ── EMA Crossover ─────────────────────────────────────────────────────────────

/**
 * Matches Python ema_crossover_trend() in indicators.py.
 * Slices to longPeriod, scans for first crossover event.
 */
export function calcEMACrossover(
    closes: number[],
    shortPeriod: number,
    longPeriod: number
): EMAResult | null {
    if (closes.length < longPeriod) return null;

    const prices = closes.slice(-longPeriod);
    const shortEMA = seededEMA(prices, shortPeriod);
    const longEMA  = seededEMA(prices, longPeriod);

    let trend = 'NEUTRAL';
    for (let i = 1; i < prices.length; i++) {
        if (shortEMA[i - 1] <= longEMA[i - 1] && shortEMA[i] > longEMA[i]) {
            trend = 'UP';
            break;
        }
        if (shortEMA[i - 1] >= longEMA[i - 1] && shortEMA[i] < longEMA[i]) {
            trend = 'DOWN';
            break;
        }
    }

    return { header: emaName(shortPeriod, longPeriod), shortPeriod, longPeriod, trend };
}

// ── MACD ──────────────────────────────────────────────────────────────────────

/**
 * Matches Python macd_trend() in indicators.py.
 * Uses seeded EMA on the SAME array (totalNeeded prices), element-wise subtraction.
 */
export function calcMACD(
    closes: number[],
    shortPeriod: number,
    longPeriod: number,
    signalPeriod: number
): MACDResult | null {
    const totalNeeded = signalPeriod + longPeriod;
    if (closes.length < totalNeeded) return null;

    const prices    = closes.slice(-totalNeeded);
    const shortEMA  = seededEMA(prices, shortPeriod);
    const longEMA   = seededEMA(prices, longPeriod);
    const macdLine  = shortEMA.map((v, i) => v - longEMA[i]);
    const signalLine = seededEMA(macdLine, signalPeriod);

    const macd   = macdLine[macdLine.length - 1];
    const signal = signalLine[signalLine.length - 1];
    const trend  = macd > signal ? 'UP' : 'DOWN';

    return {
        header: macdName(shortPeriod, longPeriod, signalPeriod),
        shortPeriod, longPeriod, signalPeriod,
        macd: Math.round(macd * 100) / 100,
        signal: Math.round(signal * 100) / 100,
        trend,
    };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

/**
 * Matches Python bollinger_trend() in indicators.py.
 * Population std (divide by N, not N-1) to match Python np.std().
 */
export function calcBollinger(
    closes: number[],
    period: number,
    numDeviations: number
): BollingerResult | null {
    if (closes.length < period) return null;

    const prices  = closes.slice(-period);
    const sma     = prices.reduce((s, p) => s + p, 0) / period;
    const variance = prices.reduce((s, p) => s + Math.pow(p - sma, 2), 0) / period;
    const stdDev  = Math.round(Math.sqrt(variance) * 100) / 100;
    const upper   = Math.round((sma + stdDev * numDeviations) * 100) / 100;
    const lower   = Math.round((sma - stdDev * numDeviations) * 100) / 100;
    const middle  = Math.round(sma * 100) / 100;
    const latest  = prices[prices.length - 1];
    const trend   = latest > upper ? 'UP' : latest < lower ? 'DOWN' : 'NEUTRAL';

    return {
        header: bollingerName(period, numDeviations),
        period, numDeviations,
        upper, middle, lower, stdDev,
        trend,
    };
}

// ── ADX ───────────────────────────────────────────────────────────────────────

/**
 * Matches Python adx_trend() in indicators.py.
 * Wilder-smoothed ATR, +DM, -DM; ADX = smoothed DX.
 */
export function calcADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): ADXResult | null {
    const n = closes.length;
    if (n < period * 2) return null;

    const tr: number[]      = [];
    const plusDM: number[]  = [];
    const minusDM: number[] = [];

    for (let i = 1; i < n; i++) {
        tr.push(Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        ));
        const upMove   = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const len = tr.length;
    const atr    = new Array<number>(len).fill(0);
    const sPlus  = new Array<number>(len).fill(0);
    const sMinus = new Array<number>(len).fill(0);

    atr[period - 1]    = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    sPlus[period - 1]  = plusDM.slice(0, period).reduce((s, v) => s + v, 0) / period;
    sMinus[period - 1] = minusDM.slice(0, period).reduce((s, v) => s + v, 0) / period;

    for (let i = period; i < len; i++) {
        atr[i]    = (atr[i - 1] * (period - 1) + tr[i]) / period;
        sPlus[i]  = (sPlus[i - 1] * (period - 1) + plusDM[i]) / period;
        sMinus[i] = (sMinus[i - 1] * (period - 1) + minusDM[i]) / period;
    }

    const plusDI  = atr.map((a, i) => a !== 0 ? 100 * sPlus[i] / a : 0);
    const minusDI = atr.map((a, i) => a !== 0 ? 100 * sMinus[i] / a : 0);
    const dx      = plusDI.map((p, i) => {
        const sum = p + minusDI[i];
        return sum !== 0 ? 100 * Math.abs(p - minusDI[i]) / sum : 0;
    });

    const adxVals = new Array<number>(dx.length).fill(0);
    const start   = 2 * period - 1;
    if (start >= dx.length) return null;

    adxVals[start] = dx.slice(period, start + 1).reduce((s, v) => s + v, 0) / (start - period + 1);
    for (let i = start + 1; i < dx.length; i++) {
        adxVals[i] = (adxVals[i - 1] * (period - 1) + dx[i]) / period;
    }

    const latestADX   = adxVals[adxVals.length - 1];
    const latestPlus  = plusDI[plusDI.length - 1];
    const latestMinus = minusDI[minusDI.length - 1];

    let trend: string;
    if (latestADX < 20)              trend = 'NEUTRAL';
    else if (latestPlus > latestMinus) trend = 'UP';
    else                               trend = 'DOWN';

    return { header: adxName(period), period, trend };
}

// ── Stochastic ────────────────────────────────────────────────────────────────

/**
 * Matches Python stochastic_trend() in indicators.py.
 * %K = (close - lowest) / (highest - lowest) * 100; %D = SMA of %K.
 */
export function calcStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    kPeriod: number,
    dPeriod: number
): StochasticResult | null {
    const n = closes.length;
    if (n < kPeriod + dPeriod) return null;

    const kValues: number[] = [];
    for (let i = kPeriod - 1; i < n; i++) {
        const highest = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
        const lowest  = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
        kValues.push(highest === lowest ? 50 : 100 * (closes[i] - lowest) / (highest - lowest));
    }

    const dValues: number[] = [];
    for (let i = dPeriod - 1; i < kValues.length; i++) {
        dValues.push(kValues.slice(i - dPeriod + 1, i + 1).reduce((s, v) => s + v, 0) / dPeriod);
    }

    const latestK = kValues[kValues.length - 1];
    const latestD = dValues.length > 0 ? dValues[dValues.length - 1] : latestK;

    let trend: string;
    if (latestK < 20 && latestK > latestD)      trend = 'UP';
    else if (latestK > 80 && latestK < latestD) trend = 'DOWN';
    else                                          trend = 'NEUTRAL';

    return { header: stochasticName(kPeriod, dPeriod), kPeriod, dPeriod, trend };
}
