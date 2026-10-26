import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import { cancelOrderWithFillRecheck } from './BrokerExecutor';
import { roundToTick } from '../../kite/Kite';
import AntOrderNotifyStream from '../../ant/AntOrderNotifyStream';
import AntContractMaster from '../../ant/AntContractMaster';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { trackPendingAntLimitOrder, untrackPendingAntLimitOrder, pendingAntSellsFor, isPendingAntOrder, PendingAntLimitOrder } from './pendingAntLimitOrders';
import { sleep } from '../../util/sleep';

// AliceBlue/ANT execution, mirroring kiteExecutor.ts's shape and the same
// per-user useGTT gating (bookkeeping.getUserUseGTT) - but the actual
// broker-side bracket mechanism differs structurally from Kite's GTT:
//
// Kite: buy (market) -> learn fill price -> place a SEPARATE two-leg GTT
// referencing that fill price. The GTT is placed AFTER entry.
//
// AliceBlue: a Bracket Order (orderComplexity=BO) IS the entry order itself -
// there is no confirmed "attach a bracket to an already-open position"
// endpoint, so the BO call both enters the position and sets up the
// target/SL legs in one shot, before the fill price is known. See the note
// on ANT.placeBracketOrder for why target/SL are passed as point offsets
// rather than absolute prices.
//
// Field names/shapes here (targetLegPrice/slLegPrice as points, the BO exit
// endpoint, array-wrapped request bodies) come from AliceBlue's own
// documentation, which disagrees with itself in places - NOT yet verified
// against a live response. See the plan's verification section.

// Resolves a BUY whose fill the order-history poll could not confirm (transport errors,
// or a timeout). Returns what is actually held. Never guesses:
//  - a full fill in the trade book is recorded as is;
//  - otherwise the resting order is cancelled (only when mayCancel - a bracket/cover parent
//    is left to the broker, cancelling it would also drop its protection legs), the cancel is
//    waited on until the order is terminal, and the trade book is re-read;
//  - any inability to establish the outcome throws for manual review, with the order id.
// Quantity 0 is returned only when the broker confirms nothing filled; the original poll
// error is then rethrown so the caller reports the failure as before.
async function resolveUnconfirmedAntBuy(
    ant: ANT,
    orderNo: string,
    requested: number,
    mayCancel: boolean,
    pollErr: any
): Promise<{ quantity: number; avgPrice: number }> {
    const manualReview = (why: string) =>
        new Error(`ANT order ${orderNo} fill status unresolved (${why}) - manual review required. Poll error: ${pollErr?.message ?? pollErr}`);
    const terminal = isTerminalOrderStatus;

    let before: { quantity: number; avgPrice: number } | null = null;
    try {
        before = await ant.getFilledFromTradeBook(orderNo);
    } catch (e: any) {
        Log.log(`[order] trade-book lookup failed for ${orderNo} before cancel: ${e?.message ?? e}`);
    }
    if (before && before.quantity === requested) return before;

    // The broker already REJECTED this order: it never reached the exchange, so nothing filled and there is nothing to
    // cancel (the cancel only produced "order is not open to cancel" noise on every retry, live 2026-10-22).
    if (/\bREJECTED\b/.test(String(pollErr?.message ?? '')) && !(before && before.quantity > 0)) {
        Log.log(`[order] ANT order ${orderNo} was REJECTED at the broker - nothing filled, not cancelling`);
        throw pollErr;
    }

    if (!mayCancel) {
        throw manualReview(`bracket/cover parent, not auto-cancelled; trade book shows ${before?.quantity ?? 'unknown'}/${requested}`);
    }

    // Fill quantity as order history reports it. Used to catch a trade book that lags or
    // lists nothing for an order history already shows as partially filled.
    let statusFilledQty = 0;
    let cancelErr: any = null;
    try {
        await ant.cancelOrder(orderNo);
    } catch (e) {
        cancelErr = e;
    }
    if (cancelErr) {
        // Cancel didn't go through: the order is dead only if its status is terminal.
        const status = await ant.getOrderStatus(orderNo).catch(() => null);
        if (!status || !terminal(status.status)) {
            throw manualReview(`cancel failed: ${cancelErr?.message ?? cancelErr}, order not terminal`);
        }
        statusFilledQty = status.filledQuantity ?? 0;
    } else {
        // Cancel accepted, but fills can still be in flight until the broker reports the
        // order terminal. Read the trade book only after that, never mid-cancel.
        let settled = false;
        for (let i = 0; i < 10 && !settled; i++) {
            const status = await ant.getOrderStatus(orderNo).catch(() => null);
            settled = !!status && terminal(status.status);
            if (settled) statusFilledQty = status!.filledQuantity ?? 0;
            else await sleep(1000);
        }
        if (!settled) throw manualReview('cancel accepted but order never reached a terminal status');
    }

    let after: { quantity: number; avgPrice: number };
    try {
        after = await ant.getFilledFromTradeBook(orderNo);
    } catch (e: any) {
        throw manualReview(`order cancelled but trade-book read failed: ${e?.message ?? e}`);
    }
    if (after.quantity === 0) {
        if (statusFilledQty > 0) {
            throw manualReview(`order history reports ${statusFilledQty} filled but trade book lists none`);
        }
        Log.log(`[order] ANT order ${orderNo} confirmed unfilled after cancel`);
        throw pollErr;
    }
    return after;
}

// A sizing quote is reused for entry only while it's this fresh; past that, quote again.
const KNOWN_LTP_MAX_AGE_MS = 5000;

// Entry price. A buy that was already sized quoted once: if that quote failed, refuse now rather
// than running the backoff a second time. An explicit-quantity buy quotes here, with the full backoff.
async function entryLtp(known: { ltp: number; atMs: number } | undefined, exch: string, token: string): Promise<number> {
    if (known === undefined) return requireAntLtp(exch, token);
    if (known.ltp > 0 && Date.now() - known.atMs < KNOWN_LTP_MAX_AGE_MS) return known.ltp;
    if (known.ltp > 0) return requireAntLtp(exch, token); // usable but stale: one fresh quote
    throw new Error(`ANT quote unavailable for ${token} - order not placed`);
}

// Sizing quote for an unsized manual buy. Cache bypassed so the timestamp is honest, and the same
// price is the entry price (see entryLtp). A 0 means the quote failed after its backoff.
async function sizingQuote(exch: string, token: string): Promise<{ ltp: number; atMs: number }> {
    const ltp = await safeAntQuote(exch, token, SAFE_QUOTE_BACKOFF_MS, true);
    return { ltp, atMs: Date.now() };
}

// Both manual-buy branches (contract and strike) size and enter the same way.
async function enterManualBuy(req: ManualBuyRequest, tsym: string, token: string, exch: 'NFO' | 'BFO', targetPoints: number, stopLossPoints: number): Promise<Trade> {
    const sized = req.quantity != null ? undefined : await sizingQuote(exch, token);
    const quantity = sizeManualBuyOrRefuse(req, tsym, sized?.ltp);
    return enterPosition(req.userId, tsym, token, quantity, exch, targetPoints, stopLossPoints, 'bracket', sized);
}

// An unsized buy needs a price to size from. Without one, refuse: the entry also needs a limit price,
// so a quote outage blocks it either way. The one-lot default (resolveManualBuyQuantity) only applies when
// a price is known but no investment amount is set.
function sizeManualBuyOrRefuse(req: ManualBuyRequest, tsym: string, price: number | undefined): number {
    const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, tsym, price ?? 0, req.quantity);
    if (req.quantity == null && !((price ?? 0) > 0)
        && bookkeeping.getUserContext(req.userId).investmentMode === 'investmentAmount') {
        throw new Error(`Manual buy ${tsym}: no ANT price to size an investment-amount order - not placed`);
    }
    return quantity;
}

