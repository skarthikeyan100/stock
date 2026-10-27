// Marks an error as a DEFINITE refusal: the order never reached the broker (or the broker answered with a rejection and nothing
// filled), so it is safe to retry or re-arm. The order process turns this into the [NOT_PLACED] tag strategies look for. Both flag
// names are set because older code paths read `orderNotPlaced` and newer ones `notPlaced`.
export function markNotPlaced(e: unknown): Error & { notPlaced: true; orderNotPlaced: true } {
    // A copy keeping the original's class and own fields (an AxiosError stays one), never the caller's instance: a shared
    // error rethrown later must not carry this flag to an unrelated failure.
    const err = (e instanceof Error
        ? Object.assign(Object.create(Object.getPrototypeOf(e)), e, { message: e.message, stack: e.stack })
        : new Error(String(e))) as Error & { notPlaced: true; orderNotPlaced: true };
    err.notPlaced = true;
    err.orderNotPlaced = true;
    (err as any).cause = e;
    return err;
}

// True when the error carries the definite-refusal flag.
export function isNotPlaced(e: any): boolean {
    return !!(e?.notPlaced || e?.orderNotPlaced);
}
