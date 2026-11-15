/** 1-minute candles from NIFTY ticks, EMA, and the trend filter's maths (spec v2.1 section 8, filter 2). Pure. */
export interface Candle { t: number /* minute start, ms */; o: number; h: number; l: number; c: number }

export class CandleBuilder {
    private candles: Candle[] = [];
    constructor(private readonly keep = 200) {}
    /** Feed a tick (any order within the current minute; a tick from an older minute is ignored). */
    add(tsMs: number, price: number): void {
        if (!Number.isFinite(price) || !Number.isFinite(tsMs)) return;
        const t = Math.floor(tsMs / 60_000) * 60_000;
        const last = this.candles[this.candles.length - 1];
        if (!last || t > last.t) {
            // a gap leaves no candle for the empty minutes: the trend rules only look at consecutive CLOSED candles that exist
            this.candles.push({ t, o: price, h: price, l: price, c: price });
            if (this.candles.length > this.keep) this.candles.shift();
        } else if (t === last.t) {
            last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price;
        }
    }
    /** Candles whose minute has ended by `nowMs` (the forming candle is excluded). */
    closed(nowMs: number): Candle[] { return this.candles.filter((x) => x.t + 60_000 <= nowMs); }
    all(): Candle[] { return this.candles.slice(); }
}

/** Exponential moving average of `values` (oldest first) with the standard 2/(n+1) factor, seeded with the first value. */
export function ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const out: number[] = [];
    values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
    return out;
}

export interface TrendParams { emaPeriod: number; minCandles: number; maxStaleMinutes: number }
export const DEFAULT_TREND: TrendParams = { emaPeriod: 9, minCandles: 10, maxStaleMinutes: 2 };

export interface TrendResult { pass: boolean; reason: string; values: { close?: number; ema?: number; emaPrev?: number; candles: number; lastCandleAgeMin?: number } }

/**
 * UP passes if the last CLOSED candle closes above the EMA of closes AND that EMA is rising (vs the previous candle); DOWN is the mirror.
 * Fails closed when there are too few candles or the newest closed candle is stale.
 */
export function evaluateTrend(direction: 'UP' | 'DOWN', candles: Candle[], nowMs: number, p: TrendParams = DEFAULT_TREND): TrendResult {
    if (candles.length < p.minCandles) return { pass: false, reason: `only ${candles.length} candles (need ${p.minCandles})`, values: { candles: candles.length } };
    const last = candles[candles.length - 1];
    const ageMin = (nowMs - (last.t + 60_000)) / 60_000;
    if (ageMin > p.maxStaleMinutes) return { pass: false, reason: `newest closed candle is ${ageMin.toFixed(1)} min old`, values: { candles: candles.length, lastCandleAgeMin: ageMin } };
    const e = ema(candles.map((x) => x.c), p.emaPeriod);
    const cur = e[e.length - 1], prev = e[e.length - 2];
    const up = last.c > cur && cur > prev;
    const down = last.c < cur && cur < prev;
    const pass = direction === 'UP' ? up : down;
    return { pass, reason: pass ? 'trend agrees' : `close ${last.c} vs EMA${p.emaPeriod} ${cur.toFixed(2)} (prev ${prev.toFixed(2)}) does not support ${direction}`, values: { close: last.c, ema: cur, emaPrev: prev, candles: candles.length, lastCandleAgeMin: ageMin } };
}
