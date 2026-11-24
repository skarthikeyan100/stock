import assert from 'assert';
import { initSRState, processTick, SRConfig } from '../lib/supportResistance';

const cfg: SRConfig = { confirmWindowMs: 30_000, maxJump: 15, maxRangeWidth: 5, buffer: 0, breachBuffer: 0, breachConfirmMs: 0 };

// Sparse: anchor 100 at t=0, next tick 108 at t=70s. The window holds only [108], but the price moved 8 (> 5) during the span: no lock.
{
    let r = processTick(initSRState(), { ltp: 100, ltt: 0 }, cfg);
    r = processTick(r.state, { ltp: 108, ltt: 70_000 }, cfg);
    assert.strictEqual(r.event.type, 'NONE', 'anchor price must take part in the range');
    assert.strictEqual(r.state.phase, 'SEEKING');
    assert.strictEqual(r.state.buffer[0].ltp, 100, 'state carries the anchor');
}
// Sparse, within width: anchor 100 then 103 -> locks, 100..103.
{
    let r = processTick(initSRState(), { ltp: 100, ltt: 0 }, cfg);
    r = processTick(r.state, { ltp: 103, ltt: 70_000 }, cfg);
    assert.strictEqual(r.event.type, 'LOCKED');
    if (r.event.type === 'LOCKED') { assert.strictEqual(r.event.support, 100); assert.strictEqual(r.event.resistance, 103); }
}
// Dense: ticks every second; a tick sits exactly on the cutoff (an older tick must not widen the range).
{
    let r = processTick(initSRState(), { ltp: 120, ltt: 0 }, { ...cfg, maxJump: 100 });
    let ev: any = r.event;
    for (let s = 1; s <= 31; s++) {
        r = processTick(r.state, { ltp: s === 1 ? 100 : 102, ltt: s * 1000 }, { ...cfg, maxJump: 100 });
        ev = r.event;
    }
    // at t=31s cutoff=1s: window starts with the tick at 1s (100); the 120 tick at 0s is the anchor and must not count
    assert.strictEqual(ev.type, 'LOCKED');
    assert.strictEqual(ev.support, 100);
    assert.strictEqual(ev.resistance, 102);
}
console.log('supportResistanceAnchorRange: OK');
