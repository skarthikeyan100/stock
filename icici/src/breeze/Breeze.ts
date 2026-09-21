import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

// breezeconnect ships no TypeScript types and is a plain CommonJS export
// (exports.BreezeConnect = ...), so it's required untyped here rather than
// via an ambient .d.ts like kiteconnect.d.ts - matches the existing
// convention for other untyped libs in this codebase (see payout.ts,
// functions.ts).
const { BreezeConnect } = require('breezeconnect');

// breezeconnect's own error handling destroys the real HTTP error body: its
// internal errorException() helper (breezeConnect.js) does
// `throw message + error.stack` - a STRING, not an Error - so the original
// axios error's `.response.data` (which carries ICICI's real error message,
// e.g. "Request Denied: Kindly pass 'limit' as parameter...") is gone by the
// time it reaches our code. Worse, every wrapped method's own catch block
// re-wraps that already-mangled string through errorException a SECOND time,
// and a string has no `.stack`, producing garbage like
// "placeOrder() Errorundefined" (confirmed live 2026-09-17).
//
// The only way to recover the real body is to capture it independently,
// before breezeconnect's catch ever runs - this interceptor runs inside
// axios's own promise chain, ahead of that. Scoped to icicidirect.com (not
// installed on RestAPI.ts's shared global axios instance) and, like that
// file's own interceptors, deliberately narrow so it can't affect unrelated
// callers. NOT concurrency-safe (a second concurrent Breeze call can
// overwrite this before the first one's catch block reads it) - acceptable
// here since this app places orders for one ICICI account mostly serially,
// matching the same single-account assumption Zerodha.buyHaltReason makes.
let lastBreezeHttpError: { url?: string; status?: number; data?: any } | null = null;
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error?.config?.url?.includes('icicidirect.com')) {
            lastBreezeHttpError = { url: error.config.url, status: error.response?.status, data: error.response?.data };
        }
        return Promise.reject(error);
    }
);

class Breeze {
    private static instance: Breeze;

    // ICICI Breeze (BreezeConnect) API credentials - update these with your
    // actual keys from https://api.icicidirect.com/apiuser/register-apps.
    // Register the app's Redirect URL as <server origin>/breeze/callback
    // (e.g. http://localhost:3000/breeze/callback for local dev) - matches
    // the /ant/callback, /kite/callback convention.
    private appKey = '60p7JA03s42b462Z58K39T796437m239';
    private appSecret = '5b459373860r3(CK2j1s(9918Y4y7360';

    private breeze: any;
    private apiSession: string | null = null;
    private sessionFile = path.join(__dirname, '../../.breeze_session.json');
    // Tracks the in-flight constructor-time session restore (see loadSession) -
    // hasValidSession() and every other public method await this first, so a
    // caller in a freshly-started process (e.g. `order`, right after restart)
    // can't race ahead of the restore and see "no session" when a valid one
    // is on disk and simply hasn't finished loading yet (confirmed live
    // 2026-09-17: the very first buy attempt after an `order` restart failed
    // with "Please login first" despite a valid .breeze_session.json, because
    // hasValidSession() ran before the fire-and-forget generateSession() call
    // below had resolved).
    private sessionLoadPromise: Promise<void> | null = null;

    private constructor() {
        this.breeze = new BreezeConnect({ appKey: this.appKey });
        this.loadSession();
    }

    static getInstance(): Breeze {
        if (!Breeze.instance) {
            Breeze.instance = new Breeze();
        }
        return Breeze.instance;
    }

    // Every breezeconnect call goes through here. Two failure shapes to
    // normalize into a real, useful Error:
    //  1. The SDK throws (HTTP-level failure) - the real message is already
    //     gone from `error` itself (see header comment), so fall back to
    //     `lastBreezeHttpError` captured by the interceptor above.
    //  2. The SDK resolves normally with ICICI's own error envelope
    //     (`{Success: null, Status: 500, Error: "..."}`) - confirmed live,
    //     this is how *business* errors (bad params, rejected orders) come
    //     back, never as a throw.
    private async callSdk<T>(methodName: string, fn: () => Promise<T>): Promise<any> {
        let result: any;
        try {
            result = await fn();
        } catch (e) {
            const captured = lastBreezeHttpError;
            const message = captured?.data?.Error ?? (captured?.data ? JSON.stringify(captured.data) : undefined);
            throw new Error(`Breeze ${methodName} failed: ${message ?? 'breezeconnect SDK threw with no recoverable diagnostic'}`);
        }
        if (result?.Error || (result?.Status && result.Status !== 200)) {
            throw new Error(`Breeze ${methodName} failed: ${result.Error ?? `unexpected status ${result.Status}`}`);
        }
        return result;
    }

