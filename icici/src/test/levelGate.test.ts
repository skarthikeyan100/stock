/**
 * Beginner gating (src/levelGate.ts): Search & Buy and own target/stop/investment mode are Advanced features.
 * Run: npx tsc && node ./dist/test/levelGate.test.js
 */
import { gateBuy, gateSettings, gateSetTarget, gateLevelChange } from '../levelGate';

let failed = false;
function assert(cond: boolean, msg: string) { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) { failed = true; process.exitCode = 1; } }
const globals = { globalTarget: 2, globalStopLoss: 10 };

console.log('gateBuy');
const adm = gateBuy({ role: 'admin', level: 'beginner', contract: 'NIFTY_25550_CE', targetPoints: 7, stopLossPoints: 9, ...globals });
assert(adm.allowed && adm.targetPoints === 7 && adm.stopLossPoints === 9, 'admin: everything passes through unchanged');
const adv = gateBuy({ role: 'user', level: 'advanced', contract: 'TCS_4000_CE', targetPoints: 7, stopLossPoints: 9, ...globals });
assert(adv.allowed && adv.targetPoints === 7 && adv.stopLossPoints === 9, 'advanced: Search & Buy and own target/stop pass through');
const bs = gateBuy({ role: 'user', level: 'beginner', contract: 'NIFTY_25550_CE', ...globals });
assert(!bs.allowed && bs.error === 'Search & Buy is available at the Advanced level', 'beginner Search & Buy refused');
const bf = gateBuy({ role: 'user', level: undefined, targetPoints: 99, stopLossPoints: 1, ...globals });
assert(bf.allowed && bf.targetPoints === 2 && bf.stopLossPoints === 10, 'beginner Flash: own target/stop ignored, global 2 / 10 forced');
const bn = gateBuy({ role: 'user', level: 'beginner', ...globals, globalTarget: NaN as any });
assert(bn.allowed && bn.targetPoints === undefined && bn.stopLossPoints === 10, 'beginner with an unusable global default: that value stays unset (the server fallback applies), the other is forced');

console.log('gateSettings');
assert(gateSettings({ role: 'user', level: 'beginner', investmentMode: 'lotCount' }).allowed === false, 'beginner cannot pick lotCount');
assert(gateSettings({ role: 'user', level: 'beginner', targetPoints: 5 }).allowed === false, 'beginner cannot set a target');
assert(gateSettings({ role: 'user', level: 'beginner', stopLossPoints: 5 }).allowed === false, 'beginner cannot set a stop-loss');
assert(gateSettings({ role: 'user', level: 'beginner', investmentMode: 'investmentAmount', targetPoints: null, stopLossPoints: null }).allowed === true, 'beginner: unchanged mode and cleared (null) overrides are fine');
assert(gateSettings({ role: 'user', level: 'beginner' }).allowed === true, 'beginner: nothing sensitive supplied is fine');
assert(gateSettings({ role: 'user', level: 'advanced', investmentMode: 'lotCount', targetPoints: 5, stopLossPoints: 5 }).allowed === true, 'advanced: all allowed');
assert(gateSettings({ role: 'admin', level: 'beginner', investmentMode: 'lotCount', targetPoints: 5 }).allowed === true, 'admin: all allowed');

if (!failed) console.log('ALL PASS');
process.exit(process.exitCode ?? 0);

console.log('review fixes');
const a0 = gateBuy({ role: 'user', level: 'advanced', stopLossPoints: 0, targetPoints: 5, ...globals });
assert(a0.allowed && a0.stopLossPoints === 10 && a0.targetPoints === 5, 'advanced stop-loss 0 falls back to the global stop (never an unprotected full-capital buy)');
assert(gateSetTarget({ role: 'user', level: 'beginner', targetPoints: 50, stopLossPoints: 200 }).allowed === false, 'beginner cannot change target/stop after the buy (settarget)');
assert(gateSetTarget({ role: 'user', level: 'advanced', targetPoints: 5, stopLossPoints: 0 }).allowed === false, 'advanced cannot remove the stop (0)');
assert(gateSetTarget({ role: 'user', level: 'advanced', targetPoints: 5, stopLossPoints: 8 }).allowed === true, 'advanced can set a stop above 0');
assert(gateSetTarget({ role: 'admin', level: 'beginner', targetPoints: 5, stopLossPoints: 0 }).allowed === true, 'admin unrestricted');
assert(gateLevelChange('advanced', 'beginner').allowed === false, 'advanced -> beginner refused');
assert(gateLevelChange('beginner', 'advanced').allowed === true && gateLevelChange('beginner', 'beginner').allowed === true && gateLevelChange('advanced', 'advanced').allowed === true, 'other transitions allowed');

