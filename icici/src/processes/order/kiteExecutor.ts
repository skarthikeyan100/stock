import type { MirrorHook } from './mirror';
import Log from '../../util/Log';
import { getSpotLtp } from './spotQuote';
import Kite from '../../kite/Kite';
import { roundToTick } from '../../util/tick';
import KiteContractMaster from '../../kite/KiteContractMaster';
import AntContractMaster from '../../ant/AntContractMaster';
import { orderPriceOf } from './orderPrice';
import ANT from '../../ant/ANT';
import configService from '../../prism/ConfigService';
import { Trade } from '../../model/model';
import { CALL } from '../../constants';
import { parseCanonicalSymbol } from '../../model/CanonicalSymbol';
import bookkeeping from './bookkeeping';
import { pickContractByPremium } from './priceRangeContract';
import * as exitMonitor from './exitMonitor';
import { estimateOptionPrice, estimateOptionPricesBatch } from './antExecutor';
import { trackPendingLimitOrder, untrackPendingLimitOrder, findPendingOrdersForSymbol, isTrackedPendingOrder, beginCancelOfPendingLimitOrders, endCancelOfPendingLimitOrders, silenceListenersOfPendingLimitOrders, awaitKiteBuy } from './pendingLimitOrders';
import { BUY_FILL_WAIT } from '../../util/fillWait';
import { BuyRequest, cancelOrderWithFillRecheck, OrderAlreadyFilledError, emptyExitTrade } from './BrokerExecutor';
import { exchangeForTsym } from '../../util/underlyings';
import { loadOrderOwners, recordOrderOwner } from './orderOwners';
import { ownerSellCap } from './neverShortClass';
import Mongo from '../../tools/mongo';
import { lossBudgetStopPrice } from '../../levelLimits';
import { registerEntryExit } from './entryExits';
import { manualBuyChunked, squareOffAutoChunked, defaultFreezeQty } from './chunkedOrder';
import { releaseGttsForSell, watchInApp, withGttSellLock, acquireGttSellLock, markKiteSelling, kiteSellBusy, modifyPositionGtts } from './gttRelease';
import type { Trade as TradeRow } from '../../model/model';

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
// `waitMs`: a buy's longer wait (BUY_FILL_WAIT); omitted (sells, exits) = Kite.getFillPrice's own default.
async function getFillBookingPartial(kite: Kite, orderId: string, mk: (qty: number, price: number) => Trade, record: (t: Trade) => Promise<unknown>, waitMs?: number): Promise<number> {
    try {
        return await (waitMs ? kite.getFillPrice(orderId, undefined, undefined, undefined, waitMs) : kite.getFillPrice(orderId));
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
// SELL only (stop / EOD / square-off exits): every BUY and every intended-market SELL is priced by the central order price (orderPrice.ts).
async function getMarketableKitePrice(antToken: string, exchange: 'NFO' | 'BFO', direction: 'SELL'): Promise<number> {
    // Live bid/ask first (the cached OHLC getQuote lags a fast option by a minute or more - see
    // ANT.getLiveQuote); fall back to getQuote if the live call fails (e.g. a 429).
    let ltp: number;
    try {
        const live = await ANT.getInstance().getLiveQuote(exchange, antToken);
        // The price a taker actually crosses on a sell: the bid (never worse than LTP).
        ltp = live.bid > 0 ? Math.min(live.ltp, live.bid) : live.ltp;
    } catch (e) {
        Log.log(`[order] getMarketableKitePrice: live quote failed for ${exchange}|${antToken}, falling back to cached getQuote:`, e);
        ltp = await ANT.getInstance().getQuote(exchange, antToken);
    }
    // Buffer beyond LTP: aggressive enough to fill immediately, not a resting order waiting for a
    // specific price. 5% (was 1%, then 3%): ANT's REST quote lags a fast-moving expiry-day option by 3-4 points
    // (an 88 quote vs a 91 market at 12:30 on 2026-10-19), so even a 3% cap sat below the ask and 'did not fill
    // within timeout' about once a minute. Kite fills a marketable limit at the best available price, so a wider
    // cap costs no extra slippage.
    const buffered = ltp * 0.95;
    return roundToTick(buffered);
}

// Shared by every entry path (index-ATM and manual/strike/contract): computes
// target/SL from points, then places a GTT or registers with exitMonitor
// depending on the placing user's useGTT setting, before recording the fill.
// `inAppExit`: one of several chunks of a split manual buy - no per-chunk GTT (see chunkedOrder.manualBuyChunked), the in-app exit monitor owns the exit.
async function finalizeEntry(trade: Trade, userId: string, exchange: 'NFO' | 'BFO', targetPoints: number, stopLossPoints: number, inAppExit = false): Promise<void> {
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

        if (bookkeeping.getUserUseGTT(userId) && !inAppExit) {
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
    const buyPrice = await orderPriceOf({ side: 'BUY', tsym: contract.tradingSymbol, token: String(commonToken), exchange: contract.exchange, broker: 'kite' });
    const { orderId } = await kite.placeLimitBuyOption(contract.tradingSymbol, req.quantity, buyPrice, contract.exchange);
    const mkPartial = (qty: number, price: number): Trade => kiteFillTrade({ tsym: contract.tradingSymbol, token: commonToken, action: 'Buy', userId: req.userId, orderId: orderId, right: req.right }, qty, price);
    return awaitKiteBuy({ orderId, userId: req.userId, tradingSymbol: contract.tradingSymbol, instrumentToken: String(commonToken), quantity: req.quantity, exchange: contract.exchange }, async () => {
        const entryPrice = await getFillBookingPartial(kite, orderId, mkPartial, (t) => finalizeEntry(t, req.userId, contract.exchange, targetPoints, stopLossPoints), BUY_FILL_WAIT.ms);
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
    });
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
    /** A resting LIMIT entry at exactly this price (a contractor's recommendation), with target/stop attached on the fill. `contract` only. Returns {orderId}, not a Trade. */
    limitPrice?: number;
    /** Contractors only: the rupees this order may use (see bookkeeping.resolveManualBuyQuantity). */
    contractorBudget?: { amount: number; strict?: boolean };
}

/** Places a resting limit buy at `limitPrice` for `userId` and records its target/stop (absolute: limit + targetPoints, limit - stopLossPoints) to attach on the fill. */
async function restingLimitBuyOnKite(userId: string, tsym: string, token: string, qty: number, exchange: 'NFO' | 'BFO', limitPrice: number, targetPoints: number | undefined, stopLossPoints: number | undefined): Promise<{ orderId: string }> {
    const targetPrice = roundToTick(limitPrice + (targetPoints ?? 0)), stopLossPrice = roundToTick(limitPrice - (stopLossPoints ?? 0));
    if (!(stopLossPrice > 0 && stopLossPrice < limitPrice && limitPrice < targetPrice)) throw new Error(`resting entry needs 0 < stop < limit < target (stop=${stopLossPrice}, limit=${limitPrice}, target=${targetPrice})`);
    const placed = await placeLimitBuyBareOnKite(userId, tsym, token, qty, limitPrice, exchange);
    try {
        await registerEntryExit({ userId, orderId: placed.orderId, tsym, token, exchange, broker: 'kite', targetPrice, stopLossPrice });
    } catch (e) {
        // The order is live but its exits could not be recorded: take it back rather than leave a position that would have none.
        await cancelOrderOnKite(placed.orderId).catch((ce) => Log.log(`[order] ALERT: resting entry ${placed.orderId} (${tsym}, ${userId}) could not be cancelled after its exits failed to record - cancel it by hand:`, ce));
        throw e;
    }
    Log.log(`[order] resting limit entry ${tsym} qty=${qty} @ ${limitPrice} for ${userId} (target ${targetPrice}, stop ${stopLossPrice} on fill)`);
    return placed;
}

export async function manualBuyOnKite(req: ManualBuyRequest): Promise<Trade | { orderId: string; resting: true; tsym: string; quantity: number; limitPrice: number }> {
    if (req.limitPrice !== undefined) {
        if (!req.contract) throw new Error('a limit entry needs a contract');
        if (!(req.limitPrice > 0)) throw new Error('limitPrice must be positive');
        const canonical = parseCanonicalSymbol(req.contract);
        const resolved = await KiteContractMaster.getInstance().findNearestExpiryOption(canonical.strike, canonical.optionType, canonical.symbol);
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(canonical.symbol, canonical.optionType, { strike: canonical.strike });
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, req.limitPrice, req.quantity, resolved.lotSize, req.stopLossPoints, req.contractorBudget, true, 'kite');
        const placed = await restingLimitBuyOnKite(req.userId, resolved.tradingSymbol, commonToken, quantity, resolved.exchange, req.limitPrice, req.targetPoints, req.stopLossPoints);
        // The mirror starts only once the user's own order is in (a resting order cannot be "undone" like a fill): the admin rests the same limit with the same exits.
        req.mirror?.({ userId: req.userId, broker: 'kite', tsym: resolved.tradingSymbol, token: commonToken, exchange: resolved.exchange, quantity, resting: true,
            place: (adminId, qty) => restingLimitBuyOnKite(adminId, resolved.tradingSymbol, commonToken, qty, resolved.exchange, req.limitPrice as number, req.targetPoints, req.stopLossPoints) });
        return { orderId: placed.orderId, resting: true, tsym: resolved.tradingSymbol, quantity, limitPrice: req.limitPrice };
    }
    if (req.contract) {
        const canonical = parseCanonicalSymbol(req.contract);
        const resolved = await KiteContractMaster.getInstance().findNearestExpiryOption(canonical.strike, canonical.optionType, canonical.symbol);
        const commonToken = AntContractMaster.getInstance().resolveCommonToken(canonical.symbol, canonical.optionType, { strike: canonical.strike });
        const price = await estimateOptionPrice(canonical.symbol, canonical.strike, canonical.optionType);
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, resolved.tradingSymbol, price, req.quantity, resolved.lotSize, req.stopLossPoints, req.contractorBudget, false, 'kite');
        const stopPoints = bookkeeping.lossBudgetStopPoints(req.userId, 'kite', resolved.tradingSymbol, quantity, price, req.stopLossPoints, req.quantity);
        return buyContractOnKite(req.userId, resolved.tradingSymbol, commonToken, quantity, resolved.exchange, req.targetPoints, stopPoints, req.mirror);
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
        const quantity = bookkeeping.resolveManualBuyQuantity(req.userId, contract.tradingSymbol, price, req.quantity, contract.lotSize, req.stopLossPoints, req.contractorBudget, false, 'kite');
        const stopPoints = bookkeeping.lossBudgetStopPoints(req.userId, 'kite', contract.tradingSymbol, quantity, price, req.stopLossPoints, req.quantity);
        return buyContractOnKite(req.userId, contract.tradingSymbol, commonToken, quantity, contract.exchange, req.targetPoints, stopPoints, req.mirror);
    }

    // Index-ATM path: resolve the entry strike every broker shares (ANT-sourced spot), then size and enter exactly like the strike branch
    // above (findATMOption on a listed strike lands on it), so investmentAmount sizing applies here too - it used to default to one lot.
    const optionType = req.right === CALL ? 'CE' : 'PE';
    const entryStrike = AntContractMaster.getInstance().entryStrike(await getSpotLtp(index), optionType, index);
    return manualBuyOnKite({ ...req, strikePrice: entryStrike, index });
}

// A manual buy, split into freeze-sized orders when it is larger than one (chunkedOrder.manualBuyChunked). The admin mirror starts ONCE with the
// whole quantity (its own order is split the same way through `place`), then the user's chunks are placed one after another.
async function buyContractOnKite(userId: string, tradingSymbol: string, commonToken: string, quantity: number, exchange: 'NFO' | 'BFO', targetPoints?: number, stopLossPoints?: number, mirror?: MirrorHook): Promise<Trade> {
    if (!(await Kite.getInstance().hasValidSession())) {
        throw new Error('Kite session not active - complete /kite/login first.');
    }
    // The admin mirror starts now, in parallel with this order (it does not wait for the user's fill).
    mirror?.({ userId, broker: 'kite', tsym: tradingSymbol, token: commonToken, exchange, quantity,
        // The admin leg gets the user's RESOLVED exit points (request, else the user's own, else settings), not the admin's defaults.
        place: (adminId, qty) => buyContractOnKite(adminId, tradingSymbol, commonToken, qty, exchange,
            targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? configService.getConfig().settings.targetPoints,
            stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? configService.getConfig().settings.stopLossPoints) });
    return manualBuyChunked({
        label: 'manualBuyChunked', userId, tradingSymbol, exchange, quantity,
        placeOne: (qty, inAppExit) => buyOneContractOnKite(userId, tradingSymbol, commonToken, qty, exchange, targetPoints, stopLossPoints, inAppExit),
        onBooked: () => exitMonitor.watchAggregate(userId, tradingSymbol, commonToken, exchange, 'kite'),
        afterBook: () => { bookkeeping.tightenStopToLossBudget(userId, 'kite', tradingSymbol); void reprotectAfterBuy(userId, tradingSymbol); },
    });
}

async function buyOneContractOnKite(userId: string, tradingSymbol: string, commonToken: string, quantity: number, exchange: 'NFO' | 'BFO', targetPoints: number | undefined, stopLossPoints: number | undefined, inAppExit: boolean): Promise<Trade> {
    const kite = Kite.getInstance();
    Log.log(`[order] Buying (manual) ${tradingSymbol} qty=${quantity} for ${userId}`);
    const buyPrice = await orderPriceOf({ side: 'BUY', tsym: tradingSymbol, token: String(commonToken), exchange, broker: 'kite' });
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    const mkPartial = (qty: number, px: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: commonToken, action: 'Buy', userId: userId, orderId: orderId }, qty, px);
    return awaitKiteBuy({ orderId, userId, tradingSymbol, instrumentToken: String(commonToken), quantity, exchange }, async () => {
        // Always wait for the real fill: a caller-supplied price used to skip this and book the order as filled at that price, so an
        // unfilled order left a phantom position with a GTT and an exit sell.
        const entryPrice = await getFillBookingPartial(kite, orderId, mkPartial, (t) =>
            finalizeEntry(
                t,
                userId,
                exchange,
                targetPoints ?? bookkeeping.getUserTargetPoints(userId) ?? configService.getConfig().settings.targetPoints,
                stopLossPoints ?? bookkeeping.getUserStopLossPoints(userId) ?? configService.getConfig().settings.stopLossPoints,
                inAppExit
            ), BUY_FILL_WAIT.ms
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
        await finalizeEntry(trade, userId, exchange, finalTargetPoints, finalStopLossPoints, inAppExit);
        return trade;
    });
}

// A restart restores a position's target / stop from its newest Buy document (bookkeeping.restoreOpenTradesForTsym): an edit is stored there.
function persistExitLevels(trade: Trade): void {
    const db = Mongo.getInstance()?.db;
    const broker = trade.broker ?? 'kite';
    if (!db || !trade.tsym || broker === 'paper') return;
    const fields = { ...(trade.targetPrice != null ? { targetPrice: trade.targetPrice } : {}), ...(trade.stopLossPrice != null ? { stopLossPrice: trade.stopLossPrice } : {}) };
    const filter = { tsym: trade.tsym, user: trade.user, action: 'Buy', ...(broker === 'kite' ? { $or: [{ broker: 'kite' }, { broker: { $exists: false } }] } : { broker }) };
    const attempt = async (): Promise<boolean> => !!(await db.collection('Trade').findOneAndUpdate(filter, { $set: fields }, { sort: { entryTime: -1 } }))?.value;
    attempt()
        .then((hit) => hit ? true : new Promise<boolean>((res) => setTimeout(() => attempt().then(res, () => res(false)), 2500)))
        .then((hit) => { if (!hit) Log.log(`[order] ALERT: could not store the target / stop of ${trade.tsym} (${trade.user}) on its Buy document - a restart would restore the previous levels`); })
        .catch((e) => Log.log(`[order] ALERT: storing the target / stop of ${trade.tsym} (${trade.user}) failed - a restart would restore the previous levels:`, e));
}

// POST /prism/settarget's Kite path: update bookkeeping's local target/SL
// fields and, if this trade has a live GTT (gttTriggerId), modify it in place.
export async function setTargetStopLoss(userId: string, token: string, targetPoints: number, stopLossPoints: number, broker?: string): Promise<void> {
    // A token can be open on several brokers for one user (independent legs): without `broker` every leg is updated, with it only that one.
    const legs = bookkeeping.trades.filter((t) => t.token === token && t.user === userId && (!broker || (t.broker ?? 'kite') === broker));
    if (legs.length === 0) throw new Error(`No open trade for token ${token} and user ${userId}${broker ? ` on ${broker}` : ''}`);
    const failures: string[] = [];
    for (const leg of legs) {
        try { await setTargetStopLossOnLeg(leg, targetPoints, stopLossPoints); }
        catch (e: any) { if (legs.length === 1) throw e; failures.push(`${leg.broker ?? 'kite'}: ${e?.message ?? e}`); }
    }
    if (failures.length > 0) throw new Error(`setTargetStopLoss failed on ${failures.join('; ')}`);
}

async function setTargetStopLossOnLeg(trade: Trade, targetPoints: number, stopLossPoints: number): Promise<void> {

    // 0 / missing / non-numeric means "leave that side unset" (the UI may set only one side). Without this a 0 became
    // price -/+ 0 = the entry price, i.e. an exit at the first tick.
    const hasTarget = Number.isFinite(targetPoints) && targetPoints > 0;
    const hasStop = Number.isFinite(stopLossPoints) && stopLossPoints > 0;
    if (!hasTarget && !hasStop) throw new Error('setTargetStopLoss: targetPoints and/or stopLossPoints must be a positive number');
    // An ANT bracket/cover keeps the levels it was placed with at the broker and cannot be modified here: refuse instead of showing levels nothing enforces.
    if (trade.broker === 'ant' && trade.antOrderNo) throw new Error(`setTargetStopLoss: ${trade.tsym} is an ANT bracket/cover position - its target/stop live at the broker and cannot be changed here`);
    const target = hasTarget ? trade.price + targetPoints : trade.targetPrice;
    let stop = hasStop ? trade.price - stopLossPoints : trade.stopLossPrice;
    // A frontend position's stop is never looser than the per-trade loss budget (as after a buy: bookkeeping.tightenStopToLossBudget).
    const budget = trade.strategy ? undefined : bookkeeping.lossBudgetFor(trade.user);
    if (hasStop && budget !== undefined) {
        const need = lossBudgetStopPrice(budget, trade.quantity, trade.price);
        if (need !== undefined && stop! < need - 1e-9) {
            Log.log(`[order] loss budget ${Math.round(budget)}: the stop ${stop} asked for ${trade.tsym} (${trade.user}) is held at ${need}`);
            stop = need;
        }
    }
    // A side sent with its current level (within half a tick: the page sends both, in points rounded to paise) is not a change.
    const differs = (next: number, now: number | undefined) => now == null || Math.abs(next - now) > 0.025;
    const targetChanged = hasTarget && differs(target!, trade.targetPrice);
    const stopChanged = hasStop && differs(stop!, trade.stopLossPrice);
    const last = Number(trade.lastTradePrice);
    if (last > 0 && stopChanged && stop! >= last) throw new Error(`setTargetStopLoss: ${trade.tsym}: the stop ${stop!.toFixed(2)} is at or above the live price ${last.toFixed(2)} - it would sell at once, not changed`);
    if (last > 0 && targetChanged && target! <= last) throw new Error(`setTargetStopLoss: ${trade.tsym}: the target ${target!.toFixed(2)} is at or below the live price ${last.toFixed(2)} - it would sell at once, not changed`);
    const before = { targetPrice: trade.targetPrice, targetPoints: trade.targetPoints, stopLossPrice: trade.stopLossPrice };
    if (targetChanged) {
        trade.targetPrice = target;
        trade.targetPoints = targetPoints;
    }
    if (stopChanged) trade.stopLossPrice = stop;

    // A GTT always carries both legs, so both prices exist whenever one is attached. A merged position holds several: modifyPositionGtts sizes them
    // so that together they never exceed what is held.
    if (trade.gttTriggerId && trade.targetPrice != null && trade.stopLossPrice != null) {
        const gttTarget = trade.targetPrice, gttStop = trade.stopLossPrice;
        try {
            await withGttSellLock(trade.user, trade.tsym, () => modifyPositionGtts(trade.user, trade, gttTarget, gttStop));
        } catch (e) {
            Object.assign(trade, before); // the page must not show levels the broker did not take
            throw e;
        }
    }
    // An in-app hard stop (a broker exit looser than the stop, or lots without a GTT) follows the stop the user chose.
    if (stopChanged && trade.hardStopPrice != null) trade.hardStopPrice = stop;
    if (targetChanged || stopChanged) persistExitLevels(trade);
    // Breeze has no broker-side exit: the in-app exitMonitor is the only enforcement, so a target/stop set on a position bought without
    // one (manual buy with no exit points) must start the watch here. Re-registering an already-watched trade just replaces its entry
    // (the monitor reads trade.targetPrice/stopLossPrice live off the same object).
    if (trade.broker === 'breeze' && trade.token) exitMonitor.registerTrade(trade, exchangeForTsym(trade.tsym), 'breeze');
    // Kite/ANT position with no GTT and no bracket (bought without exit points): nothing would enforce the new levels, so arm the in-app watch.
    else if ((trade.broker === 'ant' || (trade.broker ?? 'kite') === 'kite') && !trade.gttTriggerId && trade.token && (trade.targetPrice != null || trade.stopLossPrice != null)) {
        exitMonitor.registerTrade(trade, exchangeForTsym(trade.tsym), trade.broker === 'ant' ? 'ant' : 'kite');
    }
    bookkeeping.notifyTargetStopLossChanged();
}

// The most `userId` may sell of `tsym` while other platform owners hold the same contract on the shared Kite account (own open lots minus the owner's
// own tracked resting sells); undefined when the owner is alone on the contract.
export function kiteOwnerCap(userId: string, tsym: string): number | undefined {
    const resting = findPendingOrdersForSymbol(userId, tsym).filter((o) => o.action === 'Sell').reduce((s, o) => s + Number((o as any).quantity ?? 0), 0);
    return ownerSellCap(bookkeeping.ownerHoldings('kite', tsym, userId), resting);
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
    let gttRemoved = false;
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

        // No GTT may stay live beside this sell (gttRelease.ts): one that has FIRED is booked first (this exit then sells only what is still held;
        // live 2026-11-12 10:11: the stop GTT had fired at the broker, the in-app monitor then tried the same sell 280 times), the rest are deleted
        // before any resting sell is cancelled or the new sell placed. A GTT that cannot be removed refuses the exit.
        gttRemoved = await withGttSellLock(userId, tsym, () => releaseGttsForSell(userId, tsym));
        if (!bookkeeping.trades.includes(existing) || !(existing.quantity > 0)) {
            Log.log(`[order] squareOffOnKite: ${tsym} (${userId}) was closed by its broker GTT - nothing to sell`);
            return emptyExitTrade(userId, tsym, 'kite');
        }
        quantity = Math.min(quantity, existing.quantity);

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
            const placed = await kite.placeLimitSellOption(tsym, quantity, sellPrice, exchange, () => kiteOwnerCap(userId, tsym));
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
        // What is still open (a partial or failed sell) goes to the in-app monitor until sweepUserExits puts a GTT back.
        if (gttRemoved) watchInApp(userId, tsym);
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
    const buyPrice = await orderPriceOf({ side: 'BUY', tsym: request.tradingSymbol, token: String(request.brokerToken), exchange, broker: 'kite' });
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
    return awaitKiteBuy({ orderId, userId: request.userId, tradingSymbol: request.tradingSymbol, instrumentToken: String(request.brokerToken), quantity: request.quantity, exchange }, async () => {
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
                    : undefined,
                BUY_FILL_WAIT.ms
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
    });
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
    const buyPrice = await orderPriceOf({ side: 'BUY', tsym: tradingSymbol, token: String(instrumentToken), exchange, broker: 'kite' });
    const { orderId } = await kite.placeLimitBuyOption(tradingSymbol, quantity, buyPrice, exchange);
    // awaitKiteBuy: tracked (persisted, owner-ledgered) from placement until its fill is booked: this call waits for the fill in-process, so
    // an order-process restart in that window used to lose the fill - a real broker position with no Buy doc, which reconcile can only
    // leave untracked (2026-10-28 10:06, NIFTY26N0322550PE). The pending poller books it after a restart; recordFill dedupes on
    // brokerOrderId, so it is booked once. Left tracked if the wait throws: the poller resolves it.
    const mk = (qty: number, price: number): Trade => kiteFillTrade({ tsym: tradingSymbol, token: instrumentToken, action: 'Buy', userId: userId, orderId: orderId }, qty, price);
    return awaitKiteBuy({ orderId, userId, tradingSymbol, instrumentToken, quantity, exchange }, async () => {
        const entryPrice = await getFillBookingPartial(kite, orderId, mk, (t) => bookkeeping.recordFill(t), BUY_FILL_WAIT.ms);
        const trade = mk(quantity, entryPrice);
        await bookkeeping.recordFill(trade);
        return trade;
    });
}

// Unlike squareOffOnKite, this sets trade.token - needed so tokenRouter's
// unregisterTrade (called from strategiesProcess.ts's onFill on every Sell
// fill) actually finds the right token to unsubscribe.
export async function marketSellBareOnKite(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const kite = Kite.getInstance();
    Log.log(`[order] Bare market sell ${tradingSymbol} qty=${quantity} for ${userId}`);
    const done = markKiteSelling(userId, tradingSymbol); // no GTT is placed while this sell is open (it never reaches the pending tracker)
    let gttRemoved = false;
    try {
        gttRemoved = await withGttSellLock(userId, tradingSymbol, () => releaseGttsForSell(userId, tradingSymbol));
        const sellPrice = await getMarketableKitePrice(instrumentToken, exchange, 'SELL');
        const placed = await kite.placeLimitSellOption(tradingSymbol, quantity, sellPrice, exchange, () => kiteOwnerCap(userId, tradingSymbol));
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
    } finally {
        done();
        if (gttRemoved) watchInApp(userId, tradingSymbol);
    }
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
    const sellPrice = await orderPriceOf({ side: 'SELL', tsym: tradingSymbol, token: String(instrumentToken), exchange, broker: 'kite' });
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
    const buyPrice = await orderPriceOf({ side: 'BUY', tsym: tradingSymbol, token: String(instrumentToken), exchange, broker: 'kite' });
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
    // Locked until the order is tracked: the GTTs go first (a GTT live beside a resting sell can sell the quantity twice - gttRelease.ts), and no
    // new GTT is placed in between.
    return withGttSellLock(userId, tradingSymbol, async () => {
        // The monitor is armed before the order goes out, so a refused sell never leaves the position unwatched. A stop it hits meanwhile waits
        // for this lock, then cancels the resting sell and sells.
        if (await releaseGttsForSell(userId, tradingSymbol)) watchInApp(userId, tradingSymbol);
        const placed = await kite.placeLimitSellOption(tradingSymbol, quantity, price, exchange, () => kiteOwnerCap(userId, tradingSymbol));
        const orderId = placed.orderId;
        // Track the quantity actually placed (the never-short guard may have clamped it) so the fill is booked correctly.
        trackPendingLimitOrder({ orderId, userId, tradingSymbol, instrumentToken, quantity: placed.quantity, exchange, action: 'Sell', price });
        return { orderId, quantity: placed.quantity };
    });
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
        // docs/status/gaps.md's "Partial-fill accounting" entry. terminal mirrors
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
    // A position above one freeze order (a split frontend buy) is sold in freeze-sized chunks.
    await squareOffAutoChunked({ squareOff: (u, t, q, e) => squareOffOnKite(u, t, q, e as 'NFO' | 'BFO') }, trade.user, trade.tsym, trade.quantity, exchange);
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
        let matches = liveGtts.filter((g: any) => g?.condition?.tradingsymbol === t.tsym && (g.status === 'active' || g.status === 'triggered')
            && !owned.has(g.id) && Number(g.orders?.[0]?.quantity) === t.quantity);
        if (matches.length > 1 && t.targetPrice != null && t.stopLossPrice != null) {
            // Two users on one contract with the same quantity (a mirror pair) is normal: tell the GTTs apart by this leg's own stop/target pair.
            const want = [Number(t.stopLossPrice), Number(t.targetPrice)].sort((a, b) => a - b);
            const exact = matches.filter((g: any) => {
                const tv = (g.condition?.trigger_values ?? []).map(Number).sort((a: number, b: number) => a - b);
                return tv.length === 2 && Math.abs(tv[0] - want[0]) <= 0.05 && Math.abs(tv[1] - want[1]) <= 0.05;
            });
            if (exact.length === 1) matches = exact;
        }
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

// ---- Loss-budget re-protection of a merged position (add-more / several fills) ---------------------------------------------------------
// A Kite GTT is sized and priced for the lot it was placed with. After an add-more the merged row holds several GTTs (primary id + extraGttTriggerIds)
// whose stops are looser than the loss budget stop of the WHOLE position (bookkeeping.tightenStopToLossBudget), so the broker exit would fire at a
// loss above the budget. This replaces them with ONE GTT for the merged quantity at the row's (tightened) stop and its target, without ever leaving
// two live exits for the same quantity: every old GTT is deleted and confirmed gone at the broker's GTT book BEFORE the new one is placed; until the
// new GTT is live the in-app exit monitor is the exit (hard stop at the budget stop, row.hardStopPrice); if an old GTT cannot be cancelled it is kept
// (nothing new is placed) and the in-app hard stop stays armed. A GTT that triggered meanwhile is left to the GTT-fill poll (never replaced).
const reprotectRuns = new Map<string, { again: boolean }>();
const reprotectCooldown = new Map<string, number>();
const REPROTECT_BACKOFF_MS = [1000, 3000, 8000];
const REPROTECT_COOLDOWN_MS = 5 * 60_000;
export const reprotectDelay = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }; // tests replace it

export function gttIdsOf(t: TradeRow): number[] {
    return [t.gttTriggerId, ...(t.extraGttTriggerIds ?? [])].filter((id): id is number => id != null);
}
function gttStopOf(g: any): number | undefined {
    const tv = (g?.condition?.trigger_values ?? []).map(Number).filter((x: number) => Number.isFinite(x));
    return tv.length === 2 ? Math.min(...tv) : undefined;
}

// 'ok': the live GTTs cover exactly the row's quantity, none with a stop looser than the row's. 'mismatch': they do not. 'unknown': an id is missing
// from the book or not active (triggered / dead): the GTT-fill poll owns that, nothing is replaced here.
export function gttCoverage(row: TradeRow, live: any[]): 'ok' | 'mismatch' | 'unknown' {
    const ids = gttIdsOf(row);
    if (ids.length === 0 || row.stopLossPrice == null) return 'unknown';
    const byId = new Map<any, any>(live.map((g: any) => [g.id, g]));
    let qty = 0;
    let loose = false;
    for (const id of ids) {
        const g = byId.get(id);
        if (!g || g.status !== 'active') return 'unknown';
        qty += Number(g.orders?.[0]?.quantity) || 0;
        const stop = gttStopOf(g);
        if (stop === undefined || stop < row.stopLossPrice - 0.05 - 1e-9) loose = true;
    }
    return loose || qty !== row.quantity ? 'mismatch' : 'ok';
}

// Forgets GTT ids that are confirmed gone at the broker: on the row and on the persisted Buy documents (a restart must not restore them).
export async function forgetGttIds(trade: TradeRow, gone: number[]): Promise<void> {
    if (gone.length === 0) return;
    if (trade.gttTriggerId != null && gone.includes(trade.gttTriggerId)) trade.gttTriggerId = undefined as any;
    const remaining = (trade.extraGttTriggerIds ?? []).filter((x) => !gone.includes(x));
    trade.extraGttTriggerIds = remaining.length > 0 ? remaining : undefined;
    // Promote an extra to primary so the row's single id field keeps pointing at a live GTT.
    if (trade.gttTriggerId == null && trade.extraGttTriggerIds?.length) {
        trade.gttTriggerId = trade.extraGttTriggerIds[0];
        const rest = trade.extraGttTriggerIds.slice(1);
        trade.extraGttTriggerIds = rest.length > 0 ? rest : undefined;
    }
    try {
        await Mongo.getInstance()?.db.collection('Trade').updateMany({ tsym: trade.tsym, user: trade.user, action: 'Buy', gttTriggerId: { $in: gone } }, { $unset: { gttTriggerId: '' } });
    } catch (e) { Log.log(`[order] could not clear the stored GTT id(s) ${gone.join(',')} of ${trade.tsym} (${trade.user}):`, e); }
}

function armHardStop(row: TradeRow): void {
    if (row.stopLossPrice == null || !row.token) return;
    if (row.hardStopPrice == null || row.hardStopPrice < row.stopLossPrice) row.hardStopPrice = row.stopLossPrice;
    exitMonitor.registerTrade(row, exchangeForTsym(row.tsym), 'kite', gttIdsOf(row).length > 0);
}

const rowOfKite = (userId: string, tsym: string): TradeRow | undefined => bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId && (t.broker ?? 'kite') === 'kite');

