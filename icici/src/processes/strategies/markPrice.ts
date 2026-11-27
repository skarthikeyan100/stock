import Log from '../../util/Log';
import { exchangeForTsym } from '../../util/underlyings';
import OrderClient from './OrderClient';

// The price an open position is valued at by the profit monitors (globalMaxProfit.ts, combinedMaxProfit.ts). Order of preference (user's rule 2026-11-25:
// tick price wherever possible, a live ANT call only when no tick exists, and never a 429):
//   1. the last option TICK this process received for the token (recordTick, fed by the tick handler in strategiesProcess.ts: every token a strategy
//      holds or watches ticks here), no network call;
//   2. a live ANT quote (getOptionLtp), only for a position no strategy here has a tick for (a manual / frontend position, a feed that just
//      reconnected). Cached LIVE_CACHE_MS per token, calls spaced LIVE_MIN_GAP_MS apart, and after a 429 no live call for LIVE_BACKOFF_MS;
//   3. the order process's own last price for the row, else its cost (0 unrealized: the total under-counts, it never trips early).
// Tick tokens are ANT tokens (the order books hold ANT tokens for every broker's rows), so ticks are looked up on the 'ant' feed.
export const TICK_MAX_AGE_MS = 5 * 60_000;
export const LIVE_CACHE_MS = 30_000;
export const LIVE_MIN_GAP_MS = 1_200;
export const LIVE_BACKOFF_MS = 60_000;

const ticks = new Map<string, { ltp: number; at: number }>();
const live = new Map<string, { ltp: number; at: number }>();
let lastLiveAt = 0;
let backoffUntil = 0;
let liveChain: Promise<unknown> = Promise.resolve();
let liveFetch: (user: string, tsym: string, token: string) => Promise<number> = (user, tsym, token) =>
    OrderClient.getInstance().getOptionLtp(user, { tradingSymbol: tsym, token, exchange: exchangeForTsym(tsym) });

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const key = (source: string, token: unknown) => `${source}:${String(token)}`;

export function recordTick(source: string, token: unknown, ltp: unknown, now = Date.now()): void {
    const p = num(ltp);
    if (p > 0) ticks.set(key(source, token), { ltp: p, at: now });
}

export function tickPrice(token: unknown, now = Date.now()): number {
    const t = ticks.get(key('ant', token));
    return t && now - t.at <= TICK_MAX_AGE_MS ? t.ltp : 0;
}

async function liveQuote(user: string, tsym: string, token: string): Promise<number> {
    const k = key('ant', token);
    const hit = live.get(k);
    if (hit && Date.now() - hit.at < LIVE_CACHE_MS) return hit.ltp;
    if (Date.now() < backoffUntil) return hit?.ltp ?? 0;
    // One live call at a time, LIVE_MIN_GAP_MS apart (ANT answers 429 to rapid sequential calls).
    const run = liveChain.then(async () => {
        const again = live.get(k);
        if (again && Date.now() - again.at < LIVE_CACHE_MS) return again.ltp; // another waiter fetched it meanwhile
        if (Date.now() < backoffUntil) return again?.ltp ?? 0;
        const wait = lastLiveAt + LIVE_MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastLiveAt = Date.now();
        try {
            const ltp = num(await liveFetch(user, tsym, token));
            if (ltp > 0) { live.set(k, { ltp, at: Date.now() }); return ltp; }
        } catch (e) {
            if (/429|too many requests|rate.?limit/i.test(String((e as any)?.message ?? e))) {
                backoffUntil = Date.now() + LIVE_BACKOFF_MS;
                Log.log(`[markPrice] ANT answered 429 - no live price calls for ${LIVE_BACKOFF_MS / 1000}s (ticks / stored prices are used meanwhile)`);
            }
        }
        return again?.ltp ?? 0;
    });
    liveChain = run.catch(() => undefined);
    return run;
}

export async function markPrice(t: { user: string; tsym: string; token: unknown; price: unknown; lastTradePrice?: unknown }): Promise<number> {
    const tick = tickPrice(t.token);
    if (tick > 0) return tick;
    const q = await liveQuote(t.user, t.tsym, String(t.token));
    if (q > 0) return q;
    return num(t.lastTradePrice) > 0 ? num(t.lastTradePrice) : num(t.price);
}

// Test hooks.
export function __setLiveFetch(f: typeof liveFetch): void { liveFetch = f; }
export function __reset(): void { ticks.clear(); live.clear(); lastLiveAt = 0; backoffUntil = 0; liveChain = Promise.resolve(); }
