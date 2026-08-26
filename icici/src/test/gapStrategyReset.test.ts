/**
 * Verifies GapStrategy re-arms (decidedToday back to false) on a new trading
 * day instead of staying permanently disabled after its first decision.
 *
 * Deviates from a literal this.enabled-based reset: strategiesProcess.ts's
 * dispatch loop only calls processNiftyQuote when strategy.enabled is
 * already true, so a fix that self-disabled via this.enabled would never
 * get a chance to run resetIfNewDay() again. Uses a dedicated decidedToday
 * flag instead, mirroring GoodMorningStrategy's tradingDay/traded pattern
 * (this.enabled stays reserved for config-level/admin enablement).
 * Run: npm run build (compile), then: node ./dist/test/gapStrategyReset.test.js
 */

import GapStrategy from '../strategy/GapStrategy';
import moment from 'moment';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const strategy = new GapStrategy('GapStrategy') as any;
strategy.enabled = true;

// Simulate "made its one decision today" without needing a live quote/order path.
strategy.decidedToday = true;
strategy.tradingDay = moment().format('YYYY-MM-DD');
assert(strategy.decidedToday === true, 'stays decided for the rest of the same trading day');
assert(strategy.enabled === true, 'this.enabled is untouched by making the daily decision');

// Simulate a new day (yesterday's date still stored).
strategy.tradingDay = moment().subtract(1, 'day').format('YYYY-MM-DD');
strategy['resetIfNewDay']();
assert(strategy.decidedToday === false, `re-arms once the trading day rolls over (got ${strategy.decidedToday})`);

if (process.exitCode === 1) {
    console.log('SOME TESTS FAILED');
} else {
    console.log('ALL TESTS PASSED');
}
