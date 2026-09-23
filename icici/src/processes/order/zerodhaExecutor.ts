import Log from '../../util/Log';
import Zerodha, { roundToTick } from '../../zerodha/Zerodha';
import ZerodhaContractMaster from '../../zerodha/ZerodhaContractMaster';
import AntContractMaster from '../../ant/AntContractMaster';
import ANT from '../../ant/ANT';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { estimateOptionPrice, estimateOptionPricesBatch } from './antExecutor';
import { trackPendingLimitOrder, untrackPendingLimitOrder } from './pendingLimitOrders';
import { BuyRequest } from './BrokerExecutor';

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

// 2026-09-22: there should be no true MARKET orders placed at the broker,
// anywhere - a blind market order has no price floor at all, which is
// exactly what turned a single bad/stale tick into a real trading loss (see
// BulkPcrStrategy's exit fix earlier this session). Every remaining Zerodha
// MARKET call site below now instead fetches the latest quote and places a
// MARKETABLE LIMIT order priced just beyond it - fills immediately against
// current liquidity, same as a market order would from the user's point of
// view, but always carries a real price bound.
//
// Zerodha's own quote/LTP endpoints 403 for this account's Kite Connect
// subscription (see the removed buyOption's old comment - Kite Connect
// doesn't grant this), so ANT.getQuote is the pricing reference instead -
// the same "confirmed live" primitive ANT's own bracket-order entries
// already use to price their marketable limit (see ANT.ts's getQuote
// comment). A short TTL cache means a CHUNKED order's several calls for the
// SAME contract (all placed within a couple of seconds of each other, see
// chunkedOrder.ts) reuse one fetch instead of hitting AliceBlue's
// rate-limited OHLC endpoint (429 after 1-2 rapid sequential calls,
// confirmed live elsewhere in this codebase) once per chunk.
const REFERENCE_PRICE_TTL_MS = 10_000;
const referencePriceCache = new Map<string, { price: number; fetchedAt: number }>();

async function getMarketableZerodhaPrice(antToken: string, exchange: 'NFO' | 'BFO', direction: 'BUY' | 'SELL'): Promise<number> {
    const key = `${antToken}:${direction}`;
    const cached = referencePriceCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < REFERENCE_PRICE_TTL_MS) return cached.price;

    const ltp = await ANT.getInstance().getQuote(exchange, antToken);
    // 1% buffer beyond LTP - mirrors antExecutor.ts's enterPosition BO pricing
    // convention exactly (same rationale: aggressive enough to fill
    // immediately, not a resting order waiting for a specific price).
    const buffered = direction === 'BUY' ? ltp * 1.01 : ltp * 0.99;
    const price = roundToTick(buffered);
    referencePriceCache.set(key, { price, fetchedAt: Date.now() });
    return price;
}

