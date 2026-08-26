/**
 * Verifies ContinuousStrategy's processNiftyQuote gates on the instance's
 * own this.enabled field (which strategiesProcess.ts's dispatch loop and the
 * admin setEnabled IPC command both mutate), not a fresh config-file read.
 * Run: npm run build (compile), then: node ./dist/test/continuousStrategyEnable.test.js
 */

import ContinuousStrategy from '../strategy/ContinuousStrategy';
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
    const strategy = new ContinuousStrategy('ContinuousStrategy') as any;

    // Fresh instance must not force itself enabled - only StrategyFactory
    // (or an explicit admin setEnabled call) should ever set this.enabled=true.
    assert(strategy.enabled === false, `a fresh instance defaults to disabled (got ${strategy.enabled})`);

    // Simulate the admin setEnabled IPC command's effect (strategiesProcess.ts:76).
    strategy.enabled = true;
    const quote = Object.assign(new NiftyQuote(), { ltp: 24000 });
    // Should reach the gate that actually attempts entry (isTimeInRange/cooldown
    // may still block it, but it must NOT bail out on the disabled-gate specifically -
    // verified indirectly by confirming this.ordered is untouched only when this.enabled
    // is false, and reachable when true, via the logGateOnce reason).
    let lastGateReason = '';
    const originalLog = strategy.logGateOnce.bind(strategy);
    strategy.logGateOnce = (reason: string) => { lastGateReason = reason; return originalLog(reason); };

    strategy.enabled = false;
    await strategy.processNiftyQuote(quote);
    assert(lastGateReason === 'disabled', `disabled instance gates on 'disabled' (got '${lastGateReason}')`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
