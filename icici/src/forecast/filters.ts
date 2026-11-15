/**
 * The owner's filters for a Beginner forecast (spec v2.1 section 8): Filter.evaluate(context) -> pass/fail + reason + values. BOTH filters
 * are always applied, and the engine refuses to run without the order-book filter. Pure; the depth and candle data are passed in.
 */
import { Candle, DEFAULT_TREND, TrendParams, evaluateTrend } from './candles';

export type Direction = 'UP' | 'DOWN';
export interface DepthSnapshot { buyQty: number; sellQty: number; ts: number /* ms, when the exchange/feed produced it */; instrument: string }
export interface FilterContext { direction: Direction; nowMs: number; depth: DepthSnapshot | null; candles: Candle[] }
export interface FilterResult { name: string; pass: boolean; reason: string; values: Record<string, unknown> }
export interface Filter { readonly name: string; evaluate(ctx: FilterContext): FilterResult }

export interface OrderBookParams { upRatio: number; downRatio: number; maxAgeMs: number }
export const DEFAULT_ORDER_BOOK: OrderBookParams = { upRatio: 1.2, downRatio: 1.2, maxAgeMs: 3000 };

/** UP passes if buyQty/sellQty >= upRatio; DOWN passes if sellQty/buyQty >= downRatio; a snapshot older than maxAgeMs (or missing) rejects. */
export class OrderBookImbalanceFilter implements Filter {
    readonly name = 'OrderBookImbalance';
    constructor(private readonly p: OrderBookParams = DEFAULT_ORDER_BOOK) {}
    evaluate(ctx: FilterContext): FilterResult {
        const d = ctx.depth;
        const base = { threshold: ctx.direction === 'UP' ? this.p.upRatio : this.p.downRatio };
        if (!d) return { name: this.name, pass: false, reason: 'no depth snapshot', values: base };
        const ageMs = ctx.nowMs - d.ts;
        const common = { ...base, buyQty: d.buyQty, sellQty: d.sellQty, snapshotTs: d.ts, ageMs, instrument: d.instrument };
        if (!(d.buyQty > 0 && d.sellQty > 0)) return { name: this.name, pass: false, reason: 'depth quantities are not positive', values: common };
        if (ageMs > this.p.maxAgeMs || ageMs < -1000) return { name: this.name, pass: false, reason: `snapshot is ${ageMs} ms old (limit ${this.p.maxAgeMs})`, values: common };
        const ratio = ctx.direction === 'UP' ? d.buyQty / d.sellQty : d.sellQty / d.buyQty;
        const pass = ratio >= base.threshold;
        return { name: this.name, pass, reason: pass ? `ratio ${ratio.toFixed(3)} >= ${base.threshold}` : `ratio ${ratio.toFixed(3)} < ${base.threshold}`, values: { ...common, ratio } };
    }
}

export class TrendFilter implements Filter {
    readonly name = 'Trend1m';
    constructor(private readonly p: TrendParams = DEFAULT_TREND) {}
    evaluate(ctx: FilterContext): FilterResult {
        const closed = ctx.candles.filter((c) => c.t + 60_000 <= ctx.nowMs);
        const r = evaluateTrend(ctx.direction, closed, ctx.nowMs, this.p);
        return { name: this.name, pass: r.pass, reason: r.reason, values: { ...r.values, emaPeriod: this.p.emaPeriod } };
    }
}

export interface Decision { accepted: boolean; results: FilterResult[]; reason: string }

/** Every filter runs (no short-circuit, so the log shows all inputs); the forecast is accepted only if all pass. */
export function evaluateAll(filters: Filter[], ctx: FilterContext): Decision {
    const results = filters.map((f) => { try { return f.evaluate(ctx); } catch (e: any) { return { name: f.name, pass: false, reason: `filter error: ${e?.message ?? e}`, values: {} }; } });
    const failed = results.filter((r) => !r.pass);
    return { accepted: failed.length === 0, results, reason: failed.length ? failed.map((r) => `${r.name}: ${r.reason}`).join('; ') : 'all filters passed' };
}

/** The engine must not be configurable as a pass-through: it refuses to start without the order-book filter (and a trend filter). */
export function assertEngineFilters(filters: Filter[]): void {
    if (!filters.some((f) => f instanceof OrderBookImbalanceFilter)) throw new Error('forecast engine refuses to start: the order-book imbalance filter is not enabled');
    if (!filters.some((f) => f instanceof TrendFilter)) throw new Error('forecast engine refuses to start: the trend filter is not enabled');
}

/** Rolling rejection-rate alarm: fires when fewer than minRate of the last `window` evaluated forecasts were rejected (a pass-through in effect). Never lowers anything. */
export class PassThroughAlarm {
    private recent: boolean[] = []; // true = rejected
    constructor(private readonly window = 30, private readonly minRate = 0.1) {}
    record(rejected: boolean): void { this.recent.push(rejected); if (this.recent.length > this.window) this.recent.shift(); }
    rate(): number | null { return this.recent.length < this.window ? null : this.recent.filter(Boolean).length / this.recent.length; }
    firing(): boolean { const r = this.rate(); return r !== null && r < this.minRate; }
}
