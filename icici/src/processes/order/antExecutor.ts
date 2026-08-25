import Log from '../../util/Log';
import ANT from '../../ant/ANT';
import AntOrderNotifyStream from '../../ant/AntOrderNotifyStream';
import AntContractMaster from '../../ant/AntContractMaster';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';

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

async function enterPosition(
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: 'NFO' | 'BFO',
    targetPoints: number,
    stopLossPoints: number
): Promise<Trade> {
    const ant = ANT.getInstance();
    const useBracket = targetPoints > 0 && stopLossPoints > 0 && bookkeeping.getUserUseGTT(userId);

    let orderNo: string;
    if (useBracket) {
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
    const entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
    Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentId;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;

    if (targetPoints > 0 && stopLossPoints > 0) {
        trade.targetPoints = targetPoints;
        trade.stopLossPrice = entryPrice - stopLossPoints;
        trade.targetPrice = entryPrice + targetPoints;

        if (useBracket) {
            // The broker (not this process) watches price after this - kept
            // on the trade so squareOffOnAnt knows to exit via exitBracketOrder.
            trade.antOrderNo = orderNo;
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
    const targetPoints = req.targetPoints ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? settings.stopLossPriceDiff;
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
// subscription (see Zerodha.ts buyOption's comment), so ANT (already the
// app's sole live tick source) is the pricing reference for both executors.
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

// Batched sibling of estimateOptionPrice - resolves every candidate's token
// locally (no network) then fetches all their premiums in one ANT.getQuotes
// call, instead of one estimateOptionPrice (and thus one HTTP request) per
// candidate. Needed by any caller that checks several strikes' premiums in a
// single decision (e.g. a strike-range walk) - see ANT.getQuotes for why.
// Missing/failed candidates are simply absent from the returned map (same
// effect as estimateOptionPrice's 0-on-failure, without polluting the map
// with a misleading zero premium).
//
// Also surfaces the resolved ANT token per candidate (not just its premium) -
// Zerodha and ANT number the same contract completely differently (confirmed
// live: the same NIFTY 24300 PE is Zerodha instrumentToken 15795970 but ANT
// token 61703), and it's the ANT token that live option ticks are keyed by
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
    const exch = symbol === 'SENSEX' ? 'BFO' : 'NFO';
    const resolved: { key: string; token: string; exch: string }[] = [];
    for (const c of candidates) {
        try {
            const r = AntContractMaster.getInstance().findNearestExpiryOption({ symbol, exch, strike: c.strike, optionType: c.optionType });
            resolved.push({ key: `${c.strike}_${c.optionType}`, token: r.token, exch: r.exch });
        } catch (e) {
            Log.log('[order] Contract resolution for batch price estimate failed:', c.strike, c.optionType, e);
        }
    }
    if (resolved.length === 0) return new Map();

    try {
        const byToken = await ANT.getInstance().getQuotes(resolved.map((r) => ({ exchange: r.exch, token: r.token })));
        const byKey = new Map<string, { premium: number; antToken: string }>();
        for (const r of resolved) {
            const ltp = byToken.get(r.token);
            if (ltp != null) byKey.set(r.key, { premium: ltp, antToken: r.token });
        }
        return byKey;
    } catch (e) {
        Log.log('[order] Batch ANT quote fetch failed:', e);
        return new Map();
    }
}

export async function manualBuyOnAnt(req: ManualBuyRequest): Promise<Trade> {
    const settings = configService.getConfig().settings;
    const targetPoints = req.targetPoints ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? settings.stopLossPriceDiff;

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

export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const ant = ANT.getInstance();
    const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

    if (existing?.antOrderNo) {
        Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo})`);
        await ant.exitBracketOrder(existing.antOrderNo, 'BO');
    } else {
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
        const instrumentId = existing?.token ?? '';
        await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol: tsym,
            quantity,
            transactionType: 'SELL',
        });
    }

    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    // exitBracketOrder closes the position directly (no separate orderNo to
    // poll a fill price for); for the plain-order path a real fill-price poll
    // would need the returned orderNo threaded through - left as the entry
    // price for now, consistent with this being a best-effort first pass.
    trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;

    await bookkeeping.recordFill(trade);
    return trade;
}

// exitMonitor calls this when a useGTT=false ANT trade crosses target/SL.
exitMonitor.onExit('ant', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange);
});
