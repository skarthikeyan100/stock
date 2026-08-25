/**
 * Mock-based tests for ContinuousStrategy, following strategyTest.ts's
 * hand-rolled assert()/mock-quote style, but monkey-patching
 * (OrderClient as any).instance (the strategies process's only broker path
 * now - see OrderClient.ts) instead of Monitor.
 *
 * Run: npm run build (compile), then: MOCK_BROKER=true node ./dist/test/continuousStrategyTest.js
 */

import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import ContinuousStrategy from '../strategy/ContinuousStrategy';

// --- Mock OrderClient ---

class MockOrderClient {
    buyContractCalls: any[] = [];
    sellContractCalls: any[] = [];
    limitBuyCalls: any[] = [];
    contractLookupCalls: any[] = [];

    right = 'call';
    nextPremium = 150;
    nextEntryPrice: number | null = null; // defaults to nextPremium when null
    nextExitPrice = 200;
    nextPCR = 0.5; // < 1 favors CALL - matches the default fixed config right of 'call'
    pcrCalls: any[] = [];

    private strikeCounter = 24000;
    private tokenCounter = 0;

    async calculateRight(_userId: string, _ltp?: number): Promise<string> {
        return this.right;
    }

    async getContractByPriceRangeZerodha(_userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, index = 'NIFTY', excludeStrikes: number[] = []) {
        this.contractLookupCalls.push({ underlyingLtp, optionType, minPremium, index, excludeStrikes });
        this.strikeCounter += 50;
        const strike = this.strikeCounter;
        this.tokenCounter += 1;
        return {
            tradingSymbol: `NIFTY-${optionType}-${strike}`,
            instrumentToken: 9000 + this.tokenCounter,
            // Deliberately a different range than instrumentToken - Zerodha and ANT
            // number contracts independently in reality (see ContinuousStrategy.ts's
            // T1-entry comment); this catches a regression to reading instrumentToken
            // instead of antToken for a leg's tick-subscription token.
            antToken: String(5000 + this.tokenCounter),
            lotSize: 65,
            exchange: 'NFO' as const,
            strike,
            premium: this.nextPremium,
        };
    }

    async buyContractZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
        this.buyContractCalls.push({ userId, tradingSymbol, instrumentToken, quantity, exchange });
        const trade = new Trade();
        trade.tsym = tradingSymbol;
        trade.token = String(instrumentToken);
        trade.quantity = quantity;
        trade.price = this.nextEntryPrice ?? this.nextPremium;
        trade.lastTradePrice = trade.price;
        trade.action = 'Buy';
        trade.status = 'COMPLETE';
        trade.user = userId;
        return trade;
    }

    async sellContractZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
        this.sellContractCalls.push({ userId, tradingSymbol, instrumentToken, quantity, exchange });
        const trade = new Trade();
        trade.tsym = tradingSymbol;
        trade.token = String(instrumentToken);
        trade.quantity = quantity;
        trade.price = this.nextExitPrice;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        return trade;
    }

    async placeLimitBuyZerodhaBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }> {
        this.limitBuyCalls.push({ userId, tradingSymbol, instrumentToken, quantity, price, exchange });
        return { orderId: 'ORDER_' + this.limitBuyCalls.length };
    }

    async getPCR(userId: string, underlying: string, spot: number, window: number): Promise<number> {
        this.pcrCalls.push({ userId, underlying, spot, window });
        return this.nextPCR;
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
        type: 'ContinuousStrategy',
        enabled: true,
        initialQuantity: 65,
        slDistance: 10,
        minPremium: 100,
        allottedCapital: undefined as number | undefined,
        spawnQuantityMode: 'multiplied',
        right: 'call',
        cooldownSeconds: 0,
        logEnabled: false,
    };
    configService.config.strategies = [{ ...base, ...overrides }];
}

// --- Test helpers ---

function mockNiftyQuote(ltp: number): NiftyQuote {
    const q = new NiftyQuote();
    q.ltp = ltp;
    q.token = 'NIFTY';
    q.buyQty = 5000;
    q.sellQty = 4000;
    return q;
}

function mockOptionQuote(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.ltp = ltp;
    q.token = token;
    return q;
}

function buyTrade(tsym: string, token: string, price: number, quantity: number): Trade {
    const t = new Trade();
    t.tsym = tsym;
    t.token = token;
    t.price = price;
    t.quantity = quantity;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'TestContinuous';
    return t;
}

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function newStrategy(): any {
    return new ContinuousStrategy('TestContinuous') as any;
}

