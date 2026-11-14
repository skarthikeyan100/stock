/**
 * Successful weeks (src/successfulWeeks.ts): a completed Wed-Tue payment week with net realized P&L > 0 and no drawdown forfeit.
 * Run: npx tsc && node ./dist/test/successfulWeeks.test.js
 */
import { countSuccessfulWeeks, REQUIRED_SUCCESSFUL_WEEKS } from '../successfulWeeks';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }
const t = (iso: string, pnl: number, id = iso) => ({ exitTime: new Date(iso), realizedPnL: pnl, _id: id });
// Payment weeks run Wednesday to Tuesday: 2026-11-04..10 and 2026-11-11..17 are complete at 2026-11-20; 2026-11-18..24 is not.
const now = new Date('2026-11-20T12:00:00+05:30');
const cap = 100000, daily = 15, weekly = 30;

assert(REQUIRED_SUCCESSFUL_WEEKS === 2, 'two successful weeks are required');
assert(countSuccessfulWeeks([], cap, daily, weekly, now) === 0, 'no trades -> 0');
assert(countSuccessfulWeeks([t('2026-11-05T11:00:00+05:30', 1000), t('2026-11-12T11:00:00+05:30', 500)], cap, daily, weekly, now) === 2, 'two profitable completed weeks -> 2');
assert(countSuccessfulWeeks([t('2026-11-05T11:00:00+05:30', 1000), t('2026-11-12T11:00:00+05:30', -200)], cap, daily, weekly, now) === 1, 'one profitable + one losing week -> 1');
assert(countSuccessfulWeeks([t('2026-11-05T11:00:00+05:30', 700), t('2026-11-06T11:00:00+05:30', -700)], cap, daily, weekly, now) === 0, 'a week netting exactly 0 is not successful');
assert(countSuccessfulWeeks([t('2026-11-05T11:00:00+05:30', -16000), t('2026-11-06T11:00:00+05:30', 30000)], cap, daily, weekly, now) === 0, 'net +14000 but one day lost 16000 (> 15% of 1L): forfeited, not successful');
assert(countSuccessfulWeeks([t('2026-11-19T11:00:00+05:30', 1000)], cap, daily, weekly, now) === 0, 'the current, incomplete week is not counted');
assert(countSuccessfulWeeks([t('2026-11-10T23:30:00+05:30', 1000), t('2026-11-11T00:30:00+05:30', 1000)], cap, daily, weekly, now) === 2, 'Tuesday night and Wednesday morning belong to different weeks');
assert(countSuccessfulWeeks([t('2026-11-05T11:00:00+05:30', 1000), t('2026-11-05T12:00:00+05:30', 500, 'b')], cap, daily, weekly, now) === 1, 'several trades in one week count that week once');

if (!failed) console.log('ALL PASS');
process.exit(process.exitCode ?? 0);
