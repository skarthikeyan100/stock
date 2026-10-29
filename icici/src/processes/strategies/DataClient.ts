import { DataLink } from '../../ipc/DataLink';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../../ipc/feedSource';

// The strategy router's channel back to `data`: subscribe/unsubscribe commands go over the DataLink socket (owner 'strategies').

// exchange ('NFO'/'BFO') defaults to undefined - dataProcess.ts/each
// DataStream implementation treats that as 'NFO'. Only a SENSEX (BFO) token
// needs to pass 'BFO' explicitly (see tokenRouter.ts's callers).
export function subscribeToken(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    DataLink.getInstance().subscribe('strategies', { cmd: 'subscribe', token, source, exchange });
}

export function unsubscribeToken(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    DataLink.getInstance().subscribe('strategies', { cmd: 'unsubscribe', token, source, exchange });
}

// Depth-mode variants - only for the momentum signal's tbq/tsq (see
// MomentumSignal.ts). ANT-only on the `data` side (see DataStream.ts).
export function subscribeTokenDepth(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    DataLink.getInstance().subscribe('strategies', { cmd: 'subscribeDepth', token, source, exchange });
}

export function unsubscribeTokenDepth(token: string, source: FeedSource = DEFAULT_FEED_SOURCE, exchange?: 'NFO' | 'BFO'): void {
    DataLink.getInstance().subscribe('strategies', { cmd: 'unsubscribeDepth', token, source, exchange });
}
