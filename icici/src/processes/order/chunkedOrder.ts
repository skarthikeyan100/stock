import { BrokerExecutor, BuyRequest, Exchange } from './BrokerExecutor';
import { NIFTY_FREEZE_QUANTITY } from '../../constants';
import { splitIntoFreezeQtyChunks } from '../../util/quantityChunks';
import Log from '../../util/Log';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed live 2026-09-23: a burst of back-to-back chunk placements (an
// 8-chunk manual square-off immediately followed by an 8-chunk buyChunked
// retry) got a chunk rejected with HTTP 429 (Zerodha order-rate limit) -
// there was previously zero delay between chunks. A per-call "skip the
// delay after the last chunk" loop isn't enough on its own, since it does
// nothing to space out the boundary BETWEEN two separate chunked calls -
// exactly the sequence that triggered the 429 above (squareOffChunked's
// last chunk immediately followed by a fresh buyChunked's first chunk).
// Tracked here at module scope instead, shared across all three helpers
// below and across separate calls to any of them, so it throttles actual
// order-placement rate rather than just intra-call spacing.
const INTER_CHUNK_DELAY_MS = 1000;
let lastOrderPlacedAt = 0;

// Loops (rather than a single check-then-sleep-then-write) so two calls
// racing under BulkPcrStrategy's concurrent multi-broker entry
// (Promise.allSettled over enterOnBroker) can't both compute "no sleep
// needed" against the same stale lastOrderPlacedAt and then both write
// almost simultaneously after waking from unrelated sleeps - confirmed live
// 2026-09-23 that a single check-then-write version let exactly that happen,
// reproducing the 429 this throttle exists to prevent. Each iteration
// re-reads lastOrderPlacedAt fresh; since there's no await between the final
// passing check and the write, no other concurrent caller can observe a
// stale value in between (single-threaded JS - that stretch runs atomically).
async function throttleOrderPlacement(): Promise<void> {
    while (true) {
        const elapsed = Date.now() - lastOrderPlacedAt;
        if (elapsed >= INTER_CHUNK_DELAY_MS) break;
        await sleep(INTER_CHUNK_DELAY_MS - elapsed);
    }
    lastOrderPlacedAt = Date.now();
}

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
        await throttleOrderPlacement();
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
        await throttleOrderPlacement();
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
        await throttleOrderPlacement();
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
