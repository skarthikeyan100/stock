// settings.skipNearestExpiryOnEve (config.yml, default off): on the trading day BEFORE the nearest expiry, trade the next expiry instead
// (the expiring contract has the most gamma and theta; 2026-11-02 every losing BulkPcr/Continuous trade was on a next-day expiry).
// Applied inside every contract master's "nearest expiry" resolution, entries AND the strike-based re-resolution a sell does, so one
// day never mixes two expiries. Only a requested offset of 0 is bumped; an explicit offset or an exact expiry is left alone.
import configService from '../prism/ConfigService';
import { tradingDaysToExpiry } from './expiryOffset';

export function skipNearestExpiryOnEve(): boolean {
    try {
        return (configService.getConfig()?.settings as any)?.skipNearestExpiryOnEve === true;
    } catch {
        return false;
    }
}

// settings.skipNearestExpiryOnExpiryDay (config.yml, default off): ON the nearest expiry's own day, trade the next expiry instead (user's
// rule 2026-11-09 for SimpleContinuous/MomentumAtFixedTime; global because sells re-resolve strike -> nearest expiry in the Breeze path, so a
// next-expiry buy beside a nearest-expiry sell would close the wrong contract). Same offset-0-only rule as the eve filter.
export function skipNearestExpiryOnExpiryDay(): boolean {
    try {
        return (configService.getConfig()?.settings as any)?.skipNearestExpiryOnExpiryDay === true;
    } catch {
        return false;
    }
}

// A strategy block's own skipNearestExpiryOnExpiryDay (boolean) overrides the global setting for the contracts that strategy looks up: pass the
// result as the `skipNearestExpiryDay` argument of a contract lookup. undefined = no override (the lookup follows the setting).
export function expiryDayOverrideOf(block: any): boolean | undefined {
    const v = block?.skipNearestExpiryOnExpiryDay;
    return typeof v === 'boolean' ? v : undefined;
}

// Kite/Breeze/Prism parse their expiry as LOCAL midnight (18:30 UTC the day before in IST), ANT's is UTC midnight: +12h then floor gives the
// same calendar day for both, which tradingDaysToExpiry then reads.
export const calendarDayUtc = (ms: number): number => Math.floor((ms + 12 * 3600000) / 86400000) * 86400000;

// `expiriesMs`: the candidate expiries (any order, midnight-UTC epoch ms). Returns the offset into them, ascending.
// `skipExpiryDay`: the per-call override of settings.skipNearestExpiryOnExpiryDay (true/false); undefined follows the setting.
export function effectiveExpiryOffset(expiriesMs: number[], requested: number, nowMs: number = Date.now(), skipExpiryDay?: boolean): number {
    if (requested !== 0) return requested;
    const eve = skipNearestExpiryOnEve();
    const expiryDay = skipExpiryDay ?? skipNearestExpiryOnExpiryDay();
    if (!eve && !expiryDay) return 0;
    const distinct = Array.from(new Set(expiriesMs)).sort((a, b) => a - b);
    if (distinct.length < 2) return 0;
    const days = tradingDaysToExpiry(calendarDayUtc(distinct[0]), nowMs);
    return (eve && days === 1) || (expiryDay && days === 0) ? 1 : 0;
}
