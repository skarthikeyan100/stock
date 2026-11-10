import { roundToTick } from '../util/tick';
import { toPercentNumber } from '../prism/percentConfig';

// Stop price for a filled LimitEntryStrategy leg, shared by NiftyChange and MomentumAtFixedTime.
//   stopLossPercent: 10   - stop = average fill * (1 - 10%). Takes precedence over stopLossPoints when set ("10" or "10%").
//                           none (or omitted) = no percentage stop; stopLossPoints / maxLossPerLeg still apply. A value of 100 or more is
//                           ignored the same way (a 100% stop would sit at zero and never trigger); no config ships it.
//   stopLossPoints: 8     - stop = average fill - 8 points (used only when stopLossPercent is not set)
//   maxLossPerLeg: 15000  - optional rupee cap per leg: the stop is never further than this loss
// undefined = no stop configured (a resting target sell only). The result is never below 0.05.
export function entryStopPrice(cfg: any, avg: number, filledQty: number): number | undefined {
    const pct = toPercentNumber(cfg?.stopLossPercent);
    const points = Number(cfg?.stopLossPoints);
    const cap = Number(cfg?.maxLossPerLeg);
    const hasPct = pct != null && pct > 0 && pct < 100;
    if (!hasPct && !(points > 0) && !(cap > 0)) return undefined;
    let stop = hasPct ? avg * (1 - pct! / 100) : points > 0 ? avg - points : 0;
    if (cap > 0 && filledQty > 0) stop = Math.max(stop, avg - cap / filledQty);
    return Math.max(roundToTick(stop), 0.05);
}

// The minimum |Nifty move| (points) a slot needs before it may trade; 0 / unset = any non-zero move.
export function minMovePoints(cfg: any): number {
    const n = Number(cfg?.minMovePoints);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
