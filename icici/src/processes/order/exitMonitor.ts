import Log from '../../util/Log';
import { writeJsonLine } from '../../ipc/jsonLines';
import { OptionQuote, Trade } from '../../model/model';
import configService from '../../prism/ConfigService';

// In-app target/SL exit monitoring, for trades placed with useGTT=false (see
// bookkeeping.getUserUseGTT / zerodhaExecutor.finalizeEntry, antExecutor.finalizeEntry).
// Mirrors strategies' tokenRouter.ts+DataClient.ts pattern one level up:
// subscribe/unsubscribe commands go out on `order`'s own stdout, which the
// orchestrator relays into `data`'s stdin, and ticks come back in on `order`'s
// stdin (see orderProcess.ts). The actual squareoff call is injected per-broker
// via onExit() rather than imported directly, to avoid a circular dependency
// with zerodhaExecutor.ts/antExecutor.ts.

export type Broker = 'zerodha' | 'ant' | 'prism';

interface MonitoredTrade {
    trade: Trade;
    exchange: 'NFO' | 'BFO';
    broker: Broker;
    // True for trades whose actual exit is owned by a broker-side bracket
    // (Zerodha GTT / ANT bracket order, useGTT=true) - handleOptionTick still
    // refreshes trade.lastTradePrice for these (so the frontend's live P&L
    // keeps moving) but must never itself trigger a square-off, since the
    // broker already will.
    watchOnly: boolean;
}

type ExitHandler = (trade: Trade, exchange: 'NFO' | 'BFO') => Promise<void>;
type PriceUpdateListener = () => void;

// Composite key so two users holding a position in the *same* option
// contract (same token) are tracked independently - see bugs.md
// "Cross-user protection loss on shared contracts". Previously this map was
// keyed by trade.token alone, so a second user's registerTrade() for a
// token already held by a different user silently overwrote the first
// user's entry, permanently dropping that first user's target/SL
// monitoring with no error and no self-healing (even reconcileFromTrades on
// restart re-clobbered the same token).
const monitored = new Map<string, MonitoredTrade>(); // keyed by monitorKey(user, token)

function monitorKey(user: string, token: string): string {
    return `${user || 'Default'}:${token}`;
}

// True if any entry in `monitored` (for any user) is currently watching this
// token. Used to decide whether a subscribe/unsubscribe IPC command actually
// needs to go out: with the composite key above, two users can both hold
// entries for the same token, and the token-level websocket subscription
// (owned by `data`'s AntDataStream, a plain non-ref-counted Set - see
// dataProcess.ts / AntDataStream.ts) must only be dropped once the *last*
// watcher for that token is gone. Otherwise unregistering one user's trade
// would silently kill live ticks (and therefore target/SL monitoring) for
// another user's still-open trade on the same token.
function isTokenWatched(token: string): boolean {
    for (const entry of monitored.values()) {
        if (entry.trade.token === token) return true;
    }
    return false;
}

const exitHandlers = new Map<Broker, ExitHandler>();
// Same "register a callback instead of importing directly" pattern as onExit
// above, for the same reason: bookkeeping.ts already imports this module, so
// this module can't import bookkeeping.ts back without a circular dependency.
// orderProcess.ts (which imports both) wires this to
// bookkeeping.triggerPositionsChanged() so /positionstream actually pushes a
// fresh snapshot when a monitored trade's live price moves - previously
// nothing did this between trade events (fill/close/target-SL edit), so a
// position's displayed LTP/P&L only ever changed when a *different* trade
// action happened to also refresh the stream, not on the price tick itself.
const priceUpdateListeners: PriceUpdateListener[] = [];
let lastPriceNotifyAt = 0;
const PRICE_NOTIFY_THROTTLE_MS = 500; // caps SSE broadcast rate regardless of tick frequency

export function onExit(broker: Broker, handler: ExitHandler): void {
    exitHandlers.set(broker, handler);
}

export function onPriceUpdate(listener: PriceUpdateListener): void {
    priceUpdateListeners.push(listener);
}

