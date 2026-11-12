import Log from '../../util/Log';
import { DataLink } from '../../ipc/DataLink';
import { OptionQuote, Trade } from '../../model/model';
import configService from '../../prism/ConfigService';
import { BROKER_TO_FEED_SOURCE, DEFAULT_FEED_SOURCE } from '../../ipc/feedSource';
import { exchangeForTsym } from '../../util/underlyings';

// In-app target/SL exit monitoring, for trades placed with useGTT=false (see
// bookkeeping.getUserUseGTT / kiteExecutor.finalizeEntry, antExecutor.finalizeEntry).
// Mirrors strategies' tokenRouter.ts+DataClient.ts pattern one level up:
// subscribe/unsubscribe commands go to `data` over the DataLink socket
// (owner 'exit'), and ticks come back on the same link (see orderProcess.ts). The actual squareoff call is injected per-broker
// via onExit() rather than imported directly, to avoid a circular dependency
// with kiteExecutor.ts/antExecutor.ts.

export type Broker = 'kite' | 'ant' | 'prism' | 'breeze';

interface MonitoredTrade {
    trade: Trade;
    exchange: 'NFO' | 'BFO';
    broker: Broker;
    // True for trades whose actual exit is owned by a broker-side bracket
    // (Kite GTT / ANT bracket order, useGTT=true) - handleOptionTick still
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

// Broker is part of the key too: one user (a strategy pseudo-user) can hold the same
// contract token on two brokers at once, and each needs its own entry.
function monitorKey(user: string, token: string, broker?: Broker): string {
    return `${user || 'Default'}:${broker ?? ''}:${token}`;
}

// Resolves the bookkeeping aggregate row (one per tsym+user+broker) behind a monitored trade.
// Wired by orderProcess.ts (bookkeeping imports this module, so it can't be imported here).
// A chunked entry registers one detached Trade per chunk, each carrying only that chunk's
// quantity - the exit must size off the aggregate, and live-price updates must reach it too.
type AggregateResolver = (trade: Trade, broker: Broker) => Trade | undefined;
let aggregateResolver: AggregateResolver | undefined;
export function setAggregateResolver(resolver: AggregateResolver): void {
    aggregateResolver = resolver;
}

function feedSourceOf(broker: Broker): string {
    return BROKER_TO_FEED_SOURCE[broker] ?? DEFAULT_FEED_SOURCE;
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
function isTokenWatched(token: string, exchange?: 'NFO' | 'BFO', source?: string): boolean {
    for (const entry of monitored.values()) {
        if (entry.trade.token === token && (exchange === undefined || entry.exchange === exchange) && (source === undefined || feedSourceOf(entry.broker) === source)) return true;
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

// Called ONCE (not per tick) when a squareoff is refused because the broker holds nothing sellable: the broker already closed the position
// (its GTT/bracket fired, a resting sell filled) and what is left is to book that. Kite wires it to the GTT-fill poll.
const resolveHandlers = new Map<Broker, ExitHandler>();
export function onExitResolve(broker: Broker, handler: ExitHandler): void {
    resolveHandlers.set(broker, handler);
}

// Per position+broker retry gate for a failed squareoff. Without it a failure re-registered the watch and the very next tick fired the
// squareoff again (live 2026-11-12 10:11: 279 refusals in 90 s, one ALERT and one broker read each). Exponential delay from 5 s to 60 s;
// a refusal because the broker holds nothing sellable stops after NEVER_SHORT_MAX_ATTEMPTS (the position is gone at the broker, retrying
// cannot help). Any other failure keeps retrying at the capped delay, since giving up would leave the position unprotected.
interface RetryState { attempts: number; nextAt: number }
const retryGate = new Map<string, RetryState>();
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
export const NEVER_SHORT_MAX_ATTEMPTS = 3;
export function retryDelayMs(attempts: number): number {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function onPriceUpdate(listener: PriceUpdateListener): void {
    priceUpdateListeners.push(listener);
}

// Strategy `type`s that own their entire exit lifecycle themselves (their own
// chunked resting-limit-sell, not a GTT/bracket/cover the broker owns) and
// must NEVER be picked up by this generic target/SL watch, in either
// direction: not at entry time, and not on a restart-triggered
// reconcileFromTrades() restore from a possibly-stale persisted Trade doc.
// Live incident 2026-09-24: a Kite BulkPcrStrategy Buy doc had
// targetPrice=stopLossPrice=entryPrice persisted (a since-fixed
// kiteExecutor.finalizeEntry bug, see its comment), and every process
// restart re-armed this watch from that doc regardless of the entry-time fix
// - it fired almost immediately (price only has to move off entry by a
// tick) and called the wrong, unchunked squareoff, which always exceeds the
// exchange's per-order freeze-quantity limit for a position this size and
// retried with no backoff, hammering Kite's API. This is the single choke
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
// this same `order` process, e.g. bookkeeping.ts/kiteExecutor.ts), not an
// IPC call into the separate `strategies` process.
// TopStockOptionsOpeningGapStrategy added here for the identical reason -
// its legs are entered via enterPosition's 'target-only' orderMode (no
// broker bracket/cover), with the strategy itself placing a separate resting
// target sell as the sole exit. Without this entry, reconcileFromTrades()
// would re-register such a trade as ACTIVE on any order-process restart
// (its watchOnly heuristic there only recognizes gttTriggerId/antOrderNo/
// prismCoverOrderNo, none of which a plain-order target-only trade carries),
// letting exitMonitor fire a second, competing squareOffOnAnt once price
// crosses targetPrice - racing the already-resting limit sell from
// placeLimitSellBareOnAnt. Being in this list also makes entry-time's own
// watch-only registerTrade call a no-op (registerTrade's self-managed gate
// below fires before the watchOnly check either way) - accepted trade-off:
// this strategy's trade.lastTradePrice won't refresh off live ticks, in
// exchange for the restart-reconcile safety this list exists for.
const SELF_MANAGED_STRATEGY_TYPES = ['BulkPcrStrategy', 'TopStockOptionsOpeningGapStrategy'];

function isSelfManagedTradeUser(userId: string): boolean {
    // Not configService.getStrategyConfig(type) per type - that returns only
    // the FIRST config.yml entry of that type, regardless of userId. config.yml
    // can configure multiple instances of a listed type under distinct userId
    // values (e.g. TopStockOptionsOpeningGapStrategy's own firedTodayFile
    // comment anticipates this), and a getStrategyConfig(type)-based check
    // would only ever recognize the first such instance as self-managed,
    // leaving a second instance's trades wrongly actively watched - racing
    // its own resting exit order exactly like the 2026-09-24 gap this list
    // exists to prevent. Scan every config.yml entry of a listed type instead.
    const strategies = configService.getInstances();
    return strategies.some((cfg) => SELF_MANAGED_STRATEGY_TYPES.includes(cfg.type) && (cfg.userId || cfg.type) === userId);
}

export function registerTrade(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker, watchOnly = false): void {
    registerTradeInternal(trade, exchange, broker, watchOnly, false);
}

// `retry`: the exit monitor itself putting a failed squareoff back on the watch list - keeps the retry gate and logs nothing per call.
// An outside registration is new information about the position, so it clears the gate.
function registerTradeInternal(trade: Trade, exchange: 'NFO' | 'BFO', broker: Broker, watchOnly: boolean, retry: boolean): void {
    if (!retry) retryGate.delete(monitorKey(trade.user, trade.token, broker));
    if (isSelfManagedTradeUser(trade.user)) {
        Log.log(`[order] exitMonitor: skipping ${trade.tsym} for ${trade.user} - self-managed strategy, never watched here`);
        return;
    }
    const key = monitorKey(trade.user, trade.token, broker);
    // Check BEFORE inserting this entry - if some other entry (e.g. another
    // user's trade) already watches this token, the underlying token
    // subscription is already live and must not be requested again.
    const alreadySubscribed = isTokenWatched(trade.token, exchange, feedSourceOf(broker));
    monitored.set(key, { trade, exchange, broker, watchOnly });
    if (!alreadySubscribed) {
        // exchange + source must be explicit: a SENSEX (BFO) token subscribed without
        // the exchange is requested as NFO and never ticks.
        DataLink.getInstance().subscribe('exit', { cmd: 'subscribe', token: trade.token, source: BROKER_TO_FEED_SOURCE[broker] ?? DEFAULT_FEED_SOURCE, exchange });
    }
    if (!retry) Log.log(`[order] exitMonitor watching ${trade.tsym} (token ${trade.token}, ${broker}) for ${trade.user}: target=${trade.targetPrice} stopLoss=${trade.stopLossPrice}${watchOnly ? ' (watch-only, broker owns exit)' : ''}`);
}

// `broker` omitted removes every broker's entry for this user+token.
export function unregisterTrade(user: string, token: string, broker?: Broker): void {
    unregisterTradeInternal(user, token, broker, false);
}

function unregisterTradeInternal(user: string, token: string, broker: Broker | undefined, keepRetry: boolean): void {
    const removed: MonitoredTrade[] = [];
    for (const [key, entry] of Array.from(monitored.entries())) {
        if (entry.trade.token !== token || (entry.trade.user || 'Default') !== (user || 'Default')) continue;
        if (broker !== undefined && entry.broker !== broker) continue;
        monitored.delete(key);
        if (!keepRetry) retryGate.delete(key);
        removed.push(entry);
    }
    // Only unsubscribe at the token level once nobody else is still
    // watching it (see isTokenWatched above) - otherwise this would
    // silently cut off live ticks for another user still holding a
    // position in the same contract.
    for (const entry of removed) {
        if (!isTokenWatched(token, entry.exchange, feedSourceOf(entry.broker))) {
            DataLink.getInstance().subscribe('exit', { cmd: 'unsubscribe', token, source: BROKER_TO_FEED_SOURCE[entry.broker] ?? DEFAULT_FEED_SOURCE, exchange: entry.exchange });
        }
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
        const reBroker: Broker = trade.broker === 'ant' || trade.broker === 'prism' || trade.broker === 'kite' || trade.broker === 'breeze'
            ? trade.broker
            : trade.antOrderNo ? 'ant' : trade.prismCoverOrderNo ? 'prism' : 'kite';
        if (monitored.has(monitorKey(trade.user, trade.token, reBroker))) continue;
        if (trade.targetPrice == null && trade.stopLossPrice == null) continue;
        // Exchange/broker aren't stored on Trade - infer exchange the same
        // way setTargetStopLoss does (tsym prefix), and broker from
        // whichever executor's Trade shape this is (antOrderNo present -> ant,
        // prismCoverOrderNo present -> prism, otherwise kite - matches
        // this file's existing Broker union).
        const exchange: 'NFO' | 'BFO' = exchangeForTsym(trade.tsym);
        const broker: Broker = reBroker;
        // A GTT/bracket/cover trade already has its exit owned by the broker -
        // reconcile it watch-only (mark-to-market only) so a restart doesn't
        // also arm an in-app square-off that would race the broker's own
        // bracket/cover. Previously only checked gttTriggerId (Kite-only),
        // which meant a restored ANT bracket/cover trade (no gttTriggerId -
        // that field is Kite-specific) was wrongly reconciled as
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
        // A zero/negative/non-finite LTP is a missing quote, not a price: it would satisfy
        // `ltp <= stopLossPrice` and square the position off at a bogus level.
        if (!(quote.ltp > 0) || !Number.isFinite(quote.ltp)) continue;
        trade.lastTradePrice = quote.ltp;
        const aggregate = aggregateResolver?.(trade, broker);
        if (aggregate && aggregate !== trade) aggregate.lastTradePrice = quote.ltp;

        if (!notifiedListeners && now - lastPriceNotifyAt >= PRICE_NOTIFY_THROTTLE_MS) {
            lastPriceNotifyAt = now;
            for (const listener of priceUpdateListeners) listener();
            notifiedListeners = true;
        }

        // Watch-only: keep lastTradePrice fresh for the frontend's live P&L, but
        // the broker's own GTT/bracket owns the actual exit - never square off here.
        if (watchOnly) continue;
        // A trade that carries a broker exit (a Kite GTT id) is broker-owned whatever flag this entry was registered with: a restart
        // restores the row before its GTT id is known and registers it active (live 2026-11-12: the stop then fired at the broker AND
        // here). Never run a competing squareoff for it; the GTT-fill poll books the broker's exit.
        if (trade.gttTriggerId != null || aggregate?.gttTriggerId != null) {
            entry.watchOnly = true;
            Log.log(`[order] exitMonitor: ${trade.tsym} (${trade.user}, ${broker}) has broker GTT ${trade.gttTriggerId ?? aggregate?.gttTriggerId} - switching to watch-only, no self squareoff`);
            continue;
        }
        const gate = retryGate.get(monitorKey(trade.user, trade.token, broker));
        if (gate && now < gate.nextAt) continue; // a failed squareoff is waiting out its backoff

        const hitTarget = trade.targetPrice != null && quote.ltp >= trade.targetPrice;
        const hitStopLoss = trade.stopLossPrice != null && quote.ltp <= trade.stopLossPrice;
        if (!hitTarget && !hitStopLoss) continue;

        // Unregister before awaiting the exit so a second tick arriving while the
        // squareoff is in flight can't trigger it twice. If the exit attempt
        // fails below, this entry is re-registered in the catch block so a
        // future tick can retry it - see the comment there (bug-04).
        unregisterTradeInternal(trade.user, trade.token, broker, true);
        Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

        const exitHandler = exitHandlers.get(broker);
        if (!exitHandler) {
            Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
            continue;
        }
        const key = monitorKey(trade.user, trade.token, broker);
        try {
            // Size the exit off the aggregate row (all chunks), falling back to the monitored trade.
            await exitHandler(aggregate ?? trade, exchange);
            retryGate.delete(key);
        } catch (e) {
            // A transient failure here (network hiccup, broker rate limit, etc.) must not silently end target/SL protection on this
            // position for the rest of the day: put the watch back, but behind the retry gate (see retryGate above).
            const state = retryGate.get(key) ?? { attempts: 0, nextAt: 0 };
            state.attempts++;
            const neverShort = /NEVER-SHORT GUARD: nothing sellable/.test(String((e as any)?.message ?? e));
            if (neverShort) {
                // The broker holds nothing sellable: it already closed this position (GTT/bracket fired, a resting sell filled) or the
                // tracking is stale. Ask the broker's resolver to book it - once, here, not per tick.
                try {
                    await resolveHandlers.get(broker)?.(aggregate ?? trade, exchange);
                } catch (re) {
                    Log.log(`[order] exitMonitor: resolving the broker-side exit of ${trade.tsym} (${trade.user}, ${broker}) failed:`, re);
                }
                const stillOpen = aggregateResolver ? aggregateResolver(trade, broker) !== undefined : true;
                if (!stillOpen) {
                    Log.log(`[order] exitMonitor: ${trade.tsym} (${trade.user}, ${broker}) was already closed at the broker and is now booked - squareoff not needed`);
                    retryGate.delete(key);
                    continue;
                }
                if (state.attempts >= NEVER_SHORT_MAX_ATTEMPTS) {
                    Log.log(`[order] ALERT: exitMonitor gave up squaring off ${trade.tsym} (${trade.user}, ${broker}) after ${state.attempts} refusals - the broker holds nothing sellable but the position is still open here; the next GTT poll or npm run sync (POST /sync) books it`);
                    retryGate.delete(key);
                    continue;
                }
            }
            const delay = retryDelayMs(state.attempts);
            state.nextAt = Date.now() + delay;
            retryGate.set(key, state);
            Log.log(`[order] ALERT: exitMonitor squareoff failed for ${trade.tsym} (${trade.user}, ${broker}), attempt ${state.attempts} - retrying in ${delay / 1000}s:`, (e as any)?.message ?? e);
            registerTradeInternal(trade, exchange, broker, watchOnly, true);
        }
    }
}
