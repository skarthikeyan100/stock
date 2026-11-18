import OrderClient from '../processes/strategies/OrderClient';
import type { BrokerName } from '../util/brokerName';

export type UnconfirmedBuyResolution = { kind: 'none' } | { kind: 'filled'; qty: number; price: number } | { kind: 'unknown'; why: string };

// A buy whose IPC call ended without a result (timeout, unknown fill state) is resolved instead of parking the strategy for a human: cancel
// whatever buy of the contract still rests (a no-op when the order process already cancelled it, as in the 2026-11-13 Breeze incident), then
// read what the broker holds.
//   'none'    - nothing bought: safe to retry
//   'filled'  - `qty` more than before is held by THIS user (at `price`): book it
//   'unknown' - the broker could not be read or a cancel failed: a human must look
// `heldBefore` is what the strategy already held of this contract before the buy (an add / double-up buy on an open leg): the live quantity
// includes it, so only the excess is the unconfirmed buy. A partial fill before the cancel is therefore booked as that partial, not dropped.
export async function resolveUnconfirmedBuy(
    userId: string, broker: BrokerName, contract: { tradingSymbol: string; premium: number }, heldBefore = 0,
): Promise<UnconfirmedBuyResolution> {
    const client = OrderClient.getInstance();
    try {
        const cancel = await client.cancelRestingLimitBuys(userId, { tradingSymbol: contract.tradingSymbol, broker });
        if (cancel.cancelFailed) return { kind: 'unknown', why: 'the resting buy could not be cancelled' };
        const live = await client.getLiveQuantity(userId, broker, contract.tradingSymbol);
        // The broker position is ACCOUNT-wide: another strategy on the same broker account holding the same contract (live 2026-11-18 10:00,
        // Breeze: SimpleContinuous bought 585 of NIFTY23NOV2625300CE while ScaledHedged's buy hit a 429) would be read as this buy having
        // filled. Only what this user's own bookkeeping holds (plus a fill the cancel just caught, not booked yet) can be this strategy's,
        // so the live reading is capped by that.
        const trades = await client.getOpenTrades(userId);
        const ownBooked = trades
            .filter((t: any) => t.tsym === contract.tradingSymbol && (!t.broker || String(t.broker).toLowerCase() === String(broker).toLowerCase()))
            .reduce((sum: number, t: any) => sum + (Number(t.quantity) > 0 ? Number(t.quantity) : 0), 0);
        const own = Math.min(Number(live) || 0, ownBooked + Math.max(Number(cancel.filledQty) || 0, 0));
        const bought = Math.max(own - Math.max(heldBefore, 0), 0);
        if (bought <= 0 && !(cancel.filledQty > 0)) return { kind: 'none' };
        let price = contract.premium;
        if (heldBefore <= 0) {
            const held = trades.find((t: any) => t.tsym === contract.tradingSymbol && Number(t.quantity) > 0);
            const p = Number(held?.originalEntryPrice ?? held?.price);
            if (p > 0) price = p;
        }
        return { kind: 'filled', qty: bought > 0 ? bought : cancel.filledQty, price };
    } catch (e: any) {
        return { kind: 'unknown', why: String(e?.message ?? e) };
    }
}
