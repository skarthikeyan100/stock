import { Strategy } from '../../strategy/strategy';
import { OptionQuote } from '../../model/model';
import { subscribeToken, unsubscribeToken } from './DataClient';

// Local (in-process) replacement for Monitor's watchTokens/strategyMap-based
// option-tick routing, now that trades/watch-state live only inside the
// strategies process (order process only knows about fills, not live quotes).
// Two ways a strategy becomes interested in a token:
//   - watchToken: pre-trade watch (e.g. TargetReachStrategy waiting to enter)
//   - registerTrade: post-fill, called from the OrderClient fill handler

const watchers = new Map<string, Set<Strategy>>();
const tradeHolders = new Map<string, Set<Strategy>>();

function refCount(token: string): number {
    return (watchers.get(token)?.size ?? 0) + (tradeHolders.get(token)?.size ?? 0);
}

export function watchToken(token: string, strategy: Strategy): void {
    if (!watchers.has(token)) watchers.set(token, new Set());
    const set = watchers.get(token)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(token) === 1) subscribeToken(token);
}

export function unwatchToken(token: string, strategy: Strategy): void {
    const set = watchers.get(token);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) watchers.delete(token);
    if (refCount(token) === 0) unsubscribeToken(token);
}

export function registerTrade(token: string, strategy: Strategy): void {
    if (!tradeHolders.has(token)) tradeHolders.set(token, new Set());
    const set = tradeHolders.get(token)!;
    if (set.has(strategy)) return;
    set.add(strategy);
    if (refCount(token) === 1) subscribeToken(token);
}

export function unregisterTrade(token: string, strategy: Strategy): void {
    const set = tradeHolders.get(token);
    if (!set?.has(strategy)) return;
    set.delete(strategy);
    if (set.size === 0) tradeHolders.delete(token);
    if (refCount(token) === 0) unsubscribeToken(token);
}

export async function routeOptionTick(quote: OptionQuote): Promise<void> {
    const dispatched = new Set<Strategy>();
    for (const set of [tradeHolders.get(quote.token), watchers.get(quote.token)]) {
        if (!set) continue;
        for (const strategy of set) {
            if (!dispatched.has(strategy) && strategy.canHandleOptionQuote(quote)) {
                dispatched.add(strategy);
                await strategy.processOptionQuote(quote);
            }
        }
    }
}
