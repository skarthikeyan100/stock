// stdout is reserved for the subscribe/unsubscribe protocol back to `data` -
// redirect console.log to stderr before any other module loads (mirrors
// dataProcess.ts).
console.log = console.error;

import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { readJsonLines, writeJsonLine } from '../ipc/jsonLines';
import { STRATEGIES_SOCKET_PATH, StrategiesRequest, StrategiesResponse } from '../ipc/strategiesProtocol';
import strategies from '../strategy/strategies';
import OrderClient from './strategies/OrderClient';
import { registerTrade, unregisterTrade, routeOptionTick } from './strategies/tokenRouter';
import { subscribeToken, unsubscribeToken } from './strategies/DataClient';
import * as niftyQuoteHistory from './strategies/niftyQuoteHistory';
import * as niftyCandleBuilder from './strategies/niftyCandleBuilder';
import * as niftyStatsBuilder from './strategies/niftyStatsBuilder';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../ipc/feedSource';
import { OrderCancelledNotification } from '../ipc/orderProtocol';
import { isPastReconcileTime } from '../util/marketHours';

// Entry point for the `strategies` process. No Prism/Zerodha dependency at all -
// ticks arrive over stdin (piped from `data` by the orchestrator), orders go out
// over OrderClient's IPC socket to `order`, fills come back the same way. This is
// the process meant to be killed and respawned on every strategy code change,
// without ever touching `data`'s or `order`'s live broker connections.

async function onFill(userId: string, raw: any) {
    const trade = Object.assign(new Trade(), raw) as Trade;
    const strategy = strategies.getByUserId(userId);
    if (!strategy) {
        Log.log('[strategies] Fill for unknown strategy userId:', userId);
        return;
    }
    if (trade.action === 'Buy' && trade.token) {
        registerTrade(trade.token, strategy);
    } else if (trade.action === 'Sell' && trade.token) {
        unregisterTrade(trade.token, strategy);
    }
    await strategy.updateTrade(trade);
}

async function onOrderCancelled(userId: string, notification: OrderCancelledNotification) {
    const strategy = strategies.getByUserId(userId);
    if (!strategy) {
        Log.log('[strategies] Order cancelled for unknown strategy userId:', userId);
        return;
    }
    if (strategy.onOrderCancelled) {
        await strategy.onOrderCancelled(notification);
    }
}

// Ticks queued on stdin during startup (data.stdout is piped in before
// strategies.initialize()/reconcile() resolve) must not reach
// strategy.processNiftyQuote before every strategy has had a chance to
// restore its "is a position already open" state - otherwise a fresh
// instance can fire a duplicate live T1 entry before reconciliation ever
// runs. A few dropped ticks during this brief window are harmless; the next
// tick moments later re-populates lastNiftyLtp etc.
let ready = false;

// Login/restart-triggered reconcile() must not run against pre-market
// broker state (see marketHours.isPastReconcileTime's comment) - deferred
// from main()'s startup path to here, so it fires on the first tick received
// once the clock has passed 9:10 instead of unconditionally at process
// start/login, whatever time that happens to be.
let reconciled = false;

async function runReconcileOnce(): Promise<void> {
    if (reconciled) return;
    reconciled = true;
    // Only ContinuousStrategy/BulkPcrStrategy implement reconcile() today -
    // optional-chained since other strategies don't need it, and each call
    // is independently try/caught so one strategy's reconcile failure can't
    // block the others (reconcile() itself already fails closed internally -
    // see ContinuousStrategy.reconcile).
    for (const strategy of strategies.getList()) {
        try {
            await (strategy as any).reconcile?.();
        } catch (e) {
            Log.log(`[strategies] reconcile() failed for ${strategy.userId}:`, e);
        }
    }
    ready = true;
    Log.log(`[strategies] Reconciled and ready - ${strategies.getList().length} strategies loaded.`);
}

async function onTick(tick: any) {
    if (!reconciled && isPastReconcileTime()) {
        await runReconcileOnce();
    }
    if (!ready) return;
    if (tick.type === 'nifty') {
        const quote = Object.assign(new NiftyQuote(), tick.quote) as NiftyQuote;
        niftyQuoteHistory.record(quote);
        niftyCandleBuilder.record(quote);
        const statsUpdate = niftyStatsBuilder.record(quote.ltp, parseInt(quote.ltt as any));
        if (statsUpdate) {
            for (const strategy of strategies.getList()) {
                await strategy.receive(statsUpdate.oldStats, statsUpdate.newStats);
            }
        }
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await strategy.processNiftyQuote(quote);
        }
    } else if (tick.type === 'sensex') {
        const quote = Object.assign(new SensexQuote(), tick.quote) as SensexQuote;
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await strategy.processSensexQuote(quote);
        }
    } else if (tick.type === 'option') {
        const quote = Object.assign(new OptionQuote(), tick.quote) as OptionQuote;
        await routeOptionTick((tick.source ?? DEFAULT_FEED_SOURCE) as FeedSource, quote);
    }
}

