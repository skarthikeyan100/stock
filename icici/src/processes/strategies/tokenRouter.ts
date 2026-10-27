import Log from '../../util/Log';
import { Strategy } from '../../strategy/strategy';
import { OptionQuote } from '../../model/model';
import { subscribeToken, unsubscribeToken } from './DataClient';
import { FeedSource, DEFAULT_FEED_SOURCE, BROKER_TO_FEED_SOURCE } from '../../ipc/feedSource';
import { normalizeBrokerName } from '../../util/brokerName';

// Local (in-process) replacement for Monitor's watchTokens/strategyMap-based
// option-tick routing, now that trades/watch-state live only inside the
// strategies process (order process only knows about fills, not live quotes).
// Two ways a strategy becomes interested in a token:
//   - watchToken: pre-trade watch (e.g. TargetReachStrategy waiting to enter)
//   - registerTrade: post-fill, called from the OrderClient fill handler

// Lazy require, not a top-level import: strategies.ts -> StrategyFactory.ts ->
// (e.g.) ContinuousStrategy.ts -> LegManager.ts -> tokenRouter.ts would be a
// require cycle if this were imported eagerly. Accessed only inside
// resolveSource()'s body, mirroring how strategiesProcess.ts's onFill already
// does an equivalent lazy lookup.
function getStrategies() {
    return require('../../strategy/strategies').default;
}

// Which live-tick WebSocket a strategy's watched/held tokens should come from
// - resolved from its own configured broker (config.yml's per-strategy
// `broker:` key), defaulting to 'ant' exactly like order-execution routing
// does (bookkeeping.getUserBroker). Kept out of LegManager.ts/Strategy - every
// watchToken/registerTrade call site keeps its existing (token, strategy)
// signature.
function resolveSource(strategy: Strategy): FeedSource {
    const broker = getStrategies().getExpandedConfig(strategy.userId)?.broker;
    return (broker && BROKER_TO_FEED_SOURCE[normalizeBrokerName(broker) as keyof typeof BROKER_TO_FEED_SOURCE]) || DEFAULT_FEED_SOURCE;
}

function key(source: FeedSource, token: string): string {
    return `${source}:${token}`;
}

const watchers = new Map<string, Set<Strategy>>();
const tradeHolders = new Map<string, Set<Strategy>>();
// What the data process was last told to subscribe, per feed key. An unsubscribe that omits the exchange reuses the one recorded here
// (a BFO token must be unsubscribed as BFO), and resubscribeAll() replays these after the data process restarts.
const subscribed = new Map<string, { token: string; source: FeedSource; exchange?: 'NFO' | 'BFO' }>();

function subscribeFeed(token: string, source: FeedSource, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    subscribed.set(k, { token, source, exchange: exchange ?? subscribed.get(k)?.exchange });
    subscribeToken(token, source, exchange);
}

function unsubscribeFeed(token: string, source: FeedSource, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    const ex = exchange ?? subscribed.get(k)?.exchange;
    subscribed.delete(k);
    unsubscribeToken(token, source, ex);
}

// The data process comes back from a crash or hot restart with an empty subscription map, while the refcounts here still say its
// tokens are subscribed - so open legs/slots would silently get no ticks. Re-sends every live subscription (subscribe is idempotent).
export function resubscribeAll(): number {
    let n = 0;
    for (const [k, sub] of subscribed) {
        if (refCount(k) > 0) { subscribeToken(sub.token, sub.source, sub.exchange); n++; }
    }
    return n;
}

// Keys an external (non-strategy) client holds, e.g. the anonymous demo page's subscriptions. They take part in the ref-count, so
// releasing one can never unsubscribe a token a live strategy or position still depends on.
const externalHolds = new Set<string>();
// Short-lived holds by a strategy for one-off reads (the momentum depth check), counted separately from the strategy's own
// watch/position so releasing one can never remove the other.
const leases = new Map<string, Map<Strategy, number>>();

function refCount(k: string): number {
    return (watchers.get(k)?.size ?? 0) + (tradeHolders.get(k)?.size ?? 0) + (externalHolds.has(k) ? 1 : 0) + (leases.get(k)?.size ?? 0);
}

