// Percentage-valued config keys. Written in config.yml as either a bare number
// (`40`) or a number with a percent sign (`40%`). YAML reads `40%` as the
// string "40%", so everything that does arithmetic on these keys must go
// through toPercentNumber() (or receive values already normalised by
// ConfigService.loadConfig()).
export const PERCENT_KEYS: ReadonlySet<string> = new Set([
    'consistencyLimitPercent',
    'maxDailyDrawdownPercent',
    'maxWeeklyDrawdownPercent',
    'maxProfit',
    'maxLoss',
    'marketProtectionPercent',
]);

const PERCENT_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/;

// Returns the numeric value for a number or a "N" / "N%" string, else null.
export function toPercentNumber(v: unknown): number | null {
    if (typeof v === 'number') return Number.isNaN(v) ? null : v;
    if (typeof v !== 'string') return null;
    const m = PERCENT_PATTERN.exec(v);
    return m ? Number(m[1]) : null;
}

// Returns a shallow copy of `obj` with every percent key normalised to a
// number where possible. Non-percent keys and unparseable values are left as
// they are (validation reports the latter).
export function normalizePercentFields<T extends Record<string, any>>(obj: T): T {
    if (!obj || typeof obj !== 'object') return obj;
    const out: Record<string, any> = { ...obj };
    for (const key of Object.keys(out)) {
        if (!PERCENT_KEYS.has(key)) continue;
        const n = toPercentNumber(out[key]);
        if (n !== null) out[key] = n;
    }
    return out as T;
}

// Default drawdown limits (% of investment) when the settings key is absent.
// Single source for payout.ts and bookkeeping.ts so the two stops cannot drift.
export const DRAWDOWN_DEFAULTS = {
    maxDailyDrawdownPercent: 25,
    maxWeeklyDrawdownPercent: 50,
} as const;

export function drawdownLimit(settings: Record<string, any> | undefined, key: keyof typeof DRAWDOWN_DEFAULTS): number {
    return toPercentNumber(settings?.[key]) ?? DRAWDOWN_DEFAULTS[key];
}

// The one drawdown rule, shared by the live blocker (bookkeeping.ts) and the
// payout forfeiture (payout.ts). 'unknown' when pnl could not be read.
export type DrawdownState = 'ok' | 'breached' | 'unknown';

export function drawdownDecision(pnl: number | null, investmentAmount: number, limitPercent: number): DrawdownState {
    if (pnl === null) return 'unknown';
    return pnl <= -(investmentAmount * limitPercent) / 100 ? 'breached' : 'ok';
}

// Formats a percent field for config.yml: number 40 -> "40%". Values that do
// not parse are passed through untouched.
export function formatPercentFields<T extends Record<string, any>>(obj: T): T {
    if (!obj || typeof obj !== 'object') return obj;
    const out: Record<string, any> = { ...obj };
    for (const key of Object.keys(out)) {
        if (!PERCENT_KEYS.has(key)) continue;
        const n = toPercentNumber(out[key]);
        if (n !== null) out[key] = `${n}%`;
    }
    return out as T;
}
