/**
 * Strategy.receivesEvents(): the dispatcher's gate is `enabled` (as config.yml says) AND the trading window, read from the clock.
 * Nothing clears `enabled` in memory any more (review R4-4/R4-5), so it must stay true outside the window and the gate must
 * reopen by itself when the window does.
 * Run: node ./dist/test/strategiesEnabledGate.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import strategies from '../strategy/strategies';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// marketHours reads `new Date()`: pin the local clock to a given HH:mm.
const RealDate = Date;
function atTime(h: number, m: number, fn: () => void) {
    const fixed = new RealDate(2026, 9, 29, h, m, 0);
    (global as any).Date = class extends RealDate {
        constructor(...args: any[]) { super(...((args.length ? args : [fixed.getTime()]) as [number])); }
        static now() { return fixed.getTime(); }
    };
    try { fn(); } finally { (global as any).Date = RealDate; }
}

const s = new ContinuousStrategy('ContinuousStrategy') as any;
s.enabled = true;
s.stateLoaded = true; // the gate under test here is enabled + window; readiness has its own test
atTime(10, 0, () => assert(s.receivesEvents() === true, 'enabled inside the window is active'));
atTime(9, 5, () => assert(s.receivesEvents() === false, 'enabled before 09:10 is not active'));
atTime(15, 30, () => assert(s.receivesEvents() === false, 'enabled after the close is not active'));
assert(s.enabled === true, 'the gate never clears `enabled` (it still mirrors config.yml)');
atTime(10, 0, () => assert(s.receivesEvents() === true, 'the gate reopens by itself when the window does'));
s.enabled = false;
atTime(10, 0, () => assert(s.receivesEvents() === false, 'disabled inside the window is not active'));

assert(typeof (strategies as any).setEnabledOverride === 'undefined', 'the in-memory setEnabledOverride is gone');
assert(typeof (strategies as any).recheckTradingWindow === 'undefined', 'the in-memory window force-disable is gone');

console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
process.exit(process.exitCode ?? 0);
