import { NiftyQuote } from '../../model/model';

// Lightweight 15-minute NIFTY OHLC candle builder for GET /candles, fed from the
// same ticks strategies already receives. Deliberately not reusing the legacy
// src/candle.ts (drags in Prism/Selenium/finvasia-SDK, and its CandleManager had
// a hardcoded "only build on the 21st of the month" guard that made it broken
// most days) - this is a small, working replacement instead of a faithful port
// of a known-broken feature.

const INTERVAL_MS = 15 * 60 * 1000;
const MAX_CANDLES = 200;

interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

const candles: Candle[] = [];

export function record(quote: NiftyQuote): void {
    if (!quote?.ltp) return;
    const bucket = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
    const last = candles[candles.length - 1];
    if (last && last.timestamp === bucket) {
        last.high = Math.max(last.high, quote.ltp);
        last.low = Math.min(last.low, quote.ltp);
        last.close = quote.ltp;
    } else {
        candles.push({ timestamp: bucket, open: quote.ltp, high: quote.ltp, low: quote.ltp, close: quote.ltp });
        if (candles.length > MAX_CANDLES) candles.shift();
    }
}

export function getCandles(): Candle[] {
    return [...candles];
}
