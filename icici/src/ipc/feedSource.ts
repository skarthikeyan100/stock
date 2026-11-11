// Shared by dataProcess.ts, tokenRouter.ts and DataClient.ts - which live
// price-tick WebSocket a token's ticks come from. Kite/Kite has no usable
// WS in this app, so it proxies through ANT (unchanged, long-standing
// behavior); ANT and Breeze stream natively through their own connections.
// Prism (Shoonya) has no tick stream of its own in the `data` process, and
// Shoonya's and ANT's tokens are the same NSE/BSE exchange tokens (NIFTY17NOV26P25400
// is 45407 in both contract masters), so a Prism position's ticks come from the ANT
// feed, like Kite's. A PrismDataStream would be a new map entry here plus one in
// dataProcess.ts. 'prism' stays in the type only so a stray source value still
// type-checks; nothing routes to it (11:55 2026-11-11: RuleBased's Prism buy
// registered its token on a 'prism' feed the data process does not have - "Unknown
// feed source: prism" - so its tick-driven exit never ran).
export type FeedSource = 'ant' | 'breeze' | 'prism';

export const DEFAULT_FEED_SOURCE: FeedSource = 'ant';

export const BROKER_TO_FEED_SOURCE: Record<string, FeedSource> = {
    kite: 'ant',
    ant: 'ant',
    breeze: 'breeze',
    prism: 'ant',
};
