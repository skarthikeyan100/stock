// stdout is reserved for the subscribe/unsubscribe protocol back to `data` -
// redirect console.log to stderr before any other module loads (mirrors
// dataProcess.ts).
console.log = console.error;

import { ownSocketTracker } from '../ipc/ownSocket';
import '../util/tz'; // pin TZ=Asia/Kolkata before any other module reads the clock
import net from 'net';
import fs from 'fs';
import Log from '../util/Log';
import AntContractMaster from '../ant/AntContractMaster';
import Mongo from '../tools/mongo';
import { readJsonLines, writeJsonLine } from '../ipc/jsonLines';
import { STRATEGIES_SOCKET_PATH, StrategiesRequest, StrategiesResponse } from '../ipc/strategiesProtocol';
import strategies from '../strategy/strategies';
import OrderClient from './strategies/OrderClient';
import { registerTrade, unregisterTrade, optionTickTargets, deliverOptionTick, resubscribeAll, holdExternal, releaseExternal } from './strategies/tokenRouter';
import * as niftyQuoteHistory from './strategies/niftyQuoteHistory';
import * as niftyCandleBuilder from './strategies/niftyCandleBuilder';
import * as niftyStatsBuilder from './strategies/niftyStatsBuilder';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import { FeedSource, DEFAULT_FEED_SOURCE, BROKER_TO_FEED_SOURCE } from '../ipc/feedSource';
import { OrderCancelledNotification } from '../ipc/orderProtocol';
import { exchangeForTsym } from '../util/underlyings';

// Entry point for the `strategies` process. No Prism/Kite dependency at all -
// ticks arrive over stdin (piped from `data` by the orchestrator), orders go out
// over OrderClient's IPC socket to `order`, fills come back the same way. This is
// the process meant to be killed and respawned on every strategy code change,
// without ever touching `data`'s or `order`'s live broker connections.

// Net open quantity per (userId, feed, token), built from this process's own fill stream. A position can be
// opened in several chunks (and sold the same way); a Sell fill for ONE chunk must not drop the token's
// subscription while the other chunks are still held, or their exit/stop logic goes blind. The strategy
// stays registered until the running net hits zero. The net comes from the order process with every fill (FillNotification.openQuantity,
// computed after the fill is booked), so it is right for a position held from before a restart too; only a fill without it (an older
// order process) falls back to counting this process's own fill stream.
const openQty = new Map<string, number>();
const openQtyExchange = new Map<string, 'NFO' | 'BFO'>();
// Fills already applied, so a duplicate delivery (same broker order + side) cannot double-count the net quantity.
const seenFillKeys = new Set<string>();
function isDuplicateFill(trade: Trade): boolean {
    if (!trade.brokerOrderId) return false;
    const key = `${trade.brokerOrderId}|${trade.action}|${trade.quantity}`;
    if (seenFillKeys.has(key)) return true;
    seenFillKeys.add(key);
    if (seenFillKeys.size > 5000) seenFillKeys.delete(seenFillKeys.values().next().value as string);
    return false;
}
// A reset strategy abandons its positions' bookkeeping: drop the net quantities and trade-holder registrations.
function clearOpenQtyFor(strategy: { userId?: string }): void {
    for (const key of Array.from(openQty.keys())) {
        const [uid, feed, token] = key.split('|');
        if (uid !== strategy.userId) continue;
        const owner = strategies.getByUserId(uid);
        if (owner) unregisterTrade(token, owner, feed === 'default' ? undefined : (feed as FeedSource), openQtyExchange.get(key));
        openQty.delete(key);
        openQtyExchange.delete(key);
    }
}

