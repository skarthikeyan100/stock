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
