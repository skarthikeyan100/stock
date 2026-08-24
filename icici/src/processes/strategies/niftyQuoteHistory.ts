import { NiftyQuote } from '../../model/model';

// Local replacement for Monitor.getRecentNiftyQuotes/niftyQuoteHistory. `order`
// deliberately has no live tick feed (GTT-at-entry replaced the old per-tick
// SL/target loop, so it never needed one) - `strategies` already receives every
// NIFTY tick directly over stdin, so this stays process-local rather than
// round-tripping through `order`.

const MAX_SIZE = 100;
const history: NiftyQuote[] = [];

export function record(quote: NiftyQuote): void {
    history.push({ ...quote } as NiftyQuote);
    if (history.length > MAX_SIZE) history.shift();
}

// Most recent first, same contract as Monitor.getRecentNiftyQuotes.
export function getRecent(count: number): NiftyQuote[] {
    return history.slice(-count).reverse();
}
