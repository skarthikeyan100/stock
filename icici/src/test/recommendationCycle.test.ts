/**
 * The pure repeat / reverse rules of RecommendationStrategy (recommendationCycle.ts): no broker, no Mongo.
 * Run: npx tsc, then: node ./dist/test/recommendationCycle.test.js
 */
import { hitTarget, nextAction, backAtEntry, oppositeRight, atmStrike } from '../strategy/recommendationCycle';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

console.log('recommendationCycle');
assert(hitTarget({ filledQty: 65, soldQty: 65, soldValue: 65 * 150, exitTarget: 150 }), 'sold at the target: hit');
assert(hitTarget({ filledQty: 65, soldQty: 65, soldValue: 65 * 152, exitTarget: 150 }), 'sold above the target: hit');
assert(!hitTarget({ filledQty: 65, soldQty: 65, soldValue: 65 * 95, exitTarget: 150 }), 'sold at the stop: not a hit');
assert(!hitTarget({ filledQty: 65, soldQty: 0, soldValue: 0, exitTarget: 150 }), 'not sold yet: not a hit');
assert(!hitTarget({ filledQty: 0, soldQty: 0, soldValue: 0, exitTarget: 150 }), 'nothing filled: not a hit');
assert(!hitTarget({ filledQty: 65, soldQty: 65, soldValue: 65 * 160 }), 'no exit target recorded (adopted leg): not a hit');

assert(nextAction(0, false, false, true) === 'finish', 'both off: finish');
assert(nextAction(0, true, false, true) === 'repeat', 'repeat after the first target');
assert(nextAction(0, true, true, true) === 'repeat', 'both on: repeat first');
assert(nextAction(1, true, false, true) === 'finish', 'repeat only: the repeat ends it');
assert(nextAction(1, true, true, true) === 'watch', 'both on: reverse watch after the repeat target');
assert(nextAction(0, false, true, true) === 'watch', 'reverse only: watch after the first target');
assert(nextAction(2, true, true, true) === 'finish', 'the reverse ends it');
assert(nextAction(0, true, true, false) === 'finish', 'no target (stop / EOD / unfilled): finish');

assert(backAtEntry(120, 120) && backAtEntry(118, 120) && !backAtEntry(121, 120) && !backAtEntry(0, 120), 'back at entry: ltp <= entry, ltp > 0');
assert(oppositeRight('CE') === 'PE' && oppositeRight('PE') === 'CE', 'opposite right');
assert(atmStrike(22724) === 22700 && atmStrike(22726) === 22750, 'ATM rounds to 50');
