import WebSocket from 'ws';
import axiosModule from 'axios';
import Log from '../util/Log';
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
        const token = resp.data?.result?.orderToken ?? resp.data?.orderToken ?? resp.data?.result;
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
            Log.log('[AntOrderNotify] WebSocket error:', event);
        };

        this.ws.onclose = () => {
            Log.log('[AntOrderNotify] WebSocket closed');
            this.connected = false;
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            if (!this.manualDisconnect) this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        Log.log(`[AntOrderNotify] Reconnecting in ${this.reconnectDelayMs}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((e) => {
                Log.log('[AntOrderNotify] Reconnect attempt failed:', e);
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

        // norenordno is the confirmed field per AliceBlue's docs; the other
        // names are defensive fallbacks in case behavior differs live.
        const orderNo = data.norenordno ?? data.brokerOrderId ?? data.orderNo;
        if (!orderNo) return;
        const pending = this.pending.get(String(orderNo));
        if (!pending) return;

        const status = data.status ?? data.orderStatus;
        if (status === 'COMPLETE') {
            // Noren convention (matches Shoonya's fill messages elsewhere in
            // this repo - bookkeeping.updateTradeFromPrismMessage): flprc is
            // the fill price. Not yet confirmed for ANT's own 'om' messages
            // specifically since the documented example was a rejection.
            const fillPrice = data.flprc ?? data.averageTradedPrice ?? data.avgprc;
            clearTimeout(pending.timer);
            this.pending.delete(String(orderNo));
            if (!fillPrice) {
                pending.reject(new Error(`ANT order ${orderNo} COMPLETE but no recognizable fill-price field: ${raw}`));
            } else {
                pending.resolve(Number(fillPrice));
            }
        } else if (status === 'REJECTED' || status === 'CANCELLED') {
            clearTimeout(pending.timer);
            this.pending.delete(String(orderNo));
            const reason = data.rejreason ? ` (${data.rejreason})` : '';
            pending.reject(new Error(`ANT order ${orderNo} ${status}${reason}: ${raw}`));
        }
        // Any other status (OPEN/PENDING/TRIGGER_PENDING/...) is an
        // intermediate state - keep waiting.
    }

    // Resolves as soon as this order's COMPLETE push arrives, or rejects on
    // REJECTED/CANCELLED/timeout - no REST polling involved.
    waitForFill(orderNo: string, timeoutMs = 60000): Promise<number> {
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
