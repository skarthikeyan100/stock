// One config block, one instance per broker. A block of a single-broker strategy type with `brokers: [kite, ant, breeze]` is expanded
// in memory into one config per broker (what the operator used to copy by hand as ContinuousStrategy / -ANT / -Breeze). Each child gets
// its own userId, an internal derived `broker` (never written to config.yml) and `maxInvestment` = that broker's amount, so every reader of
// the per-instance config (LegManager caps, tokenRouter, order-side caps) keeps working unchanged. Pure: no imports of strategies/config.
import Log from './Log';
import { BrokerName, configuredBrokersOf, normalizeBrokerName } from './brokerName';
import { investmentForBroker } from '../prism/configVocabulary';

// Types that already fan out over `brokers:` inside one instance (their state is keyed per broker): never expanded.
export const MULTI_BROKER_TYPES: readonly string[] = [
    'BulkPcrStrategy', 'BulkPcrAutoStartStrategy', 'HourlyStrategy', 'ButterflyStrategy',
    'TopStockOptionsOpeningGapStrategy', 'RecommendationStrategy', 'NiftyChangeStrategy', 'MomentumAtFixedTimeStrategy',
    'NextWeekStrategy', 'BreakoutStrategy',
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
        const amount = investmentForBroker(cfg as any, broker);
        return { ...cfg, userId: instanceUserIdFor(baseId, broker), broker, brokers: [broker], maxInvestment: amount };
    });
}

export const expandAllBrokerInstances = <T extends { type: string; userId?: string; [k: string]: any }>(cfgs: T[]): T[] =>
    cfgs.flatMap(expandBrokerInstances);

type RuleCfg = { type: string; userId?: string; [k: string]: any };

/**
 * A RuleBasedStrategy block is ONE strategy instance. `indicators` is a list of rules: each item is a rule, commas inside an item join the
 * indicators that must agree within that rule. The instance id is the block's userId, or "RuleBased" when none is given.
 *
 * Input:  { type: 'RuleBasedStrategy', indicators: ['Bollinger_25_1.5', 'MACD_4_8_3, MACD_16_32_12'], quantity: 65 }
 * Output: [ { ...same, userId: 'RuleBased' } ]
 */
export function expandRuleBasedConfig(config: RuleCfg): RuleCfg[] {
    if (config.type !== 'RuleBasedStrategy') {
        return [config];  // Return as-is (single-element array)
    }
    if (!config.indicators || (Array.isArray(config.indicators) && config.indicators.length === 0)) {
        console.warn(`[StrategyFactory] RuleBasedStrategy block has no rules - it will not trade`);
    }
    return [{ ...config, userId: config.userId || 'RuleBased' }];
}

// Every runnable instance of the configured blocks: RuleBased rules first, then the per-broker split.
export const expandStrategyInstances = <T extends RuleCfg>(configs: T[]): T[] =>
    expandAllBrokerInstances(configs.flatMap((c) => expandRuleBasedConfig(c) as T[]));
