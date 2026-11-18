import Log from './Log';
import { markNotPlaced } from './notPlaced';
import { sleep } from './sleep';

// ONE ORDER WRITE AT A TIME PER BROKER, ONE SECOND APART. Every call that changes anything at a broker (place, cancel, modify, GTT
// create/modify/delete, cover/bracket exit) goes through runOrderWrite at the lowest level (Kite.ts, ANT.ts, Breeze.ts, prism/RestAPI.ts),
// so strategies, max-profit trips, exit monitors, chunked square-offs and frontend buys that fire in the same instant reach the broker
// in a line instead of in parallel. 2026-11-18 10:00: ScaledHedged-Breeze's root buy got an HTTP 429 while SimpleContinuous-Breeze was
// ordering on the same account at the same moment. Different brokers run in parallel. Reads (quotes, positions, order books) are NOT queued.
//
// The rule is deliberately simple: FIFO; the next write for a broker starts only after the previous one has finished (success or
// failure) AND at least ORDER_GAP_MS later. No tokens, no back-off, no retry.
export const ORDER_GAP_MS = 1000;
// A write whose turn does not come within this long is NOT sent: it fails with the NOT_PLACED flag (a definite "never reached the
// broker", safe for the caller to retry). The strategy side gives up on a request after ORDER_IPC_TIMEOUT_MS (90 s) and would treat a
// still-queued order as outcome unknown, then the order process would send it anyway; this keeps the answer definite and well inside that.
export const MAX_QUEUE_WAIT_MS = 30000;
// A broker call that has not returned after this long no longer holds the line (Breeze's SDK has no HTTP timeout of its own; ANT and Kite
// time out at 15 s / 7 s). The call itself carries on and its caller still gets its result; only the next order may go.
export const MAX_SLOT_HOLD_MS = 30000;

const lines = new Map<string, { tail: Promise<void>; lastDoneAt: number }>();

export async function runOrderWrite<T>(broker: string, label: string, fn: () => Promise<T>): Promise<T> {
    let line = lines.get(broker);
    if (!line) { line = { tail: Promise.resolve(), lastDoneAt: 0 }; lines.set(broker, line); }
    const myLine = line;
    const enqueuedAt = Date.now();
    const prev = myLine.tail; // only ever resolves (release() below), never rejects
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    myLine.tail = prev.then(() => mine);
    await prev;
    let released = false;
    let holdTimer: NodeJS.Timeout | undefined;
    const done = (sent: boolean): void => {
        if (released) return;
        released = true;
        if (holdTimer) clearTimeout(holdTimer);
        if (sent) myLine.lastDoneAt = Date.now();
        release();
    };
    try {
        const gap = myLine.lastDoneAt + ORDER_GAP_MS - Date.now();
        if (gap > 0) await sleep(gap);
        const waited = Date.now() - enqueuedAt;
        if (waited > MAX_QUEUE_WAIT_MS) {
            Log.log(`[orderQueue] ALERT: ${broker} ${label} waited ${waited} ms for its turn - not sent`);
            throw markNotPlaced(new Error(`${broker} order queue: ${label} waited ${waited} ms for its turn (limit ${MAX_QUEUE_WAIT_MS} ms) and was not sent`));
        }
        holdTimer = setTimeout(() => {
            Log.log(`[orderQueue] ALERT: ${broker} ${label} has not returned after ${MAX_SLOT_HOLD_MS} ms - the next ${broker} order is released`);
            done(true);
        }, MAX_SLOT_HOLD_MS);
        return await fn();
    } finally {
        done(holdTimer !== undefined);
    }
}
