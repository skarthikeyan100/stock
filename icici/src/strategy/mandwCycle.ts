// Pure rules of MandWStrategy (no I/O, no imports): the M / W shape on ONE option's price, and what to do at each point of it.
//
// The strategy buys an option (point 1, price P) with a target of P + T and a stop of P - S, both on the option price.
//   - Stop hit (adverse): reverse at once - buy the opposite option.
//   - Target hit (point 3): the position is sold at P + T. The SAME contract is then watched with no position:
//       valley  (point 4): its price falls back to the original price P or below (no tolerance);
//       peak    (point 5): after the valley it rises to P + T again. Shape complete (an "M" on a CE, a "W" on a PE) -> reverse: buy the opposite option.
//     If the price falls to the stop level P - S before the second peak the shape failed -> reverse at once, like a stop.
//     If neither happens within the timeout the watch is abandoned and the same side is bought again.

export type Right = 'CE' | 'PE';

export interface MwWatch {
    right: Right; // the side that hit its target; the shape is formed on this contract's price
    tsym: string;
    token: string;
    exchange: 'NFO' | 'BFO';
    entry: number; // P: the average fill of the cycle (the valley level)
    target: number; // P + T: the second-peak level
    stop: number; // P - S: below it the shape failed
    phase: 'peak' | 'valley'; // 'peak': waiting for the valley; 'valley': valley seen, waiting for the second peak
    startedAt: number; // ms: when the watch began (the timeout runs from here)
}

export interface MwPending {
    right: Right; // the side to buy next
    reason: string;
    at: number; // ms: a pending entry older than PENDING_MAX_AGE_MS is dropped (never placed after a long gap, e.g. a restart)
}

// The state of ONE broker (brokers act independently: nothing here is shared between brokers).
export interface MwBroker {
    cycleRight?: Right; // the side of the cycle that is (or was last) live
    watch?: MwWatch;
    pending?: MwPending;
    seq?: number; // cycles started on this broker today (the cycle key is `<day> MW-<broker>-<seq>`)
    decidedKey?: string; // the cycle key whose end was already decided
    retries?: number; // consecutive cycles that ended with nothing filled (entry refused / never filled) and were tried again
}

export interface MwState {
    brokers: Record<string, MwBroker>;
}

// After this many consecutive cycles with no fill the strategy stops for the day instead of trying again (ALERT logged).
export const MAX_ENTRY_RETRIES = 2;

export type WatchEvent = 'none' | 'valley' | 'pattern' | 'failed' | 'timeout';

export const PENDING_MAX_AGE_MS = 120_000;

export function opposite(right: Right): Right {
    return right === 'CE' ? 'PE' : 'CE';
}

// The user's names for the shape: it is an M on a CE (the price tops twice), a W on a PE.
export function patternName(right: Right): 'M' | 'W' {
    return right === 'CE' ? 'M' : 'W';
}

export type ExitKind = 'target' | 'stop' | 'other';

// How a closed cycle ended, from its average entry and exit price. 'other' is anything in between (an end-of-day close, a manual sell): no reversal.
// The halves of the target / stop distances are the boundaries, so a market stop that filled a little above the stop price is still a stop.
export function classifyExit(entry: number, exitPrice: number, target: number, stop: number): ExitKind {
    if (!(entry > 0) || !(exitPrice > 0)) return 'other';
    if (exitPrice >= entry + (target - entry) / 2 && exitPrice > entry) return 'target';
    if (exitPrice <= entry - (entry - stop) / 2 && exitPrice < entry) return 'stop';
    return 'other';
}

// One step of the watch for a price tick (`ltp` <= 0 or not finite = no price, only the timeout is checked).
// Failed beats everything; the second peak needs the valley first; the timeout is for the whole watch.
export function stepWatch(w: MwWatch, ltp: number, nowMs: number, timeoutMs: number): { phase: MwWatch['phase']; event: WatchEvent } {
    if (Number.isFinite(ltp) && ltp > 0) {
        if (ltp <= w.stop) return { phase: w.phase, event: 'failed' };
        if (w.phase === 'valley' && ltp >= w.target) return { phase: w.phase, event: 'pattern' };
        if (w.phase === 'peak' && ltp <= w.entry) return { phase: 'valley', event: 'valley' };
    }
    if (timeoutMs > 0 && nowMs - w.startedAt >= timeoutMs) return { phase: w.phase, event: 'timeout' };
    return { phase: w.phase, event: 'none' };
}
