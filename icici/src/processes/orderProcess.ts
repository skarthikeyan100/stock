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
import { ORDER_SOCKET_PATH, OrderRequest, OrderResponse, FillNotification, PositionsChangedNotification } from '../ipc/orderProtocol';
import bookkeeping from './order/bookkeeping';
import { buyIndexOnZerodha, squareOffOnZerodha, manualBuyOnZerodha, setTargetStopLoss, pollGttFills, marketBuyBareOnZerodha, marketSellBareOnZerodha, placeLimitBuyBareOnZerodha, getContractByPriceRangeOnZerodha } from './order/zerodhaExecutor';
import { pollPendingLimitOrders } from './order/pendingLimitOrders';
import * as antExecutor from './order/antExecutor';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import * as exitMonitor from './order/exitMonitor';
import * as prismExecutor from './order/prismExecutor';
import Zerodha from '../zerodha/Zerodha';
import ANT from '../ant/ANT';
import NorenRestApi from '../prism/RestAPI';
import { USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from '../constants';
import { getUser } from '../user';
import { OptionQuote } from '../model/model';

// Entry point for the `order` process - the IPC server. `strategies` and
// `frontend` connect to it as clients over a Unix domain socket (siblings can't
// use Node's fork()-only IPC directly, and `order` is the stable side on purpose:
// when `strategies` gets killed/respawned for a code change, it just reconnects -
// `order`'s live broker sessions and GTTs are never touched). Its stdin/stdout
// are also wired (by the orchestrator) into the same tick-feed pipe used by
// `strategies`/`frontend`, solely so exitMonitor.ts can watch useGTT=false
// trades against live option ticks (see orderProcess.ts's onTick below).

const clients = new Set<net.Socket>();

function broadcast(msg: FillNotification | PositionsChangedNotification) {
    for (const c of clients) writeJsonLine(c, msg);
}

bookkeeping.onFill((userId, trade) => {
    broadcast({ kind: 'fill', userId, trade });
});

bookkeeping.onPositionsChanged(() => {
    broadcast({ kind: 'positionsChanged' });
});

async function handleRequest(req: OrderRequest): Promise<OrderResponse> {
    try {
        switch (req.type) {
            case 'canPlaceOrder':
                return { kind: 'response', id: req.id, ok: true, result: await bookkeeping.canPlaceOrder(req.userId) };

            case 'buyIndex': {
                const validation = await bookkeeping.canPlaceOrder(req.userId);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const broker = bookkeeping.getUserBroker(req.userId);
                const trade = broker === 'ant'
                    ? await antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload })
                    : await buyIndexOnZerodha({ userId: req.userId, ...req.payload });
                return { kind: 'response', id: req.id, ok: true, result: trade };
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
                const broker = bookkeeping.getUserBroker(req.userId);
                const trade = broker === 'ant'
                    ? await antExecutor.squareOffOnAnt(req.userId, tsym, quantity, exchange)
                    : await squareOffOnZerodha(req.userId, tsym, quantity, exchange);
                return { kind: 'response', id: req.id, ok: true, result: trade };
            }

            case 'antBuyIndex': {
                const validation = await bookkeeping.canPlaceOrder(req.userId);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const trade = await antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload });
                return { kind: 'response', id: req.id, ok: true, result: trade };
            }

            case 'antManualBuy': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedValue);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const trade = await antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload });
                return { kind: 'response', id: req.id, ok: true, result: trade };
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
                const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedValue);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const result = await prismExecutor.buyContract(req.userId, req.payload.contract, req.payload.quantity, req.payload.price);
                return { kind: 'response', id: req.id, ok: true, result };
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
                const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedValue);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const manualBuyBroker = bookkeeping.getUserBroker(req.userId);
                const result = manualBuyBroker === 'ant'
                    ? await antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload })
                    : await manualBuyOnZerodha({ userId: req.userId, ...req.payload });
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'setTargetStopLoss': {
                await setTargetStopLoss(req.userId, req.payload.token, req.payload.targetPoints, req.payload.stopLossPoints);
                return { kind: 'response', id: req.id, ok: true };
            }

            case 'reloadSession': {
                Zerodha.getInstance().reloadSession();
                NorenRestApi.reloadToken();
                return { kind: 'response', id: req.id, ok: true };
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

            // ContinuousStrategy's bare Zerodha execution path - see zerodhaExecutor.ts.
            case 'buyContractZerodhaBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedValue);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const result = await marketBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'sellContractZerodhaBare': {
                const result = await marketSellBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'placeLimitBuyZerodhaBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedValue);
                if (!validation.allowed) {
                    return { kind: 'response', id: req.id, ok: false, error: validation.reason };
                }
                bookkeeping.pendingUsers.add(req.userId);
                const result = await placeLimitBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.price, req.payload.exchange);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getContractByPriceRangeZerodha': {
                const excludeStrikes = new Set<number>(req.payload.excludeStrikes || []);
                const result = await getContractByPriceRangeOnZerodha(req.payload.underlyingLtp, req.payload.optionType, req.payload.index, req.payload.minPremium, excludeStrikes);
                return { kind: 'response', id: req.id, ok: true, result };
            }

            case 'getPCR': {
                const result = await ANT.getInstance().getOptionChainPCR(req.payload.underlying, req.payload.spot, req.payload.window);
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

    // Auto-squareoff on daily/monthly drawdown breach (see bookkeeping.ts's
    // isDailyDrawdownBreached/isMonthlyDrawdownBreached, checked after every
    // closing trade) - closes a snapshot of the user's remaining open
    // positions through their configured broker. Each squareoff's own Sell
    // fill re-enters this same check, which is safe: it only ever acts on
    // trades still open at that moment, so it converges once none are left.
    bookkeeping.onDrawdownBreach(async (user) => {
        const broker = bookkeeping.getUserBroker(user);
        for (const trade of bookkeeping.trades.filter((t) => t.user === user)) {
            try {
                if (broker === 'ant') await antExecutor.squareOffOnAnt(user, trade.tsym, trade.quantity);
                else await squareOffOnZerodha(user, trade.tsym, trade.quantity);
            } catch (e) {
                Log.log('[order] Auto-squareoff on drawdown breach failed for', trade.tsym, e);
            }
        }
    });

    AntOrderNotifyStream.getInstance().connect().catch((e) => Log.log('[order] AntOrderNotifyStream connect failed (ANT fills will not resolve until this connects):', e));

    setInterval(() => pollGttFills().catch((e) => Log.log('[order] pollGttFills failed:', e)), 60_000);
    setInterval(() => pollPendingLimitOrders().catch((e) => Log.log('[order] pollPendingLimitOrders failed:', e)), 15_000);

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