    // Public re-read hook, mirroring Zerodha.reloadSession/ANT's session
    // reload - lets a long-running process (e.g. `order`) pick up a fresh
    // login done by a different process (`frontend`) without restarting.
    reloadSession(): void {
        this.loadSession();
    }

    private loadSession(): void {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
                if (data.apiSession) {
                    // Tracked (not truly fire-and-forget) so hasValidSession()/
                    // every other public method can await this exact in-flight
                    // restore instead of racing ahead of it - see the field
                    // comment above.
                    this.sessionLoadPromise = this.generateSession(data.apiSession).catch((e: any) =>
                        Log.log('[Breeze] Failed to restore session from file:', e)
                    );
                    Log.log('[Breeze] Session loaded from file');
                }
            }
        } catch (e) {
            Log.log('[Breeze] Failed to load session:', e);
        }
    }

    // Every public method that needs an active session calls this first.
    private async ensureSessionRestored(): Promise<void> {
        if (this.sessionLoadPromise) {
            await this.sessionLoadPromise;
            this.sessionLoadPromise = null;
        }
    }

    // --- Live streaming (WebSocket) ---
    // breezeconnect's SDK funnels BOTH price ticks and order notifications
    // through the exact same single `breeze.onTicks` callback (confirmed by
    // reading breezeConnect.js's onMessage/notify wiring - subscribeFeeds's
    // getOrderNotification branch does `wsConnectOrder(); notify();`, and
    // `notify()` is just `socketOrder.on('order', self.onMessage)`, the same
    // onMessage that regular quote ticks use) - so this class owns ONE
    // dispatcher installed once, fanning out to however many listeners
    // BreezeStream/BreezeOrderNotifyStream register, rather than each of
    // those modules fighting over the SDK's single onTicks slot directly.
    // Distinguished by shape: an order notification (parseData's order_dict
    // branch) always carries `orderStatus`; a price tick (parseData's
    // dataDict branch) never does.
    private quoteListeners: ((tick: any) => void)[] = [];
    private orderNotifyListeners: ((notification: any) => void)[] = [];
    private wsDispatcherInstalled = false;

    private installWsDispatcher(): void {
        if (this.wsDispatcherInstalled) return;
        this.breeze.onTicks = (data: any) => {
            if (data && typeof data === 'object' && 'orderStatus' in data) {
                for (const l of this.orderNotifyListeners) l(data);
            } else {
                for (const l of this.quoteListeners) l(data);
            }
        };
        this.wsDispatcherInstalled = true;
    }

    onQuote(callback: (tick: any) => void): void {
        this.installWsDispatcher();
        this.quoteListeners.push(callback);
    }

    onOrderNotification(callback: (notification: any) => void): void {
        this.installWsDispatcher();
        this.orderNotifyListeners.push(callback);
    }

    // wsConnect/wsDisconnect are synchronous, fire-and-forget per the SDK
    // (socket.io connect/disconnect - no REST round-trip, so callSdk's
    // envelope handling doesn't apply here).
    wsConnect(): void {
        this.installWsDispatcher();
        this.breeze.wsConnect();
    }

    wsDisconnect(): void {
        this.breeze.wsDisconnect();
    }

    // Raw socket.io lifecycle hooks - `this.breeze.socket` is a plain public
    // property set inside the SDK's own wsConnect() (self.socket = io.connect(...)),
    // so it's only safely accessible once wsConnect() has run at least once.
    // Needed because socket.io's own auto-reconnect does NOT replay our
    // watch()/join subscriptions (confirmed: no such replay exists in the SDK
    // source) - without an explicit resubscribe-on-connect hook, a transient
    // network blip would silently and permanently stop ticks for every open
    // Breeze leg. Also used to catch the very first 'connect' (BreezeDataStream
    // subscribes only after this fires).
    onSocketConnect(callback: () => void): void {
        this.breeze.socket?.on('connect', callback);
    }

    onSocketDisconnect(callback: (reason: any) => void): void {
        this.breeze.socket?.on('disconnect', callback);
    }

    onSocketError(callback: (err: any) => void): void {
        this.breeze.socket?.on('connect_error', callback);
    }

    // stockToken form ("4.1!<token>") or the structured
    // {exchangeCode, stockCode, productType, expiryDate, strikePrice, right,
    // getExchangeQuotes, getMarketDepth} form both work per the SDK's README -
    // structured form used throughout this codebase (BreezeStream.ts) since
    // it doesn't require a separate token lookup.
    async subscribeFeeds(params: {
        stockToken?: string;
        stockCode?: string;
        exchangeCode?: string;
        productType?: string;
        expiryDate?: string;
        strikePrice?: string;
        right?: string;
        getExchangeQuotes?: boolean;
        getMarketDepth?: boolean;
        getOrderNotification?: boolean;
    }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('subscribeFeeds', () => this.breeze.subscribeFeeds(params));
    }

    async unsubscribeFeeds(params: {
        stockToken?: string;
        stockCode?: string;
        exchangeCode?: string;
        productType?: string;
        expiryDate?: string;
        strikePrice?: string;
        right?: string;
        getExchangeQuotes?: boolean;
        getMarketDepth?: boolean;
        getOrderNotification?: boolean;
    }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('unsubscribeFeeds', () => this.breeze.unsubscribeFeeds(params));
    }

    private saveSession(): void {
        try {
            if (this.apiSession) {
                fs.writeFileSync(this.sessionFile, JSON.stringify({ apiSession: this.apiSession }));
                Log.log('[Breeze] Session saved');
            }
        } catch (e) {
            Log.log('[Breeze] Failed to save session:', e);
        }
    }

    getLoginURL(): string {
        const url = `https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(this.appKey)}`;
        Log.log('[Breeze] Generated login URL:', url);
        return url;
    }

    // apiSession is the `API_Session` value ICICI's redirect to /breeze/callback
    // hands back as a `?apisession=` query param (confirmed live 2026-09-17).
    //
    // Deliberately does NOT call the SDK's own generateSession() - that method
    // chains apiUtil() (the actual customerdetails auth call, which works) with
    // getStockScriptList() (downloads a NSE/BSE/NFO stock-code lookup CSV from
    // traderweb.icicidirect.com, used only by the SDK's getNames()-style
    // symbol-translation helpers). Confirmed live that traderweb.icicidirect.com
    // resets the connection instantly on every request (bare `curl`/axios
    // reproduce it outside the SDK too, consistently, TLS handshake completes
    // fine then RST right after the HTTP request - looks like a WAF/anti-bot
    // block on that consumer-web subdomain, not a transient blip) while
    // api.icicidirect.com (everything placeOrder/getQuotes/squareOff/etc.
    // actually need, since they all take stockCode as a plain string) works
    // fine. So this replicates just the apiUtil() half directly instead of
    // letting the CSV download's failure abort session generation entirely -
    // safe since nothing here uses the SDK's stock-code lookup tables.
    async generateSession(apiSession: string): Promise<void> {
        Log.log('[Breeze] Generating session...');
        this.breeze.sessionKey = apiSession;
        this.breeze.secretKey = this.appSecret;
        await this.callSdk('generateSession', () => this.breeze.apiUtil());
        this.apiSession = apiSession;
        this.saveSession();
        Log.log('[Breeze] Session generated and saved');
    }

    async hasValidSession(): Promise<boolean> {
        try {
            await this.ensureSessionRestored();
            if (!this.apiSession) return false;
            await this.getCustomerDetails();
            return true;
        } catch {
            return false;
        }
    }

    async getCustomerDetails(): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getCustomerDetails', () => this.breeze.getCustomerDetails(this.apiSession));
    }

    async getFunds(): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getFunds', () => this.breeze.getFunds());
    }

    async getQuotes(params: {
        stockCode: string;
        exchangeCode: string;
        expiryDate?: string;
        productType?: string;
        right?: string;
        strikePrice?: string;
    }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getQuotes', () => this.breeze.getQuotes(params));
    }

    async getOptionChainQuotes(params: {
        stockCode: string;
        exchangeCode: string;
        productType: string;
        expiryDate?: string;
        right?: string;
        strikePrice?: string;
    }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getOptionChainQuotes', () => this.breeze.getOptionChainQuotes(params));
    }

    // Response shape confirmed live: every REST call resolves to the raw
    // {Success, Status, Error} envelope - callSdk already throws on a
    // non-200/Error envelope, so a resolved value here always has a real
    // Success.order_id.
    async placeOrder(params: {
        stockCode: string;
        exchangeCode: string;
        product: string;
        action: 'buy' | 'sell';
        orderType: 'market' | 'limit';
        quantity: string;
        price?: string;
        validity?: string;
        stoploss?: string;
        disclosedQuantity?: string;
        expiryDate?: string;
        right?: string;
        strikePrice?: string;
        userRemark?: string;
    }): Promise<{ orderId: string }> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        Log.log(`[Breeze] Placing ${params.action} ${params.orderType} order: ${params.stockCode} qty=${params.quantity}`);
        const response = await this.callSdk('placeOrder', () => this.breeze.placeOrder(params));
        const orderId = response.Success.order_id;
        Log.log(`[Breeze] Order placed: ${orderId}`);
        return { orderId };
    }

    async squareOff(params: {
        exchangeCode: string;
        product: string;
        stockCode: string;
        action: 'buy' | 'sell';
        orderType: 'market' | 'limit';
        quantity: string;
        price?: string;
        validity?: string;
        stoploss?: string;
        expiryDate?: string;
        right?: string;
        strikePrice?: string;
        disclosedQuantity?: string;
    }): Promise<{ orderId: string }> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        Log.log(`[Breeze] Squaring off: ${params.stockCode} qty=${params.quantity}`);
        const response = await this.callSdk('squareOff', () => this.breeze.squareOff(params));
        return { orderId: response.Success.order_id };
    }

    async cancelOrder(exchangeCode: string, orderId: string): Promise<void> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        Log.log(`[Breeze] Cancelling order ${orderId}`);
        await this.callSdk('cancelOrder', () => this.breeze.cancelOrder({ exchangeCode, orderId }));
    }

    async getOrderDetail(exchangeCode: string, orderId: string): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getOrderDetail', () => this.breeze.getOrderDetail({ exchangeCode, orderId }));
    }

    async getOrderList(params: { exchangeCode: string; fromDate: string; toDate: string }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getOrderList', () => this.breeze.getOrderList(params));
    }

    async getPortfolioPositions(): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getPortfolioPositions', () => this.breeze.getPortfolioPositions());
    }

    async getTradeList(params: {
        fromDate: string;
        toDate: string;
        exchangeCode: string;
        productType?: string;
        action?: string;
        stockCode?: string;
    }): Promise<any> {
        await this.ensureSessionRestored();
        if (!this.apiSession) {
            throw new Error('No active Breeze session. Please login first.');
        }
        return this.callSdk('getTradeList', () => this.breeze.getTradeList(params));
    }

    // Polls getOrderDetail until the fill price is known - mirrors
    // Zerodha.getFillPrice's poll loop. Field names confirmed live 2026-09-17
    // against a real order (see the raw response captured below): `status`
    // starts as "Ordered", `average_price` stays "0" until filled; a rejected/
    // cancelled order's real status text wasn't observed live (no such order
    // occurred this session) so that check stays a defensive regex rather
    // than a confirmed exact string.
    //
    // Raw confirmed response while pending:
    // {"order_id":"...","status":"Ordered","average_price":"0","action":"Sell",
    //  "quantity":"65","price":"143.5","expiry_date":"22-Sep-2026","right":"Call",
    //  "strike_price":23300,"pending_quantity":"65","cancelled_quantity":"0", ...}
    async getFillPrice(exchangeCode: string, orderId: string, maxAttempts = 12, intervalMs = 5000): Promise<number> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const result = await this.getOrderDetail(exchangeCode, orderId);
            const record = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
            const price = Number(record?.average_price);
            if (price > 0) {
                return price;
            }
            if (record?.status && /rejected|cancelled/i.test(String(record.status))) {
                throw new Error(`Breeze order ${orderId} ${record.status}`);
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        throw new Error(`Breeze order ${orderId} did not fill within timeout`);
    }
}

export default Breeze;
