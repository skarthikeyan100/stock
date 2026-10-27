// Trailing profit exit for ONE position. Pure decision logic: it places no orders, so each strategy keeps its own
// exit path. One instance per position (never shared), so two positions never share a peak.
//
// Rule (scope.md):
//   - Nothing happens until the price first reaches entry + activation. That tick arms the trail and sells nothing.
//   - Once armed, the peak follows the highest price seen and the exit level is max(entry + activation, peak - trail):
//     it only ever moves up, and never sits below the activation (target) price.
//   - A tick at or below the exit level (after the arming tick) means "exit now".
// The caller sells with a LIMIT order priced from `exitPrice`/the tick, never a market order.
// trail <= 0 (or unset) means off: onTick always answers 'hold'.

export interface TrailStopDeps {
    getTrailDistance: () => number;   // points below the peak that trigger the exit; <= 0 / NaN = off
    getActivation: () => number;      // points above entry at which the trail arms (the target)
}

export interface TrailState {
    peak: number;
    armed: boolean;
}

export type TrailDecision =
    | { action: 'hold'; peak: number | null; changed: boolean }
    | { action: 'exit'; peak: number; exitLevel: number };

export class TrailStop {
    private peak: number | null = null;
    private armed = false;

    constructor(private deps: TrailStopDeps) {}

    enabled(): boolean {
        const trail = this.deps.getTrailDistance();
        return Number.isFinite(trail) && trail > 0;
    }

    // Restores a persisted peak after a restart. Ignores anything unusable.
    restore(state: Partial<TrailState> | undefined): void {
        if (!state || !state.armed || !(typeof state.peak === 'number' && Number.isFinite(state.peak) && state.peak > 0)) return;
        this.armed = true;
        this.peak = state.peak;
    }

    snapshot(): TrailState | undefined {
        return this.armed && this.peak !== null ? { peak: this.peak, armed: true } : undefined;
    }

    // Exit level for the current peak: never below entry + activation.
    exitLevel(entry: number): number | null {
        if (!this.armed || this.peak === null) return null;
        return Math.max(entry + this.deps.getActivation(), this.peak - this.deps.getTrailDistance());
    }

    // `changed` on a hold means the persisted state (armed / peak) moved and is worth saving.
    onTick(entry: number, ltp: number): TrailDecision {
        if (!this.enabled() || !(entry > 0) || !(ltp > 0 && Number.isFinite(ltp))) return { action: 'hold', peak: this.peak, changed: false };
        const activation = this.deps.getActivation();
        if (!this.armed) {
            if (ltp < entry + activation) return { action: 'hold', peak: null, changed: false };
            this.armed = true;
            this.peak = ltp;
            return { action: 'hold', peak: ltp, changed: true };
        }
        let changed = false;
        if (ltp > this.peak!) {
            this.peak = ltp;
            changed = true;
        }
        const level = this.exitLevel(entry)!;
        if (ltp <= level) return { action: 'exit', peak: this.peak!, exitLevel: level };
        return { action: 'hold', peak: this.peak, changed };
    }
}
