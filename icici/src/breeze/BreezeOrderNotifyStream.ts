import Log from '../util/Log';
import Breeze from './Breeze';
import myEmitter from '../tools/emitter';
import configService from '../prism/ConfigService';
import PendingFillRegistry from '../util/PendingFillRegistry';

// Push-based order-fill notification, mirroring AntOrderNotifyStream.ts's
// role (replacing/supplementing Breeze.getFillPrice's REST polling of
// getOrderDetail). Connects via the SAME socket breezeExecutor/BreezeStream
// use (breeze.wsConnect() + subscribeFeeds({getOrderNotification:true})) -
// see Breeze.ts's onQuote/onOrderNotification header comment for why both
// price ticks and order notifications share one underlying SDK callback.
//
// BIGGEST UNVERIFIED ASSUMPTION (matches AntOrderNotifyStream.ts's own
// header caveat pattern): the parsed order-notification object's field names
// come from reading breezeConnect.js's parseData() positional-array decode
// (lines ~531-581) - there is no live-observed push to confirm against as of
// writing (market data confirmed reachable, but this exact push was never
// triggered this session). Two real uncertainties:
//   1. Which field identifies the order for matching against placeOrder's
//      returned order_id - orderReference is the closest-named candidate in
//      parseData's decode list, but this is a guess, not a confirmation.
//   2. The averageExecutedRate field name is confirmed to exist in
//      parseData's decode (both order_dict variants have it, just at
//      different positional indices) but its populated-on-fill behavior
//      hasn't been observed live.
// Falls back to Breeze.getFillPrice's REST polling on timeout/no-match (see
// breezeExecutor.ts), so a wrong guess here degrades to the already-working
// REST path rather than breaking order placement - same fallback shape
// antExecutor.ts's enterPosition already uses for the identical reason.
// Needs live confirmation before being trusted as the primary fill path -
// see ToDo.md.

// Average fill price of an Executed order-notification push, or null when no plausible value is found.
// averageExecutedRate is tried first (it is right in some payloads); when it is zero or outside [minPrice, maxPrice]
// the price in cancelFlag (paise) is used. A limit order's fill can never be on the wrong side of its limit
// (buy <= limitRate, sell >= limitRate, limitRate in paise), which rejects a misparsed number that happens to fall in range.
export function pushFillPrice(data: any, minPrice: number, maxPrice: number): number | null {
    const limit = Number(data?.limitRate) / 100;
    const flow = String(data?.orderFlow ?? '').toLowerCase();
    const plausible = (p: number): boolean => {
        if (!(p > 0) || p < minPrice || p > maxPrice) return false;
        if (limit > 0) {
            if (flow === 'buy' && p > limit + 0.005) return false;
            if (flow === 'sell' && p < limit - 0.005) return false;
        }
        return true;
    };
    const avg = Number(data?.averageExecutedRate);
    if (plausible(avg)) return avg;
    // Truncated to whole paise, like the REST fill price it replaces (89.0676 -> 89.06, not 89.07).
    const fromCancelFlag = Math.floor(Number(data?.cancelFlag)) / 100;
    return plausible(fromCancelFlag) ? fromCancelFlag : null;
}

class BreezeOrderNotifyStream {
    private static instance: BreezeOrderNotifyStream;
    private connected = false;

    // Keyed by orderId (best-guess: orderReference). Handles both settling an already-registered
    // waitForFill call and buffering a terminal push that arrived with no waiter registered yet -
    // mirrors the identical fix in AntOrderNotifyStream.ts (confirmed live 2026-10-15 there: a
    // push can arrive before the REST placeOrder call that hands the caller this orderId even
    // returns, so a waitForFill registered after the fact would otherwise never see a push that
    // already happened).
    private fills = new PendingFillRegistry<number>(20000);

    static getInstance(): BreezeOrderNotifyStream {
        if (!BreezeOrderNotifyStream.instance) {
            BreezeOrderNotifyStream.instance = new BreezeOrderNotifyStream();
        }
        return BreezeOrderNotifyStream.instance;
    }

    private onNotification = (data: any) => this.handleMessage(data);

    async connect(): Promise<void> {
        if (this.connected) {
            Log.log('[BreezeOrderNotifyStream] Already connected');
            return;
        }
        const breeze = Breeze.getInstance();
        // Stable handler: Breeze.onOrderNotification dedupes by identity, so a retried connect()
        // can't double-deliver every fill.
        breeze.onOrderNotification(this.onNotification);
        breeze.wsConnect('BreezeOrderNotifyStream');
        try {
            await breeze.subscribeFeeds({ getOrderNotification: true });
        } catch (e) {
            // Release our hold on the shared socket so a retry starts clean.
            breeze.wsDisconnect('BreezeOrderNotifyStream');
            throw e;
        }
        this.connected = true;
        Log.log('[BreezeOrderNotifyStream] Connected and subscribed to order notifications');
    }