// Shared by every entry path (index-ATM and manual/strike/contract): computes
// target/SL from points, then places a GTT or registers with exitMonitor
// depending on the placing user's useGTT setting, before recording the fill.
async function finalizeEntry(trade: Trade, userId: string, exchange: 'NFO' | 'BFO', targetPoints: number, stopLossPoints: number): Promise<void> {
    const entryPrice = trade.price;
    trade.targetPoints = targetPoints;
    // Tick-rounded (not just entryPrice +/- points) so these match whatever
    // placeTargetStopLossGTT actually sends the broker, and stay sane if a
    // GTT failure falls back to exitMonitor's in-app target/SL comparison
    // below - a multi-fill average entryPrice (e.g. 133.61363636363637)
    // otherwise produces a stopLossPrice that isn't a tick multiple, which
    // Zerodha's GTT API rejects outright (confirmed live: "Stoploss trigger
    // price should be a multiple of tick size 0.05").
    trade.stopLossPrice = roundToTick(entryPrice - stopLossPoints);
    trade.targetPrice = roundToTick(entryPrice + targetPoints);

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
                // GTT owns the actual exit, but nothing else keeps trade.lastTradePrice
                // fresh after entry - register watch-only so the frontend's live P&L
                // still moves with the market instead of freezing at the fill price.
                if (trade.token) exitMonitor.registerTrade(trade, exchange, 'zerodha', true);
            } catch (e) {
                Log.log('[order] GTT placement failed - falling back to in-app target/SL monitoring:', e);
                // Without this, a GTT failure left the position with zero
                // protection at all (no broker bracket, and the watch-only
                // registration above never runs since it's after the failed
                // call) - degrade to the same in-app monitoring useGTT=false
                // users get, instead of leaving it completely unwatched.
                if (trade.token) {
                    exitMonitor.registerTrade(trade, exchange, 'zerodha');
                } else {
                    Log.log(`[order] GTT failed for ${userId} and trade has no token (${trade.tsym}) - exit will not be monitored`);
                }
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
    const targetPoints = req.targetPoints ?? bookkeeping.getUserTargetPoints(req.userId) ?? settings.targetPriceDiff;
    const stopLossPoints = req.stopLossPoints ?? bookkeeping.getUserStopLossPoints(req.userId) ?? settings.stopLossPriceDiff;
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
    const commonToken = req.strike && req.expiry
        ? AntContractMaster.getInstance().resolveCommonToken(index, optionType, { strike: req.strike, expiry: req.expiry })
        : AntContractMaster.getInstance().resolveCommonToken(index, optionType, { atmLtp: req.niftyLtp });
    Log.log(`[order] Buying ${contract.tradingSymbol} qty=${req.quantity} for ${req.userId}`);

    const buyPrice = await getMarketableZerodhaPrice(commonToken, contract.exchange, 'BUY');
    const { orderId } = await zerodha.placeLimitBuyOption(contract.tradingSymbol, req.quantity, buyPrice, contract.exchange);
    const entryPrice = await zerodha.getFillPrice(orderId);
    Log.log(`[order] Filled ${contract.tradingSymbol} at ${entryPrice} for ${req.userId}`);

    const trade = new Trade();
    trade.tsym = contract.tradingSymbol;
    trade.token = commonToken;
    trade.quantity = req.quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.right = req.right;
    trade.user = req.userId;
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;

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
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(canonical.symbol, canonical.optionType, { strike: canonical.strike });
        const price = await estimateOptionPrice(canonical.symbol, canonical.strike, canonical.optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, price, req.quantity);
        return buyContractOnZerodha(req.userId, resolved.tradingSymbol, commonToken, quantity, resolved.exchange, req.price, req.targetPoints, req.stopLossPoints);
    }

    if (!req.right) throw new Error('manualBuy requires either contract or right');

    const index = req.index ?? 'NIFTY';

    if (req.strikePrice) {
        const optionType = req.right === CALL ? 'CE' : 'PE';
        // findATMOption rounds its underlyingLtp arg to the nearest strike step -
        // strike prices are already multiples of that step, so feeding it the
        // strike directly lands exactly on it without needing a live NIFTY quote.
        const contract = await ZerodhaContractMaster.getInstance().findATMOption(req.strikePrice, optionType, index);
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(index, optionType, { atmLtp: req.strikePrice });
        const price = await estimateOptionPrice(index, req.strikePrice, optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, contract.tradingSymbol, price, req.quantity);
        return buyContractOnZerodha(req.userId, contract.tradingSymbol, commonToken, quantity, contract.exchange, req.price, req.targetPoints, req.stopLossPoints);
    }

    const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(index);
    return buyIndexOnZerodha({ userId: req.userId, index: req.index, niftyLtp: 0, right: req.right, quantity, targetPoints: req.targetPoints, stopLossPoints: req.stopLossPoints });
}

