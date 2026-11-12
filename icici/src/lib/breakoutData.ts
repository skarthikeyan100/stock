// Common model for the 15-minute breakout signal, shared by every strategy that needs it (NextWeekStrategy today).
// A candle is anything with open/high/low/close: a PeriodicStats from createStatsBuilder, a CandleData, or a row from yahooCandles.
// Wording follows the rest of the code: a signal is 'call' or 'put', the option type it buys.

export type Side = 'call' | 'put';

export interface OhlcCandle {
    open: number;
    high: number;
    low: number;
    close: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function isCompleteCandle(c: Partial<OhlcCandle> | null | undefined): c is OhlcCandle {
    return !!c && finite(c.open) && finite(c.high) && finite(c.low) && finite(c.close);
}

export class BreakoutData {
    // c1 is the earlier candle, c2 the one that just closed.
    //   call: c2 closes above its own open AND above c1's high.
    //   put:  c2 closes below its own open AND below c1's low.
    // Anything else (inside c1's range, a doji, a missing or non-numeric candle) is no signal.
    static from(c1: Partial<OhlcCandle> | null | undefined, c2: Partial<OhlcCandle> | null | undefined): Side | undefined {
        if (!isCompleteCandle(c1) || !isCompleteCandle(c2)) return undefined;
        if (c2.close > c2.open && c2.close > c1.high) return 'call';
        if (c2.close < c2.open && c2.close < c1.low) return 'put';
        return undefined;
    }
}

// Which side of VWAP a price is on: above is 'call', below is 'put', equal (or an unusable number) is no signal.
export function sideVsVwap(price: number, vwap: number): Side | undefined {
    if (!finite(price) || !finite(vwap) || !(price > 0) || !(vwap > 0)) return undefined;
    if (price > vwap) return 'call';
    if (price < vwap) return 'put';
    return undefined;
}

// Trend side from a moving average: price above it is 'call', below is 'put', equal is no signal.
export function sideVsAverage(price: number, average: number): Side | undefined {
    if (!finite(price) || !finite(average) || !(price > 0) || !(average > 0)) return undefined;
    if (price > average) return 'call';
    if (price < average) return 'put';
    return undefined;
}
