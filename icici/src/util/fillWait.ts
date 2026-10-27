// What a fill wait learned about an order it has stopped waiting for, after a cancel attempt and a status re-check.
export type FillResult =
    | { outcome: 'full'; avgPrice: number }
    | { outcome: 'partial'; filledQuantity: number; avgPrice: number }
    | { outcome: 'none' };

// The tail every broker's fill wait runs when polling gives up: cancel the order (best effort - an order left resting after we
// stop watching it is an orphan: no bookkeeping, no exit), then ALWAYS re-check, whatever the cancel did. The order can fill
// in the race window (the cancel then fails "already filled"), and reporting "did not fill" makes the caller retry the same
// order - a double fill (2026-10-19: ContinuousStrategy sold a PE leg twice, leaving a naked short). A cancel that succeeds can
// still leave a partial fill behind. Each broker supplies its own cancel and re-check; what it does with the outcome (return
// a price, throw its own error class, treat a failed re-check as fatal or as "did not fill") stays with the caller.
export async function cancelThenRecheck(params: {
    cancel: () => Promise<void>;
    recheck: (cancelFailed: boolean) => Promise<FillResult>;
}): Promise<{ result?: FillResult; cancelError?: unknown; recheckError?: unknown }> {
    let cancelError: unknown;
    try {
        await params.cancel();
    } catch (e) {
        cancelError = e;
    }
    try {
        return { result: await params.recheck(cancelError !== undefined), cancelError };
    } catch (e) {
        return { cancelError, recheckError: e };
    }
}
