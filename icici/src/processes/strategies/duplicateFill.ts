import { Trade } from '../../model/model';
import { orderKey } from '../../util/orderKey';

// Fills already applied, so a duplicate delivery (same broker order + side + size) cannot double-count the net quantity. Keyed by the composite
// '<broker>:<orderId>' (util/orderKey.ts): an ANT fill must not be dropped as the duplicate of a same-id, same-size Prism fill (ids are only unique per broker).
const seenFillKeys = new Set<string>();
export function isDuplicateFill(trade: Pick<Trade, 'brokerOrderId' | 'broker' | 'action' | 'quantity'>): boolean {
    if (!trade.brokerOrderId) return false;
    const key = `${orderKey(trade.broker, trade.brokerOrderId)}|${trade.action}|${trade.quantity}`;
    if (seenFillKeys.has(key)) return true;
    seenFillKeys.add(key);
    if (seenFillKeys.size > 5000) seenFillKeys.delete(seenFillKeys.values().next().value as string);
    return false;
}
export function resetSeenFills(): void { seenFillKeys.clear(); }
