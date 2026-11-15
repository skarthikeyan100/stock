/** A small in-memory sliding-window limiter (per key). Used on invite acceptance and the forecast/recommendation endpoints; resets on restart, which is fine for abuse limiting. */
export class RateLimiter {
    private hits = new Map<string, number[]>();
    constructor(private readonly max: number, private readonly windowMs: number) {}
    /** True when the call is allowed (and counts it). */
    allow(key: string, now = Date.now()): boolean {
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
        recent.push(now);
        this.hits.set(key, recent);
        if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
        return true;
    }
}