// Strategy `type`s that own their entire exit lifecycle themselves (their own
// chunked resting-limit-sell, not a GTT/bracket/cover the broker owns) and
// must NEVER be picked up by this generic target/SL watch, in either
// direction: not at entry time, and not on a restart-triggered
// reconcileFromTrades() restore from a possibly-stale persisted Trade doc.
// Live incident 2026-09-24: a Zerodha BulkPcrStrategy Buy doc had
// targetPrice=stopLossPrice=entryPrice persisted (a since-fixed
// zerodhaExecutor.finalizeEntry bug, see its comment), and every process
// restart re-armed this watch from that doc regardless of the entry-time fix
// - it fired almost immediately (price only has to move off entry by a
// tick) and called the wrong, unchunked squareoff, which always exceeds the
// exchange's per-order freeze-quantity limit for a position this size and
// retried with no backoff, hammering Zerodha's API. This is the single choke
// point every registerTrade() caller goes through, so excluding here closes
// the gap regardless of what's already sitting in Mongo.
//
// Matched by TYPE against `configService.getStrategyConfig(type).userId`
// (falling back to `type`, mirroring StrategyFactory.createStrategy's own
// default) rather than a hardcoded literal userId string - `trade.user` only
// happens to equal 'BulkPcrStrategy' today because config.yml has no
// explicit `userId:` override for it. A literal-string Set would silently
// stop matching (recreating the exact 2026-09-24 gap with no error) the
// moment someone adds one; deriving it from live config every call can't
// drift out of sync. ConfigService is safe to read directly here - it's a
// plain fs.watch-backed singleton per process (already used elsewhere in
// this same `order` process, e.g. bookkeeping.ts/zerodhaExecutor.ts), not an
// IPC call into the separate `strategies` process.
const SELF_MANAGED_STRATEGY_TYPES = ['BulkPcrStrategy'];

function isSelfManagedTradeUser(userId: string): boolean {
    return SELF_MANAGED_STRATEGY_TYPES.some((type) => {
        const cfg = configService.getStrategyConfig(type);
        return (cfg.userId || type) === userId;
    });
}

export function registerTrade(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker, watchOnly = false): void {
    if (isSelfManagedTradeUser(trade.user)) {
        Log.log(`[order] exitMonitor: skipping ${trade.tsym} for ${trade.user} - self-managed strategy, never watched here`);
        return;
    }
    const key = monitorKey(trade.user, trade.token);
    // Check BEFORE inserting this entry - if some other entry (e.g. another
    // user's trade) already watches this token, the underlying token
    // subscription is already live and must not be requested again.
    const alreadySubscribed = isTokenWatched(trade.token);
    monitored.set(key, { trade, exchange, broker, watchOnly });
    if (!alreadySubscribed) {
        writeJsonLine(process.stdout, { cmd: 'subscribe', token: trade.token });
    }
    Log.log(`[order] exitMonitor watching ${trade.tsym} (token ${trade.token}, ${broker}) for ${trade.user}: target=${trade.targetPrice} stopLoss=${trade.stopLossPrice}${watchOnly ? ' (watch-only, broker owns exit)' : ''}`);
}

export function unregisterTrade(user: string, token: string): void {
    const key = monitorKey(user, token);
    if (!monitored.has(key)) return;
    monitored.delete(key);
    // Only unsubscribe at the token level once nobody else is still
    // watching it (see isTokenWatched above) - otherwise this would
    // silently cut off live ticks for another user still holding a
    // position in the same contract.
    if (!isTokenWatched(token)) {
        writeJsonLine(process.stdout, { cmd: 'unsubscribe', token });
    }
}

