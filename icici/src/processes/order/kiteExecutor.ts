import type { MirrorHook } from './mirror';
import Log from '../../util/Log';
import { getSpotLtp } from './spotQuote';
import Kite from '../../kite/Kite';
import { roundToTick } from '../../util/tick';
import KiteContractMaster from '../../kite/KiteContractMaster';
import AntContractMaster from '../../ant/AntContractMaster';
import ANT from '../../ant/ANT';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import { pickContractByPremium } from './priceRangeContract';
import * as exitMonitor from './exitMonitor';
import { estimateOptionPrice, estimateOptionPricesBatch } from './antExecutor';
import { trackPendingLimitOrder, untrackPendingLimitOrder, findPendingOrdersForSymbol, isTrackedPendingOrder, beginCancelOfPendingLimitOrders, endCancelOfPendingLimitOrders, silenceListenersOfPendingLimitOrders } from './pendingLimitOrders';
import { BuyRequest, cancelOrderWithFillRecheck, OrderAlreadyFilledError, emptyExitTrade } from './BrokerExecutor';
import { exchangeForTsym } from '../../util/underlyings';
import { loadOrderOwners } from './orderOwners';
import Mongo from '../../tools/mongo';

// Kite is the primary execution broker (per current product decision - Prism
// stays wired as the secondary/legacy path in prismExecutor.ts). Ported from the
// buy->fill->GTT sequence every Kite-calling strategy duplicated inline before
// the split (see e.g. src/strategy/GoodMorningStrategy.ts:186-224) - now the one
// place that does it, since `strategies` no longer has a Kite dependency at all.
//
// Exit mechanism is a per-user choice (bookkeeping.getUserUseGTT): the default
// is a broker-side GTT bracket placed once at entry (the broker, not this
// process, watches price after that). Users with useGTT=false instead get their
// trade registered with exitMonitor.ts, which watches the tick feed piped in
// from `data` and squares off in-app when target/SL is crossed.

// The one place a Kite fill's Trade is built. A Sell does not carry lastTradePrice (its exit price is booked from the fill, and the
// open position it closes has its own mark), every other action does. `right` is set only for index entries.
interface KiteFillSpec {
    tsym: string;
    token: string;
    action: 'Buy' | 'Sell' | 'SellToOpen' | 'BuyToClose';
    userId: string;
    orderId: string;
    right?: any;
}
function kiteFillTrade(spec: KiteFillSpec, qty: number, price: number): Trade {
    const t = new Trade();
    t.tsym = spec.tsym;
    t.token = spec.token;
    t.quantity = qty;
    t.price = price;
    if (spec.action !== 'Sell') t.lastTradePrice = price;
    t.action = spec.action;
    t.status = 'COMPLETE';
    if (spec.right !== undefined) t.right = spec.right;
    t.user = spec.userId;
    t.broker = 'kite';
    t.brokerOrderId = spec.orderId;
    return t;
}

// Waits for a fill; if the order ends partially filled (Kite.getFillPrice throws driftCancelled with
// filledQuantity), books that real quantity before rethrowing - otherwise it'd be an untracked position/sale.
async function getFillBookingPartial(kite: Kite, orderId: string, mk: (qty: number, price: number) => Trade, record: (t: Trade) => Promise<unknown>): Promise<number> {
    try {
        return await kite.getFillPrice(orderId);
    } catch (e: any) {
        if (e?.driftCancelled && e.filledQuantity > 0) {
            await record(mk(e.filledQuantity, e.averagePrice));
        }
        throw e;
    }
}

// 2026-09-22: there should be no true MARKET orders placed at the broker,
// anywhere - a blind market order has no price floor at all, which is
// exactly what turned a single bad/stale tick into a real trading loss (see
// BulkPcrStrategy's exit fix earlier this session). Every remaining Kite
// MARKET call site below now instead fetches the latest quote and places a
// MARKETABLE LIMIT order priced just beyond it - fills immediately against
// current liquidity, same as a market order would from the user's point of
// view, but always carries a real price bound.
//
// Kite's own quote/LTP endpoints 403 for this account's Kite Connect
// subscription (see the removed buyOption's old comment - Kite Connect
// doesn't grant this), so ANT.getQuote is the pricing reference instead -
// the same "confirmed live" primitive ANT's own bracket-order entries
// already use to price their marketable limit (see ANT.ts's getQuote
// comment). ANT.getQuote itself short-TTL-caches by exchange+token now (see
// its own comment), so a CHUNKED order's several calls for the SAME contract
// already collapse to one HTTP call there - no separate cache needed here.
async function getMarketableKitePrice(antToken: string, exchange: 'NFO' | 'BFO', direction: 'BUY' | 'SELL'): Promise<number> {
    // Live bid/ask first (the cached OHLC getQuote lags a fast option by a minute or more - see
    // ANT.getLiveQuote); fall back to getQuote if the live call fails (e.g. a 429).
    let ltp: number;
    try {
        const live = await ANT.getInstance().getLiveQuote(exchange, antToken);
        // The price a taker actually crosses: the ask for a buy, the bid for a sell (never worse than LTP).
        ltp = direction === 'BUY' ? Math.max(live.ltp, live.ask) : (live.bid > 0 ? Math.min(live.ltp, live.bid) : live.ltp);
    } catch (e) {
        Log.log(`[order] getMarketableKitePrice: live quote failed for ${exchange}|${antToken}, falling back to cached getQuote:`, e);
        ltp = await ANT.getInstance().getQuote(exchange, antToken);
    }
    // Buffer beyond LTP: aggressive enough to fill immediately, not a resting order waiting for a
    // specific price. 5% (was 1%, then 3%): ANT's REST quote lags a fast-moving expiry-day option by 3-4 points
    // (an 88 quote vs a 91 market at 12:30 on 2026-10-19), so even a 3% cap sat below the ask and 'did not fill
    // within timeout' about once a minute. Kite fills a marketable limit at the best available price, so a wider
    // cap costs no extra slippage.
    const buffered = direction === 'BUY' ? ltp * 1.05 : ltp * 0.95;
    return roundToTick(buffered);
}

