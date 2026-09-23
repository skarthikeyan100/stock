import Log from '../../util/Log';
import Breeze from '../../breeze/Breeze';
import BreezeContractMaster, { FnoRecord } from '../../breeze/BreezeContractMaster';
import BreezeOrderNotifyStream from '../../breeze/BreezeOrderNotifyStream';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import bookkeeping from './bookkeeping';
import { BrokerExecutor, BuyRequest, BrokerPosition, Exchange } from './BrokerExecutor';
import { estimateOptionPricesBatch } from './antExecutor';
import { trackPendingBreezeLimitOrder } from './breezePendingLimitOrders';
import { roundToTick } from '../../zerodha/Zerodha';

// ICICI Breeze execution, mirroring zerodhaExecutor.ts/antExecutor.ts's shape.
// Structurally different from both in one way: Breeze identifies a contract
// by a *structured* {stockCode, expiryDate, strikePrice, right} tuple, not a
// single numeric token/tradingsymbol - BreezeContractMaster.FnoRecord.token
// is still carried on Trade.token (same "opaque, already-resolved" contract
// per BrokerExecutor.ts's header comment) so squareOff/cancelOrder/generic
// buy() can recover the full tuple via findByToken.
//
// No bracket/cover-order protection here - CONFIRMED (not just unverified)
// via ICICI's own official API docs: "Placement, modification, or
// cancelation of Margin and Option Plus orders via the Breeze API is
// prohibited" (api.icicidirect.com/breezeapi/documents, Regulatory Changes
// section, checked 2026-09-17) - optionplus is the product type that would
// have carried a native stoploss. So every entry here is a deliberately
// unprotected "bare" buy (BuyRequest's own doc comment explicitly allows
// omitting target/stopLoss) - self-monitored protection (matching
// ContinuousStrategy's own pattern elsewhere in this codebase) is the only
// viable follow-up, not a native broker mechanism.
//
// ICICI rejects MARKET orders for the 'options' product (confirmed live:
// "Kindly pass 'limit' as parameter in order_type field instead of market") -
// every order here is a LIMIT priced at the current best bid/ask, matching
// the user's explicit choice this session (exact best price, no buffer).