/** True while this position's GTTs are being replaced (a square-off must not start in the middle of it). */
export const isReprotecting = (userId: string, tsym: string): boolean => reprotectRuns.has(`${userId}:${tsym}`);

/** Books any GTT of `tsym` that has already fired and adopts one whose id is unknown, waiting out a poll already in flight. */
export async function settleGtts(tsym: string): Promise<void> {
    for (let i = 0; i < 20 && gttPollInFlight; i++) await new Promise((r) => setTimeout(r, 500));
    gttAdoptNow.add(tsym);
    await pollGttFills();
}

// Run after a manual buy has booked: only a row that shows merge evidence (several GTT ids, or the budget stop was just raised over a live GTT).
export async function reprotectAfterBuy(userId: string, tsym: string): Promise<void> {
    const row = rowOfKite(userId, tsym);
    if (!row) return;
    const ids = gttIdsOf(row);
    if (ids.length === 0 || (ids.length === 1 && row.hardStopPrice == null)) return;
    await reprotectToBudget(userId, tsym);
}

export async function reprotectToBudget(userId: string, tsym: string): Promise<void> {
    const key = `${userId}:${tsym}`;
    const running = reprotectRuns.get(key);
    if (running) { running.again = true; return; } // an add-more landed mid-run: the running pass loops once more
    const state = { again: false };
    reprotectRuns.set(key, state);
    try {
        for (let round = 0; round < 3; round++) {
            state.again = false;
            await reprotectOnce(userId, tsym, state);
            if (!state.again) break;
        }
    } catch (e) {
        Log.log(`[order] ALERT: re-protecting ${tsym} (${userId}) to the loss budget failed - the in-app hard stop stays armed:`, e);
    } finally {
        reprotectRuns.delete(key);
    }
}

