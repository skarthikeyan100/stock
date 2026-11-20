// Event-driven trigger for the non-platform-sell booking (bookkeeping.bookForeignSellShortfall), 2026-11-20 user decision: 'Manual sell should be booked
// whenever another trade happens, not just on resync or reconcile, probably as and when the sell happens'. Pure scheduling, no broker knowledge:
// callers say "check broker X, contract Y" (a fill event of a non-platform sell, the platform's own booking of any trade, a NEVER-SHORT refusal, the
// safety poll) and this runs `run` after a short settle, coalescing bursts and never running one (broker, contract) key more than once per window.
//
//  - settle:   the check starts `settleMs` after the LAST request of a burst (a 1755-lot sell arrives as many rows), but never later than `maxWaitMs`
//              after the FIRST request of the burst. The settle gives the platform's own fill bookings that are about to land time to land.
//  - window:   a key that has just run is not run again before `minGapMs` has passed (a refusal storm, an event storm and a poll all share the key);
//              a request that arrives during a run or inside the window marks the key dirty and ONE more run follows when the window ends.
//  - serial:   at most one run per broker at a time (the run itself reads the broker twice, 3 s apart, to confirm).
// `run` never needs to throw; if it does the error is logged by the caller-supplied handler and the key stays usable.
export type WatchReason = 'foreign-sell-event' | 'own-trade' | 'refusal' | 'poll';

export interface WatchOpts {
    settleMs: number;
    maxWaitMs: number;
    minGapMs: number;
    now?: () => number;
    onError?: (broker: string, tsym: string, e: unknown) => void;
}

interface KeyState { timer?: NodeJS.Timeout; firstAt: number; dueAt: number; reasons: Set<WatchReason>; running: boolean; dirty: boolean; lastRunAt: number; settleMs: number }

export class ForeignSellWatch {
    private keys = new Map<string, KeyState>();
    private brokerTails = new Map<string, Promise<void>>();
    private enabled = false;
    runs = 0; // test/diagnostics

    constructor(private run: (broker: string, tsym: string, reasons: WatchReason[]) => Promise<void>, private opts: WatchOpts) {}

    private now(): number { return (this.opts.now ?? Date.now)(); }
    enable(): void { this.enabled = true; }
    isEnabled(): boolean { return this.enabled; }
    stop(): void { for (const k of this.keys.values()) if (k.timer) clearTimeout(k.timer); this.keys.clear(); this.enabled = false; }
    pending(): number { return Array.from(this.keys.values()).filter((k) => k.timer || k.running || k.dirty).length; }

    // `tsym` '*' = every open contract of the broker. `settleMs` overrides the default settle for this request (a refusal needs less than an event).
    request(broker: string, tsym: string, reason: WatchReason, settleMs?: number): void {
        if (!this.enabled) return;
        const key = `${broker}|${tsym}`;
        const now = this.now();
        let k = this.keys.get(key);
        if (!k) { k = { firstAt: now, dueAt: now, reasons: new Set(), running: false, dirty: false, lastRunAt: -Infinity, settleMs: this.opts.settleMs }; this.keys.set(key, k); }
        k.reasons.add(reason);
        if (settleMs != null) k.settleMs = Math.min(k.settleMs, settleMs);
        if (k.running) { k.dirty = true; return; }
        if (!k.timer) k.firstAt = now;
        this.arm(key, k, now);
    }

    private arm(key: string, k: KeyState, now: number): void {
        const settleDue = Math.min(now + k.settleMs, k.firstAt + this.opts.maxWaitMs);
        const gapDue = k.lastRunAt + this.opts.minGapMs;
        k.dueAt = Math.max(settleDue, gapDue);
        if (k.timer) clearTimeout(k.timer);
        k.timer = setTimeout(() => { k.timer = undefined; void this.fire(key, k); }, Math.max(0, k.dueAt - now));
        if (typeof k.timer.unref === 'function') k.timer.unref();
    }

    private async fire(key: string, k: KeyState): Promise<void> {
        const [broker, tsym] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        const reasons = Array.from(k.reasons);
        k.reasons.clear(); k.dirty = false; k.running = true; k.settleMs = this.opts.settleMs;
        const prev = this.brokerTails.get(broker) ?? Promise.resolve();
        const mine = prev.then(async () => {
            try { this.runs++; await this.run(broker, tsym, reasons); } catch (e) { this.opts.onError?.(broker, tsym, e); }
        });
        this.brokerTails.set(broker, mine);
        await mine;
        if (this.brokerTails.get(broker) === mine) this.brokerTails.delete(broker);
        k.running = false;
        k.lastRunAt = this.now();
        if (k.dirty && this.enabled) { k.dirty = false; k.firstAt = this.now(); this.arm(key, k, this.now()); }
        // The key stays (a few bytes per contract per day): its lastRunAt is what rate-limits the next request.
    }
}
