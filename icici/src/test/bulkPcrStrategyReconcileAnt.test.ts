/**
 * Verifies BulkPcrStrategy.reconcile()'s uniform (broker-agnostic) handling of a
 * slot with no persisted bulkPcrStrategyState record, confirming:
 *  - an ant slot with a live open broker/Mongo position but NO persisted record is
 *    picked up and a protective exit is placed (the live incident 2026-10-21 this
 *    fixes - see ToDo.md).
 *  - both ant legs being naked simultaneously are reconciled independently.
 *  - a persisted 'error' record is left untouched when the broker shows nothing resting
 *    (deliberately manual-review-only), but RECOVERS to 'selling' (exitRejectCount reset)
 *    when the broker confirms its exit sell is actually still resting - the 2026-10-21
 *    "unprotected open position" incident, where the slot was wrongly stuck in 'error'
 *    even though the original resting sell had survived untouched.
 *  - a non-ant (single-sided) broker goes through the exact same code path with no
 *    special-casing, both for "no persisted record" and for a persisted 'done' record.
 *  - an exit sell that already survived at the broker from before a crash is resumed
 *    (watched), not duplicated with a brand-new sell (the 2026-10-21 incident's real
 *    root cause for the "Margin Shortfall" rejection - an oversold duplicate, not a
 *    broker netting bug).
 *
 * No real Mongo/order-process IPC is used: Mongo.getInstance() is left uninitialized
 * (loadState() naturally resolves to no persisted record), OrderClient's
 * getOpenTrades/chunkedSquareOffLimit are monkey-patched directly on the singleton,
 * and marketHours' isPastMarketClose is monkey-patched so the test is deterministic
 * regardless of when it's run.
 *
 * Run: npm run build (compile), then: node ./dist/test/bulkPcrStrategyReconcileAnt.test.js
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

// Always mid-session for this test, regardless of real wall-clock time.
(marketHours as any).isPastMarketClose = () => false;

// NEVER let this test touch the real config.yml on disk. configService is the real
// singleton (same module BulkPcrStrategy.ts imports) tied to the actual project
// config file - durablyDisable() (reached when a mocked scenario closes out every
// configured broker) calls configService.writeConfig(configService.getConfig()),
// which would otherwise overwrite the real config.yml with this test's fake
// single-strategy config (this actually happened once - see ToDo.md/git history
// 2026-10-21 - and required a manual reconstruction + recommit to fix). Hard no-op
// this regardless of what any test scenario's config/state does.
(configService as any).writeConfig = () => {};

function setConfig(userId: string, brokers: string[]) {
    (configService as any).config = {
        settings: {},
        strategies: [
            { type: 'BulkPcrStrategy', userId, enabled: true, brokers, targetPoints: 2, quantity: -1, slDistance: 10, index: 'NIFTY' },
        ],
    };
}

function mockOrderClient(
    openTrades: any[],
    placedSells: { tsym: string; quantity: number; broker: string }[],
    pendingSells: { quantity: number }[] = []
) {
    const client = OrderClient.getInstance() as any;
    client.getOpenTrades = async (_userId: string) => openTrades;
    client.getPendingSells = async (_userId: string, _broker: string, _tsym: string) => pendingSells;
    client.chunkedSquareOffLimit = async (_userId: string, payload: any) => {
        placedSells.push({ tsym: payload.tradingSymbol, quantity: payload.quantity, broker: payload.broker });
        return { soldQty: payload.quantity, soldValue: payload.quantity * payload.price };
    };
}

async function testAntSingleLegWithNoPersistedState() {
    console.log('Test: ant - one naked CE leg, no persisted state, no PE open');
    setConfig('bulkpcr-test-1', ['ant']);
    const placedSells: any[] = [];
    mockOrderClient(
        [{ broker: 'ant', tsym: 'NIFTY27OCT26C23000', token: '51352', price: 166.1, quantity: 585 }],
        placedSells
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-1') as any;
    await strategy.reconcile();

    const callSlot = strategy.positions.get('ant_call');
    const putSlot = strategy.positions.get('ant_put');
    assert(callSlot !== undefined, 'ant_call slot was restored');
    assert(callSlot?.right === 'call', `ant_call slot has right='call' (got ${callSlot?.right})`);
    assert(callSlot?.entryQuantity === 585, `ant_call slot has entryQuantity=585 (got ${callSlot?.entryQuantity})`);
    assert(callSlot?.phase === 'selling', `ant_call slot advanced to 'selling' (got ${callSlot?.phase})`);
    assert(putSlot === undefined, 'ant_put slot stays absent (nothing open on that side)');
    assert(
        placedSells.some((s) => s.tsym === 'NIFTY27OCT26C23000' && s.quantity === 585 && s.broker === 'ant'),
        'a protective exit sell was placed for the restored CE leg'
    );
}

async function testAntBothLegsNakedSimultaneously() {
    console.log('Test: ant - both CE and PE naked at once, no persisted state (the actual incident)');
    setConfig('bulkpcr-test-2', ['ant']);
    const placedSells: any[] = [];
    mockOrderClient(
        [
            { broker: 'ant', tsym: 'NIFTY27OCT26C23000', token: '51352', price: 166.1, quantity: 585 },
            { broker: 'ant', tsym: 'NIFTY27OCT26P22950', token: '51351', price: 154.8, quantity: 585 },
        ],
        placedSells
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-2') as any;
    await strategy.reconcile();

    const callSlot = strategy.positions.get('ant_call');
    const putSlot = strategy.positions.get('ant_put');
    assert(callSlot?.right === 'call' && callSlot?.entryQuantity === 585, 'ant_call independently restored');
    assert(putSlot?.right === 'put' && putSlot?.entryQuantity === 585, 'ant_put independently restored');
    assert(placedSells.length === 2, `both legs got a protective exit placed (got ${placedSells.length})`);
}

async function testAntPersistedErrorStaysUntouched() {
    console.log('Test: ant - persisted \'error\' record is left alone, not auto-reconciled');
    setConfig('bulkpcr-test-3', ['ant']);
    const placedSells: any[] = [];
    mockOrderClient(
        [{ broker: 'ant', tsym: 'NIFTY27OCT26C23000', token: '51352', price: 166.1, quantity: 585 }],
        placedSells
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-3') as any;
    // Simulate a persisted 'error' record by pre-seeding loadState's result.
    strategy.loadState = async () => ({
        userId: 'bulkpcr-test-3',
        positions: {
            ant_call: {
                broker: 'ant', right: 'call', phase: 'error', heldTsym: 'NIFTY27OCT26C23000',
                heldToken: '51352', entryAvg: 166.1, targetQuantity: 585, soldQty: 0, soldValue: 0,
            },
        },
    });

    await strategy.reconcile();

    const callSlot = strategy.positions.get('ant_call');
    assert(callSlot?.phase === 'error', `ant_call stays 'error' (got ${callSlot?.phase})`);
    assert(placedSells.length === 0, 'no exit sell was placed for the error-phase slot');
}

async function testAntPersistedErrorRecoversWhenSellStillResting() {
    console.log('Test: ant - persisted \'error\' record recovers when the broker still shows the exit sell resting');
    setConfig('bulkpcr-test-3b', ['ant']);
    const placedSells: any[] = [];
    mockOrderClient(
        [{ broker: 'ant', tsym: 'NIFTY27OCT26C23000', token: '51352', price: 166.1, quantity: 585 }],
        placedSells,
        [{ quantity: 585 }] // the original exit sell never actually went away - only a duplicate attempt was rejected
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-3b') as any;
    strategy.loadState = async () => ({
        userId: 'bulkpcr-test-3b',
        positions: {
            ant_call: {
                broker: 'ant', right: 'call', phase: 'error', heldTsym: 'NIFTY27OCT26C23000',
                heldToken: '51352', entryAvg: 166.1, targetQuantity: 585, soldQty: 0, soldValue: 0,
                exitRejectCount: 6, exitLastRejectAt: Date.now() - 60_000,
            },
        },
    });

    await strategy.reconcile();

    const callSlot = strategy.positions.get('ant_call');
    assert(callSlot?.phase === 'selling', `ant_call recovered to 'selling' (got ${callSlot?.phase})`);
    assert(callSlot?.targetQuantity === 585, `ant_call targetQuantity reflects the confirmed resting qty (got ${callSlot?.targetQuantity})`);
    assert(callSlot?.exitRejectCount === 0, `ant_call exitRejectCount reset to 0 (got ${callSlot?.exitRejectCount})`);
    assert(callSlot?.exitLastRejectAt === undefined, `ant_call exitLastRejectAt cleared (got ${callSlot?.exitLastRejectAt})`);
    assert(placedSells.length === 0, 'no duplicate exit sell was placed - the already-resting one was recognized instead');
}

async function testNonAntSingleSidedNoPersistedState() {
    console.log('Test: non-ant (breeze) - single slot, no persisted state, one open trade');
    setConfig('bulkpcr-test-4', ['breeze']);
    const placedSells: any[] = [];
    mockOrderClient(
        [{ broker: 'breeze', tsym: 'NIFTY27OCT26C23000', token: '12345', price: 150, quantity: 1300 }],
        placedSells
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-4') as any;
    await strategy.reconcile();

    // Every broker runs the pair now: the open CE is restored into its own <broker>_call slot.
    const slot = strategy.positions.get('breeze_call');
    assert(slot !== undefined, 'breeze_call slot was restored');
    assert(slot?.right === 'call', `breeze_call slot carries its side (got ${slot?.right})`);
    assert(slot?.entryQuantity === 1300, `breeze_call slot carries the open quantity (got ${slot?.entryQuantity})`);
    assert(slot?.phase === 'selling', `breeze_call slot advanced to 'selling' (got ${slot?.phase})`);
    assert(
        placedSells.some((s) => s.tsym === 'NIFTY27OCT26C23000' && s.quantity === 1300 && s.broker === 'breeze'),
        'a protective exit sell was placed for the restored breeze leg'
    );
}

async function testNonAntPersistedDoneIsRestored() {
    console.log('Test: non-ant (breeze) - persisted \'done\' record is restored as-is, not re-queried');
    setConfig('bulkpcr-test-5', ['breeze']);
    const placedSells: any[] = [];
    // Nothing open at the broker - if the fallback ran instead of the done-restore path,
    // this would correctly find nothing too, so this test specifically checks the slot
    // IS present afterward (today, before the fix, a non-ant 'done' slot was dropped
    // from `positions` entirely rather than restored).
    mockOrderClient([], placedSells);

    const strategy = new BulkPcrStrategy('bulkpcr-test-5') as any;
    strategy.loadState = async () => ({
        userId: 'bulkpcr-test-5',
        positions: {
            breeze_call: {
                broker: 'breeze', right: 'call', phase: 'done', heldTsym: 'NIFTY27OCT26C23000',
                heldToken: '12345', entryAvg: 150, targetQuantity: 1300, soldQty: 1300, soldValue: 195000,
            },
        },
    });

    await strategy.reconcile();

    const slot = strategy.positions.get('breeze_call');
    assert(slot !== undefined, 'breeze_call slot is present after reconcile (restored as-is)');
    assert(slot?.phase === 'done', `breeze_call slot stays 'done' (got ${slot?.phase})`);
    assert(placedSells.length === 0, 'no exit sell was placed for an already-done slot');
}

async function testAntFallbackFindsAlreadyRestingSell() {
    console.log('Test: ant - an exit sell already resting at the broker is watched, not duplicated (2026-10-21 incident)');
    setConfig('bulkpcr-test-6', ['ant']);
    const placedSells: any[] = [];
    mockOrderClient(
        [{ broker: 'ant', tsym: 'NIFTY27OCT26C23000', token: '51352', price: 166.1, quantity: 585 }],
        placedSells,
        [{ quantity: 585 }] // a sell for the full quantity already survived from before the crash
    );

    const strategy = new BulkPcrStrategy('bulkpcr-test-6') as any;
    await strategy.reconcile();

    const callSlot = strategy.positions.get('ant_call');
    assert(callSlot?.phase === 'selling', `ant_call advanced to 'selling' via the already-resting sell (got ${callSlot?.phase})`);
    assert(callSlot?.targetQuantity === 585, `ant_call targetQuantity reflects the already-resting qty (got ${callSlot?.targetQuantity})`);
    assert(placedSells.length === 0, 'no duplicate exit sell was placed (this is the fix - previously this oversold and got a margin-shortfall rejection)');
}

async function main() {
    await testAntSingleLegWithNoPersistedState();
    await testAntBothLegsNakedSimultaneously();
    await testAntPersistedErrorStaysUntouched();
    await testAntPersistedErrorRecoversWhenSellStillResting();
    await testNonAntSingleSidedNoPersistedState();
    await testNonAntPersistedDoneIsRestored();
    await testAntFallbackFindsAlreadyRestingSell();

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
    // configService's real fs.watch() on config.yml (started at module-import time)
    // keeps the event loop alive forever otherwise.
    process.exit(process.exitCode ?? 0);
}

main();