// Push-based fill detection (BreezeOrderNotifyStream.waitForFill) with a
// REST-polling fallback (Breeze.getFillPrice) on any failure - identical
// shape to antExecutor.ts's enterPosition (see its comment on why: a
// waitForFill failure must never abort a trade that actually filled at the
// broker, only fall back to a slower-but-confirmed-working path). Push-path
// field-mapping is unverified as of writing (see BreezeOrderNotifyStream.ts's
// header caveat) - safe to ship ahead of that confirmation specifically
// because of this fallback.
async function waitForBreezeFill(orderId: string, notifyTimeoutMs = 30000, restMaxAttempts = 12, restIntervalMs = 5000): Promise<number> {
    try {
        const price = await BreezeOrderNotifyStream.getInstance().waitForFill(orderId, notifyTimeoutMs);
        Log.log(`[order] Breeze order ${orderId} filled at ${price} via order-notify push`);
        return price;
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for Breeze order ${orderId} - falling back to REST fill check:`, waitErr);
        const price = await Breeze.getInstance().getFillPrice('NFO', orderId, restMaxAttempts, restIntervalMs);
        Log.log(`[order] REST fallback confirmed fill for Breeze order ${orderId} at ${price} (order-notify push was missed)`);
        return price;
    }
}

// Exported for chunkedBuyIndex's IPC handler (orderProcess.ts), which needs
// to resolve the contract/tsym once up front for the whole chunked sequence
// and compute a real pre-trade estimatedOrderValue - see BulkPcrStrategy's
// use of this in the plan.
export function tsymFor(record: FnoRecord): string {
    return `${record.shortName}${record.strikePrice}${record.optionType}`;
}

// Breeze's expiryDate wire format is an ISO string anchored at 06:00 UTC for
// the given calendar date (confirmed live 2026-09-17 against a working
// getQuotes call: '2026-09-22T06:00:00.000Z' for 22-Sep-2026) - NOT simply
// `new Date(record.expiryDate).toISOString()`, which parses "DD-MMM-YYYY" as
// LOCAL midnight and would shift the date under this box's IST timezone.
// Built explicitly from the FnoRecord's own DD-MMM-YYYY string to avoid that.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function expiryToIso(expiryDate: string): string {
    const [day, mon, year] = expiryDate.split('-');
    const month = MONTHS.indexOf(mon);
    if (month === -1) throw new Error(`Unrecognized Breeze expiryDate format: ${expiryDate}`);
    return new Date(Date.UTC(Number(year), month, Number(day), 6, 0, 0)).toISOString();
}

export async function getOptionQuote(record: FnoRecord): Promise<{ bestBid: number; bestAsk: number; ltp: number }> {
    const result = await Breeze.getInstance().getQuotes({
        stockCode: record.shortName,
        exchangeCode: 'NFO',
        productType: 'options',
        expiryDate: expiryToIso(record.expiryDate),
        right: record.optionType === 'CE' ? 'call' : 'put',
        strikePrice: record.strikePrice,
    });
    const q = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
    if (!q) throw new Error(`No quote available for ${tsymFor(record)}`);
    return { bestBid: Number(q.best_bid_price), bestAsk: Number(q.best_offer_price), ltp: Number(q.ltp) };
}

// Breeze's own getQuotes has been observed live 2026-09-23 returning a
// generic nginx "resource unavailable" page for this exact contract-quote
// call - genuine API/infra flakiness (Breeze's session/auth/trades endpoints
// kept working in the same window), not a business error there's a param fix
// for. zerodhaExecutor.ts's getMarketableZerodhaPrice already works around
// the identical class of problem for Zerodha (whose own quote/LTP endpoint
// isn't usable at all for this account) by pricing off ANT's feed instead -
// applying the same pattern here for Breeze's BUY entry pricing: ANT's LTP,
// buffered 1% and tick-rounded, exactly like getMarketableZerodhaPrice's own
// BUY case. Breeze's own API is still used for the actual order placement -
// only pricing is rerouted.
//
// Uses estimateOptionPricesBatch (option-chain based), NOT estimateOptionPrice
// (single-quote/OHLC based) - confirmed live 2026-09-23 that estimateOptionPrice
// hit ANT's OHLC endpoint's documented 429 rate limit here (see
// estimateOptionPricesBatch's own comment: "the OHLC endpoint rate-limits
// (429) after just 1-2 rapid calls"). getContractByPriceRangeOnBreeze right
// below already uses the batch helper for the identical reason.
export async function getMarketableBreezeBuyPrice(contract: FnoRecord): Promise<number> {
    const strike = Number(contract.strikePrice);
    const premiumData = await estimateOptionPricesBatch('NIFTY', [{ strike, optionType: contract.optionType }]);
    const data = premiumData.get(`${strike}_${contract.optionType}`);
    if (!data) throw new Error(`No ANT price estimate available for ${tsymFor(contract)}`);
    return roundToTick(data.premium * 1.01);
}

async function placeLimitOptionOrder(
    record: FnoRecord,
    action: 'buy' | 'sell',
    quantity: number,
    price: number
): Promise<{ orderId: string }> {
    return Breeze.getInstance().placeOrder({
        stockCode: record.shortName,
        exchangeCode: 'NFO',
        product: 'options',
        action,
        orderType: 'limit',
        quantity: String(quantity),
        price: String(price),
        validity: 'day',
        disclosedQuantity: '0',
        expiryDate: expiryToIso(record.expiryDate),
        right: record.optionType === 'CE' ? 'call' : 'put',
        strikePrice: record.strikePrice,
        userRemark: 'BreezeIntegration', // ICICI rejects non-alphanumeric user_remark (confirmed live)
    });
}

export interface BuyIndexOnBreezeRequest {
    userId: string;
    right: string; // constants.CALL ('call') or PUT ('put')
    quantity?: number; // defaults to the resolved contract's own lot size
    targetPoints?: number;
    stopLossPoints?: number;
}

export async function buyIndexOnBreeze(req: BuyIndexOnBreezeRequest): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) {
        throw new Error('Breeze session not active - complete /breeze/login first.');
    }

    const optionType: 'CE' | 'PE' = req.right === CALL ? 'CE' : 'PE';
    const niftyQuote = await breeze.getQuotes({ stockCode: 'NIFTY', exchangeCode: 'NSE', productType: 'cash' });
    const spotRecord = Array.isArray(niftyQuote?.Success) ? niftyQuote.Success[0] : niftyQuote?.Success;
    const niftyLtp = Number(spotRecord?.ltp);
    if (!niftyLtp) throw new Error('Could not fetch a live NIFTY spot quote');

    const contract = await BreezeContractMaster.getInstance().findATMOption(niftyLtp, optionType, 'NIFTY');
    const quantity = req.quantity ?? contract.lotSize;
    const { bestAsk } = await getOptionQuote(contract);
    const tsym = tsymFor(contract);

    Log.log(`[order] Buying ${tsym} qty=${quantity} @ ${bestAsk} (limit) for ${req.userId} via Breeze`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, bestAsk);
    const entryPrice = await waitForBreezeFill(orderId);
    Log.log(`[order] Filled ${tsym} at ${entryPrice} for ${req.userId} via Breeze`);

    const trade = new Trade();
    trade.tsym = tsym;
    trade.token = contract.token;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.right = req.right;
    trade.user = req.userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;
    trade.targetPoints = req.targetPoints;

    // Deliberately no finalizeEntry-style GTT/exitMonitor step - see file
    // header. Directly records the fill, same as every broker's tail call.
    await bookkeeping.recordFill(trade);
    return trade;
}

// Restart-safety fallback: bookkeeping.trades is in-memory only and has no
// Breeze restart-reconciliation yet (unlike Zerodha/ANT's
// reconcileZerodhaPositions/reconcileAntPositions - a real, deliberately
// deferred gap, not this pass's scope). Rather than leave a position that
// happens to outlive an `order` restart unclosable, fall back to asking
// Breeze's own live positions for the contract details directly - the same
// "broker is the source of truth" principle those other reconcile functions
// already use, just applied on demand instead of at startup.
async function resolveOpenBreezeContract(tsym: string, existingToken: string | undefined): Promise<FnoRecord> {
    if (existingToken) {
        const contract = await BreezeContractMaster.getInstance().findByToken(existingToken);
        if (contract) return contract;
    }
    const positionsResult = await Breeze.getInstance().getPortfolioPositions();
    const rows = Array.isArray(positionsResult?.Success) ? positionsResult.Success : [];
    for (const p of rows) {
        const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
        if (!optionType) continue;
        const candidateTsym = `${p.stock_code}${p.strike_price}${optionType}`;
        if (candidateTsym === tsym) {
            const contract = await BreezeContractMaster.getInstance().findOption(p.stock_code, p.expiry_date, Number(p.strike_price), optionType);
            if (contract) return contract;
        }
    }
    throw new Error(`No open Breeze position found for ${tsym} - checked bookkeeping and live broker positions`);
}

export async function squareOffOnBreeze(userId: string, tsym: string, quantity: number): Promise<Trade> {
    const pendingKey = `${userId}:${tsym}`;
    if (bookkeeping.pendingSquareOffs.has(pendingKey)) {
        Log.log(`[order] squareOffOnBreeze: square-off for ${tsym} (${userId}) already in flight - ignoring duplicate call`);
        throw new Error(`Square-off for ${tsym} is already in progress for ${userId}`);
    }
    bookkeeping.pendingSquareOffs.add(pendingKey);

    try {
        const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);
        const contract = await resolveOpenBreezeContract(tsym, existing?.token);

        // A single static-price limit sell can rest unfilled indefinitely if
        // price moves away before it's marketable (confirmed live 2026-09-21:
        // BulkPcrStrategy's target-hit sell placed a limit at bestBid, price
        // fell away, the order never filled, and chunkedSquareOff timed out
        // at the (then-90s) order-IPC boundary with the position still open
        // and the stale order still resting - see CLAUDE.md's code-review
        // note). ICICI rejects true market orders for options (see this
        // file's header comment), so the fix is to re-price against a fresh
        // best bid and retry, cancelling the previous attempt's stale order
        // each time. Each attempt is capped short (8s push wait + 1x7s REST
        // poll, ~15s), so maxAttempts=4 is ~60s worst case for one chunk -
        // this can be called up to 8 times sequentially for BulkPcrStrategy's
        // full 13975 qty (NIFTY's 1755 freeze cap), which is why
        // OrderClient.chunkedSquareOff/chunkedBuyIndex now use a 15-minute
        // IPC timeout instead of the 90s default every other (single-order)
        // request type keeps - see OrderClient.ts's CHUNKED_ORDER_TIMEOUT_MS.
        const recordSellFill = async (orderId: string, exitPrice: number): Promise<Trade> => {
            const trade = new Trade();
            trade.tsym = tsym;
            trade.token = contract.token;
            trade.quantity = quantity;
            trade.price = exitPrice;
            trade.action = 'Sell';
            trade.status = 'COMPLETE';
            trade.user = userId;
            trade.broker = 'breeze';
            trade.brokerOrderId = orderId;
            await bookkeeping.recordFill(trade);
            return trade;
        };

        const maxAttempts = 4;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const { bestBid } = await getOptionQuote(contract);
            Log.log(`[order] Squaring off ${tsym} qty=${quantity} @ ${bestBid} (limit, attempt ${attempt}/${maxAttempts}) for ${userId} via Breeze`);
            const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, bestBid);
            try {
                const exitPrice = await waitForBreezeFill(orderId, 8000, 1, 7000);
                return await recordSellFill(orderId, exitPrice);
            } catch (e) {
                lastErr = e;
                Log.log(`[order] Square-off attempt ${attempt}/${maxAttempts} for ${tsym} did not fill - cancelling stale order and re-pricing:`, e);
                try {
                    await cancelOrderOnBreeze(orderId);
                } catch (cancelErr) {
                    // A cancel can legitimately fail because the order already
                    // filled in the gap between our short wait timing out and
                    // this cancel call - a real exchange race, not hypothetical
                    // (Breeze gives no way to tell "already filled" apart from
                    // any other cancel failure up front). Check for an actual
                    // fill before looping into a fresh sell, or a late fill
                    // plus a new order would sell the same position twice.
                    try {
                        const lateFillPrice = await Breeze.getInstance().getFillPrice('NFO', orderId, 1, 0);
                        Log.log(`[order] Square-off order ${orderId} actually filled at ${lateFillPrice} just as cancel was attempted - using it, not retrying`);
                        return await recordSellFill(orderId, lateFillPrice);
                    } catch {
                        Log.log(`[order] Failed to cancel stale square-off order ${orderId} (and it did not actually fill):`, cancelErr);
                    }
                }
            }
        }
        throw new Error(`Square-off for ${tsym} failed to fill after ${maxAttempts} re-priced attempts: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    } finally {
        bookkeeping.pendingSquareOffs.delete(pendingKey);
    }
}

