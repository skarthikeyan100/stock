/**
 * TrailStop: arms at entry + activation without selling, then exits when the price falls `trail` below the peak,
 * never below the activation (target) level. Run: npx tsc, then: node ./dist/test/trailStop.test.js
 */

import { TrailStop } from '../strategy/TrailStop';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const mk = (trail: number, activation: number) => new TrailStop({ getTrailDistance: () => trail, getActivation: () => activation });

// slDistance 10 -> target 5; trail 3; entry 40
let t = mk(3, 5);
assert(t.onTick(40, 44).action === 'hold', 'below the target: hold');
let d = t.onTick(40, 45);
assert(d.action === 'hold' && d.changed === true, 'reaching the target arms the trail and does not sell');
assert(t.onTick(40, 50).action === 'hold', 'new high 50: hold');
assert(t.exitLevel(40) === 47, 'exit level = peak - trail = 47');
assert(t.onTick(40, 48).action === 'hold', '48 is above the exit level: hold');
d = t.onTick(40, 47);
assert(d.action === 'exit' && d.peak === 50 && d.exitLevel === 47, 'falling to peak - trail exits');

// floor: a small peak never lets the level sit under the target
t = mk(3, 5);
t.onTick(40, 45);
assert(t.exitLevel(40) === 45, 'level floors at the target (45), not peak - trail (42)');
assert(t.onTick(40, 45).action === 'exit', 'back at the target after arming exits at the floor');

// restart: the persisted peak survives
t = mk(3, 5);
t.onTick(40, 45); t.onTick(40, 52);
const snap = t.snapshot();
const t2 = mk(3, 5);
t2.restore(snap);
assert(t2.exitLevel(40) === 49 && t2.onTick(40, 50).action === 'hold' && t2.onTick(40, 49).action === 'exit', 'restored peak keeps the trail level');
assert(mk(3, 5).snapshot() === undefined, 'nothing to persist before arming');
const t3 = mk(3, 5); t3.restore({ peak: NaN, armed: true });
assert(t3.snapshot() === undefined, 'an unusable persisted peak is ignored');

// off / bad input
assert(mk(0, 5).onTick(40, 80).action === 'hold' && !mk(0, 5).enabled(), 'trail 0 = off');
t = mk(3, 5);
assert(t.onTick(40, NaN).action === 'hold' && t.onTick(40, 0).action === 'hold' && t.snapshot() === undefined, 'a tick without a usable price changes nothing');
