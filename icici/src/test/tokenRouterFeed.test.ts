/**
 * LegManager strategies (Continuous / SupportResistance) hold ANT tokens whatever broker places the orders, so their ticks must come
 * from the ANT feed - including for `broker: breeze` (review R5-4). Strategies without that property keep routing by broker.
 * Run: node ./dist/test/tokenRouterFeed.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import SupportResistanceStrategy from '../strategy/SupportResistanceStrategy';
import BulkPcrStrategy from '../strategy/BulkPcrStrategy';
import strategies from '../strategy/strategies';
import { resolveSource } from '../processes/strategies/tokenRouter';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const expanded = (strategies as any).expandedConfigs as Map<string, any>;
    expanded.set('c-breeze', { type: 'ContinuousStrategy', userId: 'c-breeze', broker: 'breeze' });
    expanded.set('c-kite', { type: 'ContinuousStrategy', userId: 'c-kite', broker: 'kite' });
    expanded.set('sr-breeze', { type: 'SupportResistanceStrategy', userId: 'sr-breeze', broker: 'breeze' });
    expanded.set('other-breeze', { type: 'BulkPcrStrategy', userId: 'other-breeze', broker: 'breeze' });

    assert(resolveSource(new ContinuousStrategy('c-breeze')) === 'ant', 'Continuous with broker: breeze subscribes on the ANT feed');
    assert(resolveSource(new ContinuousStrategy('c-kite')) === 'ant', 'Continuous with broker: kite stays on the ANT feed');
    assert(resolveSource(new SupportResistanceStrategy('sr-breeze')) === 'ant', 'SupportResistance with broker: breeze subscribes on the ANT feed');
    assert(resolveSource(new BulkPcrStrategy('other-breeze')) === 'breeze', 'a strategy without ANT-token legs still routes by broker');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
