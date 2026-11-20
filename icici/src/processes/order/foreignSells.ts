// Non-platform (manual) sells that took lots out of the platform's own book.
//
// 2026-11-20 NIFTY26NOV25550CE: ContinuousStrategy held 195 (3 buys). The user bought 1755 by hand (11:04) and sold 1755 + 195 (11:06): the extra
// 195 consumed exactly the platform's lots (Kite's net went to 0) while the platform's leg stayed open. The sells of an account are netted per contract, so
// the broker cannot say whose lots a manual sell took. The rule used here: a manual sell first consumes the user's OWN manual buys of the contract (in
// time order, trade by trade); only what is left over came out of lots the platform holds. Pure function, no I/O.

export interface TimedFill {
    orderId: string;
    tradeId: string;
    action: 'Buy' | 'Sell';
    tsym: string;
    qty: number;
    price: number;
    at: number; // fill time, epoch ms
    token?: string; // the broker's own instrument id when the row carries it (ant instrumentId, prism token)
    aliases?: string[]; // other spellings of the same contract (breeze's old expiry-less tsym)
}

// Equal-width numeric ids compare numerically (BigInt: broker ids exceed 2^53), anything else as text; never NaN.
export function compareIds(a: string, b: string): number {
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
}

export interface ForeignSellPiece {
    orderId: string;
    qty: number; // the part of this (non-platform) sell order that is NOT covered by the user's own manual buys
    price: number; // average of the trade-book rows that make up that part
    at: number; // newest row's time
    tradeIds: string[];
}

export interface ForeignExcess {
    pieces: ForeignSellPiece[]; // chronological
    foreignBuyQty: number;
    foreignSellQty: number;
    excessQty: number;
}

// `fills` = one contract's trade-book rows; `isPlatformOrder` says an order was placed/booked by this platform (those rows are ignored).
// `maxSellAt`: a non-platform sell newer than this is left out (its own booking - e.g. a GTT fill - may still be on its way).
// `minSellAt`: a sell OLDER than this cannot have taken the platform's lots (they were bought later - live 2026-11-20 the 10:37 manual sell of 1755 @109
// predates ContinuousStrategy's buys at 10:53-10:59 and was wrongly booked by the sync as the sale of its 195): it still consumes the user's own
// manual lots (inventory) but never becomes a piece.
export function foreignSellExcess(fills: TimedFill[], isPlatformOrder: (orderId: string) => boolean, maxSellAt = Infinity, minSellAt = -Infinity): ForeignExcess {
    const foreign = fills
        .filter((f) => f.qty > 0 && !isPlatformOrder(f.orderId))
        .sort((a, b) => a.at - b.at || compareIds(a.tradeId, b.tradeId));
    let inventory = 0;
    let foreignBuyQty = 0;
    let foreignSellQty = 0;
    const byOrder = new Map<string, { qty: number; value: number; at: number; tradeIds: string[] }>();
    for (const f of foreign) {
        if (f.action === 'Buy') { inventory += f.qty; foreignBuyQty += f.qty; continue; }
        if (f.at > maxSellAt) continue;
        foreignSellQty += f.qty;
        const fromOwn = Math.min(inventory, f.qty);
        inventory -= fromOwn;
        const rest = f.qty - fromOwn;
        if (rest <= 0 || f.at < minSellAt) continue;
        const cur = byOrder.get(f.orderId) ?? { qty: 0, value: 0, at: 0, tradeIds: [] };
        cur.qty += rest; cur.value += rest * f.price; cur.at = Math.max(cur.at, f.at); cur.tradeIds.push(f.tradeId);
        byOrder.set(f.orderId, cur);
    }
    const pieces = Array.from(byOrder, ([orderId, v]) => ({ orderId, qty: v.qty, price: v.value / v.qty, at: v.at, tradeIds: v.tradeIds }))
        .sort((a, b) => a.at - b.at);
    return { pieces, foreignBuyQty, foreignSellQty, excessQty: pieces.reduce((s, p) => s + p.qty, 0) };
}

// The pieces that explain `shortfall` lots: the NEWEST first (a manual sell consumes the user's own lots before the platform's, so the earlier
// sells are the user's), each cut to what is still needed. Returned oldest first, for booking in time order.
export function piecesForShortfall(pieces: ForeignSellPiece[], shortfall: number): ForeignSellPiece[] {
    let need = shortfall;
    const out: ForeignSellPiece[] = [];
    for (const p of [...pieces].reverse()) {
        if (need <= 0) break;
        const qty = Math.min(p.qty, need);
        need -= qty;
        out.push({ ...p, qty });
    }
    return out.reverse();
}
