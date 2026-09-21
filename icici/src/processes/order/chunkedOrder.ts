import { BrokerExecutor, BuyRequest, Exchange } from './BrokerExecutor';
import { NIFTY_FREEZE_QUANTITY } from '../../constants';
import { splitIntoFreezeQtyChunks } from '../../util/quantityChunks';
import Log from '../../util/Log';

// Broker-agnostic freeze-quantity chunking, built directly on the existing
// BrokerExecutor interface - every broker (Zerodha/ANT/Prism/Breeze) already
// implements buy()/squareOff() as "resolve, place one order, wait for fill,
// record it" for an already-resolved contract, so the chunking loop itself
// needs zero broker-specific code. Any strategy on any broker gets
// freeze-quantity safety for free by routing a large order through these
// instead of calling a broker's single-order function directly.
export interface ChunkedFillResult {
    quantity: number;
    avgPrice: number;
}

export async function buyChunked(
    executor: BrokerExecutor,
    request: BuyRequest,
    freezeQty: number = NIFTY_FREEZE_QUANTITY
): Promise<ChunkedFillResult> {
    const chunks = splitIntoFreezeQtyChunks(request.quantity, freezeQty);
    let filledQty = 0;
    let filledValue = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            const trade = await executor.buy({ ...request, quantity: chunks[i] });
            filledQty += trade.quantity;
            filledValue += trade.quantity * trade.price;
            Log.log(`[order] buyChunked: chunk ${i + 1}/${chunks.length} filled qty=${trade.quantity} @ ${trade.price} for ${request.userId}`);
        } catch (e: any) {
            throw new Error(
                `buyChunked: chunk ${i + 1}/${chunks.length} failed after filling ${filledQty}/${request.quantity} - ` +
                    `${request.quantity - filledQty} qty NOT placed. Manual review required. Underlying error: ${e?.message ?? e}`
            );
        }
    }
    return { quantity: filledQty, avgPrice: filledValue / filledQty };
}

export async function squareOffChunked(
    executor: BrokerExecutor,
    userId: string,
    tradingSymbol: string,
    quantity: number,
    exchange: Exchange,
    freezeQty: number = NIFTY_FREEZE_QUANTITY
): Promise<ChunkedFillResult> {
    const chunks = splitIntoFreezeQtyChunks(quantity, freezeQty);
    let filledQty = 0;
    let filledValue = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            const trade = await executor.squareOff(userId, tradingSymbol, chunks[i], exchange);
            filledQty += trade.quantity;
            filledValue += trade.quantity * trade.price;
            Log.log(`[order] squareOffChunked: chunk ${i + 1}/${chunks.length} filled qty=${trade.quantity} @ ${trade.price} for ${userId}`);
        } catch (e: any) {
            throw new Error(
                `squareOffChunked: chunk ${i + 1}/${chunks.length} failed after selling ${filledQty}/${quantity} - ` +
                    `${quantity - filledQty} qty NOT sold. Manual review required. Underlying error: ${e?.message ?? e}`
            );
        }
    }
    return { quantity: filledQty, avgPrice: filledValue / filledQty };
}
