// Broker-independent contract key for the tick history (collection `tickHistory`): UNDERLYING|EXPIRY(YYYY-MM-DD)|STRIKE|CE/PE, e.g.
// NIFTY|2026-12-01|25750|PE. A Kite (NIFTY26D0125750PE), ANT / Prism (NIFTY01DEC26P25750) and Breeze (NIFTY01DEC2625750PE) name of one
// contract all give the same key. Pure helpers; the contract masters are only consulted through the optional `lookup` argument.
import { readOptionTsym } from './optionTsym';

const IST_OFFSET_MS = 330 * 60_000;

// The IST calendar day (YYYY-MM-DD) of an epoch-ms instant, independent of the process time zone.
export function istDay(ms: number): string {
    return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function optionKey(underlying: string, expiryYmd: string, strike: number, optionType: 'CE' | 'PE'): string {
    return `${underlying.toUpperCase()}|${expiryYmd}|${strike}|${optionType}`;
}

export function expiryYmdOfMs(utcMidnightMs: number): string {
    return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');

// The key of any broker's option trading symbol. A spelling that names its exact expiry day needs no master; a month-only or expiry-less
// spelling (Kite monthly, legacy Breeze) is resolved by `lookup(tsym)` (the ANT master) and is undefined when that cannot name a contract.
export function keyFromTsym(tsym: string, lookup?: (tsym: string) => { symbol: string; expiryMs: number; strike: number; optionType: string } | undefined): string | undefined {
    // With a master the listed contract decides (spellings overlap: Kite's NIFTY26DEC25750PE also reads as 26-DEC-2025 strike 750).
    const hit = lookup?.(tsym);
    if (hit && (hit.optionType === 'CE' || hit.optionType === 'PE')) return optionKey(hit.symbol, expiryYmdOfMs(hit.expiryMs), hit.strike, hit.optionType);
    const readings = readOptionTsym(tsym);
    for (const r of readings) {
        if (r.expiry.kind === 'day' && r.expiry.month >= 0) {
            return optionKey(r.symbol, `${r.expiry.year}-${pad(r.expiry.month + 1)}-${pad(r.expiry.day)}`, r.strike, r.optionType);
        }
    }
    return undefined;
}
