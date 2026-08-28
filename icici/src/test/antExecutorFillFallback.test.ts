/**
 * Verifies enterPosition's REST fallback (ANT.getFillPrice) for the
 * "orphaned broker position on fill-notify failure" bug: if
 * AntOrderNotifyStream.waitForFill fails (missed/timed-out order-notify
 * push), enterPosition must fall back to a direct REST fill check instead
 * of aborting and leaving the broker-side fill untracked. If the REST
 * fallback also fails to find a fill, enterPosition must still throw and
 * must NOT record a trade (i.e. no orphan is created either way).
 *
 * Run: npm run build (compile), then: node ./dist/test/antExecutorFillFallback.test.js
 */

import ANT from '../ant/ANT';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import bookkeeping from '../processes/order/bookkeeping';
import { enterPosition } from '../processes/order/antExecutor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// --- Mocks, following continuousStrategyTest.ts's MockOrderClient pattern:
// monkey-patch the singleton's private static `instance` field so
// ANT.getInstance()/AntOrderNotifyStream.getInstance() return these mocks
// instead of constructing the real network-backed singletons. ---

class MockAnt {
    placeOrderCalls: any[] = [];
    getFillPriceCalls: string[] = [];
    nextOrderNo = 'ORDER-1';
    // Set to a number to have getFillPrice resolve with that price, or to an
    // Error instance to have it reject with that error.
    getFillPriceResult: number | Error = 100;

    async placeOrder(req: any): Promise<{ orderNo: string }> {
        this.placeOrderCalls.push(req);
        return { orderNo: this.nextOrderNo };
    }

    async placeBracketOrder(req: any): Promise<{ orderNo: string }> {
        this.placeOrderCalls.push(req);
        return { orderNo: this.nextOrderNo };
    }

    async getQuote(_exchange: string, _instrumentId: string): Promise<number> {
        return 100;
    }

    async getFillPrice(orderNo: string): Promise<number> {
        this.getFillPriceCalls.push(orderNo);
        if (this.getFillPriceResult instanceof Error) throw this.getFillPriceResult;
        return this.getFillPriceResult;
    }
}

class MockNotifyStream {
    waitForFillCalls: string[] = [];
    // Set to a number to have waitForFill resolve with that price, or to an
    // Error instance to have it reject with that error (simulating a missed
    // push / 60s timeout / REJECTED / CANCELLED).
    waitForFillResult: number | Error = 100;

    async waitForFill(orderNo: string): Promise<number> {
        this.waitForFillCalls.push(orderNo);
        if (this.waitForFillResult instanceof Error) throw this.waitForFillResult;
        return this.waitForFillResult;
    }
}

let mockAnt: MockAnt;
let mockNotify: MockNotifyStream;

function installMocks() {
    mockAnt = new MockAnt();
    mockNotify = new MockNotifyStream();
    (ANT as any).instance = mockAnt;
    (AntOrderNotifyStream as any).instance = mockNotify;
}

// targetPoints/stopLossPoints are deliberately 0 in every test below - this
// forces enterPosition's non-bracket ("regular order") branch, which needs
// no quote fetch and no placeBracketOrder mocking, keeping these tests
// focused purely on the waitForFill/getFillPrice fallback logic under test.

async function main() {
    // --- Scenario 1: waitForFill succeeds normally - no fallback should be used. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-HAPPY-PATH';
    mockNotify.waitForFillResult = 111;
    const userA = 'FallbackTestUser_HappyPath';

    const tradeA = await enterPosition(userA, 'NIFTY26AUG24100CE', 'tok-a', 65, 'NFO', 0, 0);

    assert(tradeA.price === 111, `happy path: trade price comes from waitForFill (got ${tradeA.price})`);
    assert(mockNotify.waitForFillCalls.length === 1, `happy path: waitForFill was called once (got ${mockNotify.waitForFillCalls.length})`);
    assert(mockAnt.getFillPriceCalls.length === 0, `happy path: REST fallback was NOT used (got ${mockAnt.getFillPriceCalls.length} calls)`);
    assert(bookkeeping.trades.some((t) => t.user === userA && t.brokerOrderId === 'ORDER-HAPPY-PATH'), 'happy path: trade was recorded in bookkeeping');

    // --- Scenario 2: waitForFill fails (missed push / timeout), REST fallback finds the fill. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-FALLBACK-RECOVERS';
    mockNotify.waitForFillResult = new Error('ANT order ORDER-FALLBACK-RECOVERS did not complete within 60000ms (order-notify)');
    mockAnt.getFillPriceResult = 222;
    const userB = 'FallbackTestUser_Recovers';

    const tradeB = await enterPosition(userB, 'NIFTY26AUG24200CE', 'tok-b', 65, 'NFO', 0, 0);

    assert(tradeB.price === 222, `fallback-recovers: trade price comes from REST fallback (got ${tradeB.price})`);
    assert(mockNotify.waitForFillCalls.length === 1, `fallback-recovers: waitForFill was attempted once (got ${mockNotify.waitForFillCalls.length})`);
    assert(mockAnt.getFillPriceCalls.length === 1 && mockAnt.getFillPriceCalls[0] === 'ORDER-FALLBACK-RECOVERS', `fallback-recovers: REST fallback was called with the same orderNo (got ${JSON.stringify(mockAnt.getFillPriceCalls)})`);
    assert(bookkeeping.trades.some((t) => t.user === userB && t.brokerOrderId === 'ORDER-FALLBACK-RECOVERS'), 'fallback-recovers: trade was recorded in bookkeeping despite the missed push (THIS IS THE CORE BUG FIX - no orphaned position)');

    // --- Scenario 3: waitForFill fails AND the REST fallback also fails (order genuinely never filled) - must throw, must NOT record a trade. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-GENUINELY-REJECTED';
    mockNotify.waitForFillResult = new Error('ANT order ORDER-GENUINELY-REJECTED did not complete within 60000ms (order-notify)');
    mockAnt.getFillPriceResult = new Error('ANT order ORDER-GENUINELY-REJECTED REJECTED (Insufficient funds)');
    const userC = 'FallbackTestUser_GenuineFailure';

    let threw = false;
    try {
        await enterPosition(userC, 'NIFTY26AUG24300CE', 'tok-c', 65, 'NFO', 0, 0);
    } catch (e) {
        threw = true;
    }

    assert(threw, 'genuine-failure: enterPosition throws when both waitForFill and the REST fallback fail');
    assert(mockAnt.getFillPriceCalls.length === 1, `genuine-failure: REST fallback was still attempted once (got ${mockAnt.getFillPriceCalls.length})`);
    assert(!bookkeeping.trades.some((t) => t.user === userC), 'genuine-failure: no trade was recorded for a genuinely-failed order (no orphan created)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
