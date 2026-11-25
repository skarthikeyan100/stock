// A closed leg's follow-up that was lost: the chain strategies (SimpleContinuousStrategy, ScaledHedgedStrategy) buy the next leg from afterLegClosed (a profit
// buys the same right again, a loss the opposite right). When the close is booked by a reconcile (the platform's own sell filled while the strategy was not
// told, live 2026-11-25 12:48 ScaledHedged PE L25) or the follow-up was skipped, the leg stays `hedged: false` and nothing ever hedges it: hedge triggers run
// from option ticks of OPEN legs and the retry only looks at legs marked hedgeWaiting. This picks the leg whose follow-up was lost, from unambiguous
// evidence only, so the caller can mark it hedgeWaiting (state only - a reconcile places no order; the Nifty-tick retry does the buying).

export interface ChainLeg {
    id: string; role: string; parentId?: string; status: string;
    hedged: boolean; hedgeWaiting?: boolean; pendingHedge?: unknown; restarted?: boolean; added?: boolean;
    qty: number; soldQty: number; soldValue: number; entry: number;
}

export interface LostFollowUp { leg: ChainLeg; same: boolean; firstOrderProfit: boolean }

const seq = (id: string): number => { const n = Number(String(id).replace(/\D+/g, '')); return Number.isFinite(n) ? n : -1; };

/**
 * The NEWEST closed leaf of the chain (no leg has it as parent), when it is closed by a platform sell of its whole quantity (soldQty / soldValue are only ever
 * written from a platform Sell fill; an outside close leaves them at 0 and is never healed), its hedge was never bought (hedged false) and nothing is waiting
 * or in flight for it. A deliberate end of a chain never matches: a max-profit / EOD stop is excluded by the caller (isStopped), a closed root that made its
 * target has hedged + restarted set, an outside close carries no sold quantity, a reset() marks the leaves hedged.
 * Only the newest leaf is ever picked: older stale leaves belong to an older cycle.
 */
export function lostFollowUp(legs: ChainLeg[]): LostFollowUp | null {
    const parents = new Set(legs.map((l) => l.parentId).filter((p): p is string => !!p));
    const leaves = legs.filter((l) => l.status === 'closed' && !parents.has(l.id));
    if (leaves.length === 0) return null;
    const leg = leaves.reduce((a, b) => (seq(b.id) > seq(a.id) ? b : a));
    if (leg.hedged || leg.hedgeWaiting || leg.pendingHedge || leg.restarted) return null;
    if (!(leg.qty > 0) || !(leg.soldQty >= leg.qty) || !(leg.soldValue > 0)) return null;
    const same = leg.soldValue / leg.soldQty > leg.entry;
    return { leg, same, firstOrderProfit: leg.role === 'root' && !leg.added && same };
}
