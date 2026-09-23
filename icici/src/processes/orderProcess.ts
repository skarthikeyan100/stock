// stdout now doubles as the subscribe/unsubscribe protocol channel back to
// `data` (see exitMonitor.ts) - redirect console.log to stderr before any
// other module loads, mirroring strategiesProcess.ts/dataProcess.ts.
console.log = console.error;

import dns from 'dns';
// This host is dual-stack; Node prefers IPv6 by default for outbound requests,
// which bypasses Zerodha/Kite's IPv4-only IP allowlist. Force IPv4 first for
// every process that calls api.kite.trade - `order` is the one that actually
// places Zerodha orders (see src/kiteconnect.d.ts / Zerodha.ts).
dns.setDefaultResultOrder('ipv4first');

import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import configService from '../prism/ConfigService';
import { writeJsonLine, readJsonLines } from '../ipc/jsonLines';
import { ORDER_SOCKET_PATH, OrderRequest, OrderResponse, FillNotification, PositionsChangedNotification, OrderCancelledNotification } from '../ipc/orderProtocol';
import bookkeeping from './order/bookkeeping';
import { buyIndexOnZerodha, manualBuyOnZerodha, setTargetStopLoss, pollGttFills, reconcileManualSells, marketBuyBareOnZerodha, marketSellBareOnZerodha, placeLimitBuyBareOnZerodha, cancelOrderOnZerodha, getContractByPriceRangeOnZerodha } from './order/zerodhaExecutor';
import { pollPendingLimitOrders, loadPendingLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingZerodhaOrdersForSymbol, onCancelled as onPendingZerodhaCancelled } from './order/pendingLimitOrders';
import { pollPendingAntLimitOrders, loadPendingAntLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingAntOrdersForSymbol } from './order/pendingAntLimitOrders';
import * as antExecutor from './order/antExecutor';
import { buyIndexOnBreeze, squareOffOnBreeze, marketBuyBareOnBreeze, marketSellBareOnBreeze, placeLimitBuyBareOnBreeze, cancelOrderOnBreeze, getContractByPriceRangeOnBreeze, getMarketableBreezeBuyPrice, tsymFor } from './order/breezeExecutor';
import { pollPendingBreezeLimitOrders, loadPendingBreezeLimitOrdersFromMongo, findPendingOrdersForSymbol as findPendingBreezeOrdersForSymbol, onCancelled as onPendingBreezeCancelled } from './order/breezePendingLimitOrders';
import { buyChunked, squareOffChunked, squareOffLimitChunked } from './order/chunkedOrder';
import BreezeContractMaster from '../breeze/BreezeContractMaster';
import Breeze from '../breeze/Breeze';
import ZerodhaContractMaster from '../zerodha/ZerodhaContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import BreezeOrderNotifyStream from '../breeze/BreezeOrderNotifyStream';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import * as exitMonitor from './order/exitMonitor';
import * as prismExecutor from './order/prismExecutor';
import { getBrokerExecutor } from './order/brokerExecutors';
import { BrokerExecutor } from './order/BrokerExecutor';
import Zerodha from '../zerodha/Zerodha';
import ANT from '../ant/ANT';
import NorenRestApi from '../prism/RestAPI';
import { USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT, CALL } from '../constants';
import { getUser, getAllUsers } from '../user';
import { OptionQuote } from '../model/model';
import { isPastExpirySquareOffTime } from '../util/marketHours';

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
async function placeOrderWithPendingGuard(
    req: OrderRequest,
    estimatedOrderValue: number | undefined,
    place: () => Promise<any>,
): Promise<OrderResponse> {
    const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedOrderValue);
    if (!validation.allowed) {
        return { kind: 'response', id: req.id, ok: false, error: validation.reason };
    }
    bookkeeping.markPending(req.userId, estimatedOrderValue);
    try {
        const result = await place();
        return { kind: 'response', id: req.id, ok: true, result };
    } catch (e) {
        bookkeeping.releasePending(req.userId);
        throw e;
    }
}

