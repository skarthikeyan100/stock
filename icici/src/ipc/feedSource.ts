// Shared by dataProcess.ts, tokenRouter.ts and DataClient.ts - which live
// price-tick WebSocket a token's ticks come from. Kite/Zerodha has no usable
// WS in this app, so it proxies through ANT (unchanged, long-standing
// behavior); ANT and Breeze stream natively through their own connections.
// Prism gets its own entry once a PrismDataStream (mirroring AntDataStream/
// BreezeDataStream) exists - adding it is a one-line table change, not a
// rearchitecture, since every call site here resolves through this table
// rather than hardcoding 'ant' vs 'breeze'.
export type FeedSource = 'ant' | 'breeze' | 'prism';

export const DEFAULT_FEED_SOURCE: FeedSource = 'ant';

export const BROKER_TO_FEED_SOURCE: Record<string, FeedSource> = {
    zerodha: 'ant',
    ant: 'ant',
    breeze: 'breeze',
    prism: 'prism',
};
