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

function refCount(k: string): number {
    return (watchers.get(k)?.size ?? 0) + (tradeHolders.get(k)?.size ?? 0);
}

export function watchToken(token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const source = resolveSource(strategy);
    const k = key(source, token);
    if (!watchers.has(k)) watchers.set(k, new Set());
    const set = watchers.get(k)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(k) === 1) subscribeToken(token, source, exchange);
}

export function unwatchToken(token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const source = resolveSource(strategy);
    const k = key(source, token);
    const set = watchers.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) watchers.delete(k);
    if (refCount(k) === 0) unsubscribeToken(token, source, exchange);
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
    if (refCount(k) === 1) subscribeToken(token, source, exchange);
}

export function unwatchTokenOnSource(source: FeedSource, token: string, strategy: Strategy, exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    const set = watchers.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) watchers.delete(k);
    if (refCount(k) === 0) unsubscribeToken(token, source, exchange);
}

export function registerTrade(token: string, strategy: Strategy, source: FeedSource = resolveSource(strategy), exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    if (!tradeHolders.has(k)) tradeHolders.set(k, new Set());
    const set = tradeHolders.get(k)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(k) === 1) subscribeToken(token, source, exchange);
}

export function unregisterTrade(token: string, strategy: Strategy, source: FeedSource = resolveSource(strategy), exchange?: 'NFO' | 'BFO'): void {
    const k = key(source, token);
    const set = tradeHolders.get(k);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) tradeHolders.delete(k);
    if (refCount(k) === 0) unsubscribeToken(token, source, exchange);
}

// Strategies currently holding or watching this token on this feed.
export function optionTickTargets(source: FeedSource, token: string): Strategy[] {
    const k = key(source, token);
    const targets = new Set<Strategy>();
    for (const set of [tradeHolders.get(k), watchers.get(k)]) {
        if (!set) continue;
        for (const strategy of set) targets.add(strategy);
    }
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

// All targets concurrently (one throwing or awaiting a slow broker call must not starve the rest). The strategies
// process uses optionTickTargets + deliverOptionTick with a latest-wins slot per strategy instead, so a slow
// strategy cannot delay delivery to the others at all.
export async function routeOptionTick(source: FeedSource, quote: OptionQuote): Promise<void> {
    await Promise.all(optionTickTargets(source, quote.token).map((strategy) => deliverOptionTick(strategy, quote)));
}