async function handleRequest(req: OrderRequest): Promise<OrderResponse> {
    try {
        switch (req.type) {
            case 'canPlaceOrder':
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
                    const contract = await BreezeContractMaster.getInstance().findATMOption(niftyLtp, optionType, 'NIFTY');
                    const buyPrice = await getMarketableBreezeBuyPrice(contract);
                    const estimatedOrderValue = req.payload.quantity * buyPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: tsymFor(contract),
                                instrumentId: contract.token,
                                quantity: req.payload.quantity,
                                exchange: 'NFO',
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
                    const contract = await ZerodhaContractMaster.getInstance().findATMOption(niftyLtp, optionType, 'NIFTY');
                    const commonToken = String(AntContractMaster.getInstance().resolveCommonToken('NIFTY', optionType, { atmLtp: niftyLtp }));
                    // NIFTY strike step (50) mirrors ZerodhaContractMaster.findATMOption's
                    // own rounding - needed here only for the pre-trade price estimate.
                    const atmStrike = Math.round(niftyLtp / 50) * 50;
                    const estimatedPrice = await antExecutor.estimateOptionPrice('NIFTY', atmStrike, optionType);
                    const estimatedOrderValue = req.payload.quantity * estimatedPrice;

                    return await placeOrderWithPendingGuard(req, estimatedOrderValue, async () => {
                        const result = await buyChunked(
                            executor,
                            {
                                userId: req.userId,
                                tradingSymbol: contract.tradingSymbol,
                                instrumentId: commonToken,
                                quantity: req.payload.quantity,
                                exchange: contract.exchange,
                            },
                            req.payload.freezeQuantity
                        );
                        return { tsym: contract.tradingSymbol, token: commonToken, ...result };
                    });
                }

                return { kind: 'response', id: req.id, ok: false, error: `chunkedBuyIndex: broker '${executor.brokerName}' not yet supported (breeze/zerodha only)` };
            }

            case 'chunkedSquareOff': {
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const result = await squareOffChunked(executor, req.userId, req.payload.tsym, req.payload.quantity, 'NFO', req.payload.freezeQuantity);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'chunkedSquareOffLimit': {
                const executor = getBrokerExecutor(req.userId, req.payload.broker);
                const result = await squareOffLimitChunked(
                    executor,
                    req.userId,
                    req.payload.tsym,
                    req.payload.instrumentId,
                    req.payload.quantity,
                    'NFO',
                    req.payload.price,
                    req.payload.freezeQuantity
                );
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
                // Re-run broker-position reconciliation now that a login just
                // succeeded (server.ts only calls reloadSession from its
                // OAuth callback handlers) - closes the gap where a session
                // that was stale/invalid at process startup left
                // bookkeeping.trades permanently empty until the next
                // restart, even after the user re-logged in. Each reconcile
                // call is a no-op (besides a failed getPositions log) if that
                // broker's session isn't actually the one that just changed.
                bookkeeping.reconcileZerodhaPositions().catch((e) => Log.log('[order] reloadSession: reconcileZerodhaPositions failed:', e));
                bookkeeping.reconcileAntPositions().catch((e) => Log.log('[order] reloadSession: reconcileAntPositions failed:', e));
                bookkeeping.reconcileBreezePositions().catch((e) => Log.log('[order] reloadSession: reconcileBreezePositions failed:', e));
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

            case 'openTrades':
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
    await Mongo.init().catch((e) => Log.log('[order] Mongo.init failed (continuing without persistence):', e));
    await loadUserLimits();
    // bookkeeping.closedTrades is in-memory only - reload today's realized
    // trades from Mongo so /closedtrades and /positionstream don't go blank
    // on every restart even though nothing was actually lost (see
    // loadClosedTradesFromMongo's comment).
    await bookkeeping.loadClosedTradesFromMongo();
    // Must complete before connectAntOrderNotifyIfSessionValid() and before
    // the IPC socket starts accepting strategies/frontend connections below,
    // so no client ever observes an empty bookkeeping.trades mid-restore.
    await bookkeeping.loadOpenTradesFromBroker();
    // Now live: bookkeeping.trades is populated from the broker/Mongo restore
    // above (previously this reconciled against an always-empty list on a
    // fresh restart).
    exitMonitor.reconcileFromTrades(bookkeeping.trades);

    // Restore any resting root-refill limit orders tracked before this restart,
    // so the pollPendingLimitOrders interval below can pick up a fill (or
    // cancellation) that happened while this process was down instead of
    // silently orphaning it - see pendingLimitOrders.ts's header comment.
    await loadPendingLimitOrdersFromMongo();
    await loadPendingBreezeLimitOrdersFromMongo();
    await loadPendingAntLimitOrdersFromMongo();

    // Cancels any resting limit-sell order(s) tracked for this user+tsym
    // before a force-close path market-sells the same still-open quantity -
    // added 2026-09-22 alongside chunkedSquareOffLimit (BulkPcrStrategy's
    // target-hit exit, which now leaves a limit sell resting indefinitely
    // instead of filling near-instantly like the old market order it
    // replaced). Without this, a drawdown-breach or expiry-day force-close
    // firing while that resting order is still live would place a SECOND,
    // independent sell for the same quantity - an oversell if both filled.
    // Best-effort: a cancel failing (already filled, already gone) is not
    // itself an error - the force-close square-off below is what actually
    // matters, and each pending-order poller self-heals its own tracking
    // within 15s regardless of whether the cancel here succeeded.
    async function cancelAnyRestingLimitSell(executor: BrokerExecutor, userId: string, tsym: string): Promise<void> {
        const pending = [
            ...findPendingZerodhaOrdersForSymbol(userId, tsym),
            ...findPendingBreezeOrdersForSymbol(userId, tsym),
            ...findPendingAntOrdersForSymbol(userId, tsym),
        ].filter((o) => o.action === 'Sell');
        for (const order of pending) {
            try {
                await executor.cancelOrder(order.orderId);
                Log.log(`[order] cancelAnyRestingLimitSell: cancelled resting limit sell ${order.orderId} for ${tsym} (${userId}) ahead of a force-close`);
            } catch (e) {
                Log.log(`[order] cancelAnyRestingLimitSell: cancel failed for ${order.orderId} (${tsym}, ${userId}) - proceeding with force-close anyway:`, e);
            }
        }
    }

    // Auto-squareoff on daily/weekly drawdown breach (see bookkeeping.ts's
    // isDailyDrawdownBreached/isWeeklyDrawdownBreached, checked after every
    // closing trade) - closes a snapshot of the user's remaining open
    // positions through their configured broker. Each squareoff's own Sell
    // fill re-enters this same check, which is safe: it only ever acts on
    // trades still open at that moment, so it converges once none are left.
    // Routed via getBrokerExecutor (same dispatch case 'squareOff' uses) rather
    // than a hand-rolled ant/else-zerodha branch, so a breeze-routed position
    // (e.g. ContinuousStrategy with config.yml broker: breeze) doesn't get
    // misrouted to a Zerodha square-off call for a symbol it never bought there.
    // Trade has no `exchange` field, so 'NFO' is passed literally - every trade
    // reaching this loop is a NIFTY/NFO option, matching the pre-existing
    // (implicit, default-'NFO') behavior of both branches this replaces.
    bookkeeping.onDrawdownBreach(async (user) => {
        for (const trade of bookkeeping.trades.filter((t) => t.user === user)) {
            try {
                await cancelAnyRestingLimitSell(getBrokerExecutor(user), user, trade.tsym);
                await getBrokerExecutor(user).squareOff(user, trade.tsym, trade.quantity, 'NFO');
            } catch (e) {
                Log.log('[order] Auto-squareoff on drawdown breach failed for', trade.tsym, e);
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
    // Force-close every open position by 3:15pm on NIFTY's weekly expiry day
    // (Tuesday) - see isPastExpirySquareOffTime's comment. Polled rather than
    // event-driven since there's no fill/tick event marking "expiry day
    // deadline reached". expirySquareOffInFlight guards against re-submitting
    // a squareoff for the same open position on the next tick before its
    // Sell fill has removed it from bookkeeping.trades; a failed attempt is
    // simply retried on the next tick since the trade is still open.
    const expirySquareOffInFlight = new Set<string>();
    setInterval(() => {
        if (!isPastExpirySquareOffTime()) return;
        for (const trade of bookkeeping.trades) {
            const key = `${trade.user}:${trade.token}`;
            if (expirySquareOffInFlight.has(key)) continue;
            expirySquareOffInFlight.add(key);
            // Routed via getBrokerExecutor (see the drawdown-breach handler's comment
            // above for why) instead of a hand-rolled ant/else-zerodha branch.
            const executor = getBrokerExecutor(trade.user);
            const squareOff = cancelAnyRestingLimitSell(executor, trade.user, trade.tsym)
                .then(() => executor.squareOff(trade.user, trade.tsym, trade.quantity, 'NFO'));
            squareOff
                .catch((e) => Log.log('[order] Expiry-day auto-squareoff failed for', trade.tsym, e))
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
