/**
 * How a contractor's approved recommendation or accepted forecast becomes an order: a normal user order (the same manualBuy the frontend's
 * Search & Buy uses) booked under the contractor's own user id (their email). No strategy block is involved. The broker is the user's broker
 * (default kite), the quantity comes from forecast.orders.maxInvestment (bookkeeping.resolveContractorQuantity), the exits are a target and stop
 * in points from the entry, and the admin mirrors it like any user's buy. A contractor never sees or controls any of this.
 * A recommendation (`limit: true`) RESTS as a limit buy at exactly the recommended price (Kite only; the order process attaches the target and stop when it
 * fills). A forecast buys at once at a marketable limit.
 */
import OrderClient from '../processes/strategies/OrderClient';
import { getUser } from '../user';
import { pushUserToOrderProcess } from '../routes/session';
import { Contractor } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The canonical contract string manualBuy takes: NIFTY_24150_CE, TCS_3500_PE. */
export const canonicalContract = (underlying: string, strike: number, right: 'CE' | 'PE') => `${underlying.toUpperCase()}_${strike}_${right}`;

// Contractors (by email) with a buy still waiting for its fill in this process: it can wait BUY_FILL_WAIT and is not a trade yet.
const buying = new Set<string>();

/** True when a trade of this contractor is OPEN now (a trade opened and already closed today does not count - only open trades are checked), or a buy of theirs is still waiting for its fill. */
export async function tradeInProgress(c: Contractor): Promise<boolean> {
    if (buying.has(c.email)) return true;
    const stats = await OrderClient.getInstance().stats(c.email);
    return (stats.trades ?? []).some((t: any) => t.user === c.email && t.open !== false);
}

/**
 * Buys as the user `c.email`: `price` is the entry (sizing reference; with `limit` also the exact limit price), `target` and `stop` are absolute option prices. Throws on a refusal
 * (the order process's own checks, an inactive account, a broker error): the caller decides what that means (the approval is reverted, the forecast is logged).
 */
export async function placeContractorBuy(c: Contractor, o: { underlying: string; strike: number; right: 'CE' | 'PE'; price: number; target: number; stop: number; limit?: boolean; contractorBudget?: { amount: number; strict?: boolean } }): Promise<any> {
    const user = await getUser(c.email);
    if (!user || user.role !== 'contractor') throw new Error(`no contractor user for ${c.email}`);
    if (user.enabled === false) throw new Error(`the account of ${c.email} is disabled`);
    // The order process sizes and gates by the cached settings of the user: make sure this contractor's are there (and flagged as a contractor) before the buy.
    await pushUserToOrderProcess(user, 'contractor order');
    buying.add(c.email);
    try {
        return await OrderClient.getInstance().manualBuy(c.email, {
            contract: canonicalContract(o.underlying, o.strike, o.right), price: o.price, ...(o.limit ? { limitPrice: o.price } : {}),
            targetPoints: round2(o.target - o.price), stopLossPoints: round2(o.price - o.stop),
            ...(o.contractorBudget ? { contractorBudget: o.contractorBudget } : {}),
        } as any);
    } finally {
        buying.delete(c.email);
    }
}

