/**
 * Hand-rolled tests for MomentumSignal's combine/timeout/fallback decision
 * logic (see ContinuousStrategy.resolveEntryRight's momentum veto), following
 * this directory's existing assert()/mock style (continuousStrategyTest.ts,
 * continuousStrategyEnable.test.ts) - monkey-patches OrderClient/DataClient/
 * tokenRouter's module exports directly rather than a real order/data
 * process or ANT session.
 * Run: npm run build (compile), then: node ./dist/test/momentumSignal.test.js
 */

import MomentumSignal from '../strategy/MomentumSignal';
import { OptionQuote } from '../model/model';
import { CALL, PUT } from '../constants';
import OrderClient from '../processes/strategies/OrderClient';
import * as DataClient from '../processes/strategies/DataClient';
import * as tokenRouter from '../processes/strategies/tokenRouter';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

const ATM_TOKENS = {
    ce: { token: 'CE_TOKEN', tradingSymbol: 'NIFTY-CE' },
    pe: { token: 'PE_TOKEN', tradingSymbol: 'NIFTY-PE' },
};

// Reassigned per-test to control the mocked ATM lookup's outcome.
let getAtmTokens: () => Promise<typeof ATM_TOKENS> = async () => ATM_TOKENS;

(OrderClient as any).getInstance = () => ({
    getATMTokens: async (_userId: string, _niftyLtp: number) => getAtmTokens(),
});
// No real `strategies`/`data` process behind this script - subscribe/unsubscribe
// calls (which would otherwise writeJsonLine to a stdout no one is reading, or
// touch tokenRouter's live watcher maps) are no-ops here.
(DataClient as any).subscribeTokenDepth = () => {};
(DataClient as any).unsubscribeTokenDepth = () => {};
(tokenRouter as any).watchTokenOnSource = () => {};
(tokenRouter as any).unwatchTokenOnSource = () => {};

const fakeStrategy = { userId: 'test-user' } as any;

function optionTick(token: string, tbq?: number, tsq?: number): OptionQuote {
    return Object.assign(new OptionQuote(), { token, tbq, tsq });
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testResolvesCallWhenBothLegsAgree() {
    getAtmTokens = async () => ATM_TOKENS;
    const momentum = new MomentumSignal();
    const promise = momentum.getDirection(fakeStrategy, 24000, 2000);
    await wait(20); // let the ATM lookup resolve and both legs register as tracked
    momentum.onTick(optionTick('CE_TOKEN', 1000, 500)); // CE: more buyers than sellers
    momentum.onTick(optionTick('PE_TOKEN', 400, 900)); // PE: more sellers than buyers
    const direction = await promise;
    assert(direction === CALL, `resolves CALL when CE/PE order-book imbalance both favor CALL (got ${direction})`);
}

async function testResolvesPutWhenBothLegsAgree() {
    getAtmTokens = async () => ATM_TOKENS;
    const momentum = new MomentumSignal();
    const promise = momentum.getDirection(fakeStrategy, 24000, 2000);
    await wait(20);
    momentum.onTick(optionTick('CE_TOKEN', 400, 900));
    momentum.onTick(optionTick('PE_TOKEN', 1000, 500));
    const direction = await promise;
    assert(direction === PUT, `resolves PUT when CE/PE order-book imbalance both favor PUT (got ${direction})`);
}

async function testInconclusiveWhenLegsDisagree() {
    getAtmTokens = async () => ATM_TOKENS;
    const momentum = new MomentumSignal();
    const promise = momentum.getDirection(fakeStrategy, 24000, 2000);
    await wait(20);
    momentum.onTick(optionTick('CE_TOKEN', 1000, 500)); // CE alone looks CALL-ish
    momentum.onTick(optionTick('PE_TOKEN', 1000, 500)); // but PE doesn't confirm it (needs tbq<tsq)
    const direction = await promise;
    assert(direction === null, `resolves null when CE and PE disagree with each other (got ${direction})`);
}

async function testUnavailableOnTimeout() {
    getAtmTokens = async () => ATM_TOKENS;
    const momentum = new MomentumSignal();
    const direction = await momentum.getDirection(fakeStrategy, 24000, 250);
    assert(direction === null, `resolves null (unavailable) when depth ticks never arrive before the timeout (got ${direction})`);
}

async function testUnavailableOnAtmLookupFailure() {
    getAtmTokens = async () => { throw new Error('order process unreachable'); };
    const momentum = new MomentumSignal();
    const direction = await momentum.getDirection(fakeStrategy, 24000, 1000);
    assert(direction === null, `resolves null (unavailable) when the ATM token lookup fails (got ${direction})`);
}

async function testCleansUpTrackingAfterResolve() {
    getAtmTokens = async () => ATM_TOKENS;
    const momentum = new MomentumSignal();
    const promise = momentum.getDirection(fakeStrategy, 24000, 2000);
    await wait(20);
    assert(momentum.isTracking('CE_TOKEN') && momentum.isTracking('PE_TOKEN'), 'both ATM legs tracked while awaiting a reading');
    momentum.onTick(optionTick('CE_TOKEN', 1000, 500));
    momentum.onTick(optionTick('PE_TOKEN', 400, 900));
    await promise;
    assert(!momentum.isTracking('CE_TOKEN') && !momentum.isTracking('PE_TOKEN'), 'both ATM legs untracked again once resolved (one-shot fetch, not a standing subscription)');
}

async function main() {
    await testResolvesCallWhenBothLegsAgree();
    await testResolvesPutWhenBothLegsAgree();
    await testInconclusiveWhenLegsDisagree();
    await testUnavailableOnTimeout();
    await testUnavailableOnAtmLookupFailure();
    await testCleansUpTrackingAfterResolve();

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
