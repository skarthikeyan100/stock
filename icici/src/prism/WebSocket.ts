import Log from '../util/Log';
let web_socket = require("ws");

let API = require("./config").default;


class WebSocketClient {

    private ws;
    private apikey;
    private url;
    private timeout;
    private heartbeat: NodeJS.Timeout | null = null;
    private disposed = false;
    // Per-instance (was a module-level global): a second client would otherwise inherit and
    // double-fire every callback registered by the first.
    private triggers: Record<string, ((...a: any[]) => void)[]> = {
        "open": [],
        "quote": [],
        "order": [],
        "close": [],
        "error": [],
    };
    constructor(cred) {
        this.apikey = cred.apikey;
        this.url = cred.url
        this.timeout = API.heartbeat || 3000;
    }

    connect = (params, callbacks) => {
        Log.log('WS Connect is called')
        return new Promise((resolve, reject) => {
            if (this.apikey === null || this.url === null) { reject(new Error("apikey or url is missing")); return; }

            //callbacks to the app are set here
            this.set_callbacks(callbacks);

            this.ws = new web_socket(this.url, undefined);

            const ws = this.ws;
            this.ws.onopen = (evt) => {
                if (this.heartbeat) clearInterval(this.heartbeat);
                this.heartbeat = setInterval(() =>  {
                    if (ws.readyState !== 1) return;
                    var _hb_req = '{"t":"h"}';
                    try { ws.send(_hb_req); } catch (e) { Log.log('Prism WS heartbeat send failed:', e); }
                }, this.timeout);

                //prepare the data
                // OAuth sessions authenticate via "t":"a" + accesstoken (server replies "ak"),
                // not the legacy "t":"c" + susertoken handshake (QuickAuth is deprecated for this account).
                let values = { "t": "a" };
                values["uid"] = params.uid;
                values["actid"] = params.actid;
                values["accesstoken"] = params.apikey;
                values["source"] = "API";
                this.ws.send(JSON.stringify(values));
                // resolve()

            };
            this.ws.onmessage = (evt) => {
                let result;
                try {
                    result = JSON.parse(evt.data);
                } catch (e) {
                    Log.log('Prism WS: unparseable message ignored');
                    return;
                }
                // Log.log('Result from socket: ', result);

                if (result.t == 'ck' || result.t == 'ak') {
                    // Settle the connect() promise (it used to stay pending forever) - but only an OK ack means authenticated.
                    if (String(result.s ?? 'OK').toUpperCase() !== 'OK') {
                        reject(new Error(`Prism WS rejected the login: ${JSON.stringify(result).slice(0, 200)}`));
                        return; // listeners must not treat a refused login as an open, authenticated stream
                    }
                    resolve(result);
                    this.trigger("open", [result]);
                }
                if (result.t == 'tk' || result.t == 'tf') {
                    this.trigger("quote", [result]);
                }
                if (result.t == 'dk' || result.t == 'df') {
                    this.trigger("quote", [result]);
                }
                if (result.t == 'om') {
                    this.trigger("order", [result]);
                }

            };
            this.ws.onerror = (evt) => {
                Log.log("error::", evt)
                this.trigger("error", [JSON.stringify(evt.data)]);
                // The 'close' event that follows drives reconnection (via socket_close); ws has no connect().
                reject(evt)
            };
            this.ws.onclose =  (evt) => {
                Log.log("Socket closed")
                if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
                reject(new Error('Prism WS closed before it was acknowledged')); // no-op once resolved
                this.trigger("close", [JSON.stringify(evt.data)]);
            };
        })
    }

    set_callbacks = (callbacks) => {
        if (callbacks.socket_open !== undefined) {
            this.on('open', callbacks.socket_open);
        }
        if (callbacks.socket_close !== undefined) {
            this.on('close', callbacks.socket_close);
        }
        if (callbacks.socket_error !== undefined) {
            this.on('error', callbacks.socket_error);
        }
        if (callbacks.quote !== undefined) {
            this.on('quote', callbacks.quote);
        }
        if (callbacks.order !== undefined) {
            this.on('order', callbacks.order);
        }
    }

    send = async (data) =>  {
        await this.ws.send(data);
    };

    on = (e, callback) => {
        if (this.triggers.hasOwnProperty(e)) {
            this.triggers[e].push(callback);
        }
    };


    close = () => {
        // Retired deliberately: suppress its close event so it can't trigger a reconnect.
        this.disposed = true;
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        this.ws?.close()
    }

    // trigger event callbacks; one throwing callback must not break the rest or the socket.
    private trigger(e, args) {
        if (this.disposed || !this.triggers[e]) return
        for (const cb of [...this.triggers[e]]) {
            try {
                cb.apply(cb, args ? args : []);
            } catch (err) {
                Log.log(`Prism WS '${e}' callback threw:`, err);
            }
        }
    }
}


export default WebSocketClient;