export async function cancelOrderOnBreeze(orderId: string): Promise<void> {
    await Breeze.getInstance().cancelOrder('NFO', orderId);
}

// Generic BrokerExecutor.buy() path: instrumentId is a Breeze FnoRecord.token
// (see BuyRequest's own "already resolved by the caller" contract) - resolve
// it back to the full contract, then place the same bare limit buy
// buyIndexOnBreeze does for a pre-resolved contract. No caller in this
// codebase currently reaches this path (buyIndexOnBreeze is what the IPC
// layer calls directly) - implemented for interface completeness, matching
// every other executor's buy().
async function buyResolvedOnBreeze(request: BuyRequest): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) {
        throw new Error('Breeze session not active - complete /breeze/login first.');
    }
    const contract = await BreezeContractMaster.getInstance().findByToken(request.instrumentId);
    if (!contract) {
        throw new Error(`Breeze contract master has no record for token ${request.instrumentId}`);
    }
    const buyPrice = await getMarketableBreezeBuyPrice(contract);
    const tsym = tsymFor(contract);

    Log.log(`[order] Buying ${tsym} qty=${request.quantity} @ ${buyPrice} (limit, ANT-priced) for ${request.userId} via Breeze`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', request.quantity, buyPrice);
    const entryPrice = await waitForBreezeFill(orderId);

    const trade = new Trade();
    trade.tsym = tsym;
    trade.token = contract.token;
    trade.quantity = request.quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.right = contract.optionType === 'CE' ? CALL : 'put';
    trade.user = request.userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;

    await bookkeeping.recordFill(trade);
    return trade;
}

