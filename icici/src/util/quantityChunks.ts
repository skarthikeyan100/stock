// Splits a large order quantity into exchange-compliant chunks, none
// exceeding freezeQty. Standalone/broker-agnostic so it's reusable by any
// strategy placing an order above NIFTY's exchange freeze quantity (see
// NIFTY_FREEZE_QUANTITY in constants.ts) - see
// src/processes/order/chunkedOrder.ts for the actual chunked order-placement
// loop this feeds.
export function splitIntoFreezeQtyChunks(totalQty: number, freezeQty: number): number[] {
    if (totalQty <= 0 || freezeQty <= 0) {
        throw new Error(`splitIntoFreezeQtyChunks: invalid args (totalQty=${totalQty}, freezeQty=${freezeQty})`);
    }
    const chunks: number[] = [];
    let remaining = totalQty;
    while (remaining > 0) {
        const chunk = Math.min(freezeQty, remaining);
        chunks.push(chunk);
        remaining -= chunk;
    }
    return chunks;
}
