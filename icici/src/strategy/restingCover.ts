// What a resting limit sell lets a max-profit total count (2026-11-26, SimpleContinuous kite): a leg covered by a resting limit sell cannot earn more
// than (sell price - entry) x quantity. Once the price trades above it the order has filled, or fills at that price, and the fill is only not booked yet:
// the leg was valued at LTP 206.45 above its own resting sell at 204.95, the strategy tripped on 5233 and booked 4550 (< the 5000 cap).
// So the quantity covered by a resting sell is valued at min(ltp, resting price); every uncovered quantity (no sell, a shortfall, a clamped / partial
// placement, a price nobody recorded) stays at the LTP. Profit totals only: no loss stop reads these.

export interface RestingSell { qty: number; price: number }

// The leg fields read here (the SimpleLeg of SimpleContinuous / ScaledHedged / ExperimentalScaled).
export interface RestingLeg {
    qty: number;
    soldQty: number;
    sellQty: number;
    sellShortfall?: number;
    sellPrice: number;
    // What rests, one entry per placement price. [] = something may rest but its price is not known. Absent = a state file written before this field:
    // `sellQty` at `sellPrice` (the price recorded when that sell was placed).
    resting?: RestingSell[];
}

const usable = (r: RestingSell): boolean => Number.isFinite(r.qty) && r.qty > 0 && Number.isFinite(r.price) && r.price > 0;
const cheapestFirst = (rows: RestingSell[]): RestingSell[] => rows.filter(usable).sort((a, b) => a.price - b.price);

// By how much marking `quantity` units at `ltp` overstates them when some are covered by limit sells priced below it. Never negative. A resting
// quantity above `quantity` is ignored beyond it (the lowest priced sells count first).
export function restingExcess(ltp: number, quantity: number, resting: RestingSell[] | undefined): number {
    let left = quantity;
    let excess = 0;
    for (const r of cheapestFirst(resting ?? [])) {
        if (!(left > 0)) break;
        const q = Math.min(left, r.qty);
        excess += q * Math.max(0, ltp - r.price);
        left -= q;
    }
    return excess;
}

// The leg's priced resting sells, never more than what it still holds less the quantity known to have no sell (sellShortfall). sellQty 0 = none.
export function legRestingSells(leg: RestingLeg): RestingSell[] {
    if (!(leg.sellQty > 0)) return [];
    const rows = Array.isArray(leg.resting) ? leg.resting : [{ qty: leg.sellQty, price: leg.sellPrice }];
    let left = (leg.qty - leg.soldQty) - Math.max(0, Number(leg.sellShortfall) || 0);
    const out: RestingSell[] = [];
    for (const r of cheapestFirst(rows)) {
        if (!(left > 0)) break;
        const qty = Math.min(left, r.qty);
        out.push({ qty, price: r.price });
        left -= qty;
    }
    return out;
}

// Records a placement of `quantity` at `price`. `add` = it rests beside what already rests (otherwise it replaces it). With `add`, call BEFORE the
// leg's sellQty / sellShortfall are updated.
export function noteRestingPlaced(leg: RestingLeg, quantity: number, price: number, add: boolean): void {
    const before = add ? legRestingSells(leg) : [];
    leg.resting = quantity > 0 ? [...before, { qty: quantity, price }] : before;
}

// A sell fill of `quantity` consumes the lowest priced resting sells (they fill first). A leg with no `resting` record is bounded by what it holds.
export function noteRestingFilled(leg: RestingLeg, quantity: number): void {
    if (!Array.isArray(leg.resting)) return;
    let left = quantity;
    const out: RestingSell[] = [];
    for (const r of cheapestFirst(leg.resting)) {
        const used = Math.max(0, Math.min(left, r.qty));
        left -= used;
        if (r.qty - used > 0) out.push({ qty: r.qty - used, price: r.price });
    }
    leg.resting = out;
}

// The record rebuilt at a reconcile from the order side's pending sells. An order tracked before the order side stored prices takes the price this
// leg itself recorded when it placed it; with none recorded (an adopted position) that quantity is left out, so it stays valued at the LTP.
// Call BEFORE the reconcile assumes a sellPrice for a leg that has none.
export function restingFromPending(leg: RestingLeg, pending: { quantity?: unknown; price?: unknown }[]): RestingSell[] {
    const rows = pending.map((p) => ({ qty: Number(p.quantity || 0), price: Number(p.price) }));
    const priced = rows.filter(usable);
    const unpriced = rows.filter((r) => !(r.price > 0) && r.qty > 0).reduce((s, r) => s + r.qty, 0);
    if (unpriced > 0) {
        const recorded = Array.isArray(leg.resting) ? cheapestFirst(leg.resting)[0]?.price : leg.sellPrice;
        if (Number(recorded) > 0) priced.push({ qty: unpriced, price: Number(recorded) });
    }
    return priced;
}