// --- Bare execution primitives (LegManager: ContinuousStrategy/SupportResistanceStrategy) ---
// Mirrors zerodhaExecutor.ts's marketBuyBareOnZerodha/marketSellBareOnZerodha/
// placeLimitBuyBareOnZerodha/getContractByPriceRangeOnZerodha exactly in signature
// shape, so orderProcess.ts's bare-execution IPC handlers only branch on which of
// these (vs. the Zerodha equivalents) to call, based on bookkeeping.getUserBroker -
// see orderProcess.ts's case 'buyContractBare' etc. Every "market" primitive below
// is actually a LIMIT at the current best bid/ask (see file header) - ICICI rejects
// true MARKET orders on options.

function parseTsym(tradingSymbol: string): { shortName: string; strike: number; optionType: 'CE' | 'PE' } {
    const m = tradingSymbol.match(/^([A-Za-z]+?)(\d+)(CE|PE)$/);
    if (!m) throw new Error(`Cannot parse Breeze tsym: ${tradingSymbol}`);
    return { shortName: m[1], strike: Number(m[2]), optionType: m[3] as 'CE' | 'PE' };
}

// tradingSymbol/antToken here match the shape LegManager already threads through the
// Zerodha bare path (see LegManager.ts's "ANT token, not Zerodha's instrumentToken"
// comment) - trade.token is deliberately set to antToken, not contract.token, since
// live option ticks and LegManager's legsByToken map are keyed by ANT's token.
export async function marketBuyBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestAsk } = await getOptionQuote(contract);
    Log.log(`[order] Bare Breeze limit buy (at best ask) ${tradingSymbol} qty=${quantity} @ ${bestAsk} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, bestAsk);
    const entryPrice = await waitForBreezeFill(orderId);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = antToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;
    await bookkeeping.recordFill(trade);
    return trade;
}

export async function marketSellBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestBid } = await getOptionQuote(contract);
    Log.log(`[order] Bare Breeze limit sell (at best bid) ${tradingSymbol} qty=${quantity} @ ${bestBid} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, bestBid);
    const exitPrice = await waitForBreezeFill(orderId);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = antToken;
    trade.quantity = quantity;
    trade.price = exitPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;
    await bookkeeping.recordFill(trade);
    return trade;
}

