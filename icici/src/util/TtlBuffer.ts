// Small keyed buffer for values that need to survive just long enough to bridge a short race -
// e.g. a WebSocket push arriving before the REST call that will hand the caller the key to look
// it up by has even returned (see AntOrderNotifyStream.ts/BreezeOrderNotifyStream.ts's
// handleMessage, both fixed 2026-10-15 with an identical hand-rolled version of this before being
// extracted here). Not a general-purpose cache - `take()` always consumes the entry, since the
// whole point is "the next read gets this value once, then it's gone."
export default class TtlBuffer<T> {
    private entries = new Map<string, { value: T; arrivedAt: number }>();

    constructor(private readonly ttlMs: number) {}

    private sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (now - entry.arrivedAt > this.ttlMs) this.entries.delete(key);
        }
    }

    set(key: string, value: T): void {
        this.sweep();
        this.entries.set(key, { value, arrivedAt: Date.now() });
    }

    // Returns and removes the buffered value if present and not yet expired; undefined otherwise.
    take(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        if (Date.now() - entry.arrivedAt > this.ttlMs) return undefined;
        return entry.value;
    }
}
