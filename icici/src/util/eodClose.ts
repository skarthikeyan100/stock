// settings.eodCloseTime (config.yml, 'HH:mm'): the one end-of-day close time for every strategy. It is deliberately NOT a per-strategy key
// (configValidation rejects it on a strategy block), so there is a single place to move the close, e.g. past the market close to carry
// positions overnight. When the setting is missing or not 'HH:mm', each strategy's own default applies (15:10; BulkPcr and Butterfly 15:15).
import configService from '../prism/ConfigService';
import { isPastTime } from './marketHours';

export const DEFAULT_EOD_CLOSE_TIME = '15:10';

export function eodCloseTime(): string | undefined {
    try {
        const v = (configService.getConfig()?.settings as any)?.eodCloseTime;
        return v == null ? undefined : String(v);
    } catch {
        return undefined;
    }
}

// The time actually in force: the global setting when it is a valid 'HH:mm', else `fallback`.
export function effectiveEodCloseTime(fallback: string = DEFAULT_EOD_CLOSE_TIME): string {
    const v = eodCloseTime();
    return v !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
}

export function isPastEodClose(fallback: string = DEFAULT_EOD_CLOSE_TIME, now: Date = new Date()): boolean {
    return isPastTime(eodCloseTime(), fallback, now);
}
