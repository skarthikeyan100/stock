import TtlBuffer from './TtlBuffer';

interface Outcome<T> {
    value?: T;
    error?: Error;
}

// Shared by AntOrderNotifyStream.ts and BreezeOrderNotifyStream.ts (extracted 2026-10-15 after
// the identical "resolve a registered waiter, or buffer the outcome for one that hasn't
// registered yet" logic was hand-copied between them once already - see TtlBuffer.ts's own
// extraction history). Each broker's push-classification logic (field names, status vocabulary,
// price sanity checks) stays in its own file; only the generic "settle or buffer, then let a
// late waiter pick up a buffered result" mechanics live here.
export default class PendingFillRegistry<T> {
    // Several waiters can share one key (a re-check overlapping a square-off wait): a settle reaches all of them, and a timeout removes only its own.
    private pending = new Map<string, { resolve: (value: T) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }[]>();
    private buffered: TtlBuffer<Outcome<T>>;

    constructor(bufferTtlMs: number) {
        this.buffered = new TtlBuffer<Outcome<T>>(bufferTtlMs);
    }

    // Called once a push's outcome for `key` is known. Resolves/rejects an already-registered
    // waiter; otherwise buffers the outcome so a `wait()` registered moments later (the REST call
    // that hands the caller this key may not have returned yet) still sees it instead of timing out.
    settle(key: string, outcome: Outcome<T>): void {
        const waiters = this.pending.get(key);
        if (waiters && waiters.length > 0) {
            this.pending.delete(key);
            for (const w of waiters) {
                clearTimeout(w.timer);
                if (outcome.error) w.reject(outcome.error); else w.resolve(outcome.value!);
            }
            return;
        }
        this.buffered.set(key, outcome);
    }

    // Resolves as soon as settle() is (or already was) called for this key, or rejects on timeout.
    wait(key: string, timeoutMs: number, onTimeout: () => Error): Promise<T> {
        const buffered = this.buffered.take(key);
        if (buffered) {
            return buffered.error ? Promise.reject(buffered.error) : Promise.resolve(buffered.value!);
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, timer: undefined as unknown as NodeJS.Timeout };
            entry.timer = setTimeout(() => {
                const list = (this.pending.get(key) ?? []).filter((w) => w !== entry);
                if (list.length > 0) this.pending.set(key, list); else this.pending.delete(key);
                reject(onTimeout());
            }, timeoutMs);
            this.pending.set(key, [...(this.pending.get(key) ?? []), entry]);
        });
    }
}