    private handleMessage(data: any): void {
        myEmitter.emit('breeze-order-notify', data);

        // Full raw payload on every push, not just failures - the only way to
        // actually root-cause field-mapping guesses like averageExecutedRate
        // (confirmed live 2026-09-18 to sometimes carry a garbage value even
        // though the field name itself is right) instead of just working
        // around them.
        Log.log('[BreezeOrderNotifyStream] raw push:', JSON.stringify(data));

        const orderId = data.orderReference ?? data.orderPipeId;
        if (!orderId) {
            Log.log('[BreezeOrderNotifyStream] Order notification with no recognizable order id field - raw:', JSON.stringify(data));
            return;
        }
        const key = String(orderId);

        const status = data.orderStatus;
        // Only 'Executed' (the whole order's quantity filled) resolves this
        // wait - 'Partially Executed' must NOT, even if averageExecutedRate
        // already carries a plausible price for the filled-so-far portion.
        // waitForFill's only contract is "the full requested quantity filled
        // at this price"; resolving early on a partial would make every
        // caller (breezeExecutor.ts's waitForBreezeFill) record the FULL
        // requested quantity at a partial fill's price - silently
        // overstating a buy or understating a sell's genuine remainder, the
        // same class of bug as gaps.md's "Partial-fill accounting" entry.
        // A partial push just means keep waiting for the terminal one
        // (Executed, or Rejected/Cancelled/Expired for whatever's left) -
        // the caller's own cancel-then-recheck path (cancelOrderOnBreeze's
        // getBreezeOrderFillInfo) is what correctly captures a partial fill
        // when the remainder is eventually cancelled instead of completing.
        let outcome: { fillPrice?: number; error?: Error } | null = null;
        if (status === 'Executed') {
            // Confirmed live 2026-09-18 and 2026-10-30: on a real "Executed" push averageExecutedRate is 0 or garbage
            // (117705646, 2843100, 48600000 ...). The real average fill price is carried in cancelFlag, in paise
            // (all 7 REST-confirmed Breeze fills on 2026-10-30 equalled cancelFlag / 100; a limit sell's cancelFlag
            // equals its limitRate). pushFillPrice() takes averageExecutedRate when it is plausible and cancelFlag / 100
            // otherwise, and still sanity-bounds the result against this app's own configured option price range
            // (config.yml settings.minPrice/maxPrice) and the order's limit side. On an implausible value we reject
            // (not resolve) - the caller (breezeExecutor.ts's waitForBreezeFill) falls back to the confirmed-correct
            // Breeze.getFillPrice() REST poll, so a bad payload never records a wrong price.
            const cfg = configService.getConfig().settings;
            const fillPrice = pushFillPrice(data, cfg?.minPrice ?? 0, cfg?.maxPrice ?? Number.MAX_SAFE_INTEGER);
            if (fillPrice !== null) {
                outcome = { fillPrice };
            } else {
                Log.log(`[BreezeOrderNotifyStream] Executed push for order ${orderId} carried no plausible fill price (averageExecutedRate=${data.averageExecutedRate}, cancelFlag=${data.cancelFlag}, limitRate=${data.limitRate}) - rejecting to force the REST fallback instead of recording a wrong price.`);
                outcome = { error: new Error(`Breeze order ${orderId} push carried an implausible fill price (${data.averageExecutedRate})`) };
            }
        } else if (status === 'Partially Executed') {
            Log.log(`[BreezeOrderNotifyStream] Partially Executed push for order ${orderId} - not yet the full fill, waiting for a terminal push`);
            return;
        } else if (status === 'Rejected' || status === 'Cancelled' || status === 'Expired') {
            outcome = { error: new Error(`Breeze order ${orderId} ${status}`) };
        } else if (status === 'Ordered' || status === 'Requested' || status === 'Queued') {
            // Non-terminal acknowledgement of a placed (resting) order, e.g. "Ordered" right after placeOrder:
            // nothing to settle, the terminal push (Executed/Cancelled/...) comes later.
            return;
        } else {
            // Found on review: restructuring to classify status before the pending-waiter lookup
            // silently dropped the old diagnostic log for this combination (unrecognized status,
            // whether or not a waiter is registered) - the raw payload is still logged
            // unconditionally above, but this specific note (which flagged a field-mapping
            // mismatch or an unhandled new status) is worth keeping for the same reason it
            // existed before.
            Log.log(`[BreezeOrderNotifyStream] Push for order ${orderId} has an unrecognized status (${status ?? 'none'}) - not one of Executed/Partially Executed/Rejected/Cancelled/Expired`);
            return;
        }

        // BUG FIX 2026-10-15: settle() resolves an already-registered waiter, or buffers the
        // outcome if the REST placeOrder call that will hand the caller this orderId hasn't
        // returned yet (confirmed live for the identical ANT case - see
        // AntOrderNotifyStream.ts's handleMessage) - instead of dropping a push nobody was
        // listening for yet and always falling back to REST.
        this.fills.settle(key, { value: outcome.fillPrice, error: outcome.error });
    }

    // Resolves on this order's Executed push, or rejects on
    // Rejected/Cancelled/Expired/timeout - caller (breezeExecutor.ts) falls
    // back to Breeze.getFillPrice's REST polling on any rejection here.
    waitForFill(orderId: string, timeoutMs = 30000): Promise<number> {
        return this.fills.wait(orderId, timeoutMs, () => new Error(`Breeze order ${orderId} did not complete within ${timeoutMs}ms (order-notify)`));
    }

    disconnect(): void {
        Breeze.getInstance().wsDisconnect('BreezeOrderNotifyStream');
        this.connected = false;
    }
}

export default BreezeOrderNotifyStream;
