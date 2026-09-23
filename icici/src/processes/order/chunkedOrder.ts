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

// LIMIT-priced counterpart of squareOffChunked above - places resting sell
// orders at `limitPrice` and returns as soon as they're all placed, WITHOUT
// waiting for fills (a resting limit order may take arbitrarily long to
// fill, or never fill if price never reaches it - see BrokerExecutor.squareOffLimit's
// comment). Each chunk's eventual fill round-trips back to the caller later
// via the normal bookkeeping.recordFill -> onFill -> strategy.updateTrade
// path, not via this function's return value.
export async function squareOffLimitChunked(
    executor: BrokerExecutor,
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: Exchange,
    limitPrice: number,
    freezeQty: number = NIFTY_FREEZE_QUANTITY
): Promise<{ orderIds: string[] }> {
    if (!executor.squareOffLimit) {
        throw new Error(`squareOffLimitChunked: broker '${executor.brokerName}' does not support a limit-priced square-off`);
    }
    const chunks = splitIntoFreezeQtyChunks(quantity, freezeQty);
    const orderIds: string[] = [];
    let placedQty = 0;
    for (let i = 0; i < chunks.length; i++) {
        try {
            const { orderId } = await executor.squareOffLimit(userId, tradingSymbol, instrumentId, chunks[i], exchange, limitPrice);
            orderIds.push(orderId);
            placedQty += chunks[i];
            Log.log(`[order] squareOffLimitChunked: chunk ${i + 1}/${chunks.length} placed qty=${chunks[i]} @ ${limitPrice} for ${userId}`);
        } catch (e: any) {
            throw new Error(
                `squareOffLimitChunked: chunk ${i + 1}/${chunks.length} failed to place after placing ${placedQty}/${quantity} - ` +
                    `${quantity - placedQty} qty NOT resting. Manual review required. Underlying error: ${e?.message ?? e}`
            );
        }
    }
    return { orderIds };
}