// Returns immediately with {orderId} - fill arrives later via
// breezePendingLimitOrders' poller, mirroring placeLimitBuyBareOnZerodha's contract
// exactly. Deliberately NOT wait-for-fill despite every other bare primitive here
// doing so: a root-refill limit sits below current LTP hoping for a retrace, which
// can take arbitrarily long or never happen (see LegManager's checkRefillDrift) -
// blocking here would hang LegManager's opLock indefinitely.
export async function placeLimitBuyBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    Log.log(`[order] Bare Breeze limit buy ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, price);
    trackPendingBreezeLimitOrder({ orderId, userId, tradingSymbol, antToken, quantity, exchange, action: 'Buy' });
    return { orderId };
}

// SELL counterpart of placeLimitBuyBareOnBreeze above - target-hit exit that
// must lock in a specific price rather than accept whatever squareOffOnBreeze's
// current-bestBid limit gets filled at (still a live-market price, not the
// strategy's own target). Returns immediately; fill arrives later via
// pollPendingBreezeLimitOrders.
export async function placeLimitSellBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    Log.log(`[order] Bare Breeze limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, price);
    trackPendingBreezeLimitOrder({ orderId, userId, tradingSymbol, antToken, quantity, exchange, action: 'Sell' });
    return { orderId };
}