async function reprotectOnce(userId: string, tsym: string, state: { again: boolean }): Promise<void> {
    const row = rowOfKite(userId, tsym);
    if (!row || row.strategy || !row.token || bookkeeping.lossBudgetFor(userId) === undefined) return;
    // A resting sell of this position (a square-off at a locked price) already owns the quantity: a GTT placed next to it could sell it twice.
    if (findPendingOrdersForSymbol(userId, tsym).some((o) => o.action === 'Sell')) { Log.log(`[order] re-protect ${tsym} (${userId}): a sell is resting - no GTT placed, the in-app monitor protects the position`); return; }
    const ids = gttIdsOf(row);
    if (ids.length === 0 || !(Number(row.stopLossPrice) > 0) || row.targetPrice == null) return;
    const kite = Kite.getInstance();
    const exchange = exchangeForTsym(tsym);
    let live: any[];
    try { live = await kite.getGTTs(); } catch (e) {
        Log.log(`[order] ALERT: GTT book of ${tsym} (${userId}) unreadable - the loss budget stop ${row.stopLossPrice} is enforced by the in-app hard stop until it can be re-protected:`, e);
        armHardStop(row);
        return;
    }
    const cover = gttCoverage(row, live);
    if (cover === 'ok') { row.hardStopPrice = undefined; return; }
    if (cover === 'unknown') {
        Log.log(`[order] re-protect ${tsym} (${userId}): a GTT is triggered / missing / dead - left to the GTT poll`);
        void pollGttFills();
        return;
    }
    armHardStop(row); // exposure first: the in-app monitor sells at the budget stop while the GTTs are replaced

    // 1. cancel every old GTT; confirm a failed cancel against the broker's book before believing it
    let pending = ids.slice();
    const gone: number[] = [];
    for (let attempt = 0; attempt <= REPROTECT_BACKOFF_MS.length && pending.length > 0; attempt++) {
        if (attempt > 0) await reprotectDelay.sleep(REPROTECT_BACKOFF_MS[attempt - 1]);
        const failed: number[] = [];
        for (const id of pending) {
            try { await kite.deleteGTT(id); gone.push(id); }
            catch (e) { if (isGttGoneError(e)) gone.push(id); else failed.push(id); }
        }
        pending = failed;
        if (failed.length > 0) {
            let book: any[] | undefined;
            try { book = await kite.getGTTs(); } catch { book = undefined; }
            if (book) {
                const byId = new Map<any, any>(book.map((g: any) => [g.id, g]));
                if (failed.some((id) => byId.get(id)?.status === 'triggered')) {
                    await forgetGttIds(row, gone);
                    Log.log(`[order] re-protect ${tsym} (${userId}): a GTT triggered while it was being replaced - left to the GTT poll, no new GTT placed`);
                    void pollGttFills();
                    return;
                }
                // Still active in the book = still live; absent / cancelled / deleted = not live.
                pending = failed.filter((id) => byId.get(id)?.status === 'active');
                for (const id of failed) if (!pending.includes(id)) gone.push(id);
            }
        }
    }
    await forgetGttIds(row, gone);
    if (pending.length > 0) {
        Log.log(`[order] ALERT: GTT(s) ${pending.join(',')} of ${tsym} (${userId}) could not be cancelled - kept (no second GTT placed); the in-app hard stop at ${row.hardStopPrice} sells the position at the loss budget stop`);
        armHardStop(row);
        return;
    }

    // 2. no live GTT left: the in-app monitor is the exit until the new GTT is live
    exitMonitor.registerTrade(row, exchange, 'kite', false);
    const place = async (): Promise<void> => {
        if (!bookkeeping.trades.includes(row)) return; // sold meanwhile
        const qty = row.quantity;
        if (qty > defaultFreezeQty(tsym, exchange)) {
            row.hardStopPrice = undefined;
            Log.log(`[order] ${tsym} (${userId}) qty ${qty} exceeds one freeze order: no GTT - the in-app exit monitor owns the exit at stop ${row.stopLossPrice} / target ${row.targetPrice}`);
            return;
        }
        for (let attempt = 0; attempt <= REPROTECT_BACKOFF_MS.length; attempt++) {
            if (attempt > 0) await reprotectDelay.sleep(REPROTECT_BACKOFF_MS[attempt - 1]);
            // Under the lock every platform sell takes: none can be placed between the checks and the new GTT.
            const unlock = await acquireGttSellLock(userId, tsym);
            try {
                if (!bookkeeping.trades.includes(row)) return;
                if (row.quantity !== qty) { state.again = true; return; } // another add-more booked: the next round re-sizes it
                if (kiteSellBusy(userId, tsym)) { Log.log(`[order] re-protect ${tsym} (${userId}): a sell is in progress - no GTT placed`); return; }
                const stop = row.stopLossPrice as number;
                const target = row.targetPrice as number;
                const last = row.lastTradePrice > 0 ? row.lastTradePrice : row.price;
                if (!(stop > 0) || !(stop < last) || !(last < target)) {
                    row.hardStopPrice = undefined;
                    Log.log(`[order] ALERT: no GTT can be placed for ${tsym} (${userId}): need 0 < stop ${stop} < last ${last} < target ${target} - the in-app exit monitor owns the exit`);
                    return;
                }
                let id: number;
                try {
                    id = await kite.placeTargetStopLossGTT(tsym, exchange, qty, stop, target - stop, 0, last);
                } catch (e) {
                    Log.log(`[order] ALERT: replacement GTT for ${tsym} (${userId}) qty ${qty} failed (attempt ${attempt + 1}/${REPROTECT_BACKOFF_MS.length + 1}):`, (e as any)?.message ?? e);
                    continue;
                }
                if (!bookkeeping.trades.includes(row) || row.quantity !== qty) {
                    // The position was sold / grown while the GTT was being placed: that GTT must not stay live next to the in-app exit.
                    try { await kite.deleteGTT(id); Log.log(`[order] replacement GTT ${id} of ${tsym} (${userId}) deleted - the position changed while it was placed`); }
                    catch (e) { Log.log(`[order] ALERT: replacement GTT ${id} of ${tsym} (${userId}) is stale and could NOT be deleted - delete it by hand in Kite:`, e); }
                    if (bookkeeping.trades.includes(row)) state.again = true;
                    return;
                }
                row.gttTriggerId = id;
                row.extraGttTriggerIds = undefined;
                row.hardStopPrice = undefined;
                persistGttTriggerId(row);
                exitMonitor.registerTrade(row, exchange, 'kite', true);
                bookkeeping.notifyTargetStopLossChanged();
                Log.log(`[order] re-protected ${tsym} (${userId}): ONE GTT ${id} for the merged qty ${qty}, stop ${stop} target ${target}`);
                return;
            } finally { unlock(); }
        }
        row.hardStopPrice = undefined;
        Log.log(`[order] ALERT: ${tsym} (${userId}) has NO GTT after ${REPROTECT_BACKOFF_MS.length + 1} attempts - the in-app exit monitor owns the exit at stop ${row.stopLossPrice} / target ${row.targetPrice}`);
    };
    await place();
}

