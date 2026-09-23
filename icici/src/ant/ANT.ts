import { createHash } from 'crypto';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
// Use a separate axios instance to avoid Shoonya interceptors
import axiosModule from 'axios';
// Default per-call timeout for every ANT broker HTTP call (order placement,
// quotes, option chain, fill polling, etc). Applies automatically to every
// axios.get/axios.post made through the shared instance below - previously
// a hung connection to AliceBlue left the caller (a strategy awaiting an
// order placement, via OrderClient -> order process -> ANT) stuck forever
// with no error surfaced anywhere. 15s is generous headroom over
// AliceBlue's typical sub-second-to-a-few-second REST latency while still
// bounding the worst case. See plans/bug-09-no-timeout-broker-http-ipc.md.
export const ANT_HTTP_TIMEOUT_MS = 15000;
const axios = axiosModule.create({ timeout: ANT_HTTP_TIMEOUT_MS });
// Exported for testability only (see src/test/antHttpTimeout.test.ts) - not
// intended to be used as a general-purpose HTTP client outside this file.
export const antAxiosInstance = axios;

class ANT {
    private static instance: ANT;

    // ANT Configuration - Update these with your actual credentials
    private appKey = 'voMvjS7seC'; // Alice Blue App Key (from developer console)
    private apiSecret = 'U6LMFnm9ZWguxyiurcr37Jd9qCyHVTsu8ZSfZ3JR6mwShz8jk7g6kDRXFu595ZRt3oxFHAtc5CbTk51j4oNmbm0yXgkJQ7TLF72z'; // Alice Blue API Secret
    private redirectUri = 'http://localhost:3000/ant/callback';
    private tokenUrl = 'https://a3.aliceblueonline.com/open-api/od/v1/vendor/getUserDetails';
    private userSession: string | null = null;
    private userId: string | null = null;
    private sessionFile = path.join(__dirname, '../../.ant_session.json');

    // AliceBlue's OHLC endpoint (getQuote/getQuotes) rate-limits (429) after
    // just 1-2 rapid sequential calls (confirmed live - see getQuotes'
    // comment). Both methods hit the same endpoint, so they share this gap
    // tracking rather than each having their own.
    private static readonly OHLC_MIN_GAP_MS = 1200;
    private static readonly OHLC_RETRY_DELAY_MS = 1500;
    private lastOhlcCallAt = 0;

    private async throttleOhlc(): Promise<void> {
        const wait = this.lastOhlcCallAt + ANT.OHLC_MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.lastOhlcCallAt = Date.now();
    }

    private constructor() {
        this.loadSession();
    }

    static getInstance(): ANT {
        if (!ANT.instance) {
            ANT.instance = new ANT();
        }
        return ANT.instance;
    }

