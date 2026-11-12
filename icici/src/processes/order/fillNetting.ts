/**
 * Pure helpers for rebuilding per-user open positions from raw fill docs (Mongo `Trade`). No I/O so the exact failure
 * shapes of real incidents can be unit-tested (see src/test/fillNetting.test.ts).
 */

export interface FillDoc {
    user?: string;
    action: string;
    quantity: number | string;
    price?: number;
    brokerOrderId?: string;
    entryTime?: Date | string | number;
    [k: string]: any;
}

export interface Lot<T extends FillDoc = FillDoc> {
    doc: T;
    remaining: number;
}

export interface CollapseResult<T extends FillDoc = FillDoc> {
    fills: T[];
    // Order ids that carry fills for more than one user and whose owner could not be decided: the caller must not guess.
    ambiguousOrderIds: string[];
}

/**
 * One broker order has exactly one owner. A broker order id booked under several users (a fill re-booked after a restart
 * under a different user, or a manual-sell reconcile that guessed the user from the contract name; real 2026-10-27: one
 * 1690 Kite sell sat in Mongo under both ContinuousStrategy and BulkPcr-NIFTY) must count once, for its owner.
 * `ownerOf` is the order-owner ledger (written when the order is placed/tracked): when it names one of the users that
 * order id was booked under, that user wins; several users with no ledger answer is ambiguous.
 */
export function collapseFillsByOrderId<T extends FillDoc>(fills: T[], ownerOf: (orderId: string) => string | undefined): CollapseResult<T> {
    const byOrder = new Map<string, T[]>();
    for (const f of fills) {
        const id = f.brokerOrderId ? String(f.brokerOrderId) : '';
        if (!id) continue;
        const list = byOrder.get(id);
        if (list) list.push(f); else byOrder.set(id, [f]);
    }
    const drop = new Set<T>();
    const ambiguousOrderIds: string[] = [];
    for (const [id, docs] of byOrder) {
        if (docs.length < 2) continue;
        const users = Array.from(new Set(docs.map((d) => d.user ?? '')));
        let keep: T | undefined;
        if (users.length === 1) {
            keep = docs[0]; // same user booked it twice: count it once
        } else {
            const owner = ownerOf(id);
            keep = owner !== undefined ? docs.find((d) => (d.user ?? '') === owner) : undefined;
            if (!keep) { ambiguousOrderIds.push(id); continue; }
        }
        for (const d of docs) if (d !== keep) drop.add(d);
    }
    return { fills: fills.filter((f) => !drop.has(f)), ambiguousOrderIds };
}

/**
 * FIFO netting for ONE user's fills in time order: every Sell (a partial one included) consumes the oldest remaining Buy
 * lots; what is left is what the user still holds.
 */
export function netFifoLots<T extends FillDoc>(fills: T[]): Lot<T>[] {
    const lots: Lot<T>[] = [];
    for (const f of fills) {
        const q = Number(f.quantity);
        if (!(q > 0)) continue;
        if (f.action === 'Buy') {
            lots.push({ doc: f, remaining: q });
            continue;
        }
        let toSell = q;
        while (toSell > 0 && lots.length > 0) {
            const use = Math.min(toSell, lots[0].remaining);
            lots[0].remaining -= use;
            toSell -= use;
            if (lots[0].remaining <= 0) lots.shift();
        }
    }
    return lots;
}

/** One closed slice: a Sell fill and the FIFO-matched Buy lots it consumed. */
export interface ClosedPiece<T extends FillDoc = FillDoc> {
    sell: T;
    qty: number;
    /** Quantity-weighted price of the Buy lots this sell consumed. */
    entryPrice: number;
    /** The oldest consumed lot's fill (entry time, strategy, token of the closed position). */
    buy: T;
}

/**
 * FIFO pairing for ONE user's fills of ONE contract, in time order. Same consumption rule as netFifoLots, but it keeps what each Sell
 * closed so a closed-trade row can be written for it. A Sell with no (or too few) Buy lots before it is reported as `unmatched`
 * (a sell of something Mongo never saw bought) - never turned into a closed trade.
 */
export function pairFillsFifo<T extends FillDoc>(fills: T[]): { pieces: ClosedPiece<T>[]; unmatched: { sell: T; qty: number }[] } {
    const lots: Lot<T>[] = [];
    const pieces: ClosedPiece<T>[] = [];
    const unmatched: { sell: T; qty: number }[] = [];
    for (const f of fills) {
        const q = Number(f.quantity);
        if (!(q > 0)) continue;
        if (f.action === 'Buy') {
            lots.push({ doc: f, remaining: q });
            continue;
        }
        if (f.action !== 'Sell') continue;
        let toSell = q;
        let matched = 0;
        let value = 0;
        let first: T | undefined;
        while (toSell > 0 && lots.length > 0) {
            const use = Math.min(toSell, lots[0].remaining);
            matched += use;
            value += use * Number(lots[0].doc.price ?? 0);
            first = first ?? lots[0].doc;
            lots[0].remaining -= use;
            toSell -= use;
            if (lots[0].remaining <= 0) lots.shift();
        }
        if (matched > 0 && first) pieces.push({ sell: f, qty: matched, entryPrice: value / matched, buy: first });
        if (toSell > 0) unmatched.push({ sell: f, qty: toSell });
    }
    return { pieces, unmatched };
}
