import assert from 'assert';
import { demoLeaseHeld } from '../routes/demoLease';

const open = new Map<string, number>([['1.1.1.1', 1]]);
assert.strictEqual(demoLeaseHeld(new Set(['1.1.1.1']), open), true, 'subscriber IP still streaming -> held');
assert.strictEqual(demoLeaseHeld(new Set(['2.2.2.2']), open), false, 'subscriber closed its tab while another IP streams -> not held');
assert.strictEqual(demoLeaseHeld(new Set(['2.2.2.2', '1.1.1.1']), open), true, 'any subscriber streaming -> held');
assert.strictEqual(demoLeaseHeld(undefined, open), false, 'unknown subscribers -> not held');
assert.strictEqual(demoLeaseHeld(new Set(['1.1.1.1']), new Map()), false, 'no streams -> not held');
console.log('demoLease: all passed');
