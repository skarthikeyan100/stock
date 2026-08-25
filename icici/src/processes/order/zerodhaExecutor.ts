import Log from '../../util/Log';
import Zerodha from '../../zerodha/Zerodha';
import ZerodhaContractMaster from '../../zerodha/ZerodhaContractMaster';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { estimateOptionPrice, estimateOptionPricesBatch } from './antExecutor';
import { trackPendingLimitOrder } from './pendingLimitOrders';

// Zerodha is the primary execution broker (per current product decision - Prism
// stays wired as the secondary/legacy path in prismExecutor.ts). Ported from the
// buy->fill->GTT sequence every Zerodha-calling strategy duplicated inline before
// the split (see e.g. src/strategy/GoodMorningStrategy.ts:186-224) - now the one
// place that does it, since `strategies` no longer has a Zerodha dependency at all.
//
// Exit mechanism is a per-user choice (bookkeeping.getUserUseGTT): the default
// is a broker-side GTT bracket placed once at entry (the broker, not this
// process, watches price after that). Users with useGTT=false instead get their
// trade registered with exitMonitor.ts, which watches the tick feed piped in
// from `data` and squares off in-app when target/SL is crossed.

// Shared by every entry path (index-ATM and manual/strike/contract): computes
// target/SL from points, then places a GTT or registers with exitMonitor
// depending on the placing user's useGTT setting, before recording the fill.
async function finalizeEntry(trade: Trade, userId: string, exchange: 'NFO' | 'BFO', targetPoints: number, stopLossPoints: number): Promise<void> {
    const entryPrice = trade.price;
    trade.targetPoints = targetPoints;
    trade.stopLossPrice = entryPrice - stopLossPoints;
    trade.targetPrice = entryPrice + targetPoints;

    if (targetPoints > 0 && stopLossPoints > 0) {
        if (bookkeeping.getUserUseGTT(userId)) {
            try {
                // Kept on the trade (not discarded) so setTargetStopLoss can modify
                // this same GTT later instead of only updating local bookkeeping.
                trade.gttTriggerId = await Zerodha.getInstance().placeTargetStopLossGTT(
                    trade.tsym,
                    exchange,
                    trade.quantity,
                    entryPrice,
                    targetPoints,
                    stopLossPoints,
                    entryPrice
                );
            } catch (e) {
                Log.log('[order] GTT placement failed (position is open without a bracket):', e);
            }
        } else if (trade.token) {
            exitMonitor.registerTrade(trade, exchange, 'zerodha');
        } else {
            Log.log(`[order] useGTT=false for ${userId} but trade has no token (${trade.tsym}) - exit will not be monitored`);
        }
    }

    await bookkeeping.recordFill(trade);
}

export interface BuyIndexRequest {
    userId: string;
    index?: 'NIFTY' | 'SENSEX';
    niftyLtp: number;
    right: string; // CALL | PUT
    quantity: number;
    targetPoints?: number;
    stopLossPoints?: number;
    // Exact-contract selection (TargetReachStrategy: a specific strike/expiry
    // chosen up front) - takes precedence over ATM-by-LTP when both are set.
    strike?: number;
    expiry?: string;
    // SupportResistanceStrategy: refuse if a CE/PE position is already open,
    // checked against live Zerodha positions (not local bookkeeping) so it's
    // correct across restarts regardless of which strike a prior entry used.
    skipIfOpenPositionType?: 'CE' | 'PE';
}