// Takes a lease for `strategy` on a token and returns its release. Independent of watchTokenOnSource/registerTrade: the strategy
// receives the token's ticks while any lease, watch or position holds it.
export function leaseTokenOnSource(source: FeedSource, token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): () => void {
    const k = key(source, token);
    if (!leases.has(k)) leases.set(k, new Map());
    const m = leases.get(k)!;
    m.set(strategy, (m.get(strategy) ?? 0) + 1);
    if (refCount(k) === 1) subscribeFeed(token, source, exchange);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const n = (m.get(strategy) ?? 1) - 1;
        if (n <= 0) m.delete(strategy); else m.set(strategy, n);
        if (m.size === 0) leases.delete(k);
        if (refCount(k) === 0) unsubscribeFeed(token, source, exchange);
    };
}

export function holdExternal(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    if (externalHolds.has(k)) return;
    externalHolds.add(k);
    if (refCount(k) === 1) subscribeFeed(token, source, exchange);
}

export function releaseExternal(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    if (!externalHolds.delete(k)) return;
    if (refCount(k) === 0) unsubscribeFeed(token, source, exchange);
}

export function watchToken(token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const source = resolveSource(strategy);
    const k = key(source, token);
    if (!watchers.has(k)) watchers.set(k, new Set());
    const set = watchers.get(k)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(k) === 1) subscribeFeed(token, source, exchange);
}

export function unwatchToken(token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const source = resolveSource(strategy);
    const k = key(source, token);
    const set = watchers.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) watchers.delete(k);
    if (refCount(k) === 0) unsubscribeFeed(token, source, exchange);
}

// Explicit-source variants of watchToken/unwatchToken above, for callers that
// need a specific feed source regardless of the strategy's own configured
// execution broker - namely MomentumSignal.ts, which needs ANT's tbq/tsq
// (depth mode, ANT-only) even when the owning strategy's `broker:` config
// routes its order execution (and therefore its own watchToken/registerTrade
// calls, via resolveSource) through Breeze instead.
//
// exchange ('NFO'/'BFO') is threaded through to subscribeToken/unsubscribeToken
// so a SENSEX (BFO) token's ANT websocket subscription is keyed correctly
// instead of always assuming NFO (found on code review) - callers holding a
// BFO instrument (e.g. BulkPcrStrategy's SENSEX-configured instance) must
// pass 'BFO' explicitly; every existing NFO caller is unaffected by the default.
export function watchTokenOnSource(source: FeedSource, token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    if (!watchers.has(k)) watchers.set(k, new Set());
    const set = watchers.get(k)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(k) === 1) subscribeFeed(token, source, exchange);
}

export function unwatchTokenOnSource(source: FeedSource, token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    const set = watchers.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) watchers.delete(k);
    if (refCount(k) === 0) unsubscribeFeed(token, source, exchange);
}

export function registerTrade(token: string, strategy: Strategy, source: FeedSource = resolveSource(strategy), exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    if (!tradeHolders.has(k)) tradeHolders.set(k, new Set());
    const set = tradeHolders.get(k)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(k) === 1) subscribeFeed(token, source, exchange);
}

export function unregisterTrade(token: string, strategy: Strategy, source: FeedSource = resolveSource(strategy), exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    const set = tradeHolders.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) tradeHolders.delete(k);
    if (refCount(k) === 0) unsubscribeFeed(token, source, exchange);
}

// Strategies currently holding or watching this token on this feed.
export function optionTickTargets(source: FeedSource, token: string): Strategy[] {
    const k = key(source, token);
    const targets = new Set<Strategy>();
    for (const set of [tradeHolders.get(k), watchers.get(k)]) {
        if (!set) continue;
        for (const strategy of set) targets.add(strategy);
    }
    for (const strategy of leases.get(k)?.keys() ?? []) targets.add(strategy);
    return [...targets];
}

// Delivers one tick to one strategy, isolated from the others.
export async function deliverOptionTick(strategy: Strategy, quote: OptionQuote): Promise<void> {
    try {
        if (strategy.canHandleOptionQuote(quote)) await strategy.processOptionQuote(quote);
    } catch (e) {
        Log.log(`[tokenRouter] ${strategy.getClassName()}:${strategy.userId} processOptionQuote threw (other strategies unaffected):`, e);
    }
}