// Shared by every entry path (index-ATM and manual/strike/contract): computes
// target/SL from points, then places a GTT or registers with exitMonitor
// depending on the placing user's useGTT setting, before recording the fill.
async function finalizeEntry(trade: Trade, userId: string, exchange: 'NFO' | 'BFO', targetPoints: number, stopLossPoints: number): Promise<void> {
    const entryPrice = trade.price;

    if (targetPoints > 0 && stopLossPoints > 0) {
        trade.targetPoints = targetPoints;
        // Tick-rounded (not just entryPrice +/- points) so these match whatever
        // placeTargetStopLossGTT actually sends the broker, and stay sane if a
        // GTT failure falls back to exitMonitor's in-app target/SL comparison
        // below - a multi-fill average entryPrice (e.g. 133.61363636363637)
        // otherwise produces a stopLossPrice that isn't a tick multiple, which
        // Kite's GTT API rejects outright (confirmed live: "Stoploss trigger
        // price should be a multiple of tick size 0.05").
        //
        // Deliberately scoped inside this guard (not set unconditionally
        // above it): a caller with no real target/SL (targetPoints=0,
        // stopLossPoints=0 - e.g. BulkPcrStrategy's buyResolvedOnKite,
        // which manages its own separate chunked resting-limit-sell exit)
        // must leave trade.targetPrice/stopLossPrice unset. Setting them to
        // entryPrice+/-0 here used to persist a target=stopLoss=entryPrice
        // Trade doc that looked, to a LATER exitMonitor.reconcileFromTrades()
        // restart-reconciliation pass, exactly like a real armed target/SL -
        // it would register a live (non-watchOnly) watch that fires on
        // essentially the very next tick, then square off with a single
        // unchunked order that always exceeds the exchange's per-order
        // freeze-quantity limit for a BulkPcrStrategy-sized position. Live
        // incident 2026-09-24: this fired hundreds of times/sec against
        // Kite with no backoff before being caught.
        trade.stopLossPrice = roundToTick(entryPrice - stopLossPoints);
        trade.targetPrice = roundToTick(entryPrice + targetPoints);

        if (bookkeeping.getUserUseGTT(userId)) {
            try {
                // Kept on the trade (not discarded) so setTargetStopLoss can modify
                // this same GTT later instead of only updating local bookkeeping.
                trade.gttTriggerId = await Kite.getInstance().placeTargetStopLossGTT(
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
                if (trade.token) exitMonitor.registerTrade(trade, exchange, 'kite', true);
            } catch (e) {
                Log.log('[order] GTT placement failed - falling back to in-app target/SL monitoring:', e);
                // Without this, a GTT failure left the position with zero
                // protection at all (no broker bracket, and the watch-only
                // registration above never runs since it's after the failed
                // call) - degrade to the same in-app monitoring useGTT=false
                // users get, instead of leaving it completely unwatched.
                if (trade.token) {
                    exitMonitor.registerTrade(trade, exchange, 'kite');
                } else {
                    Log.log(`[order] GTT failed for ${userId} and trade has no token (${trade.tsym}) - exit will not be monitored`);
                }
            }
        } else if (trade.token) {
            exitMonitor.registerTrade(trade, exchange, 'kite');
        } else {
            Log.log(`[order] useGTT=false for ${userId} but trade has no token (${trade.tsym}) - exit will not be monitored`);
        }
    }

    await bookkeeping.recordFill(trade);
}

export interface BuyIndexRequest {
    userId: string;
    mirror?: MirrorHook; // frontend manual buy only (see mirror.ts)
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
    // checked against live Kite positions (not local bookkeeping) so it's
    // correct across restarts regardless of which strike a prior entry used.
    skipIfOpenPositionType?: 'CE' | 'PE';
}

export async function buyIndexOnKite(req: BuyIndexRequest): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }

    const settings = configService.getConfig().settings;
    const targetPoints = req.targetPoints ?? bookkeeping.getUserTargetPoints(req.userId) ?? settings.targetPoints;
    const stopLossPoints = req.stopLossPoints ?? bookkeeping.getUserStopLossPoints(req.userId) ?? settings.stopLossPoints;
    const optionType = req.right === CALL ? 'CE' : 'PE';
    const index = req.index ?? 'NIFTY';

    if (req.skipIfOpenPositionType) {
        const positions = await kite.getPositions();
        const hasOpenPosition = (positions?.net || []).some(
            (p: any) => p.quantity !== 0 && p.exchange === 'NFO' && p.tradingsymbol?.endsWith(req.skipIfOpenPositionType)
        );
        if (hasOpenPosition) {
            throw new Error(`Skipping buy - a ${req.skipIfOpenPositionType} position is already open`);
        }
    }

    const entryStrike = AntContractMaster.getInstance().entryStrike(req.niftyLtp, optionType, index);
    const contract = req.strike && req.expiry
        ? await KiteContractMaster.getInstance().findExactOption(req.strike, req.expiry, optionType, index)
        : await KiteContractMaster.getInstance().findATMOption(entryStrike, optionType, index);
    const commonToken = req.strike && req.expiry
        ? AntContractMaster.getInstance().resolveCommonToken(index, optionType, { strike: req.strike, expiry: req.expiry })
        : AntContractMaster.getInstance().resolveCommonToken(index, optionType, { atmLtp: entryStrike });
    Log.log(`[order] Buying ${contract.tradingSymbol} qty=${req.quantity} for ${req.userId}`);

    req.mirror?.({ userId: req.userId, broker: 'kite', tsym: contract.tradingSymbol, token: commonToken, exchange: contract.exchange, quantity: req.quantity,
        place: (adminId, qty) => buyContractOnKite(adminId, contract.tradingSymbol, commonToken, qty, contract.exchange, targetPoints, stopLossPoints) });
    const buyPrice = await getMarketableKitePrice(commonToken, contract.exchange, 'BUY');
    const { orderId } = await kite.placeLimitBuyOption(contract.tradingSymbol, req.quantity, buyPrice, contract.exchange);
    const mkPartial = (qty: number, price: number): Trade => kiteFillTrade({ tsym: contract.tradingSymbol, token: commonToken, action: 'Buy', userId: req.userId, orderId: orderId, right: req.right }, qty, price);
    const entryPrice = await getFillBookingPartial(kite, orderId, mkPartial, (t) => finalizeEntry(t, req.userId, contract.exchange, targetPoints, stopLossPoints));
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
    trade.broker = 'kite';
    trade.brokerOrderId = orderId;

    await finalizeEntry(trade, req.userId, contract.exchange, targetPoints, stopLossPoints);
    return trade;
}

