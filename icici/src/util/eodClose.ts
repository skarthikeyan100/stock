// settings.eodCloseTime (config.yml, 'HH:mm'): the one end-of-day close time for every strategy. It is deliberately NOT a per-strategy key
// (configValidation rejects it on a strategy block), so there is a single place to move the close, e.g. past the market close to carry
// positions overnight. When the setting is missing or not 'HH:mm', each strategy's own default applies (15:10; BulkPcr and Butterfly 15:15).
import configService from '../prism/ConfigService';
import { isPastTime, isWithinTradingWindow } from './marketHours';

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

// 2026-11-18: strategies stop receiving events at 15:25 (isWithinTradingWindow), so an eodCloseTime at or after 15:25 (15:30 that day)
// never ran: no tick, fill or cancellation reached a strategy once the EOD time was due, and the positions stayed open. From the
// configured eodCloseTime until EOD_EVENT_WINDOW_END the dispatcher therefore keeps delivering events (the tick-driven EOD close, its
// fills, cancellations), and a clock poke (shouldPokeEod) re-delivers the last Nifty tick when the feed has gone quiet.
// Only a time in [15:25, EOD_EVENT_WINDOW_END) opens it: an earlier time is inside the normal window, a later one (23:59 = carry the
// positions overnight) is no close at all and must not start selling after the market.
export const EOD_EVENT_WINDOW_END = '15:40';
const hhmmToMin = (v: string): number => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
const VALID_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isWithinEodEventWindow(now: Date = new Date()): boolean {
    const v = eodCloseTime();
    if (v === undefined || !VALID_HHMM.test(v)) return false;
    const limit = hhmmToMin(v);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return limit >= 15 * 60 + 25 && limit < hhmmToMin(EOD_EVENT_WINDOW_END) && nowMin >= limit && nowMin < hhmmToMin(EOD_EVENT_WINDOW_END);
}

// True when the clock-driven EOD poke should re-deliver the last Nifty tick: the EOD close is due, the event window is open for an
// EOD time past the normal window (an earlier EOD is served by the ordinary window) or the window itself is still open, and no real
// tick arrived for `quietMs`.
export function shouldPokeEod(lastTickMs: number, nowMs: number = Date.now(), quietMs = 2000): boolean {
    const now = new Date(nowMs);
    if (!isPastEodClose(DEFAULT_EOD_CLOSE_TIME, now)) return false;
    if (eodCloseTime() === undefined) return false; // no configured close: each strategy's own default is tick-driven inside the window
    if (!isWithinTradingWindow(now) && !isWithinEodEventWindow(now)) return false;
    return nowMs - lastTickMs >= quietMs;
}
