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
 *     band do not move the levels - only a tick that actually crosses
 *     support or resistance counts as a BREACH, which re-seeds a fresh
 *     SEEKING buffer starting from the breaching tick.
 */

export type SRPhase = 'SEEKING' | 'LOCKED';

export interface SRConfig {
    confirmWindowMs: number;
    maxJump: number;
    maxRangeWidth: number;
    buffer: number;
}

export interface SRTick {
    ltp: number;
    ltt: number; // epoch ms
}

export interface SRState {
    phase: SRPhase;
    buffer: SRTick[];
    support: number | null;
    resistance: number | null;
    lockedAt: number | null;
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
    return { phase: 'SEEKING', buffer: [], support: null, resistance: null, lockedAt: null };
}

export function processTick(state: SRState, tick: SRTick, config: SRConfig): { state: SRState; event: SREvent } {
    if (state.phase === 'LOCKED') {
        if (tick.ltp < state.support!) {
            return {
                state: seedSeeking(tick),
                event: {
                    type: 'BREACH',
                    direction: 'support',
                    ltp: tick.ltp,
                    ltt: tick.ltt,
                    support: state.support!,
                    resistance: state.resistance!,
                    lockedAt: state.lockedAt!,
                    heldMs: tick.ltt - state.lockedAt!,
                },
            };
        }
        if (tick.ltp > state.resistance!) {
            return {
                state: seedSeeking(tick),
                event: {
                    type: 'BREACH',
                    direction: 'resistance',
                    ltp: tick.ltp,
                    ltt: tick.ltt,
                    support: state.support!,
                    resistance: state.resistance!,
                    lockedAt: state.lockedAt!,
                    heldMs: tick.ltt - state.lockedAt!,
                },
            };
        }
        return { state, event: { type: 'NONE' } };
    }

    const last = state.buffer[state.buffer.length - 1];
    let buffer = last && Math.abs(tick.ltp - last.ltp) > config.maxJump ? [tick] : [...state.buffer, tick];

    const cutoff = tick.ltt - config.confirmWindowMs;
    buffer = buffer.filter(t => t.ltt >= cutoff);

    const spanReached = buffer.length > 0 && tick.ltt - buffer[0].ltt >= config.confirmWindowMs;
    if (spanReached) {
        const prices = buffer.map(t => t.ltp);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        if (max - min <= config.maxRangeWidth) {
            const support = min - config.buffer;
            const resistance = max + config.buffer;
            return {
                state: { phase: 'LOCKED', buffer: [], support, resistance, lockedAt: tick.ltt },
                event: { type: 'LOCKED', support, resistance, lockedAt: tick.ltt },
            };
        }
    }

    return { state: { phase: 'SEEKING', buffer, support: null, resistance: null, lockedAt: null }, event: { type: 'NONE' } };
}

function seedSeeking(tick: SRTick): SRState {
    return { phase: 'SEEKING', buffer: [tick], support: null, resistance: null, lockedAt: null };
}
