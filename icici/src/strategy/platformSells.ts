import Log from '../util/Log';
import OrderClient from '../processes/strategies/OrderClient';

// Evidence that a leg a strategy's reconcile() finds gone was sold by the PLATFORM's own order, not outside it.
// Why (live 2026-11-23): a lock-profits run disables every strategy, then the order process limit-sells every open long under the strategy's own
// userId. A disabled strategy is delivered no fills, so its state file still showed those legs open; the next restart's reconcile saw the broker flat
// and filed them as "closed outside the platform" (ALERT, neutral P&L) although the order process had booked each sell (Trade Sell docs, closedTrades
// rows, the owner ledger). The order process names those sells (bookkeeping.platformSells: a fill whose order id the owner ledger names for this user
// and does not mark foreign); this file decides which of them the strategy has NOT yet seen and how they cover its gone legs. Pure apart from
// readPlatformSells, so it is unit-testable.

export interface PlatformSell { orderId: string; quantity: number; price: number; at: number }

// `since` (YYYY-MM-DD): sells from the start of that day on; absent = today's.
export async function readPlatformSells(userId: string, broker: string, tsym: string, since?: string): Promise<PlatformSell[] | null> {
    try {
        const rows = await OrderClient.getInstance().platformSells(userId, broker, tsym, since);
        return Array.isArray(rows) ? rows : null;
    } catch (e) {
        Log.log(`[${userId}] reconcile: could not read the platform's own sells of ${tsym} (nothing is attributed to the platform, the leg is handled as before):`, e);
        return null;
    }
}

export interface SeenSells {
    ids: Set<string> | null;   // order ids the strategy's fill handler already booked (state written by code that records them); null = a legacy state
    legacyQty: number;         // legacy state only: quantity the strategy already accounted for on this contract (closed legs in full, open legs their soldQty)
}
export interface GoneLeg { id: string; remaining: number }
export interface Allocation {
    orderIds: string[];
    qty: number;                 // what the platform's unseen sells cover (<= the legs' total remaining)
    price: number;               // their quantity-weighted average sell price
    perLeg: Map<string, number>; // quantity booked to each leg (legs in the given order, oldest first)
}

// The sells the strategy has not accounted for yet. null = a legacy state whose boundary falls inside one order (which part was seen is unknown).
export function unseenSells(sells: PlatformSell[], seen: SeenSells): PlatformSell[] | null {
    if (seen.ids) return sells.filter((s) => !seen.ids!.has(s.orderId));
    let skipped = 0;
    let i = 0;
    while (i < sells.length && skipped < seen.legacyQty) { skipped += sells[i].quantity; i++; }
    return skipped > seen.legacyQty ? null : sells.slice(i);
}

/**
 * Which of the platform's sells cover the legs that are gone from the broker. Never guesses:
 *  - an order the strategy already saw (its id is in `seen.ids`) is skipped, so nothing is booked twice;
 *  - a legacy state (no ids recorded) skips the first `legacyQty` lots of the platform's sells and gives up when that boundary falls inside one order;
 *  - an order larger than what is still to cover is not split;
 *  - several legs on one contract are only covered when the sells cover ALL of them (which leg the lots left cannot be told otherwise).
 * null = nothing can be attributed (the caller keeps the neutral close + ALERT).
 */
export function allocatePlatformSells(sells: PlatformSell[], seen: SeenSells, legs: GoneLeg[]): Allocation | null {
    const need = legs.reduce((s, l) => s + Math.max(0, l.remaining), 0);
    if (!(need > 0)) return null;
    const pool = unseenSells(sells, seen);
    if (!pool) return null;
    const taken: PlatformSell[] = [];
    let qty = 0;
    for (const s of pool) {
        if (!(s.quantity > 0) || !(s.price > 0) || qty + s.quantity > need) break;
        taken.push(s);
        qty += s.quantity;
    }
    if (taken.length === 0) return null;
    if (qty < need && legs.length > 1) return null;
    const price = taken.reduce((v, s) => v + s.quantity * s.price, 0) / qty;
    const perLeg = new Map<string, number>();
    let left = qty;
    for (const l of legs) {
        const q = Math.min(Math.max(0, l.remaining), left);
        if (q > 0) perLeg.set(l.id, q);
        left -= q;
    }
    return { orderIds: taken.map((s) => s.orderId), qty, price, perLeg };
}

export interface ReconcileLeg { id: string; tsym: string; qty: number; soldQty: number; status: string }

/**
 * Called from a strategy's reconcile() for the open legs the order side no longer holds, BEFORE they are closed neutral. Per contract: reads the
 * platform's own sells, and books what they cover through `book` (the strategy's own realized-P&L / leg-closing code, no order, no follow-up action).
 * A leg left with quantity after this (not covered, or covered in part) is the caller's to close neutral with the ALERT as before - only a genuinely
 * outside close alerts. `legs` = every leg of the state (used for the legacy seen-quantity); `gone` = the open legs that are not held.
 */
export async function bookPlatformSoldLegs(ctx: {
    tag: string; userId: string; broker: string;
    legs: ReconcileLeg[]; gone: ReconcileLeg[];
    seenIds: Set<string> | null;                      // null = legacy state (see SeenSells)
    markSeen: (orderIds: string[]) => void;
    book: (leg: any, qty: number, price: number) => void;
}): Promise<void> {
    const byTsym = new Map<string, ReconcileLeg[]>();
    for (const l of ctx.gone) byTsym.set(l.tsym, [...(byTsym.get(l.tsym) ?? []), l]);
    for (const [tsym, group] of byTsym) {
        const remaining = (l: ReconcileLeg) => l.qty - l.soldQty;
        const sells = await readPlatformSells(ctx.userId, ctx.broker, tsym);
        if (!sells || sells.length === 0) continue;
        const legacyQty = ctx.legs.filter((l) => l.tsym === tsym).reduce((s, l) => s + (l.status === 'closed' ? l.qty : l.soldQty), 0);
        const alloc = allocatePlatformSells(sells, { ids: ctx.seenIds, legacyQty }, group.map((l) => ({ id: l.id, remaining: remaining(l) })));
        if (!alloc) {
            Log.log(`[${ctx.tag}] reconcile: ${tsym}: the platform's own sells (${sells.map((s) => `${s.quantity}@${s.price.toFixed(2)}`).join(', ')}) do not cover the leg(s) unambiguously (already seen, several legs, or not enough lots) - handled as a close outside the platform`);
            continue;
        }
        for (const l of group) {
            const q = alloc.perLeg.get(l.id);
            if (!q) continue;
            const before = remaining(l);
            ctx.book(l, q, alloc.price);
            Log.log(`[${ctx.tag}] reconcile: ${tsym} ${q} of ${before} lots were sold by the platform's own order(s) ${alloc.orderIds.join(', ')} @ ${alloc.price.toFixed(2)} (the strategy was disabled and was not told) - booked as a normal close${q < before ? `; ${before - q} lots have no platform sell behind them` : ''}`);
        }
        ctx.markSeen(alloc.orderIds);
    }
}
