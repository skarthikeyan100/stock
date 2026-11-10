/**
 * BulkPcrStrategy profitCooldownSeconds: a maxProfit lockout is released after the cooldown once the broker is flat, the profit target
 * restarts from the day P&L at that moment, and 0 keeps the lockout for the day. No Mongo / IPC (OrderClient monkey-patched).
 * Run: npx tsc, then: node ./dist/test/bulkPcrProfitCooldown.test.js
 */
import BulkPcrStrategy from '../strategy/BulkPcrStrategy';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import * as marketHours from '../util/marketHours';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

(marketHours as any).isPastMarketClose = () => false;
(configService as any).configPath = `/tmp/bulkPcrProfitCooldown-config-${process.pid}.yml`;

function setConfig(userId: string, extra: Record<string, unknown>) {
    (configService as any).config = {
        settings: {},
        strategies: [{ type: 'BulkPcrStrategy', userId, enabled: true, brokers: ['kite'], targetPoints: 2, quantity: -1, slDistance: 10, index: 'NIFTY', maxInvestment: 100000, maxInvestmentByBroker: { kite: 100000 }, lossCooldownSeconds: 300, lossInvestmentCut: 10000, maxProfit: '2%', ...extra }],
    };
}

function mockClient() {
    const client = OrderClient.getInstance() as any;
    client.chunkedSquareOffLimit = async () => ({});
    client.cancelRestingLimitSells = async () => ({ filledQty: 0, cancelFailed: false });
    client.setBrokerInvestmentCap = async () => {};
    client.chunkedSquareOff = async () => ({ avgPrice: 0 });
}

async function main() {
    mockClient();
    console.log('Test: profit trip, release after the cooldown, restart of the target');
    setConfig('pc-1', { profitCooldownSeconds: 300 });
    const s = new BulkPcrStrategy('pc-1') as any;
    s.ensureToday(); // the first call rolls the day and clears the accumulators
    s.dayRealizedByBroker.set('kite', 2500); // threshold 2% of 100000 = 2000
    assert(s.tripIfBreached('kite') === true && s.isBrokerStopped('kite'), 'trips at +2500');
    const until = s.profitCooldownUntil.get('kite');
    assert(until !== undefined && until - Date.now() > 290_000 && until - Date.now() <= 300_000, 'cooldown of 300s recorded');
    await s.maybeReleaseProfit('kite');
    assert(s.isBrokerStopped('kite'), 'still locked before the cooldown has elapsed');
    s.profitCooldownUntil.set('kite', Date.now() - 1);
    await s.maybeReleaseProfit('kite');
    assert(!s.isBrokerStopped('kite') && !s.profitCooldownUntil.has('kite'), 'released after the cooldown');
    assert(s.profitBaselineByBroker.get('kite') === 2500, 'baseline = day P&L at the release');
    assert(s.tripIfBreached('kite') === false && !s.isBrokerStopped('kite'), 'no instant re-trip on the same profit');
    s.dayRealizedByBroker.set('kite', 4600); // +2100 since the release
    assert(s.tripIfBreached('kite') === true && s.isBrokerStopped('kite'), 'trips again after another +2000 from the release point');

    console.log('Test: a pending loss lockout waits for the profit release instead of giving up');
    s.lossCooldownUntil.set('kite', Date.now() - 1);
    await s.maybeReleaseLoss('kite');
    assert(s.lossCooldownUntil.has('kite'), 'loss release deferred while a profit cooldown is pending');
    for (const t of s.releaseTimers.values()) clearTimeout(t);
    for (const t of s.profitReleaseTimers.values()) clearTimeout(t);

    console.log('Test: profitCooldownSeconds 0 keeps the lockout for the day');
    setConfig('pc-2', {});
    const z = new BulkPcrStrategy('pc-2') as any;
    z.ensureToday();
    z.dayRealizedByBroker.set('kite', 2500);
    assert(z.tripIfBreached('kite') === true && z.profitCooldownUntil.size === 0, 'locked, no cooldown entry');
    process.exit(process.exitCode ?? 0);
}
main();