export async function enterPosition(
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: 'NFO' | 'BFO',
    targetPoints: number,
    stopLossPoints: number,
    orderMode: 'bracket' | 'cover' | 'target-only' = 'bracket',
    knownLtp?: { ltp: number; atMs: number },
    marketEntry?: { underlyingOpen: number; marketProtectionPercent: string; product?: 'INTRADAY' | 'LONGTERM' }
): Promise<Trade> {
    if (marketEntry && !(marketEntry.underlyingOpen > 0)) {
        throw new Error(`enterPosition ${tradingSymbol}: invalid underlyingOpen ${marketEntry.underlyingOpen} - order not placed`);
    }
    // marketEntry only makes sense for the plain (non-bracket/cover) MARKET-buy path -
    // a caller passing it together with orderMode 'bracket'/'cover' would have
    // marketEntry silently ignored below (useCover/useBracket are checked first in the
    // if/else-if chain), which could look like MARKET+protection was used when it
    // wasn't. Fail loudly instead of silently picking the other branch.
    if (marketEntry && orderMode !== 'target-only') {
        throw new Error(`enterPosition ${tradingSymbol}: marketEntry is only supported with orderMode 'target-only' (got '${orderMode}') - order not placed`);
    }

    const ant = ANT.getInstance();
    const useCover = orderMode === 'cover';
    const useBracket = !useCover && targetPoints > 0 && stopLossPoints > 0 && bookkeeping.getUserUseGTT(userId);

    let orderNo: string;
    if (useCover) {
        Log.log(`[order] Buying ${tradingSymbol} qty=${quantity} for ${userId} via ANT cover order (sl=${stopLossPoints})`);
        ({ orderNo } = await ant.placeCoverOrder({
            exchange,
            instrumentId,
            tradingSymbol,
            quantity,
            transactionType: 'BUY',
            stopLossPoints,
        }));
    } else if (useBracket) {
        // Confirmed live: ANT rejects MARKET orders for Bracket Orders
        // ("Market orders are not allowed") - needs a LIMIT price. Priced
        // slightly above the current LTP (a marketable limit) so it fills
        // immediately like a market buy would.
        const ltp = await entryLtp(knownLtp, exchange, instrumentId);
        const limitPrice = roundToTick(ltp * 1.01);
        Log.log(`[order] Buying ${tradingSymbol} qty=${quantity} for ${userId} via ANT bracket order (ltp=${ltp} limit=${limitPrice} target=${targetPoints} sl=${stopLossPoints})`);
        ({ orderNo } = await ant.placeBracketOrder({
            exchange,
            instrumentId,
            tradingSymbol,
            quantity,
            transactionType: 'BUY',
            price: limitPrice,
            targetPoints,
            stopLossPoints,
        }));
    } else if (marketEntry) {
        // MARKET + market protection: no pre-trade LTP needed (skips entryLtp -> throttled OHLC quote).
        Log.log(`[order] Buying ${tradingSymbol} qty=${quantity} for ${userId} via ANT MARKET order (protection=${marketEntry.marketProtectionPercent}%)`);
        try {
            ({ orderNo } = await ant.placeOrder({
                exchange, instrumentId, tradingSymbol, quantity, transactionType: 'BUY',
                marketProtectionPercent: marketEntry.marketProtectionPercent,
                product: marketEntry.product,
            }));
        } catch (e: any) {
            // Fall back ONLY on the known broker rejection of MARKET orders. Any other error (timeout, network)
            // may mean the order was actually accepted, so re-placing could double-buy: rethrow those.
            const detail = `${e?.message ?? ''} ${JSON.stringify(e?.response?.data ?? '')}`;
            if (!/EC965|Market orders are not allowed/i.test(detail)) throw e;
            Log.log(`[order] ALERT: ANT rejected MARKET+protection for ${tradingSymbol} (${detail.slice(0, 200)}) - falling back to marketable LIMIT via ScripDetails quote`);
            const ltp = await ant.getScripQuote(exchange, instrumentId);
            if (!(ltp > 0)) throw new Error(`ANT fallback quote unusable for ${tradingSymbol} - order not placed`);
            const limitPrice = roundToTick(ltp * 1.01);
            ({ orderNo } = await ant.placeOrder({ exchange, instrumentId, tradingSymbol, quantity, transactionType: 'BUY', price: limitPrice, product: marketEntry.product }));
        }
    } else {
        // Confirmed live 2026-10-12: AliceBlue now rejects MARKET orders on
        // this plain (non-bracket) regular-order path too, with the same
        // "EC965 Market orders are not allowed" the bracket branch above
        // already worked around - not just a bracket-specific restriction.
        // Same fix: a marketable LIMIT 1% above LTP, fills immediately like
        // a market order would from the caller's point of view.
        const ltp = await entryLtp(knownLtp, exchange, instrumentId);
        // BFO (SENSEX) buys are limited at LTP itself, not LTP+1% (user decision 2026-10-19); NFO keeps the 1% cushion.
        const limitPrice = exchange === 'BFO' ? roundToTick(ltp) : roundToTick(ltp * 1.01);
        Log.log(`[order] Buying ${tradingSymbol} qty=${quantity} for ${userId} via ANT regular order (ltp=${ltp} limit=${limitPrice})`);
        ({ orderNo } = await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol,
            quantity,
            transactionType: 'BUY',
            price: limitPrice,
        }));
    }

    // Push-based, not polled - resolves as soon as the order-notify websocket
    // delivers a COMPLETE status for this order (see AntOrderNotifyStream.ts).
    //
    // BUG FIX (orphaned broker position on fill-notify failure): the
    // order-notify WS push can be missed even though the order actually
    // filled at the broker (see AntOrderNotifyStream.ts:40-46's documented,
    // unverified norenordno-vs-brokerOrderId assumption - if wrong,
    // waitForFill NEVER sees a match and always times out). Previously, any
    // waitForFill failure aborted this function before the trade was ever
    // recorded in bookkeeping or protected with target/SL, silently
    // orphaning a real, live, filled broker position (uncounted against
    // limits, unprotected, invisible on /positionstream). So on ANY
    // waitForFill failure (timeout, REJECTED, CANCELLED), fall back to a
    // direct REST check - ANT.getFillPrice, a confirmed-live poll of
    // AliceBlue's orders/history endpoint keyed by this exact orderNo (see
    // ANT.ts) - before giving up. Only if the REST fallback ALSO fails to
    // find a COMPLETE fill do we treat the order as genuinely not filled and
    // let the error propagate, exactly as before.
    let entryPrice: number;
    let filledQuantity = quantity;
    try {
        entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        try {
            entryPrice = await ant.getFillPrice(orderNo);
            Log.log(`[order] REST fallback confirmed fill for ${tradingSymbol} at ${entryPrice} for ${userId} (order-notify push was missed)`);
        } catch (fallbackErr: any) {
            // The history poll could not confirm a fill, so the order may still be resting
            // at the broker. Resolve the real outcome before recording anything.
            const parentIsBrokerBracketOrCover = useCover || useBracket;
            const resolved = await resolveUnconfirmedAntBuy(ant, orderNo, quantity, !parentIsBrokerBracketOrCover, fallbackErr);
            entryPrice = resolved.avgPrice;
            filledQuantity = resolved.quantity;
            Log.log(`[order] unconfirmed ANT buy ${orderNo} resolved: ${filledQuantity}/${quantity} filled @ ${entryPrice} for ${userId}`);
        }
    }

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = filledQuantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'ant';
    trade.brokerOrderId = orderNo;
    if (marketEntry?.product) trade.product = marketEntry.product;

    if (useCover || (targetPoints > 0 && stopLossPoints > 0)) {
        // Tick-rounded for consistency with the Kite path and with
        // whatever exitMonitor/frontend display expects - AliceBlue itself
        // computes the actual bracket/cover trigger prices server-side from
        // targetLegPrice/slLegPrice point offsets (see placeBracketOrder/
        // placeCoverOrder), not from an absolute price we send, so there's no
        // equivalent broker-rejection risk here today; this is purely
        // local-field hygiene.
        trade.stopLossPrice = roundToTick(entryPrice - stopLossPoints);
        if (!useCover) {
            // Cover orders carry no target leg - nothing to record.
            trade.targetPoints = targetPoints;
            trade.targetPrice = roundToTick(entryPrice + targetPoints);
        }

        if (useBracket || useCover) {
            // The broker (not this process) watches price after this - kept
            // on the trade so squareOffOnAnt knows to exit via exitBracketOrder.
            trade.antOrderNo = orderNo;
            // Nothing else keeps trade.lastTradePrice fresh after entry - register
            // watch-only so the frontend's live P&L still moves with the market
            // instead of freezing at the fill price (the bracket/cover order
            // itself still owns the actual exit).
            if (trade.token) exitMonitor.registerTrade(trade, exchange, 'ant', true);
        } else if (trade.token) {
            exitMonitor.registerTrade(trade, exchange, 'ant');
        } else {
            Log.log(`[order] useGTT=false for ${userId} but trade has no token (${trade.tsym}) - exit will not be monitored`);
        }
    } else if (orderMode === 'target-only' && (targetPoints > 0 || marketEntry)) {
        // Explicit opt-in only - gated on orderMode, not just "targetPoints>0
        // && stopLossPoints<=0", so this doesn't silently change behavior for
        // any OTHER existing/future caller of enterPosition that happens to
        // pass that same point combination without meaning it (e.g. a
        // per-user stopLossPriceDiff=0 config through the generic
        // AntExecutor.buy path) - only a caller that explicitly asks for
        // 'target-only' gets this.
        //
        // The caller (e.g. TopStockOptionsOpeningGapStrategy) places its OWN
        // separate resting exit order right after this call returns - that
        // resting order is the sole actual exit, so record targetPoints/
        // targetPrice (restore-time ground truth per restoreOpenTradesForTsym's
        // documented invariant) BEFORE recordFill below, and register
        // watch-only only: an active (non-watch-only) registration would let
        // exitMonitor's own hitTarget trigger fire a SECOND, competing
        // square-off once ltp crosses targetPrice, racing the caller's
        // already-resting order.
        //
        // marketEntry callers pass no pre-trade targetPoints (no pre-trade option
        // LTP is fetched any more) - the target is instead sized here from the
        // real fill price: 0.25 delta x 1% of the underlying's open, capped at 100%
        // of the premium actually paid.
        //
        // entryPrice<=0 guard: resolveUnconfirmedAntBuy's trade-book fallback (above)
        // is documented elsewhere as an unverified best-guess shape - if it ever
        // returns avgPrice=0 for a nonzero filledQuantity, computing a target from it
        // would set targetPrice=0 and leave the caller (e.g.
        // TopStockOptionsOpeningGapStrategy.enterLeg) to place a live resting SELL at
        // price 0. Skip setting a target entirely in that case (same "no target"
        // outcome the old targetPoints<=0 path already produced) and ALERT instead -
        // the caller must check trade.targetPrice before placing its own resting sell.
        if (marketEntry && !(entryPrice > 0)) {
            Log.log(`[order] ALERT: ${tradingSymbol} resolved entryPrice=${entryPrice} for ${userId} - buy filled but price is unusable; skipping target so no sell is placed at a bad price. Position is LIVE and UNPROTECTED - manual review required.`);
        } else {
            const effectiveTargetPoints = marketEntry
                ? Math.min(0.0025 * marketEntry.underlyingOpen, entryPrice)
                : targetPoints;
            trade.targetPoints = effectiveTargetPoints;
            trade.targetPrice = roundToTick(entryPrice + effectiveTargetPoints);
            if (trade.token) exitMonitor.registerTrade(trade, exchange, 'ant', true);
        }
    }

    await bookkeeping.recordFill(trade);
    return trade;
}

