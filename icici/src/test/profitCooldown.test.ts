/**
 * profitCooldownSeconds (LegManager): a max-profit trip is released after the cooldown once flat, the profit target restarts from the
 * release point (no instant re-trip), and 0 keeps the lockout for the day.
 * Run: node ./dist/test/profitCooldown.test.js
 */
import { LegManager } from '../strategy/LegManager';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

function make(cfg: any) {
    const lm: any = new LegManager({
        userId: 'T', ownerType: 'TestOwner', strategyRef: {} as any,
        getConfig: () => cfg, getLastUnderlyingLtp: () => 23000, recordOutcome: () => {},
    } as any);
    return lm;
}

async function main() {
    // maxProfit 4% of 100000 = 4000
    const cfg: any = { maxInvestment: 100000, maxProfit: '4%', profitCooldownSeconds: 60 };
    cfg.maxProfit = 4;
    const lm = make(cfg);
    lm.realizedPnL = 4500;
    lm.checkAndMaybeTripMaxProfit(cfg);
    assert(lm.maxProfitTripped === true, 'trips at +4500 (threshold 4000)');
    assert(typeof lm.profitCooldownUntil === 'number', 'a cooldown end is set');

    await lm.maybeReleaseMaxProfit();
    assert(lm.maxProfitTripped === true, 'not released before the cooldown has passed');
    if (lm.profitCooldownTimer) clearTimeout(lm.profitCooldownTimer);

    lm.profitCooldownUntil = Date.now() - 1;
    await lm.maybeReleaseMaxProfit();
    assert(lm.maxProfitTripped === false && lm.profitCooldownUntil === null, 'released once the cooldown passed and the manager is flat');
    assert(lm.maxProfitBaseline === 4500, 'the baseline moves to the realized P&L so far');
    lm.checkAndMaybeTripMaxProfit(cfg);
    assert(lm.maxProfitTripped === false, 'no instant re-trip on the profit that caused the lockout');

    lm.realizedPnL = 8600; // +4100 since the release
    lm.checkAndMaybeTripMaxProfit(cfg);
    assert(lm.maxProfitTripped === true, 'trips again after another +4000 from the release point');
    if (lm.profitCooldownTimer) clearTimeout(lm.profitCooldownTimer);

    const cfg0: any = { maxInvestment: 100000, maxProfit: 4 };
    const lm0 = make(cfg0);
    lm0.realizedPnL = 4500;
    lm0.checkAndMaybeTripMaxProfit(cfg0);
    assert(lm0.maxProfitTripped === true && lm0.profitCooldownUntil === null, 'no profitCooldownSeconds: tripped with no release (locked for the day)');
    await lm0.maybeReleaseMaxProfit();
    assert(lm0.maxProfitTripped === true, 'and it stays tripped');
    process.exit(process.exitCode ?? 0);
}
main();
