/**
 * A resting refill buy survives a restart (review R5-8): its intent is persisted on every change and restored by reconcile, so the
 * eventual fill becomes a tracked leg instead of an untracked position with no stop.
 * Run: node ./dist/test/legPendingReEntries.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import Mongo from '../tools/mongo';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const store = new Map<string, any>();
const fakeDb = {
    collection: (name: string) => ({
        replaceOne: async (filter: any, doc: any) => { store.set(name + ':' + filter.userId + ':' + filter.ownerType, doc); },
        findOne: async (filter: any) => store.get(name + ':' + filter.userId + ':' + filter.ownerType) ?? null,
        insertOne: async () => ({}),
        find: () => ({ sort: () => ({ toArray: async () => [] }) }),
    }),
};
(Mongo as any).getInstance = () => ({ db: fakeDb });

const intent = (token: string) => ({
    token, tsym: 'NIFTY26N0322500CE', exchange: 'NFO', strike: 22500, right: 'call', quantity: 130, limitPrice: 100,
    orderId: 'ord-1', isRoot: true, parentLegId: null, parentLevel: null, parentLegRef: null,
});

async function main() {
    const before = (new ContinuousStrategy('ContinuousStrategy') as any).legManager;
    before.pendingReEntries.set('tokA', intent('tokA'));
    const saved = store.get('legPendingReEntries:ContinuousStrategy:' + before.deps.ownerType);
    assert(saved && saved.intents.length === 1 && saved.intents[0].orderId === 'ord-1', 'placing a refill persists its intent');

    // "Restart": a fresh LegManager for the same user.
    const after = (new ContinuousStrategy('ContinuousStrategy') as any).legManager;
    assert(after.canHandle('tokA') === false, 'a fresh instance knows nothing before reconcile');
    await after.restorePendingReEntries();
    assert(after.canHandle('tokA') === true, 'reconcile restores the resting refill intent');

    const fill = Object.assign(new Trade(), { action: 'Buy', token: 'tokA', tsym: 'NIFTY26N0322500CE', quantity: 130, price: 98, brokerOrderId: 'ord-1' });
    await after.handleFillOrExternalSell(fill);
    assert(after.legsByToken.has('tokA'), 'the refill that fills after the restart becomes a tracked leg');

    // Filled while down: the broker's open trades already restored a leg for this token, so the intent is dropped.
    const third = (new ContinuousStrategy('ContinuousStrategy') as any).legManager;
    third.legsByToken.set('tokA', { token: 'tokA' });
    store.set('legPendingReEntries:ContinuousStrategy:' + third.deps.ownerType, { day: saved.day, intents: [intent('tokA'), intent('tokB')] });
    await third.restorePendingReEntries();
    assert(!third.pendingReEntries.has('tokA') && third.pendingReEntries.has('tokB'), 'an intent whose token already has a leg is dropped; the other is kept');

    // Yesterday's intents are not resurrected.
    const fourth = (new ContinuousStrategy('ContinuousStrategy') as any).legManager;
    store.set('legPendingReEntries:ContinuousStrategy:' + fourth.deps.ownerType, { day: '2000-01-01', intents: [intent('tokC')] });
    await fourth.restorePendingReEntries();
    assert(!fourth.pendingReEntries.has('tokC'), 'a previous day\'s intents are ignored');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