function legs(strategy: any): Map<string, any> {
    return strategy.legsByToken as Map<string, any>;
}

function legByLegId(strategy: any, legId: string): any {
    for (const leg of legs(strategy).values()) if (leg.legId === legId) return leg;
    return undefined;
}

// --- Tests ---

async function testNoLegsCannotHandleQuote() {
    console.log('\n--- Test 1: No legs open -> canHandleOptionQuote is false ---');
    setConfig();
    installMock();
    const s = newStrategy();
    assert(s.canHandleOptionQuote(mockOptionQuote('ANY_TOKEN', 100)) === false, 'canHandleOptionQuote false with no legs');
}

async function testResetClearsState() {
    console.log('\n--- Test 2: reset() clears all legs and re-arms ---');
    setConfig();
    installMock();
    const s = newStrategy();
    legs(s).set('T1', { legId: 'x', token: 'T1', isRoot: true, childByLevel: new Map() });
    s.ordered = true;
    s.reset();
    assert(legs(s).size === 0, 'legsByToken cleared');
    assert(s.ordered === false, 'ordered reset to false');
}

async function testT1Entry() {
    console.log('\n--- Test 3: T1 entry opens a tracked root leg ---');
    setConfig();
    installMock();
    mock.nextPremium = 150;
    mock.nextEntryPrice = 150;
    const s = newStrategy();

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(s.ordered === true, 'ordered set true');
    assert(legs(s).size === 1, 'one leg tracked');
    const leg = Array.from(legs(s).values())[0];
    assert(leg.isRoot === true, 'T1 leg is root');
    assert(leg.entryPrice === 150, 'T1 entry price recorded');
    assert(leg.quantity === 65, 'T1 quantity matches initialQuantity');
}

async function enterT1(s: any, entryPrice = 150): Promise<any> {
    mock.nextPremium = entryPrice;
    mock.nextEntryPrice = entryPrice;
    await s.processNiftyQuote(mockNiftyQuote(24500));
    return Array.from(legs(s).values()).find((l: any) => l.isRoot);
}

async function testRootTargetHitImmediateRefill() {
    console.log('\n--- Test 4: Root target hit (no nested legs) refills immediately ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);

    await s.processOptionQuote(mockOptionQuote(root.token, 161)); // >= 150 + 10

    assert(legs(s).size === 0, 'root leg removed on target hit');
    assert(s.pendingReEntries.size === 1, 'root refill placed immediately (no nested legs)');
    assert(s.deferredRootRefill === null, 'no deferred refill');
    assert(mock.limitBuyCalls.length === 1 && mock.limitBuyCalls[0].price === 150, 'limit re-entry placed at original entry price');
}

async function testGappedTickFiresDeepestFreeLevelOnly() {
    console.log('\n--- Test 5: Gapped tick fires only the deepest free level ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);

    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 115)); // adverseMove=35, level=3

    assert(legs(s).size === 2, 'one spawn created (root + child)');
    assert(root.childByLevel.has(3) && !root.childByLevel.has(1) && !root.childByLevel.has(2), 'only level 3 slot occupied');
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);
    assert(child.quantity === 65 * 3, 'level-3 spawn quantity = 3x parent (multiplied mode)');
}

