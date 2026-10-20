/**
 * Verifies POST /config's server-side validation (src/prism/configValidation.ts)
 * rejects a negative lossLimit, a non-positive quantity, and an inverted
 * stopLossPoints/targetPoints pair, while still accepting a valid config
 * update - and that the target/stop-loss cross-field check grandfathers an
 * already-persisted (pre-validation) bad pair left unchanged, but still
 * rejects a request that actively introduces a new bad pair.
 * Run: npm run build (compile), then: node ./dist/test/configValidation.test.js
 */

import { validateNumericRanges, validateTargetVsStopLoss, validateFlatConfig, validateConfigFile } from '../prism/configValidation';
import { toPercentNumber, formatPercentFields, normalizePercentFields, drawdownLimit } from '../prism/percentConfig';

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

    // --- percent fields: "N" and "N%" are both accepted ---
    assert(toPercentNumber(2) === 2 && toPercentNumber('2') === 2 && toPercentNumber('2%') === 2 && toPercentNumber(' 2.5 % ') === 2.5,
        'toPercentNumber accepts 2, "2", "2%" and " 2.5 % "');
    assert(toPercentNumber('abc%') === null && toPercentNumber('2 pct') === null && toPercentNumber(undefined) === null,
        'toPercentNumber returns null for unparseable values');
    const normalized: Record<string, any> = normalizePercentFields({ maxLoss: '6%', targetPoints: '10' } as Record<string, any>);
    assert(normalized.maxLoss === 6 && normalized.targetPoints === '10',
        'normalizePercentFields converts only percent keys');
    const formatted: Record<string, any> = formatPercentFields({ maxLoss: 6, targetPoints: 10 } as Record<string, any>);
    assert(formatted.maxLoss === '6%' && formatted.targetPoints === 10,
        'formatPercentFields writes percent keys with % and leaves others alone');

    const okPercentErrors = validateFlatConfig(
        { settings: { consistencyLimitPercent: '40%', maxDailyDrawdownPercent: 25 }, continuousStrategy: { type: 'ContinuousStrategy', maxProfit: '4%', maxLoss: 6 } },
        {});
    assert(okPercentErrors.length === 0, `valid "N" and "N%" percent values pass (errors: ${JSON.stringify(okPercentErrors)})`);

    const badPercentErrors = validateFlatConfig(
        { settings: { consistencyLimitPercent: 'abc%' }, continuousStrategy: { type: 'ContinuousStrategy', maxLoss: '-3%' } },
        {});
    assert(badPercentErrors.length === 2, `an unparseable and a negative percent are both rejected (errors: ${JSON.stringify(badPercentErrors)})`);

    const zeroStopErrors = validateNumericRanges('continuousStrategy', { maxProfit: 0 });
    assert(zeroStopErrors.length === 1, `maxProfit of 0 is rejected - it would trip on the first tick (errors: ${JSON.stringify(zeroStopErrors)})`);

    const outOfRangeErrors = validateNumericRanges('settings', { consistencyLimitPercent: '150%' });
    assert(outOfRangeErrors.length === 1, `consistencyLimitPercent above 100 is rejected (errors: ${JSON.stringify(outOfRangeErrors)})`);

    // --- validateConfigFile: whole-file checks used by the loader and POST /config ---
    assert(validateConfigFile(null).length > 0 && validateConfigFile('x').length > 0,
        'an empty or non-mapping config file is rejected');
    assert(validateConfigFile({ strategies: [] }).length > 0,
        'a config with no settings block is rejected');
    assert(validateConfigFile({ settings: {}, strategies: { type: 'x' } }).length > 0,
        'strategies that is not a list is rejected');
    assert(validateConfigFile({ settings: {}, strategies: [{ type: 'A', enabled: true, quantity: 0 }] }).length > 0,
        'an enabled strategy with an invalid value is rejected');
    assert(validateConfigFile({ settings: {}, strategies: [{ type: 'A', enabled: false, quantity: 0, maxLoss: 0 }] }).length === 0,
        'a stale invalid value in a DISABLED strategy block does not reject the file');
    assert(validateConfigFile({ settings: {}, strategies: [{ type: 'A', enabled: true, maxInvestment: '1,00,000' }] }).length > 0,
        'a non-numeric maxInvestment is rejected (would otherwise NaN-disable the stops)');
    assert(validateConfigFile({ settings: { maxDailyDrawdownPercent: '0%' }, strategies: [] }).length > 0,
        'a zero drawdown limit is rejected (would block every zero-P&L day)');

    // --- drawdownLimit: shared default, percent parsing, safe with absent settings ---
    assert(drawdownLimit(undefined, 'maxDailyDrawdownPercent') === 25 && drawdownLimit({}, 'maxWeeklyDrawdownPercent') === 50,
        'drawdownLimit falls back to the shared defaults (25 / 50) when absent');
    assert(drawdownLimit({ maxDailyDrawdownPercent: '10%' }, 'maxDailyDrawdownPercent') === 10,
        'drawdownLimit reads "N%" values');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
