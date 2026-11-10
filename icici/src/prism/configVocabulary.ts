// config.yml vocabulary migration (REFACTOR_PLAN.md section 3): canonical name <- legacy name.
//   settings:    targetPoints <- targetPriceDiff, stopLossPoints <- stopLossPriceDiff   (point offsets)
import { DEFAULT_MAX_INVESTMENT } from '../constants';
import { normalizeBrokerName } from '../util/brokerName';

const SETTINGS_PAIRS: [canonical: string, legacy: string][] = [['targetPoints', 'targetPriceDiff'], ['stopLossPoints', 'stopLossPriceDiff']];

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

// The spend cap of a strategy block (maxInvestment), falling back to the project default.
export function resolveMaxInvestment(cfg: { maxInvestment?: number } | null | undefined): number {
    return cfg?.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
}

// The amount ONE broker trades with: `maxInvestmentByBroker[broker]` (broker aliases such as zerodha accepted) else the block's
// maxInvestment, which means "per broker" for every strategy.
export function investmentForBroker(cfg: { maxInvestment?: number; maxInvestmentByBroker?: Record<string, number> } | null | undefined, broker: string): number {
    const wanted = normalizeBrokerName(broker);
    for (const [name, cap] of Object.entries(cfg?.maxInvestmentByBroker ?? {})) {
        if (normalizeBrokerName(name) === wanted && Number.isFinite(Number(cap)) && Number(cap) > 0) return Number(cap);
    }
    return resolveMaxInvestment(cfg);
}

// A global setting that a strategy may override: the strategy block's own value when it sets the key, else settings[key] from config.yml,
// else undefined. `settings` is passed in (not imported) so this stays free of the ConfigService import cycle.
export function settingFor<T = any>(block: Record<string, any> | null | undefined, settings: Record<string, any> | null | undefined, key: string): T | undefined {
    const own = block?.[key];
    return (own !== undefined && own !== null ? own : settings?.[key]) as T | undefined;
}
