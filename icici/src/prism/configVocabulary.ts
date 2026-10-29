// config.yml vocabulary migration (REFACTOR_PLAN.md section 3): canonical name <- legacy name.
//   settings:    targetPoints <- targetPriceDiff, stopLossPoints <- stopLossPriceDiff   (point offsets)
//   strategies:  maxExposure  <- maxInvestment                                          (spend cap)
// Both names are accepted on read (the canonical one wins) and BOTH are kept on the loaded object, so any reader of either works and
// a file is written with both until the old names are dropped in a later release.
import { DEFAULT_MAX_INVESTMENT } from '../constants';

const SETTINGS_PAIRS: [canonical: string, legacy: string][] = [['targetPoints', 'targetPriceDiff'], ['stopLossPoints', 'stopLossPriceDiff']];
const STRATEGY_PAIRS: [canonical: string, legacy: string][] = [['maxExposure', 'maxInvestment']];

function fill<T extends Record<string, any>>(block: T, pairs: [string, string][]): T {
    if (!block || typeof block !== 'object') return block;
    const out: Record<string, any> = { ...block };
    for (const [canonical, legacy] of pairs) {
        const value = out[canonical] ?? out[legacy];
        if (value !== undefined && value !== null) { out[canonical] = value; out[legacy] = value; }
    }
    return out as T;
}

export const withCanonicalSettings = <T extends Record<string, any>>(settings: T): T => fill(settings, SETTINGS_PAIRS);
export const withCanonicalStrategy = <T extends Record<string, any>>(strategy: T): T => fill(strategy, STRATEGY_PAIRS);

// The spend cap of a strategy block, whichever name it carries (the canonical one wins), falling back to the project default. One
// expression for what LegManager (3x) and the order process each spelled out on their own.
export function resolveMaxExposure(cfg: { maxExposure?: number; maxInvestment?: number } | null | undefined): number {
    return cfg?.maxExposure ?? cfg?.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
}
