import Log from '../../util/Log';
import Breeze from '../../breeze/Breeze';
import ANT from '../../ant/ANT';
import BreezeContractMaster, { FnoRecord, BreezeExchange, breezeShortNameFor, indexNameFor, strikeStepFor } from '../../breeze/BreezeContractMaster';
import BreezeOrderNotifyStream from '../../breeze/BreezeOrderNotifyStream';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import bookkeeping from './bookkeeping';
import { BuyRequest, Exchange, OptionExchange, cancelOrderWithFillRecheck, cancelRestingSellsAheadOfExit, neverShortSellable, OrderAlreadyFilledError, emptyExitTrade } from './BrokerExecutor';
import { estimateOptionPricesBatch } from './antExecutor';
import { trackPendingBreezeLimitOrder, untrackPendingBreezeLimitOrder, pendingBreezeOrderExchange, findPendingOrdersForSymbol as findPendingBreezeOrdersForSymbol } from './breezePendingLimitOrders';
import { roundToTick } from '../../kite/Kite';

// ICICI Breeze execution, mirroring kiteExecutor.ts/antExecutor.ts's shape.
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
// cancelOnTimeout: forwarded to Breeze.getFillPrice's REST fallback - pass
// false when the caller (squareOffOnBreeze) already cancels the order itself
// right after this throws, to avoid a redundant double-cancel each retry.
async function waitForBreezeFill(orderId: string, notifyTimeoutMs = 30000, restMaxAttempts = 12, restIntervalMs = 5000, cancelOnTimeout = true): Promise<number> {
    try {
        const price = await BreezeOrderNotifyStream.getInstance().waitForFill(orderId, notifyTimeoutMs);
        Log.log(`[order] Breeze order ${orderId} filled at ${price} via order-notify push`);
        return price;
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for Breeze order ${orderId} - falling back to REST fill check:`, waitErr);
        const price = await Breeze.getInstance().getFillPrice(exchangeOfOrder(orderId), orderId, restMaxAttempts, restIntervalMs, cancelOnTimeout);
        Log.log(`[order] REST fallback confirmed fill for Breeze order ${orderId} at ${price} (order-notify push was missed)`);
        return price;
    }
}

// waitForBreezeFill, but if the order ends partially filled (REST fallback throws driftCancelled with
// filledQuantity) the real partial is booked via `record` before the error is rethrown - otherwise it'd be an
// untracked position/sale at the broker.
async function waitForBreezeFillBooking(orderId: string, tpl: Partial<Trade>, record: (t: Trade) => Promise<unknown>): Promise<number> {
    try {
        return await waitForBreezeFill(orderId);
    } catch (e: any) {
        if (e?.driftCancelled && e.filledQuantity > 0) {
            const t = Object.assign(new Trade(), tpl, {
                quantity: e.filledQuantity,
                price: e.averagePrice,
                lastTradePrice: e.averagePrice,
                status: 'COMPLETE',
                broker: 'breeze',
                brokerOrderId: orderId,
            });
            await record(t);
        }
        throw e;
    }
}

// Breeze's getOrderDetail / cancelOrder / getFillPrice are all keyed by exchangeCode, and the
// BrokerExecutor interface's getFillPrice(orderId) carries no exchange (cancelOrder takes it optionally).
// So every order this process places records its exchange here, keyed by orderId, and the
// order-keyed calls look it up. An orderId this process never placed (e.g. from before an
// `order` restart) falls back to NFO - the pre-SENSEX behaviour - and a BFO order in that
// state fails loudly at the broker (wrong exchange) rather than silently acting on the wrong
// contract. Bounded so a long-running process can't grow it without limit.
const ORDER_EXCHANGE_CAP = 5000;
const orderExchange = new Map<string, BreezeExchange>();

function rememberOrderExchange(orderId: string, exchange: BreezeExchange): void {
    orderExchange.set(orderId, exchange);
    if (orderExchange.size > ORDER_EXCHANGE_CAP) {
        const oldest = orderExchange.keys().next().value;
        if (oldest !== undefined) orderExchange.delete(oldest);
    }
}

// Resolution order: this process's own record, then the Mongo-restored pending limit-order
// tracker (survives an `order` restart for resting limit sells). Only an order that is neither
// (e.g. a market buy already filled before the restart) falls back to NFO.
function exchangeOfOrder(orderId: string): BreezeExchange {
    const known = orderExchange.get(orderId) ?? pendingBreezeOrderExchange(orderId);
    if (known) return known;
    Log.log(`[order] exchangeOfOrder: no recorded exchange for Breeze order ${orderId} - defaulting to NFO`);
    return 'NFO';
}

// Exported for chunkedBuyIndex's IPC handler (orderProcess.ts), which needs
// to resolve the contract/tsym once up front for the whole chunked sequence
// and compute a real pre-trade estimatedOrderValue - see BulkPcrStrategy's
// use of this in the plan.
// SENSEX contracts use the 'SENSEX' index name in their tsym (not ICICI's 'BSESEN' stockCode)
// so every tsym-keyed path in the app (bookkeeping lot size, BFO-vs-NFO inference via
// startsWith('SENSEX'), ANT-style tsyms) treats them the same as the ANT/Kite SENSEX legs.
export function tsymFor(record: FnoRecord): string {
    return `${indexNameFor(record.shortName)}${record.strikePrice}${record.optionType}`;
}

// The tsym a live Breeze position reports (ICICI stock_code 'BSESEN' -> 'SENSEX' prefix).
function tsymFromPosition(p: any, optionType: 'CE' | 'PE'): string {
    return `${indexNameFor(String(p.stock_code))}${p.strike_price}${optionType}`;
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

async function getOptionQuote(record: FnoRecord): Promise<{ bestBid: number; bestAsk: number; ltp: number }> {
    try {
        const result = await Breeze.getInstance().getQuotes({
            stockCode: record.shortName,
            exchangeCode: record.exchange,
            productType: 'options',
            expiryDate: expiryToIso(record.expiryDate),
            right: record.optionType === 'CE' ? 'call' : 'put',
            strikePrice: record.strikePrice,
        });
        const q = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
        if (!q) throw new Error(`No quote available for ${tsymFor(record)}`);
        const bestBid = Number(q.best_bid_price);
        const bestAsk = Number(q.best_offer_price);
        // A zero/NaN side is unusable as a limit price (ICICI rejects price 0), so treat
        // it the same as a failed call and fall through to the ANT-priced fallback.
        if (bestBid > 0 && bestAsk > 0) return { bestBid, bestAsk, ltp: Number(q.ltp) };
        throw new Error(`Breeze quote for ${tsymFor(record)} has no bid/ask (bid=${q.best_bid_price}, ask=${q.best_offer_price})`);
    } catch (e: any) {
        // Breeze's contract-quote endpoint intermittently returns a generic nginx error page
        // (seen live 2026-09-23 and 2026-10-19) while the rest of its API keeps working. Every
        // caller here (buy at ask, sell at bid, square-off retries) needs a marketable limit, so
        // price off ANT's option-chain LTP with the same 5% buffer as the Kite path instead
        // of failing the entry/exit outright. Placement itself still goes through Breeze.
        Log.log(`[order] Breeze option quote failed for ${tsymFor(record)} (${String(e?.message ?? e).slice(0, 120)}) - falling back to ANT-priced bid/ask`);
        // ANT's option chain covers only each index's nearest expiry - for anything else a strike
        // match would silently price a different contract, so surface the original failure.
        const index = indexNameFor(record.shortName);
        const nearest = await BreezeContractMaster.getInstance().findNearestExpiryOption(Number(record.strikePrice), record.optionType as 'CE' | 'PE', record.shortName).catch(() => undefined);
        if (!nearest || nearest.expiryDate !== record.expiryDate) throw e;
        const strike = Number(record.strikePrice);
        const data = (await estimateOptionPricesBatch(index, [{ strike, optionType: record.optionType }])).get(`${strike}_${record.optionType}`);
        if (!data || !(data.premium > 0)) throw new Error(`No Breeze quote and no ANT price estimate available for ${tsymFor(record)}`);
        return {
            bestBid: Math.max(0.05, roundToTick(data.premium * 0.95)),
            bestAsk: roundToTick(data.premium * 1.05),
            ltp: data.premium,
        };
    }
}

// Breeze's own getQuotes has been observed live 2026-09-23 returning a
// generic nginx "resource unavailable" page for this exact contract-quote
// call - genuine API/infra flakiness (Breeze's session/auth/trades endpoints
// kept working in the same window), not a business error there's a param fix
// for. kiteExecutor.ts's getMarketableKitePrice already works around
// the identical class of problem for Kite (whose own quote/LTP endpoint
// isn't usable at all for this account) by pricing off ANT's feed instead -
// applying the same pattern here for Breeze's BUY entry pricing: ANT's LTP,
// buffered 1% and tick-rounded, exactly like getMarketableKitePrice's own
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
    const premiumData = await estimateOptionPricesBatch(indexNameFor(contract.shortName), [{ strike, optionType: contract.optionType }]);
    const data = premiumData.get(`${strike}_${contract.optionType}`);
    if (!data) throw new Error(`No ANT price estimate available for ${tsymFor(contract)}`);
    // The option chain's LTP lags a fast expiry-day option (live 2026-10-22 13:00: priced the Breeze buy
    // at 125.05 while the contract traded ~129-132, so the limit never filled, twice). Prefer ANT's live
    // ScripDetails LTP for the same contract, as kiteExecutor/antExecutor do; fall back to the chain.
    let ltp = data.premium;
    try {
        const exch = indexNameFor(contract.shortName) === 'SENSEX' ? 'BFO' : 'NFO';
        ltp = (await ANT.getInstance().getLiveQuote(exch, data.antToken)).ltp;
    } catch (liveErr: any) {
        Log.log(`[order] ANT live quote unavailable for Breeze pricing of ${tsymFor(contract)} (${liveErr?.message ?? liveErr}) - using option-chain LTP`);
    }
    return roundToTick(ltp * 1.01);
}

async function placeLimitOptionOrder(
    record: FnoRecord,
    action: 'buy' | 'sell',
    quantity: number,
    price: number
): Promise<{ orderId: string }> {
    const { orderId } = await Breeze.getInstance().placeOrder({
        stockCode: record.shortName,
        exchangeCode: record.exchange,
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
    rememberOrderExchange(orderId, record.exchange);
    return { orderId };
}

export interface BuyIndexOnBreezeRequest {
    userId: string;
    right: string; // constants.CALL ('call') or PUT ('put')
    index?: 'NIFTY' | 'SENSEX'; // defaults to NIFTY
    quantity?: number; // defaults to the resolved contract's own lot size
    targetPoints?: number;
    stopLossPoints?: number;
}

// Live spot for the underlying. NIFTY: its NSE cash quote. SENSEX: Breeze has no usable BSE cash
// quote for it (BSESEN on BSE returns no data, checked live 2026-10-21), but every BFO option quote
// carries the underlying's spot_price field - read it off the nearest-expiry contract.
async function getBreezeSpot(index: 'NIFTY' | 'SENSEX'): Promise<number> {
    const breeze = Breeze.getInstance();
    if (index === 'NIFTY') {
        const niftyQuote = await breeze.getQuotes({ stockCode: 'NIFTY', exchangeCode: 'NSE', productType: 'cash' });
        const spotRecord = Array.isArray(niftyQuote?.Success) ? niftyQuote.Success[0] : niftyQuote?.Success;
        const ltp = Number(spotRecord?.ltp);
        if (!ltp) throw new Error('Could not fetch a live NIFTY spot quote');
        return ltp;
    }
    const anyStrike = await BreezeContractMaster.getInstance().findNearestExpiryAnyStrike('SENSEX');
    const quote = await breeze.getQuotes({
        stockCode: anyStrike.shortName,
        exchangeCode: anyStrike.exchange,
        productType: 'options',
        expiryDate: expiryToIso(anyStrike.expiryDate),
        right: 'call',
        strikePrice: anyStrike.strikePrice,
    });
    const q = Array.isArray(quote?.Success) ? quote.Success[0] : quote?.Success;
    const ltp = Number(q?.spot_price);
    if (!ltp) throw new Error('Could not fetch a live SENSEX spot quote (BFO option spot_price)');
    return ltp;
}

export async function buyIndexOnBreeze(req: BuyIndexOnBreezeRequest): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) {
        throw new Error('Breeze session not active - complete /breeze/login first.');
    }

    const optionType: 'CE' | 'PE' = req.right === CALL ? 'CE' : 'PE';
    const index = req.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
    const spotLtp = await getBreezeSpot(index);

    const contract = await BreezeContractMaster.getInstance().findATMOption(spotLtp, optionType, index);
    const quantity = req.quantity ?? contract.lotSize;
    const { bestAsk } = await getOptionQuote(contract);
    const tsym = tsymFor(contract);

    Log.log(`[order] Buying ${tsym} qty=${quantity} @ ${bestAsk} (limit) for ${req.userId} via Breeze`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, bestAsk);
    const entryPrice = await waitForBreezeFillBooking(orderId, { tsym, token: contract.token, action: 'Buy', right: req.right, user: req.userId, targetPoints: req.targetPoints }, (t) => bookkeeping.recordFill(t));
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
// Breeze restart-reconciliation yet (unlike Kite/ANT's
// reconcileKitePositions/reconcileAntPositions - a real, deliberately
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
        const candidateTsym = tsymFromPosition(p, optionType);
        if (candidateTsym === tsym) {
            const contract = await BreezeContractMaster.getInstance().findOption(p.stock_code, p.expiry_date, Number(p.strike_price), optionType);
            if (contract) return contract;
        }
    }
    throw new Error(`No open Breeze position found for ${tsym} - checked bookkeeping and live broker positions`);
}

export async function squareOffOnBreeze(userId: string, tsym: string, quantity: number): Promise<Trade> {
    const pendingKey = `breeze:${userId}:${tsym}`;
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
        // Records one confirmed fill (full or partial) and folds it into the
        // running totals below - NOT necessarily the outer `quantity`
        // parameter. A resting sell can genuinely partially fill before its
        // remainder is cancelled (confirmed live field shape - see
        // getBreezeOrderFillInfo's comment); recording the full requested
        // quantity for a partial fill would silently book MORE as sold than
        // actually happened, leaving a real residual position untracked and
        // unclosable - see gaps.md's "Partial-fill accounting" entry. Each
        // call here represents one broker fill event, same as a normal
        // multi-chunk fill sequence.
        const buildSellTrade = (orderId: string, exitPrice: number, filledQty: number): Trade => {
            const trade = new Trade();
            trade.tsym = tsym;
            trade.token = contract.token;
            trade.quantity = filledQty;
            trade.price = exitPrice;
            trade.action = 'Sell';
            trade.status = 'COMPLETE';
            trade.user = userId;
            trade.broker = 'breeze';
            trade.brokerOrderId = orderId;
            return trade;
        };
        const recordSellFill = async (orderId: string, exitPrice: number, filledQty: number): Promise<void> => {
            await bookkeeping.recordFill(buildSellTrade(orderId, exitPrice, filledQty));
        };

        const maxAttempts = 4;
        let lastErr: unknown;
        // remainingQty shrinks only on a BROKER-CONFIRMED partial fill (via
        // OrderAlreadyFilledError.filledQuantity below) - every attempt
        // places a fresh order for whatever's still genuinely unsold, so a
        // multi-attempt partial sequence (e.g. 2 partial fills then a full
        // fill of the remainder) is folded into one correct total instead of
        // over/under-selling across attempts.
        // A resting limit sell for this position (e.g. BulkPcr's target chunks) must come off first, or both could fill and oversell.
        const openOnBreeze = () => bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId)?.quantity;
        const settled = await cancelRestingSellsAheadOfExit({
            pending: findPendingBreezeOrdersForSymbol(userId, tsym), cancel: cancelOrderOnBreeze, openQuantity: openOnBreeze, requested: quantity, label: `squareOffOnBreeze ${tsym} (${userId})`,
        });
        if (!(settled.quantity > 0)) {
            Log.log(`[order] squareOffOnBreeze: nothing left to sell for ${tsym} (${userId}) after resting sells settled`);
            return emptyExitTrade(userId, tsym, 'breeze');
        }
        // Resting sells were cancelled above, so none count against the live position.
        let remainingQty = await neverShortSellable({ label: `${tsym} (${userId}, Breeze)`, quantity: settled.quantity, livePosition: () => getLiveNetQuantity(tsym), restingSellQuantity: 0 });
        let bookingFailure: unknown; // a confirmed fill that could not be booked - reported, never retried with a fresh sell
        let stuck = false; // a resting order we could neither cancel nor confirm closed - stop, don't risk a double-order
        let totalFilledQty = 0;
        let totalFilledValue = 0;
        let lastOrderId = '';
        for (let attempt = 1; attempt <= maxAttempts && remainingQty > 0 && !stuck; attempt++) {
            const { bestBid } = await getOptionQuote(contract);
            Log.log(`[order] Squaring off ${tsym} qty=${remainingQty}/${quantity} @ ${bestBid} (limit, attempt ${attempt}/${maxAttempts}) for ${userId} via Breeze`);
            const { orderId } = await placeLimitOptionOrder(contract, 'sell', remainingQty, bestBid);
            lastOrderId = orderId;
            try {
                const exitPrice = await waitForBreezeFill(orderId, 8000, 1, 7000, false);
                await recordSellFill(orderId, exitPrice, remainingQty);
                totalFilledQty += remainingQty;
                totalFilledValue += remainingQty * exitPrice;
                remainingQty = 0;
                break;
            } catch (e) {
                lastErr = e;
                Log.log(`[order] Square-off attempt ${attempt}/${maxAttempts} for ${tsym} did not fully fill - cancelling stale order and re-pricing:`, e);
                try {
                    await cancelOrderOnBreeze(orderId);
                    // Cancel succeeded with no OrderAlreadyFilledError thrown -
                    // cancelOrderWithFillRecheck's own recheck positively
                    // confirmed 0 filled, so remainingQty is unchanged and the
                    // next attempt re-prices the SAME full remaining quantity.
                } catch (cancelErr) {
                    if (cancelErr instanceof OrderAlreadyFilledError) {
                        // cancelOrderOnBreeze's own recheck already positively
                        // confirmed this order filled - cancelErr.filledQuantity
                        // is the real amount (may be LESS than remainingQty, a
                        // genuine partial fill whose rest got cancelled). It
                        // just doesn't carry the price itself. Retry fetching
                        // it rather than giving up after one flaky call: we
                        // already KNOW it's filled, so a getFillPrice hiccup
                        // here must not fall through to placing a fresh sell
                        // for a quantity that includes the already-sold part
                        // (confirmed via code review: the single-attempt,
                        // 0-retry fetch below is appropriate ONLY for the "not
                        // actually confirmed" case right below it, not this one).
                        //
                        // If even the retries fail, don't fall through to the
                        // outer loop's next attempt either (that's still the
                        // same double-sell this whole branch exists to avoid)
                        // - surface the failure instead. bookkeeping.trades
                        // stays (harmlessly) stale until the next full
                        // position reconcile (reconcileBreezePositions, run
                        // at order-process startup and on a Breeze re-login)
                        // picks it up - NOT pollPendingBreezeLimitOrders,
                        // which never learns about this order in the first
                        // place: placeLimitOptionOrder (used here) never
                        // calls trackPendingBreezeLimitOrder, only
                        // placeLimitBuyBareOnBreeze/placeLimitSellBareOnBreeze
                        // do (confirmed via code review - an earlier version
                        // of this comment wrongly claimed that poller as a
                        // safety net for this specific order).
                        const filledQty = cancelErr.filledQuantity;
                        let lateFillPrice: number;
                        try {
                            lateFillPrice = await Breeze.getInstance().getFillPrice(contract.exchange, orderId, 3, 2000);
                        } catch (fillPriceErr) {
                            // Deliberately NOT wrapping the recordSellFill call
                            // below in this same catch (confirmed via code
                            // review) - a bookkeeping/Mongo failure there is a
                            // different problem than a price-fetch failure,
                            // and would otherwise get misreported under this
                            // "fetching its price failed" message.
                            Log.log(`[order] Square-off order ${orderId} confirmed already filled (qty=${filledQty}) but fetching its price failed after retries - not retrying a fresh sell (would double-sell); leaving for the next reconcile cycle:`, fillPriceErr);
                            throw fillPriceErr;
                        }
                        Log.log(`[order] Square-off order ${orderId} confirmed already filled qty=${filledQty} at ${lateFillPrice} during cancel - recording it${filledQty < remainingQty ? ' and retrying the genuine remainder' : ''}`);
                        await recordSellFill(orderId, lateFillPrice, filledQty);
                        totalFilledQty += filledQty;
                        totalFilledValue += filledQty * lateFillPrice;
                        remainingQty -= filledQty;
                        continue;
                    }
                    // A cancel can legitimately fail for an unrelated reason
                    // too - Breeze gives no way to tell "already filled" apart
                    // from any other cancel failure in that case (unlike the
                    // branch above, cancelOrderOnBreeze's own recheck did NOT
                    // confirm a fill here). Check for an actual fill (and its
                    // real quantity, not just its price) before looping into a
                    // fresh sell, or a late fill plus a new order would sell
                    // part of the same position twice.
                    try {
                        const fillInfo = await getBreezeOrderFillInfo(orderId);
                        if (!fillInfo) throw new Error('could not confirm order status');
                        if (!fillInfo.terminal) {
                            // Cancel failed AND this order is STILL genuinely
                            // resting (pending_quantity > 0) - true whether it
                            // has filled 0 or partially so far. We don't know
                            // whether it'll fill further or eventually get
                            // cancelled on its own. Placing a fresh order for
                            // "the remainder" here (even when filledQuantity
                            // is currently 0) would risk TWO live orders for
                            // the same quantity (this one, still resting,
                            // plus a new one) - a double-sell if both fill.
                            // Confirmed via code review: an earlier version
                            // only reached this branch when filledQuantity>0,
                            // so a still-resting, zero-fill-so-far order fell
                            // through to the catch below instead, which
                            // treated it as "safe to place a fresh order" -
                            // exactly the double-order risk this branch
                            // exists to prevent. Record whatever's already
                            // confirmed filled (real money, must not be
                            // dropped) and stop placing new orders; surface
                            // the stuck order for manual review instead of
                            // guessing further.
                            if (fillInfo.filledQuantity > 0) {
                                totalFilledQty += fillInfo.filledQuantity;
                                totalFilledValue += fillInfo.filledQuantity * fillInfo.avgPrice;
                                remainingQty -= fillInfo.filledQuantity;
                                try {
                                    await recordSellFill(orderId, fillInfo.avgPrice, fillInfo.filledQuantity);
                                } catch (bookErr) {
                                    bookingFailure = bookErr; // surfaced after the loop; never falls into the cancel-failure catch below
                                }
                            }
                            lastErr = new Error(
                                `order ${orderId} would not cancel and is still resting live at the broker (filled so far: ${fillInfo.filledQuantity}/${remainingQty + fillInfo.filledQuantity}) - stopping rather than risk a double-sell with a fresh order`
                            );
                            Log.log(`[order] Square-off for ${tsym}: ${(lastErr as Error).message}`);
                            stuck = true;
                            break;
                        }
                        if (fillInfo.filledQuantity <= 0) throw new Error('not filled');
                        Log.log(`[order] Square-off order ${orderId} actually filled qty=${fillInfo.filledQuantity} at ${fillInfo.avgPrice} just as cancel was attempted - recording it${fillInfo.filledQuantity < remainingQty ? ' and retrying the genuine remainder' : ''}`);
                        // The fill is confirmed real: count it first, then book it. A bookkeeping failure here is NOT a cancel failure -
                        // falling through to a fresh sell for the same quantity would double-sell, so stop and surface it.
                        totalFilledQty += fillInfo.filledQuantity;
                        totalFilledValue += fillInfo.filledQuantity * fillInfo.avgPrice;
                        remainingQty -= fillInfo.filledQuantity;
                        try {
                            await recordSellFill(orderId, fillInfo.avgPrice, fillInfo.filledQuantity);
                        } catch (bookErr) {
                            Log.log(`[order] ALERT: Breeze square-off order ${orderId} for ${tsym} (${userId}) filled qty=${fillInfo.filledQuantity} but booking it failed - stopping (no fresh sell), reconcile must pick it up:`, bookErr);
                            bookingFailure = bookErr;
                            stuck = true;
                        }
                        if (stuck) break;
                    } catch {
                        Log.log(`[order] Failed to cancel stale square-off order ${orderId} (and it did not actually fill):`, cancelErr);
                    }
                }
            }
        }
        if (bookingFailure !== undefined) {
            // Fills are real even if bookkeeping missed them (reconcile must pick them up): report them, and fail rather than
            // return a success trade for a position bookkeeping still shows open.
            throw Object.assign(
                new Error(`Square-off for ${tsym}: sold ${totalFilledQty}/${quantity} but booking a fill failed - not retrying (would double-sell): ${bookingFailure instanceof Error ? bookingFailure.message : bookingFailure}`),
                { filledQuantity: totalFilledQty, averagePrice: totalFilledQty > 0 ? totalFilledValue / totalFilledQty : 0, ...(stuck ? { orderMayBeLive: true } : {}) }
            );
        }
        if (remainingQty > 0) {
            throw Object.assign(
                new Error(
                    `Square-off for ${tsym} failed to fill after ${maxAttempts} re-priced attempts - sold ${totalFilledQty}/${quantity}, ${remainingQty} still open: ${lastErr instanceof Error ? lastErr.message : lastErr}`
                ),
                // `stuck`: a resting sell we could neither cancel nor confirm closed - a retry would sell next to it.
                { filledQuantity: totalFilledQty, averagePrice: totalFilledQty > 0 ? totalFilledValue / totalFilledQty : 0, ...(stuck ? { orderMayBeLive: true } : {}) }
            );
        }
        // Summary only - NOT re-recorded via bookkeeping.recordFill (every
        // partial/full fill above was already recorded as it happened); this
        // is purely the return value callers like squareOffChunked use to
        // fold this call's total into their own running total.
        return buildSellTrade(lastOrderId, totalFilledValue / totalFilledQty, totalFilledQty);
    } finally {
        bookkeeping.pendingSquareOffs.delete(pendingKey);
    }
}

// Breeze's own getOrderDetail record carries quantity/pending_quantity/
// cancelled_quantity as separate fields from status (confirmed live
// 2026-09-17 - see the raw sample in Breeze.getFillPrice's own comment), so
// the actual filled amount is always quantity - pending - cancelled,
// correct for a full fill (pending=cancelled=0), a genuine partial fill
// still resting (pending>0), and a partial-fill-then-cancelled order
// (cancelled>0) alike - unlike the old `average_price > 0` check (still
// true for ANY nonzero fill, partial or full), this tells the two apart.
// Shared by cancelOrderOnBreeze's isFilled below and squareOffOnBreeze's
// own cancel-failed-but-filled fallback branch, which need the same
// quantity+price pair together rather than isFilled's quantity-only view.
// terminal = pending_quantity === 0, i.e. nothing is still resting at the
// broker for this order - either the whole thing filled, or whatever didn't
// fill was genuinely cancelled/rejected. false means the order (or some
// part of it) is STILL LIVE and can fill further - callers must not treat
// filledQuantity as "the rest is safely gone" in that case (see
// cancelOrderWithFillRecheck's own terminal comment for why).
async function getBreezeOrderFillInfo(orderId: string): Promise<{ filledQuantity: number; avgPrice: number; terminal: boolean } | undefined> {
    const result = await Breeze.getInstance().getOrderDetail(exchangeOfOrder(orderId), orderId);
    const record = Array.isArray(result?.Success) ? result.Success[0] : result?.Success;
    if (!record) return undefined;
    // An order REJECTED outright (never rested at all) was never seen live
    // for this field combination, so don't trust quantity math alone to
    // derive filledQuantity for it (confirmed via code review: a rejected
    // order could plausibly report pending_quantity=0/cancelled_quantity=0
    // just like a genuinely fully-filled one, which would compute
    // filledQuantity as the FULL requested quantity - wrongly treating a
    // rejection as a complete fill). average_price is the one field
    // Breeze.getFillPrice already trusts as the fill signal - a rejection
    // never populates it, so gate on that too, not quantity arithmetic
    // alone.
    if (record.status && /rejected/i.test(String(record.status))) {
        return { filledQuantity: 0, avgPrice: 0, terminal: true };
    }
    const quantity = Number(record.quantity ?? 0);
    const pending = Number(record.pending_quantity ?? 0);
    const cancelled = Number(record.cancelled_quantity ?? 0);
    const avgPrice = Number(record.average_price ?? 0);
    return { filledQuantity: avgPrice > 0 ? Math.max(0, quantity - pending - cancelled) : 0, avgPrice, terminal: pending === 0 };
}

// Cancels and untracks - mirrors kiteExecutor.cancelOrderOnKite.
// Without the untrack, the next pollPendingBreezeLimitOrders tick would
// independently discover the same order cancelled/rejected and fire the
// cancelled-listener chain, re-placing a brand new resting sell for the
// quantity the caller just cancelled specifically to avoid double-selling
// (e.g. cancelAnyRestingLimitSell ahead of a force-close). See
// cancelOrderWithFillRecheck's own comment (BrokerExecutor.ts) for why
// untracking isn't unconditional, and why a confirmed fill always throws
// regardless of whether the cancel call itself succeeded or failed -
// squareOffOnBreeze's own retry loop below calls this directly (not through
// the generic executor.cancelOrder dispatch) and depends on that throw to
// run its own independent fill-check + recordSellFill instead of looping
// into a fresh sell for a quantity that already closed.
export async function cancelOrderOnBreeze(orderId: string, exchange?: OptionExchange): Promise<void> {
    // A caller-supplied exchange (the tracker's record for this order) beats the side-map lookup and the NFO default.
    if (exchange) rememberOrderExchange(orderId, exchange);
    const breeze = Breeze.getInstance();
    await cancelOrderWithFillRecheck({
        orderId,
        label: 'cancelOrderOnBreeze',
        cancel: () => breeze.cancelOrder(exchangeOfOrder(orderId), orderId),
        isFilled: async () => {
            const info = await getBreezeOrderFillInfo(orderId);
            return { filledQuantity: info?.filledQuantity ?? 0, terminal: info?.terminal ?? false };
        },
        untrack: () => untrackPendingBreezeLimitOrder(orderId),
    });
}

// Generic BrokerExecutor.buy() path: instrumentId is a Breeze FnoRecord.token
// (see BuyRequest's own "already resolved by the caller" contract) - resolve
// it back to the full contract, then place the same bare limit buy
// buyIndexOnBreeze does for a pre-resolved contract. No caller in this
// codebase currently reaches this path (buyIndexOnBreeze is what the IPC
// layer calls directly) - implemented for interface completeness, matching
// every other executor's buy().
export async function buyResolvedOnBreeze(request: BuyRequest): Promise<Trade> {
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
    const entryPrice = await waitForBreezeFillBooking(orderId, { tsym, token: contract.token, action: 'Buy', right: contract.optionType === 'CE' ? CALL : 'put', user: request.userId }, (t) => bookkeeping.recordFill(t));

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
// Mirrors kiteExecutor.ts's marketBuyBareOnKite/marketSellBareOnKite/
// placeLimitBuyBareOnKite/getContractByPriceRangeOnKite exactly in signature
// shape, so orderProcess.ts's bare-execution IPC handlers only branch on which of
// these (vs. the Kite equivalents) to call, based on bookkeeping.getUserBroker -
// see orderProcess.ts's case 'buyContractBare' etc. Every "market" primitive below
// is actually a LIMIT at the current best bid/ask (see file header) - ICICI rejects
// true MARKET orders on options.

function parseTsym(tradingSymbol: string): { shortName: string; strike: number; optionType: 'CE' | 'PE' } {
    const m = tradingSymbol.match(/^([A-Za-z]+?)(\d+)(CE|PE)$/);
    if (!m) throw new Error(`Cannot parse Breeze tsym: ${tradingSymbol}`);
    return { shortName: m[1], strike: Number(m[2]), optionType: m[3] as 'CE' | 'PE' };
}

// tradingSymbol/antToken here match the shape LegManager already threads through the
// Kite bare path (see LegManager.ts's "ANT token, not Kite's instrumentToken"
// comment) - trade.token is deliberately set to antToken, not contract.token, since
// live option ticks and LegManager's legsByToken map are keyed by ANT's token.
export async function marketBuyBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestAsk } = await getOptionQuote(contract);
    Log.log(`[order] Bare Breeze limit buy (at best ask) ${tradingSymbol} qty=${quantity} @ ${bestAsk} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, bestAsk);
    const entryPrice = await waitForBreezeFillBooking(orderId, { tsym: tradingSymbol, token: antToken, action: 'Buy', user: userId }, (t) => bookkeeping.recordFill(t));

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

export async function marketSellBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestBid } = await getOptionQuote(contract);
    Log.log(`[order] Bare Breeze limit sell (at best bid) ${tradingSymbol} qty=${quantity} @ ${bestBid} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, bestBid);
    const exitPrice = await waitForBreezeFillBooking(orderId, { tsym: tradingSymbol, token: antToken, action: 'Sell', user: userId }, (t) => bookkeeping.recordFill(t));

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

// ButterflyStrategy's narrow sell-to-open exception ONLY. Breeze has no position-based
// never-short guard of its own (placeLimitOptionOrder already takes a generic
// 'buy'|'sell' action, mechanically identical to marketSellBareOnBreeze above) - the
// exception here is purely at the bookkeeping layer: recordShortFill (not recordFill),
// so this fill is tracked as a short, not swallowed by the long-only Sell branch's
// "no existing entry" no-op. Never call placeLimitOptionOrder with 'sell' for a fresh
// entry from anywhere outside this function and the equivalent kite/ant/prism functions.
export async function enterShortOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestBid } = await getOptionQuote(contract);
    Log.log(`[order] [BUTTERFLY] Short-entry (sell-to-open) ${tradingSymbol} qty=${quantity} @ ${bestBid} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, bestBid);
    const entryPrice = await waitForBreezeFillBooking(orderId, { tsym: tradingSymbol, token: antToken, action: 'SellToOpen', user: userId }, (t) => bookkeeping.recordShortFill(t));

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = antToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'SellToOpen';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;
    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Closes a short opened by enterShortOnBreeze - mechanically identical to
