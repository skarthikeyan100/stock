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

    // Set once the broker rejects a buy with an "ageing debit balance" error
    // (InputException - collateral margin for option buying is blocked until
    // the debit is cleared). Every subsequent buy would fail the same way, so
    // rather than keep hitting the broker and burning 90s per attempt (see
    // orderProcess.ts's OrderClient timeout), fail fast in-process instead.
    // Deliberately never auto-clears - the debit balance is an account-level
    // condition this app has no way to observe changing; recovering requires
    // a process restart once the balance is actually cleared. Sells/square-offs
    // are unaffected - they go through getKiteConnect().placeOrder() directly,
    // not buyOption()/placeLimitBuyOption().
    private buyHaltReason: string | null = null;

    isBuyHalted(): boolean {
        return this.buyHaltReason !== null;
    }

    getBuyHaltReason(): string | null {
        return this.buyHaltReason;
    }

    private assertBuysNotHalted(): void {
        if (this.buyHaltReason) {
            throw new Error(`Zerodha buying halted - ${this.buyHaltReason}`);
        }
    }

    private haltBuysOnDebitBalance(e: any): void {
        const message = e?.message ?? String(e);
        if (/ageing debit balance/i.test(message)) {
            this.buyHaltReason = message;
            Log.log(`[Zerodha] FATAL: ${message} - halting ALL further buy orders until the order process is restarted (sell/square-off is unaffected)`);
        }
    }

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

    // Standalone LIMIT buy - no market_protection (that's a MARKET/SL-M-only param; a plain
    // `price` is what Kite expects for LIMIT). Originally added for ContinuousStrategy's
    // target-hit re-entries; since 2026-09-22 this is also the ONLY entry point every
    // Zerodha buy anywhere in the app funnels through - the old buyOption() (blind
    // MARKET + market_protection:-1) was removed, since a market order has no price
    // floor at all (see zerodhaExecutor.ts's getMarketableZerodhaPrice comment for why).
    // Every caller now fetches a live ANT-sourced quote first and prices a marketable
    // limit here instead.
    async placeLimitBuyOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        this.assertBuysNotHalted();
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Placing NRML limit buy: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
        try {
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
        } catch (e) {
            this.haltBuysOnDebitBalance(e);
            throw e;
        }
    }

    // Standalone LIMIT sell, mirroring placeLimitBuyOption above (no buy-halt
    // check - that only applies to entries). Used for a target-hit exit that
    // must lock in a specific price rather than accept whatever a MARKET
    // order fills at - see BulkPcrStrategy's target-hit exit (2026-09-22
    // incident: a MARKET square-off filled below entry on a stray tick that
    // never reflected a real tradable price).
    async placeLimitSellOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Zerodha] Placing NRML limit sell: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
        const response = await this.kc.placeOrder('regular', {
            exchange,
            tradingsymbol: tradingSymbol,
            transaction_type: 'SELL',
            quantity,
            product: 'NRML',
            order_type: 'LIMIT',
            price,
        });
        Log.log(`[Zerodha] Limit sell order placed: ${response.order_id}`);
        return { orderId: response.order_id };
    }

    // Polls order history until the fill (average_price) is known - Kite has no
    // bracket-order support anymore (SEBI discontinued BO/CO in 2021), so callers
    // need the real fill price before they can attach a GTT target/stop-loss.
    async getFillPrice(
        orderId: string,
        maxAttempts = 12,
        intervalMs = 5000,
        driftCheck?: { limitPrice: number; driftPoints: number; getLtp: () => Promise<number> }
    ): Promise<number> {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const history = await this.kc.getOrderHistory(orderId);
            const latest = history[history.length - 1];

            if (latest?.status === 'COMPLETE' && latest.average_price) {
                return latest.average_price;
            }
            if (latest?.status === 'REJECTED' || latest?.status === 'CANCELLED') {
                throw new Error(`Zerodha order ${orderId} ${latest.status}`);
            }

            // Skip the drift check on the very first attempt: the resting
            // limit price (buyPrice) was itself computed from a quote that
            // can already be up to 10s stale (getMarketableZerodhaPrice's
            // cache), so comparing it against a freshly-fetched LTP
            // immediately after placement can flag "drift" that's really
            // just cache staleness at placement time, not real movement
            // since the order started resting - confirmed via code review.
            // Give it at least one real poll interval to actually rest first.
            if (driftCheck && attempt > 0) {
                // Guard the LTP fetch itself - it's a real network call (ANT quote
                // API), and a transient failure here (e.g. AliceBlue's documented
                // rate-limit 429) must not abort the whole wait/cancel/fill flow.
                // Skip just this one drift check and keep polling normally.
                let ltp: number | undefined;
                try {
                    ltp = await driftCheck.getLtp();
                } catch (e) {
                    Log.log(`[Zerodha] Drift-check LTP fetch failed for order ${orderId} - skipping this check, will retry next poll:`, e);
                }
                const drift = ltp !== undefined ? ltp - driftCheck.limitPrice : -Infinity; // one-directional, mirrors LegManager.checkRefillDrift
                if (drift > driftCheck.driftPoints) {
                    let cancelFailed = false;
                    try {
                        await this.cancelOrder(orderId);
                        Log.log(`[Zerodha] Cancelled order ${orderId} - price drifted ${drift.toFixed(2)} above limit ${driftCheck.limitPrice} (threshold ${driftCheck.driftPoints})`);
                    } catch (e) {
                        cancelFailed = true;
                        Log.log(`[Zerodha] Failed to cancel order ${orderId} after drift detected - re-checking status:`, e);
                    }
                    // Re-check status regardless of whether cancel succeeded or
                    // failed - a cancel can legitimately succeed after a PARTIAL
                    // fill (Kite cancels just the remaining unfilled qty, which is
                    // normal, not an error) just as easily as it can fail because
                    // the order fully filled in the race window (the LTP fetch
                    // above is a real network round-trip, so that window isn't
                    // negligible). Either way, don't silently discard quantity
                    // that genuinely filled at the broker (confirmed via code
                    // review - the original version threw driftCancelled
                    // unconditionally here, in both the cancel-succeeded and
                    // cancel-failed cases, which would have silently lost a fill).
                    const recheck = await this.kc.getOrderHistory(orderId);
                    const recheckLatest = recheck[recheck.length - 1];
                    if (recheckLatest?.status === 'COMPLETE' && recheckLatest.average_price) {
                        Log.log(`[Zerodha] Order ${orderId} actually filled fully during the drift-cancel race - using real fill price ${recheckLatest.average_price}`);
                        return recheckLatest.average_price;
                    }
                    // Trust the recheck's own filled_quantity regardless of
                    // whether our cancel call itself succeeded - it reflects
                    // the broker's true state as of this recheck either way.
                    // (A prior version zeroed this out when cancelFailed,
                    // which discarded a real, already-observed partial fill -
                    // fixed per code review.) If cancel failed, the order may
                    // still be resting live at the broker and able to fill
                    // further after we stop watching it here - flag that
                    // distinctly so it's visible in logs/monitoring, even
                    // though the actual handling (record what we know, then
                    // stop watching) matches this same function's pre-existing
                    // timeout-cancel-failure precedent just above.
                    const filledQuantity = Number(recheckLatest?.filled_quantity ?? 0);
                    const averagePrice = Number(recheckLatest?.average_price ?? 0);
                    if (cancelFailed) {
                        Log.log(`[Zerodha] Order ${orderId} may still be resting live at the broker after a failed drift-cancel - filled_quantity as of recheck: ${filledQuantity}`);
                    }
                    throw Object.assign(
                        new Error(
                            `Zerodha order ${orderId} cancelled - price drifted ${drift.toFixed(2)} points above limit ${driftCheck.limitPrice} (threshold ${driftCheck.driftPoints})` +
                                (filledQuantity > 0 ? ` (partial fill ${filledQuantity} @ ${averagePrice} before cancel)` : '')
                        ),
                        { driftCancelled: true, filledQuantity, averagePrice }
                    );
                }
            }

            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        // Give up waiting - but an order left resting at the broker after we
        // stop watching it is an orphan: no bookkeeping, no target/SL, no
        // exit monitoring, yet still live and able to fill later on its own.
        // Cancel it here so a market-protection LIMIT that never matched
        // (see NIFTY2690124100PE, 2026-08-31) can't silently turn into an
        // untracked position. Best-effort - if the cancel itself fails
        // (already filled/cancelled in the interim), log and still throw the
        // original timeout so the caller aborts the trade either way.
        try {
            await this.cancelOrder(orderId);
            Log.log(`[Zerodha] Cancelled unfilled order ${orderId} after fill-price timeout`);
        } catch (e) {
            Log.log(`[Zerodha] Failed to cancel unfilled order ${orderId} after fill-price timeout:`, e);
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
        await this.kc.cancelOrder('regular', orderId);
    }
}

export default Zerodha;