// ButterflyStrategy's narrow sell-to-open exception ONLY. `enterPosition` above hardcodes
// `transactionType: 'BUY'` throughout every one of its branches - this is a deliberately
// separate, minimal function rather than adding a direction param there, so every other ANT
// caller of enterPosition stays byte-for-byte unmodified. Reuses the exact same fill-
// confirmation discipline enterPosition's plain (non-bracket/cover) branch already uses
// (push-based waitForFill, REST getFillPrice fallback on a missed push) - that fallback
// exists because of a documented live incident with missed fill notifications; skipping it
// here would risk the exact same orphaned-position class of bug for a short leg.
export async function enterShortPosition(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
    const ant = ANT.getInstance();
    const ltp = await entryLtp(undefined, exchange, instrumentId);
    // BFO (SENSEX) priced at LTP itself, NFO at a marketable 1% cushion BELOW LTP (the sell-side
    // mirror of enterPosition's own BFO/NFO buy-side convention a few lines up in this file).
    const limitPrice = exchange === 'BFO' ? roundToTick(ltp) : roundToTick(ltp * 0.99);
    Log.log(`[order] [BUTTERFLY] Short-entry (sell-to-open) ${tradingSymbol} qty=${quantity} for ${userId} via ANT regular order (ltp=${ltp} limit=${limitPrice})`);
    const { orderNo } = await ant.placeOrder({
        exchange,
        instrumentId,
        tradingSymbol,
        quantity,
        transactionType: 'SELL',
        price: limitPrice,
    });

    let entryPrice: number;
    try {
        entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] [BUTTERFLY] Short-entry filled ${tradingSymbol} at ${entryPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] [BUTTERFLY] waitForFill failed for short-entry ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        entryPrice = await ant.getFillPrice(orderNo);
        Log.log(`[order] [BUTTERFLY] REST fallback confirmed short-entry fill for ${tradingSymbol} at ${entryPrice} for ${userId} (order-notify push was missed)`);
    }

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'SellToOpen';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'ant';
    trade.brokerOrderId = orderNo;

    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Closes a short opened by enterShortPosition - a plain marketable LIMIT BUY (closing a short
// via a BUY has no broker-side guard to begin with). Mirrors enterShortPosition's own
// fill-confirmation discipline exactly. Records via recordShortFill with action='BuyToClose'.
export async function buyToClosePosition(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
    const ant = ANT.getInstance();
    const ltp = await entryLtp(undefined, exchange, instrumentId);
    const limitPrice = exchange === 'BFO' ? roundToTick(ltp) : roundToTick(ltp * 1.01);
    Log.log(`[order] [BUTTERFLY] Buy-to-close ${tradingSymbol} qty=${quantity} for ${userId} via ANT regular order (ltp=${ltp} limit=${limitPrice})`);
    const { orderNo } = await ant.placeOrder({
        exchange,
        instrumentId,
        tradingSymbol,
        quantity,
        transactionType: 'BUY',
        price: limitPrice,
    });

    let exitPrice: number;
    try {
        exitPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] [BUTTERFLY] Buy-to-close filled ${tradingSymbol} at ${exitPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] [BUTTERFLY] waitForFill failed for buy-to-close ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        exitPrice = await ant.getFillPrice(orderNo);
        Log.log(`[order] [BUTTERFLY] REST fallback confirmed buy-to-close fill for ${tradingSymbol} at ${exitPrice} for ${userId} (order-notify push was missed)`);
    }

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = quantity;
    trade.price = exitPrice;
    trade.lastTradePrice = exitPrice;
    trade.action = 'BuyToClose';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'ant';
    trade.brokerOrderId = orderNo;

    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Read-only live net quantity for a (tradingSymbol, exchange) pair, for ButterflyStrategy's
// reconcile() to cross-check a persisted leg against the real broker position. Field names
// (netQty/tradingSymbol) are the same best-guess shape bookkeeping.reconcileAntPositions
// already uses (its own comment flags them as unverified against a live response).
export async function getLiveNetQuantity(tradingSymbol: string): Promise<number> {
    const positions = await ANT.getInstance().getPositions();
    const list = Array.isArray(positions) ? positions : [];
    const pos = list.find((p: any) => (p.tradingSymbol ?? p.tsym ?? p.symbol) === tradingSymbol);
    return Number(pos?.netQty ?? pos?.netqty ?? 0);
}

export interface BuyIndexRequest {
    userId: string;
    index?: 'NIFTY' | 'SENSEX';
    niftyLtp: number;
    right: string; // CALL | PUT
    quantity: number;
    targetPoints?: number;
    stopLossPoints?: number;
    strike?: number;
    expiry?: string;
}

export async function buyIndexOnAnt(req: BuyIndexRequest): Promise<Trade> {
    const settings = configService.getConfig().settings;
    const targetPoints = req.targetPoints ?? bookkeeping.getUserTargetPoints(req.userId) ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? bookkeeping.getUserStopLossPoints(req.userId) ?? settings.stopLossPriceDiff;
    const optionType = req.right === CALL ? 'CE' : 'PE';
    const index = req.index ?? 'NIFTY';

    const contract = req.strike && req.expiry
        ? AntContractMaster.getInstance().findExactOption({ symbol: index, strike: req.strike, expiry: req.expiry, optionType })
        : AntContractMaster.getInstance().findATMOption(req.niftyLtp, optionType, index);

    return enterPosition(
        req.userId,
        contract.tradingSymbol,
        contract.token,
        req.quantity,
        contract.exch as 'NFO' | 'BFO',
        targetPoints,
        stopLossPoints
    );
}

// Mirrors manualBuyOnKite's three branches: canonical `contract` string,
// else `strikePrice` (ATM-by-strike), else index-ATM fallback.
export interface ManualBuyRequest {
    userId: string;
    index?: 'NIFTY' | 'SENSEX';
    right?: string;
    contract?: string;
    strikePrice?: number;
    quantity?: number;
    targetPoints?: number;
    stopLossPoints?: number;
}

// Quote retry schedules (ms between attempts after the first). Only HTTP 429 is retried, by
// ANT.postOhlc - the single retry loop; the callers below only choose the schedule. Other errors
// return immediately. A zero or unusable LTP is never returned as a price (getQuote throws).
// Entry sizing uses the full schedule; exits use one short retry so a stop-loss isn't stuck behind it.
const SAFE_QUOTE_BACKOFF_MS = [3000, 6000, 10000];
// estimateOptionPrice's sizing path (quantity=-1, "size from maxInvestment") gets a longer
// budget than ordinary entry sizing: live incident 2026-10-15 - a transient AliceBlue OHLC
// 429 outlasted the standard 3-attempt/~19s schedule, exhausting it with price still 0 and
// failing a BulkPcrAutoStartStrategy slot that would have gone through fine a few seconds
// later. Not time-critical the way an order placement is, so the extra wait is cheap insurance.
// Tradeoff noted on review: this ~43s max sits inside orderProcess.ts's ORDER_IPC_TIMEOUT_MS
// (default 90s), leaving less margin for the chunked buy that follows to also complete within
// that same window during a bad OHLC-degradation day. Left as is deliberately - the schedule
// exists specifically to survive a degradation that outlasts the old ~19s budget, and a chunked
// buy normally completes in a few seconds (confirmed live), so this is headroom traded for
// resilience, not a correctness bug.
const SIZING_ESTIMATE_BACKOFF_MS = [3000, 5000, 8000, 12000, 15000];
// Exit path: one quick retry only. A stop-loss must not sit behind the entry-grade backoff.
const EXIT_QUOTE_RETRY_MS = [1500];
// Exit fallback floor when no live quote exists: 3% below the trigger tick's LTP (a live quote gets 1%).
const EXIT_FALLBACK_FLOOR_FACTOR = 0.97;

// Returns 0 (never throws) when no usable quote could be had. Sizing and exits use this.
async function safeAntQuote(exch: string, token: string, retryDelaysMs: number[] = SAFE_QUOTE_BACKOFF_MS, skipCache = false): Promise<number> {
    try {
        // Live ScripDetails LTP first: the cached OHLC quote below ran far behind on a fast expiry-day option
        // (live 2026-10-22: sized and priced a buy off 109-128 while the contract traded ~197, so the limit
        // never filled and the paired Kite leg was oversized). getLiveQuote refuses a non-positive LTP.
        try {
            return (await ANT.getInstance().getLiveQuote(exch, token)).ltp;
        } catch (liveErr: any) {
            Log.log(`[order] ANT live quote unavailable for ${token} (${liveErr?.message ?? liveErr}) - falling back to OHLC quote`);
        }
        // getQuote refuses a non-positive LTP, so anything it returns is usable.
        return await ANT.getInstance().getQuote(exch, token, { retryDelaysMs, skipCache });
    } catch (e: any) {
        // Status and message only - the raw axios error carries the request headers, including the session token.
        Log.log(`[order] ANT quote unavailable for ${token}: ${e?.response?.status ?? ''} ${e?.message ?? e} (returning 0 - no price)`);
        return 0;
    }
}

// For order-placing paths: a limit price derived from a missing or zero quote would send an
// order at price 0 (a free buy, or a sell at 0), so refuse before anything reaches the broker.
async function requireAntLtp(exch: string, token: string, retryDelaysMs: number[] = SAFE_QUOTE_BACKOFF_MS): Promise<number> {
    const ltp = await safeAntQuote(exch, token, retryDelaysMs);
    if (!(ltp > 0)) throw new Error(`ANT quote unavailable for ${token} - order not placed`);
    return ltp;
}

// Live price estimate for investment-amount-based manual-buy sizing,
// resolved via ANT regardless of execution broker - Kite's own
// quote/LTP endpoints return 403 for this account's Kite Connect
// subscription (see Kite.placeLimitBuyOption's comment), so ANT (already
// the app's sole live tick source) is the pricing reference for both executors.
export async function estimateOptionPrice(symbol: string, strike: number, optionType: string): Promise<number> {
    try {
        const exch = symbol === 'SENSEX' ? 'BFO' : 'NFO';
        const resolved = AntContractMaster.getInstance().findNearestExpiryOption({ symbol, exch, strike, optionType });
        return await safeAntQuote(resolved.exch as 'NFO' | 'BFO', resolved.token, SIZING_ESTIMATE_BACKOFF_MS);
    } catch (e) {
        Log.log('[order] Contract resolution for price estimate failed (falling back to 1-lot sizing):', e);
        return 0;
    }
}

// Read-only ATM CE/PE token lookup for MomentumSignal.ts - the tbq/tsq
// momentum check needs both ATM contracts' ANT tokens to depth-subscribe,
// same findATMOption resolution buyIndexOnAnt already uses for real entries.
// Always ANT (AntContractMaster) regardless of which broker a strategy's own
// order execution is configured to route through - ANT is the platform's
// sole tick source, and depth mode (tbq/tsq) is ANT-only.
export interface AtmTokens {
    ce: { token: string; tradingSymbol: string };
    pe: { token: string; tradingSymbol: string };
}

export function getATMTokens(niftyLtp: number, index: string = 'NIFTY'): AtmTokens {
    const ce = AntContractMaster.getInstance().findATMOption(niftyLtp, 'CE', index);
    const pe = AntContractMaster.getInstance().findATMOption(niftyLtp, 'PE', index);
    return {
        ce: { token: ce.token, tradingSymbol: ce.tradingSymbol },
        pe: { token: pe.token, tradingSymbol: pe.tradingSymbol },
    };
}

// Batched sibling of estimateOptionPrice - sources every candidate's token
// and live premium from a single option-chain fetch (ANT.getOptionChain),
// instead of one estimateOptionPrice (and thus one HTTP request) per
// candidate. Needed by any caller that checks several strikes' premiums in a
// single decision (e.g. a strike-range walk).
//
// Uses the option chain rather than the OHLC endpoint (ANT.getQuotes)
// deliberately: the OHLC endpoint rate-limits (429) after just 1-2 rapid
// calls (see ANT.ts), and this is the highest-frequency live consumer of
// whichever endpoint it uses (ContinuousStrategy's T1/spawn/root-refill
// contract selection) - the option chain endpoint is on a separate,
// confirmed-not-rate-limited bucket, and already returns token+tradingsymbol+
// ltp per strike, so no separate local contract-master resolution step is
// needed either. Missing candidates (outside the chain's returned strike
// window) are simply absent from the returned map (same effect as
// estimateOptionPrice's 0-on-failure, without polluting the map with a
// misleading zero premium).
//
// Surfaces the ANT token per candidate (not just its premium) - Kite and
// ANT number the same contract completely differently (confirmed live: the
// same NIFTY 24300 PE is Kite instrumentToken 15795970 but ANT token
// 61703), and it's the ANT token that live option ticks are keyed by
// (OptionQuote.fromAnt sets quote.token = response.tk). A caller that resolves
// a contract here for a leg it will self-monitor via live ANT ticks (e.g.
// ContinuousStrategy) needs this ANT token, not Kite's, wired into
// whatever it later registers for tick subscription/matching - passing
// Kite's token there means the subscription and every incoming tick land
// in a token space the leg's own map can never match.
export async function estimateOptionPricesBatch(
    symbol: string,
    candidates: { strike: number; optionType: string }[]
): Promise<Map<string, { premium: number; antToken: string }>> {
    const byKey = new Map<string, { premium: number; antToken: string }>();
    try {
        const chain = await ANT.getInstance().getOptionChain(symbol);
        const byStrike = new Map(chain.map((row) => [row.strike, row]));
        for (const c of candidates) {
            const row = byStrike.get(c.strike);
            if (!row) continue;
            const side = c.optionType === 'CE' ? row.ce : row.pe;
            byKey.set(`${c.strike}_${c.optionType}`, { premium: side.ltp, antToken: side.token });
        }
    } catch (e) {
        Log.log(`[order] Option chain fetch for batch price estimate failed: ${e?.response?.status ?? ''} ${e?.message ?? e}`);
    }
    return byKey;
}

export async function manualBuyOnAnt(req: ManualBuyRequest): Promise<Trade> {
    const settings = configService.getConfig().settings;
    const targetPoints = req.targetPoints ?? bookkeeping.getUserTargetPoints(req.userId) ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? bookkeeping.getUserStopLossPoints(req.userId) ?? settings.stopLossPriceDiff;

    if (req.contract) {
        const canonical = parseCanonicalSymbol(req.contract);
        const resolved = AntContractMaster.getInstance().findNearestExpiryOption({
            symbol: canonical.symbol,
            exch: canonical.symbol === 'SENSEX' ? 'BFO' : 'NFO',
            strike: canonical.strike,
            optionType: canonical.optionType,
        });
        return enterManualBuy(req, resolved.tradingSymbol, resolved.token, resolved.exch as 'NFO' | 'BFO', targetPoints, stopLossPoints);
    }

    if (!req.right) throw new Error('manualBuy requires either contract or right');

    const index = req.index ?? 'NIFTY';

    if (req.strikePrice) {
        const optionType = req.right === CALL ? 'CE' : 'PE';
        const contract = AntContractMaster.getInstance().findATMOption(req.strikePrice, optionType, index);
        return enterManualBuy(req, contract.tradingSymbol, contract.token, contract.exch as 'NFO' | 'BFO', targetPoints, stopLossPoints);
    }

    const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(index);

    return buyIndexOnAnt({ userId: req.userId, index: req.index, niftyLtp: 0, right: req.right, quantity, targetPoints, stopLossPoints });
}

// AliceBlue's BO modify endpoint field shape for re-pricing a live bracket's
// legs hasn't been confirmed against a live response, so this only updates
// local bookkeeping for now - the broker-side BO leg prices are NOT
// re-priced. Once the modify shape is verified, add the live call here
// (mirroring kiteExecutor.setTargetStopLoss's modifyTargetStopLossGTT call).
export async function setTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
    const trade = bookkeeping.trades.find((t) => t.token === token && t.user === userId);
    if (!trade) throw new Error(`No open trade for token ${token} and user ${userId}`);

    // 0 / missing / non-numeric means "leave that side unset" (the UI may set only one side). Without this a 0 became
    // price -/+ 0 = the entry price, i.e. an exit at the first tick.
    const hasTarget = Number.isFinite(targetPoints) && targetPoints > 0;
    const hasStop = Number.isFinite(stopLossPoints) && stopLossPoints > 0;
    if (!hasTarget && !hasStop) throw new Error('setTargetStopLoss: targetPoints and/or stopLossPoints must be a positive number');
    if (hasTarget) {
        trade.targetPrice = trade.price + targetPoints;
        trade.targetPoints = targetPoints;
    }
    if (hasStop) trade.stopLossPrice = trade.price - stopLossPoints;

    if (trade.antOrderNo) {
        Log.log(`[order] setTargetStopLoss updated local bookkeeping for ANT order ${trade.antOrderNo} - live BO leg re-price not yet implemented (unverified endpoint shape)`);
    }
    bookkeeping.notifyTargetStopLossChanged();
}

