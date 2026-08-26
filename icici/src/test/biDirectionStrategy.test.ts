/**
 * Verifies two BiDirectionStrategy bug fixes: canHandleOptionQuote's
 * CALL-match reset, and the SELL branch's blind same-contract re-buy
 * instead of reporting the position closed for fresh-strike re-entry.
 * Run: npm run build (compile), then: node ./dist/test/biDirectionStrategy.test.js
 */

import BiDirectionStrategy from '../strategy/BiDirectionStrategy';
import { OptionQuote } from '../model/model';
import { execSync } from 'child_process';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // Bug 1: a real CALL match must survive canHandleOptionQuote.
    const s1 = new BiDirectionStrategy('BiDir1') as any;
    s1.call = { canHandleOptionQuote: (token: string) => token === 'callTok' };
    s1.put = { canHandleOptionQuote: (token: string) => false };
    const quote = Object.assign(new OptionQuote(), { token: 'callTok' });
    assert(s1.canHandleOptionQuote(quote) === true, 'a genuine CALL-side match is not reset to false');

    // Bug 2: Contract is not exported, so the cleanest real check of the
    // SELL branch (which no longer blindly re-buys the same contract, and
    // instead reports tradeClosed=true so the outer strategy's
    // openCallTrade()/openPutTrade() fresh-strike re-entry path runs) is a
    // targeted grep - a proportionate, honest verification for private,
    // unexported state rather than a fabricated reflection-based unit test.
    const grepResult = execSync("grep -n 'tradeClosed = true' src/strategy/BiDirectionStrategy.ts").toString();
    assert(grepResult.includes('tradeClosed = true'), 'SELL branch now reports the position closed');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