// /prism/order/buy's three branches, Kite-routed. `contract` (now a
// canonical symbol, e.g. "NIFTY_24100_CE" - see src/model/CanonicalSymbol.ts,
// not a raw broker tradingsymbol) takes precedence, resolved to the nearest
// expiry; else `strikePrice` selects an exact strike via
// KiteContractMaster.findATMOption; else it's the ATM auto-strike path
// (buyIndexOnKite above). Always resolved via Kite - no broker
// selection here. Once orders can route to other brokers, this is where a
// per-user broker lookup (extending bookkeeping's userSettingsCache) would
// decide which ContractMaster/executor to use instead of always Kite.
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
    mirror?: MirrorHook; // set by orderProcess for a frontend user's buy: the admin mirrors it (mirror.ts)
}

export async function manualBuyOnKite(req: ManualBuyRequest): Promise<Trade> {
    if (req.contract) {
        const canonical = parseCanonicalSymbol(req.contract);
        const resolved = await KiteContractMaster.getInstance().findNearestExpiryOption(canonical.strike, canonical.optionType, canonical.symbol);
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(canonical.symbol, canonical.optionType, { strike: canonical.strike });
        const price = await estimateOptionPrice(canonical.symbol, canonical.strike, canonical.optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, price, req.quantity);
        return buyContractOnKite(req.userId, resolved.tradingSymbol, commonToken, quantity, resolved.exchange, req.targetPoints, req.stopLossPoints, req.mirror);
    }

    if (!req.right) throw new Error('manualBuy requires either contract or right');

    const index = req.index ?? 'NIFTY';

    if (req.strikePrice) {
        const optionType = req.right === CALL ? 'CE' : 'PE';
        // findATMOption rounds its underlyingLtp arg to the nearest strike step -
        // strike prices are already multiples of that step, so feeding it the
        // strike directly lands exactly on it without needing a live NIFTY quote.
        const contract = await KiteContractMaster.getInstance().findATMOption(req.strikePrice, optionType, index);
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(index, optionType, { atmLtp: req.strikePrice });
        const price = await estimateOptionPrice(index, req.strikePrice, optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, contract.tradingSymbol, price, req.quantity);
        return buyContractOnKite(req.userId, contract.tradingSymbol, commonToken, quantity, contract.exchange, req.targetPoints, req.stopLossPoints, req.mirror);
    }

    const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(index);
    return buyIndexOnKite({ userId: req.userId, index: req.index, niftyLtp: await getSpotLtp(index), right: req.right, quantity, targetPoints: req.targetPoints, stopLossPoints: req.stopLossPoints, mirror: req.mirror });
}