export function isGttGoneError(e: any): boolean {
    if (!e) return false;
    if (e.status === 404 || e.response?.status === 404) return true;
    return /not found|does not exist|no such trigger/i.test(String(e.message ?? e));
}

// Run from the GTT poll with the broker's GTT list it already read: a position whose live GTTs are looser than its stop or cover another quantity
// (restart after a merge, a lot whose own GTT failed) is re-protected. Per position, at most once per 5 minutes.
function checkGttsAgainstBudget(live: any[]): void {
    for (const row of bookkeeping.trades) {
        if ((row.broker ?? 'kite') !== 'kite' || row.strategy || !row.token || gttIdsOf(row).length === 0) continue;
        if (bookkeeping.lossBudgetFor(row.user) === undefined) continue;
        const key = `${row.user}:${row.tsym}`;
        if (reprotectRuns.has(key) || gttCoverage(row, live) !== 'mismatch') continue;
        if (Date.now() - (reprotectCooldown.get(key) ?? 0) < REPROTECT_COOLDOWN_MS) continue;
        reprotectCooldown.set(key, Date.now());
        Log.log(`[order] GTT poll: GTT(s) of ${row.tsym} (${row.user}) do not match its quantity ${row.quantity} / stop ${row.stopLossPrice} - re-protecting`);
        void reprotectToBudget(row.user, row.tsym);
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
    checkGttsAgainstBudget(liveGtts);
    const openGttTrades = bookkeeping.trades.filter((t) => gttIdsOf(t).length > 0);
    if (openGttTrades.length === 0) return;
    const byId = new Map<any, any>(liveGtts.map((g: any) => [g.id, g]));
    let orderBook: any[] | undefined; // read once per poll, only when a GTT has triggered
    const readOrders = async (): Promise<any[]> => (orderBook ??= await kite.getKiteConnect().getOrders());

    for (const trade of openGttTrades) {
        // The GTTs of LATER buys merged into this row (extraGttTriggerIds) are broker exits as well: each fires on its own and sells its own lot.
        // They used to be looked at by nobody, so a fired extra's sell stayed unbooked, showed up as a 'sell outside the platform' and left the
        // leg open at a quantity the broker no longer held (live 2026-11-25 12:29:40 GTT 346265018 fired, 12:30:19 the exit monitor then tried to
        // sell the same 520 again: NEVER-SHORT refusal). Every id of the row is resolved here.
        for (const extraId of (trade.extraGttTriggerIds ?? []).slice()) {
            const eg = byId.get(extraId);
            if (!eg) continue; // absent from the list: left as is (the primary's missing-poll fallback owns the row's recovery)
            if (eg.status === 'triggered') {
                try { await bookFiredGtt(trade, eg, readOrders); } catch (e) { Log.log('[order] GTT poll: failed to resolve exit of extra GTT', extraId, 'for', trade.tsym, e); }
            } else if (GTT_DEAD_STATUSES.has(eg.status)) {
                Log.log(`[order] ALERT: extra GTT ${extraId} for ${trade.tsym} (${trade.user}) is '${eg.status}', not triggered - that lot has no broker exit; dropping the reference`);
                trade.extraGttTriggerIds = (trade.extraGttTriggerIds ?? []).filter((x) => x !== extraId);
                if (trade.extraGttTriggerIds.length === 0) trade.extraGttTriggerIds = undefined;
            }
        }
        if (!bookkeeping.trades.includes(trade) || trade.gttTriggerId == null) continue;
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
            await bookFiredGtt(trade, gtt, readOrders);
        } catch (e) {
            Log.log('[order] GTT poll: failed to resolve exit for', trade.tsym, e);
        }
    }
}