async function onFill(userId: string, raw: any, openQuantity?: number) {
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
    // for its own BulkPcr square-off/reconcile calls - found on review: without
    // this, a held BFO token's subscription here would default to NFO and
    // never receive a tick back from AliceBlue.
    const exchange: 'NFO' | 'BFO' = exchangeForTsym(trade.tsym);
    if (isDuplicateFill(trade)) {
        Log.log(`[strategies] Ignoring duplicate fill delivery for order ${trade.brokerOrderId} (${trade.action} ${trade.quantity} ${trade.tsym})`);
        return;
    }
    const qtyKey = `${userId}|${feed ?? 'default'}|${trade.token}`;
    const fillQty = Number.isFinite(Number(trade.quantity)) && Number(trade.quantity) > 0 ? Number(trade.quantity) : 0;
    // The order process's own net (after this fill was booked) is authoritative: it already covers a position held from before a
    // restart and fills this process never saw. Without it (an older order process) count this process's fill stream.
    let reportedNet = Number.isFinite(openQuantity) && (openQuantity as number) >= 0 ? (openQuantity as number) : undefined;
    // No net from the order process (an older build) and none tracked here (a position held from before this process started): ask
    // the order process for its open trades rather than guess - the same sum it would have sent (token on the same feed).
    if (reportedNet === undefined && trade.token && !openQty.has(qtyKey)) {
        try {
            let timer: NodeJS.Timeout | undefined;
            const open: any[] = await Promise.race([
                OrderClient.getInstance().getOpenTrades(userId),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 5_000); }),
            ]).finally(() => clearTimeout(timer));
            // Same feed keying as the fill itself above (an untagged row shares the untagged fill's 'default' key).
            const feedOf = (broker?: string) => (broker ? BROKER_TO_FEED_SOURCE[broker] : undefined);
            reportedNet = open.filter((t) => t?.token === trade.token && feedOf(t.broker) === feed).reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
        } catch (e) {
            Log.log(`[strategies] Could not read open trades for ${userId} to size ${trade.tsym}'s net quantity:`, e);
        }
    }
    if (trade.action === 'Buy' && trade.token) {
        openQty.set(qtyKey, reportedNet ?? (openQty.get(qtyKey) ?? 0) + fillQty);
        openQtyExchange.set(qtyKey, exchange);
        registerTrade(trade.token, strategy, feed, exchange);
    } else if (trade.action === 'Sell' && trade.token) {
        // Still unknown (the order process unreachable too): keep the subscription - a lingering one is cleaned up by a strategy
        // reset, a dropped one blinds the remaining chunks' exits.
        const unknownNet = reportedNet === undefined && !openQty.has(qtyKey);
        const remaining = reportedNet ?? (openQty.get(qtyKey) ?? 0) - fillQty;
        if (unknownNet) {
            Log.log(`[strategies] Sell fill for ${trade.tsym} with no known net quantity - keeping the tick subscription`);
        } else if (remaining > 0) {
            openQty.set(qtyKey, remaining);
        } else {
            openQty.delete(qtyKey);
            openQtyExchange.delete(qtyKey);
            unregisterTrade(trade.token, strategy, feed, exchange);
        }
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

// Ticks and fills arrive as fire-and-forget callbacks; without ordering, tick N+1 could start (and a later
// fill could be applied) while tick N / the earlier fill is still awaiting inside a strategy. These helpers
// keep per-key FIFO order: every nifty/sensex tick, and every fill/cancel of one strategy, runs strictly
// after the previous one. Option ticks use latest-wins per token instead (a full quote supersedes the
// previous one), so a slow strategy can never build an unbounded backlog of stale prices in front of an exit.
const fifoChains = new Map<string, Promise<void>>();
function enqueueFifo(key: string, job: () => Promise<void>): Promise<void> {
    const prev = fifoChains.get(key) ?? Promise.resolve();
    const next = prev.then(job, job).catch((e) => Log.log(`[strategies] ${key} handler failed:`, e));
    fifoChains.set(key, next);
    next.then(() => { if (fifoChains.get(key) === next) fifoChains.delete(key); });
    return next;
}

// Index (nifty/sensex) ticks, latest-wins per strategy like option ticks: a strategy blocked on a 90s broker call used to replay ~90
// stale ticks afterwards (stale entries, late EOD/stop). The queued quote is replaced by the newest; stats updates are discrete
// events (old -> new) so those are all kept, in order.
const indexSlots = new Map<string, { running: boolean; quote: any; stats: any[] }>();
function enqueueLatestIndex(key: string, quote: any, statsUpdate: any, job: (quote: any, stats: any[]) => Promise<void>): void {
    let slot = indexSlots.get(key);
    if (slot?.running) {
        slot.quote = quote;
        if (statsUpdate) slot.stats.push(statsUpdate);
        return;
    }
    const s = { running: true, quote, stats: statsUpdate ? [statsUpdate] : [] };
    indexSlots.set(key, s);
    (async () => {
        while (s.quote) {
            const q = s.quote;
            const stats = s.stats;
            s.quote = null;
            s.stats = [];
            try { await job(q, stats); } catch (e) { Log.log(`[strategies] index tick ${key} failed:`, e); }
        }
        indexSlots.delete(key);
    })();
}

const optionSlots = new Map<string, { running: boolean; pending: OptionQuote | null }>();
// Depth-feed ticks are sparse partial updates (e.g. tbq/tsq without lp): when a queued quote is superseded, its defined
// fields are carried into the newer one (newer wins) so data later ticks do not repeat is not lost.
function mergeQuotes(dropped: OptionQuote, newer: OptionQuote): OptionQuote {
    const merged = Object.assign(new OptionQuote(), newer);
    for (const [k, v] of Object.entries(dropped)) {
        if (v !== undefined && v !== null && (merged as any)[k] === undefined) (merged as any)[k] = v;
    }
    return merged;
}
function enqueueLatest(key: string, quote: OptionQuote, job: (q: OptionQuote) => Promise<void>): void {
    let slot = optionSlots.get(key);
    if (!slot) { slot = { running: false, pending: null }; optionSlots.set(key, slot); }
    if (slot.running) { slot.pending = slot.pending ? mergeQuotes(slot.pending, quote) : quote; return; }
    slot.running = true;
    const s = slot;
    (async () => {
        let next: OptionQuote | null = quote;
        while (next) {
            try { await job(next); } catch (e) { Log.log(`[strategies] option tick ${key} failed:`, e); }
            next = s.pending;
            s.pending = null;
        }
        s.running = false;
        optionSlots.delete(key);
    })();
}

async function onTick(tick: any) {
    // Control line from the orchestrator after the data process was restarted: replay every live token subscription.
    if (tick.cmd === 'resync') {
        Log.log(`[strategies] data process restarted - resubscribed ${resubscribeAll()} token feed(s)`);
        return;
    }
    if (tick.type === 'nifty') {
        const quote = Object.assign(new NiftyQuote(), tick.quote) as NiftyQuote;
        // A zero/NaN price must not reach the history, candle builder, stats or any strategy.
        if (!(Number.isFinite(quote.ltp) && quote.ltp > 0)) return;
        niftyQuoteHistory.record(quote);
        niftyCandleBuilder.record(quote);
        const statsUpdate = niftyStatsBuilder.record(quote.ltp, parseInt(quote.ltt as any));
        // One latest-wins slot per strategy: a strategy stuck awaiting a broker call only coalesces its own ticks, not everyone's.
        for (const strategy of strategies.getList()) {
            enqueueLatestIndex(`tick:nifty:${strategy.getClassName()}:${strategy.userId}`, quote, statsUpdate, async (q, statsList) => {
                for (const u of statsList) {
                    await isolate(strategy, 'receive', () => strategy.receive(u.oldStats, u.newStats));
                }
                if (strategy.enabled) await isolate(strategy, 'processNiftyQuote', () => strategy.processNiftyQuote(q));
            });
        }
    } else if (tick.type === 'sensex') {
        const quote = Object.assign(new SensexQuote(), tick.quote) as SensexQuote;
        for (const strategy of strategies.getList()) {
            enqueueLatestIndex(`tick:sensex:${strategy.getClassName()}:${strategy.userId}`, quote, undefined, async (q) => {
                if (strategy.enabled) await isolate(strategy, 'processSensexQuote', () => strategy.processSensexQuote(q));
            });
        }
    } else if (tick.type === 'option') {
        const quote = Object.assign(new OptionQuote(), tick.quote) as OptionQuote;
        const source = (tick.source ?? DEFAULT_FEED_SOURCE) as FeedSource;
        // One latest-wins slot per (feed, token, strategy): a strategy awaiting a broker call only coalesces its own ticks.
        for (const strategy of optionTickTargets(source, quote.token)) {
            enqueueLatest(`${source}:${quote.token}:${strategy.getClassName()}:${strategy.userId}`, quote, (q) => deliverOptionTick(strategy, q));
        }
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
                matched.forEach((s) => { s.reset(); clearOpenQtyFor(s); });
                return { kind: 'response', id: req.id, ok: true, result: { type: req.payload.type, reset: matched.length } };
            }

            case 'getCandles':
                return { kind: 'response', id: req.id, ok: true, result: niftyCandleBuilder.getCandles() };

            // Demo-mode support: fires a real subscribe/unsubscribe command for
            // an arbitrary token on request, with no ref-counting against
            // watchToken/registerTrade - a demo request isn't a Strategy, and
            // a stray duplicate/early (un)subscribe here is harmless.
            // Ref-counted through the token router (an external hold), so an unsubscribe here can never cut off a token that a live
            // strategy or open position is still using.
            case 'subscribeToken':
                holdExternal(req.payload.token);
                return { kind: 'response', id: req.id, ok: true, result: null };

            case 'unsubscribeToken':
                releaseExternal(req.payload.token);
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
    server.listen(STRATEGIES_SOCKET_PATH, () => {
        ownSocket.record(STRATEGIES_SOCKET_PATH);
        Log.log('[strategies] Listening on', STRATEGIES_SOCKET_PATH);
    });
}

const ownSocket = ownSocketTracker(); // see ipc/ownSocket.ts

async function main() {
    // TopStock (and antLegOps) resolve ANT contracts in this process - warm the NFO/NSE caches
    // before strategies.initialize() so the first in-window lookup is an in-memory read.
    AntContractMaster.getInstance().preload();

    await Mongo.init().catch((e) => Log.log('[strategies] Mongo.init failed (continuing without persistence):', e));

    OrderClient.getInstance().onFill((userId, trade, openQuantity) => {
        enqueueFifo(`fill:${userId}`, () => onFill(userId, trade, openQuantity));
    });
    OrderClient.getInstance().onCancelled((userId, notification) => {
        // Own queue: a cancel handler can wait seconds (BulkPcr sleeps, then re-places an exit over a long IPC call) and must not
        // hold up every fill for that user (updateTrade/stop/trail bookkeeping).
        enqueueFifo(`cancel:${userId}`, () => onOrderCancelled(userId, notification));
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

    // Restore today's max-profit / max-loss latches right away (not only inside reconcile(), which runs on demand).
    for (const strategy of strategies.getList()) {
        try {
            await (strategy as any).restoreLatches?.();
        } catch (e) {
            Log.log(`[strategies] restoreLatches() failed for ${strategy.userId}:`, e);
        }
    }

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

// A throw in any strategy callback (or a stray rejected promise) must not kill the process mid-position:
// a respawn drops every strategy's in-memory exit state. Log and keep running, same policy as `order`.
process.on('unhandledRejection', (reason) => {
    Log.log('[strategies] Unhandled promise rejection (process kept alive):', reason);
});
process.on('uncaughtException', (e) => {
    Log.log('[strategies] Uncaught exception (process kept alive):', e);
});

main().catch((e) => {
    Log.log('[strategies] Fatal startup error:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    ownSocket.unlink(STRATEGIES_SOCKET_PATH);
    process.exit(0);
});
