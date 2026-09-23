import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import { roundToTick } from '../../zerodha/Zerodha';
import AntOrderNotifyStream from '../../ant/AntOrderNotifyStream';
import AntContractMaster from '../../ant/AntContractMaster';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { trackPendingAntLimitOrder } from './pendingAntLimitOrders';

// AliceBlue/ANT execution, mirroring zerodhaExecutor.ts's shape and the same
// per-user useGTT gating (bookkeeping.getUserUseGTT) - but the actual
// broker-side bracket mechanism differs structurally from Zerodha's GTT:
//
// Zerodha: buy (market) -> learn fill price -> place a SEPARATE two-leg GTT
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

export async function enterPosition(
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: 'NFO' | 'BFO',
    targetPoints: number,
    stopLossPoints: number,
    orderMode: 'bracket' | 'cover' = 'bracket'
): Promise<Trade> {
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
        const ltp = await ant.getQuote(exchange, instrumentId);
        const limitPrice = Math.round(ltp * 1.01 * 20) / 20;
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
    } else {
        Log.log(`[order] Buying ${tradingSymbol} qty=${quantity} for ${userId} via ANT regular order`);
        ({ orderNo } = await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol,
            quantity,
            transactionType: 'BUY',
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
    try {
        entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        entryPrice = await ant.getFillPrice(orderNo);
        Log.log(`[order] REST fallback confirmed fill for ${tradingSymbol} at ${entryPrice} for ${userId} (order-notify push was missed)`);
    }

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.brokerOrderId = orderNo;

    if (useCover || (targetPoints > 0 && stopLossPoints > 0)) {
        // Tick-rounded for consistency with the Zerodha path and with
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
    }

    await bookkeeping.recordFill(trade);
    return trade;
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

// Mirrors manualBuyOnZerodha's three branches: canonical `contract` string,
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

// Quote fetch for sizing purposes only - never throws, returns 0 (which
// bookkeeping.resolveManualBuyQuantity treats as "no price available, use
// 1 lot") on any failure, so a temporary ANT hiccup never blocks a manual
// buy that doesn't otherwise depend on ANT (e.g. Zerodha-executed orders).
async function safeAntQuote(exch: 'NFO' | 'BFO', token: string): Promise<number> {
    try {
        return await ANT.getInstance().getQuote(exch, token);
    } catch (e) {
        Log.log('[order] ANT quote fetch failed (falling back to 1-lot sizing):', e);
        return 0;
    }
}

// Live price estimate for investment-amount-based manual-buy sizing,
// resolved via ANT regardless of execution broker - Zerodha's own
// quote/LTP endpoints return 403 for this account's Kite Connect
// subscription (see Zerodha.placeLimitBuyOption's comment), so ANT (already
// the app's sole live tick source) is the pricing reference for both executors.
export async function estimateOptionPrice(symbol: string, strike: number, optionType: string): Promise<number> {
    try {
        const exch = symbol === 'SENSEX' ? 'BFO' : 'NFO';
        const resolved = AntContractMaster.getInstance().findNearestExpiryOption({ symbol, exch, strike, optionType });
        return await safeAntQuote(resolved.exch as 'NFO' | 'BFO', resolved.token);
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
// Surfaces the ANT token per candidate (not just its premium) - Zerodha and
// ANT number the same contract completely differently (confirmed live: the
// same NIFTY 24300 PE is Zerodha instrumentToken 15795970 but ANT token
// 61703), and it's the ANT token that live option ticks are keyed by
// (OptionQuote.fromAnt sets quote.token = response.tk). A caller that resolves
// a contract here for a leg it will self-monitor via live ANT ticks (e.g.
// ContinuousStrategy) needs this ANT token, not Zerodha's, wired into
// whatever it later registers for tick subscription/matching - passing
// Zerodha's token there means the subscription and every incoming tick land
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
        Log.log('[order] Option chain fetch for batch price estimate failed:', e);
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
        const price = await safeAntQuote(resolved.exch as 'NFO' | 'BFO', resolved.token);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, price, req.quantity);
        return enterPosition(req.userId, resolved.tradingSymbol, resolved.token, quantity, resolved.exch as 'NFO' | 'BFO', targetPoints, stopLossPoints);
    }

    if (!req.right) throw new Error('manualBuy requires either contract or right');

    const index = req.index ?? 'NIFTY';

    if (req.strikePrice) {
        const optionType = req.right === CALL ? 'CE' : 'PE';
        const contract = AntContractMaster.getInstance().findATMOption(req.strikePrice, optionType, index);
        const price = await safeAntQuote(contract.exch as 'NFO' | 'BFO', contract.token);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, contract.tradingSymbol, price, req.quantity);
        return enterPosition(req.userId, contract.tradingSymbol, contract.token, quantity, contract.exch as 'NFO' | 'BFO', targetPoints, stopLossPoints);
    }

    const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(index);

    return buyIndexOnAnt({ userId: req.userId, index: req.index, niftyLtp: 0, right: req.right, quantity, targetPoints, stopLossPoints });
}

// AliceBlue's BO modify endpoint field shape for re-pricing a live bracket's
// legs hasn't been confirmed against a live response, so this only updates
// local bookkeeping for now - the broker-side BO leg prices are NOT
// re-priced. Once the modify shape is verified, add the live call here
// (mirroring zerodhaExecutor.setTargetStopLoss's modifyTargetStopLossGTT call).
export async function setTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
    const trade = bookkeeping.trades.find((t) => t.token === token && t.user === userId);
    if (!trade) throw new Error(`No open trade for token ${token} and user ${userId}`);

    trade.targetPrice = trade.price + targetPoints;
    trade.stopLossPrice = trade.price - stopLossPoints;
    trade.targetPoints = targetPoints;

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
// that must lock in a specific price - see placeLimitSellBareOnZerodha's
// comment for why (2026-09-22 incident).
export async function placeLimitSellBareOnAnt(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const ant = ANT.getInstance();
    Log.log(`[order] Bare ANT limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderNo } = await ant.placeOrder({
        exchange,
        instrumentId,
        tradingSymbol,
        quantity,
        transactionType: 'SELL',
        price,
    });
    trackPendingAntLimitOrder({ orderId: orderNo, userId, tradingSymbol, instrumentId, quantity, exchange, action: 'Sell' });
    return { orderId: orderNo };
}

export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
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
        const ant = ANT.getInstance();
        const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

        let squareOffOrderNo: string | undefined;
        if (existing?.antOrderNo) {
            // Only bracket-order trades carry a target leg (see enterPosition) -
            // a cover-order trade has none, so its absence distinguishes 'CO'
            // from 'BO' without needing a separate field on Trade.
            const orderComplexity = existing.targetPoints ? 'BO' : 'CO';
            Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo}, ${orderComplexity})`);
            await ant.exitBracketOrder(existing.antOrderNo, orderComplexity);
        } else {
            Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
            const instrumentId = existing?.token ?? '';
            const { orderNo } = await ant.placeOrder({
                exchange,
                instrumentId,
                tradingSymbol: tsym,
                quantity,
                transactionType: 'SELL',
            });
            squareOffOrderNo = orderNo;
        }

        const trade = new Trade();
        trade.tsym = tsym;
        trade.quantity = quantity;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        if (squareOffOrderNo) {
            try {
                trade.price = await AntOrderNotifyStream.getInstance().waitForFill(squareOffOrderNo);
            } catch (e) {
                Log.log('[order] squareOffOnAnt: waitForFill failed, falling back to last-seen price:', e);
                trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
            }
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
    await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange);
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
