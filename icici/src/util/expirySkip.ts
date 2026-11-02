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

// Kite/Breeze/Prism parse their expiry as LOCAL midnight (18:30 UTC the day before in IST), ANT's is UTC midnight: +12h then floor gives the
// same calendar day for both, which tradingDaysToExpiry then reads.
const calendarDayUtc = (ms: number): number => Math.floor((ms + 12 * 3600000) / 86400000) * 86400000;

// `expiriesMs`: the candidate expiries (any order, midnight-UTC epoch ms). Returns the offset into them, ascending.
export function effectiveExpiryOffset(expiriesMs: number[], requested: number, nowMs: number = Date.now()): number {
    if (requested !== 0 || !skipNearestExpiryOnEve()) return requested;
    const distinct = Array.from(new Set(expiriesMs)).sort((a, b) => a - b);
    return distinct.length > 1 && tradingDaysToExpiry(calendarDayUtc(distinct[0]), nowMs) === 1 ? 1 : 0;
}
