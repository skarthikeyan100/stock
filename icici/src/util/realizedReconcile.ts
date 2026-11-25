// Same-day check that the platform's closed-trade totals equal each broker's own realized P&L, per broker and per contract (pure, no I/O).
//
// Why: a fill the platform dropped (live 2026-11-25: an ANT buy whose Noren-style order id equalled an earlier Prism order's id) leaves the strategy's own
// books right but the platform's per-broker closedTrades short of the broker's realized P&L, and nothing said so until a person compared the books by hand.
// This module is the comparison. It is used by the platform's end-of-day sync (bookkeeping.collectRealizedMismatches -> an ALERT line per contract) and by
// `scripts/strategy-status.sh reconcile` (src/tools/reconcileRealized.ts, read-only), so both print the same figures.
//
// Broker convention = the one `status net` uses: kite, ant and prism DAY-AVERAGE (realized = sold qty x (avg sell - avg buy) when the day nets long, bought qty x
// (avg sell - avg buy) when it nets short), breeze FIFO per contract from its trade book (its position average is the average of the lots still open).
import { INDEX_LOT_SIZE } from '../constants';

export interface BookFill { tsym: string; action: 'Buy' | 'Sell'; qty: number; price: number; orderId?: string; at?: number }

export const RUPEES_PER_LOT_TOLERANCE = 1.5;

// kite/ant/prism: realized of one contract's day from its totals (same split as `status net`).
function dayAverage(fills: BookFill[]): number {
    let bq = 0, bv = 0, sq = 0, sv = 0;
    for (const f of fills) { if (f.action === 'Buy') { bq += f.qty; bv += f.qty * f.price; } else { sq += f.qty; sv += f.qty * f.price; } }
    const q = bq - sq;
    if (q >= 0) { const ab = bq > 0 ? bv / bq : 0; return sq > 0 ? sv - sq * ab : 0; }
    const as = sq > 0 ? sv / sq : 0; return bq > 0 ? bq * as - bv : 0;
}

// breeze: FIFO per contract; `fills` must be oldest first. A lot is signed (+ long, - short); an opposite fill consumes the oldest open lots first.
function fifo(fills: BookFill[]): number {
    const lots: { q: number; px: number }[] = [];
    let r = 0;
    for (const f of fills) {
        let left = f.qty; const sgn = f.action === 'Buy' ? 1 : -1;
        while (left > 0 && lots.length && Math.sign(lots[0].q) === -sgn) {
            const l = lots[0], n = Math.min(left, Math.abs(l.q));
            r += n * (l.q > 0 ? f.price - l.px : l.px - f.price);
            l.q -= Math.sign(l.q) * n; left -= n; if (l.q === 0) lots.shift();
        }
        if (left > 0) lots.push({ q: sgn * left, px: f.price });
    }
    return r;
}

// Broker realized per contract from the day's fills. Returns null for breeze when a row has no usable time (FIFO needs the order).
export function brokerRealizedByContract(broker: string, fills: BookFill[]): Map<string, number> | null {
    const by = new Map<string, BookFill[]>();
    for (const f of fills) { if (!(f.qty > 0)) continue; by.set(f.tsym, [...(by.get(f.tsym) ?? []), f]); }
    const out = new Map<string, number>();
    for (const [tsym, list] of by) {
        if (broker === 'breeze') {
            if (list.some((f) => f.at == null)) return null;
            out.set(tsym, fifo([...list].sort((a, b) => (a.at! - b.at!))));
        } else out.set(tsym, dayAverage(list));
    }
    return out;
}

export function lotSizeOfTsym(tsym: string): number {
    if (/^NIFTY(?!BANK)/i.test(tsym)) return INDEX_LOT_SIZE.NIFTY;
    if (/^SENSEX/i.test(tsym)) return INDEX_LOT_SIZE.SENSEX;
    return 1;
}

export interface PlatformClosedRow { tsym: string; realizedPnL: number; quantity: number }
export function platformRealizedByContract(rows: PlatformClosedRow[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.tsym, (out.get(r.tsym) ?? 0) + (Number(r.realizedPnL) || 0));
    return out;
}

export interface RealizedDiff {
    broker: string; tsym: string; brokerRealized: number; platformRealized: number; diff: number; tolerance: number;
    cause: string;
}

// Contracts where the platform's realized differs from the broker's by more than `tolerancePerLot` x lots (lots = the contract's traded quantity / its lot
// size, at least 1). `qtyOf` = traded quantity per contract (sold quantity is enough). `explain` supplies the likely cause (default: generic).
export function compareRealized(
    broker: string,
    brokerMap: Map<string, number>,
    platformMap: Map<string, number>,
    qtyOf: (tsym: string) => number,
    explain: (tsym: string, diff: number) => string = () => 'average-price / pairing difference, or a manual order outside the platform',
    tolerancePerLot = RUPEES_PER_LOT_TOLERANCE,
): RealizedDiff[] {
    const out: RealizedDiff[] = [];
    const contracts = new Set<string>([...brokerMap.keys(), ...platformMap.keys()]);
    for (const tsym of [...contracts].sort()) {
        const b = brokerMap.get(tsym) ?? 0, p = platformMap.get(tsym) ?? 0;
        const lots = Math.max(1, Math.round(qtyOf(tsym) / lotSizeOfTsym(tsym)));
        const tol = tolerancePerLot * lots;
        const diff = p - b;
        if (Math.abs(diff) > tol) out.push({ broker, tsym, brokerRealized: +b.toFixed(2), platformRealized: +p.toFixed(2), diff: +diff.toFixed(2), tolerance: +tol.toFixed(2), cause: explain(tsym, diff) });
    }
    return out;
}

// The likely cause of one contract's gap from what is stored. Pure: the caller reads the evidence.
//  brokerFills: the broker's day fills of the contract; stored: `${action}|${brokerOrderKey}` of every raw Trade doc of the broker; keyOf: the composite key;
//  otherBrokerIds: raw order ids of these fills that ALSO exist on another broker's raw docs (an id collision); closedSellKeys: order keys of the contract's
//  Sell fills that have a closedTrades row (null = not known); storedSells: the contract's Sell fills in Trade ('Sell|<key>' present in `stored`).
export function likelyCause(
    brokerFills: BookFill[], stored: Set<string>, keyOf: (orderId: string) => string, otherBrokerIds: Set<string>, diff: number,
    sellsWithoutClosedRow: string[],
): string {
    const missing = brokerFills.filter((f) => f.orderId && !stored.has(`${f.action}|${keyOf(f.orderId)}`));
    if (missing.length > 0) {
        const ids = [...new Set(missing.map((f) => `${f.action} ${f.orderId}`))].join(', ');
        const coll = missing.filter((f) => otherBrokerIds.has(String(f.orderId)));
        return coll.length > 0
            ? `broker fill(s) ${ids} have no raw Trade doc and the same order id exists on another broker: an order-id collision dropped the fill`
            : `broker fill(s) ${ids} have no raw Trade doc: never booked (run the sync)`;
    }
    if (sellsWithoutClosedRow.length > 0) return `Sell fill(s) ${sellsWithoutClosedRow.join(', ')} are stored but have no closedTrades row (run the sync: repairedClosed)`;
    return diff < 0
        ? 'every broker fill is stored: the platform paired them to a lower P&L (average-price / pairing difference) or a manual order sits in the broker book'
        : 'every broker fill is stored: the platform paired them to a higher P&L (average-price / pairing difference) or a booking was duplicated';
}
