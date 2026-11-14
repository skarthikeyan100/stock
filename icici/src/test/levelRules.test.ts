/**
 * Level rules (src/levelRules.ts): per-level numbers from config.yml settings.levelRules, with built-in defaults.
 * Run: npx tsc && node ./dist/test/levelRules.test.js
 */
import { levelRules } from '../levelRules';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

console.log('defaults');
const b = levelRules(undefined, undefined);
assert(b.level === 'beginner' && b.capital === 100000 && b.maxDailyDrawdownPercent === 15 && b.maxWeeklyDrawdownPercent === 30 && b.maxLossPerTradePercent === 10 && b.profitSplitPercent === 35, `beginner defaults (got ${JSON.stringify(b)})`);
const a = levelRules({}, 'ADVANCED');
assert(a.level === 'advanced' && a.capital === 200000 && a.profitSplitPercent === 25 && a.maxDailyDrawdownPercent === 15 && a.maxWeeklyDrawdownPercent === 30 && a.maxLossPerTradePercent === 10, `advanced defaults (got ${JSON.stringify(a)})`);
assert(levelRules({}, 'junk').level === 'beginner', 'unknown level -> beginner');

console.log('config overrides');
const o = levelRules({ levelRules: { advanced: { capital: 300000, maxDailyDrawdownPercent: '12%' } } }, 'advanced');
assert(o.capital === 300000 && o.maxDailyDrawdownPercent === 12 && o.profitSplitPercent === 25, `own values win, the rest default (got ${JSON.stringify(o)})`);

console.log('invalid values fall back');
const bad = levelRules({ levelRules: { beginner: { capital: 'abc', profitSplitPercent: 0, maxLossPerTradePercent: -5, maxDailyDrawdownPercent: 'x' } } }, 'beginner');
assert(bad.capital === 100000 && bad.profitSplitPercent === 35 && bad.maxLossPerTradePercent === 10, `invalid capital/share/per-trade -> defaults (got ${JSON.stringify(bad)})`);

console.log('no max payment');
assert(!('maxPayment' in levelRules({}, 'beginner')), 'maxPayment is gone');

if (!failed) console.log('ALL PASS');