// Breeze premium-floor strike walk - mirrors getContractByPriceRangeOnZerodha's shape
// exactly (zerodhaExecutor.ts:424-458), including reusing the SAME ANT cross-reference
// (estimateOptionPricesBatch) for premiums/antToken, for consistency and to avoid a
// second, redundant rate-limited data source. Only the final contract-resolution step
// differs (BreezeContractMaster.findNearestExpiryOption instead of ZerodhaContractMaster's).
export async function getContractByPriceRangeOnBreeze(
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    index: 'NIFTY' | 'SENSEX' = 'NIFTY',
    minPremium = 100,
    excludeStrikes: Set<number> = new Set()
): Promise<{ tradingSymbol: string; instrumentToken: string; lotSize: number; exchange: 'NFO' | 'BFO'; strike: number; premium: number; antToken: string }> {
    const strikeStep = index === 'SENSEX' ? 100 : 50;
    const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;

    const candidateStrikes: number[] = [];
    for (let depth = 0; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike + depth * strikeStep : atmStrike - depth * strikeStep;
        if (!excludeStrikes.has(strike)) candidateStrikes.push(strike);
    }
    for (let depth = 1; depth < 5; depth++) {
        const strike = optionType === 'CE' ? atmStrike - depth * strikeStep : atmStrike + depth * strikeStep;
        if (!excludeStrikes.has(strike)) candidateStrikes.push(strike);
    }

    const premiumData = await estimateOptionPricesBatch(index, candidateStrikes.map((strike) => ({ strike, optionType })));

    for (const strike of candidateStrikes) {
        const data = premiumData.get(`${strike}_${optionType}`);
        if (data == null || data.premium < minPremium) continue;
        try {
            const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, index);
            return { tradingSymbol: tsymFor(contract), instrumentToken: contract.token, lotSize: contract.lotSize, exchange: 'NFO', strike, premium: data.premium, antToken: data.antToken };
        } catch (e) {
            Log.log('[order] Breeze contract resolution failed for a priced-in strike:', strike, optionType, e);
        }
    }

    throw new Error(`No ${index} ${optionType} contract found with premium >= ${minPremium} (underlyingLtp=${underlyingLtp})`);
}

async function getPositionsOnBreeze(): Promise<BrokerPosition[]> {
    const result = await Breeze.getInstance().getPortfolioPositions();
    const rows = Array.isArray(result?.Success) ? result.Success : [];
    // Field names confirmed live 2026-09-17 against a real open position:
    // {stock_code, expiry_date, strike_price, right: "Call"|"Put", quantity,
    //  average_price, exchange_code, ...} - notably NO token field, unlike
    // Zerodha/ANT's position responses, so instrumentId is resolved via
    // BreezeContractMaster rather than read directly off the row.
    return Promise.all(
        rows.map(async (r: any) => {
            const optionType = r.right === 'Call' ? 'CE' : r.right === 'Put' ? 'PE' : undefined;
            const contract = optionType
                ? await BreezeContractMaster.getInstance().findOption(r.stock_code, r.expiry_date, Number(r.strike_price), optionType)
                : undefined;
            return {
                tradingSymbol: r.stock_code ?? '',
                instrumentId: contract?.token ?? '',
                quantity: Number(r.quantity ?? 0),
                avgPrice: Number(r.average_price ?? 0),
                exchange: r.exchange_code ?? 'NFO',
            };
        })
    );
}

async function getTradesOnBreeze(): Promise<Trade[]> {
    const today = new Date();
    const fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 1);
    const result = await Breeze.getInstance().getTradeList({
        fromDate: fromDate.toISOString(),
        toDate: today.toISOString(),
        exchangeCode: 'NFO',
    });
    const rows = Array.isArray(result?.Success) ? result.Success : [];
    return rows.map((r: any) => {
        const trade = new Trade();
        trade.tsym = r.stock_code ?? r.stockCode ?? '';
        trade.action = r.action;
        trade.quantity = Number(r.quantity ?? 0);
        trade.broker = 'breeze';
        trade.price = Number(r.execution_price ?? r.average_cost ?? 0);
        trade.brokerOrderId = r.order_id;
        return trade;
    });
}

export const BreezeExecutor: BrokerExecutor = {
    brokerName: 'breeze',
    hasValidSession: () => Breeze.getInstance().hasValidSession(),
    buy: buyResolvedOnBreeze,
    squareOff: (userId: string, tradingSymbol: string, quantity: number, _exchange: Exchange) =>
        squareOffOnBreeze(userId, tradingSymbol, quantity),
    squareOffLimit: (userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: Exchange, limitPrice: number) =>
        placeLimitSellBareOnBreeze(userId, tradingSymbol, instrumentId, quantity, limitPrice, exchange as 'NFO' | 'BFO'),
    cancelOrder: cancelOrderOnBreeze,
    getFillPrice: (orderId: string) => Breeze.getInstance().getFillPrice('NFO', orderId),
    getPositions: getPositionsOnBreeze,
    getTrades: getTradesOnBreeze,
};