export async function buyIndexOnZerodha(req: BuyIndexRequest): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }

    const settings = configService.getConfig().settings;
    const targetPoints = req.targetPoints ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? settings.stopLossPriceDiff;
    const optionType = req.right === CALL ? 'CE' : 'PE';
    const index = req.index ?? 'NIFTY';

    if (req.skipIfOpenPositionType) {
        const positions = await zerodha.getPositions();
        const hasOpenPosition = (positions?.net || []).some(
            (p: any) => p.quantity !== 0 && p.exchange === 'NFO' && p.tradingsymbol?.endsWith(req.skipIfOpenPositionType)
        );
        if (hasOpenPosition) {
            throw new Error(`Skipping buy - a ${req.skipIfOpenPositionType} position is already open`);
        }
    }

    const contract = req.strike && req.expiry
        ? await ZerodhaContractMaster.getInstance().findExactOption(req.strike, req.expiry, optionType, index)
        : await ZerodhaContractMaster.getInstance().findATMOption(req.niftyLtp, optionType, index);
    Log.log(`[order] Buying ${contract.tradingSymbol} qty=${req.quantity} for ${req.userId}`);

    const { orderId } = await zerodha.buyOption(contract.tradingSymbol, req.quantity, contract.exchange);
    const entryPrice = await zerodha.getFillPrice(orderId);
    Log.log(`[order] Filled ${contract.tradingSymbol} at ${entryPrice} for ${req.userId}`);

    const trade = new Trade();
    trade.tsym = contract.tradingSymbol;
    trade.token = String(contract.instrumentToken);
    trade.quantity = req.quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.right = req.right;
    trade.user = req.userId;

    await finalizeEntry(trade, req.userId, contract.exchange, targetPoints, stopLossPoints);
    return trade;
}

// /prism/order/buy's three branches, Zerodha-routed. `contract` (now a
// canonical symbol, e.g. "NIFTY_24100_CE" - see src/model/CanonicalSymbol.ts,
// not a raw broker tradingsymbol) takes precedence, resolved to the nearest
// expiry; else `strikePrice` selects an exact strike via
// ZerodhaContractMaster.findATMOption; else it's the ATM auto-strike path
// (buyIndexOnZerodha above). Always resolved via Zerodha - no broker
// selection here. Once orders can route to other brokers, this is where a
// per-user broker lookup (extending bookkeeping's userSettingsCache) would
// decide which ContractMaster/executor to use instead of always Zerodha.
export interface ManualBuyRequest {
    userId: string;
    index?: 'NIFTY' | 'SENSEX';
    right?: string;
    contract?: string; // canonical symbol string, e.g. "NIFTY_24100_CE"
    strikePrice?: number;
    price?: number;
    quantity?: number;
    targetPoints?: number;
    stopLossPoints?: number;
}

export async function manualBuyOnZerodha(req: ManualBuyRequest): Promise<Trade> {
    if (req.contract) {
        const canonical = parseCanonicalSymbol(req.contract);
        const resolved = await ZerodhaContractMaster.getInstance().findNearestExpiryOption(canonical.strike, canonical.optionType, canonical.symbol);
        const price = await estimateOptionPrice(canonical.symbol, canonical.strike, canonical.optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, price, req.quantity);
        return buyContractOnZerodha(req.userId, resolved.tradingSymbol, String(resolved.instrumentToken), quantity, resolved.exchange, req.price, req.targetPoints, req.stopLossPoints);
    }

    if (!req.right) throw new Error('manualBuy requires either contract or right');

    const index = req.index ?? 'NIFTY';

    if (req.strikePrice) {
        const optionType = req.right === CALL ? 'CE' : 'PE';
        // findATMOption rounds its underlyingLtp arg to the nearest strike step -
        // strike prices are already multiples of that step, so feeding it the
        // strike directly lands exactly on it without needing a live NIFTY quote.
        const contract = await ZerodhaContractMaster.getInstance().findATMOption(req.strikePrice, optionType, index);
        const price = await estimateOptionPrice(index, req.strikePrice, optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, contract.tradingSymbol, price, req.quantity);
        return buyContractOnZerodha(req.userId, contract.tradingSymbol, String(contract.instrumentToken), quantity, contract.exchange, req.price, req.targetPoints, req.stopLossPoints);
    }

    const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(index);
    return buyIndexOnZerodha({ userId: req.userId, index: req.index, niftyLtp: 0, right: req.right, quantity, targetPoints: req.targetPoints, stopLossPoints: req.stopLossPoints });
}

