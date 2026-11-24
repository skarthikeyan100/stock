// Pure rules of ExpiryStrategy (no I/O, no imports): how a closed cycle ended, what to buy next, and when an unfilled buy has drifted away.

export type Right = 'CE' | 'PE';

export function opposite(r: Right): Right {
    return r === 'CE' ? 'PE' : 'CE';
}

// What one broker is to buy next. `price` set = a limit at exactly that price on the SAME strike (the re-buy at the bought price after a target);
// absent = the ATM strike of the NIFTY level at that moment, limit at the central order price (best bid).
export interface ExPending {
    right: Right;
    price?: number;
    strike?: number; // with `price`: the strike the re-buy goes on (the one just sold)
    reason: string;
    at: number; // epoch ms the decision was taken (a decision older than PENDING_MAX_AGE_MS is dropped, never placed late)
}

// One broker's state. Nothing in it is shared with another broker.
export interface ExBroker {
    seq?: number;          // cycles started on this broker today (the cycle key is `<day> EX-<broker>-<seq>`)
    cycleRight?: Right;    // right of the current / last cycle
    cycleStrike?: number;  // strike of the current / last cycle
    cyclePrice?: number;   // limit price of a re-buy cycle (absent for an LTP entry)
    pending?: ExPending;
    decidedKey?: string;   // the cycle key whose end was already decided
    retries?: number;      // cycles in a row that ended with nothing filled
}

export interface ExState {
    brokers: Record<string, ExBroker>;
}

export const MAX_ENTRY_RETRIES = 2;
export const PENDING_MAX_AGE_MS = 2 * 60_000;

export type ExitKind = 'target' | 'stop' | 'other';

// How a closed cycle ended, from its average entry and exit price. 'other' is anything in between (an end-of-day close, a manual sell): no re-entry.
// The halves of the target / stop distances are the boundaries, so a market stop that filled a little above the stop price is still a stop.
export function classifyExit(entry: number, exitPrice: number, target: number, stop: number): ExitKind {
    if (!(entry > 0) || !(exitPrice > 0)) return 'other';
    if (exitPrice > entry && exitPrice >= entry + (target - entry) / 2) return 'target';
    if (exitPrice < entry && exitPrice <= entry - (entry - stop) / 2) return 'stop';
    return 'other';
}

// What follows a closed cycle: a target re-buys the same contract at the bought price, a stop buys the opposite right at the ATM, anything else nothing.
export function nextAfterExit(kind: ExitKind, right: Right, strike: number | undefined, entryAvg: number): ExPending | null {
    const at = Date.now();
    if (kind === 'target') return { right, price: entryAvg, strike, reason: 'target hit: buy again at the same price', at };
    if (kind === 'stop') return { right: opposite(right), reason: 'stop hit: buy the opposite right', at };
    return null;
}

// A resting BUY limit has drifted away when the market is more than `driftPoints` above its price (it cannot fill unless the price comes back).
export function drifted(ltp: number, orderPrice: number, driftPoints: number): boolean {
    return Number.isFinite(ltp) && ltp > 0 && orderPrice > 0 && driftPoints > 0 && ltp > orderPrice + driftPoints;
}

export function atmStrike(niftyLtp: number): number {
    return Math.round(niftyLtp / 50) * 50;
}