// Books the exit order of ONE triggered GTT of `trade` (primary or an extra id) as a platform sell: the order is found by the GTT's own result
// (orders[].result.order_result.order_id), the GTT id is taken off the row before booking (so booking does not try to delete the trigger that just
// fired), and the order is registered as the platform's own (brokerOwnedExitOrderIds + bookkeeping.gttFiredOrders) so it can never be read as a sell
// made outside the platform. Returns true when a sell was booked.
export async function bookFiredGtt(trade: TradeRow, gtt: any, readOrders: () => Promise<any[]>, orphan = false): Promise<boolean> {
    const firedId = gtt.id as number;
    // `orphan`: the id is already off the row (a sell booked elsewhere released the row's GTTs while this one had fired): book its sell against what is left.
    if (!orphan && !gttIdsOf(trade).includes(firedId)) return false;
    const orders = await readOrders();
    const entryMs = trade.entryTime ? new Date(trade.entryTime).getTime() : 0;
    // THIS GTT's own exit order: Kite reports it on the triggered GTT (orders[].result.order_result.order_id). Picking "the newest
    // completed sell of the contract" instead booked the SAME order for two users holding the same contract (a mirror pair, both GTTs
    // firing together): the second booking was dropped as a redelivered fill and that leg stayed open (live 2026-11-12 10:50).
    const gttOrderIds = new Set<string>((gtt.orders ?? []).map((x: any) => x?.result?.order_result?.order_id).filter((x: any) => x != null && x !== '').map(String));
    const completedSells = (orders as any[]).filter((o: any) => o.tradingsymbol === trade.tsym && o.transaction_type === 'SELL' && o.status === 'COMPLETE' && new Date(o.order_timestamp).getTime() >= entryMs);
    let sellFill: any;
    if (gttOrderIds.size > 0) {
        sellFill = completedSells.find((o: any) => gttOrderIds.has(String(o.order_id)));
    } else {
        // The GTT did not name its order: only a sell no other leg has claimed, nearest this leg's own target/stop price.
        const free = completedSells.filter((o: any) => !bookkeeping.isFillProcessed(String(o.order_id)));
        const ref = [trade.targetPrice, trade.stopLossPrice].filter((x) => x != null) as number[];
        const dist = (o: any) => ref.length ? Math.min(...ref.map((r) => Math.abs(Number(o.average_price) - r))) : 0;
        sellFill = free.sort((a: any, b: any) => dist(a) - dist(b))[0];
    }
    if (!sellFill) {
        // Triggered but the exit order isn't COMPLETE yet (or not visible): retry next poll rather than
        // booking a guessed exit.
        Log.log(`[order] GTT poll: ${trade.tsym} (${trade.user}) GTT ${firedId} triggered but no completed sell order yet - will retry`);
        return false;
    }
    if (orphan && !(trade.quantity > 0)) {
        // Nothing open to book it against: the account was sold twice (the caller ALERTs). The order is still the platform's own: remember it so no
        // check calls it a sell made outside the platform.
        const id = String(sellFill.order_id);
        bookkeeping.markGttExit('kite', id, firedId);
        recordOrderOwner(id, trade.user, 'kite', {});
        return false;
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

    // The GTT itself sold: take its id off the row first (an extra just leaves the list; a primary hands the row's single id field to the next one).
    const before = { primary: trade.gttTriggerId, extras: trade.extraGttTriggerIds ? trade.extraGttTriggerIds.slice() : undefined };
    if (orphan) { /* already off the row */ } else if (trade.gttTriggerId === firedId) {
        const rest = (trade.extraGttTriggerIds ?? []).slice();
        trade.gttTriggerId = rest.length > 0 ? rest.shift()! : undefined as any;
        trade.extraGttTriggerIds = rest.length > 0 ? rest : undefined;
    } else {
        const rest = (trade.extraGttTriggerIds ?? []).filter((x) => x !== firedId);
        trade.extraGttTriggerIds = rest.length > 0 ? rest : undefined;
    }
    const orderId = String(sellTrade.brokerOrderId);
    if (sellTrade.brokerOrderId) bookkeeping.markGttExit('kite', orderId, firedId);
    try {
        await bookkeeping.recordFill(sellTrade);
    } catch (e) {
        trade.gttTriggerId = before.primary as any;
        trade.extraGttTriggerIds = before.extras;
        throw e;
    }
    Log.log(`[order] GTT poll: ${trade.tsym} (${trade.user}) closed${trade.quantity > 0 ? ` ${sellTrade.quantity} (${trade.quantity} still held, covered by ${gttIdsOf(trade).length} other GTT(s))` : ''}, recorded exit at ${sellTrade.price} (GTT ${firedId}, order ${orderId})`);
    return true;
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
Kite.neverShortRepair = (tsym) => bookkeeping.requestNeverShortRepair('kite', tsym);
bookkeeping.registerGttSupport({
    // Order ids of sells that TRIGGERED GTTs of the platform's open rows placed (primary or extra id): the platform's own sells, booked or not yet.
    exitOrderIds: async () => {
        const ids = new Set<number>();
        for (const t of bookkeeping.trades) if ((t.broker ?? 'kite') === 'kite') for (const id of gttIdsOf(t)) ids.add(id);
        const out = new Set<string>();
        if (ids.size === 0) return out;
        for (const g of await Kite.getInstance().getGTTs()) {
            if (!ids.has(g?.id) || g.status !== 'triggered') continue;
            for (const o of g.orders ?? []) { const oid = o?.result?.order_result?.order_id; if (oid != null && oid !== '') out.add(String(oid)); }
        }
        return out;
    },
    poll: () => pollGttFills(),
    bookOrphan: (t, g) => bookFiredGtt(t as TradeRow, g, async () => (await Kite.getInstance().getKiteConnect().getOrders()) as any[], true),
});
bookkeeping.registerOwnOrderTest('kite', (id) => isTrackedPendingOrder(id));
Kite.neverShortExplainer = (tsym) => bookkeeping.explainNeverShort('kite', tsym, (id) => Kite.getInstance().isOwnOrder(id) || isTrackedPendingOrder(id));
const FOREIGN_SELL_GRACE_MS = 2 * 60_000; // a GTT-triggered exit is booked by pollGttFills shortly after it fills; give that time to claim it
const foreignSellAlerted = new Set<string>();

async function reconcileManualSellsOnce(): Promise<void> {
    const kite = Kite.getInstance();
    if (!(await kite.hasValidSession())) return;
    if (bookkeeping.trades.length === 0) return;

    // A non-platform sell that took the platform's own lots (broker net below the platform's open quantity, the manual sells exceeding the user's
    // own manual buys) is booked first, at its trade-book price, through the normal fill path (the strategy's leg closes like any sale). The ALERT
    // below then only names the sells that stay the user's own business.
    // (the booking itself is event-driven now: bookkeeping's foreign-sell watch, fed by the platform's own bookings, NEVER-SHORT refusals and a 15 s poll;
    // this 60 s pass only names the sells that stay the user's business)
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
    const owners = await loadOrderOwners(candidates.map((o: any) => String(o.order_id)), 'kite');
    for (const o of candidates) {
        const id = String(o.order_id);
        if (owners.has(id)) continue;
        foreignSellAlerted.add(id);
        Log.log(`[order] ALERT: Kite SELL ${o.tradingsymbol} qty=${o.filled_quantity} @ ${o.average_price} (order ${id}) was not placed by this platform - NOT booked or stored; a tracked leg on this contract may now be stale`);
    }
}
