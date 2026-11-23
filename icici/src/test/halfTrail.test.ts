/**
 * Half-at-target + trail exit: the pure rules (halfTrail.ts).
 * Run: npx tsc, then: node ./dist/test/halfTrail.test.js
 */
import '../util/tz';
import configService from '../prism/ConfigService';
import { splitLots, stepHalfTrail, HalfTrailState } from '../strategy/halfTrail';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

// ---- pure rules ----
console.log('splitLots');
assert(splitLots(65, 65) === null, '1 lot: not engaged');
assert(splitLots(130, 65)?.halfQty === 65 && splitLots(130, 65)?.trailQty === 65, '2 lots: 1 + 1');
assert(splitLots(195, 65)?.halfQty === 65 && splitLots(195, 65)?.trailQty === 130, '3 lots: 1 sold at target, 2 trail');
assert(splitLots(325, 65)?.halfQty === 130, '5 lots: 2 + 3');
assert(splitLots(100, 65) === null && splitLots(0, 65) === null, 'not whole lots / zero: null');

console.log('stepHalfTrail');
const st = (): HalfTrailState => ({ halfQty: 65, targetPrice: 110, dist: 4, phase: 'half', sellQty: 65 });
let h = st();
let r = stepHalfTrail(h, 100, 111, 0);
assert(r.action === 'hold' && !r.switched && h.phase === 'half', 'half not sold yet: nothing happens, whatever the price');
r = stepHalfTrail(h, 100, 112, 65);
assert(r.action === 'hold' && r.switched && h.phase === 'trail' && h.trail?.peak === 112, 'half sold at 112: trail starts, peak 112');
r = stepHalfTrail(h, 100, 118, 65);
assert(r.action === 'hold' && h.trail?.peak === 118, 'peak follows to 118');
r = stepHalfTrail(h, 100, 115, 65);
assert(r.action === 'hold', '115 > 118 - 4: hold');
r = stepHalfTrail(h, 100, 114, 65);
assert(r.action === 'exit' && r.exitLevel === 114, 'exit at peak - 4 = 114');
h = st();
r = stepHalfTrail(h, 100, 109, 65);
assert(r.action === 'exit' && r.switched && r.exitLevel === 110, 'half sold but price already below the target: floor 110, exits at once');
h = st();
r = stepHalfTrail(h, 100, 111, 65);
r = stepHalfTrail(h, 100, 110, 65);
assert(r.action === 'exit' && r.exitLevel === 110, 'peak 111 -> level max(110, 107) = 110: never below the target');
h = st(); h.sellQty = undefined;
r = stepHalfTrail(h, 100, 112, 65);
assert(!r.switched && h.phase === 'half', 'sell not yet recorded: phase stays half');
h = st(); stepHalfTrail(h, 100, 120, 65);
const copy: HalfTrailState = JSON.parse(JSON.stringify(h));
r = stepHalfTrail(copy, 100, 116, 65);
assert(r.action === 'exit' && r.peak === 120, 'state survives a JSON round trip (restart): peak 120 kept (exit level 116)');
