// One config block, one instance per broker. A block of a single-broker strategy type with `brokers: [kite, ant, breeze]` is expanded
// in memory into one config per broker (what the operator used to copy by hand as ContinuousStrategy / -ANT / -Breeze). Each child gets
// its own userId, an internal derived `broker` (never written to config.yml) and `maxExposure` = that broker's amount, so every reader of
// the per-instance config (LegManager caps, tokenRouter, order-side caps) keeps working unchanged. Pure: no imports of strategies/config.
import Log from './Log';
import { BrokerName, configuredBrokersOf, normalizeBrokerName } from './brokerName';
import { exposureForBroker } from '../prism/configVocabulary';

// Types that already fan out over `brokers:` inside one instance (their state is keyed per broker): never expanded.
export const MULTI_BROKER_TYPES: readonly string[] = [
    'BulkPcrStrategy', 'BulkPcrAutoStartStrategy', 'HourlyStrategy', 'ButterflyStrategy',
    'TopStockOptionsOpeningGapStrategy', 'RecommendationStrategy', 'NiftyChangeStrategy', 'MomentumAtFixedTimeStrategy',
];

// Kite keeps the base id (state, latches and trade history carry over); the others get a suffix, as the hand-made copies did.
const SUFFIX: Record<string, string> = { kite: '', ant: '-ANT', breeze: '-Breeze', prism: '-Prism' };

export function instanceUserIdFor(baseId: string, broker: string): string {
    return baseId + (SUFFIX[normalizeBrokerName(broker)] ?? `-${broker}`);
}

export function expandBrokerInstances<T extends { type: string; userId?: string; [k: string]: any }>(cfg: T): T[] {
    if (MULTI_BROKER_TYPES.includes(cfg.type)) return [cfg];
    const brokers = configuredBrokersOf(cfg);
    const baseId = cfg.userId || cfg.type;
    return brokers.map((broker: BrokerName) => {
        const amount = exposureForBroker(cfg as any, broker);
        return { ...cfg, userId: instanceUserIdFor(baseId, broker), broker, brokers: [broker], maxExposure: amount, maxInvestment: amount };
    });
}

export const expandAllBrokerInstances = <T extends { type: string; userId?: string; [k: string]: any }>(cfgs: T[]): T[] =>
    cfgs.flatMap(expandBrokerInstances);

type RuleCfg = { type: string; userId?: string; [k: string]: any };

/**
 * Expand RuleBasedStrategy config with multiple indicator rules into separate configs
 *
 * Input:
 * {
 *   type: 'RuleBasedStrategy',
 *   enabled: true,
 *   indicators: ['RSI_5_80_20, EMA_5_13', 'MACD_12_26_9'],
 *   quantity: 65
 * }
 *
 * Output:
 * [
 *   { type: 'RuleBasedStrategy', userId: 'Rule-RSI_5_80_20, EMA_5_13', enabled: true,
 *     indicators: ['RSI_5_80_20', 'EMA_5_13'], quantity: 65 },
 *   { type: 'RuleBasedStrategy', userId: 'Rule-MACD_12_26_9', enabled: true,
 *     indicators: ['MACD_12_26_9'], quantity: 65 }
 * ]
 */
export function expandRuleBasedConfig(config: RuleCfg): RuleCfg[] {
    // Only expand RuleBasedStrategy with indicators array
    if (config.type !== 'RuleBasedStrategy' || !config.indicators || !Array.isArray(config.indicators)) {
        return [config];  // Return as-is (single-element array)
    }

    const expanded: RuleCfg[] = [];

    for (let i = 0; i < config.indicators.length; i++) {
        const indicatorRule = config.indicators[i];

        // Split by comma and trim whitespace
        const indicatorArray = indicatorRule
            .split(',')
            .map((ind: string) => ind.trim())
            .filter((ind: string) => ind.length > 0);

        if (indicatorArray.length === 0) {
            console.warn(`[StrategyFactory] Skipping empty indicator rule at index ${i}`);
            continue;
        }

        // Create userId from indicator names
        const userId = `Rule-${indicatorRule}`;  // e.g., "Rule-RSI_5_80_20, EMA_5_13"

        // Create expanded config for this rule
        const expandedConfig: RuleCfg = {
            ...config,  // Clone all properties (enabled, quantity, targetProfitPercent, etc.)
            userId,
            indicators: indicatorArray  // Replace with parsed array
        };

        expanded.push(expandedConfig);
    }

    Log.log(`[StrategyFactory] Expanded RuleBasedStrategy into ${expanded.length} instances`);
    return expanded;
}

// Every runnable instance of the configured blocks: RuleBased rules first, then the per-broker split.
export const expandStrategyInstances = <T extends RuleCfg>(configs: T[]): T[] =>
    expandAllBrokerInstances(configs.flatMap((c) => expandRuleBasedConfig(c) as T[]));
