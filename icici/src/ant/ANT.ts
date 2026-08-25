import { createHash } from 'crypto';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
// Use a separate axios instance to avoid Shoonya interceptors
import axiosModule from 'axios';
const axios = axiosModule.create();

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
            return [];
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
            return [];
        }
    }

    private authHeader() {
        if (!this.userSession) {
            throw new Error('No active session. Please login first.');
        }
        return { Authorization: `Bearer ${this.userSession}` };
    }

    // Live LTP for a specific instrument - needed because ANT rejects MARKET
    // orders for Bracket Orders (confirmed live: "Market orders are not
    // allowed"), so a BO entry needs a LIMIT price computed from the current
    // quote.
    async getQuote(exchange: string, token: string): Promise<number> {
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/ChartAPIService/chart/get/multi/ohlc',
            [{ exchange, token }],
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
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
        const resp = await axios.post(
            'https://a3.aliceblueonline.com/open-api/od/ChartAPIService/chart/get/multi/ohlc',
            requests.map((r) => ({ exchange: r.exchange, token: r.token })),
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        const map = new Map<string, number>();
        for (const row of resp.data?.result ?? []) {
            if (row?.tk != null && row?.ltp != null) map.set(String(row.tk), Number(row.ltp));
        }
        return map;
    }

    // Put-Call Ratio from AliceBlue's Option Chain API (v2, obrest/optionChain) -
    // nearest expiry only, summed over strikes within `window` points of `spot`.
    // Field shape confirmed live: getUnderlyingExp -> result[0].underlying_expiry[]
    // (nearest-first); getOptionChain -> result[0].data[] of {strikeprice, CE:{oi,...}, PE:{oi,...}}.
    async getOptionChainPCR(underlying: string, spot: number, window: number): Promise<number> {
        const expResp = await axios.post(
            'https://a3.aliceblueonline.com/obrest/optionChain/getUnderlyingExp',
            { underlying },
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        const expiry = expResp.data?.result?.[0]?.underlying_expiry?.[0];
        if (!expiry) {
            throw new Error(`ANT getOptionChainPCR: no expiry for ${underlying}: ${JSON.stringify(expResp.data)}`);
        }

        const chainResp = await axios.post(
            'https://a3.aliceblueonline.com/obrest/optionChain/getOptionChain',
            { underlying, expiry, interval: 5, exch: 'nse_fo' },
            { headers: { ...this.authHeader(), 'Content-Type': 'application/json' } }
        );
        const rows = chainResp.data?.result?.[0]?.data ?? [];
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
        return peOi / ceOi;
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
}

export default ANT;
