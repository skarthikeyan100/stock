/**
 * Verifies SupportResistanceStrategy does not treat an unconfigured (0)
 * support/resistance level as a real, always-crossed level.
 * Run: npm run build (compile), then: node ./dist/test/supportResistanceStrategy.test.js
 */

import SupportResistanceStrategy from '../strategy/SupportResistanceStrategy';
import { NiftyQuote } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const strategy = new SupportResistanceStrategy('SupportResistanceStrategy') as any;
    strategy.enabled = true;

    let executeTradeCalls = 0;
    strategy.executeTrade = async () => { executeTradeCalls++; };

    // resistancePrice=0 (shipped default) must not fire on every positive LTP.
    await strategy.processNiftyQuote(Object.assign(new NiftyQuote(), { ltp: 24000 }));
    assert(executeTradeCalls === 0, `does not fire on an unconfigured (0) resistance level (calls=${executeTradeCalls})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