// marketBuyBareOnBreeze above, but recorded via recordShortFill with action='BuyToClose'
// so bookkeeping's long-only Buy branch never mistakes this for a new long position.
export async function buyToCloseOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    const { bestAsk } = await getOptionQuote(contract);
    Log.log(`[order] [BUTTERFLY] Buy-to-close ${tradingSymbol} qty=${quantity} @ ${bestAsk} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, bestAsk);
    const exitPrice = await waitForBreezeFillBooking(orderId, { tsym: tradingSymbol, token: antToken, action: 'BuyToClose', user: userId }, (t) => bookkeeping.recordShortFill(t));

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = antToken;
    trade.quantity = quantity;
    trade.price = exitPrice;
    trade.lastTradePrice = exitPrice;
    trade.action = 'BuyToClose';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'breeze';
    trade.brokerOrderId = orderId;
    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Read-only live net quantity for `tradingSymbol`, for ButterflyStrategy's reconcile() to
// cross-check a persisted leg against the real broker position - mirrors
// bookkeeping.reconcileBreezePositions' own direct getPortfolioPositions() read.
export async function getLiveNetQuantity(tradingSymbol: string): Promise<number> {
    const result = await Breeze.getInstance().getPortfolioPositions();
    const rows = Array.isArray(result?.Success) ? result.Success : [];
    for (const p of rows) {
        const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
        if (!optionType) continue;
        if (tsymFromPosition(p, optionType) === tradingSymbol) return Number(p.quantity ?? 0);
    }
    return 0;
}

// Returns immediately with {orderId} - fill arrives later via
// breezePendingLimitOrders' poller, mirroring placeLimitBuyBareOnKite's contract
// exactly. Deliberately NOT wait-for-fill despite every other bare primitive here
// doing so: a root-refill limit sits below current LTP hoping for a retrace, which
// can take arbitrarily long or never happen (see LegManager's checkRefillDrift) -
// blocking here would hang LegManager's opLock indefinitely.
export async function placeLimitBuyBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, price: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    Log.log(`[order] Bare Breeze limit buy ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'buy', quantity, price);
    trackPendingBreezeLimitOrder({ orderId, userId, tradingSymbol, antToken, quantity, exchange: contract.exchange, action: 'Buy' });
    return { orderId };
}