async function buyContractOnKite(userId: string, tradingSymbol: string, commonToken: string, quantity: number, exchange: 'NFO' | 'BFO', targetPoints?: number, stopLossPoints?: number, mirror?: MirrorHook): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] Buying (manual) ${tradingSymbol} qty=${quantity} for ${userId}`);
    // The admin mirror starts now, in parallel with this order (it does not wait for the user's fill).
    mirror?.({ userId, broker: 'kite', tsym: tradingSymbol, token: commonToken, exchange, quantity,
        // The admin leg gets the user's RESOLVED exit points (request, else the user's own, else settings), not the admin's defaults.
        place: (adminId, qty) => buyContractOnKite(adminId, tradingSymbol, commonToken, qty, exchange,
            targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? configService.getConfig().settings.targetPoints,
            stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? configService.getConfig().settings.stopLossPoints) });
    const buyPrice = await getMarketableKitePrice(commonToken, exchange, 'BUY');
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    const mkPartial = (qty: number, px: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: commonToken, action: 'Buy', userId: userId, orderId: orderId }, qty, px);
    // Always wait for the real fill: a caller-supplied price used to skip this and book the order as filled at that price, so an
    // unfilled order left a phantom position with a GTT and an exit sell.
    const entryPrice = await getFillBookingPartial(kite, orderId, mkPartial, (t) =>
        finalizeEntry(
            t,
            userId,
            exchange,
            targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? configService.getConfig().settings.targetPoints,
            stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? configService.getConfig().settings.stopLossPoints
        )
    );

    const trade = new Trade();
    trade.tsym = tradingSymbol;
    trade.token = commonToken;
    trade.quantity = quantity;
    trade.price = entryPrice;
    trade.lastTradePrice = entryPrice;
    trade.action = 'Buy';
    trade.status = 'COMPLETE';
    trade.user = userId;
    trade.broker = 'kite';
    trade.brokerOrderId = orderId;

    const settings = configService.getConfig().settings;
    const finalTargetPoints = targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? settings.targetPoints;
    const finalStopLossPoints = stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? settings.stopLossPoints;
    await finalizeEntry(trade, userId, exchange, finalTargetPoints, finalStopLossPoints);
    return trade;
}

// POST /prism/settarget's Kite path: update bookkeeping's local target/SL
// fields and, if this trade has a live GTT (gttTriggerId), modify it in place.
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

    // A GTT always carries both legs, so both prices exist whenever one is attached.
    if (trade.gttTriggerId && trade.targetPrice !== undefined && trade.stopLossPrice !== undefined) {
        const kite = Kite.getInstance();
        const exchange = exchangeForTsym(trade.tsym);
        await kite.modifyTargetStopLossGTT(
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

export async function squareOffOnKite(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    // One exit operation per position at a time (shared with the ANT path): a duplicate call (manual
    // request racing exitMonitor, or a chunked caller's retry) must not place a second sell.
    const pendingKey = `kite:${userId}:${tsym}`;
    if (bookkeeping.pendingSquareOffs.has(pendingKey)) {
        throw new Error(`Square-off for ${tsym} is already in progress for ${userId}`);
    }
    bookkeeping.pendingSquareOffs.add(pendingKey);
    try {
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId}`);
        // ANT commonToken for pricing (see getMarketableKitePrice) - every open
        // Kite trade in bookkeeping.trades carries one, set at entry by every
        // buy path above.
        const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId && (t.broker ?? 'kite') === 'kite');
        if (!existing?.token) {
            throw new Error(`squareOffOnKite: no tracked open trade (with a token) found for ${tsym} (${userId}) - cannot price a marketable limit sell without it`);
        }
        const token = existing.token;

        // A resting limit sell for this position (e.g. BulkPcr's target exit) must come off before this
        // market-style sell, or both could fill and oversell. Each is cancelled with a fill recheck; a fill that
        // landed in the race window is still unbooked (the poller books it), so it's subtracted here.
        const openBefore = existing.quantity;
        let filledNotBooked = 0;
        let cancelledAny = false;
        for (const resting of findPendingOrdersForSymbol(userId, tsym).filter((o) => o.action === 'Sell')) {
            try {
                await cancelOrderOnKite(resting.orderId);
                cancelledAny = true;
            } catch (e) {
                if (e instanceof OrderAlreadyFilledError) filledNotBooked += e.filledQuantity;
                else throw e; // state of the resting sell unknown: selling now could double-sell
            }
        }
        if (filledNotBooked > 0 || openBefore !== existing.quantity) {
            quantity = Math.min(quantity, existing.quantity, openBefore - filledNotBooked);
        } else {
            quantity = Math.min(quantity, existing.quantity);
        }
        if (!(quantity > 0)) {
            Log.log(`[order] squareOffOnKite: nothing left to sell for ${tsym} (${userId}) after resting sells settled`);
            return emptyExitTrade(userId, tsym, 'kite');
        }

        let orderId: string;
        try {
            const sellPrice = await getMarketableKitePrice(token, exchange, 'SELL');
            const placed = await kite.placeLimitSellOption(tsym, quantity, sellPrice, exchange);
            orderId = placed.orderId;
            // The never-short guard may have clamped the sell: book what was actually placed.
            if (placed.quantity !== quantity) {
                Log.log(`[order] squareOffOnKite: sell for ${tsym} (${userId}) clamped ${quantity} -> ${placed.quantity} by the never-short guard`);
                quantity = placed.quantity;
            }
        } catch (e) {
            if (cancelledAny) Log.log(`[order] ALERT: resting sell(s) for ${tsym} (${userId}) were cancelled but the replacement sell failed - the position has no exit order until retried:`, e);
            throw e;
        }
        // Tracked until its fill is booked: if the fill wait below times out the order may still fill, and the
        // pending poller then books it instead of leaving the sale unrecorded.
        trackPendingLimitOrder({ orderId, userId, tradingSymbol: tsym, instrumentToken: token, quantity, exchange, action: 'Sell' });

        const trade = new Trade();
        trade.tsym = tsym;
        trade.token = token;
        trade.quantity = quantity;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        trade.broker = 'kite';
        trade.brokerOrderId = orderId;
        trade.price = await kite.getFillPrice(orderId);
        untrackPendingLimitOrder(orderId);

        await bookkeeping.recordFill(trade);
        return trade;
    } finally {
        bookkeeping.pendingSquareOffs.delete(pendingKey);
    }
}

// BrokerExecutor.buy() implementation (see BrokerExecutor.ts) - places a
// market buy for an already-resolved contract (caller did strike/expiry
// selection; buyIndexOnKite/manualBuyOnKite above do their own
// resolution before ever reaching a Trade), then finalizeEntry protects it
// (GTT or exitMonitor watch) when both target/stopLossPoints are set, or
// leaves it unprotected when they aren't - the same "bare" semantics
// marketBuyBareOnKite below hand-implements by skipping finalizeEntry
// entirely, unified here into one function since finalizeEntry already
// no-ops protection on its own when targetPoints/stopLossPoints are 0.
export async function buyResolvedOnKite(request: BuyRequest): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    // 'NSE' in Exchange is Breeze-only (Kite never trades NSE cash through
    // this path) - cast is safe, this dispatch only reaches here for
    // Kite-broker users.
    const exchange = request.exchange as 'NFO' | 'BFO';
    Log.log(`[order] Buying ${request.tradingSymbol} qty=${request.quantity} for ${request.userId} (BrokerExecutor.buy)`);
    // ANT.getQuote's own TTL cache means a chunked buy (buyChunked calling
    // this once per chunk, same request.brokerToken every time) naturally
    // reuses one ANT quote fetch across the whole chunk batch instead of one
    // per chunk.
    const buyPrice = await getMarketableKitePrice(request.brokerToken, exchange, 'BUY');
    // Shared by the full-fill path below and the partial-fill-on-drift-cancel
    // path in the catch block - both build an identical Trade shape, differing
    // only in quantity/price.
    const buildTrade = (quantity: number, price: number, orderId: string): Trade => {
        const trade = new Trade();
        trade.tsym = request.tradingSymbol;
        trade.token = request.brokerToken;
        trade.quantity = quantity;
        trade.price = price;
        trade.lastTradePrice = price;
        trade.action = 'Buy';
        trade.status = 'COMPLETE';
        trade.user = request.userId;
        trade.broker = 'kite';
        trade.brokerOrderId = orderId;
        return trade;
    };

    const { orderId } = await kite.placeLimitBuyOption(request.tradingSymbol, request.quantity, buyPrice, exchange);
    let entryPrice: number;
    try {
        entryPrice = await kite.getFillPrice(
            orderId,
            undefined,
            undefined,
            request.driftCancelPoints !== undefined
                ? {
                      limitPrice: buyPrice,
                      driftPoints: request.driftCancelPoints,
                      // skipCache: true - drift check needs a fresh LTP every
                      // poll, not ANT.getQuote's own cached snapshot (see its
                      // comment); otherwise this could compare the resting
                      // limit price against the exact same quote that set it.
                      getLtp: () => ANT.getInstance().getQuote(exchange, request.brokerToken, { skipCache: true }),
                  }
                : undefined
        );
    } catch (e: any) {
        // A drift-cancel can carry a genuine partial fill (Kite cancelled only
        // the remaining unfilled qty - see Kite.getFillPrice's driftCheck
        // block). That quantity is real money at the broker and must be
        // recorded the same way every other successful chunk is (finalizeEntry
        // -> bookkeeping.recordFill), or it becomes an untracked position with
        // no exit sizing for it (the exact gap flagged in code review). Still
        // rethrow afterward so buyChunked knows to stop placing further chunks
        // - the error already carries filledQuantity/averagePrice for
        // buyChunked to fold into its own running total.
        if (e?.driftCancelled && e.filledQuantity > 0) {
            const partialTrade = buildTrade(e.filledQuantity, e.averagePrice, orderId);
            await finalizeEntry(partialTrade, request.userId, exchange, request.targetPoints ?? 0, request.stopLossPoints ?? 0);
        }
        throw e;
    }

    const trade = buildTrade(request.quantity, entryPrice, orderId);

    await finalizeEntry(trade, request.userId, exchange, request.targetPoints ?? 0, request.stopLossPoints ?? 0);
    return trade;
}

