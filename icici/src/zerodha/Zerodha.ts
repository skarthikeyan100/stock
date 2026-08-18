import { KiteConnect } from 'kiteconnect';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';

class Zerodha {
    private static instance: Zerodha;

    // Zerodha Configuration - Update these with your actual credentials
    private apiKey = '8ugdwlq4fz81o218';
    private apiSecret = '914b3mcaxlx94jfmleikmexysueqohmn';
    private redirectUri = 'http://localhost:3000/kite/callback';
    private kc: KiteConnect;
    private accessToken: string | null = null;
    private sessionFile = path.join(__dirname, '../../.zerodha_session.json');

    private constructor() {
        this.kc = new KiteConnect({ api_key: this.apiKey });
        this.loadSession();
    }

    static getInstance(): Zerodha {
        if (!Zerodha.instance) {
            Zerodha.instance = new Zerodha();
        }
        return Zerodha.instance;
    }

    private loadSession(): void {
        try {
            if (fs.existsSync(this.sessionFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf-8'));
                if (data.access_token) {
                    this.accessToken = data.access_token;
                    this.kc.setAccessToken(this.accessToken);
                    Log.log('Zerodha session loaded from file');
                }
            }
        } catch (e) {
            Log.log('Failed to load Zerodha session:', e);
        }
    }

    private saveSession(): void {
        try {
            if (this.accessToken) {
                fs.writeFileSync(this.sessionFile, JSON.stringify({ access_token: this.accessToken }));
                Log.log('Zerodha session saved');
            }
        } catch (e) {
            Log.log('Failed to save Zerodha session:', e);
        }
    }

    getLoginURL(): string {
        const url = this.kc.getLoginURL();
        Log.log('Generated Zerodha login URL:', url);
        return url;
    }

    async exchangeRequestTokenForSession(requestToken: string): Promise<{ access_token: string; profile: any }> {
        try {
            Log.log('=== Zerodha Token Exchange Starting ===');
            Log.log('Request token:', requestToken.substring(0, 20) + '...');

            const session = await this.kc.generateSession(requestToken, this.apiSecret);

            Log.log('Session generated:', session);

            this.accessToken = session.access_token;
            this.kc.setAccessToken(this.accessToken);
            this.saveSession();

            Log.log('✓ Access token obtained and saved');
            Log.log('=== Zerodha Token Exchange Successful! ===');

            return {
                access_token: this.accessToken,
                profile: session
            };
        } catch (e: any) {
            Log.log('❌ Zerodha Token Exchange Failed!');
            Log.log('Error message:', e.message);
            Log.log('Error:', e);

            const errorMsg = e.message || 'Token exchange failed';
            throw new Error(`Zerodha token exchange failed: ${errorMsg}`);
        }
    }

    async hasValidSession(): Promise<boolean> {
        try {
            if (!this.accessToken) return false;
            await this.kc.getProfile();
            return true;
        } catch {
            return false;
        }
    }

    getAccessToken(): string | null {
        return this.accessToken;
    }

    getKiteConnect(): KiteConnect {
        return this.kc;
    }

    setApiKey(key: string): void {
        this.apiKey = key;
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
            if (!this.accessToken) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching Zerodha trades...');
            const trades = await (this.kc as any).getTrades();
            Log.log('Trades fetched:', trades.length);
            return trades;
        } catch (e: any) {
            Log.log('Error fetching trades:', e.message);
            throw new Error(`Failed to fetch trades: ${e.message}`);
        }
    }

    async getPositions(): Promise<any> {
        try {
            if (!this.accessToken) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching Zerodha positions...');
            const positions = await (this.kc as any).getPositions();
            Log.log('Positions fetched');
            return positions;
        } catch (e: any) {
            Log.log('Error fetching positions:', e.message);
            throw new Error(`Failed to fetch positions: ${e.message}`);
        }
    }

    // Kite's API requires MARKET (and SL-M) orders to carry a market_protection value -
    // "Market orders without market protection are not allowed via API. Please set market
    // protection or use a Limit order." market_protection: -1 means "automatic protection
    // per exchange guidelines" (converts to a protected limit order internally, bounded by
    // the exchange's LPP range) - avoids needing a live quote, which this account's Kite
    // Connect subscription doesn't have access to anyway (getLTP returns 403 Insufficient
    // permission). Not in the kiteconnect SDK's typed params, but placeOrder() forwards
    // the whole params object through to the REST call untouched, so it's honored.
    async buyOption(tradingSymbol: string, quantity: number): Promise<{ orderId: string }> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Placing NRML market buy: ${tradingSymbol} qty=${quantity}`);
        const response = await this.kc.placeOrder('regular', {
            exchange: 'NFO',
            tradingsymbol: tradingSymbol,
            transaction_type: 'BUY',
            quantity,
            product: 'NRML',
            order_type: 'MARKET',
            market_protection: -1,
        });
        Log.log(`[Zerodha] Buy order placed: ${response.order_id}`);
        return { orderId: response.order_id };
    }

    // Polls order history until the fill (average_price) is known - Kite has no
    // bracket-order support anymore (SEBI discontinued BO/CO in 2021), so callers
    // need the real fill price before they can attach a GTT target/stop-loss.
    async getFillPrice(orderId: string, maxAttempts = 12, intervalMs = 5000): Promise<number> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const history = await this.kc.getOrderHistory(orderId);
            const latest = history[history.length - 1];

            if (latest?.status === 'COMPLETE' && latest.average_price) {
                return latest.average_price;
            }
            if (latest?.status === 'REJECTED' || latest?.status === 'CANCELLED') {
                throw new Error(`Zerodha order ${orderId} ${latest.status}`);
            }

            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        throw new Error(`Zerodha order ${orderId} did not fill within timeout`);
    }

    // Two-leg GTT (OCO): whichever trigger fires first (stop-loss or target) places
    // that SELL order and Kite auto-cancels the other leg - the modern replacement
    // for the now-discontinued bracket-order product type.
    async placeTargetStopLossGTT(
        tradingSymbol: string,
        exchange: string,
        quantity: number,
        entryPrice: number,
        targetPoints: number,
        stopLossPoints: number,
        lastPrice: number
    ): Promise<number> {
        const targetPrice = Math.round((entryPrice + targetPoints) * 100) / 100;
        const stopLossPrice = Math.round((entryPrice - stopLossPoints) * 100) / 100;

        Log.log(`[Zerodha] Placing GTT OCO for ${tradingSymbol}: stopLoss=${stopLossPrice} target=${targetPrice}`);

        const response = await this.kc.placeGTT({
            trigger_type: 'two-leg', // KiteConnect.GTT_TYPE_OCO - not in the SDK's type defs
            tradingsymbol: tradingSymbol,
            exchange,
            last_price: lastPrice,
            trigger_values: [stopLossPrice, targetPrice],
            orders: [
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: stopLossPrice },
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: targetPrice },
            ],
        });

        Log.log(`[Zerodha] GTT placed: trigger_id=${response.trigger_id}`);
        return response.trigger_id;
    }
}

export default Zerodha;
