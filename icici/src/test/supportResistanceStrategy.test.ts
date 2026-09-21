/**
 * Mock-based tests for SupportResistanceStrategy's self-monitored,
 * dynamic-breach-detector entry model (rewritten 2026-09-11 - the strategy
 * used to fire off static config.supportPrice/resistancePrice and delegate
 * exit entirely to a broker GTT; it now fires off the dynamic support/
 * resistance breach detector (src/lib/supportResistance.ts), gated by the
 * held-duration filter, and self-manages every leg via LegManager, shared
 * with ContinuousStrategy). Follows continuousStrategyTest.ts's hand-rolled
 * assert()/mock-quote style.
 *
 * Run: npm run build (compile), then: node ./dist/test/supportResistanceStrategy.test.js
 */

import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import SupportResistanceStrategy from '../strategy/SupportResistanceStrategy';
import { CALL } from '../constants';

// --- Mock OrderClient (trimmed continuousStrategyTest.ts's MockOrderClient -
// SupportResistanceStrategy never calls calculateRight/getPCR) ---

class MockOrderClient {
    buyContractCalls: any[] = [];
    sellContractCalls: any[] = [];
    limitBuyCalls: any[] = [];
    cancelOrderCalls: any[] = [];
    contractLookupCalls: any[] = [];

    nextPremium = 150;
    nextEntryPrice: number | null = null; // defaults to nextPremium when null
    nextExitPrice = 200;

    private strikeCounter = 24000;
    private tokenCounter = 0;

