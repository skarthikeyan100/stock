import { KiteConnect } from 'kiteconnect';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';

// NFO/BFO options tick size - Zerodha rejects GTT trigger/order prices that
// aren't an exact multiple of this (confirmed live: "Stoploss trigger price
// should be a multiple of tick size 0.05" - a plain 2-decimal round isn't
// enough, e.g. a multi-fill average entry price like 133.61363636363637
// rounds to 122.61 after subtracting stopLossPoints, which is NOT a multiple
// of 0.05). Exported so callers (e.g. zerodhaExecutor.ts) can pre-round
// values that end up in bookkeeping/exitMonitor comparisons too, so they stay
// consistent with whatever the broker actually enforces.
export const NFO_TICK_SIZE = 0.05;

export function roundToTick(price: number, tick: number = NFO_TICK_SIZE): number {
    // Round to the nearest tick, then fix up floating-point representation
    // drift (e.g. 0.05*3 = 0.15000000000000002) by rounding to 2 decimals -
    // safe since a 0.05 tick never needs more than 2 decimal places.
    return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

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

    // Public re-read hook: `order` calls this after `frontend` completes a fresh
    // OAuth login in a different process, so this already-running singleton picks
    // up the new token without a restart (see reloadSession in orderProcess.ts).
    reloadSession(): void {
        this.loadSession();
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

    async getGTTs(): Promise<any[]> {
        try {
            if (!this.accessToken) {
                throw new Error('No active session. Please login first.');
            }
            return await this.kc.getGTTs();
        } catch (e: any) {
            Log.log('Error fetching GTTs:', e.message);
            throw new Error(`Failed to fetch GTTs: ${e.message}`);
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
    async buyOption(tradingSymbol: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Placing NRML market buy: ${tradingSymbol} qty=${quantity} exchange=${exchange}`);
        const response = await this.kc.placeOrder('regular', {
            exchange,
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

    // Standalone LIMIT buy - no market_protection (that's a MARKET/SL-M-only param; a plain
    // `price` is what Kite expects for LIMIT). Used by ContinuousStrategy's target-hit
    // re-entries, which need to sit at a specific price rather than fill immediately.
    async placeLimitBuyOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Placing NRML limit buy: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
        const response = await this.kc.placeOrder('regular', {
            exchange,
            tradingsymbol: tradingSymbol,
            transaction_type: 'BUY',
            quantity,
            product: 'NRML',
            order_type: 'LIMIT',
            price,
        });
        Log.log(`[Zerodha] Limit buy order placed: ${response.order_id}`);
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
        const targetPrice = roundToTick(entryPrice + targetPoints);
        const stopLossPrice = roundToTick(entryPrice - stopLossPoints);

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

    // Replaces an existing GTT's target/stop-loss (POST /prism/settarget's Zerodha
    // path) - modifyGTT requires the full trigger definition, not just the changed
    // fields, so this re-sends the same two-leg OCO shape placeTargetStopLossGTT
    // uses, with new trigger_values.
    async modifyTargetStopLossGTT(
        triggerId: number,
        tradingSymbol: string,
        exchange: string,
        quantity: number,
        targetPrice: number,
        stopLossPrice: number,
        lastPrice: number
    ): Promise<void> {
        // Round here too (not just in placeTargetStopLossGTT) - callers (e.g.
        // setTargetStopLoss) compute these from trade.price +/- points
        // without rounding, so a non-tick entry price hits the same rejection
        // on modify as on initial placement.
        targetPrice = roundToTick(targetPrice);
        stopLossPrice = roundToTick(stopLossPrice);
        Log.log(`[Zerodha] Modifying GTT ${triggerId} for ${tradingSymbol}: stopLoss=${stopLossPrice} target=${targetPrice}`);
        await this.kc.modifyGTT(triggerId, {
            trigger_type: 'two-leg',
            tradingsymbol: tradingSymbol,
            exchange,
            last_price: lastPrice,
            trigger_values: [stopLossPrice, targetPrice],
            orders: [
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: stopLossPrice },
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: targetPrice },
            ],
        });
    }

    // Cancels a plain (non-GTT) order, e.g. a resting root-refill LIMIT buy
    // (see ContinuousStrategy's checkRootRefillDrift) - same 'regular' variety
    // used by every other order this class places.
    async cancelOrder(orderId: string): Promise<void> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Cancelling order ${orderId}`);
        await this.kc.cancelOrder(orderId, 'regular');
    }
}

export default Zerodha;
