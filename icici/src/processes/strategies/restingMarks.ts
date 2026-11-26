import { RestingSell, restingExcess } from '../../strategy/restingCover';
import { NonFiniteAlert } from '../../strategy/finiteGuard';
import OrderClient from './OrderClient';

// The resting-sell cap of the profit monitors (globalMaxProfit.ts, overAllMaxProfit.ts), per contract of one user on one broker: the order side's
// pending limit sells (the price it stored at placement) and a Kite GTT target. The quantity they cover is valued at no more than their price
// (restingCover.ts). Everything else, including an order tracked without a price and a target the in-app exit monitor watches (it rests nothing at
// the broker), stays at the live price.

const alert = new NonFiniteAlert();
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const contractKey = (t: { user: string; broker?: unknown; tsym: string }): string => `${t.user}|${String(t.broker || 'kite')}|${t.tsym}`;

// Read BEFORE the trade snapshot it is applied to: a sell that fills in between then shows as closed in the snapshot (an order leaves the pending
// list only after its fill is booked), never as an open row with no cover.
export async function restingByContract(openRows: any[]): Promise<Map<string, RestingSell[]>> {
    const out = new Map<string, RestingSell[]>();
    for (const t of openRows) {
        const key = contractKey(t);
        let rows = out.get(key);
        if (!rows) {
            rows = [];
            out.set(key, rows);
            try {
                const pending: any = await OrderClient.getInstance().getPendingSells(t.user, String(t.broker || 'kite'), t.tsym);
                if (Array.isArray(pending)) for (const p of pending) rows.push({ qty: num(p.quantity), price: num(p.price) });
            } catch (e) {
                alert.report(`${key}:pending`, `[max-profit] could not read the resting sells of ${t.tsym} (${t.user}, ${String(t.broker || 'kite')}) - valued at the live price: ${(e as any)?.message ?? e}`);
            }
        }
        if (t.gttTriggerId != null && num(t.targetPrice) > 0) rows.push({ qty: num(t.quantity), price: num(t.targetPrice) });
    }
    return out;
}

// The value per unit each open row counts at: its mark, lowered by what the contract's resting sells below the mark cover.
export function cappedMarks(openRows: any[], marks: Map<any, number>, resting: Map<string, RestingSell[]>): Map<any, number> {
    const groups = new Map<string, any[]>();
    for (const t of openRows) { const k = contractKey(t); groups.set(k, [...(groups.get(k) ?? []), t]); }
    const out = new Map<any, number>(marks);
    for (const [key, rows] of groups) {
        const quantity = rows.reduce((s, t) => s + num(t.quantity), 0);
        if (!(quantity > 0)) continue;
        // One contract, one tick: the rows share their mark (a row valued from its own stored price keeps its own excess share).
        const perUnit = restingExcess(Math.max(...rows.map((t) => marks.get(t)!)), quantity, resting.get(key)) / quantity;
        if (perUnit > 0) for (const t of rows) out.set(t, marks.get(t)! - perUnit);
    }
    return out;
}