async function buyContractOnZerodha(userId: string, tradingSymbol: string, commonToken: string, quantity: number, exchange: 'NFO' | 'BFO', price?: number, targetPoints?: number, stopLossPoints?: number): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Buying (manual) ${tradingSymbol} qty=${quantity} for ${userId}`);
    const buyPrice = await getMarketableZerodhaPrice(commonToken, exchange, 'BUY');
    const { orderId } = await zerodha.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    const entryPrice = price ?? (await zerodha.getFillPrice(orderId));

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = commonToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;

    const settings = configService.getConfig().settings;
    const finalTargetPoints = targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? settings.targetPriceDiff;
    const finalStopLossPoints = stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? settings.stopLossPriceDiff;
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
    // ANT commonToken for pricing (see getMarketableZerodhaPrice) - every open
    // Zerodha trade in bookkeeping.trades carries one, set at entry by every
    // buy path above.
    const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);
    if (!existing?.token) {
        throw new Error(`squareOffOnZerodha: no tracked open trade (with a token) found for ${tsym} (${userId}) - cannot price a marketable limit sell without it`);
    }
    const sellPrice = await getMarketableZerodhaPrice(existing.token, exchange, 'SELL');
    const { orderId } = await zerodha.placeLimitSellOption(tsym, quantity, sellPrice, exchange);

    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;
    const fillPrice = await zerodha.getFillPrice(orderId);
    trade.price = fillPrice;

    await bookkeeping.recordFill(trade);
    return trade;
}

// BrokerExecutor.buy() implementation (see BrokerExecutor.ts) - places a
// market buy for an already-resolved contract (caller did strike/expiry
// selection; buyIndexOnZerodha/manualBuyOnZerodha above do their own
// resolution before ever reaching a Trade), then finalizeEntry protects it
// (GTT or exitMonitor watch) when both target/stopLossPoints are set, or
// leaves it unprotected when they aren't - the same "bare" semantics
// marketBuyBareOnZerodha below hand-implements by skipping finalizeEntry
// entirely, unified here into one function since finalizeEntry already
// no-ops protection on its own when targetPoints/stopLossPoints are 0.
export async function buyResolvedOnZerodha(request: BuyRequest): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    // 'NSE' in Exchange is Breeze-only (Zerodha never trades NSE cash through
    // this path) - cast is safe, this dispatch only reaches here for
    // Zerodha-broker users.
    const exchange = request.exchange as 'NFO' | 'BFO';
    Log.log(`[order] Buying ${request.tradingSymbol} qty=${request.quantity} for ${request.userId} (BrokerExecutor.buy)`);
    // getMarketableZerodhaPrice's TTL cache means a chunked buy (buyChunked
    // calling this once per chunk, same request.instrumentId every time)
    // naturally reuses one ANT quote fetch across the whole chunk batch
    // instead of one per chunk.
    const buyPrice = await getMarketableZerodhaPrice(request.instrumentId, exchange, 'BUY');
    const { orderId } = await zerodha.placeLimitBuyOption(request.tradingSymbol, request.quantity, buyPrice, exchange);
    const entryPrice = await zerodha.getFillPrice(orderId);

    const trade = new Trade();
    trade.tsym = request.tradingSymbol;
    trade.token = request.instrumentId;
    trade.quantity = request.quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = request.userId;
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;

    await finalizeEntry(trade, request.userId, exchange, request.targetPoints ?? 0, request.stopLossPoints ?? 0);
    return trade;
}

// --- ContinuousStrategy bare execution primitives ---
// Deliberately bypass finalizeEntry (no GTT, no exitMonitor registration) -
// ContinuousStrategy self-monitors every leg's target/1x-5x thresholds from
// live option ticks instead. "Bare" = just buy/sell + record the fill.
// Left as its own separate path (not migrated onto buyResolvedOnZerodha
// above) rather than touching ContinuousStrategy's already-working, live
// call sites as part of this change - see the BrokerExecutor plan's
// migration notes.

export async function marketBuyBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare market buy ${tradingSymbol} qty=${quantity} for ${userId}`);
    // instrumentToken here is the ANT commonToken (LegManager's callers
    // always resolve it that way - live option ticks are keyed by ANT's
    // token, not Zerodha's own instrumentToken), which is what
    // getMarketableZerodhaPrice needs to query ANT for a live quote.
    const buyPrice = await getMarketableZerodhaPrice(instrumentToken, exchange, 'BUY');
    const { orderId } = await zerodha.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
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
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;

    await bookkeeping.recordFill(trade);
    return trade;
}