async function handleStrategiesRequest(req: StrategiesRequest): Promise<StrategiesResponse> {
    try {
        switch (req.type) {
            case 'stats':
                return { kind: 'response', id: req.id, ok: true, result: strategies.getList().map((s) => s.getStats()) };

            case 'list':
                return {
                    kind: 'response',
                    id: req.id,
                    ok: true,
                    result: strategies.getList().map((s) => ({ type: s.getClassName(), userId: s.userId, enabled: s.enabled })),
                };

            case 'setEnabled': {
                const { identifier, enabled } = req.payload;
                strategies.setEnabledOverride(identifier, enabled);
                return {
                    kind: 'response',
                    id: req.id,
                    ok: true,
                    result: strategies.getList().map((s) => ({ type: s.getClassName(), userId: s.userId, enabled: s.enabled })),
                };
            }

            case 'reset': {
                const matched = strategies.getList().filter((s) => s.getClassName() === req.payload.type);
                matched.forEach((s) => s.reset());
                return { kind: 'response', id: req.id, ok: true, result: { type: req.payload.type, reset: matched.length } };
            }

            case 'getCandles':
                return { kind: 'response', id: req.id, ok: true, result: niftyCandleBuilder.getCandles() };

            // Demo-mode support: fires a real subscribe/unsubscribe command for
            // an arbitrary token on request, with no ref-counting against
            // watchToken/registerTrade - a demo request isn't a Strategy, and
            // a stray duplicate/early (un)subscribe here is harmless.
            case 'subscribeToken':
                subscribeToken(req.payload.token);
                return { kind: 'response', id: req.id, ok: true, result: null };

            case 'unsubscribeToken':
                unsubscribeToken(req.payload.token);
                return { kind: 'response', id: req.id, ok: true, result: null };

            // Live config-reload, called from server.ts's POST /config after every
            // save - see Strategies.syncFromConfig's own comment for why this is
            // safe to call unconditionally (doesn't touch live position state).
            case 'syncFromConfig':
                strategies.syncFromConfig();
                return { kind: 'response', id: req.id, ok: true, result: null };

            default:
                return { kind: 'response', id: req.id, ok: false, error: `Unknown request type: ${(req as any).type}` };
        }
    } catch (e: any) {
        Log.log('[strategies] Request failed:', req.type, e);
        return { kind: 'response', id: req.id, ok: false, error: e?.message ?? String(e) };
    }
}

function startStrategiesServer() {
    if (fs.existsSync(STRATEGIES_SOCKET_PATH)) fs.unlinkSync(STRATEGIES_SOCKET_PATH);
    const server = net.createServer((socket) => {
        Log.log('[strategies] Frontend client connected');
        readJsonLines(
            socket,
            async (msg) => {
                if (msg.kind === 'request') {
                    const response = await handleStrategiesRequest(msg as StrategiesRequest);
                    writeJsonLine(socket, response);
                }
            },
            (line, err) => Log.log('[strategies] Failed to parse client message:', line, err)
        );
        socket.on('error', (e) => Log.log('[strategies] Client socket error:', e));
    });
    server.listen(STRATEGIES_SOCKET_PATH, () => Log.log('[strategies] Listening on', STRATEGIES_SOCKET_PATH));
}

async function main() {
    await Mongo.init().catch((e) => Log.log('[strategies] Mongo.init failed (continuing without persistence):', e));

    OrderClient.getInstance().onFill((userId, trade) => {
        onFill(userId, trade).catch((e) => Log.log('[strategies] onFill handler failed:', e));
    });
    OrderClient.getInstance().onCancelled((userId, notification) => {
        onOrderCancelled(userId, notification).catch((e) => Log.log('[strategies] onOrderCancelled handler failed:', e));
    });
    OrderClient.getInstance().connect();
    startStrategiesServer();

    readJsonLines(
        process.stdin,
        (tick) => {
            onTick(tick).catch((e) => Log.log('[strategies] onTick handler failed:', e));
        },
        (line, err) => Log.log('[strategies] Failed to parse stdin tick:', line, err)
    );

    await strategies.initialize();

    // reconcile() itself (and setting ready=true) is deferred to the first
    // tick received after isPastReconcileTime() - see runReconcileOnce/onTick
    // above. If it's already past that time right now (e.g. a mid-day
    // restart), it simply runs on whatever tick arrives next - no different
    // in practice from running it here, since no tick exists before market
    // open anyway.

    // Keeps the trading-window gate (strategies.ts's enforceTradingWindow)
    // self-correcting without needing a restart - disable-only: force-disables
    // any strategy still enabled once the window closes (past 15:25). Never
    // re-enables anything - a strategy only becomes enabled again via a fresh
    // explicit enable action (config save or admin live-toggle) made while
    // within the window; see strategies.ts's enforceTradingWindow/
    // setEnabledOverride comments.
    setInterval(() => strategies.recheckTradingWindow(), 60 * 1000);

    Log.log(`[strategies] Initialized - ${strategies.getList().length} strategies loaded. Reconciliation deferred to first tick after 09:10.`);
}

main().catch((e) => {
    Log.log('[strategies] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    if (fs.existsSync(STRATEGIES_SOCKET_PATH)) fs.unlinkSync(STRATEGIES_SOCKET_PATH);
    process.exit(0);
});