    private loadSession(): void {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
                if (data.userSession && this.isSessionStale(data.userSession)) {
                    Log.log('ANT session was issued on an earlier date - discarding, re-login required (/ant/login)');
                    fs.unlinkSync(this.sessionFile);
                    return;
                }
                if (data.userSession) {
                    this.userSession = data.userSession;
                }
                if (data.userId) {
                    this.userId = data.userId;
                }
                Log.log('ANT session loaded from file');
            }
        } catch (e) {
            Log.log('Failed to load ANT session:', e);
        }
    }

    // AliceBlue invalidates the session server-side once the calendar day it
    // was issued on has passed, regardless of the JWT's own (much later) exp
    // claim - confirmed live: a session issued Fri got a 401 from createWsSess
    // the following Mon despite exp claiming validity into the next month. So
    // staleness is judged by the JWT's iat date vs today, not by exp.
    private isSessionStale(token: string): boolean {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
            if (!payload.iat) return false;
            const issuedDate = new Date(payload.iat * 1000);
            return issuedDate.toDateString() !== new Date().toDateString();
        } catch (e) {
            Log.log('Failed to check ANT session staleness:', e);
            return false;
        }
    }

    private saveSession(): void {
        try {
            fs.writeFileSync(
                this.sessionFile,
                JSON.stringify({ userSession: this.userSession, userId: this.userId })
            );
            Log.log('ANT session saved');
        } catch (e) {
            Log.log('Failed to save ANT session:', e);
        }
    }

    getAuthorizationUrl(): string {
        const url = `https://ant.aliceblueonline.com/?appcode=${encodeURIComponent(this.appKey)}`;
        Log.log('Generated ANT Authorization URL:', url);
        return url;
    }

    async exchangeAuthCodeForToken(userId: string, authCode: string): Promise<{ userSession: string }> {
        try {
            Log.log('=== ANT Token Exchange Starting ===');
            Log.log('userId:', userId);
            Log.log('authCode:', authCode.substring(0, 20) + '...');

            this.userId = userId;

            // Step 1: Compute checksum
            Log.log('\n--- Step 1: Computing checksum ---');
            const checksumInput = userId + authCode + this.apiSecret;
            const checksum = createHash('sha256')
                .update(checksumInput)
                .digest('hex');
            Log.log('✓ Checksum computed:', checksum.substring(0, 20) + '...');

            // Step 2: Exchange for userSession
            Log.log('\n--- Step 2: Exchanging authCode for userSession ---');
            Log.log('POST:', this.tokenUrl);

            const tokenResp = await axios.post(
                this.tokenUrl,
                { checkSum: checksum },
                { headers: { 'Content-Type': 'application/json' } }
            );

            Log.log('Response status:', tokenResp.status);
            Log.log('Response data:', tokenResp.data);

            this.userSession = tokenResp.data?.userSession;
            if (!this.userSession) {
                throw new Error(`Failed to get userSession. Response: ${JSON.stringify(tokenResp.data)}`);
            }

            this.saveSession();

            Log.log('✓ Step 2 Success: userSession obtained');
            Log.log('\n=== ANT Token Exchange Successful! ===\n');

            return {
                userSession: this.userSession
            };
        } catch (e: any) {
            Log.log('\n❌ ANT Token Exchange Failed!');
            Log.log('Error message:', e.message);
            Log.log('Error status:', e.response?.status);
            Log.log('Error data:', e.response?.data);

            let errorMsg = 'Unknown error';
            if (e.response) {
                errorMsg = e.response.data?.emsg || e.response.data?.error || e.message;
            } else if (e.request) {
                errorMsg = `No response from server: ${e.message}`;
            } else {
                errorMsg = e.message;
            }

            throw new Error(`ANT token exchange failed: ${errorMsg}`);
        }
    }

    // Public re-read hook: called after a fresh OAuth login completes in a different
    // process (frontend), so this already-running singleton (e.g. in `data`) picks
    // up the new token without a restart. Mirrors Zerodha.ts's reloadSession.
    reloadSession(): void {
        this.loadSession();
    }

    getUserSession(): string | null {
        return this.userSession;
    }

    // No dedicated lightweight "am I logged in" endpoint exists for ANT the
    // way Zerodha.hasValidSession has getProfile() - mirrors that same
    // pattern (a cheap authenticated call, fail closed on any error) using
    // getPositions() instead. Added for BrokerExecutor parity - not
    // previously called anywhere, so its actual behavior against a real
    // stale/valid session is unverified. See ToDo.md.
    async hasValidSession(): Promise<boolean> {
        if (!this.userSession) return false;
        try {
            await this.getPositions();
            return true;
        } catch {
            return false;
        }
    }

    getUserId(): string | null {
        return this.userId;
    }

    getApiSecret(): string {
        return this.apiSecret;
    }

    getAppKey(): string {
        return this.appKey;
    }

    setAppKey(key: string): void {
        this.appKey = key;
    }

    setApiSecret(secret: string): void {
        this.apiSecret = secret;
    }

    setRedirectUri(uri: string): void {
        this.redirectUri = uri;
    }

    getRedirectUri(): string {
        return this.redirectUri;
    }

    async getTrades(): Promise<any[]> {
        try {
            if (!this.userSession) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching ANT trades...');

            const tradesResp = await axios.get(
                'https://a3.aliceblueonline.com/open-api/od/v1/orders/trades',
                { headers: { 'Authorization': `Bearer ${this.userSession}` } }
            );

            Log.log('ANT Trades response:', tradesResp.data?.status);
            if (tradesResp.data?.status === 'Ok' && tradesResp.data?.result) {
                return tradesResp.data.result;
            }
            return [];
        } catch (e: any) {
            Log.log('Error fetching ANT trades:', e.message);
            // Rethrow (was previously swallowed into an empty array) - an
            // absent/expired session must not look identical to "genuinely no
            // trades today". Callers (the /ant/trades route, and anything
            // that later depends on this as a live session probe) need the
            // failure to actually surface. Mirrors getPositions() below and
            // Zerodha.getPositions()'s existing throw-on-failure pattern.
            throw new Error(`Failed to fetch trades: ${e.message}`);
        }
    }

    async getPositions(): Promise<any> {
        try {
            if (!this.userSession) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching ANT positions...');

            const posResp = await axios.get(
                'https://a3.aliceblueonline.com/open-api/od/v1/positions',
                { headers: { 'Authorization': `Bearer ${this.userSession}` } }
            );

            Log.log('ANT Positions response:', posResp.data?.status);
            if (posResp.data?.status === 'Ok' && posResp.data?.result) {
                return posResp.data.result;
            }
            return [];
        } catch (e: any) {
            Log.log('Error fetching ANT positions:', e.message);
            // Rethrow (was previously swallowed into an empty array) - see
            // getTrades()'s comment above for why. Also relied on by
            // bookkeeping.loadOpenTradesFromBroker's own try/catch, which
            // otherwise silently never fires on a real session failure.
            throw new Error(`Failed to fetch positions: ${e.message}`);
        }
    }

    private authHeader() {
        if (!this.userSession) {
            throw new Error('No active session. Please login first.');
        }
        return { Authorization: `Bearer ${this.userSession}` };
    }

    // Shared by getQuote/getQuotes - both hit this same endpoint, so the
    // throttle gap and the one-retry-on-429 policy are centralized here
    // rather than duplicated in each. A 429 is retried exactly once after
    // OHLC_RETRY_DELAY_MS; any other failure (or a second 429) propagates to
    // the caller, which already has its own fail-safe (see antExecutor.ts's
    // safeAntQuote, which falls back to 1-lot sizing on any thrown error).
    private async postOhlc(payload: { exchange: string; token: string }[]): Promise<any> {
        await this.throttleOhlc();
        try {
            return await axios.post(
                'https://a3.aliceblueonline.com/open-api/od/ChartAPIService/chart/get/multi/ohlc',
                payload,
                { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
            );
        } catch (e: any) {
            if (e?.response?.status !== 429) throw e;
            Log.log('[ANT] OHLC endpoint rate-limited (429), retrying once after backoff');
            await new Promise((resolve) => setTimeout(resolve, ANT.OHLC_RETRY_DELAY_MS));
            await this.throttleOhlc();
            return await axios.post(
                'https://a3.aliceblueonline.com/open-api/od/ChartAPIService/chart/get/multi/ohlc',
                payload,
                { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
            );
        }
    }

    // Live LTP for a specific instrument - needed because ANT rejects MARKET
    // orders for Bracket Orders (confirmed live: "Market orders are not
    // allowed"), so a BO entry needs a LIMIT price computed from the current
    // quote.
    async getQuote(exchange: string, token: string): Promise<number> {
        const resp = await this.postOhlc([{ exchange, token }]);
        const ltp = resp.data?.result?.[0]?.ltp;
        if (ltp == null) {
            throw new Error(`ANT getQuote failed for ${exchange}|${token}: ${JSON.stringify(resp.data)}`);
        }
        return Number(ltp);
    }

    // Batched sibling of getQuote - same endpoint, but sends every requested
    // (exchange, token) pair in one call instead of one call each. AliceBlue's
    // OHLC endpoint rate-limits (429) after just 1-2 rapid sequential single
    // calls (confirmed live) - a strike-range walk that checks several
    // candidates' premiums must batch them into one request instead of
    // looping getQuote(), or most candidates silently read as "no data".
    // Matched by the response's own `tk` field - order isn't guaranteed.
    async getQuotes(requests: { exchange: string; token: string }[]): Promise<Map<string, number>> {
        if (requests.length === 0) return new Map();
        const resp = await this.postOhlc(requests.map((r) => ({ exchange: r.exchange, token: r.token })));
        const map = new Map<string, number>();
        for (const row of resp.data?.result ?? []) {
            if (row?.tk != null && row?.ltp != null) map.set(String(row.tk), Number(row.ltp));
        }
        return map;
    }

    // Per-scrip quote via AliceBlue's older ScripDetails endpoint (different
    // host/API family from the OHLC endpoint above, and a different auth
    // header shape - "Bearer <USERID> <userSession>" rather than just
    // "Bearer <userSession>"). Confirmed live to return real LTP for a token
    // that the OHLC endpoint's postOhlc/getQuote returned `result: [null]`
    // for post-market-close, so this is used as the post-close fallback
    // instead of getQuote (see GapScreenerOptionQuoteEod.ts) - not used
    // during live market hours, where getQuote/getQuotes (used for BO limit
    // pricing and strike-range walks) are unaffected and already proven.
    async getScripQuote(exchange: string, token: string): Promise<number> {
        if (!this.userSession || !this.userId) {
            throw new Error('No active session. Please login first.');
        }
        const resp = await axios.post(
            'https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/ScripDetails/getScripQuoteDetails',
            { exch: exchange, symbol: String(token) },
            {
                headers: {
                    'X-SAS-Version': '2.0',
                    Authorization: `Bearer ${this.userId.toUpperCase()} ${this.userSession}`,
                },
            }
        );
        const ltp = resp.data?.LTP;
        if (ltp == null) {
            throw new Error(`ANT getScripQuote failed for ${exchange}|${token}: ${JSON.stringify(resp.data)}`);
        }
        return Number(ltp);
    }

    // Shared by getOptionChainPCR/getOptionChain - both need the same
    // nearest-expiry option chain raw rows (v2, obrest/optionChain). Field
    // shape confirmed live: getUnderlyingExp -> result[0].underlying_expiry[]
    // (nearest-first); getOptionChain -> result[0].data[] of
    // {strikeprice, CE:{ltp,oi,token,tradingsymbol,...}, PE:{...}}. This
    // endpoint is on a separate rate-limit bucket from the OHLC endpoint
    // (getQuote/getQuotes/postOhlc) - confirmed live, no 429s seen here even
    // when the OHLC endpoint was rate-limiting on a single call.
    private async fetchOptionChainRows(underlying: string): Promise<any[]> {
        const expResp = await axios.post(
            'https://a3.aliceblueonline.com/obrest/optionChain/getUnderlyingExp',
            { underlying, exch: 'nse_fo' },
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        const expiry = expResp.data?.result?.[0]?.underlying_expiry?.[0];
        if (!expiry) {
            throw new Error(`ANT option chain: no expiry for ${underlying}: ${JSON.stringify(expResp.data)}`);
        }

        const chainResp = await axios.post(
            'https://a3.aliceblueonline.com/obrest/optionChain/getOptionChain',
            { underlying, expiry, interval: 5, exch: 'nse_fo' },
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        return chainResp.data?.result?.[0]?.data ?? [];
    }

    // Put-Call Ratio from the option chain - summed over strikes within
    // `window` points of `spot`.
    async getOptionChainPCR(underlying: string, spot: number, window: number): Promise<number> {
        const rows = await this.fetchOptionChainRows(underlying);
        let ceOi = 0;
        let peOi = 0;
        for (const row of rows) {
            const strike = Number(row.strikeprice);
            if (Math.abs(strike - spot) > window) continue;
            ceOi += Number(row.CE?.oi ?? 0);
            peOi += Number(row.PE?.oi ?? 0);
        }
        if (ceOi === 0) {
            throw new Error(`ANT getOptionChainPCR: no CE OI in +/-${window} window around ${spot}`);
        }
        const pcr = peOi / ceOi;
        Log.log(`[ANT] getOptionChainPCR ${underlying}: spot=${spot} window=${window} ceOi=${ceOi} peOi=${peOi} pcr=${pcr.toFixed(4)}`);
        return pcr;
    }

    // Per-strike CE/PE token + live LTP for every strike in the nearest
    // expiry's chain - lets a caller price/resolve several candidate strikes
    // from a single pair of requests, without ever touching the fragile OHLC
    // endpoint (see antExecutor.ts's estimateOptionPricesBatch, its
    // motivating caller).
    async getOptionChain(underlying: string): Promise<Array<{
        strike: number;
        ce: { ltp: number; token: string; tradingsymbol: string };
        pe: { ltp: number; token: string; tradingsymbol: string };
    }>> {
        const rows = await this.fetchOptionChainRows(underlying);
        return rows
            .filter((row) => row?.CE != null && row?.PE != null)
            .map((row) => ({
                strike: Number(row.strikeprice),
                ce: { ltp: Number(row.CE.ltp), token: String(row.CE.token), tradingsymbol: String(row.CE.tradingsymbol) },
                pe: { ltp: Number(row.PE.ltp), token: String(row.PE.token), tradingsymbol: String(row.PE.tradingsymbol) },
            }))
            .sort((a, b) => a.strike - b.strike);
    }

    // ORDER PLACEMENT — AliceBlue's own documentation disagrees with itself on
    // field names for these endpoints (productdocumentation/orders%20Management
    // shows a single-object body with target/stopLoss/trailingStopLoss; the
    // downloadable Postman collection shows an array-wrapped body with
    // targetLegPrice/slLegPrice). The shape below follows the Postman
    // collection (more likely to reflect what's actually accepted, since it's
    // meant to be run as-is) but has NOT been verified against a live
    // response. Log the raw request/response on the first real call and
    // correct field names here if the broker rejects the shape.

    async placeOrder(params: {
        exchange: 'NFO' | 'BFO';
        instrumentId: string;
        tradingSymbol: string;
        quantity: number;
        transactionType: 'BUY' | 'SELL';
        price?: number; // omitted/0 => MARKET
    }): Promise<{ orderNo: string }> {
        const body = [{
            exchange: params.exchange,
            instrumentId: params.instrumentId,
            tradingSymbol: params.tradingSymbol,
            transactionType: params.transactionType,
            quantity: params.quantity,
            product: 'INTRADAY',
            orderType: params.price ? 'LIMIT' : 'MARKET',
            price: params.price ?? 0,
            orderComplexity: 'REGULAR',
            validity: 'DAY',
        }];
        Log.log('[ANT] placeOrder request:', JSON.stringify(body));
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/placeorder',
            body,
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        Log.log('[ANT] placeOrder response:', JSON.stringify(resp.data));
        // Confirmed live: the field is brokerOrderId, not orderNo (AliceBlue's
        // own doc pages disagreed here too).
        const orderNo = resp.data?.result?.[0]?.brokerOrderId;
        if (!orderNo) {
            throw new Error(`ANT placeOrder failed: ${JSON.stringify(resp.data)}`);
        }
        return { orderNo };
    }

    // NOTE ON targetLegPrice/slLegPrice: unlike Zerodha's GTT (placed AFTER
    // entry, once the fill price is known, with absolute trigger prices), a
    // Bracket Order on ANT IS the entry order itself - the fill price isn't
    // known yet when this is called, so absolute leg prices can't be computed
    // up front. These are passed through as POINT OFFSETS from the eventual
    // fill (matching this codebase's existing targetPoints/stopLossPoints
    // convention, and Zerodha's old pre-2021 Kite BO API, which used the same
    // point-offset convention for its squareoff/stoploss fields) - NOT
    // verified against a live AliceBlue response yet. Confirm on first real
    // use; if AliceBlue actually expects absolute prices here, this will
    // reject or silently mis-bracket the position.
    async placeBracketOrder(params: {
        exchange: 'NFO' | 'BFO';
        instrumentId: string;
        tradingSymbol: string;
        quantity: number;
        transactionType: 'BUY' | 'SELL';
        price?: number; // omitted/0 => MARKET entry
        targetPoints: number;
        stopLossPoints: number;
    }): Promise<{ orderNo: string }> {
        const body = [{
            exchange: params.exchange,
            instrumentId: params.instrumentId,
            tradingSymbol: params.tradingSymbol,
            transactionType: params.transactionType,
            quantity: params.quantity,
            product: 'INTRADAY',
            orderType: params.price ? 'LIMIT' : 'MARKET',
            price: params.price ?? 0,
            orderComplexity: 'BO',
            validity: 'DAY',
            targetLegPrice: params.targetPoints,
            slLegPrice: params.stopLossPoints,
        }];
        Log.log('[ANT] placeBracketOrder request:', JSON.stringify(body));
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/placeorder',
            body,
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        Log.log('[ANT] placeBracketOrder response:', JSON.stringify(resp.data));
        // Confirmed live: the field is brokerOrderId, not orderNo (AliceBlue's
        // own doc pages disagreed here too).
        const orderNo = resp.data?.result?.[0]?.brokerOrderId;
        if (!orderNo) {
            throw new Error(`ANT placeBracketOrder failed: ${JSON.stringify(resp.data)}`);
        }
        return { orderNo };
    }

    // Same unverified-against-a-live-response caveat as placeBracketOrder
    // above: orderComplexity 'CO' and slLegPrice as a point-offset are
    // inferred from AliceBlue's BO shape, not confirmed live. Confirm on
    // first real use (see the gap-screener cover-order plan's verification
    // section). A cover order carries only a stop-loss leg, no target leg.
    async placeCoverOrder(params: {
        exchange: 'NFO' | 'BFO';
        instrumentId: string;
        tradingSymbol: string;
        quantity: number;
        transactionType: 'BUY' | 'SELL';
        price?: number; // omitted/0 => MARKET entry
        stopLossPoints: number;
    }): Promise<{ orderNo: string }> {
        const body = [{
            exchange: params.exchange,
            instrumentId: params.instrumentId,
            tradingSymbol: params.tradingSymbol,
            transactionType: params.transactionType,
            quantity: params.quantity,
            product: 'INTRADAY',
            orderType: params.price ? 'LIMIT' : 'MARKET',
            price: params.price ?? 0,
            orderComplexity: 'CO',
            validity: 'DAY',
            slLegPrice: params.stopLossPoints,
        }];
        Log.log('[ANT] placeCoverOrder request:', JSON.stringify(body));
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/placeorder',
            body,
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        Log.log('[ANT] placeCoverOrder response:', JSON.stringify(resp.data));
        const orderNo = resp.data?.result?.[0]?.brokerOrderId;
        if (!orderNo) {
            throw new Error(`ANT placeCoverOrder failed: ${JSON.stringify(resp.data)}`);
        }
        return { orderNo };
    }

    // Closes BOTH legs of a live BO/CO position - distinct from cancelOrder,
    // which only cancels a pending/unfilled order.
    async exitBracketOrder(orderNo: string, orderComplexity: 'BO' | 'CO' = 'BO'): Promise<void> {
        const body = [{ orderNo, orderComplexity }];
        Log.log('[ANT] exitBracketOrder request:', JSON.stringify(body));
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/exit/sno',
            body,
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        Log.log('[ANT] exitBracketOrder response:', JSON.stringify(resp.data));
        if (resp.data?.status !== 'Ok') {
            throw new Error(`ANT exitBracketOrder failed: ${JSON.stringify(resp.data)}`);
        }
    }

    async cancelOrder(orderNo: string): Promise<void> {
        const body = { brokerOrderId: orderNo };
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/cancel',
            body,
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        if (resp.data?.status !== 'Ok') {
            throw new Error(`ANT cancelOrder failed: ${JSON.stringify(resp.data)}`);
        }
    }

    // Polls order history until the order is COMPLETE (or REJECTED/CANCELLED),
    // mirroring Zerodha.getFillPrice's poll/timeout shape. Confirmed live:
    // `result` is an array of order-state-transition records (PENDING/OPEN/
    // COMPLETE/...), NOT chronologically ordered (COMPLETE was observed first
    // in one response) - so every record must be scanned for a terminal
    // status rather than trusting array position. Fill price field is
    // `averageTradedPrice` (confirmed live), populated only on the COMPLETE
    // record.
    async getFillPrice(orderNo: string, maxAttempts = 12, intervalMs = 5000): Promise<number> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const resp = await axios.post(
                'https://a3.aliceblueonline.com/open-api/od/v1/orders/history',
                { brokerOrderId: orderNo },
                { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
            );
            const records: any[] = resp.data?.result ?? [];
            const completed = records.find((r) => r.orderStatus === 'COMPLETE');
            if (completed) {
                const fillPrice = completed.averageTradedPrice ?? completed.averagePrice ?? completed.avgPrice;
                if (!fillPrice) {
                    throw new Error(`ANT order ${orderNo} COMPLETE but no recognizable fill-price field: ${JSON.stringify(completed)}`);
                }
                return Number(fillPrice);
            }
            const rejected = records.find((r) => r.orderStatus === 'REJECTED' || r.orderStatus === 'CANCELLED');
            if (rejected) {
                throw new Error(`ANT order ${orderNo} ${rejected.orderStatus}: ${JSON.stringify(rejected)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        throw new Error(`ANT order ${orderNo} did not complete within ${maxAttempts * intervalMs}ms`);
    }

    // Single-shot status check (no retry loop) - for a poller that checks a
    // resting order once per interval tick rather than blocking until it
    // fills, mirroring Zerodha.getOrderHistory's role in pollPendingLimitOrders.
    // Same field/shape caveats as getFillPrice above.
    async getOrderStatus(orderNo: string): Promise<{ status: string; fillPrice?: number }> {
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/v1/orders/history',
            { brokerOrderId: orderNo },
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        const records: any[] = resp.data?.result ?? [];
        const completed = records.find((r) => r.orderStatus === 'COMPLETE');
        if (completed) {
            const fillPrice = completed.averageTradedPrice ?? completed.averagePrice ?? completed.avgPrice;
            return { status: 'COMPLETE', fillPrice: fillPrice ? Number(fillPrice) : undefined };
        }
        const rejected = records.find((r) => r.orderStatus === 'REJECTED' || r.orderStatus === 'CANCELLED');
        if (rejected) return { status: rejected.orderStatus };
        return { status: 'PENDING' };
    }
}

export default ANT;
