// Marks an error as a DEFINITE refusal: the order never reached the broker (or the broker answered with a rejection and nothing
// filled), so it is safe to retry or re-arm. The order process turns this into the [NOT_PLACED] tag strategies look for. Both flag
// names are set because older code paths read `orderNotPlaced` and newer ones `notPlaced`.
export function markNotPlaced(e: unknown): Error & { notPlaced: true; orderNotPlaced: true } {
    // A copy, never the caller's instance: a shared error rethrown later must not carry this flag to an unrelated failure.
    const err = Object.assign(new Error(e instanceof Error ? e.message : String(e)), e instanceof Error ? e : {}, {
        notPlaced: true as const,
        orderNotPlaced: true as const,
    });
    (err as any).cause = e;
    if (e instanceof Error) {
        err.name = e.name;
        err.stack = e.stack;
    }
    return err;
}

// True when the error (or the one it wraps) is a definite refusal.
export function isNotPlaced(e: any): boolean {
    return !!(e?.notPlaced || e?.orderNotPlaced);
}
