// stdout now doubles as the subscribe/unsubscribe protocol channel back to
// `data` (see exitMonitor.ts) - redirect console.log to stderr before any
// other module loads, mirroring strategiesProcess.ts/dataProcess.ts.
console.log = console.error;

// This host is dual-stack and Node's Happy-Eyeballs connection logic prefers
// IPv6 when both are available, which bypasses Kite's AND AliceBlue/ANT's
// IPv4-only order-placement allowlists. dns.setDefaultResultOrder('ipv4first')
// looks like the fix but does NOT actually change the connected family
// (confirmed live - autoSelectFamily doesn't honor it); forcing IPv4
// process-wide (via NODE_OPTIONS) does work but broke Breeze, whose
// registered "static IP" is apparently the IPv6 address, not IPv4 - see
// orchestrator.ts's note. So the override is scoped to just the specific
// hostnames that need it (see kiteDns.ts) - `order` is the only process that
// calls api.kite.trade (Zerodha) AND the one that places/cancels/exits ANT
// orders via a3.aliceblueonline.com, so it's installed here.
import { installIpv4OnlyHostOverride } from './order/kiteDns';
installIpv4OnlyHostOverride();

import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { writeJsonLine, readJsonLines } from '../ipc/jsonLines';
import { ORDER_SOCKET_PATH, OrderRequest, OrderResponse, FillNotification, PositionsChangedNotification, OrderCancelledNotification } from '../ipc/orderProtocol';
import bookkeeping from './order/bookkeeping';
import { buyIndexOnZerodha, manualBuyOnZerodha, setTargetStopLoss, pollGttFills, reconcileManualSells, marketBuyBareOnZerodha, marketSellBareOnZerodha, placeLimitBuyBareOnZerodha, placeLimitSellBareOnZerodha, cancelOrderOnZerodha, getContractByPriceRangeOnZerodha, enterShortOnZerodha, buyToCloseOnZerodha } from './order/zerodhaExecutor';
import { pollPendingLimitOrders, loadPendingLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingZerodhaOrdersForSymbol, onCancelled as onPendingZerodhaCancelled } from './order/pendingLimitOrders';
import { pollPendingAntLimitOrders, loadPendingAntLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingAntOrdersForSymbol, onCancelled as onPendingAntCancelled } from './order/pendingAntLimitOrders';
import { pollPendingPrismLimitOrders, loadPendingPrismLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingPrismOrdersForSymbol, onCancelled as onPendingPrismCancelled } from './order/pendingPrismLimitOrders';
import * as antExecutor from './order/antExecutor';
import { buyIndexOnBreeze, squareOffOnBreeze, marketBuyBareOnBreeze, marketSellBareOnBreeze, placeLimitBuyBareOnBreeze, placeLimitSellBareOnBreeze, cancelOrderOnBreeze, getContractByPriceRangeOnBreeze, getMarketableBreezeBuyPrice, tsymFor, enterShortOnBreeze, buyToCloseOnBreeze } from './order/breezeExecutor';
import { pollPendingBreezeLimitOrders, loadPendingBreezeLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingBreezeOrdersForSymbol, onCancelled as onPendingBreezeCancelled } from './order/breezePendingLimitOrders';
import { buyChunked, squareOffChunked, squareOffLimitChunked } from './order/chunkedOrder';
import BreezeContractMaster from '../breeze/BreezeContractMaster';
import Breeze from '../breeze/Breeze';
import ZerodhaContractMaster from '../zerodha/ZerodhaContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import PrismContractMaster from '../prism/PrismContractMaster';
import BreezeOrderNotifyStream from '../breeze/BreezeOrderNotifyStream';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import * as exitMonitor from './order/exitMonitor';
import * as prismExecutor from './order/prismExecutor';
import { getBrokerExecutor } from './order/brokerExecutors';
import { BrokerExecutor, OrderAlreadyFilledError } from './order/BrokerExecutor';
import Zerodha from '../zerodha/Zerodha';
import ANT from '../ant/ANT';
import NorenRestApi from '../prism/RestAPI';
import { USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT, CALL } from '../constants';
import { getUser, getAllUsers } from '../user';
import { OptionQuote, Trade } from '../model/model';
import { isPastExpirySquareOffTime, isPastReconcileTime } from '../util/marketHours';

// Defense-in-depth: an unhandled promise rejection anywhere in this process
// (e.g. a fire-and-forget Mongo write - see bookkeeping.ts's
// _processTradeEvent/checkDrawdownNotification/persistClosedTrade) would
// otherwise crash the whole `order` process on Node's default
// unhandledRejection behavior, losing all in-flight risk state
// (bookkeeping.trades, pending order attribution, GTT tracking, P&L). Log
// and keep running instead - deliberately no process.exit() here.
process.on('unhandledRejection', (reason) => {
    Log.log('[order] Unhandled promise rejection (process kept alive):', reason);
});

// Entry point for the `order` process - the IPC server. `strategies` and
// `frontend` connect to it as clients over a Unix domain socket (siblings can't
// use Node's fork()-only IPC directly, and `order` is the stable side on purpose:
// when `strategies` gets killed/respawned for a code change, it just reconnects -
// `order`'s live broker sessions and GTTs are never touched). Its stdin/stdout
// are also wired (by the orchestrator) into the same tick-feed pipe used by
// `strategies`/`frontend`, solely so exitMonitor.ts can watch useGTT=false
// trades against live option ticks (see orderProcess.ts's onTick below).

const clients = new Set<net.Socket>();

function broadcast(msg: FillNotification | PositionsChangedNotification | OrderCancelledNotification) {
    for (const c of clients) writeJsonLine(c, msg);
}

bookkeeping.onFill((userId, trade) => {
    broadcast({ kind: 'fill', userId, trade });
});

bookkeeping.onPositionsChanged(() => {
    broadcast({ kind: 'positionsChanged' });
});

onPendingZerodhaCancelled((userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason) => {
    broadcast({ kind: 'cancelled', userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason });
});

onPendingBreezeCancelled((userId, tradingSymbol, antToken, quantity, exchange, action, broker, orderId, reason) => {
    broadcast({ kind: 'cancelled', userId, tradingSymbol, instrumentToken: antToken, quantity, exchange, action, broker, orderId, reason });
});

onPendingAntCancelled((userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason, rejectReason) => {
    broadcast({ kind: 'cancelled', userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason, rejectReason });
});

onPendingPrismCancelled((userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason) => {
    broadcast({ kind: 'cancelled', userId, tradingSymbol, instrumentToken, quantity, exchange, action, broker, orderId, reason });
});

// exitMonitor watches live ticks for every monitored trade (both in-app
// target/SL monitoring and the watch-only mode used for GTT/bracket trades'
// live P&L) but has no way to call bookkeeping directly (circular import -
// see exitMonitor.ts's onPriceUpdate comment). Without this, a monitored
// trade's lastTradePrice kept updating in memory but nothing ever told
// /positionstream's already-connected clients to re-fetch and push it - the
// displayed price only changed on the next unrelated trade event (fill/close/
// target-SL edit), not on the price tick itself.
exitMonitor.onPriceUpdate(() => bookkeeping.triggerPositionsChanged());

// AntOrderNotifyStream.connect() throws (rather than retrying) when the ANT
// session isn't there yet or was issued on an earlier day (ANT.loadSession
// already discards those) - getUserSession() is null in exactly that case, so
// gate on it instead of letting connect() fail every time this process starts
// before the day's ANT login has happened.
function connectAntOrderNotifyIfSessionValid(context: string): void {
    if (!ANT.getInstance().getUserSession()) {
        Log.log(`[order] ANT session not valid for today (${context}) - skipping AntOrderNotifyStream connect until next ANT login`);
        return;
    }
    AntOrderNotifyStream.getInstance().connect().catch((e) => Log.log('[order] AntOrderNotifyStream connect failed (ANT fills will not resolve until this connects):', e));
}

// Same gating reasoning as connectAntOrderNotifyIfSessionValid above, adapted
// for Breeze's async hasValidSession() (a REST round-trip, unlike ANT's
// synchronous local session-file check) - waitForBreezeFill's push path
// (breezeExecutor.ts) silently degrades to REST polling if this never
// connects, so a failed/skipped connect here is non-fatal, just slower fills.
async function connectBreezeOrderNotifyIfSessionValid(context: string): Promise<void> {
    if (!(await Breeze.getInstance().hasValidSession())) {
        Log.log(`[order] Breeze session not valid (${context}) - skipping BreezeOrderNotifyStream connect until next Breeze login`);
        return;
    }
    BreezeOrderNotifyStream.getInstance().connect().catch((e) => Log.log('[order] BreezeOrderNotifyStream connect failed (Breeze fills will fall back to REST polling):', e));
}

