// Per-future VWAP bookkeeping for the live feed. ANT's touchline sends `ap` (the exchange's average traded price, i.e. its VWAP) and `v`
// (cumulative volume) but only on the ticks where they changed, so the tracker keeps the latest of each. It also computes the VWAP itself
// from the volume deltas (sum of price x delta-volume / sum of delta-volume) as a cross-check on `ap`, and flags feed problems.
//
// The own VWAP only covers volume traded since the first tick this tracker saw (the earlier volume has no price), so it matches the
// exchange's figure only when the process was up from the open; `ownSinceVolume` says where it started.

export interface FutVwapState {
    ltp: number;
    volume: number | undefined;      // cumulative day volume, last seen
    exchangeVwap: number | undefined; // `ap`, last seen (> 0)
    ownVwap: number | undefined;
    ownSinceVolume: number | undefined;
}

export type FutVwapIssue = 'volume-went-backwards' | 'ap-is-zero';

export class FutVwapTracker {
    private ltp = NaN;
    private volume: number | undefined;
    private ap: number | undefined;
    private baselineVolume: number | undefined;
    private sumPV = 0;
    private sumV = 0;
    private day = '';

    // Feeds one raw ANT tick's numbers (any may be undefined on a partial update). Returns the problems this tick showed.
    update(raw: { lp?: unknown; v?: unknown; ap?: unknown }, dayKey: string): FutVwapIssue[] {
        const issues: FutVwapIssue[] = [];
        if (dayKey !== this.day) { this.resetForDay(dayKey); }
        const lp = raw.lp !== undefined ? parseFloat(String(raw.lp)) : NaN;
        if (Number.isFinite(lp) && lp > 0) this.ltp = lp;
        if (raw.ap !== undefined) {
            const ap = parseFloat(String(raw.ap));
            if (Number.isFinite(ap) && ap > 0) this.ap = ap;
            else if (Number.isFinite(ap) && ap === 0) issues.push('ap-is-zero');
        }
        if (raw.v !== undefined) {
            const v = parseInt(String(raw.v), 10);
            if (Number.isFinite(v) && v >= 0) {
                if (this.volume === undefined) {
                    this.baselineVolume = v;
                } else if (v < this.volume) {
                    // A feed reset or a bad tick: restart the own VWAP from this volume rather than mixing two bases.
                    issues.push('volume-went-backwards');
                    this.sumPV = 0;
                    this.sumV = 0;
                    this.baselineVolume = v;
                } else if (v > this.volume && Number.isFinite(this.ltp)) {
                    const delta = v - this.volume;
                    this.sumPV += this.ltp * delta;
                    this.sumV += delta;
                }
                this.volume = v;
            }
        }
        return issues;
    }

    state(): FutVwapState {
        return {
            ltp: this.ltp,
            volume: this.volume,
            exchangeVwap: this.ap,
            ownVwap: this.sumV > 0 ? this.sumPV / this.sumV : undefined,
            ownSinceVolume: this.baselineVolume,
        };
    }

    // The VWAP a strategy should use: the exchange's `ap` when present, else the own one.
    best(): { vwap: number; source: 'ap' | 'own' } | undefined {
        const s = this.state();
        if (s.exchangeVwap !== undefined) return { vwap: s.exchangeVwap, source: 'ap' };
        if (s.ownVwap !== undefined) return { vwap: s.ownVwap, source: 'own' };
        return undefined;
    }

    private resetForDay(dayKey: string): void {
        this.day = dayKey;
        this.ltp = NaN;
        this.volume = undefined;
        this.ap = undefined;
        this.baselineVolume = undefined;
        this.sumPV = 0;
        this.sumV = 0;
    }
}