// Unlike squareOffOnZerodha, this sets trade.token - needed so tokenRouter's
// unregisterTrade (called from strategiesProcess.ts's onFill on every Sell
// fill) actually finds the right token to unsubscribe.
export async function marketSellBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const zerodha = Zerodha.getInstance();
    Log.log(`[order] Bare market sell ${tradingSymbol} qty=${quantity} for ${userId}`);
    const sellPrice = await getMarketableZerodhaPrice(instrumentToken, exchange, 'SELL');
    const { orderId } = await zerodha.placeLimitSellOption(tradingSymbol, quantity, sellPrice, exchange);
    const fillPrice = await zerodha.getFillPrice(orderId);

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = instrumentToken;
    trade.quantity = quantity;
    trade.price = fillPrice;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'zerodha';
    trade.brokerOrderId = orderId;

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
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange, action: 'Buy' });
    return { orderId };
}

// Returns immediately with {orderId} - fill arrives later via
// pollPendingLimitOrders, mirroring placeLimitBuyBareOnZerodha exactly but
// for a SELL leg. Used for a target-hit exit that must lock in a specific
// price - unlike squareOffOnZerodha (blind MARKET order, no price floor at
// all), a caller here controls exactly what price the position can close
// at; if the market never actually reaches it, the order simply rests
// rather than selling into a loss.
export async function placeLimitSellBareOnZerodha(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await zerodha.placeLimitSellOption(tradingSymbol, quantity, price, exchange);
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange, action: 'Sell' });
    return { orderId };
}

// Cancels a resting limit order (e.g. ContinuousStrategy's root-refill drift-cancel
// check) and stops pollPendingLimitOrders from continuing to poll it.
export async function cancelOrderOnZerodha(orderId: string): Promise<void> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) {
        throw new Error('Zerodha session not active - complete /kite/login first.');
    }
    await zerodha.cancelOrder(orderId);
    untrackPendingLimitOrder(orderId);
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
            sellTrade.broker = 'zerodha';

            await bookkeeping.recordFill(sellTrade);
            Log.log(`[order] GTT poll: ${trade.tsym} (${trade.user}) closed, recorded exit at ${sellTrade.price}`);
        } catch (e) {
            Log.log('[order] GTT poll: failed to resolve exit for', trade.tsym, e);
        }
    }
}

// Detects a sell placed OUTSIDE this app - e.g. the user manually squared off
// a position from the Kite app UI directly - and reconciles it into
// bookkeeping so the trade doesn't stay open forever (blocking future orders
// via lot/investment limits) and its P&L never gets recorded. Every sell this
// app itself places already sets trade.brokerOrderId and is recorded via
// recordFill synchronously at its own call site, and recordFill's own
// processedFillIds dedup (keyed on brokerOrderId, see bookkeeping.ts) means
// blindly re-feeding an order it already knows about is a silent no-op - so
// this function doesn't need its own "is this orderId ours" tracking, it just
// finds every COMPLETE SELL order for each open trade's tsym since that
// trade's entryTime and lets recordFill sort out which (if any) are actually
// new. Called on an interval from orderProcess.ts, same cadence as pollGttFills.
export async function reconcileManualSells(): Promise<void> {
    const zerodha = Zerodha.getInstance();
    if (!(await zerodha.hasValidSession())) return;
    if (bookkeeping.trades.length === 0) return;

    let orders: any[];
    try {
        orders = await zerodha.getKiteConnect().getOrders();
    } catch (e) {
        Log.log('[order] reconcileManualSells: failed to fetch orders:', e);
        return;
    }

    for (const trade of bookkeeping.trades) {
        const entryTimeMs = trade.entryTime?.getTime() ?? 0;
        const sellFills = orders.filter((o: any) =>
            o.tradingsymbol === trade.tsym && o.transaction_type === 'SELL' && o.status === 'COMPLETE' &&
            new Date(o.order_timestamp).getTime() >= entryTimeMs
        );

        for (const fill of sellFills) {
            try {
                const sellTrade = new Trade();
                sellTrade.tsym = trade.tsym;
                sellTrade.token = trade.token;
                sellTrade.quantity = fill.filled_quantity;
                sellTrade.price = fill.average_price;
                sellTrade.action = 'Sell';
                sellTrade.status = 'COMPLETE';
                sellTrade.user = trade.user;
                sellTrade.broker = 'zerodha';
                sellTrade.brokerOrderId = fill.order_id;

                await bookkeeping.recordFill(sellTrade);
            } catch (e) {
                Log.log('[order] reconcileManualSells: failed to record fill for', trade.tsym, fill.order_id, e);
            }
        }
    }
}