// Shared guard for every buy-style request type: check canPlaceOrder, reserve
// the slot via bookkeeping.markPending() (so a concurrent request for the same
// user sees the reservation - see bookkeeping.markPending's doc comment), then
// run the actual broker call.
//
// On success, the broker call itself is responsible for releasing the
// reservation - synchronously, via bookkeeping.recordFill, for every market
// order here; asynchronously, later, via pollPendingLimitOrders'/
// pollPendingBreezeLimitOrders' recordFill, for placeLimitBuyBare specifically.
// Either way this function must
// NOT release on success, or it would double-release / release too early for
// the limit-order case.
//
// On a thrown/rejected broker call, release it here - this is the leak fix:
// previously pendingUsers was never cleared on this path, so a single failed
// order (broker rejection, network error, waitForFill timeout) permanently
// blocked that user's future orders until process restart.
// chunkedBuyIndex's quantity: -1 convention - "spend whatever maxInvestment
// headroom is left" instead of a fixed quantity. Resolved here, once a
// broker-specific price estimate exists, rather than in BulkPcrStrategy
// itself (which never sees per-broker pricing - see chunkedBuyIndex's
// payload). Returns a lot-aligned quantity, or an error string when there's
// no headroom (or the computed quantity would be 0 for some other reason),
// so callers can respond with ok:false instead of placing a zero-quantity
// order.
// Which broker a given request's canPlaceOrder/markPending/releasePending
// reservation should be scoped to - maxInvestment is now checked per (user,
// broker), not pooled across every broker a multi-broker strategy
// pseudo-user trades under (see bookkeeping.canPlaceOrder's own comment).
// Matches each request type's own actual broker dispatch: the explicit-
// broker families (antXxx, breezeBuyIndex, buyContract/prism) always trade
// that one broker regardless of the user's configured default, so they're
// hardcoded here rather than resolved from bookkeeping.getUserBroker, which
// would give the wrong answer for a user whose default broker setting
// differs from the broker this specific request type always uses.
// chunkedBuyIndex/butterflyBuyLeg/butterflySellToOpen already carry an
// explicit `broker` field in their payload (multi-broker-per-user support -
// see orderProtocol.ts's own comments on those types) - use it when present.
// Every other (single-implicit-broker-per-user) type falls back to
// bookkeeping.getUserBroker(userId), identical to how its own handler
// resolves which broker to actually call.
function resolveRequestBroker(req: OrderRequest): string {
    switch (req.type) {
        case 'antBuyIndex':
        case 'antManualBuy':
        case 'antPlaceCoverOrder':
        case 'antBuyTargetOnly':
        case 'antBuyContractBare':
            return 'ant';
        case 'breezeBuyIndex':
            return 'breeze';
        case 'buyContract':
            return 'prism';
        case 'chunkedBuyIndex':
        case 'butterflyBuyLeg':
        case 'butterflySellToOpen':
            return req.payload?.broker ?? bookkeeping.getUserBroker(req.userId);
        default:
            return bookkeeping.getUserBroker(req.userId);
    }
}

// `knownLotSize` is the contract's own lot size as resolved by that broker's contract master
// (AntContractMaster/ZerodhaContractMaster/BreezeContractMaster all already carry it on the
// resolved contract) - preferred over bookkeeping.getInstrumentLotSize(tsym), which only
// recognizes BANKNIFTY/FINNIFTY by name and silently falls back to 65 (NIFTY's lot size) for
// everything else, including SENSEX (actual lot size 20). That mismatch sized a real SENSEX
// order at 325 (5 x 65) instead of a multiple of 20 and got REJECTED at the broker (live
// 2026-10-21, BulkPcr-SENSEX's 11:05 slot, quantity=-1) - PrismContractMaster.findATMOption
// doesn't return a lot size today, so its caller omits knownLotSize and this still falls back
// to the guess for that one broker.
function resolveChunkedBuyQuantity(req: OrderRequest, pricePerUnit: number, tsym: string, knownLotSize?: number): { quantity: number; error?: undefined } | { quantity?: undefined; error: string } {
    if (req.payload.quantity !== -1) return { quantity: req.payload.quantity };
    const broker = resolveRequestBroker(req);
    const lotSize = knownLotSize && knownLotSize > 0 ? knownLotSize : bookkeeping.getInstrumentLotSize(tsym);
    const quantity = bookkeeping.resolveMaxInvestmentQuantity(req.userId, pricePerUnit, lotSize, broker);
    if (quantity <= 0) {
        return { error: `chunkedBuyIndex: quantity=-1 but no available investment headroom to size an order from (broker=${broker}, maxInvestment=${bookkeeping.getUserMaxInvestment(req.userId)}, current=${bookkeeping.getCurrentInvestment(req.userId, broker)}, price=${pricePerUnit})` };
    }
    return { quantity };
}

async function placeOrderWithPendingGuard(
    req: OrderRequest,
    estimatedOrderValue: number | undefined,
    place: () => Promise<any>,
): Promise<OrderResponse> {
    // See reconcileInFlight's comment on 'openTrades' below - this is the
    // function that actually gates every real buy (buyIndex/antBuyIndex/
    // breezeBuyIndex/chunkedBuyIndex/manualBuy/buyContract/antManualBuy/
    // antPlaceCoverOrder all funnel through it), so it needs the same guard
    // 'canPlaceOrder'/'squareOff'/'openTrades' already have - otherwise a buy
    // arriving mid-reconcile can approve itself against still-incomplete
    // bookkeeping.trades, reopening the exact doubled-quantity failure mode
    // the reconcileInFlight mechanism exists to close.
    if (reconcileInFlight) await reconcileInFlight;
    const broker = resolveRequestBroker(req);
    // Startup and login no longer reconcile, so bookkeeping.trades can be empty
    // while the broker still holds a live position. Refuse new entries on a
    // reconcilable broker until POST /reconcile has restored it - otherwise a
    // buy could double up a position the app simply doesn't know about yet.
    if (isReconcilableBroker(broker) && !brokerReconciled[broker]) {
        return { kind: 'response', id: req.id, ok: false, error: `${broker}: broker positions not reconciled since startup - run POST /reconcile before placing new entries on this broker` };
    }
    const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedOrderValue, broker);
    if (!validation.allowed) {
        return { kind: 'response', id: req.id, ok: false, error: validation.reason };
    }
    bookkeeping.markPending(req.userId, estimatedOrderValue, broker);
    try {
        const result = await place();
        return { kind: 'response', id: req.id, ok: true, result };
    } catch (e) {
        bookkeeping.releasePending(req.userId, broker);
        throw e;
    }
}

// Cancels any resting limit-sell order(s) tracked for this user+tsym before a
// force-close path market-sells the same still-open quantity - added
// 2026-09-22 alongside chunkedSquareOffLimit (BulkPcrStrategy's target-hit
// exit, which now leaves a limit sell resting indefinitely instead of
// filling near-instantly like the old market order it replaced). Without
// this, a drawdown-breach or expiry-day force-close firing while that
// resting order is still live would place a SECOND, independent sell for the
// same quantity - an oversell if both filled. Module-scoped (not nested
// inside main()) so handleRequest's 'cancelRestingLimitSells' IPC case
// (BulkPcrStrategy's hedge hand-off, see antLegOps.ts) can call it too.
//
// Returns filledQty: the TOTAL quantity, across every resting Sell order
// found for this tsym, that was confirmed already filled during cancellation
// (each broker's cancelOrderOnX throws OrderAlreadyFilledError specifically
// for this - see BrokerExecutor.ts). Per-order, not a single yes/no for the
// whole tsym (confirmed via code review: an earlier version collapsed this
// to one boolean, which meant ONE filled chunk of a multi-chunk
// squareOffLimitChunked position - see chunkedOrder.ts - made the caller
// skip the force-close for the ENTIRE trade, leaving any OTHER still-open
// chunk unprotected). Callers MUST subtract filledQty from trade.quantity
// before calling squareOff, and skip it entirely only if that leaves nothing
// left - never "proceed anyway" with the stale pre-fill trade.quantity, or
// they double-sell the portion that already closed.
//
// Returns cancelFailed: true if any cancel attempt failed for a reason OTHER
// than "already filled" (already gone, genuinely still open, network
// hiccup). A cancel failing for that reason means the resting order's true
// state is unknown - the pending-order poller self-heals its own tracking
// within 15s regardless, so the drawdown-breach/expiry-squareoff force-close
// paths below still proceed anyway for that order's quantity, but
// BulkPcrStrategy's hedge hand-off (cancelRestingLimitSells's caller) must
// NOT adopt the root leg on a failed cancel - see BulkPcrStrategy.ts's
// handOff.
async function cancelAnyRestingLimitSell(executor: BrokerExecutor, userId: string, tsym: string): Promise<{ filledQty: number; cancelFailed: boolean }> {
    // Selects ONLY the tracker for executor.brokerName, not all four merged
    // together - BulkPcrAutoStartStrategy can now hold simultaneous
    // ant+prism positions on the identical tsym (both Noren/Omnesys-family
    // contract-symbol formats) under the same userId. Merging every
    // tracker's matches by tsym alone (as this used to) would hand a
    // Prism-tracked order id to antExecutor.cancelOrder() (or vice versa)
    // whenever both brokers happened to have a resting sell on the same
    // symbol at once - a foreign order id sent to the wrong broker's cancel
    // API, silently relying on that broker's API to reject it rather than on
    // correct routing.
    const pendingByBroker: Record<string, { orderId: string; action: string; quantity: number }[]> = {
        zerodha: findPendingZerodhaOrdersForSymbol(userId, tsym),
        breeze: findPendingBreezeOrdersForSymbol(userId, tsym),
        ant: findPendingAntOrdersForSymbol(userId, tsym),
        prism: findPendingPrismOrdersForSymbol(userId, tsym),
    };
    const pending = (pendingByBroker[executor.brokerName] ?? []).filter((o) => o.action === 'Sell');
    let filledQty = 0;
    let cancelFailed = false;
    for (const order of pending) {
        try {
            await executor.cancelOrder(order.orderId);
            Log.log(`[order] cancelAnyRestingLimitSell: cancelled resting limit sell ${order.orderId} for ${tsym} (${userId}) ahead of a force-close`);
        } catch (e) {
            if (e instanceof OrderAlreadyFilledError) {
                // e.filledQuantity is the broker-confirmed actual fill - may
                // be LESS than order.quantity (a genuine partial fill whose
                // remainder was cancelled, not filled). Using order.quantity
                // here would wrongly exclude that still-open remainder from
                // the force-close below, leaving it unprotected - see
                // gaps.md's "Partial-fill accounting" entry.
                filledQty += e.filledQuantity;
                Log.log(`[order] cancelAnyRestingLimitSell: ${order.orderId} (${tsym}, ${userId}) already filled qty=${e.filledQuantity}/${order.quantity} - excluding filled portion from force-close`);
            } else {
                cancelFailed = true;
                Log.log(`[order] cancelAnyRestingLimitSell: cancel failed for ${order.orderId} (${tsym}, ${userId}) - proceeding with force-close anyway:`, e);
            }
        }
    }
    return { filledQty, cancelFailed };
}

