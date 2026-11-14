/**
 * Level defaults for a user's capital and profit share (src/user.ts levelDefaultsFor).
 * Run: npx tsc && node ./dist/test/userLevelDefaults.test.js
 */
import { levelDefaultsFor } from '../user';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }

const b = levelDefaultsFor('beginner');
const a = levelDefaultsFor('advanced');
assert(b.accountCapital === 100000 && b.profitSplitPercent === 35, `beginner: 1L capital, 35% share (got ${JSON.stringify(b)})`);
assert(a.accountCapital === 200000 && a.profitSplitPercent === 25, `advanced: 2L capital, 25% share (got ${JSON.stringify(a)})`);
if (!failed) console.log('ALL PASS');
process.exit(process.exitCode ?? 0);
