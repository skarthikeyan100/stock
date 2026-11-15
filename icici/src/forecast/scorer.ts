/** Scoring of a forecast (spec v2.1 section 7). Pure. CORRECT / INCORRECT / NEUTRAL from the start and end index values; VOID when a reference tick is missing. */
export type Outcome = 'OPEN' | 'CORRECT' | 'INCORRECT' | 'NEUTRAL' | 'VOID';
export interface Tick { ts: number /* ms */; ltp: number }

/** The tick closest to targetMs within +/- toleranceMs, else null. Ticks need not be sorted. */
export function tickNear(ticks: Tick[], targetMs: number, toleranceMs = 5000): Tick | null {
    let best: Tick | null = null;
    for (const t of ticks) {
        const d = Math.abs(t.ts - targetMs);
        if (d <= toleranceMs && (best === null || d < Math.abs(best.ts - targetMs))) best = t;
    }
    return best;
}

export function scoreForecast(direction: 'UP' | 'DOWN', start: number | null, end: number | null, neutralThresholdPoints: number): Outcome {
    if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return 'VOID';
    const move = end - start;
    if (Math.abs(move) < neutralThresholdPoints) return 'NEUTRAL';
    return (direction === 'UP' ? move > 0 : move < 0) ? 'CORRECT' : 'INCORRECT';
}

export interface Forecast { direction: 'UP' | 'DOWN'; submittedAtMs: number; windowMinutes: number; neutralThresholdPoints: number }
/** Scores one forecast from the stored ticks: the start tick near submittedAt, the end tick near submittedAt + window (+/- 5 s each). */
export function scoreFromTicks(f: Forecast, ticks: Tick[], toleranceMs = 5000): { outcome: Outcome; start: Tick | null; end: Tick | null } {
    const start = tickNear(ticks, f.submittedAtMs, toleranceMs);
    const end = tickNear(ticks, f.submittedAtMs + f.windowMinutes * 60_000, toleranceMs);
    return { outcome: scoreForecast(f.direction, start?.ltp ?? null, end?.ltp ?? null, f.neutralThresholdPoints), start, end };
}
