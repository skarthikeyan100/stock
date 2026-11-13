import Log from '../util/Log';

// Fail-safe handling of a non-finite P&L in the max-profit / max-loss trip decisions (2026-11-13).
// In JS every comparison with NaN is false, so `if (total < cap) return;` FALLS THROUGH on NaN and trips: a single bad tick or a leg with a
// non-numeric entry/pnlRef/quantity would latch the strategy for the day and close real positions. Rules, used by every trip site:
//   1. a trip is `total >= cap` (or `pnl <= -threshold`) guarded by Number.isFinite(total); never the negation of `<`;
//   2. a leg whose own fields are unusable is SKIPPED in the total (counts 0, exactly like a leg with no tick yet) and reported, so one bad
//      leg neither poisons the sum nor blocks the good legs; if the total is still non-finite (e.g. realizedPnl is NaN) nothing trips;
//   3. the report is ONE ALERT line per key per ALERT_INTERVAL_MS (the checks run on every tick).

export const NON_FINITE_ALERT_INTERVAL_MS = 10 * 60 * 1000;

export class NonFiniteAlert {
    private last = new Map<string, number>();
    constructor(private intervalMs = NON_FINITE_ALERT_INTERVAL_MS) {}
    // Logs `message` unless this key already alerted within the interval. Returns true when a line was written.
    report(key: string, message: string, now = Date.now()): boolean {
        const prev = this.last.get(key);
        if (prev !== undefined && now - prev < this.intervalMs) return false;
        this.last.set(key, now);
        Log.log(`ALERT: ${message}`);
        return true;
    }
}

export interface PnlLegView {
    id: string;
    remaining: number;
    lastLtp: unknown;
    ref: unknown;          // pnlRef ?? entry
    pending?: boolean;     // still waiting for its reference tick
}

// Which field of a leg makes it unusable for P&L, or null when it is fine. A leg with no positive tick is not "bad": it simply has none yet.
export function badFieldOf(l: PnlLegView): string | null {
    if (!Number.isFinite(Number(l.remaining))) return `remaining=${String(l.remaining)}`;
    if (l.ref === undefined || l.ref === null || !Number.isFinite(Number(l.ref))) return `entry/pnlRef=${String(l.ref)}`;
    return null;
}

// realized + sum over open legs of remaining x (lastLtp - ref). A leg waiting for its reference tick, or with no positive tick, counts 0; a leg
// with an unusable field counts 0 and is reported. May still return a non-finite value (realized itself bad): the caller must not trip on it.
export function profitTotalOf(owner: string, realized: number, legs: PnlLegView[], alert: NonFiniteAlert): number {
    let total = realized;
    const bad: string[] = [];
    for (const l of legs) {
        if (l.pending) continue;
        const ltp = Number(l.lastLtp);
        if (l.lastLtp !== undefined && l.lastLtp !== null && !Number.isFinite(ltp)) { bad.push(`${l.id}: lastLtp=${String(l.lastLtp)}`); continue; }
        if (!(ltp > 0)) continue;
        const field = badFieldOf(l);
        if (field) { bad.push(`${l.id}: ${field}`); continue; }
        total += l.remaining * (ltp - Number(l.ref));
    }
    if (bad.length) alert.report(`${owner}:legs`, `[${owner}] non-finite P&L input, leg(s) skipped from the max-profit total (they count 0): ${bad.join('; ')}`);
    return total;
}

// The one trip test. False for a non-finite total, with a throttled alert.
export function shouldTrip(owner: string, total: number, cap: number, alert: NonFiniteAlert): boolean {
    if (!Number.isFinite(total)) {
        alert.report(`${owner}:total`, `[${owner}] max-profit total is ${String(total)} (realized or a leg is not a number) - NOT tripping, NOT closing anything`);
        return false;
    }
    return total >= cap;
}
