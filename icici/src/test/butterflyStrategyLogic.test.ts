/**
 * Verifies ButterflyStrategy's pure combo logic: standard vs reverse mode assigns
 * BUY/SELL sides to the correct leg roles, buyRoles()/sellRoles() derive from that
 * assignment correctly, and netComboPoints() sums BUY/SELL leg contributions with the
 * right sign and returns null when any open leg is missing a live ltp.
 * Run: npm run build (compile), then: node ./dist/test/butterflyStrategyLogic.test.js
 */

import ButterflyStrategy from '../strategy/ButterflyStrategy';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function emptyLeg(strategy: any, role: string, right: 'CE' | 'PE', side: 'BUY' | 'SELL', strike: number, quantity: number) {
    return strategy.emptyLeg(role, right, side, strike, quantity);
}

function makePosition(strategy: any, mode: 'standard' | 'reverse', quantity = 65) {
    const atmStrike = 24000;
    const wingOffset = 100;
    return {
        broker: 'zerodha',
        phase: 'open',
        index: 'NIFTY',
        mode,
        quantity,
        atmStrike,
        entryCycleStartedAt: Date.now(),
        legs: {
            wingLower: emptyLeg(strategy, 'wingLower', 'PE', mode === 'standard' ? 'BUY' : 'SELL', atmStrike - wingOffset, quantity),
            wingUpper: emptyLeg(strategy, 'wingUpper', 'CE', mode === 'standard' ? 'BUY' : 'SELL', atmStrike + wingOffset, quantity),
            centerCall: emptyLeg(strategy, 'centerCall', 'CE', mode === 'standard' ? 'SELL' : 'BUY', atmStrike, quantity),
            centerPut: emptyLeg(strategy, 'centerPut', 'PE', mode === 'standard' ? 'SELL' : 'BUY', atmStrike, quantity),
        },
    };
}

async function main() {
    const strategy: any = new (ButterflyStrategy as any)('ButterflyLogicTestUser');

    // --- standard mode: wings BUY, center SELL (net credit) ---
    const standardPos = makePosition(strategy, 'standard');
    assert(strategy.buyRoles(standardPos).sort().join(',') === 'wingLower,wingUpper', `standard mode: wings are BUY (got ${strategy.buyRoles(standardPos)})`);
    assert(strategy.sellRoles(standardPos).sort().join(',') === 'centerCall,centerPut', `standard mode: center is SELL (got ${strategy.sellRoles(standardPos)})`);

    // --- reverse mode: wings SELL, center BUY (net debit) ---
    const reversePos = makePosition(strategy, 'reverse');
    assert(strategy.sellRoles(reversePos).sort().join(',') === 'wingLower,wingUpper', `reverse mode: wings are SELL (got ${strategy.sellRoles(reversePos)})`);
    assert(strategy.buyRoles(reversePos).sort().join(',') === 'centerCall,centerPut', `reverse mode: center is BUY (got ${strategy.buyRoles(reversePos)})`);

    // --- netComboPoints: null when any open leg has no live ltp yet ---
    const pos = makePosition(strategy, 'standard');
    for (const role of ['wingLower', 'wingUpper', 'centerCall', 'centerPut']) {
        pos.legs[role].token = `tok-${role}`;
        pos.legs[role].status = 'open';
        pos.legs[role].filledQty = 65;
        pos.legs[role].entryAvg = 50;
    }
    assert(strategy.netComboPoints(pos) === null, 'netComboPoints returns null when no leg has a live ltp yet');

    // --- netComboPoints: BUY leg profits when ltp rises, SELL leg profits when ltp falls ---
    strategy.latestLtp.set('tok-wingLower', 55); // BUY PE wing, entry 50 -> ltp 55: +5*65
    strategy.latestLtp.set('tok-wingUpper', 45); // BUY CE wing, entry 50 -> ltp 45: -5*65
    strategy.latestLtp.set('tok-centerCall', 40); // SELL CE center, entry 50 -> ltp 40: +10*65
    strategy.latestLtp.set('tok-centerPut', 60); // SELL PE center, entry 50 -> ltp 60: -10*65
    // total points = (5*65 - 5*65 + 10*65 - 10*65) / 65 = 0
    const net = strategy.netComboPoints(pos);
    assert(net === 0, `netComboPoints sums BUY(ltp-entry)+SELL(entry-ltp) correctly across 4 legs (got ${net})`);

    // --- netComboPoints: a closed leg is excluded from the sum ---
    pos.legs.wingLower.status = 'closed';
    const netAfterClose = strategy.netComboPoints(pos);
    // removing wingLower's +5*65 contribution from the 0 total leaves -5*65/65 = -5
    assert(netAfterClose === -5, `netComboPoints excludes closed legs from the sum (got ${netAfterClose})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
