import OrderClient from '../processes/strategies/OrderClient';

export type UnconfirmedBuyResolution = { kind: 'none' } | { kind: 'filled'; qty: number; price: number } | { kind: 'unknown'; why: string };

// A buy whose IPC call ended without a result (timeout, unknown fill state) is resolved instead of parking the strategy for a human: cancel
// whatever buy of the contract still rests (a no-op when the order process already cancelled it, as in the 2026-11-13 Breeze incident), then
// read what the broker holds.
//   'none'    - nothing bought: safe to retry
//   'filled'  - `qty` more than before is held (at `price`): book it
//   'unknown' - the broker could not be read or a cancel failed: a human must look
// `heldBefore` is what the strategy already held of this contract before the buy (an add / double-up buy on an open leg): the live quantity
// includes it, so only the excess is the unconfirmed buy. A partial fill before the cancel is therefore booked as that partial, not dropped.
export async function resolveUnconfirmedBuy(
    userId: string, broker: 'kite' | 'ant' | 'breeze' | 'prism', contract: { tradingSymbol: string; premium: number }, heldBefore = 0,
): Promise<UnconfirmedBuyResolution> {
    const client = OrderClient.getInstance();
    try {
        const cancel = await client.cancelRestingLimitBuys(userId, { tradingSymbol: contract.tradingSymbol, broker });
        if (cancel.cancelFailed) return { kind: 'unknown', why: 'the resting buy could not be cancelled' };
        const live = await client.getLiveQuantity(userId, broker, contract.tradingSymbol);
        const bought = Math.max((Number(live) || 0) - Math.max(heldBefore, 0), 0);
        if (bought <= 0 && !(cancel.filledQty > 0)) return { kind: 'none' };
        let price = contract.premium;
        if (heldBefore <= 0) {
            try {
                const trades = await client.getOpenTrades(userId);
                const held = trades.find((t: any) => t.tsym === contract.tradingSymbol && Number(t.quantity) > 0);
                const p = Number(held?.originalEntryPrice ?? held?.price);
                if (p > 0) price = p;
            } catch { /* the premium hint is the fallback entry price */ }
        }
        return { kind: 'filled', qty: bought > 0 ? bought : cancel.filledQty, price };
    } catch (e: any) {
        return { kind: 'unknown', why: String(e?.message ?? e) };
    }
}
