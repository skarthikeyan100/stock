import Log from '../util/Log';
import Mongo from '../tools/mongo';
import { localDayKey } from '../strategy/dayKey';
import { SeedCandle } from '../processes/strategies/niftyStatsBuilder';

// 15-minute NIFTY 50 candles from Yahoo Finance (^NSEI), used once per trading day to seed the 50 EMA of NextWeekStrategy. Yahoo is an
// unofficial, keyless endpoint: it can change or rate-limit without notice, so every failure is reported and the caller does not trade
// until it holds enough candles. The index has no traded volume (Yahoo returns 0).
//
// Verified 2026-11-12: interval=15m&range=5d returned 126 candles (5 days x 25 + a one-tick 15:30 candle), timestamps aligned to 09:15 IST.

const URL_15M = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=15m&range=5d';
const CACHE_COLLECTION = 'candles15Seed';
const CANDLE_SECONDS = 900;
const SESSION_CLOSE_SECONDS = (15 * 60 + 30) * 60; // a candle starting at 15:30 or later is the closing-auction artefact
const FETCH_TIMEOUT_MS = 15_000;

export interface YahooCandle extends SeedCandle { volume: number }

// Pure: Yahoo's chart JSON -> closed candles of days BEFORE `todayKey`, oldest first. Rows with a null field are dropped (Yahoo leaves
// holes), a candle starting at 15:30 or later is dropped, and so is anything from today (the current day's candles come from our own ticks).
export function parseYahooCandles(json: any, todayKey: string): YahooCandle[] {
    const result = json?.chart?.result?.[0];
    const ts: number[] | undefined = result?.timestamp;
    const q = result?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return [];
    const out: YahooCandle[] = [];
    for (let i = 0; i < ts.length; i++) {
        const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
        if (![open, high, low, close].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) continue;
        const start = new Date(ts[i] * 1000);
        if (localDayKey(start) >= todayKey) continue;
        const secondsOfDay = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds();
        if (secondsOfDay >= SESSION_CLOSE_SECONDS) continue;
        out.push({ time: ts[i], open, high, low, close, volume: Number(q.volume?.[i]) || 0 });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

export async function fetchNiftyCandles15(todayKey: string = localDayKey()): Promise<YahooCandle[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(URL_15M, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`Yahoo responded HTTP ${res.status}`);
        return parseYahooCandles(await res.json(), todayKey);
    } finally {
        clearTimeout(timer);
    }
}

// The seed for today: the Mongo copy when one was stored today, else one Yahoo call (stored afterwards). So a restart does not call Yahoo
// again, and a normal day calls it once. Throws when Yahoo fails and nothing is cached; `source` tells the log which path ran.
export async function loadSeedCandles(todayKey: string = localDayKey()): Promise<{ candles: YahooCandle[]; source: 'cache' | 'yahoo' }> {
    const col = () => Mongo.getInstance()?.db?.collection(CACHE_COLLECTION);
    try {
        const doc: any = await col()?.findOne({ _id: todayKey as any });
        if (Array.isArray(doc?.candles) && doc.candles.length > 0) return { candles: doc.candles, source: 'cache' };
    } catch (e: any) {
        Log.log(`[yahooCandles] could not read the ${CACHE_COLLECTION} cache (${e?.message ?? e}) - fetching from Yahoo`);
    }
    const candles = await fetchNiftyCandles15(todayKey);
    if (candles.length === 0) throw new Error('Yahoo returned no usable candles');
    try {
        await col()?.updateOne({ _id: todayKey as any }, { $set: { candles, fetchedAt: new Date() } }, { upsert: true });
    } catch (e: any) {
        Log.log(`[yahooCandles] could not store the ${CACHE_COLLECTION} cache (${e?.message ?? e}) - a restart will fetch again`);
    }
    return { candles, source: 'yahoo' };
}

// Today's own completed 15-minute candles (built from our ticks), kept in Mongo so a mid-day restart still has the earlier candles of the day
// instead of a hole in the EMA series. One document per day.
const LIVE_COLLECTION = 'candles15Live';

export async function loadLiveCandles(dayKey: string = localDayKey()): Promise<SeedCandle[]> {
    try {
        const doc: any = await Mongo.getInstance()?.db?.collection(LIVE_COLLECTION).findOne({ _id: dayKey as any });
        return Array.isArray(doc?.candles) ? doc.candles : [];
    } catch (e: any) {
        Log.log(`[yahooCandles] could not read today's candles from ${LIVE_COLLECTION} (${e?.message ?? e})`);
        return [];
    }
}

export async function saveLiveCandles(candles: SeedCandle[], dayKey: string = localDayKey()): Promise<void> {
    try {
        await Mongo.getInstance()?.db?.collection(LIVE_COLLECTION).updateOne({ _id: dayKey as any }, { $set: { candles, updatedAt: new Date() } }, { upsert: true });
    } catch (e: any) {
        Log.log(`[yahooCandles] could not store today's candles in ${LIVE_COLLECTION} (${e?.message ?? e}) - a restart will lose them`);
    }
}

export const CANDLE_INTERVAL_SECONDS = CANDLE_SECONDS;
