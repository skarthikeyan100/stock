/**
 * Rules per proficiency level (Beginner / Advanced), one global block in config.yml:
 *   settings.levelRules.<level>: { maxDailyDrawdownPercent, maxWeeklyDrawdownPercent, maxLossPerTradePercent, capital, profitSplitPercent }
 * A missing level or a missing/invalid field falls back (drawdown limits: first to an explicit global settings.maxDaily/WeeklyDrawdownPercent,
 * then) to DEFAULT_LEVEL_RULES, so an absent block still gives sensible numbers.
 * A user's level is `proficiencyLevel` on the user document (default: beginner). There is no maximum payment (removed 2026-11-14).
 */
import { toPercentNumber } from './prism/percentConfig';

export type ProficiencyLevel = 'beginner' | 'advanced';
export const LEVELS: ProficiencyLevel[] = ['beginner', 'advanced'];

export interface LevelRules {
    level: ProficiencyLevel;
    maxDailyDrawdownPercent: number;   // % of the allocated capital
    maxWeeklyDrawdownPercent: number;  // % of the allocated capital
    maxLossPerTradePercent: number;    // % of the allocated capital one trade may lose at its stop-loss (enforced as the position's stop, never as a size cap: see levelLimits.ts)
    capital: number;                   // starting allocated capital in rupees
    profitSplitPercent: number;        // the user's share of gross profit
}

export const DEFAULT_LEVEL_RULES: Record<ProficiencyLevel, Omit<LevelRules, 'level'>> = {
    beginner: { maxDailyDrawdownPercent: 15, maxWeeklyDrawdownPercent: 30, maxLossPerTradePercent: 10, capital: 100000, profitSplitPercent: 35 },
    advanced: { maxDailyDrawdownPercent: 15, maxWeeklyDrawdownPercent: 30, maxLossPerTradePercent: 10, capital: 200000, profitSplitPercent: 25 },
};

export function normalizeLevel(v: unknown): ProficiencyLevel {
    return typeof v === 'string' && v.trim().toLowerCase() === 'advanced' ? 'advanced' : 'beginner';
}

export function levelLabel(level: ProficiencyLevel): string { return level === 'advanced' ? 'Advanced' : 'Beginner'; }

export function levelRules(settings: Record<string, any> | undefined, level: unknown): LevelRules {
    const lv = normalizeLevel(level);
    const own = settings?.levelRules?.[lv] ?? {};
    const def = DEFAULT_LEVEL_RULES[lv];
    const pct = (key: 'maxDailyDrawdownPercent' | 'maxWeeklyDrawdownPercent' | 'maxLossPerTradePercent', globalKey?: string): number => {
        const n = toPercentNumber(own[key]);
        if (n !== null && n > 0) return n;
        if (globalKey) { const g = toPercentNumber(settings?.[globalKey]); if (g !== null && g > 0) return g; }
        return def[key];
    };
    const positive = (v: unknown, fallback: number, max?: number): number => {
        const n = typeof v === 'number' ? v : Number.NaN;
        return Number.isFinite(n) && n > 0 && (max === undefined || n <= max) ? n : fallback;
    };
    return {
        level: lv,
        maxDailyDrawdownPercent: pct('maxDailyDrawdownPercent', 'maxDailyDrawdownPercent'),
        maxWeeklyDrawdownPercent: pct('maxWeeklyDrawdownPercent', 'maxWeeklyDrawdownPercent'),
        maxLossPerTradePercent: pct('maxLossPerTradePercent'),
        capital: positive(own.capital, def.capital),
        profitSplitPercent: positive(own.profitSplitPercent, def.profitSplitPercent, 100),
    };
}