async function buyContractOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO', price?: number, targetPoints?: number, stopLossPoints?: number): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Buying (manual) ${tradingSymbol} qty=${quantity} for ${userId}`);
    const { orderId } = await zerodha.buyOption(tradingSymbol, quantity, exchange);
    const entryPrice = price ?? (await zerodha.getFillPrice(orderId));

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;

    const settings = configService.getConfig().settings;
    const finalTargetPoints = targetPoints ?? settings.targetPriceDiff;
    const finalStopLossPoints = stopLossPoints ?? settings.stopLossPriceDiff;
    await finalizeEntry(trade, userId, exchange, finalTargetPoints, finalStopLossPoints);
    return trade;
}

// POST /prism/settarget's Zerodha path: update bookkeeping's local target/SL
// fields and, if this trade has a live GTT (gttTriggerId), modify it in place.
export async function setTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number): Promise<void> {
    const trade = bookkeeping.trades.find((t) => t.token === token && t.user === userId);
    if (!trade) throw new Error(`No open trade for token ${token} and user ${userId}`);

    trade.targetPrice = trade.price + targetPoints;
    trade.stopLossPrice = trade.price - stopLossPoints;
    trade.targetPoints = targetPoints;

    if (trade.gttTriggerId) {
        const zerodha = Zerodha.getInstance();
        const exchange = trade.tsym.startsWith('BSE') ? 'BFO' : 'NFO';
        await zerodha.modifyTargetStopLossGTT(
            trade.gttTriggerId,
            trade.tsym,
            exchange,
            trade.quantity,
            trade.targetPrice,
            trade.stopLossPrice,
            trade.lastTradePrice || trade.price
        );
    }
    bookkeeping.notifyTargetStopLossChanged();
}

export async function squareOffOnZerodha(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId}`);
    const response = await zerodha.getKiteConnect().placeOrder('regular', {
        exchange,
        tradingsymbol: tsym,
        transaction_type: 'SELL',
        quantity,
        product: 'NRML',
        order_type: 'MARKET',
        market_protection: -1,
    } as any);

    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    const fillPrice = await zerodha.getFillPrice(response.order_id);
    trade.price = fillPrice;

    await bookkeeping.recordFill(trade);
    return trade;
}

// --- ContinuousStrategy bare execution primitives ---
// Deliberately bypass finalizeEntry (no GTT, no exitMonitor registration) -
// ContinuousStrategy self-monitors every leg's target/1x-5x thresholds from
// live option ticks instead. "Bare" = just buy/sell + record the fill.

export async function marketBuyBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare market buy ${tradingSymbol} qty=${quantity} for ${userId}`);
    const { orderId } = await zerodha.buyOption(tradingSymbol, quantity, exchange);
    const entryPrice = await zerodha.getFillPrice(orderId);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;

    await bookkeeping.recordFill(trade);
    return trade;
}

// Unlike squareOffOnZerodha, this sets trade.token - needed so tokenRouter's
// unregisterTrade (called from strategiesProcess.ts's onFill on every Sell
// fill) actually finds the right token to unsubscribe.
export async function marketSellBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    Log.log(`[order] Bare market sell ${tradingSymbol} qty=${quantity} for ${userId}`);
    const response = await zerodha.getKiteConnect().placeOrder('regular', {
        exchange,
        tradingsymbol: tradingSymbol,
        transaction_type: 'SELL',
        quantity,
        product: 'NRML',
        order_type: 'MARKET',
        market_protection: -1,
    } as any);
    const fillPrice = await zerodha.getFillPrice(response.order_id);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentToken;
    trade.quantity = quantity;
    trade.price = fillPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;

    await bookkeeping.recordFill(trade);
    return trade;
}

// Places the limit order and returns immediately - does not wait for a fill
// (unlike the market-order primitives above). The fill arrives later via
// pollPendingLimitOrders -> bookkeeping.recordFill -> the normal fill-listener
// chain (IPC broadcast -> OrderClient.onFill -> strategy.updateTrade).
export async function placeLimitBuyBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare limit buy ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await zerodha.placeLimitBuyOption(tradingSymbol, quantity, price, exchange);
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange });
    return { orderId };
}