// --- ContinuousStrategy bare execution primitives ---
// Deliberately bypass finalizeEntry (no GTT, no exitMonitor registration) -
// ContinuousStrategy self-monitors every leg's target/1x-5x thresholds from
// live option ticks instead. "Bare" = just buy/sell + record the fill.
// Left as its own separate path (not migrated onto buyResolvedOnKite
// above) rather than touching ContinuousStrategy's already-working, live
// call sites as part of this change - see the BrokerExecutor plan's
// migration notes.

export async function marketBuyBareOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare market buy ${tradingSymbol} qty=${quantity} for ${userId}`);
    // instrumentToken here is the ANT commonToken (LegManager's callers
    // always resolve it that way - live option ticks are keyed by ANT's
    // token, not Kite's own instrumentToken), which is what
    // getMarketableKitePrice needs to query ANT for a live quote.
    const buyPrice = await getMarketableKitePrice(instrumentToken, exchange, 'BUY');
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    // Tracked (persisted, owner-ledgered) from placement until its fill is booked: this call waits for the fill in-process, so an
    // order-process restart in that window used to lose the fill - a real broker position with no Buy doc, which reconcile can only
    // leave untracked (2026-10-28 10:06, NIFTY26N0322550PE). The pending poller books it after a restart; recordFill dedupes on
    // brokerOrderId, so it is booked once whichever side gets there first. Left tracked if the wait throws: the poller resolves it.
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange, action: 'Buy' });
    const mk = (qty: number, price: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: instrumentToken, action: 'Buy', userId: userId, orderId: orderId }, qty, price);
    const entryPrice = await getFillBookingPartial(kite, orderId, mk, (t) => bookkeeping.recordFill(t));
    const trade = mk(quantity, entryPrice);

    await bookkeeping.recordFill(trade);
    untrackPendingLimitOrder(orderId);
    return trade;
}

// Unlike squareOffOnKite, this sets trade.token - needed so tokenRouter's
// unregisterTrade (called from strategiesProcess.ts's onFill on every Sell
// fill) actually finds the right token to unsubscribe.
export async function marketSellBareOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    Log.log(`[order] Bare market sell ${tradingSymbol} qty=${quantity} for ${userId}`);
    const sellPrice = await getMarketableKitePrice(instrumentToken, exchange, 'SELL');
    const placed = await kite.placeLimitSellOption(tradingSymbol, quantity, sellPrice, exchange);
    const orderId = placed.orderId;
    // The never-short guard may have clamped the sell: book what was actually placed, not what was requested.
    if (placed.quantity !== quantity) {
        Log.log(`[order] marketSellBareOnKite: sell for ${tradingSymbol} (${userId}) clamped ${quantity} -> ${placed.quantity} by the never-short guard`);
        quantity = placed.quantity;
    }
    const mk = (qty: number, price: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: instrumentToken, action: 'Sell', userId: userId, orderId: orderId }, qty, price);
    const fillPrice = await getFillBookingPartial(kite, orderId, mk, (t) => bookkeeping.recordFill(t));
    const trade = mk(quantity, fillPrice);

    await bookkeeping.recordFill(trade);
    return trade;
}

// ButterflyStrategy's narrow sell-to-open exception ONLY - see Kite.ts's
// placeShortEntryOption/NEVER-SHORT GUARD comment. Mechanically mirrors
// marketSellBareOnKite exactly, but calls placeShortEntryOption (never
// placeLimitSellOption/getSellableQuantity) and records via
// bookkeeping.recordShortFill (never recordFill - see that function's own
// comment on why a plain Sell/Buy would be wrong here). Do not call this from
// any strategy other than ButterflyStrategy.
export async function enterShortOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] [BUTTERFLY] Short-entry (sell-to-open) ${tradingSymbol} qty=${quantity} for ${userId}`);
    const sellPrice = await getMarketableKitePrice(instrumentToken, exchange, 'SELL');
    const { orderId } = await kite.placeShortEntryOption(tradingSymbol, quantity, sellPrice, exchange);
    const mk = (qty: number, price: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: instrumentToken, action: 'SellToOpen', userId: userId, orderId: orderId }, qty, price);
    const fillPrice = await getFillBookingPartial(kite, orderId, mk, (t) => bookkeeping.recordShortFill(t));
    const trade = mk(quantity, fillPrice);

    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Closes a short opened by enterShortOnKite - a plain marketable LIMIT BUY via the
