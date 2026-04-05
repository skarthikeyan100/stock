/**
 * Central parameter lists for all indicators.
 * Single source of truth used by both decision.ts (server) and analyze.ts (analysis).
 * Matches analysis/config.py exactly.
 */

export const INTERVALS = [60, 300, 600, 900, 1200, 1800];

export const INTERVAL_LABELS: Record<number, string> = {
    60:   '1min',
    300:  '5min',
    600:  '10min',
    900:  '15min',
    1200: '20min',
    1800: '30min',
};

// RSI: 7 periods × 3 threshold pairs = 21 combos
export const RSI_PARAMS: Array<{ period: number; overbought: number; oversold: number }> = [
    { period:  5, overbought: 70, oversold: 30 },
    { period:  5, overbought: 80, oversold: 20 },
    { period:  5, overbought: 90, oversold: 10 },
    { period: 10, overbought: 70, oversold: 30 },
    { period: 10, overbought: 80, oversold: 20 },
    { period: 10, overbought: 90, oversold: 10 },
    { period: 14, overbought: 70, oversold: 30 },
    { period: 14, overbought: 80, oversold: 20 },
    { period: 14, overbought: 90, oversold: 10 },
    { period: 15, overbought: 70, oversold: 30 },
    { period: 15, overbought: 80, oversold: 20 },
    { period: 15, overbought: 90, oversold: 10 },
    { period: 20, overbought: 70, oversold: 30 },
    { period: 20, overbought: 80, oversold: 20 },
    { period: 20, overbought: 90, oversold: 10 },
    { period: 25, overbought: 70, oversold: 30 },
    { period: 25, overbought: 80, oversold: 20 },
    { period: 25, overbought: 90, oversold: 10 },
    { period: 30, overbought: 70, oversold: 30 },
    { period: 30, overbought: 80, oversold: 20 },
    { period: 30, overbought: 90, oversold: 10 },
];

// MACD: 6 combos
export const MACD_PARAMS: Array<{ shortPeriod: number; longPeriod: number; signalPeriod: number }> = [
    { shortPeriod:  4, longPeriod:  8, signalPeriod:  3 },
    { shortPeriod:  8, longPeriod: 16, signalPeriod:  6 },
    { shortPeriod: 12, longPeriod: 24, signalPeriod:  9 },
    { shortPeriod: 12, longPeriod: 26, signalPeriod:  9 },
    { shortPeriod: 16, longPeriod: 32, signalPeriod: 12 },
    { shortPeriod: 20, longPeriod: 40, signalPeriod: 15 },
    { shortPeriod: 24, longPeriod: 48, signalPeriod: 18 },
];

// EMA Crossover: 9 combos
export const EMA_PARAMS: Array<{ shortPeriod: number; longPeriod: number }> = [
    { shortPeriod:  5, longPeriod: 13 },
    { shortPeriod:  9, longPeriod: 21 },
    { shortPeriod: 12, longPeriod: 28 },
    { shortPeriod: 15, longPeriod: 35 },
    { shortPeriod: 18, longPeriod: 42 },
    { shortPeriod: 21, longPeriod: 49 },
    { shortPeriod: 24, longPeriod: 56 },
    { shortPeriod: 27, longPeriod: 63 },
    { shortPeriod: 30, longPeriod: 70 },
];

// Bollinger Bands: 6 periods × 3 deviations = 18 combos
export const BOLLINGER_PARAMS: Array<{ period: number; numDeviations: number }> = [
    { period:  5, numDeviations: 1   },
    { period:  5, numDeviations: 1.5 },
    { period:  5, numDeviations: 2   },
    { period: 10, numDeviations: 1   },
    { period: 10, numDeviations: 1.5 },
    { period: 10, numDeviations: 2   },
    { period: 15, numDeviations: 1   },
    { period: 15, numDeviations: 1.5 },
    { period: 15, numDeviations: 2   },
    { period: 20, numDeviations: 1   },
    { period: 20, numDeviations: 1.5 },
    { period: 20, numDeviations: 2   },
    { period: 25, numDeviations: 1   },
    { period: 25, numDeviations: 1.5 },
    { period: 25, numDeviations: 2   },
    { period: 30, numDeviations: 1   },
    { period: 30, numDeviations: 1.5 },
    { period: 30, numDeviations: 2   },
];

// ADX: 2 combos
export const ADX_PARAMS: Array<{ period: number }> = [
    { period: 14 },
    { period: 20 },
];

// Stochastic: 2 combos
export const STOCHASTIC_PARAMS: Array<{ kPeriod: number; dPeriod: number }> = [
    { kPeriod: 14, dPeriod: 3 },
    { kPeriod: 14, dPeriod: 5 },
];
