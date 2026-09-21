import { writeJsonLine } from '../../ipc/jsonLines';
import { FeedSource, DEFAULT_FEED_SOURCE } from '../../ipc/feedSource';

// strategies' only channel back to `data`: subscribe/unsubscribe commands go out
// on strategies' own stdout, which the orchestrator relays into `data`'s stdin
// (the reverse of the tick pipe). stdout is reserved for this protocol -
// strategiesProcess.ts redirects console.log to stderr for that reason.

export function subscribeToken(token: string, source: FeedSource = DEFAULT_FEED_SOURCE): void {
    writeJsonLine(process.stdout, { cmd: 'subscribe', token, source });
}

export function unsubscribeToken(token: string, source: FeedSource = DEFAULT_FEED_SOURCE): void {
    writeJsonLine(process.stdout, { cmd: 'unsubscribe', token, source });
}

// Depth-mode variants - only for the momentum signal's tbq/tsq (see
// MomentumSignal.ts). ANT-only on the `data` side (see DataStream.ts).
export function subscribeTokenDepth(token: string, source: FeedSource = DEFAULT_FEED_SOURCE): void {
    writeJsonLine(process.stdout, { cmd: 'subscribeDepth', token, source });
}

export function unsubscribeTokenDepth(token: string, source: FeedSource = DEFAULT_FEED_SOURCE): void {
    writeJsonLine(process.stdout, { cmd: 'unsubscribeDepth', token, source });
}
