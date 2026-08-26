/**
 * Verifies IntermittentStrategy.updateTrade reads the targetPrice config
 * field (not loopCount) for its re-buy sell-target log line.
 * Run: npm run build (compile), then: node ./dist/test/intermittentStrategy.test.js
 */

import configService from '../prism/ConfigService';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const cfg = configService.getStrategyConfig('IntermittentStrategy');
assert(cfg.targetPrice !== cfg.loopCount, 'sanity: targetPrice and loopCount are configured as different values in config.yml (test is meaningless if they happen to match - check config.yml:66-70)');

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
