import { roundToTick } from './tick';

export function crossCheckQuote(q: { bestBid: number; bestAsk: number; ltp: number }, live: { ltp: number; bid: number; ask: number } | null): { bestBid: number; bestAsk: number; widened: boolean } {
    const askSources = [q.bestAsk, q.ltp, live?.ask ?? 0, live?.ltp ?? 0].filter((v) => Number.isFinite(v) && v > 0);
    const bidSources = [q.bestBid, live?.bid ?? 0].filter((v) => Number.isFinite(v) && v > 0);
    // An empty source list would make Math.max() -Infinity / Math.min() Infinity: fall back to the quote's own side.
    const bestAsk = askSources.length > 0 ? roundToTick(Math.max(...askSources)) : q.bestAsk;
    const bestBid = bidSources.length > 0 ? Math.max(0.05, roundToTick(Math.min(...bidSources))) : q.bestBid;
    return { bestBid, bestAsk, widened: bestAsk > q.bestAsk + 1e-9 || bestBid < q.bestBid - 1e-9 };
}
