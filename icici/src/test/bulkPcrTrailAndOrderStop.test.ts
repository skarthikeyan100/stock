/**
 * BulkPcrStrategy: (1) the hedge trail exit and (2) the per-order loss stop (maxLossPerOrder).
 * No Mongo / IPC: OrderClient is monkey-patched, slots are injected, ticks go through processOptionQuote.
 * Run: npx tsc, then: node ./dist/test/bulkPcrTrailAndOrderStop.test.js
 */

import BulkPcrStrategy from '../strategy/BulkPcrStrategy';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import * as marketHours from '../util/marketHours';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

(marketHours as any).isPastMarketClose = () => false;

function setConfig(userId: string, extra: Record<string, unknown>) {
    (configService as any).config = {
        settings: {},
        strategies: [{ type: 'BulkPcrStrategy', userId, enabled: true, brokers: ['kite'], targetPoints: 2, quantity: -1, slDistance: 10, maxInvestment: 100000, ...extra }],
    };
}

interface Calls { sells: any[]; cancels: any[]; squareOffs: any[] }
function mockClient(): Calls {
    const calls: Calls = { sells: [], cancels: [], squareOffs: [] };
    const client = OrderClient.getInstance() as any;
    client.chunkedSquareOffLimit = async (_u: string, p: any) => { calls.sells.push(p); return {}; };
    client.cancelRestingLimitSells = async (_u: string, p: any) => { calls.cancels.push(p); return { filledQty: 0, cancelFailed: false }; };
    client.chunkedSquareOff = async (_u: string, p: any) => { calls.squareOffs.push(p); return { avgPrice: 0 }; };
    return calls;
}

function slot(right: 'call' | 'put', tsym: string, token: string, entryAvg: number, extra: any = {}) {
    return { broker: 'kite', right, phase: 'selling', heldTsym: tsym, heldToken: token, entryAvg, targetQuantity: 100, soldQty: 0, soldValue: 0, entryQuantity: 100, ...extra };
}

const tick = (token: string, ltp: number) => ({ token, ltp } as any);

async function testTrail() {
    console.log('Test: hedge trail - arms at slDistance/2 without selling, exits on a limit at the tick, re-prices a fast fall');
    setConfig('trail-1', { hedgeTrailDistance: 3 });
    const calls = mockClient();
    const s = new BulkPcrStrategy('trail-1') as any;
    // CE root far above (so it neither hedges nor trips), PE hedge entry 40, target = ceil(10/2) = 5.
    s.positions.set('kite_call', slot('call', 'NIFTYC', 'C1', 100));
    s.positions.set('kite_put', slot('put', 'NIFTYP', 'P1', 40, { hedge: true, trailDistance: 3, trailTarget: 5 }));

    await s.processOptionQuote(tick('P1', 44));
    assert(calls.sells.length === 0 && !s.positions.get('kite_put').trail, 'below the target: nothing armed, nothing sold');
    await s.processOptionQuote(tick('P1', 45));
    assert(s.positions.get('kite_put').trail?.armed === true && calls.sells.length === 0, 'reaching the target (45) arms the trail and sells nothing');
    await s.processOptionQuote(tick('P1', 52));
    await s.processOptionQuote(tick('P1', 50));
    assert(calls.sells.length === 0, 'peak 52, level 49: a tick at 50 still holds');
    await s.processOptionQuote(tick('P1', 49));
    assert(calls.sells.length === 1 && calls.sells[0].price === 49 && calls.sells[0].quantity === 100, `falling to peak-trail places ONE limit sell at the tick (got ${JSON.stringify(calls.sells.map((c) => c.price))})`);
    await s.processOptionQuote(tick('P1', 48.5));
    assert(calls.sells.length === 1, 'a tick right after the exit does not stack a second order (re-price waits)');
    // Fast fall: age the order, price now under the limit.
    s.positions.get('kite_put').exitPlacedAt = Date.now() - 10_000;
    await s.processOptionQuote(tick('P1', 47));
    assert(calls.cancels.length === 1 && calls.sells.length === 2 && calls.sells[1].price === 47, 'unfilled limit left behind by a fast fall is cancelled and re-placed at the tick');
    // Never below the entry.
    // The config turned off mid-cycle: the slot keeps the mode it was placed with.
    setConfig('trail-1', {});
    s.positions.get('kite_put').exitPlacedAt = Date.now() - 10_000;
    await s.processOptionQuote(tick('P1', 39));
    assert(calls.sells.length === 2, 'no re-price below the entry (40)');
}

async function testTrailOffAndRootLeg() {
    console.log('Test: trail off, or a root leg - nothing changes');
    setConfig('trail-2', {});
    let calls = mockClient();
    let s = new BulkPcrStrategy('trail-2') as any;
    s.positions.set('kite_put', slot('put', 'NIFTYP', 'P1', 40, { hedge: true }));
    await s.processOptionQuote(tick('P1', 60));
    assert(calls.sells.length === 0 && !s.positions.get('kite_put').trail, 'hedgeTrailDistance unset: hedge is not trailed');
    setConfig('trail-3', { hedgeTrailDistance: 3 });
    calls = mockClient();
    s = new BulkPcrStrategy('trail-3') as any;
    s.positions.set('kite_call', slot('call', 'NIFTYC', 'C1', 40));
    await s.processOptionQuote(tick('C1', 60));
    assert(calls.sells.length === 0 && !s.positions.get('kite_call').trail, 'a root (non-hedge) leg is not trailed');
}

async function testPerOrderStopTrips() {
    console.log('Test: maxLossPerOrder trip closes only that order');
    setConfig('order-2', { maxLossPerOrder: '1%' }); // 1000 per order, qty 100 -> 10 points
    const calls = mockClient();
    const s = new BulkPcrStrategy('order-2') as any;
    s.positions.set('kite_call', slot('call', 'NIFTYC', 'C1', 100));
    s.positions.set('kite_put', slot('put', 'NIFTYP', 'P1', 40));
    await s.processOptionQuote(tick('P1', 80)); // put +4000
    await s.processOptionQuote(tick('C1', 95)); // call -500
    assert(!s.isBrokerStopped('kite'), 'call -500 with put +4000: no trip (no netting needed, and none applied)');
    await s.processOptionQuote(tick('C1', 89)); // call -1100 > 1000
    assert(s.isBrokerStopped('kite'), 'call -1100 breaches its own 1000 cap');
    assert(calls.squareOffs.length === 1 && calls.squareOffs[0].tsym === 'NIFTYC', `only the call is squared off (got ${JSON.stringify(calls.squareOffs.map((c) => c.tsym))})`);
    assert(s.positions.get('kite_put').phase === 'selling', 'the put keeps its exit');
    assert(s.stopFor('kite_call').isTripped() && !s.stopFor('kite_put').isTripped(), 'the latch is per order');
}

async function main() {
    await testTrail();
    await testTrailOffAndRootLeg();
    await testPerOrderStopTrips();
    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
}
main().then(() => process.exit(process.exitCode ?? 0));