// EXISTING, unguarded placeLimitBuyOption (closing a short via a BUY has no guard to begin
// with - never needs a new broker-level primitive). Records via recordShortFill with
// action='BuyToClose' so bookkeeping's long-only Buy branch never mistakes this for a new
// long position. Do not call this from any strategy other than ButterflyStrategy.
export async function buyToCloseOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] [BUTTERFLY] Buy-to-close ${tradingSymbol} qty=${quantity} for ${userId}`);
    const buyPrice = await getMarketableKitePrice(instrumentToken, exchange, 'BUY');
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    const mk = (qty: number, price: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: instrumentToken, action: 'BuyToClose', userId: userId, orderId: orderId }, qty, price);
    const fillPrice = await getFillBookingPartial(kite, orderId, mk, (t) => bookkeeping.recordShortFill(t));
    const trade = mk(quantity, fillPrice);

    await bookkeeping.recordShortFill(trade);
    return trade;
}

// Places the limit order and returns immediately - does not wait for a fill
// (unlike the market-order primitives above). The fill arrives later via
// pollPendingLimitOrders -> bookkeeping.recordFill -> the normal fill-listener
// chain (IPC broadcast -> OrderClient.onFill -> strategy.updateTrade).
export async function placeLimitBuyBareOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string }> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare limit buy ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, price, exchange);
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange, action: 'Buy' });
    return { orderId };
}

// Returns immediately with {orderId} - fill arrives later via
// pollPendingLimitOrders, mirroring placeLimitBuyBareOnKite exactly but
// for a SELL leg. Used for a target-hit exit that must lock in a specific
// price - unlike squareOffOnKite (blind MARKET order, no price floor at
// all), a caller here controls exactly what price the position can close
// at; if the market never actually reaches it, the order simply rests
// rather than selling into a loss.
export async function placeLimitSellBareOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<{ orderId: string; quantity: number }> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    Log.log(`[order] Bare limit sell ${tradingSymbol} qty=${quantity} price=${price} for ${userId}`);
    const placed = await kite.placeLimitSellOption(tradingSymbol, quantity, price, exchange);
    const orderId = placed.orderId;
    // Track the quantity actually placed (the never-short guard may have clamped it) so the fill is booked correctly.
    trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity: placed.quantity, exchange, action: 'Sell' });
    return { orderId, quantity: placed.quantity };
}

// Cancels a resting limit order (e.g. ContinuousStrategy's root-refill drift-cancel
// check) and stops pollPendingLimitOrders from continuing to poll it.
//
// Re-checks status before untracking (mirrors the same addition in
// antExecutor.cancelOrderOnAnt/prismExecutor.cancelOrderOnPrism/
// breezeExecutor.cancelOrderOnBreeze, all via the shared
// cancelOrderWithFillRecheck - see its own comment in BrokerExecutor.ts) -
// the order can genuinely fill in the gap between our last poll and this
// cancel call, or the broker can ack the cancel even though it just filled.
// Untracking unconditionally in that case would silently drop the fill
// (pollPendingLimitOrders would never see it again to call
// bookkeeping.recordFill).
export async function cancelOrderOnKite(orderId: string): Promise<void> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    await cancelOrderWithFillRecheck({
        orderId,
        label: 'cancelOrderOnKite',
        cancel: () => kite.cancelOrder(orderId),
        // filled_quantity reflects the broker's true cumulative filled amount
        // regardless of the order's final status - correct for both a full
        // COMPLETE fill AND a partial-fill-then-CANCELLED record (confirmed
        // live elsewhere in this file - see Kite.getFillPrice's own
        // driftCheck recheck, which already trusts this same field). Checking
        // status === 'COMPLETE' alone (the old version) returned false for a
        // genuine partial fill, since Kite reports that as 'CANCELLED' - see
        // gaps.md's "Partial-fill accounting" entry. terminal mirrors
        // Kite.getFillPrice's own terminal-status check - COMPLETE/
        // CANCELLED/REJECTED are all final, anything else (OPEN etc.) means
        // the order can still fill further.
        isFilled: async () => {
            const history = await kite.getKiteConnect().getOrderHistory(orderId);
            const latest = history[history.length - 1];
            return {
                filledQuantity: Number(latest?.filled_quantity ?? 0),
                terminal: latest?.status === 'COMPLETE' || latest?.status === 'CANCELLED' || latest?.status === 'REJECTED',
            };
        },
        untrack: () => untrackPendingLimitOrder(orderId),
        beginCancel: () => beginCancelOfPendingLimitOrders(orderId),
        endCancel: () => endCancelOfPendingLimitOrders(orderId),
        silenceListeners: () => silenceListenersOfPendingLimitOrders(orderId),
    });
}

// Kite-side premium-range strike lookup (mirrors Prism.getContractByPriceRange's
// OTM-then-ITM strike-walk shape - src/prism.ts:666-721), but sources the
// tradable contract from KiteContractMaster (CSV-backed, no live premium
// data) and the live premium from the ANT cross-reference (estimateOptionPrice)
// since this account's Kite quote API 403s. Floor-only check (no upper
// bound) - unlike Prism's min/max range, a ContinuousStrategy leg can move up
// to 5x its SL distance further from its own entry, so headroom above the
// floor is wanted, not capped.
//
// Premiums for every candidate strike are fetched in ONE batched ANT call
// (estimateOptionPricesBatch) rather than one estimateOptionPrice call per
// candidate in the walk loop - AliceBlue's OHLC endpoint rate-limits (429)
// after just 1-2 rapid sequential calls (confirmed live), which silently
// starved out real, qualifying candidates when this walked one-at-a-time.
export async function getContractByPriceRangeOnKite(
    underlyingLtp: number,
    optionType: 'CE' | 'PE',
    index: 'NIFTY' | 'SENSEX' = 'NIFTY',
    minPremium = 100,
    excludeStrikes: Set<number> = new Set(),
    skipNearestExpiryDay?: boolean
): Promise<{ tradingSymbol: string; instrumentToken: number; lotSize: number; exchange: 'NFO' | 'BFO'; strike: number; premium: number; antToken: string }> {
    return pickContractByPremium(underlyingLtp, optionType, index, minPremium, excludeStrikes, (strike) =>
        KiteContractMaster.getInstance().findNearestExpiryOption(strike, optionType, index, 0, skipNearestExpiryDay), skipNearestExpiryDay);
}

// exitMonitor calls this when a useGTT=false trade crosses target/SL. Wired
// here (rather than exitMonitor importing squareOffOnKite directly) to
// avoid a circular import between the two modules.
exitMonitor.onExit('kite', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnKite(trade.user, trade.tsym, trade.quantity, exchange);
});

// exitMonitor calls this ONCE when its squareoff was refused because Kite holds nothing sellable (the broker's GTT already sold the
// position): look for / adopt the GTT and book its fill now instead of waiting for the next 60 s poll.
exitMonitor.onExitResolve('kite', async (trade: Trade) => {
    // A poll already in flight may have read the GTT list before this squareoff was refused: wait for it, then poll again with this contract flagged.
    for (let i = 0; i < 20 && gttPollInFlight; i++) await new Promise((r) => setTimeout(r, 500));
    gttAdoptNow.add(trade.tsym);
    await pollGttFills();
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
let gttPollInFlight = false;

// Writes a GTT id onto the newest Buy document of this position in Mongo. The document is inserted at the fill, BEFORE a post-fill
// protection (attachProtection) places its GTT, so without this a restart restores the row with no gttTriggerId: exitMonitor then arms an
// ACTIVE self squareoff next to the broker's GTT and pollGttFills never looks at that GTT (live 2026-11-12 10:04-10:12: the stop fired at the
// broker and here, and the fill was not booked for over 80 s). Fire-and-forget; one retry because the Buy insert may still be in flight.
export function persistGttTriggerId(trade: Trade): void {
    const id = trade.gttTriggerId;
    const db = Mongo.getInstance()?.db;
    if (id == null || !db || !trade.tsym) return;
    const filter = { tsym: trade.tsym, user: trade.user, action: 'Buy', $or: [{ broker: 'kite' }, { broker: { $exists: false } }] };
    const attempt = async (): Promise<boolean> => {
        const r = await db.collection('Trade').findOneAndUpdate(filter, { $set: { gttTriggerId: id } }, { sort: { entryTime: -1 } });
        return !!r?.value;
    };
    attempt()
        .then((hit) => hit ? true : new Promise<boolean>((res) => setTimeout(() => attempt().then(res, () => res(false)), 2500)))
        .then((hit) => { if (!hit) Log.log(`[order] ALERT: could not store GTT ${id} on the Buy document of ${trade.tsym} (${trade.user}) - a restart before the GTT poll adopts it would not know about it`); })
        .catch((e) => Log.log(`[order] persisting GTT ${id} for ${trade.tsym} failed:`, e));
}

// Healing for a position whose GTT id is unknown (restored from Mongo without it, or lost): look for ONE live broker GTT on the same
// contract with the same quantity that no other row already owns, and adopt it. Tried once per row (plus on demand when a squareoff is
// refused as nothing-sellable), so a position that never had a GTT does not cost a broker read every poll.
const gttAdoptTried = new Set<string>();
const gttAdoptNow = new Set<string>(); // tsyms a refused squareoff asked to re-check
function adoptKey(t: Trade): string { return `${t.user}|${t.tsym}|${t.quantity}`; }
function needsGttAdoption(t: Trade): boolean {
    return (t.broker ?? 'kite') === 'kite' && t.gttTriggerId == null && t.quantity > 0 && !!t.token
        && (t.targetPrice != null || t.stopLossPrice != null) && bookkeeping.getUserUseGTT(t.user)
        && (!gttAdoptTried.has(adoptKey(t)) || gttAdoptNow.has(t.tsym));
}
function adoptUntrackedGtts(liveGtts: any[]): void {
    const owned = new Set<any>();
    for (const t of bookkeeping.trades) {
        if (t.gttTriggerId != null) owned.add(t.gttTriggerId);
        for (const x of t.extraGttTriggerIds ?? []) owned.add(x);
    }
    for (const t of bookkeeping.trades.filter(needsGttAdoption)) {
        gttAdoptTried.add(adoptKey(t));
        const matches = liveGtts.filter((g: any) => g?.condition?.tradingsymbol === t.tsym && (g.status === 'active' || g.status === 'triggered')
            && !owned.has(g.id) && Number(g.orders?.[0]?.quantity) === t.quantity);
        if (matches.length !== 1) {
            if (matches.length > 1) Log.log(`[order] ALERT: ${matches.length} live GTTs fit ${t.tsym} (${t.user}) qty ${t.quantity} - not adopting any; check the broker's GTT list by hand`);
            continue;
        }
        t.gttTriggerId = matches[0].id;
        owned.add(matches[0].id);
        persistGttTriggerId(t);
        Log.log(`[order] GTT poll: adopted live GTT ${matches[0].id} (${matches[0].status}) for ${t.tsym} (${t.user}) - broker owns its exit, exitMonitor watch-only`);
        if (matches[0].status === 'active' && t.token) exitMonitor.registerTrade(t, exchangeForTsym(t.tsym), 'kite', true);
    }
}
// Consecutive polls in which a trade's GTT was absent from the broker's list.
const gttMissCount = new Map<string, number>();
const GTT_MISSING_FALLBACK_POLLS = 3;
const GTT_DEAD_STATUSES = new Set(['disabled', 'expired', 'cancelled', 'rejected', 'deleted']);

