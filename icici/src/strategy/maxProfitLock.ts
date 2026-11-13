import { roundToTick, NFO_TICK_SIZE } from '../util/tick';

// The maxProfit exit of SimpleContinuousStrategy / ScaledHedgedStrategy (user's rule, 2026-11-13: a trip must LOCK the cap, not book below it).
// The trip itself is judged on the last tick (profitTotal); the exit is a limit sell at the price that makes the strategy total equal the cap,
// never a sell at the live bid. The legs are the strategies' own SimpleLeg objects; only the fields below are read.
export interface LockLeg {
    qty: number;
    soldQty: number;
    entry: number;
    pnlRef?: number;
    pnlRefPending?: boolean;
    lastLtp?: number;
    sellQty: number;
    sellPrice: number;
}

const remaining = (l: LockLeg): number => l.qty - l.soldQty;
const refOf = (l: LockLeg): number => l.pnlRef ?? l.entry;

// What a leg adds to the total when it exits at `price`.
export function gainAt(l: LockLeg, price: number): number {
    return remaining(l) * (price - refOf(l));
}

// A leg's exit price as far as the total is concerned: where its resting sell sits, else the last tick (what profitTotal values it at).
// A leg still waiting for its reference tick (or with no tick) counts 0, as in profitTotal.
function gainOfOther(l: LockLeg): number {
    if (l.pnlRefPending) return 0;
    if (l.sellQty > 0 && l.sellPrice > 0) return gainAt(l, l.sellPrice);
    if (!(Number(l.lastLtp) > 0)) return 0;
    return gainAt(l, Number(l.lastLtp));
}

// The lowest tick price at which selling the rest of `leg` brings the total to `cap`:
//   realized + this leg's remaining x (price - ref) + every other open leg's gain >= cap.
// Rounded UP to the tick (so the booked total is never below the cap) and never below one tick.
export function clearPrice(leg: LockLeg, openLegs: LockLeg[], realized: number, cap: number): number {
    const others = openLegs.filter((l) => l !== leg).reduce((s, l) => s + gainOfOther(l), 0);
    const rem = remaining(leg);
    const exact = refOf(leg) + (cap - realized - others) / rem;
    const ticks = Math.ceil(exact / NFO_TICK_SIZE - 1e-9);
    return Math.max(NFO_TICK_SIZE, roundToTick(ticks * NFO_TICK_SIZE));
}
