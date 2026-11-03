/**
 * expandBrokerInstances / exposureForBroker: a single-broker strategy block with `brokers: [...]` becomes one instance per broker, each
 * with its own id and its own per-broker amount; multi-broker types are left alone; the removed `broker:` key is ignored.
 * Run: node ./dist/test/strategyInstances.test.js
 */
import { expandBrokerInstances as expandTyped, expandStrategyInstances as expandAllTyped } from '../util/strategyInstances';
import { exposureForBroker } from '../prism/configVocabulary';
import { configuredBrokersOf } from '../util/brokerName';

const expandBrokerInstances = expandTyped as (c: any) => any[];
const expandStrategyInstances = expandAllTyped as (c: any[]) => any[];

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const three = expandBrokerInstances({ type: 'ContinuousStrategy', enabled: true, brokers: ['kite', 'ant', 'breeze'], maxExposure: 100000, maxExposureByBroker: { zerodha: 50000, ant: 70000 } });
assert(three.map((c) => c.userId).join() === 'ContinuousStrategy,ContinuousStrategy-ANT,ContinuousStrategy-Breeze', 'ids: kite keeps the base id, others are suffixed');
assert(three.map((c) => c.broker).join() === 'kite,ant,breeze', 'each child carries its derived broker');
assert(three.map((c) => c.maxExposure).join() === '50000,70000,100000', 'per-broker amount: alias zerodha -> kite, ant override, breeze falls back to maxExposure');
assert(three.every((c) => c.brokers.length === 1), 'a child lists only its own broker (no second expansion)');

const single = expandBrokerInstances({ type: 'ContinuousStrategy', enabled: true, maxInvestment: 80000 });
assert(single.length === 1 && single[0].userId === 'ContinuousStrategy' && single[0].broker === 'kite' && single[0].maxExposure === 80000, 'no brokers: -> [kite], base id, maxInvestment used');

const custom = expandBrokerInstances({ type: 'SupportResistanceStrategy', userId: 'SR-1', enabled: true, brokers: ['ant'] });
assert(custom.length === 1 && custom[0].userId === 'SR-1-ANT', 'explicit userId is the base of the suffix');

const legacyKey = expandBrokerInstances({ type: 'ContinuousStrategy', enabled: true, broker: 'ant' });
assert(legacyKey.length === 1 && legacyKey[0].broker === 'kite', 'the removed broker: key is ignored');

const multi = { type: 'NiftyChangeStrategy', enabled: true, brokers: ['kite', 'ant'] };
assert(expandBrokerInstances(multi).length === 1 && expandBrokerInstances(multi)[0] === multi, 'multi-broker types are not expanded');

const rule = expandStrategyInstances([{ type: 'RuleBasedStrategy', enabled: true, indicators: ['RSI_5_80_20'], brokers: ['kite', 'ant'] }]);
assert(rule.map((c) => c.userId).join() === 'Rule-RSI_5_80_20,Rule-RSI_5_80_20-ANT', 'RuleBased x brokers composes: Rule-<ind>, Rule-<ind>-ANT');

assert(exposureForBroker({ maxExposure: 5 }, 'breeze') === 5, 'exposureForBroker falls back to maxExposure');
assert(exposureForBroker({ maxExposureByBroker: { icici: 9 }, maxExposure: 5 }, 'breeze') === 9, 'exposureForBroker normalises aliases (icici -> breeze)');
assert(configuredBrokersOf({ broker: 'ant' }).join() === 'kite', 'configuredBrokersOf no longer reads broker:');

const simple = expandBrokerInstances({ type: 'SimpleContinuousStrategy', enabled: true, brokers: ['kite', 'ant'], maxInvestment: 100000 });
assert(simple.map((c) => c.userId).join() === 'SimpleContinuousStrategy,SimpleContinuousStrategy-ANT', 'SimpleContinuousStrategy is a single-broker type: one instance per broker');