// Returns immediately with {orderId} - fill arrives later via
// pollPendingAntLimitOrders. Places a plain REGULAR LIMIT sell (ant.placeOrder,
// 'Confirmed live' per its own comment) at a caller-chosen price, unlike
// squareOffOnAnt below which either exits a bracket order's own legs or
// places a regular order with no price floor. Used for a target-hit exit
// that must lock in a specific price - see placeLimitSellBareOnKite's
// comment for why (2026-09-22 incident).
export async function placeLimitSellBareOnAnt(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO', product?: 'INTRADAY' | 'LONGTERM'): Promise<{ orderId: string }> {
    const ant = ANT.getInstance();
    Log.log(`[order] Bare ANT limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderNo } = await ant.placeOrder({
        exchange,
        instrumentId,
        tradingSymbol,
        quantity,
        transactionType: 'SELL',
        price,
        product,
    });
    trackPendingAntLimitOrder({ orderId: orderNo, userId, tradingSymbol, instrumentId, quantity, exchange, action: 'Sell', product });
    return { orderId: orderNo };
}

// Cancels a resting ANT limit order (e.g. cancelAnyRestingLimitSell ahead of
// a force-close) and untracks it - mirrors kiteExecutor.cancelOrderOnKite.
// Without the untrack, the next pollPendingAntLimitOrders tick would
// independently discover the same order CANCELLED and fire the
// cancelled-listener chain, re-placing a brand new resting sell for the
// quantity the caller just cancelled specifically to avoid double-selling
// ahead of its own force-close. See cancelOrderWithFillRecheck's own comment
// (BrokerExecutor.ts) for why untracking isn't unconditional.
export async function cancelOrderOnAnt(orderId: string): Promise<void> {
    const ant = ANT.getInstance();
    await cancelOrderWithFillRecheck({
        orderId,
        label: 'cancelOrderOnAnt',
        cancel: () => ant.cancelOrder(orderId),
        isFilled: async () => {
            const result = await ant.getOrderStatus(orderId);
            return { filledQuantity: result.filledQuantity ?? 0, terminal: result.status !== 'PENDING' };
        },
        untrack: () => untrackPendingAntLimitOrder(orderId),
    });
}

// Terminal order states: nothing further can fill. The one predicate for every exit and entry path.
function isTerminalOrderStatus(status: string): boolean {
    return status === 'COMPLETE' || status === 'CANCELLED' || status === 'REJECTED';
}

// Books a sell order's fills from the broker's trade book. Shared by every path that closes out a sell.
async function bookSellFills(orderId: string, userId: string, tsym: string): Promise<number> {
    const book = await ANT.getInstance().getFilledFromTradeBook(orderId);
    if (book.quantity > 0) {
        const sold = new Trade();
        sold.tsym = tsym;
        sold.quantity = book.quantity;
        sold.price = book.avgPrice;
        sold.lastTradePrice = book.avgPrice;
        sold.action = 'Sell';
        sold.status = 'COMPLETE';
        sold.user = userId;
        sold.broker = 'ant';
        sold.brokerOrderId = orderId;
        await bookkeeping.recordFill(sold);
    }
    return book.quantity;
}

// Cancels a resting sell so a stop-loss can exit the position, then books what that sell had already filled.
// Returns the filled quantity. Throws (for manual review) if the broker can't confirm the order is terminal -
// the position could then still be sold twice - or if the trade book disagrees with the order status.
async function cancelRestingSellForExit(orderId: string, userId: string, tsym: string, prev?: PendingAntLimitOrder): Promise<number> {
    const ant = ANT.getInstance();
    const isTerminal = isTerminalOrderStatus;
    // Off the poller's book first: once the cancel goes through, a poller still tracking the order would fire
    // the cancelled listeners and re-place a sell. Re-tracked below only if the cancel isn't confirmed.
    untrackPendingAntLimitOrder(orderId);
    let st: { status: string; filledQuantity?: number };
    try {
        try {
            await ant.cancelOrder(orderId);
        } catch (e: any) {
            // Often means the sell filled first; the status check below decides.
            Log.log(`[order] cancel of resting sell ${orderId} for ${tsym} returned: ${e?.message ?? e}`);
        }
        st = await ant.getOrderStatus(orderId);
        for (let i = 0; i < 10 && !isTerminal(st.status); i++) {
            await sleep(1000);
            st = await ant.getOrderStatus(orderId);
        }
    } catch (e) {
        if (prev) trackPendingAntLimitOrder(prev);
        throw e;
    }
    if (!isTerminal(st.status)) {
        if (prev) trackPendingAntLimitOrder(prev);
        throw new Error(`Stop-loss for ${tsym}: resting sell ${orderId} not confirmed cancelled (status ${st.status}) - manual review required`);
    }
    let sold: number;
    try {
        sold = await bookSellFills(orderId, userId, tsym);
    } catch (e: any) {
        Log.log(`[order] ALERT: resting sell ${orderId} for ${tsym} (${userId}) is cancelled but its fills could not be read: ${e?.message ?? e} - check the broker`);
        throw e;
    }
    if ((st.filledQuantity ?? 0) > sold) {
        Log.log(`[order] ALERT: resting sell ${orderId} for ${tsym} (${userId}) shows ${st.filledQuantity} filled but the trade book has ${sold} - manual review required`);
        throw new Error(`Resting sell ${orderId} for ${tsym}: broker status ${st.filledQuantity} filled, trade book ${sold} - not exiting until reconciled`);
    }
    Log.log(`[order] resting sell ${orderId} for ${tsym} (${userId}) ${st.status}: ${sold} already sold`);
    return sold;
}

// Open quantity still held for this position, per bookkeeping. Booked fills (including a cancelled
// sell's partial) have already reduced it, so it is the source of truth for what's left to exit.
function openQuantity(userId: string, tsym: string): number {
    return bookkeeping.getOpenTrades(userId).filter((t) => t.tsym === tsym).reduce((sum, t) => sum + t.quantity, 0);
}

// An exit sell that wasn't confirmed filled is re-checked after a minute (immediately when the caller
// already waited). A COMPLETE fill is booked; a still-open or dead sell is cancelled and what's left is
// re-placed at live LTP, then checked again, up to a limit.
const EXIT_RECHECK_MS = 60000;
const EXIT_MAX_REPRICES = 10;
// A separate cap for consecutive unreadable-status checks, so a run of read failures (network
// blips, nothing to do with the sell itself) can't silently eat into the re-price budget above
// and trigger its "not filled after N re-prices" alert without a single re-price ever happening.
const EXIT_MAX_UNREADABLE_STATUS = 10;
// Found on review: before unreadableStatusCount was split out as its own counter, a persistent
// cancel-failure loop (which never advanced `attempt` either, before or after that split) could
// incidentally still trip EXIT_MAX_REPRICES if unreadable-status rounds happened to be mixed in,
// since those used to share the same counter. Splitting the counters removed that accidental
// escape hatch, leaving a genuinely stuck "cancel never succeeds" loop with no cap of its own at
// all - a resting, unprotected position could re-check forever with no alert ever firing. Giving
// cancel failures their own explicit bounded cap closes this rather than relying on an
// unreadable-status coincidence.
const EXIT_MAX_CANCEL_FAILURES = 10;

// Found on review: three independent, same-typed counters (attempt/unreadableStatusCount/
// cancelFailureCount) threaded as bare positional numbers risked a silent transposition if a
// future edit added a fourth or reordered a call - no compiler error would catch passing one
// count where another is expected. Bundled into one named-fields object instead.
interface ExitRecheckCounters {
    attempt: number;
    unreadableStatusCount: number;
    cancelFailureCount: number;
}
const INITIAL_EXIT_RECHECK_COUNTERS: ExitRecheckCounters = { attempt: 0, unreadableStatusCount: 0, cancelFailureCount: 0 };

function scheduleExitRecheck(order: PendingAntLimitOrder, counters: ExitRecheckCounters, lastLimit: number, delayMs = EXIT_RECHECK_MS): void {
    setTimeout(() => {
        void recheckUnfilledExit(order, counters, lastLimit);
    }, delayMs);
}

async function recheckUnfilledExit(order: PendingAntLimitOrder, counters: ExitRecheckCounters, lastLimit: number): Promise<void> {
    const { attempt, unreadableStatusCount, cancelFailureCount } = counters;
    const key = `${order.userId}:${order.tradingSymbol}`;
    // One exit operation per position at a time: a square-off or another re-price in flight would race this one.
    if (bookkeeping.pendingSquareOffs.has(key)) {
        scheduleExitRecheck(order, counters, lastLimit, 5000);
        return;
    }
    bookkeeping.pendingSquareOffs.add(key);
    try {
        if (!isPendingAntOrder(order.orderId)) {
            Log.log(`[order] re-price: ${order.orderId} (${order.tradingSymbol}, ${order.userId}) is no longer tracked - leaving it to the poller and listeners`);
            return;
        }
        if (attempt >= EXIT_MAX_REPRICES) {
            // Leave the last sell resting; it is still live protection.
            Log.log(`[order] ALERT: exit ${order.orderId} for ${order.tradingSymbol} (${order.userId}) not filled after ${attempt} re-prices - still resting, manual action required`);
            return;
        }
        let st = await ANT.getInstance().getOrderStatus(order.orderId).catch(() => null);
        for (let i = 0; !st && i < 2; i++) {
            await sleep(2000);
            st = await ANT.getInstance().getOrderStatus(order.orderId).catch(() => null);
        }
        if (!st) {
            const nextUnreadableCount = unreadableStatusCount + 1;
            if (nextUnreadableCount >= EXIT_MAX_UNREADABLE_STATUS) {
                Log.log(`[order] ALERT: exit ${order.orderId} for ${order.tradingSymbol} (${order.userId}) status unreadable ${nextUnreadableCount} times in a row - still resting, manual action required`);
                return;
            }
            Log.log(`[order] re-price: status of ${order.orderId} unreadable, checking again in 60s`);
            scheduleExitRecheck(order, { attempt, unreadableStatusCount: nextUnreadableCount, cancelFailureCount }, lastLimit);
            return;
        }
        if (st.status === 'COMPLETE') {
            const booked = await bookSellFills(order.orderId, order.userId, order.tradingSymbol);
            if (!(booked > 0)) throw new Error(`exit ${order.orderId} COMPLETE but the trade book shows no fill - manual review`);
            untrackPendingAntLimitOrder(order.orderId);
            return;
        }
        try {
            await cancelRestingSellForExit(order.orderId, order.userId, order.tradingSymbol, order);
        } catch (cancelErr: any) {
            const nextCancelFailureCount = cancelFailureCount + 1;
            if (nextCancelFailureCount >= EXIT_MAX_CANCEL_FAILURES) {
                Log.log(`[order] ALERT: exit ${order.orderId} for ${order.tradingSymbol} (${order.userId}) cancel failed ${nextCancelFailureCount} times in a row - still resting, manual action required: ${cancelErr?.message ?? cancelErr}`);
                return;
            }
            // The sell is re-tracked when its cancel isn't confirmed, so the next check picks it up again.
            Log.log(`[order] re-price: cancel of ${order.orderId} for ${order.tradingSymbol} not confirmed, checking again in 60s: ${cancelErr?.message ?? cancelErr}`);
            // `st` was read successfully just above (that's how we got here at all), so the
            // unreadable-status streak is over - reset to 0 rather than carrying the stale count
            // forward. Otherwise a handful of old, long-resolved read failures could combine with
            // a later, unrelated one to trip the alert despite no actual streak.
            scheduleExitRecheck(order, { attempt, unreadableStatusCount: 0, cancelFailureCount: nextCancelFailureCount }, lastLimit);
            return;
        }
        const remaining = openQuantity(order.userId, order.tradingSymbol);
        if (remaining <= 0) {
            Log.log(`[order] re-price: ${order.tradingSymbol} (${order.userId}) fully sold by the resting sell - nothing to re-place`);
            return;
        }
        try {
            await placeReplacementExit(order, remaining, lastLimit, attempt);
        } catch (placeErr: any) {
            // The resting sell is already cancelled, so a failed replacement leaves the position with NO exit. Retry
            // when the failure proves no order exists at the broker; an ambiguous one (e.g. timeout) is not retried.
            if (placeErr?.orderNotPlaced) {
                Log.log(`[order] re-price: replacement exit for ${order.tradingSymbol} (${order.userId}) not placed (${placeErr?.message ?? placeErr}) - retrying`);
                scheduleReplacementRetry(order, lastLimit, attempt, 1);
                return;
            }
            throw placeErr;
        }
    } catch (e: any) {
        Log.log(`[order] ALERT: re-price of exit for ${order.tradingSymbol} (${order.userId}) failed - position may be unprotected: ${e?.message ?? e}`);
    } finally {
        bookkeeping.pendingSquareOffs.delete(key);
    }
}

const EXIT_MAX_REPLACEMENT_FAILURES = 5;

// Retries a replacement exit whose placement definitely did not reach the broker. Same one-exit-per-position
// gate as the re-price check; re-reads the open quantity and defers to any sell that has appeared meanwhile.
function scheduleReplacementRetry(order: PendingAntLimitOrder, lastLimit: number, attempt: number, failures: number, busy = 0): void {
    setTimeout(() => {
        void retryReplacementExit(order, lastLimit, attempt, failures, busy);
    }, 15000);
}

async function retryReplacementExit(order: PendingAntLimitOrder, lastLimit: number, attempt: number, failures: number, busy = 0): Promise<void> {
    const key = `${order.userId}:${order.tradingSymbol}`;
    if (bookkeeping.pendingSquareOffs.has(key)) {
        // Bounded: another exit operation owns the position; stop waiting after ~10 minutes.
        if (busy < 40) scheduleReplacementRetry(order, lastLimit, attempt, failures, busy + 1);
        else Log.log(`[order] ALERT: replacement exit for ${order.tradingSymbol} (${order.userId}) gave up waiting for another exit operation - check the position`);
        return;
    }
    bookkeeping.pendingSquareOffs.add(key);
    try {
        const remaining = openQuantity(order.userId, order.tradingSymbol);
        if (remaining <= 0) return;
        if (pendingAntSellsFor(order.userId, order.tradingSymbol).length > 0) {
            Log.log(`[order] re-price retry: ${order.tradingSymbol} (${order.userId}) already has a resting sell - not placing another`);
            return;
        }
        await placeReplacementExit(order, remaining, lastLimit, attempt);
    } catch (e: any) {
        if (e?.orderNotPlaced && failures + 1 < EXIT_MAX_REPLACEMENT_FAILURES) {
            scheduleReplacementRetry(order, lastLimit, attempt, failures + 1);
            return;
        }
        Log.log(`[order] ALERT: replacement exit for ${order.tradingSymbol} (${order.userId}) failed ${failures + 1} time(s) - position has NO exit order, manual action required: ${e?.message ?? e}`);
    } finally {
        bookkeeping.pendingSquareOffs.delete(key);
    }
}

async function placeReplacementExit(order: PendingAntLimitOrder, remaining: number, lastLimit: number, attempt: number): Promise<void> {
    const ant = ANT.getInstance();
    // No live quote: hold the last limit rather than stepping down again on every check (a quote outage
    // would otherwise compound the discount with no floor).
    let ltp = 0;
    try {
        ltp = await safeAntQuote(order.exchange, order.instrumentId, EXIT_QUOTE_RETRY_MS, true);
    } catch (e: any) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { orderNotPlaced: true }); // nothing sent yet
    }
    const limit = roundToTick(ltp > 0 ? ltp * 0.99 : lastLimit);
    // A placement that TIMED OUT may already have been accepted by the broker, so only an outright rejection (the
    // broker answered, with an error or without an order id) is marked orderNotPlaced and safe to retry.
    let orderNo: string;
    try {
        ({ orderNo } = await ant.placeOrder({
            exchange: order.exchange,
            instrumentId: order.instrumentId,
            tradingSymbol: order.tradingSymbol,
            quantity: remaining,
            transactionType: 'SELL',
            price: limit,
            product: order.product,
        }));
    } catch (e: any) {
        // A 5xx/gateway reply can still mean the order was accepted - only a 4xx or the explicit no-order-id body is definitive.
        const status = Number(e?.response?.status);
        const answered = (Number.isFinite(status) && status >= 400 && status < 500) || /^ANT placeOrder failed/.test(String(e?.message ?? ''));
        throw answered ? Object.assign(e instanceof Error ? e : new Error(String(e)), { orderNotPlaced: true }) : e;
    }
    const next: PendingAntLimitOrder = { orderId: orderNo, userId: order.userId, tradingSymbol: order.tradingSymbol, instrumentId: order.instrumentId, quantity: remaining, exchange: order.exchange, action: 'Sell', product: order.product };
    trackPendingAntLimitOrder(next);
    Log.log(`[order] re-price ${attempt + 1}: ${order.tradingSymbol} (${order.userId}) ${remaining} re-placed as ${orderNo} at ${limit} (ltp=${ltp})`);
    scheduleExitRecheck(next, { attempt: attempt + 1, unreadableStatusCount: 0, cancelFailureCount: 0 }, limit);
}

export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO', triggerLtp?: number): Promise<Trade> {
    // In-flight guard: set synchronously (no await between the check and the
    // add) so two near-simultaneous callers - e.g. a manual /prism/squareoff
    // request and exitMonitor's auto-triggered exit for the same trade - can
    // never both pass this check. Node is single-threaded, so whichever call
    // reaches this line first sets the key and only then yields to the event
    // loop (at the first await below); the other call runs this same
    // synchronous check afterward and sees the key already present.
    const pendingKey = `${userId}:${tsym}`;
    if (bookkeeping.pendingSquareOffs.has(pendingKey)) {
        Log.log(`[order] squareOffOnAnt: square-off for ${tsym} (${userId}) already in flight - ignoring duplicate call`);
        throw new Error(`Square-off for ${tsym} is already in progress for ${userId}`);
    }
    bookkeeping.pendingSquareOffs.add(pendingKey);

    try {
        // Stop-loss takes precedence over a resting exit sell (typically BulkPcr's profit target): cancel
        // each one, book whatever it already sold, and exit only what's left.
        if (!(quantity > 0)) throw new Error(`Square-off for ${tsym}: invalid quantity ${quantity}`);
        const restingSells = pendingAntSellsFor(userId, tsym);
        // Fail before touching a resting sell if the exit can't be placed at all (no instrument token).
        const openForCheck = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);
        if (restingSells.length > 0 && !openForCheck?.antOrderNo && !(openForCheck?.token)) {
            throw new Error(`Square-off for ${tsym}: no instrument token - resting exit left untouched, manual action required`);
        }
        // In parallel: each cancel's wait is bounded, so the total wait is one poll window, not one per sell.
        const cancels = await Promise.allSettled(restingSells.map((r) => cancelRestingSellForExit(r.orderId, userId, tsym, r)));
        const failed = cancels.find((c) => c.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed) throw failed.reason;
        // What's still held is the smaller of the request and what bookkeeping shows open after the fills above.
        quantity = Math.min(quantity, openQuantity(userId, tsym));
        if (quantity <= 0) {
            if (restingSells.length === 0) {
                throw new Error(`Square-off for ${tsym}: nothing open in bookkeeping and no resting exit - not placing an order; check the broker`);
            }
            Log.log(`[order] squareOffOnAnt: resting sells already closed all of ${tsym} for ${userId} - nothing left to exit`);
            const done = new Trade();
            done.tsym = tsym;
            done.quantity = 0;
            done.price = 0;
            done.action = 'Sell';
            done.status = 'COMPLETE';
            done.user = userId;
            done.broker = 'ant';
            return done;
        }
        const ant = ANT.getInstance();
        const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

        let squareOffOrderNo: string | undefined;
        let placedExit: PendingAntLimitOrder | undefined;
        let placedLimit = 0;
        if (existing?.antOrderNo) {
            // Only bracket-order trades carry a target leg (see enterPosition) -
            // a cover-order trade has none, so its absence distinguishes 'CO'
            // from 'BO' without needing a separate field on Trade.
            const orderComplexity = existing.targetPoints ? 'BO' : 'CO';
            Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo}, ${orderComplexity})`);
            await ant.exitBracketOrder(existing.antOrderNo, orderComplexity);
        } else {
            // Same EC965 "Market orders are not allowed" fix as enterPosition's
            // regular-order BUY branch above - confirmed live 2026-10-12 that
            // AliceBlue rejects a blind MARKET order here too. A marketable
            // LIMIT 1% BELOW LTP (selling, so the marketable direction is down,
            // not up like the BUY side) fills immediately like a market sell
            // would, but with a real price floor instead of none.
            const instrumentId = existing?.token ?? '';
            if (!instrumentId) throw new Error(`Square-off for ${tsym}: no instrument token - exit NOT placed, manual action required`);
            let limitPrice: number;
            const liveLtp = await safeAntQuote(exchange, instrumentId, EXIT_QUOTE_RETRY_MS, true);
            if (liveLtp > 0) {
                limitPrice = roundToTick(liveLtp * 0.99);
                Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order (ltp=${liveLtp} limit=${limitPrice})`);
            } else if (triggerLtp && triggerLtp > 0) {
                // No live quote: the trigger tick's LTP, floored lower than a live exit would be.
                limitPrice = roundToTick(triggerLtp * EXIT_FALLBACK_FLOOR_FACTOR);
                Log.log(`[order] EXIT FALLBACK: no live ANT quote for ${tsym} - selling ${quantity} at floor ${limitPrice} from trigger LTP ${triggerLtp} for ${userId}`);
            } else {
                throw new Error(`Square-off for ${tsym}: no live quote and no trigger price - exit NOT placed, manual action required`);
            }
            let orderNo: string;
            try {
                ({ orderNo } = await ant.placeOrder({
                    exchange,
                    instrumentId,
                    tradingSymbol: tsym,
                    quantity,
                    transactionType: 'SELL',
                    price: limitPrice,
                    product: existing?.product,
                }));
            } catch (e: any) {
                // Timed out with no response: the sell may be live at the broker. ANT has no order-book/idempotency
                // lookup to reconcile against, so surface it loudly - callers must not blindly re-sell.
                if (e?.ambiguousPlacement) {
                    Log.log(`[order] ALERT: ANT square-off sell for ${tsym} qty=${quantity} (${userId}) outcome UNKNOWN - verify positions before retrying`);
                }
                throw e;
            }
            squareOffOrderNo = orderNo;
            // Tracked so the pending-order poller books the fill if this wait misses it - same as a bare limit sell.
            placedExit = { orderId: orderNo, userId, tradingSymbol: tsym, instrumentId, quantity, exchange, action: 'Sell', product: existing?.product };
            placedLimit = limitPrice;
            trackPendingAntLimitOrder(placedExit);
        }

        const trade = new Trade();
        trade.tsym = tsym;
        trade.quantity = quantity;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        trade.broker = 'ant';
        if (squareOffOrderNo) {
            const exitOrderNo = squareOffOrderNo;
            let confirmed = true;
            try {
                trade.price = await AntOrderNotifyStream.getInstance().waitForFill(exitOrderNo);
            } catch (e) {
                // Not confirmed by the push. Ask the broker once - never record a sale on a guessed price.
                const st = await ANT.getInstance().getOrderStatus(exitOrderNo).catch(() => null);
                if (st?.status === 'COMPLETE' && st.fillPrice && st.fillPrice > 0) {
                    Log.log(`[order] squareOffOnAnt: push missed but broker confirms COMPLETE for ${exitOrderNo} at ${st.fillPrice}`);
                    trade.price = st.fillPrice;
                } else {
                    confirmed = false;
                }
            }
            if (!confirmed) {
                // Not recorded as sold. The re-price chain takes over (it cancels and re-places, or the poller
                // books the fill). Not thrown: the exit monitor would otherwise place a second sell alongside it.
                Log.log(`[order] ALERT: exit ${exitOrderNo} for ${tsym} (${userId}) fill not confirmed - re-pricing at live LTP, not recorded as sold`);
                trade.status = 'PENDING';
                if (placedExit) scheduleExitRecheck(placedExit, INITIAL_EXIT_RECHECK_COUNTERS, placedLimit, 0);
                return trade;
            }
            // Booked below: untrack first so the poller doesn't book the same fill, and carry the order id
            // so recordFill's own dedupe catches a fill the poller already booked.
            untrackPendingAntLimitOrder(exitOrderNo);
            trade.brokerOrderId = exitOrderNo;
        } else {
            // exitBracketOrder path (existing?.antOrderNo) - no separate orderNo to poll a fill price for.
            trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
        }

        await bookkeeping.recordFill(trade);
        return trade;
    } finally {
        // Always release, on success or failure, so a legitimately-retriable
        // square-off (e.g. after a transient broker error) is never
        // permanently blocked.
        bookkeeping.pendingSquareOffs.delete(pendingKey);
    }
}

// exitMonitor calls this when a useGTT=false ANT trade crosses target/SL.
exitMonitor.onExit('ant', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange, trade.lastTradePrice);
});

// Entry point for the gap-screener cover-order flow (GapScreenerCoverOrder.ts) -
// the caller already has an exact resolved contract/token, so unlike
// manualBuyOnAnt this needs no contract-resolution branching.
export async function placeCoverOrderForGapScreener(
    userId: string, tradingSymbol: string, instrumentId: string,
    quantity: number, exchange: 'NFO' | 'BFO', stopLossPoints: number,
): Promise<Trade> {
    return enterPosition(userId, tradingSymbol, instrumentId, quantity, exchange, 0, stopLossPoints, 'cover');
}
