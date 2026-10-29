import assert from 'assert';
import { shouldAutoRestart, ChildRole } from '../orchestratorPolicy';

assert.strictEqual(shouldAutoRestart('data', 'crash'), false, 'a data crash must not auto-restart the feeds');
assert.strictEqual(shouldAutoRestart('data', 'dist-change'), false, 'a rebuilt dist file must not restart data');
for (const role of ['order', 'strategies', 'frontend'] as ChildRole[]) {
    assert.strictEqual(shouldAutoRestart(role, 'crash'), true, `${role} crash still respawns`);
    assert.strictEqual(shouldAutoRestart(role, 'dist-change'), true, `${role} dist change still restarts`);
}
console.log('orchestratorRestartPolicy: all assertions passed');