// Zerodha-side premium-range strike lookup (mirrors Prism.getContractByPriceRange's
// OTM-then-ITM strike-walk shape - src/prism.ts:666-721), but sources the
// tradable contract from ZerodhaContractMaster (CSV-backed, no live premium
// data) and the live premium from the ANT cross-reference (estimateOptionPrice)
// since this account's Zerodha quote API 403s. Floor-only check (no upper
// bound) - unlike Prism's min/max range, a ContinuousStrategy leg can move up
// to 5x its SL distance further from its own entry, so headroom above the
// floor is wanted, not capped.
//
// Premiums for every candidate strike are fetched in ONE batched ANT call
// (estimateOptionPricesBatch) rather than one estimateOptionPrice call per
// candidate in the walk loop - AliceBlue's OHLC endpoint rate-limits (429)
// after just 1-2 rapid sequential calls (confirmed live), which silently
// starved out real, qualifying candidates when this walked one-at-a-time.
export async function getContractByPriceRangeOnZerodha(
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    index: 'NIFTY' | 'SENSEX' = 'NIFTY',
    minPremium = 100,
    excludeStrikes: Set<number> = new Set()
): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: 'NFO' | 'BFO'; strike: number; premium: number; antToken: string }> {
    const strikeStep = index === 'SENSEX' ? 100 : 50;
    const atmStrike = Math.round(underlyingLtp / strikeStep) * strikeStep;

    // OTM depth 0-4, then ITM depth 1-4 - same priority order as before.
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
            const contract = await ZerodhaContractMaster.getInstance().findNearestExpiryOption(strike, optionType, index);
            return { ...contract, strike, premium: data.premium, antToken: data.antToken };
        } catch (e) {
            Log.log('[order] Zerodha contract resolution failed for a priced-in strike:', strike, optionType, e);
        }
    }

    throw new Error(`No ${index} ${optionType} contract found with premium >= ${minPremium} (underlyingLtp=${underlyingLtp})`);
}

// exitMonitor calls this when a useGTT=false trade crosses target/SL. Wired
// here (rather than exitMonitor importing squareOffOnZerodha directly) to
// avoid a circular import between the two modules.
exitMonitor.onExit('zerodha', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnZerodha(trade.user, trade.tsym, trade.quantity, exchange);
});

// GTT placement (above, useGTT=true path) is fire-and-forget - the broker
// watches price after that, but nothing here ever asked whether it actually
// triggered. Without this poll, a GTT-closed trade stays "open" in
// bookkeeping forever (blocking future orders via lot/investment limits) and
// its P&L is never recorded. Called on an interval from orderProcess.ts.
//
// `status === 'active'` and the order fields below (transaction_type,
// average_price, order_timestamp) are per Kite Connect's documented shapes
// but not yet verified against a live response from this account - log the
// raw payloads on the first real trigger and correct field names here if the
// broker's actual shape disagrees.
export async function pollGttFills(): Promise<void> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) return;

    const openGttTrades = bookkeeping.trades.filter((t) => t.gttTriggerId != null);
    if (openGttTrades.length === 0) return;

    const liveGtts = await zerodha.getGTTs();
    const activeIds = new Set(liveGtts.filter((g: any) => g.status === 'active').map((g: any) => g.id));

    for (const trade of openGttTrades) {
        if (activeIds.has(trade.gttTriggerId)) continue; // still live, not closed

        try {
            const orders = await zerodha.getKiteConnect().getOrders();
            const sellFill = (orders as any[])
                .filter((o: any) => o.tradingsymbol === trade.tsym && o.transaction_type === 'SELL' && o.status === 'COMPLETE')
                .sort((a: any, b: any) => new Date(b.order_timestamp).getTime() - new Date(a.order_timestamp).getTime())[0];

            const sellTrade = new Trade();
            sellTrade.tsym = trade.tsym;
            sellTrade.token = trade.token;
            sellTrade.quantity = trade.quantity;
            sellTrade.price = sellFill?.average_price ?? trade.targetPrice;
            sellTrade.action = 'Sell';
            sellTrade.status = 'COMPLETE';
            sellTrade.user = trade.user;

            await bookkeeping.recordFill(sellTrade);
            Log.log(`[order] GTT poll: ${trade.tsym} (${trade.user}) closed, recorded exit at ${sellTrade.price}`);
        } catch (e) {
            Log.log('[order] GTT poll: failed to resolve exit for', trade.tsym, e);
        }
    }
}
