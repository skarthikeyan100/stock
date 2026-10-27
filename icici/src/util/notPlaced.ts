// Marks an error as a DEFINITE refusal: the order never reached the broker (or the broker answered with a rejection and nothing
// filled), so it is safe to retry or re-arm. The order process turns this into the [NOT_PLACED] tag strategies look for. Both flag
// names are set because older code paths read `orderNotPlaced` and newer ones `notPlaced`.
export function markNotPlaced(e: unknown): Error & { notPlaced: true; orderNotPlaced: true } {
    const err = (e instanceof Error ? e : new Error(String(e))) as Error & { notPlaced: true; orderNotPlaced: true };
    err.notPlaced = true;
    err.orderNotPlaced = true;
    return err;
}
