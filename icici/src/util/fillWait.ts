import Log from './Log';

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
    label: string; // log prefix, e.g. 'Kite order 123'
    cancel: () => Promise<void>;
    recheck: (cancelFailed: boolean) => Promise<FillResult>;
}): Promise<{ result?: FillResult; cancelFailed: boolean; cancelError?: unknown; recheckError?: unknown }> {
    let cancelFailed = false;
    let cancelError: unknown;
    try {
        await params.cancel();
        Log.log(`[fillWait] ${params.label}: cancelled after the fill wait gave up`);
    } catch (e) {
        cancelFailed = true;
        cancelError = e;
        Log.log(`[fillWait] ${params.label}: cancel FAILED after the fill wait gave up - re-checking status:`, e);
    }
    try {
        return { result: await params.recheck(cancelFailed), cancelFailed, cancelError };
    } catch (e) {
        return { cancelFailed, cancelError, recheckError: e };
    }
}

// The error a fill wait throws when it can no longer tell whether the order filled (the re-check itself failed): never "did not
// fill", which makes the caller retry the same order (double fill). `orderMayBeLive` says the cancel also failed. Not tagged
// driftCancelled: buyChunked keeps a reduced fill for a drift-cancel, and an unknown state is not a clean cancel.
export function fillStateUnknownError(message: string, orderMayBeLive: boolean): Error {
    return Object.assign(new Error(`${message} (fill state UNKNOWN${orderMayBeLive ? ', cancel also failed - order may still be resting' : ''})`), {
        fillStateUnknown: true, orderMayBeLive, filledQuantity: 0, averagePrice: 0,
    });
}
