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
    cancelOrderCalls: any[] = [];
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

    async getContractByPriceRangeBare(_userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, index = 'NIFTY', excludeStrikes: number[] = []) {
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

    async buyContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
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

    async sellContractBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade> {
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

    async placeLimitBuyBare(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }> {
        this.limitBuyCalls.push({ userId, tradingSymbol, instrumentToken, quantity, price, exchange });
        return { orderId: 'ORDER_' + this.limitBuyCalls.length };
    }

    async cancelOrderBare(userId: string, orderId: string): Promise<void> {
        this.cancelOrderCalls.push({ userId, orderId });
    }

    async getPCR(userId: string, underlying: string, spot: number, window: number): Promise<number> {
        this.pcrCalls.push({ userId, underlying, spot, window });
        return this.nextPCR;
    }

    async getUserAllottedCapital(_userId: string): Promise<number | undefined> {
        return undefined; // no longer consulted by capitalCheck() (reads maxInvestment from cfg() directly) - kept as a harmless stub
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
        maxInvestment: 10_000_000 as number | undefined, // effectively uncapped by default - tests below tighten it explicitly
        spawnQuantityMode: 2, // flat multiplier - mirrors config.yml's live "double" value
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
    const s = new ContinuousStrategy('TestContinuous') as any;
    s.enabled = true; // ContinuousStrategy.processNiftyQuote's "disabled" gate (added as a
    // diagnostic, keyed off this instance field rather than cfg().enabled) is normally
    // synced by StrategyFactory in production; tests bypass that, so set it directly.
    return s;
}

function legs(strategy: any): Map<string, any> {
    return strategy.legManager.getLegsByToken() as Map<string, any>;
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
    assert(s.legManager.getPendingReEntries().size === 1, 'root refill placed immediately (no nested legs)');
    assert(s.legManager.getDeferredRootRefill() === null, 'no deferred refill');
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
    assert(child.quantity === 65 * 2, 'level-3 spawn quantity = flat 2x multiplier (spawnQuantityMode=2), not level-scaled');
    assert(child.quantity !== 65 * 3, 'must NOT equal the old level-scaled (3x) value - confirms flat-multiplier semantics');
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

async function testNestedLegRefillsWhenParentAlive() {
    console.log('\n--- Test 8: Nested leg hitting target refills while its parent is still alive ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn (adverseMove=10)
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(child.token, 91)); // child target hit (entry 80 + D 10 = 90)

    assert(s.legManager.getPendingReEntries().size === 1, 'nested leg refill placed while its parent (root) is still alive');
    assert(mock.limitBuyCalls.length === 1 && mock.limitBuyCalls[0].price === 80, 'limit re-entry at the nested leg\'s original entry price');
    const pending = s.legManager.getPendingReEntries().get(child.token);
    assert(pending.isRoot === false, 'pending refill records nested identity');
    assert(pending.parentLegId === root.legId && pending.parentLevel === 1, 'pending refill records its parent leg/level');
    assert(!root.childByLevel.has(1), 'level 1 slot freed immediately on the child\'s close');
}

async function testNestedLegBlockedWhenParentClosed() {
    console.log('\n--- Test 8b: Nested leg does NOT refill once its parent has closed ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, D=10
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn; child now open
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(root.token, 100)); // root 5x's (adverseMove=50, level 5) - gone for good
    assert(!legs(s).has(root.token), 'root closed via 5x');
    assert(legs(s).has(child.token), 'nested child still open after its parent closed');

    await s.processOptionQuote(mockOptionQuote(child.token, 91)); // child's own target hit (entry 80 + D 10 = 90)

    assert(s.legManager.getPendingReEntries().size === 0, 'no refill placed - parent (root) is no longer alive');
}

async function testNestedCapitalBlockedRefillSkippedOutright() {
    console.log('\n--- Test 8c: Nested refill skipped outright (no retry) when capital-blocked ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 80;
    mock.nextEntryPrice = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn; child now open
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    setConfig({ maxInvestment: 1 }); // tighten the cap so any nonzero refill is blocked

    await s.processOptionQuote(mockOptionQuote(child.token, 91)); // child target hit -> refill capital-blocked

    assert(s.legManager.getPendingReEntries().size === 0, 'nested refill skipped outright - not placed');
    assert(s.legManager.getDeferredRootRefill() === null, 'no defer/retry state created for a nested refill');
    assert(mock.limitBuyCalls.length === 0, 'placeLimitBuyBare never called for the blocked nested refill');
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

    assert(s.legManager.getDeferredRootRefill() !== null, 'root refill deferred while nested leg open');
    assert(s.legManager.getPendingReEntries().size === 0, 'no limit order placed yet');
    assert(mock.limitBuyCalls.length === 0, 'placeLimitBuyBare not called yet');

    // Now close the nested child (5x, for variety)
    await s.processOptionQuote(mockOptionQuote(child.token, 30)); // entry 80, D 10 -> 5x threshold = 30

    assert(s.legManager.getDeferredRootRefill() === null, 'deferred refill cleared');
    assert(s.legManager.getPendingReEntries().size === 1, 'deferred refill promoted into a pending re-entry');
    assert(mock.limitBuyCalls.length === 1 && mock.limitBuyCalls[0].price === 150, 'limit order placed at original root entry price');
}

async function testCapitalCapBlocksSpawnUntilFreed() {
    console.log('\n--- Test 10: Capital cap blocks a spawn until capital frees up ---');
    setConfig({ maxInvestment: 65 * 150 }); // exactly T1's own investment, no headroom
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
    configService.config.strategies[0].maxInvestment = 10_000_000;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // retry same tick condition

    assert(legs(s).size === 2, 'spawn succeeds once capital is available');
}

async function testSpawnQuantityModeExplicitOne() {
    console.log('\n--- Test 11: spawnQuantityMode=1 - flat 1x regardless of level ---');
    setConfig({ spawnQuantityMode: 1 });
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);

    mock.nextPremium = 60;
    mock.nextEntryPrice = 60;
    await s.processOptionQuote(mockOptionQuote(root.token, 105)); // adverseMove=45, level=4

    const child = legByLegId(s, root.childByLevel.get(4));
    assert(child.quantity === 65, 'level-4 spawn quantity = 1x parent (spawnQuantityMode=1), not 4x level-scaled');
}

async function testSpawnQuantityModeFallback() {
    console.log('\n--- Test 11b: spawnQuantityMode falls back to a flat 1x when unset, zero, negative, or non-numeric ---');
    for (const badValue of [undefined, 0, -2, 'not-a-number', NaN]) {
        setConfig({ spawnQuantityMode: badValue });
        installMock();
        const s = newStrategy();
        const root = await enterT1(s, 150);

        mock.nextPremium = 80;
        mock.nextEntryPrice = 80;
        await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn

        const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);
        assert(child.quantity === 65, `spawnQuantityMode=${JSON.stringify(badValue)} falls back to 1x (65), got ${child?.quantity}`);
    }
}

async function testSpawnQuantityReadsCurrentTotalQuantity() {
    console.log('\n--- Test 11c: hedge spawn sizes off totalQuantity (post-averaging), not original quantity ---');
    setConfig({ spawnQuantityMode: 2 });
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, qty=65, D=10

    mock.nextPremium = 130;
    mock.nextEntryPrice = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1: spawn (totalQuantity=65 at spawn time) + average -> totalQuantity=130
    assert(root.totalQuantity === 130, 'root grew to 130 via the level-1 average-add');

    mock.nextPremium = 110;
    mock.nextEntryPrice = 110;
    await s.processOptionQuote(mockOptionQuote(root.token, 125)); // adverseMove=25 -> level 2, root.totalQuantity is now 130

    const level2Child = legByLegId(s, root.childByLevel.get(2));
    assert(level2Child.quantity === 260, `level-2 spawn = 2x root's CURRENT totalQuantity (130), i.e. 260 - got ${level2Child?.quantity}`);
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
    s.legManager.getPendingReEntries().set('TOKEN_X', {
        token: 'TOKEN_X', tsym: 'NIFTY-CE-24500', exchange: 'NFO', strike: 24500,
        right: 'call', quantity: 65, limitPrice: 150, orderId: 'ORDER_X',
        isRoot: true, parentLegId: null, parentLevel: null,
    });

    await s.updateTrade(buyTrade('NIFTY-CE-24500', 'TOKEN_X', 152, 65));

    assert(s.legManager.getPendingReEntries().size === 0, 'pending re-entry cleared');
    assert(legs(s).size === 1, 'new leg opened');
    const leg = legs(s).get('TOKEN_X');
    assert(leg.isRoot === true, 'resolved leg is root');
    assert(leg.entryPrice === 152, 'resolved leg uses the fill price');
}

async function testUpdateTradeReoccupiesParentSlotForNestedRefill() {
    console.log('\n--- Test 15b: updateTrade reoccupies the parent slot when a nested refill fills ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 130;
    mock.nextEntryPrice = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn; child now open
    const child = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(child.token, 141)); // child target hit (entry 130 + D 10 = 140) -> refill pending
    assert(s.legManager.getPendingReEntries().size === 1, 'nested refill pending');
    assert(!root.childByLevel.has(1), 'level 1 slot freed on the child\'s close');

    await s.updateTrade(buyTrade(child.tsym, child.token, 132, 65)); // fill echo for the pending refill

    assert(s.legManager.getPendingReEntries().size === 0, 'pending refill resolved');
    const newLeg = legs(s).get(child.token);
    assert(newLeg !== undefined, 'new leg opened for the filled nested refill');
    assert(newLeg.isRoot === false, 'new leg keeps nested identity');
    assert(newLeg.parentLegId === root.legId && newLeg.parentLevel === 1, 'new leg references the correct parent leg/level');
    assert(root.childByLevel.get(1) === newLeg.legId, 'parent slot reoccupied by the new leg');
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

async function testAutoResolveRightFromPcr() {
    console.log('\n--- Test 18: right: none auto-resolves direction from PCR alone ---');

    setConfig({ right: 'none' });
    installMock();
    mock.nextPCR = 0.5; // < 1 favors CALL
    let s = newStrategy();
    const quote = mockNiftyQuote(24500);
    assert(quote.prevClose == null, 'prevClose left unset - direction must not depend on it');
    await s.processNiftyQuote(quote);
    assert(s.ordered === true, 'T1 fires on auto-resolve (PCR < 1)');
    assert(mock.contractLookupCalls[0]?.optionType === 'CE', 'PCR < 1 auto-resolves to CALL');

    setConfig({ right: 'none' });
    installMock();
    mock.nextPCR = 2; // > 1 favors PUT
    s = newStrategy();
    await s.processNiftyQuote(mockNiftyQuote(24500));
    assert(s.ordered === true, 'T1 fires on auto-resolve (PCR > 1)');
    assert(mock.contractLookupCalls[0]?.optionType === 'PE', 'PCR > 1 auto-resolves to PUT');
}

async function testAveragingLowersTargetAndExitsEarly() {
    console.log('\n--- Test 19: averaging (in addition to hedge spawn) lowers target to avg+1 ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, qty=65, D=10 -> original target=160

    mock.nextEntryPrice = 130; // fill price for both the hedge spawn's buy and the average-add
    mock.nextPremium = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // adverseMove=10, level=1

    assert(root.averagedLevels.has(1), 'level 1 average recorded on the root leg');
    assert(root.totalQuantity === 130, 'totalQuantity grew by the averaged-in qty (65+65)');
    assert(Math.abs(root.avgPrice - 140) < 1e-9, 'avgPrice is the weighted average of 150 and 130');
    assert(legs(s).size === 2, 'hedge spawn still happened alongside averaging (root + 1 nested child)');
    assert(root.quantity === 65 && root.entryPrice === 150, 'quantity/entryPrice stay original - unaffected by averaging (hedge sizing must be unchanged)');

    // New target is avg+1=141 - well below the original entry+D=160 target, and still
    // below the original entry price of 150.
    await s.processOptionQuote(mockOptionQuote(root.token, 141));
    assert(!legs(s).has(root.token), 'root exits at avg+1, without ever reaching the original entry+D target');
    const lastSell = mock.sellContractCalls[mock.sellContractCalls.length - 1];
    assert(lastSell.quantity === 130, 'sells the full averaged quantity (130), not just the original 65');
}

async function testRootRefillDriftCancelsPastThreshold() {
    console.log('\n--- Test 20: Root refill cancelled once LTP drifts past refillCancelDistance ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    await s.processOptionQuote(mockOptionQuote(root.token, 161)); // target hit -> refill placed at 150
    assert(s.legManager.getPendingReEntries().size === 1, 'root refill pending');

    await s.processOptionQuote(mockOptionQuote(root.token, 150 + 51)); // 51 > default 50-pt cancelDistance

    assert(mock.cancelOrderCalls.length === 1 && mock.cancelOrderCalls[0].orderId === 'ORDER_1', 'cancelOrderBare called for the pending order');
    assert(s.legManager.getPendingReEntries().size === 0, 'pending re-entry dropped, no re-place at a new price');
}

async function testRootRefillNoCancelAtBoundary() {
    console.log('\n--- Test 21: Root refill NOT cancelled at exactly the boundary distance ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    await s.processOptionQuote(mockOptionQuote(root.token, 161)); // target hit -> refill placed at 150

    await s.processOptionQuote(mockOptionQuote(root.token, 150 + 50)); // exactly the default cancelDistance

    assert(mock.cancelOrderCalls.length === 0, 'no cancel call at the boundary');
    assert(s.legManager.getPendingReEntries().size === 1, 'order still resting');
}

async function testLateFillEchoAfterCancelIsNoOp() {
    console.log('\n--- Test 22: A late fill echo after cancellation does not resurrect a leg ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    const cancelledToken = root.token;
    await s.processOptionQuote(mockOptionQuote(cancelledToken, 161)); // target hit -> refill placed at 150
    await s.processOptionQuote(mockOptionQuote(cancelledToken, 150 + 51)); // drift-cancel
    assert(s.legManager.getPendingReEntries().size === 0, 'pending re-entry dropped by the cancel');

    await s.updateTrade(buyTrade('NIFTY-CE-24500', cancelledToken, 150, 65)); // late echo of the now-cancelled order

    assert(legs(s).size === 0, 'no leg resurrected from the post-cancel fill echo');
}

async function testDeeperLevelCancelsShallowerPendingRefills() {
    console.log('\n--- Test 23: A deeper level spawn cancels a shallower pending refill under the same leg ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, D=10
    mock.nextPremium = 130;
    mock.nextEntryPrice = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1: spawn L1 (entry=130) + average (root target -> 141)
    const l1 = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(l1.token, 141)); // L1 target hit (entry 130 + D 10 = 140) -> refill pending
    assert(s.legManager.getPendingReEntries().size === 1, 'L1 refill pending');
    const cancelsBefore = mock.cancelOrderCalls.length;

    mock.nextPremium = 110;
    mock.nextEntryPrice = 110;
    await s.processOptionQuote(mockOptionQuote(root.token, 125)); // adverseMove=25 -> level 2 (125 < root's target 141, no premature target-hit)

    assert(mock.cancelOrderCalls.length === cancelsBefore + 1, 'L1\'s pending refill cancelled once level 2 fires');
    assert(s.legManager.getPendingReEntries().size === 0, 'no pending refills remain after cancellation');
    assert(root.childByLevel.has(2), 'level 2 spawned');
    assert(legs(s).size === 2, 'root + new level-2 child open (L1 already closed, not live)');
}

async function testSameLevelRecrossCancelsAndRespawns() {
    console.log('\n--- Test 24: Re-crossing the same level cancels a stale pending refill and respawns ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150);
    mock.nextPremium = 130;
    mock.nextEntryPrice = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn + average; L1 open
    const l1 = Array.from(legs(s).values()).find((l: any) => !l.isRoot);
    const firstL1LegId = l1.legId;

    await s.processOptionQuote(mockOptionQuote(l1.token, 141)); // L1 target hit -> refill pending, slot 1 freed
    assert(s.legManager.getPendingReEntries().size === 1, 'L1 refill pending');
    assert(!root.childByLevel.has(1), 'level 1 slot freed on L1\'s close');

    // Root ticks at level 1's range again - slot is free, already averaged at level 1
    // (so only the spawn path runs, not another average-add) - target stays at 141.
    mock.nextPremium = 132;
    mock.nextEntryPrice = 132;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 again

    assert(mock.cancelOrderCalls.length === 1, 'stale L1 pending refill cancelled on re-crossing level 1');
    assert(s.legManager.getPendingReEntries().size === 0, 'no pending refills remain');
    assert(root.childByLevel.has(1), 'level 1 respawned');
    const newL1LegId = root.childByLevel.get(1);
    assert(newL1LegId !== firstL1LegId, 'fresh spawn has a new legId, not the old L1');
}

async function test5xCancelsChildPendingRefills() {
    console.log('\n--- Test 25: A leg\'s 5x square-off cancels its own children\'s pending refills ---');
    setConfig();
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, D=10
    mock.nextPremium = 130;
    mock.nextEntryPrice = 130;
    await s.processOptionQuote(mockOptionQuote(root.token, 140)); // level 1 spawn + average; L1 open
    const l1 = Array.from(legs(s).values()).find((l: any) => !l.isRoot);

    await s.processOptionQuote(mockOptionQuote(l1.token, 141)); // L1 target hit -> refill pending
    assert(s.legManager.getPendingReEntries().size === 1, 'L1 refill pending');

    await s.processOptionQuote(mockOptionQuote(root.token, 100)); // root 5x's (adverseMove=50, level 5) - gone for good

    assert(!legs(s).has(root.token), 'root closed via 5x');
    assert(s.legManager.getPendingReEntries().size === 0, 'L1\'s pending refill cancelled when root 5x\'d');
    assert(mock.cancelOrderCalls.length === 1, 'cancelOrderBare called for L1\'s pending refill');
}

async function testHedgeStartLevelDelaysHedgeSpawn() {
    console.log('\n--- Test 30: hedgeStartLevel delays the hedge spawn but not averaging ---');
    setConfig({ hedgeStartLevel: 2 });
    installMock();
    const s = newStrategy();
    const root = await enterT1(s, 150); // entry=150, qty=65, D=10

    mock.nextEntryPrice = 140;
    mock.nextPremium = 140;
    await s.processOptionQuote(mockOptionQuote(root.token, 135)); // adverseMove=15, level=1 (< hedgeStartLevel=2)

    assert(legs(s).size === 1, 'level 1 (below hedgeStartLevel) does not spawn a hedge leg');
    assert(root.averagedLevels.has(1), 'level 1 still averages into the root leg (unconditional, unlike the hedge spawn)');
    assert(root.totalQuantity === 130, `averaging raised totalQuantity to 130 (got ${root.totalQuantity})`);
    assert(Math.abs(root.avgPrice - 145) < 1e-9, `averaging lowered avgPrice to the weighted average of 150 and 140 (got ${root.avgPrice})`);

    mock.nextEntryPrice = 80;
    mock.nextPremium = 80;
    await s.processOptionQuote(mockOptionQuote(root.token, 125)); // adverseMove=25, level=2 (>= hedgeStartLevel)

    assert(legs(s).size === 2, 'level 2 (at hedgeStartLevel) spawns a hedge leg');
    assert(root.childByLevel.has(2), 'level 2 hedge slot occupied');
    assert(root.averagedLevels.has(2), 'level 2 also averages into the root leg, same as any level');
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
        ['Nested leg refills when parent alive', testNestedLegRefillsWhenParentAlive],
        ['Nested leg blocked when parent closed', testNestedLegBlockedWhenParentClosed],
        ['Nested capital-blocked refill skipped outright', testNestedCapitalBlockedRefillSkippedOutright],
        ['Deferred root refill promotes', testDeferredRootRefillPromotesWhenNestedClears],
        ['Capital cap blocks then frees', testCapitalCapBlocksSpawnUntilFreed],
        ['spawnQuantityMode explicit 1x (not level-scaled)', testSpawnQuantityModeExplicitOne],
        ['spawnQuantityMode fallback to 1x on invalid config', testSpawnQuantityModeFallback],
        ['spawnQuantityMode reads current totalQuantity, not original quantity', testSpawnQuantityReadsCurrentTotalQuantity],
        ['5x closes only this leg', testFiveXClosesOnlyThisLeg],
        ['Concurrent ticks spawn once', testConcurrentTicksSpawnOnce],
        ['updateTrade ignores unmatched fill', testUpdateTradeIgnoresUnmatchedFill],
        ['updateTrade resolves pending root refill', testUpdateTradeResolvesPendingRootRefill],
        ['updateTrade reoccupies parent slot for nested refill', testUpdateTradeReoccupiesParentSlotForNestedRefill],
        ['PCR mismatch blocks T1, realigns after window', testPcrMismatchBlocksT1ThenRealignsAfterWindow],
        ['PCR fetch failure fails closed', testPcrFetchFailureBlocksT1],
        ['right: none auto-resolves from PCR', testAutoResolveRightFromPcr],
        ['Averaging lowers target and exits early', testAveragingLowersTargetAndExitsEarly],
        ['Root refill drift-cancels past threshold', testRootRefillDriftCancelsPastThreshold],
        ['Root refill does not cancel at boundary', testRootRefillNoCancelAtBoundary],
        ['Late fill echo after cancel is a no-op', testLateFillEchoAfterCancelIsNoOp],
        ['Deeper level cancels shallower pending refills', testDeeperLevelCancelsShallowerPendingRefills],
        ['Same-level re-cross cancels and respawns', testSameLevelRecrossCancelsAndRespawns],
        ['5x cancels child pending refills', test5xCancelsChildPendingRefills],
        ['hedgeStartLevel delays the hedge spawn but not averaging', testHedgeStartLevelDelaysHedgeSpawn],
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