// Shared by the drawdown-breach liquidation and the expiry-day sweep so the two can never both
// square off the same position. A key is held from the moment a force-close starts until the
// trade has left bookkeeping.trades (its sell fill was booked) or FORCE_CLOSE_COOLDOWN_MS has
// passed - a squareoff call returning does not mean the sell has filled, so releasing on return
// would let the next sweep tick (or a second breach event) sell the same position again.
// A failed attempt releases at once so it is retried.
const FORCE_CLOSE_COOLDOWN_MS = 2 * 60_000;
// Keyed by the trade row itself (not user+token): a position split into chunks has several rows
// with the same token, and each must be force-closed.
const forceCloseStartedAt = new Map<Trade, number>();
function forceCloseActive(trade: Trade): boolean {
    const startedAt = forceCloseStartedAt.get(trade);
    if (startedAt === undefined) return false;
    if (!bookkeeping.trades.includes(trade) || Date.now() - startedAt > FORCE_CLOSE_COOLDOWN_MS) {
        forceCloseStartedAt.delete(trade);
        return false;
    }
    return true;
}
// Short-leg guard key, shared by the breach handler and the expiry sweep.
function shortCloseKey(t: { user: string; token: any }): string {
    return `${t.user}:${t.token}:short`;
}

// Cancels any resting limit sell for the trade, then sells what is left. Returns false when it
// skipped because a force-close for this trade is already underway.
async function forceCloseTrade(trade: Trade): Promise<boolean> {
    if (forceCloseActive(trade)) {
        Log.log(`[order] forceCloseTrade: skipped ${trade.tsym} (${trade.user}) - a force-close is already in progress; will be retried by the next sweep once it expires`);
        return false;
    }
    forceCloseStartedAt.set(trade, Date.now());
    try {
        const executor = getBrokerExecutor(trade.user, trade.broker);
        // Quantity BEFORE the cancel: the pending-order poller may book a fill (shrinking
        // trade.quantity) while the cancel is in flight, and cancelAnyRestingLimitSell's
        // filledQty would then be subtracted a second time. The smaller of the two views is
        // correct in both orderings (fill booked during the cancel, or not yet booked).
        const quantityBefore = trade.quantity;
        const { filledQty: alreadyFilledQty } = await cancelAnyRestingLimitSell(executor, trade.user, trade.tsym);
        const remainingQty = Math.min(trade.quantity, quantityBefore - alreadyFilledQty);
        if (remainingQty <= 0) {
            // Key stays held (bounded by the cooldown) so the next sweep does not sell a position whose fill is not booked yet.
            Log.log(`[order] forceCloseTrade: ${trade.tsym} (${trade.user}) fully covered by already-filled sells - nothing to sell`);
            return true;
        } // see cancelAnyRestingLimitSell's comment - would double-sell
        // Trade has no `exchange` field - inferred from tsym (SENSEX = BFO).
        const exchange: 'NFO' | 'BFO' = trade.tsym?.startsWith('SENSEX') ? 'BFO' : 'NFO';
        await executor.squareOff(trade.user, trade.tsym, remainingQty, exchange);
        return true;
    } catch (e) {
        forceCloseStartedAt.delete(trade);
        throw e;
    }
}

// Read-only strike+right -> contract lookup, dispatched per-broker to each broker's own
// contract master. Used by ButterflyStrategy to resolve all 4 of its legs before placing
// anything. ant's findNearestExpiryOption returns `exch` (renamed to `exchange` here for a
// uniform return shape across all 4 brokers). Prism's contract master carries no exchange
// field at all - hardcoded here, same as the 'BFO' fallback below.
async function resolveOptionContractForBroker(
    broker: 'zerodha' | 'ant' | 'breeze' | 'prism',
    index: 'NIFTY' | 'SENSEX',
    strike: number,
    right: 'CE' | 'PE'
): Promise<{ tsym: string; token: string; exchange: 'NFO' | 'BFO' }> {
    if (broker === 'ant') {
        const exch = index === 'SENSEX' ? 'BFO' : 'NFO';
        const r = AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch, strike, optionType: right, expiryOffset: 0 });
        return { tsym: r.tradingSymbol, token: r.token, exchange: r.exch as 'NFO' | 'BFO' };
    }
    if (broker === 'zerodha') {
        // trade.token/tick subscriptions must always carry the ANT common token, never
        // Zerodha's own instrument_token - ANT is the sole live-tick source and the only
        // thing exitMonitor/tokenRouter's subscriptions understand (see ToDo.md 2026-08-27
        // and AntContractMaster's own comment on this exact invariant). Zerodha's
        // instrumentToken is discarded here; getMarketableZerodhaPrice also needs the ANT
        // token specifically, since ANT is the price source Zerodha orders are priced from.
        const r = await ZerodhaContractMaster.getInstance().findNearestExpiryOption(strike, right, index, 0);
        const exch = index === 'SENSEX' ? 'BFO' : 'NFO';
        const antMatch = AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch, strike, optionType: right, expiryOffset: 0 });
        return { tsym: r.tradingSymbol, token: antMatch.token, exchange: r.exchange };
    }
    if (broker === 'breeze') {
        const exch = index === 'SENSEX' ? 'BFO' : 'NFO';
        const r = await BreezeContractMaster.getInstance().findNearestExpiryOption(strike, right, index);
        const antMatch = AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch, strike, optionType: right, expiryOffset: 0 });
        return { tsym: tsymFor(r), token: antMatch.token, exchange: exch };
    }
    if (broker === 'prism') {
        // Prism's own contract master (NFO_symbols.txt) carries no exchange field and is a
        // DIFFERENT token scheme from ANT's (confirmed: it's the Shoonya/Prism token, not
        // cross-referenced) - resolve ANT's token separately, same as the zerodha/breeze
        // branches above, so trade.token/tick subscriptions are always ANT-keyed (every
        // live tick in this codebase, across every broker, flows through ANT - see
        // BulkPcrStrategy's watchTokenOnSource('ant', ...) calls, the only live multi-
        // broker precedent in this codebase).
        const exch = index === 'SENSEX' ? 'BFO' : 'NFO';
        const r = PrismContractMaster.getInstance().findNearestExpiryOption(index, strike, right, 0);
        const antMatch = AntContractMaster.getInstance().findNearestExpiryOption({ symbol: index, exch, strike, optionType: right, expiryOffset: 0 });
        return { tsym: r.tradingSymbol, token: antMatch.token, exchange: exch };
    }
    throw new Error(`resolveOptionContractForBroker: unsupported broker ${broker}`);
}

// Force-closes one ButterflyStrategy short leg (bookkeeping.shortTrades entry) via
// buy-to-close - used by the drawdown-breach and expiry-day safety nets, which otherwise
// only ever iterate bookkeeping.trades (long-only) and would leave a short leg completely
// unprotected. `shortTrade.broker` is always set by recordShortFill's callers; exchange is
// inferred from tsym, mirroring the same SENSEX/BFO convention used elsewhere in this file
// (onFill, resolveOptionContractForBroker) since Trade carries no exchange field of its own.
async function buyToCloseShortLegForUser(user: string, shortTrade: Trade): Promise<void> {
    const broker = shortTrade.broker;
    const exchange: 'NFO' | 'BFO' = shortTrade.tsym?.startsWith('SENSEX') ? 'BFO' : 'NFO';
    if (broker === 'zerodha') await buyToCloseOnZerodha(user, shortTrade.tsym, shortTrade.token, shortTrade.quantity, exchange);
    else if (broker === 'ant') await antExecutor.buyToClosePosition(user, shortTrade.tsym, shortTrade.token, shortTrade.quantity, exchange);
    else if (broker === 'breeze') await buyToCloseOnBreeze(user, shortTrade.tsym, shortTrade.token, shortTrade.quantity, exchange);
    else if (broker === 'prism') await prismExecutor.buyToClosePrism(user, shortTrade.tsym, shortTrade.token, shortTrade.quantity, exchange);
    else throw new Error(`buyToCloseShortLegForUser: unsupported/missing broker '${broker}' for ${shortTrade.tsym}`);
}

