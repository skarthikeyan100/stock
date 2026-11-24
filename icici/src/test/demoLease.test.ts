import assert from 'assert';
import { demoLeaseHeld, addSubscriberIp, removeSubscriberIp, ipHoldsToken } from '../routes/demoLease';

const open = new Map<string, number>([['1.1.1.1', 1]]);
assert.strictEqual(demoLeaseHeld(new Map([['1.1.1.1', 1]]), open), true, 'subscriber IP still streaming -> held');
assert.strictEqual(demoLeaseHeld(new Map([['2.2.2.2', 1]]), open), false, 'subscriber closed its tab while another IP streams -> not held');
assert.strictEqual(demoLeaseHeld(new Map([['2.2.2.2', 1], ['1.1.1.1', 1]]), open), true, 'any subscriber streaming -> held');
assert.strictEqual(demoLeaseHeld(undefined, open), false, 'unknown subscribers -> not held');
assert.strictEqual(demoLeaseHeld(new Map([['1.1.1.1', 1]]), new Map()), false, 'no streams -> not held');
{
    const ips = new Map<string, number>();
    addSubscriberIp(ips, '1.1.1.1'); addSubscriberIp(ips, '1.1.1.1'); addSubscriberIp(ips, '2.2.2.2');
    removeSubscriberIp(ips, '2.2.2.2');
    assert.strictEqual(demoLeaseHeld(ips, new Map([['2.2.2.2', 1]])), false, 'departed IP no longer refreshes the lease');
    removeSubscriberIp(ips, '1.1.1.1');
    assert.strictEqual(demoLeaseHeld(ips, new Map([['1.1.1.1', 1]])), true, 'IP with a remaining subscription still holds');
    removeSubscriberIp(ips, '1.1.1.1');
    assert.strictEqual(ips.size, 0, 'IP removed at zero');
    removeSubscriberIp(ips, '9.9.9.9');
    assert.strictEqual(ips.size, 0, 'removing unknown IP is a no-op');
}
{
    const ips = new Map<string, number>([['1.1.1.1', 1]]);
    assert.strictEqual(ipHoldsToken(ips, '1.1.1.1'), true, 'subscriber IP may unsubscribe');
    assert.strictEqual(ipHoldsToken(ips, '2.2.2.2'), false, 'IP that never subscribed the token may not unsubscribe it');
    assert.strictEqual(ipHoldsToken(undefined, '1.1.1.1'), false, 'no IP map -> rejected');
    removeSubscriberIp(ips, '1.1.1.1');
    assert.strictEqual(ipHoldsToken(ips, '1.1.1.1'), false, 'IP that already released its subscriptions may not unsubscribe again');
}
console.log('demoLease: all passed');
