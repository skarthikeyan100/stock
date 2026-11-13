import { roundToTick } from './tick';

export function crossCheckQuote(q: { bestBid: number; bestAsk: number; ltp: number }, live: { ltp: number; bid: number; ask: number } | null): { bestBid: number; bestAsk: number; widened: boolean } {
    const askSources = [q.bestAsk, q.ltp, live?.ask ?? 0, live?.ltp ?? 0].filter((v) => Number.isFinite(v) && v > 0);
    const bidSources = [q.bestBid, live?.bid ?? 0].filter((v) => Number.isFinite(v) && v > 0);
    const bestAsk = roundToTick(Math.max(...askSources));
    const bestBid = Math.max(0.05, roundToTick(Math.min(...bidSources)));
    return { bestBid, bestAsk, widened: bestAsk > q.bestAsk + 1e-9 || bestBid < q.bestBid - 1e-9 };
}