async function handleRequest(req: OrderRequest): Promise<OrderResponse> {
    try {
        switch (req.type) {
            case 'canPlaceOrder':
                // See reconcileInFlight's comment on 'openTrades' below - a
                // canPlaceOrder check reading bookkeeping.trades mid-reconcile
                // could approve a duplicate entry for a position that's still
                // being restored.
                if (reconcileInFlight) await reconcileInFlight;
                return { kind: 'response', id: req.id, ok: true, result: await bookkeeping.canPlaceOrder(req.userId) };

            case 'buyIndex': {
                return await placeOrderWithPendingGuard(req, undefined, () => {
                    const broker = bookkeeping.getUserBroker(req.userId);
                    return broker === 'ant'
                        ? antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload })
                        : buyIndexOnZerodha({ userId: req.userId, ...req.payload });
                });
            }

            case 'squareOff': {
                // /prism/squareoff historically took a broker `token`, not a
                // trading symbol - resolve it against the live position so
                // callers can keep passing whatever token /openTrades gave them
                // (Zerodha's instrumentToken now, not the old Prism/ANT token
                // space, but the same "look up by what the client already has"
                // shape).
                // See reconcileInFlight's comment on 'openTrades' below - a
                // squareOff resolving/sizing itself from bookkeeping.trades
                // mid-reconcile could miss or mis-size the trade it's trying
                // to close.
                if (reconcileInFlight) await reconcileInFlight;
                let { tsym, quantity, exchange, token } = req.payload;
                if (!tsym && token) {
                    const trade = bookkeeping.trades.find((t) => t.token === String(token) && t.user === req.userId);
                    if (!trade) return { kind: 'response', id: req.id, ok: false, error: `No open trade found for token ${token}` };
                    tsym = trade.tsym;
                    quantity = quantity ?? trade.quantity;
                }
                const trade = await getBrokerExecutor(req.userId).squareOff(req.userId, tsym, quantity, exchange);
                return { kind: 'response', id: req.id, ok: true, result: trade };
            }

            case 'antBuyIndex': {
                return await placeOrderWithPendingGuard(req, undefined, () =>
                    antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload }),
                );
            }

            case 'breezeBuyIndex': {
                return await placeOrderWithPendingGuard(req, undefined, () =>
                    buyIndexOnBreeze({ userId: req.userId, ...req.payload }),
                );
            }

            // Dedicated Breeze square-off, bypassing getBrokerExecutor's
            // per-user broker lookup (see brokerExecutors.getBrokerExecutor) -
            // used directly by the /breeze/order/squareoff debug route, which
            // always knows it's closing a Breeze position regardless of
            // whatever the caller's bookkeeping.getUserBroker setting says.
            case 'breezeSquareOff': {
                // See reconcileInFlight's comment on 'openTrades' below - same
                // risk as 'squareOff'/'antSquareOff': squareOffOnBreeze
                // resolves the position from bookkeeping.trades too.
                if (reconcileInFlight) await reconcileInFlight;
                const trade = await squareOffOnBreeze(req.userId, req.payload.tsym, req.payload.quantity);
                return { kind: 'response', id: req.id, ok: true, result: trade };
            }

            // Broker-agnostic freeze-quantity-chunked buy/squareoff (see
            // chunkedOrder.ts) - BulkPcrStrategy's use case (13975 qty, over
            // NIFTY's 1755 exchange freeze cap). Breeze and Zerodha are wired
            // up; the getBrokerExecutor(...) dispatch already makes extending
            // to other brokers additive, not a rewrite.
            case 'chunkedBuyIndex': {
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const optionType = req.payload.right === CALL ? 'CE' : 'PE';

                if (executor.brokerName === 'breeze') {
                    // Real pre-trade valuation (unlike breezeBuyIndex's `undefined`) -
                    // this order is large enough that maxInvestment/perOrderCap must
                    // actually gate it, not just record it after the fact.
                    //
                    // Uses the caller-supplied niftyLtp (ANT-sourced, same as the
                    // zerodha branch below) instead of an independent Breeze spot
                    // quote, and getMarketableBreezeBuyPrice (also ANT-sourced) for
                    // the option premium estimate - Breeze's own getQuotes has been
                    // observed live 2026-09-23 returning a generic nginx "resource
                    // unavailable" page (session/auth endpoints kept working in the
                    // same window, so this is API/infra flakiness, not an auth
                    // problem), and req.payload.niftyLtp was already available here
                    // for free either way.
                    const niftyLtp = req.payload.niftyLtp;
                    if (!Number.isFinite(niftyLtp)) {
                        return { kind: 'response', id: req.id, ok: false, error: 'chunkedBuyIndex (breeze): niftyLtp is required and must be a finite number' };
                    }
                    // index threaded through (not hardcoded NIFTY) - a SENSEX-configured instance resolves a BFO
                    // contract against the SENSEX spot it passes as niftyLtp, same as the zerodha/ant/prism branches.
                    const index = req.payload.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
                    const contract = await BreezeContractMaster.getInstance().findATMOption(niftyLtp, optionType, index);
                    const buyPrice = await getMarketableBreezeBuyPrice(contract);
                    const resolvedQty = resolveChunkedBuyQuantity(req, buyPrice, tsymFor(contract), contract.lotSize);
                    if (resolvedQty.error) return { kind: 'response', id: req.id, ok: false, error: resolvedQty.error };
                    const quantity = resolvedQty.quantity;
                    const estimatedOrderValue = quantity * buyPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: tsymFor(contract),
                                instrumentId: contract.token,
                                quantity,
                                exchange: contract.exchange,
                            },
                            req.payload.freezeQuantity
                        );
                        return { tsym: tsymFor(contract), token: contract.token, ...result };
                    });
                }

                if (executor.brokerName === 'zerodha') {
                    // Live option ticks for a zerodha-routed strategy arrive over the
                    // ANT feed, not Zerodha's own (tokenRouter.ts's resolveSource maps
                    // broker 'zerodha' -> feed 'ant'), so the token recorded on the
                    // Trade - and therefore what registerTrade subscribes to and what
                    // the strategy's canHandleOptionQuote matches against - must be
                    // ANT's commonToken, not ZerodhaContractMaster's instrumentToken.
                    // Mirrors buyIndexOnZerodha's exact same resolution.
                    const niftyLtp = req.payload.niftyLtp;
                    if (!Number.isFinite(niftyLtp)) {
                        return { kind: 'response', id: req.id, ok: false, error: 'chunkedBuyIndex (zerodha): niftyLtp is required and must be a finite number' };
                    }
                    // index threaded through exactly like the ant branch below - found on review:
                    // this used to hardcode 'NIFTY' regardless of req.payload.index, which for a
                    // SENSEX-configured instance would resolve a NIFTY contract (wrong strike/
                    // exchange entirely) against a SENSEX spot price.
                    const index = req.payload.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
                    const contract = await ZerodhaContractMaster.getInstance().findATMOption(niftyLtp, optionType, index);
                    const commonToken = String(AntContractMaster.getInstance().resolveCommonToken(index, optionType, { atmLtp: niftyLtp }));
                    // Strike step mirrors ZerodhaContractMaster.findATMOption's own rounding -
                    // needed here only for the pre-trade price estimate.
                    const step = AntContractMaster.STRIKE_STEP[index] ?? 50;
                    const atmStrike = Math.round(niftyLtp / step) * step;
                    const estimatedPrice = await antExecutor.estimateOptionPrice(index, atmStrike, optionType);
                    const resolvedQty = resolveChunkedBuyQuantity(req, estimatedPrice, contract.tradingSymbol, contract.lotSize);
                    if (resolvedQty.error) return { kind: 'response', id: req.id, ok: false, error: resolvedQty.error };
                    const quantity = resolvedQty.quantity;
                    const estimatedOrderValue = quantity * estimatedPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: contract.tradingSymbol,
                                instrumentId: commonToken,
                                quantity,
                                exchange: contract.exchange,
                                driftCancelPoints: req.payload.driftCancelPoints,
                            },
                            req.payload.freezeQuantity
                        );
                        return { tsym: contract.tradingSymbol, token: commonToken, ...result };
                    });
                }

                if (executor.brokerName === 'ant') {
                    // AntContractMaster resolves directly (no separate
                    // commonToken-resolution step like the zerodha branch
                    // above needs - ANT's own token IS the live-tick token
                    // here, since this order executes on ANT itself).
                    const niftyLtp = req.payload.niftyLtp;
                    if (!Number.isFinite(niftyLtp)) {
                        return { kind: 'response', id: req.id, ok: false, error: 'chunkedBuyIndex (ant): niftyLtp is required and must be a finite number' };
                    }
                    const index = req.payload.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
                    const contract = AntContractMaster.getInstance().findATMOption(niftyLtp, optionType, index);
                    const step = AntContractMaster.STRIKE_STEP[index] ?? 50;
                    const atmStrike = Math.round(niftyLtp / step) * step;
                    const estimatedPrice = await antExecutor.estimateOptionPrice(index, atmStrike, optionType);
                    const resolvedQty = resolveChunkedBuyQuantity(req, estimatedPrice, contract.tradingSymbol, Number(contract.lotSize));
                    if (resolvedQty.error) return { kind: 'response', id: req.id, ok: false, error: resolvedQty.error };
                    const quantity = resolvedQty.quantity;
                    const estimatedOrderValue = quantity * estimatedPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: contract.tradingSymbol,
                                instrumentId: contract.token,
                                quantity,
                                exchange: contract.exch as 'NFO' | 'BFO',
                                driftCancelPoints: req.payload.driftCancelPoints,
                            },
                            req.payload.freezeQuantity
                        );
                        return { tsym: contract.tradingSymbol, token: contract.token, ...result };
                    });
                }

                if (executor.brokerName === 'prism') {
                    // PrismContractMaster has no live-tick concept of its own -
                    // this order's fill/exit still flows through bookkeeping
                    // keyed by this tsym/token like every other broker. Pricing
                    // estimate reuses ANT (same reasoning as the zerodha/ant
                    // branches above - Prism has no reliable live quote path of
                    // its own wired in here).
                    const niftyLtp = req.payload.niftyLtp;
                    if (!Number.isFinite(niftyLtp)) {
                        return { kind: 'response', id: req.id, ok: false, error: 'chunkedBuyIndex (prism): niftyLtp is required and must be a finite number' };
                    }
                    // index threaded through exactly like the ant/zerodha branches above - found on
                    // review: this used to hardcode 'NIFTY' regardless of req.payload.index, which for
                    // a SENSEX-configured instance would resolve a NIFTY contract against a SENSEX
                    // spot price (PrismContractMaster.STRIKE_STEP's own comment already flagged this
                    // exact gap). exchange derived the same way AntContractMaster/ZerodhaContractMaster
                    // do elsewhere - PrismContractMaster.findATMOption doesn't return one.
                    const index = req.payload.index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
                    const prismExchange = index === 'SENSEX' ? 'BFO' : 'NFO';
                    const contract = PrismContractMaster.getInstance().findATMOption(niftyLtp, optionType, index);
                    const step = AntContractMaster.STRIKE_STEP[index] ?? 50;
                    const atmStrike = Math.round(niftyLtp / step) * step;
                    const estimatedPrice = await antExecutor.estimateOptionPrice(index, atmStrike, optionType);
                    const resolvedQty = resolveChunkedBuyQuantity(req, estimatedPrice, contract.tradingSymbol);
                    if (resolvedQty.error) return { kind: 'response', id: req.id, ok: false, error: resolvedQty.error };
                    const quantity = resolvedQty.quantity;
                    const estimatedOrderValue = quantity * estimatedPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: contract.tradingSymbol,
                                instrumentId: contract.token,
                                quantity,
                                exchange: prismExchange,
                                driftCancelPoints: req.payload.driftCancelPoints,
                            },
                            req.payload.freezeQuantity
                        );
                        return { tsym: contract.tradingSymbol, token: contract.token, ...result };
                    });
                }

                return { kind: 'response', id: req.id, ok: false, error: `chunkedBuyIndex: broker '${executor.brokerName}' not yet supported (breeze/zerodha/ant/prism only)` };
            }

            case 'chunkedSquareOff': {
                // See reconcileInFlight's comment on 'openTrades' below -
                // squareOffChunked's underlying executor.squareOff resolves
                // from bookkeeping.trades same as the plain 'squareOff' case,
                // and (unlike breezeSquareOff's live-broker fallback) throws
                // outright on a miss, so a position genuinely open at the
                // broker could otherwise be reported as needing manual
                // review purely because reconcile hadn't finished yet.
                if (reconcileInFlight) await reconcileInFlight;
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const result = await squareOffChunked(executor, req.userId, req.payload.tsym, req.payload.quantity, req.payload.tsym.startsWith('SENSEX') ? 'BFO' : 'NFO', req.payload.freezeQuantity);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'chunkedSquareOffLimit': {
                // Same reasoning as 'chunkedSquareOff' above - this is
                // BulkPcrStrategy's actual target-hit exit path.
                if (reconcileInFlight) await reconcileInFlight;
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const result = await squareOffLimitChunked(
                    executor,
                    req.userId,
                    req.payload.tsym,
                    req.payload.instrumentId,
                    req.payload.quantity,
                    req.payload.tsym.startsWith('SENSEX') ? 'BFO' : 'NFO',
                    req.payload.price,
                    req.payload.freezeQuantity
                );
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getPendingSells': {
                // Broker-uniform: dispatch to whichever tracker owns this broker's pending
                // orders, filter to SELL generically here (not per-tracker) since all four
                // trackers already share the same {quantity, action, ...} shape.
                const findFns: Record<string, (userId: string, tsym: string) => { quantity: number; action: 'Buy' | 'Sell' }[]> = {
                    ant: findPendingAntOrdersForSymbol,
                    zerodha: findPendingZerodhaOrdersForSymbol,
                    breeze: findPendingBreezeOrdersForSymbol,
                    prism: findPendingPrismOrdersForSymbol,
                };
                const find = findFns[req.payload.broker];
                const result = find ? find(req.userId, req.payload.tradingSymbol).filter((o) => o.action === 'Sell') : [];
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'antManualBuy': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload }),
                );
            }

            case 'antPlaceCoverOrder': {
                return placeOrderWithPendingGuard(req, undefined, () =>
                    antExecutor.placeCoverOrderForGapScreener(
                        req.userId,
                        req.payload.tradingSymbol,
                        req.payload.instrumentId,
                        req.payload.quantity,
                        req.payload.exchange,
                        req.payload.stopLossPoints,
                    ),
                );
            }

            case 'antSquareOff': {
                // See reconcileInFlight's comment on 'openTrades' below - same
                // risk as the plain 'squareOff' case above: resolving/sizing
                // from bookkeeping.trades mid-reconcile could miss or
                // mis-size the trade it's trying to close.
                if (reconcileInFlight) await reconcileInFlight;
                let { tsym, quantity, exchange, token } = req.payload;
                if (!tsym && token) {
                    const trade = bookkeeping.trades.find((t) => t.token === String(token) && t.user === req.userId);
                    if (!trade) return { kind: 'response', id: req.id, ok: false, error: `No open trade found for token ${token}` };
                    tsym = trade.tsym;
                    quantity = quantity ?? trade.quantity;
                }
                const trade = await antExecutor.squareOffOnAnt(req.userId, tsym, quantity, exchange);
                return { kind: 'response', id: req.id, ok: true, result: trade };
            }

            case 'antSetTargetStopLoss': {
                await antExecutor.setTargetStopLoss(req.userId, req.payload.token, req.payload.targetPoints, req.payload.stopLossPoints);
                return { kind: 'response', id: req.id, ok: true };
            }

            // See orderProtocol.ts's comment on these two request types - ANT-
            // specific, not broker-generic, because TopStockOptionsOpeningGapStrategy
            // (the only caller) runs in the `strategies` process and needs these
            // to actually execute inside `order`, where antExecutor.ts's
            // singletons live.
            case 'antBuyTargetOnly': {
                const { tradingSymbol, instrumentId, quantity, exchange, underlyingOpen, marketProtectionPercent, product } = req.payload;
                // No pre-trade option LTP any more, so no value estimate (same as 'buyIndex').
                return placeOrderWithPendingGuard(req, undefined, () =>
                    antExecutor.enterPosition(req.userId, tradingSymbol, instrumentId, quantity, exchange, 0, 0, 'target-only', undefined,
                        { underlyingOpen, marketProtectionPercent: String(marketProtectionPercent), product }),
                );
            }

            case 'antPlaceLimitSellBare': {
                const { tradingSymbol, instrumentId, quantity, price, exchange, product } = req.payload;
                const result = await antExecutor.placeLimitSellBareOnAnt(req.userId, tradingSymbol, instrumentId, quantity, price, exchange, product);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            // Broker-parameterized counterpart of 'antPlaceLimitSellBare' - used by
            // TopStockOptionsOpeningGapStrategy's zerodha/breeze legs, which (unlike
            // ant's antBuyTargetOnly) have no broker-side target computation, so the
            // strategy itself sizes the target and places its own resting sell here.
            // Mechanically identical to each broker's existing bare limit-sell
            // primitive (already used by brokerExecutors.ts's squareOffLimit) - just
            // dispatched by an explicit `broker` field instead of a per-user default.
            case 'brokerPlaceLimitSellBare': {
                const { broker, tradingSymbol, instrumentToken, quantity, price, exchange } = req.payload;
                let result: { orderId: string };
                if (broker === 'zerodha') result = await placeLimitSellBareOnZerodha(req.userId, tradingSymbol, instrumentToken, quantity, price, exchange);
                else if (broker === 'breeze') result = await placeLimitSellBareOnBreeze(req.userId, tradingSymbol, instrumentToken, quantity, price, exchange);
                else if (broker === 'ant') result = await antExecutor.placeLimitSellBareOnAnt(req.userId, tradingSymbol, instrumentToken, quantity, price, exchange);
                else throw new Error(`brokerPlaceLimitSellBare: unsupported broker ${broker}`);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            // ANT-specific bare ops for BulkPcrStrategy's hedge tree (LegManager via
            // antLegOps.ts) - BulkPcr trades on ANT, so the Zerodha/Breeze-only
            // getContractByPriceRangeBare/buyContractBare/etc 'Bare' family above can't
            // be reused for it (see antLegOps.ts's header comment).
            case 'antBuyContractBare': {
                const { tradingSymbol, instrumentId, quantity, exchange } = req.payload;
                return placeOrderWithPendingGuard(req, undefined, () =>
                    antExecutor.enterPosition(req.userId, tradingSymbol, instrumentId, quantity, exchange, 0, 0, 'target-only'),
                );
            }

            case 'antSquareOffBare': {
                const { tradingSymbol, quantity, exchange } = req.payload;
                const result = await antExecutor.squareOffOnAnt(req.userId, tradingSymbol, quantity, exchange);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'antCancelOrderBare': {
                await antExecutor.cancelOrderOnAnt(req.payload.orderId);
                return { kind: 'response', id: req.id, ok: true };
            }

            // Cancels any resting limit sell(s) for this tsym ahead of a hand-off to
            // the hedge tree (BulkPcrStrategy, ANT-only) or a plain invalidation-close
            // (HourlyStrategy, zerodha/ant/breeze) - same closure the drawdown-breach/
            // expiry-squareoff paths below use. Dispatched via the caller-supplied
            // broker rather than hardcoded to 'ant': HourlyStrategy runs zerodha/ant/
            // breeze legs, and forcing a non-ant position's cancel onto the ANT
            // executor would miss the real resting order entirely, letting the
            // market force-close double-sell.
            case 'cancelRestingLimitSells': {
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const result = await cancelAnyRestingLimitSell(executor, req.userId, req.payload.tsym);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            // ButterflyStrategy's narrow sell-to-open exception (see Zerodha.ts's
            // NEVER-SHORT GUARD comment) - the only two IPC cases allowed to open a
            // short position, reachable only from ButterflyStrategy's own code path.
            // Routed through placeOrderWithPendingGuard like every other real-money entry
            // in this file (reconcileInFlight wait + canPlaceOrder loss/lot/investment check +
            // markPending/releasePending dedup) - found on review: this and 'butterflyBuyLeg'
            // below were the only two entry paths in this file that bypassed it entirely.
            case 'butterflySellToOpen': {
                const { broker, tradingSymbol, instrumentToken, quantity, exchange } = req.payload;
                return placeOrderWithPendingGuard(req, undefined, () => {
                    if (broker === 'zerodha') return enterShortOnZerodha(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    if (broker === 'ant') return antExecutor.enterShortPosition(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    if (broker === 'breeze') return enterShortOnBreeze(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    if (broker === 'prism') return prismExecutor.enterShortOnPrism(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    throw new Error(`butterflySellToOpen: unsupported broker ${broker}`);
                });
            }

            // Long-side (buy-to-open) leg, explicit-broker dispatch - see orderProtocol.ts's
            // comment on why this can't reuse 'buyContractBare'/'antBuyContractBare'/'buyContract'
            // directly for a strategy that runs several brokers' legs concurrently. Mechanically
            // identical to each broker's existing "bare" long-entry primitive; records via the
            // normal recordFill (this is an ordinary long, not a short). Routed through
            // placeOrderWithPendingGuard - see 'butterflySellToOpen' comment above.
            case 'butterflyBuyLeg': {
                const { broker, tradingSymbol, instrumentToken, quantity, exchange } = req.payload;
                return placeOrderWithPendingGuard(req, undefined, () => {
                    if (broker === 'zerodha') return marketBuyBareOnZerodha(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    if (broker === 'ant') return antExecutor.enterPosition(req.userId, tradingSymbol, instrumentToken, quantity, exchange, 0, 0, 'target-only');
                    if (broker === 'breeze') return marketBuyBareOnBreeze(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                    if (broker === 'prism') return prismExecutor.buyContract(req.userId, tradingSymbol, quantity);
                    throw new Error(`butterflyBuyLeg: unsupported broker ${broker}`);
                });
            }

            // Long-side (sell-to-close) leg, explicit-broker dispatch - closes a position
            // opened by 'butterflyBuyLeg'. Mechanically identical to each broker's existing
            // "bare" square-off primitive; records via the normal recordFill.
            case 'butterflyCloseLeg': {
                const { broker, tradingSymbol, instrumentToken, quantity, exchange } = req.payload;
                let result: Trade;
                if (broker === 'zerodha') result = await marketSellBareOnZerodha(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                else if (broker === 'ant') result = await antExecutor.squareOffOnAnt(req.userId, tradingSymbol, quantity, exchange);
                else if (broker === 'breeze') result = await marketSellBareOnBreeze(req.userId, tradingSymbol, instrumentToken, quantity, exchange);
                else if (broker === 'prism') result = await prismExecutor.sellContract(req.userId, tradingSymbol, quantity);
                else throw new Error(`butterflyCloseLeg: unsupported broker ${broker}`);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'butterflyBuyToClose': {
                const { broker, tradingSymbol, instrumentToken, exchange } = req.payload;
                let result: Trade;
                if (broker === 'zerodha') result = await buyToCloseOnZerodha(req.userId, tradingSymbol, instrumentToken, req.payload.quantity, exchange);
                else if (broker === 'ant') result = await antExecutor.buyToClosePosition(req.userId, tradingSymbol, instrumentToken, req.payload.quantity, exchange);
                else if (broker === 'breeze') result = await buyToCloseOnBreeze(req.userId, tradingSymbol, instrumentToken, req.payload.quantity, exchange);
                else if (broker === 'prism') result = await prismExecutor.buyToClosePrism(req.userId, tradingSymbol, instrumentToken, req.payload.quantity, exchange);
                else throw new Error(`butterflyBuyToClose: unsupported broker ${broker}`);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            // Read-only strike+right -> contract lookup, dispatched per-broker to each
            // broker's own contract master. Used by ButterflyStrategy to resolve all 4 of
            // its legs before placing anything.
            case 'resolveOptionContract': {
                const { broker, index, strike, right } = req.payload;
                const result = await resolveOptionContractForBroker(broker, index, strike, right);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'buyContract': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    prismExecutor.buyContract(req.userId, req.payload.contract, req.payload.quantity, req.payload.price),
                );
            }

            case 'sellContract': {
                const result = await prismExecutor.sellContract(req.userId, req.payload.contract, req.payload.quantity, req.payload.price);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getContractByPriceRange': {
                const result = await prismExecutor.getContractByPriceRange(req.payload.right);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'calculateRight': {
                const result = await prismExecutor.calculateRight(req.payload.ltp);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getToken': {
                const result = await prismExecutor.getToken(req.payload.contract);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getNiftyQuote': {
                const result = await prismExecutor.getNiftyQuote();
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getOptionQuote': {
                const result = await prismExecutor.getOptionQuote(req.payload.token);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getStockOptionQuote': {
                const result = await prismExecutor.getStockOptionQuote(req.payload.contract);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'stats':
                return {
                    kind: 'response',
                    id: req.id,
                    ok: true,
                    result: {
                        trades: bookkeeping.trades,
                        // ButterflyStrategy's short legs (SellToOpen) live in a separate ledger -
                        // see bookkeeping.recordShortFill's own comment on why. Exposed here so
                        // the position dashboard/trades API doesn't silently omit them - found on
                        // review: they were otherwise invisible everywhere `trades` is read.
                        shortTrades: bookkeeping.shortTrades,
                        closedTrades: bookkeeping.closedTrades,
                        userPnL: Object.fromEntries(bookkeeping.userPnL),
                    },
                };

            case 'manualBuy': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () => {
                    const manualBuyBroker = bookkeeping.getUserBroker(req.userId);
                    return manualBuyBroker === 'ant'
                        ? antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload })
                        : manualBuyOnZerodha({ userId: req.userId, ...req.payload });
                });
            }

            case 'setTargetStopLoss': {
                await setTargetStopLoss(req.userId, req.payload.token, req.payload.targetPoints, req.payload.stopLossPoints);
                return { kind: 'response', id: req.id, ok: true };
            }

            case 'reloadSession': {
                Zerodha.getInstance().reloadSession();
                NorenRestApi.reloadToken();
                ANT.getInstance().reloadSession();
                connectAntOrderNotifyIfSessionValid('reloadSession');
                Breeze.getInstance().reloadSession();
                connectBreezeOrderNotifyIfSessionValid('reloadSession').catch((e) => Log.log('[order] connectBreezeOrderNotifyIfSessionValid failed:', e));
                // Broker-position reconciliation is NOT run here any more - a
                // login no longer triggers it. It's an explicit step, invoked
                // via the 'reconcileBrokerPositions' IPC case (POST /reconcile
                // in server.ts), once the user has checked for open positions.
                return { kind: 'response', id: req.id, ok: true };
            }

            // Live config-reload, called from server.ts's POST /config after every
            // save - re-reads each strategy's broker/maxInvestment/useGTT from
            // config.yml into bookkeeping's settings cache. Safe to call anytime:
            // it only rewrites settings, never touches live trade/position state.
            case 'reloadUserLimits': {
                await loadUserLimits();
                return { kind: 'response', id: req.id, ok: true, result: null };
            }

            case 'refreshTradeList': {
                const result = await prismExecutor.refreshTradeList();
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getOrders': {
                const result = await prismExecutor.getOrders();
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'updateUserSettings': {
                bookkeeping.updateUserSettings(req.userId, req.payload);
                return { kind: 'response', id: req.id, ok: true };
            }

            case 'hasActiveTrade':
                return { kind: 'response', id: req.id, ok: true, result: bookkeeping.hasActiveTrade(req.userId) };

            // Explicit broker-position reconcile - POST /reconcile in server.ts
            // invokes this first, then `strategies`' reconcile (which depends on
            // the restored bookkeeping.trades). Refused before 09:10.
            case 'reconcileBrokerPositions': {
                try {
                    const result = await runBrokerReconcileNow('manual (POST /reconcile)');
                    return { kind: 'response', id: req.id, ok: true, result };
                } catch (e: any) {
                    Log.log('[order] reconcileBrokerPositions failed:', e);
                    return { kind: 'response', id: req.id, ok: false, error: e?.message ?? String(e) };
                }
            }

            case 'openTrades':
                // See reconcileInFlight's comment - waits out a broker-position
                // reconcile still in progress so the caller (e.g.
                // BulkPcrStrategy.reconcile() in the `strategies` process)
                // never reads bookkeeping.trades mid-reconcile.
                if (reconcileInFlight) await reconcileInFlight;
                return { kind: 'response', id: req.id, ok: true, result: bookkeeping.getOpenTrades(req.userId) };

            case 'findToken': {
                const result = await prismExecutor.findToken(req.payload.index, req.payload.depth, req.payload.right);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'injectTrade': {
                // GET /addTrade: manually injects a synthetic fill via the same
                // Prism-websocket-message code path a real broker callback uses.
                const result = await bookkeeping.updateTradeFromPrismMessage(req.payload);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'connectPrism': {
                await prismExecutor.connectPrism();
                return { kind: 'response', id: req.id, ok: true };
            }

            case 'getIndexQuote': {
                const result = await prismExecutor.getIndexQuote(req.payload.index);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getStockQuote': {
                const result = await prismExecutor.getStockQuote(req.payload.symbol);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            // Bare execution path shared by ContinuousStrategy/SupportResistanceStrategy's
            // LegManager - broker-resolved per userId (a strategy's pseudo-user id), the
            // same convention buyIndex/manualBuy/squareOff already use for real users. See
            // bookkeeping.getUserBroker (populated from each strategy's own config.yml
            // `broker` field via loadUserLimits below).
            case 'buyContractBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return await placeOrderWithPendingGuard(req, estimatedValue, () => {
                    const broker = bookkeeping.getUserBroker(req.userId);
                    return broker === 'breeze'
                        ? marketBuyBareOnBreeze(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange)
                        : marketBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange);
                });
            }

            case 'sellContractBare': {
                const broker = bookkeeping.getUserBroker(req.userId);
                const result = broker === 'breeze'
                    ? await marketSellBareOnBreeze(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange)
                    : await marketSellBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'placeLimitBuyBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return await placeOrderWithPendingGuard(req, estimatedValue, () => {
                    const broker = bookkeeping.getUserBroker(req.userId);
                    return broker === 'breeze'
                        ? placeLimitBuyBareOnBreeze(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.price, req.payload.exchange)
                        : placeLimitBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.price, req.payload.exchange);
                });
            }

            case 'cancelOrderBare': {
                const broker = bookkeeping.getUserBroker(req.userId);
                if (broker === 'breeze') await cancelOrderOnBreeze(req.payload.orderId);
                else await cancelOrderOnZerodha(req.payload.orderId);
                return { kind: 'response', id: req.id, ok: true, result: undefined };
            }

            case 'getContractByPriceRangeBare': {
                const broker = bookkeeping.getUserBroker(req.userId);
                const excludeStrikes = new Set<number>(req.payload.excludeStrikes || []);
                const result = broker === 'breeze'
                    ? await getContractByPriceRangeOnBreeze(req.payload.underlyingLtp, req.payload.optionType, req.payload.index, req.payload.minPremium, excludeStrikes)
                    : await getContractByPriceRangeOnZerodha(req.payload.underlyingLtp, req.payload.optionType, req.payload.index, req.payload.minPremium, excludeStrikes);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getPCR': {
                const result = await ANT.getInstance().getOptionChainPCR(req.payload.underlying, req.payload.spot, req.payload.window);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getATMTokens': {
                const result = antExecutor.getATMTokens(req.payload.niftyLtp, req.payload.index);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getUserAllottedCapital': {
                const result = bookkeeping.getUserAllottedCapital(req.userId);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            default:
                return { kind: 'response', id: req.id, ok: false, error: `Unknown request type: ${(req as any).type}` };
        }
    } catch (e: any) {
        Log.log('[order] Request failed:', req.type, e);
        return { kind: 'response', id: req.id, ok: false, error: e?.message ?? String(e) };
    }
}

async function loadUserLimits() {
    configService.reloadNow(); // don't wait on fs.watchFile's own poll - see ConfigService.reloadNow's comment
    const config = configService.getConfig();
    for (const cfg of config.strategies || []) {
        const userId = cfg.userId || cfg.type;
        const mongoUser = await getUser(userId).catch(() => null);
        bookkeeping.updateUserSettings(userId, {
            lossLimit: mongoUser?.lossLimit ?? USER_LOSS_LIMIT,
            lotLimit: mongoUser?.lotCount ?? DEFAULT_LOT_LIMIT,
            maxInvestment: (cfg as any).maxInvestment || DEFAULT_MAX_INVESTMENT,
            useGTT: cfg.useGTT ?? mongoUser?.useGTT ?? true,
            broker: (cfg as any).broker ?? (mongoUser as any)?.broker ?? 'zerodha',
        });
    }

    // Real Mongo users are otherwise only synced into this cache reactively
    // (login/create/settings-save - see server.ts) - never at order-process
    // startup. Preload everyone here too, so a restart doesn't silently drop
    // an already-logged-in user back to hardcoded defaults (e.g.
    // investmentAmount=0) until they take one of those actions again.
    const users = await getAllUsers().catch(() => []);
    for (const user of users) {
        bookkeeping.updateUserSettings(user.email, {
            lossLimit: user.lossLimit,
            lotLimit: user.lotCount,
            investmentMode: user.investmentMode,
            investmentAmount: user.investmentAmount,
            useGTT: user.useGTT,
            broker: user.broker,
            perOrderCap: user.perOrderCap,
            allottedCapital: user.allottedCapital,
            targetPoints: user.targetPoints,
            stopLossPoints: user.stopLossPoints,
        });
    }
}

// Broker-position reconciliation is an explicit, operator-triggered step (the
// 'reconcileBrokerPositions' IPC case, reached via POST /reconcile in server.ts)
// - it does NOT run at process startup or on every broker login any more. The
// user checks for open positions and then invokes it.
//
// Set for the duration of a reconcile - awaited by the 'openTrades'/
// 'canPlaceOrder'/'squareOff' IPC handlers above so a concurrent reader can't
// observe bookkeeping.trades mid-reconcile and wrongly conclude nothing is open
// (or approve a duplicate entry). null once nothing is in flight.
let reconcileInFlight: Promise<void> | null = null;

// True while a trailing coalesced reconcile has been requested but not yet
// started - see startReconcile's comment.
let reconcileQueued = false;

// Per-broker outcome of the most recent completed reconcile. A broker is only
// true when its positions were actually fetched and restored. Until then (and
// after any failed run) placeOrderWithPendingGuard refuses new entries on that
// broker - bookkeeping.trades can't yet be trusted to say what is already open.
type ReconcilableBroker = 'zerodha' | 'ant' | 'breeze';
const brokerReconciled: Record<ReconcilableBroker, boolean> = { zerodha: false, ant: false, breeze: false };

function isReconcilableBroker(broker: string): broker is ReconcilableBroker {
    return broker === 'zerodha' || broker === 'ant' || broker === 'breeze';
}

async function reconcileAllBrokersOnce(logContext: string): Promise<void> {
    Log.log(`[order] Running broker-position reconciliation (${logContext})`);
    const [zerodha, ant, breeze] = await Promise.all([
        bookkeeping.reconcileZerodhaPositions().catch((e) => { Log.log('[order] reconcileZerodhaPositions failed:', e); return false; }),
        bookkeeping.reconcileAntPositions().catch((e) => { Log.log('[order] reconcileAntPositions failed:', e); return false; }),
        bookkeeping.reconcileBreezePositions().catch((e) => { Log.log('[order] reconcileBreezePositions failed:', e); return false; }),
    ]);
    brokerReconciled.zerodha = zerodha;
    brokerReconciled.ant = ant;
    brokerReconciled.breeze = breeze;
    exitMonitor.reconcileFromTrades(bookkeeping.trades);
}

// Runs all three broker reconciles and tracks them via reconcileInFlight.
// Coalesces overlapping triggers: a call that arrives while one is already in
// flight can't start its own Promise.all (whichever finished first would null
// reconcileInFlight while the other is still running). Instead exactly one
// trailing run is queued to start right after the current one finishes, since
// it may have been triggered by a session that changed mid-run.
function startReconcile(logContext: string): void {
    if (reconcileInFlight) {
        reconcileQueued = true;
        Log.log(`[order] Reconcile already in flight - queuing one trailing run for ${logContext}`);
        return;
    }
    reconcileInFlight = (async () => {
        await reconcileAllBrokersOnce(logContext);
        while (reconcileQueued) {
            reconcileQueued = false;
            await reconcileAllBrokersOnce('trailing, coalesced');
        }
        reconcileInFlight = null;
    })();
}

// Explicit reconcile, reached via the 'reconcileBrokerPositions' IPC case.
// Refused before 09:10: pre-market broker responses are incomplete/stale (see
// marketHours.isPastReconcileTime). Resolves only once the run - including any
// trailing coalesced run - has completed, and returns the per-broker outcome.
async function runBrokerReconcileNow(logContext: string): Promise<Record<ReconcilableBroker, boolean>> {
    if (!isPastReconcileTime()) {
        throw new Error('broker-position reconciliation refused before 09:10 - broker responses are pre-market and incomplete; retry after 09:10');
    }
    startReconcile(logContext);
    await reconcileInFlight;
    return { ...brokerReconciled };
}

// Only useGTT=false trades ever end up in exitMonitor's watch list (see
// zerodhaExecutor.finalizeEntry), so this is a no-op for the GTT-brokered
// majority of trades - most ticks arriving here simply have no matching entry.
async function onTick(tick: any) {
    if (tick.type === 'option') {
        const quote = Object.assign(new OptionQuote(), tick.quote) as OptionQuote;
        await exitMonitor.handleOptionTick(quote);
    }
}

async function main() {
    // Warm every broker's contract master before the IPC socket accepts requests, so the first
    // order inside a trading window doesn't pay the file parse. Breeze's daily refresh runs
    // in the background (void) so a slow download can't delay startup.
    AntContractMaster.getInstance().preload({ bfo: true });
    ZerodhaContractMaster.getInstance().preload();
    PrismContractMaster.getInstance().preload();
    void BreezeContractMaster.getInstance().preload();

    await Mongo.init().catch((e) => Log.log('[order] Mongo.init failed (continuing without persistence):', e));
    await loadUserLimits();
    // bookkeeping.closedTrades is in-memory only - reload today's realized
    // trades from Mongo so /closedtrades and /positionstream don't go blank
    // on every restart even though nothing was actually lost (see
    // loadClosedTradesFromMongo's comment).
    await bookkeeping.loadClosedTradesFromMongo();
    // Broker-position reconciliation is NOT run at startup - it's the explicit
    // 'reconcileBrokerPositions' step (POST /reconcile). Until it has run for a
    // broker, bookkeeping.trades has nothing restored for that broker and
    // placeOrderWithPendingGuard refuses new entries on it.
    Log.log('[order] startup: broker-position reconciliation not run - invoke POST /reconcile after checking for open positions');
    exitMonitor.reconcileFromTrades(bookkeeping.trades);

    // Restore any resting root-refill limit orders tracked before this restart,
    // so the pollPendingLimitOrders interval below can pick up a fill (or
    // cancellation) that happened while this process was down instead of
    // silently orphaning it - see pendingLimitOrders.ts's header comment.
    await loadPendingLimitOrdersFromMongo();
    await loadPendingBreezeLimitOrdersFromMongo();
    await loadPendingAntLimitOrdersFromMongo();
    await loadPendingPrismLimitOrdersFromMongo();

    // cancelAnyRestingLimitSell is now module-scoped (see its definition above
    // handleRequest) so both this drawdown-breach handler and
    // handleRequest's 'cancelRestingLimitSells' IPC case (BulkPcrStrategy's
    // hedge hand-off) can call it.

    // Auto-squareoff on daily/weekly drawdown breach (see bookkeeping.ts's
    // drawdownState (daily/weekly), checked after every
    // closing trade) - closes a snapshot of the user's remaining open
    // positions through their configured broker. Each squareoff's own Sell
    // fill re-enters this same check, which is safe: it only ever acts on
    // trades still open at that moment, so it converges once none are left.
    // Routed via getBrokerExecutor (same dispatch case 'squareOff' uses) rather
    // than a hand-rolled ant/else-zerodha branch, so a breeze-routed position
    // (e.g. ContinuousStrategy with config.yml broker: breeze) doesn't get
    // misrouted to a Zerodha square-off call for a symbol it never bought there.
    // Trade has no `exchange` field, so it's inferred from tsym - same
    // SENSEX/BFO convention used everywhere else in this file (onFill,
    // resolveOptionContractForBroker, buyToCloseShortLegForUser) since
    // BulkPcrStrategy's SENSEX/BFO support means not every trade here is NFO.
    //
    // Resolved via trade.broker (falling back to the per-user default only
    // when a trade has none) rather than getBrokerExecutor(user) alone -
    // bookkeeping.getUserBroker(user) only ever resolves one broker per user
    // and can never return 'prism', so a BulkPcrStrategy position opened on
    // ant/prism (BulkPcrAutoStartStrategy's multi-broker fan-out) would
    // otherwise force-close against whatever stale single broker the user's
    // settings/config.yml happen to say, missing the real resting order
    // entirely - the same "stuck position with no exit" failure mode this
    // project already took a live loss from.
    // In-flight guard for short-leg buy-to-close, shared by the breach handler and the expiry sweep.
    const expirySquareOffInFlight = new Set<string>();
    bookkeeping.onDrawdownBreach(async (user) => {
        for (const trade of bookkeeping.trades.filter((t) => t.user === user)) {
            try {
                await forceCloseTrade(trade);
            } catch (e) {
                Log.log('[order] Auto-squareoff on drawdown breach failed for', trade.tsym, e);
            }
        }
        // ButterflyStrategy's short legs are NOT in bookkeeping.trades (separate ledger - see
        // bookkeeping.recordShortFill) and were otherwise never force-closed by a drawdown
        // breach - found on review: a user breaching their loss limit would ride an open short
        // leg completely uncovered. Buy-to-close, not squareOff (a short reduces via a BUY).
        for (const shortTrade of bookkeeping.shortTrades.filter((t) => t.user === user)) {
            // Same key as the expiry sweep below, so overlapping breach events and the sweep cannot double-buy-to-close.
            const key = shortCloseKey(shortTrade);
            if (expirySquareOffInFlight.has(key)) {
                Log.log('[order] Drawdown buy-to-close skipped for', shortTrade.tsym, '- one is already in flight');
                continue;
            }
            expirySquareOffInFlight.add(key);
            try {
                await buyToCloseShortLegForUser(user, shortTrade);
            } catch (e) {
                Log.log('[order] Auto-buy-to-close on drawdown breach failed for', shortTrade.tsym, e);
            } finally {
                expirySquareOffInFlight.delete(key);
            }
        }
    });

    connectAntOrderNotifyIfSessionValid('startup');
    connectBreezeOrderNotifyIfSessionValid('startup').catch((e) => Log.log('[order] connectBreezeOrderNotifyIfSessionValid failed:', e));

    setInterval(() => pollGttFills().catch((e) => Log.log('[order] pollGttFills failed:', e)), 60_000);
    setInterval(() => reconcileManualSells().catch((e) => Log.log('[order] reconcileManualSells failed:', e)), 60_000);
    setInterval(() => pollPendingLimitOrders().catch((e) => Log.log('[order] pollPendingLimitOrders failed:', e)), 15_000);
    setInterval(() => pollPendingBreezeLimitOrders().catch((e) => Log.log('[order] pollPendingBreezeLimitOrders failed:', e)), 15_000);
    setInterval(() => pollPendingAntLimitOrders().catch((e) => Log.log('[order] pollPendingAntLimitOrders failed:', e)), 15_000);
    setInterval(() => pollPendingPrismLimitOrders().catch((e) => Log.log('[order] pollPendingPrismLimitOrders failed:', e)), 15_000);
    // Force-close every open position by 3:15pm on NIFTY's weekly expiry day
    // (Tuesday) - see isPastExpirySquareOffTime's comment. Polled rather than
    // event-driven since there's no fill/tick event marking "expiry day
    // deadline reached". expirySquareOffInFlight guards against re-submitting
    // a squareoff for the same open position on the next tick before its
    // Sell fill has removed it from bookkeeping.trades; a failed attempt is
    // simply retried on the next tick since the trade is still open.
    setInterval(() => {
        if (!isPastExpirySquareOffTime()) return;
        for (const trade of bookkeeping.trades) {
            // Shares forceCloseTrade's in-flight guard with the drawdown-breach handler.
            forceCloseTrade(trade)
                .catch((e) => Log.log('[order] Expiry-day auto-squareoff failed for', trade.tsym, e));
        }
        // ButterflyStrategy's short legs are NOT in bookkeeping.trades - see the
        // drawdown-breach handler's identical comment above for why this sweep must also
        // separately cover bookkeeping.shortTrades, or a SellToOpen leg still open at the
        // 3:15pm expiry deadline would ride uncovered with nothing to force-close it.
        for (const shortTrade of bookkeeping.shortTrades) {
            const key = shortCloseKey(shortTrade);
            if (expirySquareOffInFlight.has(key)) continue;
            expirySquareOffInFlight.add(key);
            buyToCloseShortLegForUser(shortTrade.user, shortTrade)
                .catch((e) => Log.log('[order] Expiry-day auto-buy-to-close failed for', shortTrade.tsym, e))
                .finally(() => expirySquareOffInFlight.delete(key));
        }
    }, 60_000);

    readJsonLines(
        process.stdin,
        onTick,
        (line, err) => Log.log('[order] Failed to parse stdin tick:', line, err)
    );

    if (fs.existsSync(ORDER_SOCKET_PATH)) fs.unlinkSync(ORDER_SOCKET_PATH);

    const server = net.createServer((socket) => {
        clients.add(socket);
        Log.log('[order] Client connected, total:', clients.size);

        readJsonLines(
            socket,
            async (msg) => {
                if (msg.kind === 'request') {
                    const response = await handleRequest(msg as OrderRequest);
                    writeJsonLine(socket, response);
                }
            },
            (line, err) => Log.log('[order] Failed to parse client message:', line, err)
        );

        socket.on('close', () => {
            clients.delete(socket);
            Log.log('[order] Client disconnected, total:', clients.size);
        });
        socket.on('error', (e) => Log.log('[order] Client socket error:', e));
    });

    server.listen(ORDER_SOCKET_PATH, () => {
        Log.log('[order] Listening on', ORDER_SOCKET_PATH);
    });
}

main().catch((e) => {
    Log.log('[order] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    if (fs.existsSync(ORDER_SOCKET_PATH)) fs.unlinkSync(ORDER_SOCKET_PATH);
    process.exit(0);
});
