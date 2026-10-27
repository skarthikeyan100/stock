import { markNotPlaced } from '../util/notPlaced';
import { cancelThenRecheck, fillStateUnknownError } from '../util/fillWait';
import { KiteConnect } from 'kiteconnect';
import Log from '../util/Log';
import fs from 'fs';
import path from 'path';
import { sleep } from '../util/sleep';

// NFO/BFO options tick size - Kite rejects GTT trigger/order prices that
// aren't an exact multiple of this (confirmed live: "Stoploss trigger price
// should be a multiple of tick size 0.05" - a plain 2-decimal round isn't
// enough, e.g. a multi-fill average entry price like 133.61363636363637
// rounds to 122.61 after subtracting stopLossPoints, which is NOT a multiple
// of 0.05). Exported so callers (e.g. kiteExecutor.ts) can pre-round
// values that end up in bookkeeping/exitMonitor comparisons too, so they stay
// consistent with whatever the broker actually enforces.
export const NFO_TICK_SIZE = 0.05;

export function roundToTick(price: number, tick: number = NFO_TICK_SIZE): number {
    // Round to the nearest tick, then fix up floating-point representation
    // drift (e.g. 0.05*3 = 0.15000000000000002) by rounding to 2 decimals -
    // safe since a 0.05 tick never needs more than 2 decimal places.
    return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

// GTT stop leg limit sits this fraction below the trigger so the sell still fills on a gap-down
// (a LIMIT at exactly the trigger can sit unfilled while price falls through it).
export const GTT_STOP_LIMIT_BUFFER = 0.03;

export function stopLimitPrice(stopTrigger: number): number {
    return Math.max(NFO_TICK_SIZE, roundToTick(stopTrigger * (1 - GTT_STOP_LIMIT_BUFFER)));
}

class Kite {
    private static instance: Kite;

    // Kite Configuration - Update these with your actual credentials
    private apiKey = '8ugdwlq4fz81o218';
    private apiSecret = '914b3mcaxlx94jfmleikmexysueqohmn';
    private kc: KiteConnect;
    private accessToken: string | null = null;
    // Every Kite order this process has placed. The order id is the only reliable owner key: reconcileManualSells must
    // not book a system-placed sell to whichever tracked trade happens to hold the same contract (real 2026-10-27
    // 11:02: BulkPcr's 1690 sell was booked against ContinuousStrategy's 130-qty leg on the same tsym).
    private placedOrderIds = new Set<string>();
    isOwnOrder(orderId: string): boolean { return this.placedOrderIds.has(orderId); }
    private sessionFile = path.join(__dirname, '../../.kite_session.json');
    // Pre-rename session file name; read as a fallback only so an existing login survives the rename.
    private legacySessionFile = path.join(__dirname, '../../.zerodha_session.json');

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



    private assertBuysNotHalted(): void {
        if (this.buyHaltReason) {
            throw new Error(`Kite buying halted - ${this.buyHaltReason}`);
        }
    }

    private haltBuysOnDebitBalance(e: any): void {
        const message = e?.message ?? String(e);
        if (/ageing debit balance/i.test(message)) {
            this.buyHaltReason = message;
            Log.log(`[Kite] FATAL: ${message} - halting ALL further buy orders until the order process is restarted (sell/square-off is unaffected)`);
        }
    }

    private constructor() {
        this.kc = new KiteConnect({ api_key: this.apiKey });
        this.loadSession();
    }

    static getInstance(): Kite {
        if (!Kite.instance) {
            Kite.instance = new Kite();
        }
        return Kite.instance;
    }

    // Public re-read hook: `order` calls this after `frontend` completes a fresh
    // OAuth login in a different process, so this already-running singleton picks
    // up the new token without a restart (see reloadSession in orderProcess.ts).
    reloadSession(): void {
        this.loadSession();
    }

    private loadSession(): void {
        try {
            const file = fs.existsSync(this.sessionFile) ? this.sessionFile : fs.existsSync(this.legacySessionFile) ? this.legacySessionFile : null;
            if (file) {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (data.access_token) {
                    this.accessToken = data.access_token;
                    this.kc.setAccessToken(this.accessToken);
                    Log.log('Kite session loaded from file');
                } else {
                    this.accessToken = null; // file parsed but holds no token: drop the stale in-memory one
                try { this.kc.setAccessToken(''); } catch { /* ignore */ }
                }
            } else if (this.accessToken) {
                Log.log('Kite session file is gone - clearing the in-memory token');
                this.accessToken = null;
                try { this.kc.setAccessToken(''); } catch { /* ignore */ }
            }
        } catch (e) {
            Log.log('Failed to load Kite session:', e);
        }
    }

    private saveSession(): void {
        try {
            if (this.accessToken) {
                fs.writeFileSync(this.sessionFile, JSON.stringify({ access_token: this.accessToken }), { mode: 0o600 });
                Log.log('Kite session saved');
            }
        } catch (e) {
            Log.log('Failed to save Kite session:', e);
        }
    }

    getLoginURL(): string {
        const url = this.kc.getLoginURL();
        Log.log('Generated Kite login URL:', url);
        return url;
    }

    async exchangeRequestTokenForSession(requestToken: string): Promise<{ access_token: string; profile: any }> {
        try {
            Log.log('=== Kite Token Exchange Starting ===');
            Log.log('Request token:', requestToken.substring(0, 20) + '...');

            const session = await this.kc.generateSession(requestToken, this.apiSecret);

            Log.log('Kite session generated for user', session.user_id ?? '(unknown)');

            this.accessToken = session.access_token;
            this.kc.setAccessToken(this.accessToken);
            this.saveSession();

            Log.log('✓ Access token obtained and saved');
            Log.log('=== Kite Token Exchange Successful! ===');

            return {
                access_token: this.accessToken,
                profile: session
            };
        } catch (e: any) {
            Log.log('❌ Kite Token Exchange Failed!');
            Log.log('Error message:', e.message);
            Log.log('Error:', e);

            const errorMsg = e.message || 'Token exchange failed';
            throw new Error(`Kite token exchange failed: ${errorMsg}`);
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


    getKiteConnect(): KiteConnect {
        return this.kc;
    }





    async getTrades(): Promise<any[]> {
        try {
            if (!this.accessToken) {
                throw new Error('No active session. Please login first.');
            }
            Log.log('Fetching Kite trades...');
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
            Log.log('Fetching Kite positions...');
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
    // Kite buy anywhere in the app funnels through - the old buyOption() (blind
    // MARKET + market_protection:-1) was removed, since a market order has no price
    // floor at all (see kiteExecutor.ts's getMarketableKitePrice comment for why).
    // Every caller now fetches a live ANT-sourced quote first and prices a marketable
    // limit here instead.
    async placeLimitBuyOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        this.assertBuysNotHalted();
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Kite] Placing NRML limit buy: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
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
            Log.log(`[Kite] Limit buy order placed: ${response.order_id}`);
            this.placedOrderIds.add(response.order_id);
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
    // Contracts with a sell currently between its sellable-quantity check and the broker accepting the order.
    private sellsInFlight = new Set<string>();

    // NEVER-SHORT GUARD. How many of `tradingSymbol` can still be sold without going net short:
    // the lower of the broker's net position and the net implied by today's orders (overnight qty +
    // filled buys - filled sells; covers a position update that lags a fill), minus quantity already
    // resting in open sells. 2026-10-19: strategies sold their tracked quantity again on retries and
    // mass closes while earlier sells had already filled, leaving a naked short (see bugs.md).
    async getSellableQuantity(tradingSymbol: string): Promise<number> {
        const positions = await (this.kc as any).getPositions();
        const pos = (positions?.net ?? []).find((p: any) => p.tradingsymbol === tradingSymbol);
        const positionNet = Number(pos?.quantity ?? 0);
        const orders: any[] = await this.kc.getOrders();
        let ordersNet = Number(pos?.overnight_quantity ?? 0);
        let openSells = 0;
        for (const o of orders) {
            if (o.tradingsymbol !== tradingSymbol) continue;
            const filled = Number(o.filled_quantity ?? 0);
            ordersNet += o.transaction_type === 'BUY' ? filled : -filled;
            if (o.transaction_type === 'SELL' && !['COMPLETE', 'CANCELLED', 'REJECTED'].includes(String(o.status).toUpperCase())) {
                openSells += Math.max(0, Number(o.quantity ?? 0) - filled);
            }
        }
        return Math.min(positionNet, ordersNet) - openSells;
    }

    async placeLimitSellOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string; quantity: number; clamped: boolean }> {
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        // Held from the check until the broker has accepted the order (so it shows up as an open sell
        // for the next check): two concurrent sells for one contract can never both pass.
        if (this.sellsInFlight.has(tradingSymbol)) {
            throw new Error(`NEVER-SHORT GUARD: another sell for ${tradingSymbol} is in flight - refusing a concurrent sell`);
        }
        this.sellsInFlight.add(tradingSymbol);
        try {
            const sellable = await this.getSellableQuantity(tradingSymbol);
            if (sellable <= 0) {
                Log.log(`[Kite] ALERT: NEVER-SHORT GUARD refused a sell of ${quantity} ${tradingSymbol} - nothing sellable (sellable=${sellable}); the caller's position tracking is out of sync with the broker`);
                throw new Error(`NEVER-SHORT GUARD: nothing sellable for ${tradingSymbol} (sellable=${sellable}) - refusing to sell ${quantity}`);
            }
            const requestedQuantity = quantity;
            if (quantity > sellable) {
                Log.log(`[Kite] ALERT: NEVER-SHORT GUARD clamped a sell of ${tradingSymbol} from ${quantity} to ${sellable} - the caller's position tracking is out of sync with the broker`);
                quantity = sellable;
            }
            Log.log(`[Kite] Placing NRML limit sell: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
            const response = await this.kc.placeOrder('regular', {
                exchange,
                tradingsymbol: tradingSymbol,
                transaction_type: 'SELL',
                quantity,
                product: 'NRML',
                order_type: 'LIMIT',
                price,
            });
            Log.log(`[Kite] Limit sell order placed: ${response.order_id}`);
            this.placedOrderIds.add(response.order_id);
            // quantity/clamped let callers see that less than requested was actually placed.
            return { orderId: response.order_id, quantity, clamped: quantity < requestedQuantity };
        } finally {
            this.sellsInFlight.delete(tradingSymbol);
        }
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
            // A transient history-fetch failure must not abort the wait: that would skip the
            // timeout-cancel below and leave a live order resting, untracked.
            let latest: any;
            try {
                const history = await this.kc.getOrderHistory(orderId);
                latest = history[history.length - 1];
            } catch (e) {
                Log.log(`[Kite] getOrderHistory failed for order ${orderId} (attempt ${attempt + 1}/${maxAttempts}) - will retry:`, e);
                await sleep(intervalMs);
                continue;
            }

            if (latest?.status === 'COMPLETE' && latest.average_price) {
                return latest.average_price;
            }
            if (latest?.status === 'REJECTED' || latest?.status === 'CANCELLED') {
                const filledQuantity = Number(latest.filled_quantity ?? 0);
                if (filledQuantity > 0) {
                    // Partially filled, then cancelled/rejected: that quantity is real at the broker.
                    const averagePrice = Number(latest.average_price ?? 0);
                    throw Object.assign(
                        new Error(`Kite order ${orderId} ${latest.status} after a partial fill (${filledQuantity} @ ${averagePrice})`),
                        { driftCancelled: true, filledQuantity, averagePrice }
                    );
                }
                // Nothing filled: a definite refusal, so a strategy may safely re-arm ([NOT_PLACED] in the order process).
                throw markNotPlaced(new Error(`Kite order ${orderId} ${latest.status}`));
            }

            // Skip the drift check on the very first attempt: the resting
            // limit price (buyPrice) was itself computed from a quote that
            // can already be up to 5s stale (ANT.getQuote's own cache - see
            // its comment), so comparing it against a freshly-fetched LTP
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
                    Log.log(`[Kite] Drift-check LTP fetch failed for order ${orderId} - skipping this check, will retry next poll:`, e);
                }
                const drift = ltp !== undefined ? ltp - driftCheck.limitPrice : -Infinity; // one-directional, mirrors LegManager.checkRefillDrift
                if (drift > driftCheck.driftPoints) {
                    let cancelFailed = false;
                    try {
                        await this.cancelOrder(orderId);
                        Log.log(`[Kite] Cancelled order ${orderId} - price drifted ${drift.toFixed(2)} above limit ${driftCheck.limitPrice} (threshold ${driftCheck.driftPoints})`);
                    } catch (e) {
                        cancelFailed = true;
                        Log.log(`[Kite] Failed to cancel order ${orderId} after drift detected - re-checking status:`, e);
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
                    let recheck: any[];
                    try {
                        recheck = await this.kc.getOrderHistory(orderId);
                    } catch (re) {
                        // Fill state is unknown - say so loudly rather than a bare transport error.
                        throw fillStateUnknownError(`Kite order ${orderId} drift-cancel issued but the status re-check failed: ${(re as any)?.message ?? re}`, cancelFailed);
                    }
                    const recheckLatest = recheck[recheck.length - 1];
                    if (recheckLatest?.status === 'COMPLETE' && recheckLatest.average_price) {
                        Log.log(`[Kite] Order ${orderId} actually filled fully during the drift-cancel race - using real fill price ${recheckLatest.average_price}`);
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
                        Log.log(`[Kite] Order ${orderId} may still be resting live at the broker after a failed drift-cancel - filled_quantity as of recheck: ${filledQuantity}`);
                    }
                    throw Object.assign(
                        new Error(
                            `Kite order ${orderId} cancelled - price drifted ${drift.toFixed(2)} points above limit ${driftCheck.limitPrice} (threshold ${driftCheck.driftPoints})` +
                                (filledQuantity > 0 ? ` (partial fill ${filledQuantity} @ ${averagePrice} before cancel)` : '')
                        ),
                        { driftCancelled: true, filledQuantity, averagePrice }
                    );
                }
            }

            await sleep(intervalMs);
        }
        // Give up waiting - but an order left resting at the broker after we stop watching it is an orphan: no bookkeeping, no
        // target/SL, no exit monitoring, yet still live and able to fill later on its own. Cancel it (best effort; a market-protection
        // LIMIT that never matched must not silently turn into an untracked position - NIFTY2690124100PE, 2026-08-31), then re-check
        // regardless of the cancel's outcome (see cancelThenRecheck). A partial fill is surfaced the same way the drift-cancel path does.
        const settled = await cancelThenRecheck({
            label: `Kite order ${orderId}`,
            cancel: () => this.cancelOrder(orderId),
            recheck: async () => {
                const recheck = await this.kc.getOrderHistory(orderId);
                const recheckLatest = recheck[recheck.length - 1];
                if (recheckLatest?.status === 'COMPLETE' && recheckLatest.average_price) return { outcome: 'full', avgPrice: recheckLatest.average_price };
                const filledQuantity = Number(recheckLatest?.filled_quantity ?? 0);
                if (filledQuantity > 0) return { outcome: 'partial', filledQuantity, avgPrice: Number(recheckLatest?.average_price ?? 0) };
                return { outcome: 'none' };
            },
        });
        if (settled.result?.outcome === 'full') {
            Log.log(`[Kite] Order ${orderId} actually filled fully during the timeout-cancel race - using real fill price ${settled.result.avgPrice}`);
            return settled.result.avgPrice;
        }
        if (settled.result?.outcome === 'partial') {
            const { filledQuantity, avgPrice: averagePrice } = settled.result;
            throw Object.assign(
                new Error(`Kite order ${orderId} only partially filled within timeout (${filledQuantity} @ ${averagePrice}), ${settled.cancelFailed ? 'remainder may STILL BE RESTING (cancel failed)' : 'remainder cancelled'}`),
                { timeoutPartial: true, driftCancelled: true, filledQuantity, averagePrice, orderMayBeLive: settled.cancelFailed }
            );
        }
        if (settled.recheckError) {
            // Fill state is unknown - say so rather than "did not fill", which makes the caller retry the same order (double fill).
            throw fillStateUnknownError(`Kite order ${orderId} fill-price timeout: the status re-check failed: ${(settled.recheckError as any)?.message ?? settled.recheckError}`, settled.cancelFailed);
        }
        if (settled.cancelFailed) Log.log(`[Kite] ALERT: order ${orderId} did not fill within the timeout and the cancel failed - it may still be resting live at the broker`);
        throw Object.assign(new Error(`Kite order ${orderId} did not fill within timeout`), { orderMayBeLive: settled.cancelFailed });
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
        lastPrice = roundToTick(lastPrice);
        Kite.assertGttPrices(stopLossPrice, lastPrice, targetPrice);

        Log.log(`[Kite] Placing GTT OCO for ${tradingSymbol}: stopLoss=${stopLossPrice} target=${targetPrice}`);

        const response = await this.kc.placeGTT({
            trigger_type: 'two-leg', // KiteConnect.GTT_TYPE_OCO - not in the SDK's type defs
            tradingsymbol: tradingSymbol,
            exchange,
            last_price: lastPrice,
            trigger_values: [stopLossPrice, targetPrice],
            orders: [
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: stopLimitPrice(stopLossPrice) },
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: targetPrice },
            ],
        });

        Log.log(`[Kite] GTT placed: trigger_id=${response.trigger_id}`);
        return response.trigger_id;
    }

    // Kite's two-leg GTT requires stop trigger < last price < target trigger (all on the tick grid);
    // fail locally with a clear message instead of an opaque broker rejection.
    private static assertGttPrices(stopLoss: number, last: number, target: number): void {
        if (!(stopLoss > 0) || !(stopLoss < last) || !(last < target)) {
            throw new Error(`Invalid GTT prices: need 0 < stopLoss < lastPrice < target (stopLoss=${stopLoss}, last=${last}, target=${target})`);
        }
    }

    // Replaces an existing GTT's target/stop-loss (POST /prism/settarget's Kite
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
        lastPrice = roundToTick(lastPrice);
        Kite.assertGttPrices(stopLossPrice, lastPrice, targetPrice);
        Log.log(`[Kite] Modifying GTT ${triggerId} for ${tradingSymbol}: stopLoss=${stopLossPrice} target=${targetPrice}`);
        await this.kc.modifyGTT(triggerId, {
            trigger_type: 'two-leg',
            tradingsymbol: tradingSymbol,
            exchange,
            last_price: lastPrice,
            trigger_values: [stopLossPrice, targetPrice],
            orders: [
                { transaction_type: 'SELL', quantity, order_type: 'LIMIT', product: 'NRML', price: stopLimitPrice(stopLossPrice) },
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
        Log.log(`[Kite] Cancelling order ${orderId}`);
        await this.kc.cancelOrder('regular', orderId);
    }

    // NARROW EXCEPTION TO THE NEVER-SHORT GUARD (see getSellableQuantity/placeLimitSellOption
    // above): ButterflyStrategy's own 2 sell legs are allowed to open a short position, ONLY
    // after its own 2 buy legs for the same entry cycle are confirmed filled - that sequencing
    // is enforced entirely in ButterflyStrategy.ts, not here. This function deliberately does
    // NOT call getSellableQuantity/sellsInFlight and never should - any caller reaching this
    // other than the butterflySellToOpen IPC case (orderProcess.ts) is a bug.
    async placeShortEntryOption(tradingSymbol: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
        this.assertBuysNotHalted();
        if (!this.accessToken) {
            throw new Error('No active session. Please login first.');
        }
        Log.log(`[Kite] [BUTTERFLY SHORT-ENTRY] Placing NRML limit sell-to-open: ${tradingSymbol} qty=${quantity} price=${price} exchange=${exchange}`);
        let response;
        try {
            response = await this.kc.placeOrder('regular', {
                exchange,
                tradingsymbol: tradingSymbol,
                transaction_type: 'SELL',
                quantity,
                product: 'NRML',
                order_type: 'LIMIT',
                price,
            });
        } catch (e) {
            this.haltBuysOnDebitBalance(e);
            throw e;
        }
        Log.log(`[Kite] [BUTTERFLY SHORT-ENTRY] Limit sell-to-open order placed: ${response.order_id}`);
        this.placedOrderIds.add(response.order_id);
        return { orderId: response.order_id };
    }

    // Read-only live net quantity for `tradingSymbol`, for ButterflyStrategy's reconcile() to
    // cross-check a persisted leg's status against the real broker position - deliberately
    // NOT getSellableQuantity (that's guard-bearing logic for a different decision: how much
    // can still be sold without going short). Mirrors bookkeeping.reconcileKitePositions'
    // own direct getPositions() read.
    async getLiveNetQuantity(tradingSymbol: string): Promise<number> {
        const positions = await this.getPositions();
        const pos = (positions?.net ?? []).find((p: any) => p.tradingsymbol === tradingSymbol);
        return Number(pos?.quantity ?? 0);
    }
}

export default Kite;