// SELL counterpart of placeLimitBuyBareOnBreeze above - target-hit exit that
// must lock in a specific price rather than accept whatever squareOffOnBreeze's
// current-bestBid limit gets filled at (still a live-market price, not the
// strategy's own target). Returns immediately; fill arrives later via
// pollPendingBreezeLimitOrders.
export async function placeLimitSellBareOnBreeze(userId: string, tradingSymbol: string, antToken: string, quantity: number, price: number, _exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const breeze = Breeze.getInstance();
    if (!(await breeze.hasValidSession())) throw new Error('Breeze session not active - complete /breeze/login first.');
    const { shortName, strike, optionType } = parseTsym(tradingSymbol);
    const contract = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, optionType, shortName);
    quantity = await neverShortSellable({
        label: `${tradingSymbol} (${userId}, Breeze)`, quantity, livePosition: () => getLiveNetQuantity(tradingSymbol),
        restingSellQuantity: findPendingBreezeOrdersForSymbol(userId, tradingSymbol).filter((o) => o.action === 'Sell').reduce((sum, o) => sum + o.quantity, 0), recheckIfFlat: true,
    });
    Log.log(`[order] Bare Breeze limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await placeLimitOptionOrder(contract, 'sell', quantity, price);
    trackPendingBreezeLimitOrder({ orderId, userId, tradingSymbol, antToken, quantity, exchange: contract.exchange, action: 'Sell' });
    return { orderId };
}

// Breeze premium-floor strike walk - mirrors getContractByPriceRangeOnKite's shape
// exactly (kiteExecutor.ts:424-458), including reusing the SAME ANT cross-reference
// (estimateOptionPricesBatch) for premiums/antToken, for consistency and to avoid a
// second, redundant rate-limited data source. Only the final contract-resolution step
// differs (BreezeContractMaster.findNearestExpiryOption instead of KiteContractMaster's).
export async function getContractByPriceRangeOnBreeze(
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    index: 'NIFTY' | 'SENSEX' = 'NIFTY',
    minPremium = 100,
    excludeStrikes: Set<number> = new Set()
): Promise<{ tradingSymbol: string; instrumentToken: string; lotSize: number; exchange: 'NFO' | 'BFO'; strike: number; premium: number; antToken: string }> {
    const strikeStep = strikeStepFor(breezeShortNameFor(index));
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
            return { tradingSymbol: tsymFor(contract), instrumentToken: contract.token, lotSize: contract.lotSize, exchange: contract.exchange, strike, premium: data.premium, antToken: data.antToken };
        } catch (e) {
            Log.log('[order] Breeze contract resolution failed for a priced-in strike:', strike, optionType, e);
        }
    }

    throw new Error(`No ${index} ${optionType} contract found with premium >= ${minPremium} (underlyingLtp=${underlyingLtp})`);
}
