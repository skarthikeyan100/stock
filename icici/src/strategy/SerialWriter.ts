import Log from '../util/Log';

// Runs async writes strictly one after another, in call order. Strategies persist their state with
// fire-and-forget Mongo writes; two writes issued back to back (phase 'selling' then 'done') can otherwise land out
// of order, and a restart would then read the OLDER snapshot (a position resurrected as 'selling'). Callers snapshot
// the document synchronously when they call enqueue(), so each write carries the state as of that call.
//
// Each write is bounded by WRITE_TIMEOUT_MS: one hung Mongo call must not block every later write (and every caller
// that awaits enqueue()). A timed-out write is logged and the chain moves on.
const WRITE_TIMEOUT_MS = 10_000;

export default class SerialWriter {
    private chain: Promise<void> = Promise.resolve();

    constructor(private label: string) {}

    // Resolves once THIS write has finished (or failed / timed out); never rejects.
    enqueue(write: () => Promise<unknown> | undefined): Promise<void> {
        const run = this.chain.then(async () => {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    Promise.resolve(write()),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`write timed out after ${WRITE_TIMEOUT_MS}ms`)), WRITE_TIMEOUT_MS); }),
                ]);
            } catch (e) {
                Log.log(`[${this.label}] persistState failed:`, e);
            } finally {
                if (timer) clearTimeout(timer);
            }
        });
        this.chain = run;
        return run;
    }
}
