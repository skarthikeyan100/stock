import Log from '../util/Log';
import { Strategy } from './strategy';
import BuySellStrategy from './BuySellStrategy';
import SentimentStrategy from './SentimentStrategy';
import IntermittentStrategy from './IntermittentStrategy';
import BiDirectionStrategy from './BiDirectionStrategy';
import DiffStrategy from './DiffStrategy';
import PivotStrategy from './PivotStrategy';
import HighLotStrategy from './HighLotStrategy';
import Minutes5Decision from './Minutes5Decision';
import TestStrategy from './TestStrategy';
import RateOfChangeStrategy from './RateOfChangeStrategy';
import GapStrategy from './GapStrategy';
import RuleBasedStrategy from './RuleBasedStrategy';
import GoodMorningStrategy from './GoodMorningStrategy';
import GoodMorningSensexStrategy from './GoodMorningSensexStrategy';
import SupportResistanceStrategy from './SupportResistanceStrategy';
import TargetReachStrategy from './TargetReachStrategy';
import ContinuousStrategy from './ContinuousStrategy';
import { StrategyInstanceConfig } from '../prism/AppConfig';

const STRATEGY_REGISTRY = new Map<string, new (userId?: string) => Strategy>();
STRATEGY_REGISTRY.set('BuySellStrategy', BuySellStrategy);
STRATEGY_REGISTRY.set('SentimentStrategy', SentimentStrategy);
STRATEGY_REGISTRY.set('IntermittentStrategy', IntermittentStrategy);
STRATEGY_REGISTRY.set('BiDirectionStrategy', BiDirectionStrategy);
STRATEGY_REGISTRY.set('DiffStrategy', DiffStrategy);
STRATEGY_REGISTRY.set('PivotStrategy', PivotStrategy);
STRATEGY_REGISTRY.set('HighLotStrategy', HighLotStrategy);
STRATEGY_REGISTRY.set('Minutes5Decision', Minutes5Decision);
STRATEGY_REGISTRY.set('TestStrategy', TestStrategy);
STRATEGY_REGISTRY.set('RateOfChangeStrategy', RateOfChangeStrategy);
STRATEGY_REGISTRY.set('GapStrategy', GapStrategy);
STRATEGY_REGISTRY.set('RuleBasedStrategy', RuleBasedStrategy);
STRATEGY_REGISTRY.set('GoodMorningStrategy', GoodMorningStrategy);
STRATEGY_REGISTRY.set('GoodMorningSensexStrategy', GoodMorningSensexStrategy);
STRATEGY_REGISTRY.set('SupportResistanceStrategy', SupportResistanceStrategy);
STRATEGY_REGISTRY.set('TargetReachStrategy', TargetReachStrategy);
STRATEGY_REGISTRY.set('ContinuousStrategy', ContinuousStrategy);

export function createStrategy(config: StrategyInstanceConfig): Strategy | null {
    const StrategyClass = STRATEGY_REGISTRY.get(config.type);
    if (!StrategyClass) {
        Log.log(`[StrategyFactory] Unknown strategy type: ${config.type}`);
        return null;
    }
    const userId = config.userId || config.type;
    const strategy = new StrategyClass(userId);
    strategy.enabled = config.enabled;
    return strategy;
}

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
export function expandRuleBasedConfig(config: StrategyInstanceConfig): StrategyInstanceConfig[] {
    // Only expand RuleBasedStrategy with indicators array
    if (config.type !== 'RuleBasedStrategy' || !config.indicators || !Array.isArray(config.indicators)) {
        return [config];  // Return as-is (single-element array)
    }

    const expanded: StrategyInstanceConfig[] = [];

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
        const expandedConfig: StrategyInstanceConfig = {
            ...config,  // Clone all properties (enabled, quantity, targetProfitPercent, etc.)
            userId,
            indicators: indicatorArray  // Replace with parsed array
        };

        expanded.push(expandedConfig);
    }

    Log.log(`[StrategyFactory] Expanded RuleBasedStrategy into ${expanded.length} instances`);
    return expanded;
}

export function createStrategiesFromConfig(configs: StrategyInstanceConfig[]): Strategy[] {
    return configs
        .flatMap(expandRuleBasedConfig)   // Expand RuleBasedStrategy → multiple configs
        .map(createStrategy)               // Instantiate each config → Strategy
        .filter((s): s is Strategy => s !== null);
}
