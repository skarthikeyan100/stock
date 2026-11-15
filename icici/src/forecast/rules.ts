/** Forecast submission rules (spec v2.1 section 7), all from config.yml `forecast:` with defaults; pure functions, no I/O. */
import configService from '../prism/ConfigService';

export interface ForecastConfig {
    hours: { start: string; end: string; expiryEnd: string };
    dailyLimit: number;
    windowMinutes: number;
    neutralThresholdPoints: number;
    holidays: string[];            // YYYY-MM-DD exchange holidays (there is no calendar elsewhere in the repo)
}

const hhmm = (v: unknown, d: string) => (/^\d{2}:\d{2}$/.test(String(v ?? '')) ? String(v) : d);
const posInt = (v: unknown, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
const posNum = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function getForecastConfig(): ForecastConfig {
    const f: any = (configService.getConfig() as any)?.forecast ?? {};
    return {
        hours: { start: hhmm(f.hours?.start, '09:20'), end: hhmm(f.hours?.end, '15:00'), expiryEnd: hhmm(f.hours?.expiryEnd, '14:30') },
        dailyLimit: posInt(f.dailyLimit, 3),
        windowMinutes: posInt(f.windowMinutes, 15),
        neutralThresholdPoints: posNum(f.neutralThresholdPoints, 5),
        holidays: Array.isArray(f.holidays) ? f.holidays.map(String).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    };
}

export const istParts = (d: Date): { date: string; hhmm: string; weekday: number } => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
    const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: wd[p.weekday] };
};

export type Verdict = { ok: true } | { ok: false; error: string };

export interface SubmitContext {
    now: Date;
    cfg: ForecastConfig;
    isExpiryDay: boolean;
    todaysCount: number;       // this contractor's forecasts so far today (IST), any outcome
    hasOpenWindow: boolean;    // a forecast of theirs whose window has not closed
}

/** Why a forecast cannot be recorded now, or ok. The messages are shown to the contractor as they are. */
export function checkSubmission(c: SubmitContext): Verdict {
    const t = istParts(c.now);
    if (t.weekday === 0 || t.weekday === 6 || c.cfg.holidays.includes(t.date)) return { ok: false, error: 'The exchange is closed today, so forecasts are not accepted.' };
    const end = c.isExpiryDay ? c.cfg.hours.expiryEnd : c.cfg.hours.end;
    if (t.hhmm < c.cfg.hours.start || t.hhmm > end) return { ok: false, error: `Forecasts are accepted from ${c.cfg.hours.start} to ${end} IST${c.isExpiryDay ? ' on expiry days' : ''} (it is ${t.hhmm} now).` };
    if (c.hasOpenWindow) return { ok: false, error: 'You already have a forecast whose window is still open. Wait until it closes.' };
    if (c.todaysCount >= c.cfg.dailyLimit) return { ok: false, error: `You have used all ${c.cfg.dailyLimit} forecasts for today.` };
    return { ok: true };
}
