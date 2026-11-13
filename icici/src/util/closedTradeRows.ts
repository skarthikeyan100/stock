// One row per closed trade for /strategyPnl?closed=1 (scripts/strategy-status.sh users). Pure, so it is unit-tested (src/test/closedTradeRows.test.ts).
// The closed row (Mongo closedTrades, in-memory stats.closedTrades) carries entryPrice/exitPrice; a row built from a Trade object may carry
// price instead of entryPrice. Nothing on the row says it is an admin mirror of another user's buy (the mirror writes only Mongo mirrorLegs), so
// there is deliberately no mirrored flag here.
import { isOpenedToday } from './openedToday';

export interface ClosedTradeRow {
    strategy: string; user: string; broker: string; tsym: string; quantity: number;
    entryPrice: number | null; exitPrice: number | null; realizedPnL: number;
    entryTime: string | null; exitTime: string | null;
}

const num = (v: unknown): number | null => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
const iso = (v: unknown): string | null => { if (v == null || v === '') return null; const d = new Date(v as any); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };

/** Closed rows passing the match regex (on strategy, else user, as the grouped route does) and, when todayOnly, opened today; oldest exit first. */
export function closedTradeRows(closed: any[], re: RegExp | null, todayOnly: boolean, now: number = Date.now()): ClosedTradeRow[] {
    return closed
        .filter((t) => (!re || re.test(t.strategy || t.user || '')) && (!todayOnly || isOpenedToday(t.entryTime, now)))
        .map((t) => ({
            strategy: t.strategy || t.user || '(none)', user: String(t.user ?? ''), broker: String(t.broker || 'kite'), tsym: String(t.tsym ?? ''),
            quantity: Number(t.quantity) || 0, entryPrice: num(t.entryPrice ?? t.price), exitPrice: num(t.exitPrice ?? t.sellPrice),
            realizedPnL: +(Number(t.realizedPnL) || 0).toFixed(2), entryTime: iso(t.entryTime), exitTime: iso(t.exitTime),
        }))
        .sort((a, b) => (a.exitTime ?? '').localeCompare(b.exitTime ?? ''));
}
