import { BrokerExecutor, BuyRequest, Exchange } from './BrokerExecutor';
import { NIFTY_FREEZE_QUANTITY, SENSEX_FREEZE_QUANTITY } from '../../constants';
import { splitIntoFreezeQtyChunks } from '../../util/quantityChunks';
import Log from '../../util/Log';
import { sleep } from '../../util/sleep';
import { markNotPlaced, isNotPlaced } from '../../util/notPlaced';
import type { ChunkedFillResult } from '../../ipc/orderProtocol';


// Confirmed live 2026-09-23: a burst of back-to-back chunk placements (an
// 8-chunk manual square-off immediately followed by an 8-chunk buyChunked
// retry) got a chunk rejected with HTTP 429 (Kite order-rate limit) -
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
// BrokerExecutor interface - every broker (Kite/ANT/Prism/Breeze) already
// implements buy()/squareOff() as "resolve, place one order, wait for fill,
// record it" for an already-resolved contract, so the chunking loop itself
// needs zero broker-specific code. Any strategy on any broker gets
// freeze-quantity safety for free by routing a large order through these
// instead of calling a broker's single-order function directly.
export type { ChunkedFillResult };

// A chunk whose fill could not be settled may be live or filled: carry those flags (unchanged) onto the error the chunked run
// throws, so no caller retries it.
function carryFillStateFlags(target: Error, cause: any): void {
    if (cause?.fillStateUnknown || cause?.orderMayBeLive) Object.assign(target, { fillStateUnknown: !!cause.fillStateUnknown, orderMayBeLive: !!cause.orderMayBeLive });
}

export async function buyChunked(
    executor: BrokerExecutor,
    request: BuyRequest,
    // Defaults to the request's own exchange's freeze limit - found on review:
    // this used to always default to NIFTY's (much larger) limit regardless
    // of exchange, which for an un-chunked BFO (SENSEX) order above 1000
    // would get rejected by the exchange outright instead of being split.
    freezeQty: number = request.exchange === 'BFO' ? SENSEX_FREEZE_QUANTITY : NIFTY_FREEZE_QUANTITY
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
            Log.log(`[order] buyChunked: ${request.tradingSymbol} chunk ${i + 1}/${chunks.length} filled qty=${trade.quantity} @ ${trade.price} for ${request.userId} (bought ${filledQty}/${request.quantity})`);
        } catch (e: any) {
            if (e?.driftCancelled && !e.fillStateUnknown) {
                // Fold in any partial fill THIS chunk contributed before being
                // cancelled (kiteExecutor.ts already recorded it via
                // finalizeEntry/bookkeeping - this is just keeping buyChunked's
                // own running total in sync so the caller sizes its exit sell
                // for what's actually held, not less).
                if (e.filledQuantity > 0) {
                    filledQty += e.filledQuantity;
                    filledValue += e.filledQuantity * e.averagePrice;
                }
                if (filledQty > 0) {
                    // The booked lots are what the caller must size its exit for, so they are returned, not thrown away. A cancel
                    // that FAILED leaves the remainder resting live and able to fill later: the result says so.
                    const live = !!e.orderMayBeLive;
                    Log.log(`[order] ${live ? 'ALERT: ' : ''}buyChunked: ${request.tradingSymbol} chunk ${i + 1}/${chunks.length} drift-cancelled - keeping reduced fill ${filledQty}/${request.quantity} for ${request.userId}${live ? ' - the cancel of the unfilled remainder FAILED, it may still be resting live at the broker, manual review required' : ''}. ${e.message}`);
                    return { quantity: filledQty, avgPrice: filledValue / filledQty, ...(live ? { orderMayBeLive: true as const } : {}) };
                }
            } else if (e?.partial && e.filledQuantity > 0) {
                // Prism's partial-then-cancel error (buyOnPrism has already booked it): keep the thrown filledQuantity in step with bookkeeping.
                filledQty += e.filledQuantity;
                filledValue += e.filledQuantity * e.averagePrice;
            }
            // filledQuantity/averagePrice carried on the error: earlier chunks are real, already-booked positions, so a
            // caller must be able to tell a partial entry from a clean failure.
            const buyErr = Object.assign(new Error(
                `buyChunked: chunk ${i + 1}/${chunks.length} failed after filling ${filledQty}/${request.quantity} - ` +
                    `${request.quantity - filledQty} qty NOT placed. Manual review required. Underlying error: ${e?.message ?? e}`
            ), { filledQuantity: filledQty, averagePrice: filledQty > 0 ? filledValue / filledQty : 0, partial: filledQty > 0 });
            // A clean refusal of the first chunk is still a clean refusal of the whole request.
            carryFillStateFlags(buyErr, e);
            throw i === 0 && isNotPlaced(e) ? markNotPlaced(buyErr) : buyErr;
        }
    }
    return { quantity: filledQty, avgPrice: filledQty > 0 ? filledValue / filledQty : 0 };
}