// Called once at order-process startup: exitMonitor's in-memory `monitored`
// map doesn't survive a restart, but bookkeeping.trades is the live source
// of truth for open positions. Any open trade with a target/SL set that
// isn't already being watched gets re-registered here, closing the
// "restart silently drops SL/target monitoring for useGTT=false users" gap.
export function reconcileFromTrades(trades: Trade[]): void {
    let reconciled = 0;
    for (const trade of trades) {
        if (!trade.token) continue;
        if (monitored.has(monitorKey(trade.user, trade.token))) continue;
        if (trade.targetPrice == null && trade.stopLossPrice == null) continue;
        // Exchange/broker aren't stored on Trade - infer exchange the same
        // way setTargetStopLoss does (tsym prefix), and broker from
        // whichever executor's Trade shape this is (antOrderNo present -> ant,
        // prismCoverOrderNo present -> prism, otherwise zerodha - matches
        // this file's existing Broker union).
        const exchange: 'NFO' | 'BFO' = trade.tsym?.startsWith('BSE') ? 'BFO' : 'NFO';
        const broker: Broker = trade.antOrderNo ? 'ant' : trade.prismCoverOrderNo ? 'prism' : 'zerodha';
        // A GTT/bracket/cover trade already has its exit owned by the broker -
        // reconcile it watch-only (mark-to-market only) so a restart doesn't
        // also arm an in-app square-off that would race the broker's own
        // bracket/cover. Previously only checked gttTriggerId (Zerodha-only),
        // which meant a restored ANT bracket/cover trade (no gttTriggerId -
        // that field is Zerodha-specific) was wrongly reconciled as
        // NOT watch-only - the same gap a Prism cover-order restore would hit
        // too, since Prism has no gttTriggerId either.
        const watchOnly = trade.gttTriggerId != null || trade.antOrderNo != null || trade.prismCoverOrderNo != null;
        registerTrade(trade, exchange, broker, watchOnly);
        reconciled++;
    }
    if (reconciled > 0) {
        Log.log(`[order] exitMonitor: reconciled ${reconciled} open trade(s) with target/SL back onto the watch list after restart`);
    }
}

export async function handleOptionTick(quote: OptionQuote): Promise<void> {
    const tokenStr = String(quote.token);
    // A token can now have more than one monitored entry (one per user
    // holding a position in that contract - see monitorKey above), so
    // collect every matching entry first rather than a single
    // monitored.get(token) lookup. Snapshotting into an array up front also
    // means later mutations of `monitored` (e.g. the unregisterTrade call
    // below, for an earlier match in this same loop) can't disturb
    // iteration of the remaining matches.
    const matches: MonitoredTrade[] = [];
    for (const entry of monitored.values()) {
        if (entry.trade.token === tokenStr) matches.push(entry);
    }
    if (matches.length === 0) return;

    const now = Date.now();
    let notifiedListeners = false;

    for (const entry of matches) {
        const { trade, exchange, broker, watchOnly } = entry;
        trade.lastTradePrice = quote.ltp;

        if (!notifiedListeners && now - lastPriceNotifyAt >= PRICE_NOTIFY_THROTTLE_MS) {
            lastPriceNotifyAt = now;
            for (const listener of priceUpdateListeners) listener();
            notifiedListeners = true;
        }

        // Watch-only: keep lastTradePrice fresh for the frontend's live P&L, but
        // the broker's own GTT/bracket owns the actual exit - never square off here.
        if (watchOnly) continue;

        const hitTarget = trade.targetPrice != null && quote.ltp >= trade.targetPrice;
        const hitStopLoss = trade.stopLossPrice != null && quote.ltp <= trade.stopLossPrice;
        if (!hitTarget && !hitStopLoss) continue;

        // Unregister before awaiting the exit so a second tick arriving while the
        // squareoff is in flight can't trigger it twice. If the exit attempt
        // fails below, this entry is re-registered in the catch block so a
        // future tick can retry it - see the comment there (bug-04).
        unregisterTrade(trade.user, trade.token);
        Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

        const exitHandler = exitHandlers.get(broker);
        if (!exitHandler) {
            Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
            continue;
        }
        try {
            await exitHandler(trade, exchange);
        } catch (e) {
            // A transient failure here (network hiccup, broker rate limit, etc.)
            // must not silently end target/SL protection on this position for
            // the rest of the day. Re-register with the same trade/exchange/
            // broker/watchOnly this entry was unregistered with above, so the
            // next tick retries the exit. Deliberately unconditional (no retry
            // cap/backoff) - worst case this keeps trying to protect the
            // position, which is the desired behavior; see bug-04 plan for
            // rationale.
            Log.log('[order] exitMonitor squareoff failed - re-registering for retry:', trade.tsym, e);
            registerTrade(trade, exchange, broker, watchOnly);
        }
    }
}
