import Log from '../util/Log';
import Breeze from './Breeze';
import myEmitter from '../tools/emitter';
import configService from '../prism/ConfigService';

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

interface PendingFill {
    resolve: (price: number) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class BreezeOrderNotifyStream {
    private static instance: BreezeOrderNotifyStream;
    private connected = false;
    private pending = new Map<string, PendingFill>(); // keyed by orderId (best-guess: orderReference)

    static getInstance(): BreezeOrderNotifyStream {
        if (!BreezeOrderNotifyStream.instance) {
            BreezeOrderNotifyStream.instance = new BreezeOrderNotifyStream();
        }
        return BreezeOrderNotifyStream.instance;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            Log.log('[BreezeOrderNotifyStream] Already connected');
            return;
        }
        const breeze = Breeze.getInstance();
        breeze.onOrderNotification((data: any) => this.handleMessage(data));
        breeze.wsConnect();
        await breeze.subscribeFeeds({ getOrderNotification: true });
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
        const pending = this.pending.get(String(orderId));
        if (!pending) {
            Log.log(`[BreezeOrderNotifyStream] Push for order ${orderId} - not one we're waiting on (or field-mapping mismatch)`);
            return;
        }

        const status = data.orderStatus;
        if (status === 'Executed' || status === 'Partially Executed') {
            const fillPrice = Number(data.averageExecutedRate);
            // Confirmed live 2026-09-18: a real "Executed" push resolved with
            // averageExecutedRate=117705646 - the field name is right (matches
            // parseData's decode), but the value on this real payload was
            // garbage (REST getOrderDetail confirmed the true fill was 84).
            // Rather than trust an unbounded push value for money-affecting
            // P&L, sanity-bound it against this app's own configured option
            // price range (config.yml settings.minPrice/maxPrice) and reject
            // (not resolve) on an implausible value - the caller
            // (breezeExecutor.ts's waitForBreezeFill) already falls back to
            // the confirmed-correct Breeze.getFillPrice() REST poll on any
            // rejection, so this only trades push speed for REST reliability
            // on the rare bad payload, never silently records a wrong price.
            const cfg = configService.getConfig().settings;
            const minPrice = cfg?.minPrice ?? 0;
            const maxPrice = cfg?.maxPrice ?? Number.MAX_SAFE_INTEGER;
            if (fillPrice > 0 && fillPrice >= minPrice && fillPrice <= maxPrice) {
                clearTimeout(pending.timer);
                this.pending.delete(String(orderId));
                pending.resolve(fillPrice);
            } else if (status === 'Executed') {
                Log.log(`[BreezeOrderNotifyStream] Executed push for order ${orderId} carried an implausible averageExecutedRate (${data.averageExecutedRate}) - rejecting to force the REST fallback instead of recording a wrong price.`);
                clearTimeout(pending.timer);
                this.pending.delete(String(orderId));
                pending.reject(new Error(`Breeze order ${orderId} push carried an implausible fill price (${data.averageExecutedRate})`));
            }
            // Partially Executed with no plausible rate yet - keep waiting for the next push.
        } else if (status === 'Rejected' || status === 'Cancelled' || status === 'Expired') {
            clearTimeout(pending.timer);
            this.pending.delete(String(orderId));
            pending.reject(new Error(`Breeze order ${orderId} ${status}`));
        }
    }

    // Resolves on this order's Executed push, or rejects on
    // Rejected/Cancelled/Expired/timeout - caller (breezeExecutor.ts) falls
    // back to Breeze.getFillPrice's REST polling on any rejection here.
    waitForFill(orderId: string, timeoutMs = 30000): Promise<number> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(orderId);
                reject(new Error(`Breeze order ${orderId} did not complete within ${timeoutMs}ms (order-notify)`));
            }, timeoutMs);
            this.pending.set(orderId, { resolve, reject, timer });
        });
    }

    disconnect(): void {
        Breeze.getInstance().wsDisconnect();
        this.connected = false;
    }
}

export default BreezeOrderNotifyStream;
