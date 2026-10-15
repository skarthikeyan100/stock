import WebSocket from 'ws';
import axiosModule from 'axios';
import Log from '../util/Log';
import { isPastMarketClose } from '../util/marketHours';
import TtlBuffer from '../util/TtlBuffer';
import ANT from './ANT';

const axios = axiosModule.create();

// Push-based order-fill notification, replacing ANT.getFillPrice's REST
// polling of orders/history. This is a SEPARATE websocket from AntDataStream
// (market data, wss://ws1.aliceblueonline.com/NorenWS/) - order updates live
// on their own channel: GET .../order-notify/ws/createWsToken for a token,
// then connect to wss://a3.aliceblueonline.com/open-api/order-notify/websocket
// and send {orderToken, userId} to subscribe.
//
// Per AliceBlue's "Webhooks" doc page (the WS variant of order updates, same
// page as the HTTP webhook option):
//   - subscribe: {"orderToken": "<token>", "userId": "<id>"} -> {"status":"Ok"}
//   - heartbeat: {"heartbeat": "h", "userId": "<id>"} every 60s, or the
//     connection is closed as idle (confirmed live: an earlier heartbeat
//     guess of {"t":"h"}, borrowed from the market-data WS protocol, produced
//     a consistent ~5-minute disconnect cycle - this is now fixed).
//   - push messages are Noren/Omnesys 'om' order messages, the SAME family
//     Shoonya's WS uses elsewhere in this codebase (see
//     bookkeeping.updateTradeFromPrismMessage's data.flprc/fillshares/status
//     handling) - documented example:
//     {"t":"om","norenordno":"...","uid":"...","actid":"...","qty":"1",
//      "prc":"0.00","pcode":"I","remarks":"","rejreason":"...","prctyp":"MKT",
//      "ret":"DAY","dscqty":"0","trantype":"B","exch":"NSE","tsym":"MRF-EQ",
//      "status":"REJECTED","reporttype":"Rejected"}
//     The order id is norenordno, not brokerOrderId (a different field name
//     for the same concept than the REST orders/history endpoint uses). Fill
//     price/quantity fields (flprc/fillshares) aren't shown in the
//     documented REJECTED example (nothing to fill) but follow the same
//     Noren convention as Shoonya's fill messages elsewhere in this repo.
//     NOT yet verified against a live push (market closed) - handleMessage
//     still logs every raw message and falls back to a few alternate field
//     names, so this can be corrected quickly once verified live.
//
// BIGGEST UNVERIFIED ASSUMPTION: waitForFill() is keyed by the brokerOrderId
// ANT.placeOrder/placeBracketOrder returns from the REST placeorder call, but
// the WS push reports the order under norenordno instead. These are assumed
// to be the same underlying value under two different field names (both are
// broker order-number strings in a similar date-prefixed numeric format,
// e.g. REST: "26082100061654" / doc's WS example: "24070600000744") - if
// that assumption is wrong, waitForFill will never see a match and will
// always time out. Confirm this by comparing a real REST brokerOrderId
// against the norenordno reported for the same order once the market reopens.

