// stdout is reserved for the subscribe/unsubscribe protocol back to `data` -
// redirect console.log to stderr before any other module loads (mirrors
// dataProcess.ts).
console.log = console.error;

import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import AntContractMaster from '../ant/AntContractMaster';
import Mongo from '../tools/mongo';
import { readJsonLines, writeJsonLine } from '../ipc/jsonLines';
import { STRATEGIES_SOCKET_PATH, StrategiesRequest, StrategiesResponse } from '../ipc/strategiesProtocol';
import strategies from '../strategy/strategies';
import OrderClient from './strategies/OrderClient';
import { registerTrade, unregisterTrade, routeOptionTick } from './strategies/tokenRouter';
import { BROKER_TO_FEED_SOURCE } from '../ipc/feedSource';
import { subscribeToken, unsubscribeToken } from './strategies/DataClient';
import * as niftyQuoteHistory from './strategies/niftyQuoteHistory';
import * as niftyCandleBuilder from './strategies/niftyCandleBuilder';
import * as niftyStatsBuilder from './strategies/niftyStatsBuilder';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../ipc/feedSource';
import { OrderCancelledNotification } from '../ipc/orderProtocol';

// Entry point for the `strategies` process. No Prism/Kite dependency at all -
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
    // The fill's own broker decides the feed its token belongs to; the strategy's config `broker:`
    // key is only a fallback for untagged fills (a BulkPcr ANT pair under `broker: breeze` would
    // otherwise subscribe an ANT token on the Breeze feed).
    const feed = trade.broker ? BROKER_TO_FEED_SOURCE[trade.broker] : undefined;
    // SENSEX (BFO) tsym -> 'BFO', same convention BulkPcrStrategy already uses
    // for its own antSquareOffBare/reconcile calls - found on review: without
    // this, a held BFO token's subscription here would default to NFO and
    // never receive a tick back from AliceBlue.
    const exchange: 'NFO' | 'BFO' = trade.tsym?.startsWith('SENSEX') ? 'BFO' : 'NFO';
    if (trade.action === 'Buy' && trade.token) {
        registerTrade(trade.token, strategy, feed, exchange);
    } else if (trade.action === 'Sell' && trade.token) {
        unregisterTrade(trade.token, strategy, feed, exchange);
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

// reconcile() runs only when explicitly requested (the 'reconcile' IPC request,
// reached via POST /reconcile in server.ts) - never on startup or on a tick, and
// nothing waits for it: ticks and order events flow from startup. It is a repair
// for when broker positions and Mongo documents disagree. Concurrent requests
// share the run that is in flight; once it finishes a later request runs again.
let reconcileInFlight: Promise<void> | null = null;

function runReconcile(): Promise<void> {
    if (!reconcileInFlight) {
        reconcileInFlight = reconcileStrategies().finally(() => { reconcileInFlight = null; });
    }
    return reconcileInFlight;
}

async function reconcileStrategies(): Promise<void> {
    // Only a handful of strategies implement reconcile() today (ContinuousStrategy,
    // BulkPcrStrategy, SupportResistanceStrategy, HourlyStrategy) - optional-chained
    // since other strategies don't need it, and each call
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
    Log.log(`[strategies] Reconciled - ${strategies.getList().length} strategies.`);
}

// One strategy throwing on a tick must not starve the strategies after it (including ones managing live exits).
async function isolate(strategy: { userId?: string; getClassName(): string }, what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn();
    } catch (e) {
        Log.log(`[strategies] ${strategy.getClassName()}${strategy.userId ? ':' + strategy.userId : ''} ${what} threw (other strategies unaffected):`, e);
    }
}

async function onTick(tick: any) {
    if (tick.type === 'nifty') {
        const quote = Object.assign(new NiftyQuote(), tick.quote) as NiftyQuote;
        niftyQuoteHistory.record(quote);
        niftyCandleBuilder.record(quote);
        const statsUpdate = niftyStatsBuilder.record(quote.ltp, parseInt(quote.ltt as any));
        if (statsUpdate) {
            for (const strategy of strategies.getList()) {
                await isolate(strategy, 'receive', () => strategy.receive(statsUpdate.oldStats, statsUpdate.newStats));
            }
        }
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await isolate(strategy, 'processNiftyQuote', () => strategy.processNiftyQuote(quote));
        }
    } else if (tick.type === 'sensex') {
        const quote = Object.assign(new SensexQuote(), tick.quote) as SensexQuote;
        for (const strategy of strategies.getList()) {
            if (strategy.enabled) await isolate(strategy, 'processSensexQuote', () => strategy.processSensexQuote(quote));
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

            // Explicit reconcile - POST /reconcile in server.ts sends this only
            // after `order`'s broker-position reconcile has succeeded, since
            // every strategy's reconcile() reads the restored open trades.
            // `ran` is false when this request joined a reconcile already in flight.
            case 'reconcile': {
                const joinedInFlight = reconcileInFlight !== null;
                await runReconcile();
                return { kind: 'response', id: req.id, ok: true, result: { ran: !joinedInFlight } };
            }

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
    // TopStock (and antLegOps) resolve ANT contracts in this process - warm the NFO/NSE caches
    // before strategies.initialize() so the first in-window lookup is an in-memory read.
    AntContractMaster.getInstance().preload();

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

    // reconcile() does not run here or on any tick - it's the explicit
    // 'reconcile' request (POST /reconcile), used only to repair a mismatch
    // between broker positions and Mongo. Ticks and order events flow regardless.

    // Keeps the trading-window gate (strategies.ts's enforceTradingWindow)
    // self-correcting without needing a restart - disable-only: force-disables
    // any strategy still enabled once the window closes (past 15:25). Never
    // re-enables anything - a strategy only becomes enabled again via a fresh
    // explicit enable action (config save or admin live-toggle) made while
    // within the window; see strategies.ts's enforceTradingWindow/
    // setEnabledOverride comments.
    setInterval(() => strategies.recheckTradingWindow(), 60 * 1000);

    Log.log(`[strategies] Initialized - ${strategies.getList().length} strategies loaded. POST /reconcile is on-demand only.`);
}

main().catch((e) => {
    Log.log('[strategies] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    if (fs.existsSync(STRATEGIES_SOCKET_PATH)) fs.unlinkSync(STRATEGIES_SOCKET_PATH);
    process.exit(0);
});
