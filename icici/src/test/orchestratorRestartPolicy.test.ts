import assert from 'assert';
import { shouldAutoRestart, ChildRole, shouldGiveUpOnQuickCrashes, shouldGiveUpOnFailedRestarts, maxQuickCrashes, maxFailedRestarts } from '../orchestratorPolicy';

assert.strictEqual(shouldAutoRestart('data', 'crash'), false, 'a data crash must not auto-restart the feeds');
assert.strictEqual(shouldAutoRestart('data', 'dist-change'), false, 'a rebuilt dist file must not restart data');
for (const role of ['order', 'strategies', 'frontend'] as ChildRole[]) {
    assert.strictEqual(shouldAutoRestart(role, 'crash'), true, `${role} crash still respawns`);
    assert.strictEqual(shouldAutoRestart(role, 'dist-change'), true, `${role} dist change still restarts`);
}
assert.strictEqual(maxQuickCrashes('trading'), 2);
assert.strictEqual(maxFailedRestarts('trading'), 2);
for (const role of ['order', 'strategies', 'frontend']) {
    assert.strictEqual(maxQuickCrashes(role), 10);
    assert.strictEqual(maxFailedRestarts(role), 10);
}
for (const [n, want] of [[0, false], [1, false], [2, true], [3, true], [1000, true]] as Array<[number, boolean]>) {
    assert.strictEqual(shouldGiveUpOnQuickCrashes('trading', n), want, `trading quick crashes ${n}`);
    assert.strictEqual(shouldGiveUpOnFailedRestarts('trading', n), want, `trading failed restarts ${n}`);
}
for (const [n, want] of [[1, false], [2, false], [9, false], [10, true], [11, true]] as Array<[number, boolean]>) {
    assert.strictEqual(shouldGiveUpOnQuickCrashes('frontend', n), want, `frontend quick crashes ${n}`);
    assert.strictEqual(shouldGiveUpOnFailedRestarts('frontend', n), want, `frontend failed restarts ${n}`);
}
console.log('orchestratorRestartPolicy: all assertions passed');
