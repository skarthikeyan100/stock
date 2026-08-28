/**
 * Verifies POST /config's server-side validation (src/prism/configValidation.ts)
 * rejects a negative lossLimit, a non-positive quantity, and an inverted
 * stopLossPoints/targetPoints pair, while still accepting a valid config
 * update - and that the target/stop-loss cross-field check grandfathers an
 * already-persisted (pre-validation) bad pair left unchanged, but still
 * rejects a request that actively introduces a new bad pair.
 * Run: npm run build (compile), then: node ./dist/test/configValidation.test.js
 */

import { validateNumericRanges, validateTargetVsStopLoss, validateFlatConfig } from '../prism/configValidation';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // --- negative lossLimit is rejected ---
    const negLossLimitErrors = validateNumericRanges('testStrategy', { lossLimit: -100 });
    assert(negLossLimitErrors.length > 0, `negative lossLimit is rejected (errors: ${JSON.stringify(negLossLimitErrors)})`);

    // --- negative quantity is rejected ---
    const negQuantityErrors = validateNumericRanges('testStrategy', { quantity: -5 });
    assert(negQuantityErrors.length > 0, `negative quantity is rejected (errors: ${JSON.stringify(negQuantityErrors)})`);

    // --- zero quantity is also rejected (must be > 0, not just >= 0) ---
    const zeroQuantityErrors = validateNumericRanges('testStrategy', { quantity: 0 });
    assert(zeroQuantityErrors.length > 0, `zero quantity is rejected (errors: ${JSON.stringify(zeroQuantityErrors)})`);

    // --- stopLossPoints >= targetPoints is rejected ---
    const invertedErrors = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 10 });
    assert(invertedErrors.length > 0, `stopLossPoints >= targetPoints (10 >= 10) is rejected (errors: ${JSON.stringify(invertedErrors)})`);

    const invertedErrors2 = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 15 });
    assert(invertedErrors2.length > 0, `stopLossPoints > targetPoints (15 > 10) is rejected (errors: ${JSON.stringify(invertedErrors2)})`);

    // --- a valid config update passes ---
    const validRangeErrors = validateNumericRanges('testStrategy', { lossLimit: 15000, quantity: 65, minPrice: 20, maxPrice: 150 });
    assert(validRangeErrors.length === 0, `a valid range-only config passes (errors: ${JSON.stringify(validRangeErrors)})`);

    const validPairErrors = validateTargetVsStopLoss('testStrategy', { targetPoints: 10, stopLossPoints: 5 });
    assert(validPairErrors.length === 0, `a valid targetPoints > stopLossPoints pair passes (errors: ${JSON.stringify(validPairErrors)})`);

    // --- validateFlatConfig: grandfathers an unchanged legacy bad pair ---
    // Mirrors this repo's actual config.yml today: GoodMorningStrategy has
    // targetPoints:10, stopLossPoints:10 (equal, technically invalid) already
    // persisted before this validation existed. Re-posting it UNCHANGED
    // (e.g. the Admin UI's full-object autosave after an unrelated edit
    // elsewhere) must not be blocked.
    const currentFlat = {
        settings: { minPrice: 20, maxPrice: 30000 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: false, quantity: 65, targetPoints: 10, stopLossPoints: 10 },
    };
    const repostUnchanged = validateFlatConfig(currentFlat, currentFlat);
    assert(repostUnchanged.length === 0, `re-posting an unchanged legacy bad target/stopLoss pair is grandfathered, not rejected (errors: ${JSON.stringify(repostUnchanged)})`);

    // --- validateFlatConfig: still rejects a NEW bad pair introduced by this request ---
    const newBadPairFlat = {
        settings: { minPrice: 20, maxPrice: 30000 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: false, quantity: 65, targetPoints: 5, stopLossPoints: 10 },
    };
    const rejectedNewChange = validateFlatConfig(newBadPairFlat, currentFlat);
    assert(rejectedNewChange.length > 0, `a request that CHANGES targetPoints/stopLossPoints into a bad pair is rejected (errors: ${JSON.stringify(rejectedNewChange)})`);

    // --- validateFlatConfig: a fully valid full-payload update passes cleanly ---
    const validFullFlat = {
        settings: { minPrice: 20, maxPrice: 30000, consistencyLimitPercent: 40 },
        goodMorningStrategy: { type: 'GoodMorningStrategy', enabled: true, quantity: 65, targetPoints: 10, stopLossPoints: 5 },
    };
    const validFullErrors = validateFlatConfig(validFullFlat, currentFlat);
    assert(validFullErrors.length === 0, `a fully valid full config payload passes with no errors (errors: ${JSON.stringify(validFullErrors)})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
