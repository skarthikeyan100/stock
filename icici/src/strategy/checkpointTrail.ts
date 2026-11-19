// HighLow exit for ONE leg: checkpoint on a 5-minute option candle close. Pure decision logic (no orders, no I/O); LimitEntryStrategy places the orders.
//
//   buy 100, target 10, stop 8:  checkpoint = buy + target = 110, second target = buy + 1.5 x target = 115, stop = 92.
//   - Until the checkpoint the whole leg has only the tick stop (92). Nothing rests at the broker.
//   - When a 5-minute candle of the option CLOSES at or above the checkpoint: half the quantity (whole lots, floor(lots / 2)) is sold at market and the
//     stop of the rest moves to that close - LOCK_BELOW_CLOSE (close 110 -> stop 108). The rest then exits on a tick at or above the second target (115)
//     or at or below the new stop.
//   - The candle in progress when the leg's first tick arrives is partial and is never judged. Candle state is in memory: after a restart the
//     next candle is partial again, the persisted phase / quantities are kept.
//   - Fewer than 2 lots cannot be halved: splitLots (halfTrail.ts) answers null and the caller uses its normal target / stop exit.
export const CANDLE_SECONDS = 300;
export const LOCK_BELOW_CLOSE = 2;
export const SECOND_TARGET_FACTOR = 1.5;

export interface CheckpointState {
    halfQty: number;       // quantity sold when the checkpoint candle closes
    checkpoint: number;    // candle close at or above this triggers the half sell
    target2: number;       // second target of the rest: buy + 1.5 x target
    phase: 'watch' | 'moved';
    sellQty?: number;      // set BEFORE the half sell goes out (a retry or restart never doubles it)
    trigger?: number;      // the candle close that hit the checkpoint (the stop for the rest is trigger - LOCK_BELOW_CLOSE)
}

// Candle closes from a tick stream. `nowMs` is the tick's wall-clock time (5-minute buckets of the epoch line up with the 09:15 grid).
export class FiveMinuteCloses {
    private bucket: number | null = null;
    private last = 0;
    private partial = true;
    // Returns the close of the candle that just ended (the first tick of the next bucket reveals it), or undefined. The first, partial, candle is skipped.
    onTick(ltp: number, nowMs: number): number | undefined {
        if (!(ltp > 0)) return undefined;
        const b = Math.floor(nowMs / 1000 / CANDLE_SECONDS);
        if (this.bucket === null) { this.bucket = b; this.last = ltp; return undefined; }
        let closed: number | undefined;
        if (b !== this.bucket) {
            closed = this.partial ? undefined : this.last;
            this.partial = false;
            this.bucket = b;
        }
        this.last = ltp;
        return closed;
    }
}

export function checkpointTrigger(s: CheckpointState, candleClose: number): boolean {
    return s.phase === 'watch' && s.trigger === undefined && candleClose >= s.checkpoint;
}

export function lockedStop(trigger: number): number {
    return Math.max(trigger - LOCK_BELOW_CLOSE, 0.05);
}
