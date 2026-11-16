// Half-at-target + trail exit for ONE leg. Pure decision logic (no orders, no I/O); LimitEntryStrategy places the orders.
//
//   - Half of the quantity (whole lots, floor(lots / 2)) is sold at the target by a resting limit sell. The WHOLE leg is protected by the tick stop meanwhile.
//   - Once that sell has filled (soldQty >= halfQty) the stop is dropped and the rest trails: TrailStop armed at the target, exit level
//     max(target, peak - dist), so the trailed part never sells below the target price.
//   - Fewer than 2 lots cannot be halved: splitLots answers null and the caller uses its normal target / stop exit (trailing is not engaged).
// The mode (dist, halfQty) is fixed on the leg when its exit is placed, so a config change never flips a live position.
import { TrailStop, TrailState } from './TrailStop';

export interface HalfTrailState {
    halfQty: number;        // quantity sold at the target
    targetPrice: number;    // price the half rests at, and the floor of the trail
    dist: number;           // points below the peak that end the trailed part
    phase: 'half' | 'trail';
    sellQty?: number;       // quantity the resting target sell covers, set BEFORE the order goes out (a retry never doubles it)
    trail?: TrailState;     // persisted peak of the trailed part
}

// null when the quantity is not at least two whole lots.
export function splitLots(qty: number, lot: number): { halfQty: number; trailQty: number } | null {
    if (!(lot > 0) || !Number.isInteger(qty) || qty <= 0 || qty % lot !== 0) return null;
    const lots = qty / lot;
    if (lots < 2) return null;
    const halfQty = Math.floor(lots / 2) * lot;
    return { halfQty, trailQty: qty - halfQty };
}

export type HalfTrailStep =
    | { action: 'hold'; switched: boolean; changed: boolean }
    | { action: 'exit'; switched: boolean; peak: number; exitLevel: number };

// One tick. Mutates `s` (phase / trail). `entry` is the leg's average fill, `soldQty` what has been sold so far.
export function stepHalfTrail(s: HalfTrailState, entry: number, ltp: number, soldQty: number): HalfTrailStep {
    let switched = false;
    if (s.phase === 'half') {
        if (!(s.sellQty !== undefined && soldQty >= s.halfQty)) return { action: 'hold', switched: false, changed: false };
        s.phase = 'trail';
        s.trail = { peak: Math.max(s.targetPrice, Number.isFinite(ltp) && ltp > 0 ? ltp : 0), armed: true };
        switched = true;
    }
    const t = new TrailStop({ getTrailDistance: () => s.dist, getActivation: () => s.targetPrice - entry });
    t.restore(s.trail);
    const d = t.onTick(entry, ltp);
    s.trail = t.snapshot() ?? s.trail;
    if (d.action === 'exit') return { action: 'exit', switched, peak: d.peak, exitLevel: d.exitLevel };
    return { action: 'hold', switched, changed: switched || d.changed };
}
