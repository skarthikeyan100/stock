/**
 * Verifies BuySellStrategy reconciles its `ordered`/cooldown state against the
 * `order` process's live trade list on construction, so a `strategies` process
 * restart does not fire a duplicate entry order against a position `order`
 * still holds (see reconcileOrderState() in BuySellStrategy.ts).
 *
 * Follows continuousStrategyTest.ts's pattern of monkey-patching
 * (OrderClient as any).instance with a MockOrderClient instead of a live
 * `order` process/IPC/broker.
 *
 * Run: npm run build (compile), then: MOCK_BROKER=true node ./dist/test/buySellStrategyReconciliation.test.js
 */

import { NiftyQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import BuySellStrategy from '../strategy/BuySellStrategy';

// --- Mock OrderClient ---

class MockOrderClient {
    buyContractCalls: any[] = [];
    sellContractCalls: any[] = [];

    // What stats() returns - set per-test before constructing the strategy.
    statsTrades: any[] = [];

    private tokenCounter = 0;

    async calculateRight(_userId: string, _ltp?: number): Promise<string> {
        return 'call';
    }

    async getContractByPriceRange(_userId: string, right: string): Promise<string> {
        this.tokenCounter += 1;
        return `NIFTY-${right === 'call' ? 'CE' : 'PE'}-${24000 + this.tokenCounter}`;
    }

    async buyContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        this.buyContractCalls.push({ userId, contract, quantity, price });
        this.tokenCounter += 1;
        return { contract, price: price ?? 100, qty: quantity, token: 'TOKEN_' + this.tokenCounter };
    }

    async sellContract(userId: string, contract: string, quantity: number, price?: number): Promise<any> {
        this.sellContractCalls.push({ userId, contract, quantity, price });
        return { contract, price: price ?? 100, qty: quantity, token: 'SELL_TOKEN' };
    }

    async stats(_userId = 'Default'): Promise<{ trades: any[]; closedTrades: any[]; userPnL: Record<string, number> }> {
        return { trades: this.statsTrades, closedTrades: [], userPnL: {} };
    }
}

let mock: MockOrderClient;

function installMock() {
    mock = new MockOrderClient();
    (OrderClient as any).instance = mock;
}

// --- Config helper ---

function setConfig(overrides: Record<string, any> = {}) {
    const base = {
        type: 'BuySellStrategy',
        enabled: true,
        right: 'call',
        targetPrice: 10,
        averageThreshold: 5,
        initialQuantity: 65,
        activateIntermittentCount: 3,
        maxIterationCount: 5,
        incrementFactor: 'iteration',
        incrementQuantity: 65,
        logEnabled: false,
    };
    configService.config.strategies = [{ ...base, ...overrides }];
    configService.config.settings = {
        ...(configService.config.settings || {}),
        cooldownSeconds: 0,
        targetPriceDiff: 10,
        stopLossPriceDiff: 10,
        trailingDistance: 5,
    } as any;
}

function mockNiftyQuote(ltp: number): NiftyQuote {
    const q = new NiftyQuote();
    q.ltp = ltp;
    q.token = 'NIFTY';
    return q;
}

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tests ---

async function testDefensiveDefaultOrderedTrueImmediatelyAfterConstruction() {
    console.log('\n--- Test 1: ordered defaults to true immediately after construction (before reconciliation resolves) ---');
    setConfig();
    installMock();
    mock.statsTrades = []; // no open position - but reconciliation has not run yet at this point
    const s = new BuySellStrategy('TestUserFailSafe') as any;

    assert(s.ordered === true, 'ordered is true synchronously right after construction, before the async reconcile resolves');
}

async function testReconciliationFindsExistingOpenTrade() {
    console.log('\n--- Test 2: reconciliation finds an existing open trade for this userId -> ordered stays true, contract rehydrated, no duplicate entry ---');
    setConfig();
    installMock();
    const existingTrade = new Trade();
    existingTrade.tsym = 'NIFTY-CE-24500';
    existingTrade.token = 'EXISTING_TOKEN';
    existingTrade.price = 120;
    existingTrade.quantity = 65;
    existingTrade.user = 'TestUserExisting';
    mock.statsTrades = [existingTrade];

    const s = new BuySellStrategy('TestUserExisting') as any;
    await sleep(20); // let the constructor's fire-and-forget reconcileOrderState() resolve

    assert(s.ordered === true, 'ordered is true after reconciliation finds a matching open trade');
    assert(s.reconciling === false, 'reconciling flag cleared once reconciliation resolves');
    assert(s.contract.contract === 'NIFTY-CE-24500', 'contract symbol rehydrated from the existing trade');
    assert(s.contract.token === 'EXISTING_TOKEN', 'contract token rehydrated from the existing trade');
    assert(s.contract.price === 120, 'contract price rehydrated from the existing trade');
    assert(s.contract.qty === 65, 'contract qty rehydrated from the existing trade');

    // A subsequent qualifying tick must NOT fire a duplicate entry order.
    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 0, 'no duplicate entry order placed for a tick after reconciliation found an existing open trade');
}

async function testReconciliationFindsNoOpenTrade() {
    console.log('\n--- Test 3: reconciliation finds no open trade at all -> ordered becomes false, entries resume normally ---');
    setConfig();
    installMock();
    mock.statsTrades = []; // order process reports no open positions at all

    const s = new BuySellStrategy('TestUserNoTrade') as any;
    await sleep(20);

    assert(s.ordered === false, 'ordered is false after reconciliation finds no matching open trade');

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 1, 'a qualifying tick fires a normal entry once reconciliation clears ordered');
}

async function testReconciliationIgnoresOtherUsersTrades() {
    console.log('\n--- Test 4: an open trade exists, but for a different userId -> ordered becomes false for this instance ---');
    setConfig();
    installMock();
    const otherUsersTrade = new Trade();
    otherUsersTrade.tsym = 'NIFTY-PE-23000';
    otherUsersTrade.token = 'OTHER_TOKEN';
    otherUsersTrade.price = 90;
    otherUsersTrade.quantity = 65;
    otherUsersTrade.user = 'SomeOtherStrategyUserId';
    mock.statsTrades = [otherUsersTrade];

    const s = new BuySellStrategy('TestUserDistinct') as any;
    await sleep(20);

    assert(s.ordered === false, 'ordered is false - the only open trade belongs to a different userId, not this instance');

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.buyContractCalls.length === 1, 'entry fires normally - the other user\'s open trade must not block this instance');
}

// --- Run All Tests ---

async function runAllTests() {
    console.log('=== BuySellStrategy Reconciliation Tests ===\n');

    const tests: Array<[string, () => Promise<void>]> = [
        ['Defensive default ordered=true immediately after construction', testDefensiveDefaultOrderedTrueImmediatelyAfterConstruction],
        ['Reconciliation finds existing open trade', testReconciliationFindsExistingOpenTrade],
        ['Reconciliation finds no open trade', testReconciliationFindsNoOpenTrade],
        ['Reconciliation ignores other users\' trades', testReconciliationIgnoresOtherUsersTrades],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (e: any) {
            console.log(`  ERROR in ${name}:`, e?.message ?? e);
            process.exitCode = 1;
        }
    }

    console.log('\n=== Tests Complete ===');
    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

runAllTests();
