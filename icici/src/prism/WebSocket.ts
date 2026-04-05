import Log from '../util/Log';
let web_socket = require("ws");

let triggers = {
    "open": [],
    "quote": [],
    "order": [],
    "close": []

};

let API = require("./config").default;


class WebSocketClient {

    private ws;
    private apikey;
    private url;
    private timeout;
    constructor(cred) {
        this.apikey = cred.apikey;
        this.url = cred.url
        this.timeout = API.heartbeat || 3000;
    }

    connect = (params, callbacks) => {
        Log.log('WS Connect is called')
        return new Promise((resolve, reject) => {
            if (this.apikey === null || this.url === null) return "apikey or url is missing";

            //callbacks to the app are set here
            this.set_callbacks(callbacks);

            this.ws = new web_socket(this.url, null, { rejectUnauthorized: false });

            this.ws.onopen = (evt) => {
                setInterval(() =>  {
                    var _hb_req = '{"t":"h"}';
                    this.ws.send(_hb_req);
                }, this.timeout);

                //prepare the data
                let values = { "t": "c" };
                values["uid"] = params.uid;
                values["actid"] = params.actid;
                values["susertoken"] = params.apikey;
                values["source"] = "API";
                this.ws.send(JSON.stringify(values));
                // resolve()

            };
            this.ws.onmessage = (evt) => {
                var result = JSON.parse(evt.data);
                // Log.log('Result from socket: ', result);

                if (result.t == 'ck') {
                    trigger("open", [result]);
                }
                if (result.t == 'tk' || result.t == 'tf') {
                    trigger("quote", [result]);
                }
                if (result.t == 'dk' || result.t == 'df') {
                    trigger("quote", [result]);
                }
                if (result.t == 'om') {
                    trigger("order", [result]);
                }

            };
            this.ws.onerror = (evt) => {
                Log.log("error::", evt)
                trigger("error", [JSON.stringify(evt.data)]);
                this.ws.connect();
                reject(evt)
            };
            this.ws.onclose =  (evt) => {
                Log.log("Socket closed")
                trigger("close", [JSON.stringify(evt.data)]);
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
        if (triggers.hasOwnProperty(e)) {
            triggers[e].push(callback);
        }
    };


    close = () => {
        this.ws.close()
    }
}


// trigger event callbacks
function trigger(e, args) {
    if (!triggers[e]) return
    for (var n = 0; n < triggers[e].length; n++) {
        triggers[e][n].apply(triggers[e][n], args ? args : []);
    }
}

export default WebSocketClient;