export async function pollGttFills(): Promise<void> {
    if (gttPollInFlight) return;
    gttPollInFlight = true;
    try {
        await pollGttFillsOnce();
    } finally {
        gttPollInFlight = false;
    }
}

async function pollGttFillsOnce(): Promise<void> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) return;

    if (bookkeeping.trades.every((t) => t.gttTriggerId == null) && !bookkeeping.trades.some(needsGttAdoption)) return;

    const liveGtts: any[] = await kite.getGTTs();
    adoptUntrackedGtts(liveGtts);
    gttAdoptNow.clear();
    const openGttTrades = bookkeeping.trades.filter((t) => t.gttTriggerId != null);
    if (openGttTrades.length === 0) return;
    const byId = new Map<any, any>(liveGtts.map((g: any) => [g.id, g]));

    for (const trade of openGttTrades) {
        const gtt = byId.get(trade.gttTriggerId);
        if (!gtt) {
            const missKey = String(trade.gttTriggerId);
            const misses = (gttMissCount.get(missKey) ?? 0) + 1;
            gttMissCount.set(missKey, misses);
            if (misses < GTT_MISSING_FALLBACK_POLLS) {
                Log.log(`[order] GTT poll: GTT ${trade.gttTriggerId} for ${trade.tsym} (${trade.user}) not in the broker's list (${misses}/${GTT_MISSING_FALLBACK_POLLS}) - leaving the position as is for now`);
                continue;
            }
            gttMissCount.delete(missKey);
            Log.log(`[order] ALERT: GTT ${trade.gttTriggerId} for ${trade.tsym} (${trade.user}) missing from the broker for ${misses} polls - falling back to in-app target/SL monitoring`);
            trade.gttTriggerId = undefined;
            if (trade.token && (trade.targetPrice != null || trade.stopLossPrice != null)) {
                exitMonitor.registerTrade(trade, exchangeForTsym(trade.tsym), 'kite');
            }
            continue;
        }
        gttMissCount.delete(String(trade.gttTriggerId));
        if (gtt.status === 'active') continue; // still live, not closed

        if (GTT_DEAD_STATUSES.has(gtt.status)) {
            // Cancelled/expired/disabled: nothing was sold. Recording a sell here would be a phantom exit. The GTT no
            // longer protects the position, so drop the reference and fall back to in-app target/SL monitoring.
            Log.log(`[order] ALERT: GTT ${trade.gttTriggerId} for ${trade.tsym} (${trade.user}) is '${gtt.status}', not triggered - position still open; falling back to in-app target/SL monitoring`);
            trade.gttTriggerId = undefined;
            if (trade.token && (trade.targetPrice != null || trade.stopLossPrice != null)) {
                const exchange: 'NFO' | 'BFO' = exchangeForTsym(trade.tsym);
                exitMonitor.registerTrade(trade, exchange, 'kite');
            }
            continue;
        }
        if (gtt.status !== 'triggered') continue; // unknown status: act only on a confirmed trigger

        try {
            const orders = await kite.getKiteConnect().getOrders();
            const entryMs = trade.entryTime ? new Date(trade.entryTime).getTime() : 0;
            const sellFill = (orders as any[])
                .filter((o: any) => o.tradingsymbol === trade.tsym && o.transaction_type === 'SELL' && o.status === 'COMPLETE' && new Date(o.order_timestamp).getTime() >= entryMs)
                .sort((a: any, b: any) => new Date(b.order_timestamp).getTime() - new Date(a.order_timestamp).getTime())[0];
            if (!sellFill) {
                // Triggered but the exit order isn't COMPLETE yet (or not visible): retry next poll rather than
                // booking a guessed exit.
                Log.log(`[order] GTT poll: ${trade.tsym} (${trade.user}) GTT triggered but no completed sell order yet - will retry`);
                continue;
            }

            const sellTrade = new Trade();
            sellTrade.tsym = trade.tsym;
            sellTrade.token = trade.token;
            sellTrade.quantity = Math.min(trade.quantity, Number(sellFill.filled_quantity) > 0 ? Number(sellFill.filled_quantity) : trade.quantity);
            sellTrade.price = sellFill.average_price;
            sellTrade.action = 'Sell';
            sellTrade.status = 'COMPLETE';
            sellTrade.user = trade.user;
            sellTrade.broker = 'kite';
            sellTrade.brokerOrderId = sellFill.order_id; // dedupes against reconcileManualSells seeing the same order

            // The GTT itself sold: clear the id first so booking this sell does not try to delete the trigger that just fired.
            const firedId = trade.gttTriggerId;
            trade.gttTriggerId = undefined;
            if (sellTrade.brokerOrderId) bookkeeping.brokerOwnedExitOrderIds.add(String(sellTrade.brokerOrderId));
            try {
                await bookkeeping.recordFill(sellTrade);
            } catch (e) {
                trade.gttTriggerId = firedId;
                throw e;
            }
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
let manualSellsInFlight = false;
export async function reconcileManualSells(): Promise<void> {
    if (manualSellsInFlight) return;
    manualSellsInFlight = true;
    try {
        await reconcileManualSellsOnce();
    } finally {
        manualSellsInFlight = false;
    }
}

// Orders placed in the Kite app (or anywhere else outside this platform) are NOT this platform's: they are never booked, never stored in
// Mongo and never attributed to a strategy (user's rule, 2026-11-03). Before this, a foreign sell on a contract a strategy held was
// booked under that strategy's user by contract name alone: it fabricated an orderOwners row, closed the strategy's leg at the foreign
// price and distorted its P&L. All that remains is a log ALERT, once per order, when a foreign sell touches a contract a tracked leg
// holds - the strategy's own view of that leg may then be stale.
const FOREIGN_SELL_GRACE_MS = 2 * 60_000; // a GTT-triggered exit is booked by pollGttFills shortly after it fills; give that time to claim it
const foreignSellAlerted = new Set<string>();

async function reconcileManualSellsOnce(): Promise<void> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) return;
    if (bookkeeping.trades.length === 0) return;

    let orders: any[];
    try {
        orders = await kite.getKiteConnect().getOrders();
    } catch (e) {
        Log.log('[order] reconcileManualSells: failed to fetch orders:', e);
        return;
    }

    const heldTsyms = new Set(bookkeeping.trades.filter((t) => (t.broker ?? 'kite') === 'kite').map((t) => t.tsym));
    const candidates = orders.filter((o: any) =>
        o.transaction_type === 'SELL' && o.status === 'COMPLETE' && heldTsyms.has(o.tradingsymbol) &&
        !foreignSellAlerted.has(String(o.order_id)) &&
        Date.now() - new Date(o.order_timestamp).getTime() >= FOREIGN_SELL_GRACE_MS &&
        !kite.isOwnOrder(o.order_id) && !isTrackedPendingOrder(o.order_id)
    );
    if (candidates.length === 0) return;
    // The persistent ownership ledger (written when this platform places or books an order) survives a restart, unlike isOwnOrder.
    const owners = await loadOrderOwners(candidates.map((o: any) => String(o.order_id)));
    for (const o of candidates) {
        const id = String(o.order_id);
        if (owners.has(id)) continue;
        foreignSellAlerted.add(id);
        Log.log(`[order] ALERT: Kite SELL ${o.tradingsymbol} qty=${o.filled_quantity} @ ${o.average_price} (order ${id}) was not placed by this platform - NOT booked or stored; a tracked leg on this contract may now be stale`);
    }
}