interface PendingFill {
    resolve: (price: number) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class AntOrderNotifyStream {
    private static instance: AntOrderNotifyStream;
    private ws: WebSocket | null = null;
    private connected = false;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectDelayMs = 2000;
    private readonly MAX_RECONNECT_DELAY_MS = 30000;
    private manualDisconnect = false;

    private pending = new Map<string, PendingFill>(); // keyed by brokerOrderId

    // Terminal pushes that arrived with no waiter yet registered - see handleMessage's
    // 2026-10-15 bug-fix comment. Short TTL: this only needs to bridge the gap between a push
    // arriving and the REST placeOrder call returning (observed live as near-instant, well
    // under a second), not to survive indefinitely.
    private recentTerminalPushes = new TtlBuffer<{ fillPrice?: number; error?: Error }>(20000);

    static getInstance(): AntOrderNotifyStream {
        if (!AntOrderNotifyStream.instance) {
            AntOrderNotifyStream.instance = new AntOrderNotifyStream();
        }
        return AntOrderNotifyStream.instance;
    }

    private async getWsToken(): Promise<string> {
        const session = ANT.getInstance().getUserSession();
        if (!session) throw new Error('No active ANT session - login first');
        const resp = await axios.get(
            'https://a3.aliceblueonline.com/open-api/order-notify/ws/createWsToken',
            { headers: { Authorization: `Bearer ${session}` } }
        );
        Log.log('[AntOrderNotify] createWsToken response:', JSON.stringify(resp.data));
        // BUG FIX 2026-10-15: AliceBlue's documented response wraps the token in a one-element
        // ARRAY - {"result":[{"orderToken":"..."}]} - confirmed live today. The old fallback
        // chain (result?.orderToken ?? ... ?? result) never found the string on an array (arrays
        // have no .orderToken property) and fell all the way through to `result` itself - the
        // array object - which then got JSON.stringify'd straight into the subscribe payload as
        // a malformed orderToken on every single connection. AliceBlue silently never recognized
        // it, never marked a session active, and closed the socket every ~5 minutes as "Session
        // inactive" (confirmed via the close-code/reason logging added alongside this fix) -
        // explaining a 100% order-notify push-miss rate (not even the subscribe ack ever arrived).
        const result = resp.data?.result;
        const token = (Array.isArray(result) ? result[0]?.orderToken : result?.orderToken) ?? resp.data?.orderToken;
        if (!token) throw new Error(`ANT createWsToken failed: ${JSON.stringify(resp.data)}`);
        return token;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            Log.log('[AntOrderNotify] Already connected');
            return;
        }

        const orderToken = await this.getWsToken();
        const userId = ANT.getInstance().getUserId();
        if (!userId) throw new Error('userId not available');

        this.ws = new WebSocket('wss://a3.aliceblueonline.com/open-api/order-notify/websocket', undefined, { rejectUnauthorized: false });

        this.ws.onopen = () => {
            Log.log('[AntOrderNotify] Connected, subscribing...');
            this.ws!.send(JSON.stringify({ orderToken, userId }));

            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ heartbeat: 'h', userId }));
                }
            }, 60000); // docs: "every minute" or the connection is closed as idle

            this.connected = true;
            this.reconnectDelayMs = 2000;
        };

        this.ws.onmessage = (event) => {
            const text = typeof event.data === 'string' ? event.data : event.data.toString('utf-8');
            Log.log('[AntOrderNotify] Message:', text);
            this.handleMessage(text);
        };

        this.ws.onerror = (event) => {
            Log.log('[AntOrderNotify] WebSocket error:', (event as any)?.message ?? event);
        };

        // code/reason diagnostic (2026-10-15): the close event carries both, but the handler
        // previously discarded them entirely, leaving no way to tell a clean idle-timeout close
        // apart from an abnormal one - added while investigating a 100% order-notify push-miss
        // rate (zero raw messages ever received, not even the subscribe ack) alongside a steady
        // ~5-minute close/reconnect cycle all afternoon.
        this.ws.onclose = (event: any) => {
            Log.log(`[AntOrderNotify] WebSocket closed (code=${event?.code ?? 'unknown'}, reason=${event?.reason || 'none'}, wasClean=${event?.wasClean ?? 'unknown'})`);
            this.connected = false;
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            if (this.manualDisconnect) return;
            if (isPastMarketClose()) {
                Log.log('[AntOrderNotify] Past market close - not reconnecting');
                return;
            }
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        Log.log(`[AntOrderNotify] Reconnecting in ${this.reconnectDelayMs}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((e) => {
                Log.log('[AntOrderNotify] Reconnect attempt failed:', e);
                if (isPastMarketClose()) {
                    Log.log('[AntOrderNotify] Past market close - not retrying');
                    return;
                }
                this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.MAX_RECONNECT_DELAY_MS);
                this.scheduleReconnect();
            });
        }, this.reconnectDelayMs);
    }

    private handleMessage(raw: string): void {
        let data: any;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        // Only 'om' (order message) carries order state; other message
        // types (subscribe ack {"status":"Ok"}, etc) are ignored here.
        if (data.t && data.t !== 'om') return;

        // norenordno is the confirmed field per AliceBlue's docs (and confirmed live
        // 2026-10-15 to equal the REST brokerOrderId exactly) - the other names are
        // defensive fallbacks in case behavior differs live.
        const orderNo = data.norenordno ?? data.brokerOrderId ?? data.orderNo;
        if (!orderNo) return;
        const key = String(orderNo);

        const status = data.status ?? data.orderStatus;
        let outcome: { fillPrice?: number; error?: Error } | null = null;
        if (status === 'COMPLETE') {
            // Noren convention (matches Shoonya's fill messages elsewhere in this repo -
            // bookkeeping.updateTradeFromPrismMessage): flprc is the fill price - confirmed
            // live 2026-10-15 against a real fill push.
            const fillPrice = data.flprc ?? data.averageTradedPrice ?? data.avgprc;
            outcome = fillPrice
                ? { fillPrice: Number(fillPrice) }
                : { error: new Error(`ANT order ${orderNo} COMPLETE but no recognizable fill-price field: ${raw}`) };
        } else if (ANT.isTerminalRejectOrCancel(status)) {
            const reason = data.rejreason ? ` (${data.rejreason})` : '';
            outcome = { error: new Error(`ANT order ${orderNo} ${status}${reason}: ${raw}`) };
        } else {
            return; // intermediate state (OPEN/PENDING/TRIGGER_PENDING/...) - nothing to resolve yet
        }

        const pending = this.pending.get(key);
        if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(key);
            if (outcome.error) pending.reject(outcome.error); else pending.resolve(outcome.fillPrice!);
            return;
        }

        // BUG FIX 2026-10-15 (confirmed live): no waiter is registered yet. This is NOT
        // necessarily "nobody cares about this order" - the REST placeOrder/placeBracketOrder
        // call that will hand enterPosition this exact orderNo may not have returned yet.
        // Confirmed live: a real bracket buy's COMPLETE fill push arrived and was logged
        // BEFORE placeBracketOrder's own REST response (which is what enterPosition needs
        // before it can call waitForFill(orderNo) at all) - the push was silently dropped
        // here every time, and every entry fell back to the 60s REST poll regardless of the
        // WS otherwise working correctly end to end. Buffer the outcome briefly so a
        // waitForFill registered moments later still sees it.
        Log.log(`[AntOrderNotify] Terminal push for order ${orderNo} - no waiter registered yet, buffering`);
        this.recentTerminalPushes.set(key, outcome);
        // Any other status (OPEN/PENDING/TRIGGER_PENDING/...) is an
        // intermediate state - keep waiting.
    }

    // Resolves as soon as this order's COMPLETE push arrives, or rejects on
    // REJECTED/CANCELLED/timeout - no REST polling involved.
    waitForFill(orderNo: string, timeoutMs = 60000): Promise<number> {
        // See handleMessage's 2026-10-15 bug-fix comment: the push can genuinely arrive before
        // this is even called. Check the buffer first rather than always registering a fresh
        // wait that a past push can never satisfy.
        const buffered = this.recentTerminalPushes.take(orderNo);
        if (buffered) {
            return buffered.error ? Promise.reject(buffered.error) : Promise.resolve(buffered.fillPrice!);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(orderNo);
                reject(new Error(`ANT order ${orderNo} did not complete within ${timeoutMs}ms (order-notify)`));
            }, timeoutMs);
            this.pending.set(orderNo, { resolve, reject, timer });
        });
    }

    disconnect(): void {
        this.manualDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.ws?.close();
        this.ws = null;
        this.connected = false;
    }
}

export default AntOrderNotifyStream;
