/**
 * isExpiryDayFor: "is today a NIFTY expiry day" comes from the contract master's nearest expiry, not from a fixed weekday, because the
 * exchange moves an expiry to the previous trading day when its usual weekday is a holiday (NIFTY 2026-11-10 is listed as 2026-11-09).
 * Run: node ./dist/test/expiryDay.test.js
 */
import { isExpiryDayFor } from '../util/marketHours';

const DAY = 86400000;
const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);
let failed = 0;
function check(name: string, actual: boolean, expected: boolean) {
    if (actual === expected) { console.log(`PASS ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}: expected ${expected}, got ${actual}`);
}

// Monday 2026-11-09 is the listed expiry (Tuesday 11-10 is a holiday): squareoff must run on the Monday.
check('holiday-shifted expiry Monday is an expiry day', isExpiryDayFor(d(2026, 11, 9), d(2026, 11, 9), 1), true);
// The shifted-away Tuesday is not (the next listed expiry is a week out).
check('shifted-away Tuesday is not an expiry day', isExpiryDayFor(d(2026, 11, 10), d(2026, 11, 17), 2), false);
// An ordinary Tuesday expiry.
check('ordinary Tuesday expiry', isExpiryDayFor(d(2026, 11, 17), d(2026, 11, 17), 2), true);
// A mid-week day before the expiry.
check('Wednesday before the expiry is not an expiry day', isExpiryDayFor(d(2026, 11, 4), d(2026, 11, 9), 3), false);
// No master data: weekday rule.
check('no master data, Tuesday', isExpiryDayFor(d(2026, 11, 10), undefined, 2), true);
check('no master data, Monday', isExpiryDayFor(d(2026, 11, 9), undefined, 1), false);
// Stale master (nearest expiry more than 7 days out): weekday rule, never "not an expiry day" by default.
check('stale master, Tuesday', isExpiryDayFor(d(2026, 11, 10), d(2026, 12, 29), 2), true);
check('stale master, Thursday', isExpiryDayFor(d(2026, 11, 12), d(2026, 12, 29), 4), false);
// Exactly 7 days out is still a usable master.
check('7 days out is trusted', isExpiryDayFor(d(2026, 11, 10), d(2026, 11, 10) + 7 * DAY, 2), false);

if (failed > 0) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('all passed');
