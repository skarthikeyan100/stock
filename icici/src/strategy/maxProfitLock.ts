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
    if (l.sellQty > 0 && l.sellPrice > 0) { const g = gainAt(l, l.sellPrice); return Number.isFinite(g) ? g : 0; }
    if (!(Number(l.lastLtp) > 0)) return 0;
    const g = gainAt(l, Number(l.lastLtp));
    return Number.isFinite(g) ? g : 0; // an unusable leg counts 0 (finiteGuard.ts)
}

// The lowest tick price at which selling the rest of `leg` brings the total to `cap`:
//   realized + this leg's remaining x (price - ref) + every other open leg's gain >= cap.
// Rounded UP to the tick (so the booked total is never below the cap) and never below one tick.
export function clearPrice(leg: LockLeg, openLegs: LockLeg[], realized: number, cap: number): number {
    const others = openLegs.filter((l) => l !== leg).reduce((s, l) => s + gainOfOther(l), 0);
    const rem = remaining(leg);
    const exact = refOf(leg) + (cap - realized - others) / rem;
    if (!Number.isFinite(exact)) return NFO_TICK_SIZE; // unusable inputs: never a NaN price; tripSellPrice then places at the marketable floor
    const ticks = Math.ceil(exact / NFO_TICK_SIZE - 1e-9);
    return Math.max(NFO_TICK_SIZE, roundToTick(ticks * NFO_TICK_SIZE));
}

// ---- The price a trip sell is actually placed at (2026-11-13 14:35 incident) ----
// clearPrice is the lowest price that locks the cap. When other legs' realized P&L already meets or exceeds the cap it can be ANY value
// down to one tick (live: 41 for a leg trading at 126), which the broker refuses ("order price is outside the price range specified by the
// exchange") and which, if accepted, would add nothing: a limit sell below the bid fills AT the bid. So the sell goes at
//     max(clearPrice, marketable floor)      floor = last tick LTP less a buffer, rounded to the tick
// The tick LTP is the one live reference every broker's leg already carries (ANT feed), so the rule is identical for Kite/ANT/Breeze/Prism and
// needs no extra quote call. What it guarantees: the placed limit is >= clearPrice, so every fill books at least what clearPrice assumed and the
// strategy total stays >= the cap (the cap is a FLOOR on the total, never a target: a fill at the bid above the limit books more, never less).
// The buffer starts at 5% (the same cushion the Kite/Breeze marketable sells use) and tightens to 2% then 0% after a refused placement, so a
// persistent band rejection walks the price to the live LTP, which is inside any exchange band.
export const TRIP_FLOOR_BUFFERS = [0.05, 0.02, 0];

export function tripFloor(lastLtp: number | undefined, attempt = 0): number | undefined {
    const ltp = Number(lastLtp);
    if (!(ltp > 0)) return undefined; // no tick yet: no floor (the caller places at clearPrice as before; a refusal is retried)
    const buf = TRIP_FLOOR_BUFFERS[Math.min(Math.max(attempt, 0), TRIP_FLOOR_BUFFERS.length - 1)];
    return Math.max(NFO_TICK_SIZE, roundToTick(ltp * (1 - buf)));
}

export function tripSellPrice(clear: number, lastLtp: number | undefined, attempt = 0): number {
    const floor = tripFloor(lastLtp, attempt);
    return floor === undefined ? clear : Math.max(clear, floor);
}

// Is a resting trip sell at `sellPrice` fine as it is? Yes when it sits at clearPrice, or above it but at or below the market (it is marketable:
// it locks at least the cap and fills at the bid). One above the market with a price above clearPrice sits out of reach (the market fell
// under it) and is re-priced; one below clearPrice locks less than the cap and is raised. This is what stops a floored price from being
// cancelled and re-placed on every tick as the LTP moves.
export function keepTripSell(sellPrice: number, clear: number, lastLtp: number | undefined): boolean {
    if (!(sellPrice > 0)) return false;
    if (Math.abs(sellPrice - clear) < NFO_TICK_SIZE / 2) return true;
    if (sellPrice < clear) return false;
    const ltp = Number(lastLtp);
    return ltp > 0 && sellPrice <= ltp + NFO_TICK_SIZE / 2;
}

// Per-leg retry state of a trip, in memory only: a throttle and a verification step, never a control (a restart simply starts it fresh, and
// the next pass re-derives everything from the legs and the broker).
export const TRIP_FILL_WAIT_MS = 60_000;
const TRIP_BACKOFF_BASE_MS = 5_000;
const TRIP_BACKOFF_MAX_MS = 60_000;
export class TripGuard {
    private failures = new Map<string, { n: number; next: number }>();
    private fillSince = new Map<string, number>(); // a cancel reported a fill: the leg's fill events may not have arrived yet
    private goneSince = new Map<string, number>(); // the broker refused the sell as 'nothing sellable' and the order side holds nothing

    // A placement refused: the next attempt waits 5 s, 10 s, 20 s ... up to 60 s. Returns the failure count (callers log in full on 1, 10, 20 ...).
    fail(id: string, now = Date.now()): number {
        const n = (this.failures.get(id)?.n ?? 0) + 1;
        this.failures.set(id, { n, next: now + Math.min(TRIP_BACKOFF_MAX_MS, TRIP_BACKOFF_BASE_MS * 2 ** (n - 1)) });
        return n;
    }
    due(id: string, now = Date.now()): boolean { const f = this.failures.get(id); return !f || now >= f.next; }
    attempts(id: string): number { return this.failures.get(id)?.n ?? 0; }
    ok(id: string): void { this.failures.delete(id); this.goneSince.delete(id); }
    shouldLogFailure(n: number): boolean { return n === 1 || n % 10 === 0; }

    markFill(id: string, now = Date.now()): void { if (!this.fillSince.has(id)) this.fillSince.set(id, now); }
    fillWait(id: string): number | undefined { return this.fillSince.get(id); }
    clearFill(id: string): void { this.fillSince.delete(id); }

    // First sight of 'nothing sellable' with nothing held starts the grace; returns true once the grace (the fill event's chance to arrive) is over.
    goneExpired(id: string, now = Date.now()): boolean {
        const since = this.goneSince.get(id);
        if (since === undefined) { this.goneSince.set(id, now); return false; }
        return now - since > TRIP_FILL_WAIT_MS;
    }
    forget(id: string): void { this.failures.delete(id); this.fillSince.delete(id); this.goneSince.delete(id); }
}