async function testOccupiedLevelDoesNotRefire() {
    console.log('\n--- Test 6: Occupied level does not re-fire ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 115)); // fires level 3
    const buysAfterFirstSpawn = mock.buyContractCalls.length;

    await s.processOptionQuote(mockOptionQuote(root.token, 115)); // same level, still occupied

    assert(legs(s).size === 2, 'no additional leg created');
    assert(mock.buyContractCalls.length === buysAfterFirstSpawn, 'no additional buy call');
}

async function testSlotReArmsAfterChildCloses() {
    console.log('\n--- Test 7: Slot re-arms once its child closes ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 115)); // level 3 spawn
    const firstChild = Array.from(legs(s).values()).find((l: any) => !l.isRoot);
    const firstChildLegId = firstChild.legId;

    // Close the child via its own target hit (nested leg, entry=80, D=10 -> target=90)
    await s.processOptionQuote(mockOptionQuote(firstChild.token, 95));

    assert(!root.childByLevel.has(3), 'level 3 slot freed after child closed');
    assert(legs(s).size === 1, 'only root remains after child closed');

    // Re-fire the same level on the root
    mock.nextPremium = 82;
    mock.nextEntryPrice = 82;
    await s.processOptionQuote(mockOptionQuote(root.token, 115));

    assert(legs(s).size === 2, 'level 3 spawned again after slot freed');
    const secondChildLegId = root.childByLevel.get(3);
    assert(secondChildLegId !== firstChildLegId, 'new spawn has a new legId');
}

async function testNestedLegNeverRefills() {
    console.log('\n--- Test 8: Nested leg hitting target never creates a refill ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn (adverseMove=10)
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(child.token, 91)); // child target hit (entry 80 + D 10 = 90)

    assert(s.pendingReEntries.size === 0, 'no pending re-entry from a nested leg target hit');
    assert(s.deferredRootRefill === null, 'no deferred refill from a nested leg target hit');
}

async function testDeferredRootRefillPromotesWhenNestedClears() {
    console.log('\n--- Test 9: Deferred root refill promotes once nested legs clear ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn, nested leg now open
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    // Root hits its own target while the nested child is still open
    await s.processOptionQuote(mockOptionQuote(root.token, 161));

    assert(s.deferredRootRefill !== null, 'root refill deferred while nested leg open');
    assert(s.pendingReEntries.size === 0, 'no limit order placed yet');
    assert(mock.limitBuyCalls.length === 0, 'placeLimitBuyZerodhaBare not called yet');

    // Now close the nested child (5x, for variety)
    await s.processOptionQuote(mockOptionQuote(child.token, 30)); // entry 80, D 10 -> 5x threshold = 30

    assert(s.deferredRootRefill === null, 'deferred refill cleared');
    assert(s.pendingReEntries.size === 1, 'deferred refill promoted into a pending re-entry');
    assert(mock.limitBuyCalls.length === 1 && mock.limitBuyCalls[0].price === 150, 'limit order placed at original root entry price');
}

async function testCapitalCapBlocksSpawnUntilFreed() {
    console.log('\n--- Test 10: Capital cap blocks a spawn until capital frees up ---');
    setConfig({ allottedCapital: 65 * 150 }); // exactly T1's own investment, no headroom
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    const buysBeforeAttempt = mock.buyContractCalls.length;

    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 - should be blocked

    assert(legs(s).size === 1, 'spawn blocked by capital cap');
    assert(!root.childByLevel.has(1), 'level 1 slot left free after capital block');
    assert(mock.buyContractCalls.length === buysBeforeAttempt, 'no buy order placed while blocked');

    // Capital frees up
    configService.config.strategies[0].allottedCapital = 10_000_000;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // retry same tick condition

    assert(legs(s).size === 2, 'spawn succeeds once capital is available');
}

async function testQuantityModeSame() {
    console.log('\n--- Test 11: spawnQuantityMode "same" ---');
    setConfig({ spawnQuantityMode: 'same' });
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);

    mock.nextPremium = 60;
    mock.nextEntryPrice = 60;
    await s.processOptionQuote(mockOptionQuote(root.token, 105)); // adverseMove=45, level=4

    const child = legByLegId(s, root.childByLevel.get(4));
    assert(child.quantity === 65, 'level-4 spawn uses same quantity as parent, not 4x');
}

async function testFiveXClosesOnlyThisLeg() {
    console.log('\n--- Test 12: 5x squares off only this leg ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(root.token, 95)); // root 5x: 150 - 5*10 = 100

    assert(!legs(s).has(root.token), 'root leg closed');
    assert(legs(s).has(child.token), 'child leg remains open, untouched');
    assert(legs(s).get(child.token).status === 'OPEN', 'child leg still OPEN');
}

async function testConcurrentTicksSpawnOnce() {
    console.log('\n--- Test 13: Concurrent unawaited ticks spawn only once ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);

    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    const quote = mockOptionQuote(root.token, 140); // level 1
    const p1 = s.processOptionQuote(quote);
    const p2 = s.processOptionQuote(quote);
    await Promise.all([p1, p2]);

    assert(legs(s).size === 2, 'exactly one spawn from two concurrent ticks');
}

async function testUpdateTradeIgnoresUnmatchedFill() {
    console.log('\n--- Test 14: updateTrade ignores an unmatched Buy fill ---');
    setConfig();
    installMock();
    const s = newStrategy();

    await s.updateTrade(buyTrade('NIFTY-CE-24500', 'SOME_TOKEN', 150, 65));

    assert(legs(s).size === 0, 'no leg created for an unmatched fill');
}

async function testUpdateTradeResolvesPendingRootRefill() {
    console.log('\n--- Test 15: updateTrade resolves a pending root refill ---');
    setConfig();
    installMock();
    const s = newStrategy();
    s.pendingReEntries.set('TOKEN_X', {
        token: 'TOKEN_X', tsym: 'NIFTY-CE-24500', exchange: 'NFO', strike: 24500,
        right: 'call', quantity: 65, limitPrice: 150,
    });

    await s.updateTrade(buyTrade('NIFTY-CE-24500', 'TOKEN_X', 152, 65));

    assert(s.pendingReEntries.size === 0, 'pending re-entry cleared');
    assert(legs(s).size === 1, 'new leg opened');
    const leg = legs(s).get('TOKEN_X');
    assert(leg.isRoot === true, 'resolved leg is root');
    assert(leg.entryPrice === 152, 'resolved leg uses the fill price');
}

async function testPcrMismatchBlocksT1ThenRealignsAfterWindow() {
    console.log('\n--- Test 16: PCR mismatch blocks T1, realigns after 5-min window ---');
    setConfig(); // right: 'call' (fixed)
    installMock();
    mock.nextPCR = 2; // > 1 favors PUT - mismatches the configured 'call' direction
    const s = newStrategy();

    await s.processNiftyQuote(mockNiftyQuote(24500));
    assert(s.ordered === false, 'T1 not fired on PCR mismatch');
    assert(legs(s).size === 0, 'no leg opened on PCR mismatch');
    assert(mock.pcrCalls.length === 1, 'PCR fetched once on first tick');

    await s.processNiftyQuote(mockNiftyQuote(24500)); // immediate re-tick, still within throttle window
    assert(mock.pcrCalls.length === 1, 'PCR not re-fetched before the 5-min window elapses');
    assert(s.ordered === false, 'still not fired, within throttle window');

    // Simulate 5 minutes elapsing, then correct the PCR to align with 'call'.
    (s as any).lastPcrCheckTime = Date.now() - 5 * 60 * 1000 - 1;
    mock.nextPCR = 0.5; // now favors CALL - aligned
    mock.nextEntryPrice = 150;
    mock.nextPremium = 150;
    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(mock.pcrCalls.length === 2, 'PCR re-fetched after the 5-min window');
    assert(s.ordered === true, 'T1 fires once PCR realigns');
    assert(legs(s).size === 1, 'root leg opened after realignment');
}

async function testPcrFetchFailureBlocksT1() {
    console.log('\n--- Test 17: PCR fetch failure fails closed (blocks T1) ---');
    setConfig();
    installMock();
    mock.getPCR = async () => { throw new Error('simulated PCR API failure'); };
    const s = newStrategy();

    await s.processNiftyQuote(mockNiftyQuote(24500));

    assert(s.ordered === false, 'T1 not fired when PCR fetch errors');
    assert(legs(s).size === 0, 'no leg opened when PCR fetch errors');
}

// --- Run All Tests ---

async function runAllTests() {
    console.log('=== ContinuousStrategy Tests ===\n');

    const tests: Array<[string, () => Promise<void>]> = [
        ['No legs / canHandleOptionQuote', testNoLegsCannotHandleQuote],
        ['reset()', testResetClearsState],
        ['T1 entry', testT1Entry],
        ['Root target hit, immediate refill', testRootTargetHitImmediateRefill],
        ['Gapped tick, deepest free level only', testGappedTickFiresDeepestFreeLevelOnly],
        ['Occupied level does not re-fire', testOccupiedLevelDoesNotRefire],
        ['Slot re-arms after child closes', testSlotReArmsAfterChildCloses],
        ['Nested leg never refills', testNestedLegNeverRefills],
        ['Deferred root refill promotes', testDeferredRootRefillPromotesWhenNestedClears],
        ['Capital cap blocks then frees', testCapitalCapBlocksSpawnUntilFreed],
        ['spawnQuantityMode same', testQuantityModeSame],
        ['5x closes only this leg', testFiveXClosesOnlyThisLeg],
        ['Concurrent ticks spawn once', testConcurrentTicksSpawnOnce],
        ['updateTrade ignores unmatched fill', testUpdateTradeIgnoresUnmatchedFill],
        ['updateTrade resolves pending root refill', testUpdateTradeResolvesPendingRootRefill],
        ['PCR mismatch blocks T1, realigns after window', testPcrMismatchBlocksT1ThenRealignsAfterWindow],
        ['PCR fetch failure fails closed', testPcrFetchFailureBlocksT1],
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
}

runAllTests();
