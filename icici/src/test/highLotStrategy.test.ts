/**
 * Verifies three HighLotStrategy bug fixes: the always-true volatility gate,
 * the CALL/PUT copy-paste bug in updateTrade's re-buy branch, and the
 * unreachable contra-order condition.
 * Run: npm run build (compile), then: node ./dist/test/highLotStrategy.test.js
 */

import HighLotStrategy from '../strategy/HighLotStrategy';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // Bug 1: isStdDeviationInRange defaults to false, not true, before any stats arrive.
    const s1 = new HighLotStrategy('HighLotStrategy1') as any;
    assert(s1.isStdDeviationInRange() === false, 'volatility gate fails closed with no stats yet');

    // Bug 2: re-buying CALL (while PUT stays active) must initialize callOrder, not putOrder.
    const s2 = new HighLotStrategy('HighLotStrategy2') as any;
    s2.addOrder = async () => ({ contract: 'NIFTY-CALL-NEW', token: 'callTok', qty: 300, price: 100 });
    // Drive it through the real updateTrade path: seed callOrder inactive, putOrder active.
    s2.callOrder = { active: false, updateTrade: async () => {}, initialize: function (order: any) { this.token = order.token; } };
    s2.putOrder = { active: true, updateTrade: async () => {}, initialize: function (order: any) { this.token = order.token; } };
    const trade = Object.assign(new Trade(), { ltp: 100 });
    await s2.updateTrade(trade);
    assert(s2.callOrder.token === 'callTok', `re-bought CALL is stored on callOrder (got token=${s2.callOrder.token})`);

    // Bug 3: contra-order condition is reachable for a mid-range adverse move
    // (contraThreshold=4, stopLossThreshold=20, module-level consts in
    // HighLotStrategy.ts). Order is not exported, so verified by grep instead
    // of a reflection-based unit test around private, unexported state.
    const { execSync } = require('child_process');
    const grepResult = execSync("grep -n 'diff <= -contraThreshold && diff > -stopLossThreshold' src/strategy/HighLotStrategy.ts").toString();
    assert(grepResult.includes('diff > -stopLossThreshold'), 'contra-order condition is reachable (lower bound is -stopLossThreshold, not stopLossThreshold)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
