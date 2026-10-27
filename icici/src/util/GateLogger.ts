import Log from './Log';

// "Why am I not trading" log lines fire on every tick; this logs each distinct reason at most once per throttle window.
// Shared by LegManager, ContinuousStrategy and BulkPcrStrategy (each used to carry its own copy).
export default class GateLogger {
    private last = new Map<string, number>();

    constructor(private readonly prefix: string, private readonly throttleMs: number = 5 * 60 * 1000) {}

    log(reason: string): void {
        const now = Date.now();
        if (now - (this.last.get(reason) ?? 0) < this.throttleMs) return;
        this.last.set(reason, now);
        Log.log(`${this.prefix} ${reason}`);
    }
}