    async getContractByPriceRangeBare(_userId: string, underlyingLtp: number, optionType: 'CE' | 'PE', minPremium: number, index = 'NIFTY', excludeStrikes: number[] = []) {
        this.contractLookupCalls.push({ underlyingLtp, optionType, minPremium, index, excludeStrikes });
        this.strikeCounter += 50;
        const strike = this.strikeCounter;
        this.tokenCounter += 1;
        return {
            tradingSymbol: `NIFTY-${optionType}-${strike}`,
            instrumentToken: 9000 + this.tokenCounter,
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

    async getUserAllottedCapital(_userId: string): Promise<number | undefined> {
        return undefined;
    }
}

let mock: MockOrderClient;

function installMock() {
    mock = new MockOrderClient();
    (OrderClient as any).instance = mock;
}

// --- Config helper ---
// Real config.yml srHypothesis defaults (confirmWindowMin=3 -> 180000ms,
// breachConfirmSec=15 -> 15000ms, heldMinSec=407/heldMaxSec=651) are reused
// as-is - since ticks carry synthetic `ltt` timestamps the test controls
// directly (no real wall-clock waiting), any window size runs instantly.

const SR_HYPOTHESIS = {
    confirmWindowMin: 3, maxJump: 15, maxRangeWidth: 25, buffer: 8,
    target: 8, stopLoss: 15, breachBuffer: 5, breachConfirmSec: 15,
    heldMinSec: 407, heldMaxSec: 651, csvOutput: false,
};
const CONFIRM_WINDOW_MS = SR_HYPOTHESIS.confirmWindowMin * 60_000; // 180000
const BREACH_CONFIRM_MS = SR_HYPOTHESIS.breachConfirmSec * 1000; // 15000

function setConfig(overrides: Record<string, any> = {}) {
    const base = {
        type: 'SupportResistanceStrategy',
        enabled: true,
        quantity: 65,
        minPremium: 50,
        maxInvestment: 10_000_000 as number | undefined,
        slDistance: 10,
        squareOffDistance: 100,
        maxLevels: 4,
        spawnQuantityMode: '1',
        averageQuantityMode: 'same',
        postAverageTargetDistance: 1,
        refillCancelDistance: 50,
        cooldownSeconds: 0,
        logEnabled: false,
    };
    configService.config.strategies = [{ ...base, ...overrides }];
    (configService.config as any).srHypothesis = { ...SR_HYPOTHESIS };
}

// --- Test helpers ---

function niftyTick(ltp: number, ltt: number): NiftyQuote {
    const q = new NiftyQuote();
    q.ltp = ltp;
    q.ltt = ltt;
    q.token = 'NIFTY';
    return q;
}

function mockOptionQuote(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.ltp = ltp;
    q.token = token;
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

function newStrategy(): any {
    return new SupportResistanceStrategy('TestSupportResistance') as any;
}

function legs(strategy: any): Map<string, any> {
    return strategy.legManager.getLegsByToken() as Map<string, any>;
}

// Feeds a LOCK-then-confirmed-resistance-breach tick sequence starting at
// `baseTime`, with a controllable held duration (lockedAt to the confirming
// breach tick). The seed tick uses a price far from any plausible prior tick
// (base+1000) so the detector's maxJump check always forces a fresh SEEKING
// buffer, regardless of internal state left over from an earlier breach's
// auto-reseed - makes each call self-contained/composable. Returns the ltt of
// the confirming (final) tick, so callers can chain a second breach after it
// with a safely-later baseTime.
async function feedResistanceBreach(s: any, heldMs: number, baseTime: number, basePrice = 24000): Promise<number> {
    const seedPrice = basePrice + 1000; // forces a maxJump-triggered buffer reset regardless of prior state
    await s.processNiftyQuote(niftyTick(seedPrice, baseTime));
    // Must land exactly on the window boundary (not +epsilon): processTick's
    // cutoff filter drops the seed tick once the gap exceeds confirmWindowMs,
    // so overshooting even slightly breaks the two-tick LOCK.
    const lockedAt = baseTime + CONFIRM_WINDOW_MS;
    await s.processNiftyQuote(niftyTick(seedPrice + 10, lockedAt)); // spans window, range=10<=25 -> LOCKED (resistance = seedPrice+10+8)
    const resistance = seedPrice + 10 + 8;
    const breachPrice = resistance + 100; // safely above resistance+breachBuffer(5)
    const breachStart = lockedAt + Math.max(0, heldMs - BREACH_CONFIRM_MS);
    await s.processNiftyQuote(niftyTick(breachPrice, breachStart)); // pending breach starts
    const confirmAt = breachStart + BREACH_CONFIRM_MS;
    await s.processNiftyQuote(niftyTick(breachPrice, confirmAt)); // still above threshold -> BREACH confirmed, heldMs = confirmAt - lockedAt
    return confirmAt;
}

// --- Tests ---

async function testNoLegsCannotHandleQuote() {
    console.log('\n--- Test 1: No legs open -> canHandleOptionQuote is false ---');
    setConfig();
    installMock();
    const s = newStrategy();
    assert(s.canHandleOptionQuote(mockOptionQuote('ANY_TOKEN', 100)) === false, 'canHandleOptionQuote false with no legs');
}

async function testHeldConfirmedBreachOpensLeg() {
    console.log('\n--- Test 2: Held-duration-confirmed resistance breach opens a CALL leg ---');
    setConfig();
    installMock();
    mock.nextPremium = 150;
    mock.nextEntryPrice = 150;
    const s = newStrategy();

    await feedResistanceBreach(s, 465_000, 0); // within [407s, 651s]

    assert(legs(s).size === 1, 'one leg opened on a held-confirmed breach');
    const leg = Array.from(legs(s).values())[0];
    assert(leg.right === CALL, 'resistance breach opens a CALL leg');
    assert(leg.isRoot === true, 'opened leg is root');
    assert(leg.entryPrice === 150, 'entry price recorded from the fill');
    assert(mock.contractLookupCalls.length === 1, 'contract resolved exactly once');
}

async function testHeldTooShortDoesNotOpen() {
    console.log('\n--- Test 3: A breach held too briefly (below heldMinSec) does not open a leg ---');
    setConfig();
    installMock();
    const s = newStrategy();

    await feedResistanceBreach(s, 16_000, 0); // well below 407s

    assert(legs(s).size === 0, 'no leg opened - held duration outside the confirmed window');
    assert(mock.buyContractCalls.length === 0, 'no buy attempted');
}

async function testHeldTooLongDoesNotOpen() {
    console.log('\n--- Test 4: A breach held too long (above heldMaxSec) does not open a leg ---');
    setConfig();
    installMock();
    const s = newStrategy();

    await feedResistanceBreach(s, 700_000, 0); // above 651s

    assert(legs(s).size === 0, 'no leg opened - held duration exceeds the confirmed window');
}

async function testHasOpenLegOfRightBlocksSecondEntry() {
    console.log('\n--- Test 5: A second same-side breach does not open a duplicate leg while one is already open ---');
    setConfig();
    installMock();
    mock.nextPremium = 150;
    mock.nextEntryPrice = 150;
    const s = newStrategy();

    const firstConfirmAt = await feedResistanceBreach(s, 465_000, 0);
    assert(legs(s).size === 1, 'first breach opens a leg');
    const buysAfterFirst = mock.buyContractCalls.length;

    // A second, independent held-confirmed breach (own fresh LOCK/BREACH
    // cycle, well after the first) should still be blocked from opening a
    // second CALL leg by hasOpenLegOfRight - isolates that gate from the
    // held-duration gate, since this second breach is itself held-confirmed.
    await feedResistanceBreach(s, 465_000, firstConfirmAt + 1000, 25000);

    assert(legs(s).size === 1, 'still only one leg open - second same-side entry blocked');
    assert(mock.buyContractCalls.length === buysAfterFirst, 'no additional buy for the blocked second entry');
}

async function testCombinedMaxProfitAcrossBothSides() {
    console.log('\n--- Test 6: maxProfit is a single combined latch across CE and PE legs ---');
    setConfig({ maxProfit: 2, maxInvestment: 20_000 });
    installMock();
    mock.nextPremium = 150;
    mock.nextEntryPrice = 150;
    const s = newStrategy();

    await feedResistanceBreach(s, 465_000, 0); // opens a CALL leg
    assert(legs(s).size === 1, 'CALL leg opened');

    // A large unrealized gain on the open CALL leg (via a big option-tick
    // move) should trip the combined maxProfit latch and close every leg,
    // regardless of side - single LegManager instance covers both.
    const leg = Array.from(legs(s).values())[0];
    await s.processOptionQuote(mockOptionQuote(leg.token, 5000));

    assert(s.legManager.isMaxProfitTripped() === true, 'maxProfit latch tripped from the single combined LegManager instance');
    assert(legs(s).size === 0, 'leg closed by the maxProfit trip');
}

// --- Run All Tests ---

async function runAllTests() {
    console.log('=== SupportResistanceStrategy Tests ===\n');

    const tests: Array<[string, () => Promise<void>]> = [
        ['No legs / canHandleOptionQuote', testNoLegsCannotHandleQuote],
        ['Held-confirmed breach opens a leg', testHeldConfirmedBreachOpensLeg],
        ['Held too short does not open', testHeldTooShortDoesNotOpen],
        ['Held too long does not open', testHeldTooLongDoesNotOpen],
        ['hasOpenLegOfRight blocks a second same-side entry', testHasOpenLegOfRightBlocksSecondEntry],
        ['maxProfit is a combined latch across both sides', testCombinedMaxProfitAcrossBothSides],
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