export async function squareOffChunked(
    executor: BrokerExecutor,
    userId: string,
    tradingSymbol: string,
    quantity: number,
    exchange: Exchange,
    // Same exchange-aware default as buyChunked above.
    freezeQty: number = exchange === 'BFO' ? SENSEX_FREEZE_QUANTITY : NIFTY_FREEZE_QUANTITY
): Promise<ChunkedFillResult> {
    const chunks = splitIntoFreezeQtyChunks(quantity, freezeQty);
    let filledQty = 0;
    let filledValue = 0;
    for (let i = 0; i < chunks.length; i++) {
        await throttleOrderPlacement();
        try {
            const trade = await executor.squareOff(userId, tradingSymbol, chunks[i], exchange);
            if (trade.status === 'PENDING') {
                // The exit was placed but its fill is not confirmed (ANT's re-price chain owns it). It is NOT sold, and no further chunk
                // may be placed: the next chunk would cancel that resting sell and size itself from what is left, never re-covering
                // this one. Stop and report only the confirmed fills (not thrown: a retry would cancel the live re-priced sell).
                Log.log(`[order] squareOffChunked: chunk ${i + 1}/${chunks.length} exit for ${tradingSymbol} (${userId}) placed but fill unconfirmed (being re-priced) - stopping, ${quantity - filledQty} qty not confirmed sold`);
                break;
            }
            filledQty += trade.quantity;
            filledValue += trade.quantity * trade.price;
            Log.log(`[order] squareOffChunked: chunk ${i + 1}/${chunks.length} filled qty=${trade.quantity} @ ${trade.price} for ${userId}`);
        } catch (e: any) {
            // Fold in any partial fill THIS chunk contributed before giving
            // up (e.g. squareOffOnBreeze's own cancel-retry loop throws with
            // filledQuantity/averagePrice when it sold part of the chunk but
            // couldn't close the rest - see its own comment) - mirrors
            // buyChunked's identical handling above, so the error message
            // reports what's actually still open at the broker rather than
            // understating it by this chunk's already-sold portion.
            if (e?.filledQuantity > 0) {
                filledQty += e.filledQuantity;
                filledValue += e.filledQuantity * e.averagePrice;
            }
            const sellErr = Object.assign(new Error(
                `squareOffChunked: chunk ${i + 1}/${chunks.length} failed after selling ${filledQty}/${quantity} - ` +
                    `${quantity - filledQty} qty NOT sold. Manual review required. Underlying error: ${e?.message ?? e}`
            ), { filledQuantity: filledQty, averagePrice: filledQty > 0 ? filledValue / filledQty : 0, partial: filledQty > 0 });
            // A chunk whose fill could not be settled may be live or filled: carry that on, so no caller retries it.
            carryFillStateFlags(sellErr, e);
            throw i === 0 && isNotPlaced(e) ? markNotPlaced(sellErr) : sellErr;
        }
    }
    return { quantity: filledQty, avgPrice: filledQty > 0 ? filledValue / filledQty : 0 };
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
    // Same exchange-aware default as buyChunked above.
    freezeQty: number = exchange === 'BFO' ? SENSEX_FREEZE_QUANTITY : NIFTY_FREEZE_QUANTITY
): Promise<{ orderIds: string[]; placedQuantity: number }> {
    const chunks = splitIntoFreezeQtyChunks(quantity, freezeQty);
    const orderIds: string[] = [];
    let placedQty = 0;
    for (let i = 0; i < chunks.length; i++) {
        await throttleOrderPlacement();
        try {
            const placed = await executor.squareOffLimit(userId, tradingSymbol, instrumentId, chunks[i], exchange, limitPrice);
            // The quantity actually placed (Kite's never-short guard may clamp it), not the requested chunk size.
            const placedChunkQty = placed.quantity ?? chunks[i];
            orderIds.push(placed.orderId);
            placedQty += placedChunkQty;
            Log.log(`[order] squareOffLimitChunked: chunk ${i + 1}/${chunks.length} placed qty=${placedChunkQty}${placedChunkQty < chunks[i] ? ` (clamped from ${chunks[i]})` : ''} @ ${limitPrice} for ${userId}`);
        } catch (e: any) {
            const limitErr = Object.assign(new Error(
                `squareOffLimitChunked: chunk ${i + 1}/${chunks.length} failed to place after placing ${placedQty}/${quantity} - ` +
                    `${quantity - placedQty} qty NOT resting. Manual review required. Underlying error: ${e?.message ?? e}`
            ), { placedQuantity: placedQty, orderIds: orderIds.slice(), partial: placedQty > 0 });
            throw i === 0 && isNotPlaced(e) ? markNotPlaced(limitErr) : limitErr;
        }
    }
    // A short placement is often benign (a resting chunk filled meanwhile and the guard clamped the new sell), and throwing would
    // lock the slot into manual review while its resting orders are fine - so it is reported in the result and logged.
    if (placedQty < quantity) {
        Log.log(`[order] squareOffLimitChunked: ALERT - only ${placedQty}/${quantity} placed for ${tradingSymbol} (${userId}); a never-short guard clamped a sell. Orders placed: ${orderIds.join(',')}`);
    }
    return { orderIds, placedQuantity: placedQty };
}
