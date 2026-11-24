/**
 * Dynamic support/resistance range detector.
 *
 * Two-phase state machine driven purely off tick data (no wall-clock reads,
 * so live streaming and historical replay behave identically):
 *
 *   SEEKING - accumulate ticks in a rolling buffer spanning `confirmWindowMs`.
 *     A tick-to-tick jump larger than `maxJump` restarts the buffer from that
 *     tick (a jump means price isn't consolidating). Once the buffer spans
 *     the full window and its range (max-min) is within `maxRangeWidth`, the
 *     range LOCKS: support = min - buffer, resistance = max + buffer.
 *
 *   LOCKED - support/resistance are frozen. New local highs/lows inside the
 *     band do not move the levels. A tick crossing support/resistance by more
 *     than `breachBuffer` starts a *pending* breach rather than firing
 *     immediately - if price stays beyond that buffered line for at least
 *     `breachConfirmMs`, the breach is confirmed (using the confirming tick's
 *     price/time) and re-seeds a fresh SEEKING buffer. If price returns
 *     inside the buffered line before the delay elapses, the pending breach
 *     is cancelled as a false alarm and the range stays LOCKED. With
 *     `breachBuffer = 0` and `breachConfirmMs = 0` this degenerates to the
 *     original behavior: any crossing tick is an immediate breach.
 */

export type SRPhase = 'SEEKING' | 'LOCKED';

export interface SRConfig {
    confirmWindowMs: number;
    maxJump: number;
    maxRangeWidth: number;
    buffer: number;
    breachBuffer: number;
    breachConfirmMs: number;
}

export interface SRTick {
    ltp: number;
    ltt: number; // epoch ms
}

export interface PendingBreach {
    direction: 'support' | 'resistance';
    startedAt: number; // ltt of the first tick that crossed the buffered line
}

export interface SRState {
    phase: SRPhase;
    buffer: SRTick[];
    support: number | null;
    resistance: number | null;
    lockedAt: number | null;
    pendingBreach: PendingBreach | null;
}

export type SREvent =
    | { type: 'LOCKED'; support: number; resistance: number; lockedAt: number }
    | {
          type: 'BREACH';
          direction: 'support' | 'resistance';
          ltp: number;
          ltt: number;
          support: number;
          resistance: number;
          lockedAt: number;
          heldMs: number;
      }
    | { type: 'NONE' };

export function initSRState(): SRState {
    return { phase: 'SEEKING', buffer: [], support: null, resistance: null, lockedAt: null, pendingBreach: null };
}

export function processTick(state: SRState, tick: SRTick, config: SRConfig): { state: SRState; event: SREvent } {
    if (state.phase === 'LOCKED') {
        const support = state.support!;
        const resistance = state.resistance!;
        const belowSupport = tick.ltp < support - config.breachBuffer;
        const aboveResistance = tick.ltp > resistance + config.breachBuffer;
        const crossing = belowSupport || aboveResistance;

        if (!crossing) {
            if (state.pendingBreach) {
                // Price came back inside the buffered line - false alarm, cancel the pending breach.
                return { state: { ...state, pendingBreach: null }, event: { type: 'NONE' } };
            }
            return { state, event: { type: 'NONE' } };
        }

        const direction: 'support' | 'resistance' = belowSupport ? 'support' : 'resistance';
        const alreadyPending = state.pendingBreach && state.pendingBreach.direction === direction;
        const startedAt = alreadyPending ? state.pendingBreach!.startedAt : tick.ltt;

        if (tick.ltt - startedAt >= config.breachConfirmMs) {
            return {
                state: seedSeeking(tick),
                event: {
                    type: 'BREACH',
                    direction,
                    ltp: tick.ltp,
                    ltt: tick.ltt,
                    support,
                    resistance,
                    lockedAt: state.lockedAt!,
                    heldMs: tick.ltt - state.lockedAt!,
                },
            };
        }

        return { state: { ...state, pendingBreach: { direction, startedAt } }, event: { type: 'NONE' } };
    }

    const last = state.buffer[state.buffer.length - 1];
    let buffer = last && Math.abs(tick.ltp - last.ltp) > config.maxJump ? [tick] : [...state.buffer, tick];

    const cutoff = tick.ltt - config.confirmWindowMs;
    // The span is proven by ANY tick at or before the cutoff (the old filter-then-compare only held when a tick landed exactly on it).
    // Keep the newest such tick as the anchor. Its price was in force at the window start, so it takes part in the range unless a tick
    // sits exactly on the cutoff (dense feed: unchanged behaviour).
    const spanReached = buffer.length > 0 && buffer[0].ltt <= cutoff;
    const older = buffer.filter(t => t.ltt < cutoff);
    const anchor = older.length > 0 ? [older[older.length - 1]] : [];
    buffer = buffer.filter(t => t.ltt >= cutoff);
    if (spanReached) {
        const prices = buffer.map(t => t.ltp);
        if (anchor.length > 0 && (buffer.length === 0 || buffer[0].ltt > cutoff)) prices.push(anchor[0].ltp);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (max - min <= config.maxRangeWidth) {
            const support = min - config.buffer;
            const resistance = max + config.buffer;
            return {
                state: { phase: 'LOCKED', buffer: [], support, resistance, lockedAt: tick.ltt, pendingBreach: null },
                event: { type: 'LOCKED', support, resistance, lockedAt: tick.ltt },
            };
        }
    }

    return { state: { phase: 'SEEKING', buffer: [...anchor, ...buffer], support: null, resistance: null, lockedAt: null, pendingBreach: null }, event: { type: 'NONE' } };
}

function seedSeeking(tick: SRTick): SRState {
    return { phase: 'SEEKING', buffer: [tick], support: null, resistance: null, lockedAt: null, pendingBreach: null };
}
