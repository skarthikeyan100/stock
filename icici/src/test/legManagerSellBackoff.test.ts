/**
 * LegManager: a sell refused as 'nothing sellable' is never retried in a tight loop (live 2026-11-20 11:16: 65 refusals in 30 s on a leg
 * sold by hand). Back-off between attempts, ONE alert per leg per 10 min, the other legs of the mass close still sold, the max-profit latch
 * kept, and a leg the broker no longer holds closed neutral after the grace; a leg the broker still holds keeps retrying.
 * Run: node ./dist/test/legManagerSellBackoff.test.js
 */
import { LegManager } from '../strategy/LegManager';
import OrderClient from '../processes/strategies/OrderClient';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const leg = (token: string, tsym: string, qty: number) => ({ legId: `L${token}`, token, tsym, strike: 25500, exchange: 'NFO' as const, right: 'CALL', entryPrice: 100, quantity: qty, isRoot: true,
    parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN' as const, avgPrice: 100, totalQuantity: qty, averagedLevels: new Set<number>(), lastLtp: 110 });

async function run(liveQty: number) {
    const sells: string[] = [];
    const outcomes: number[] = [];
    const ops: any = { async sell(_u: string, tsym: string, _t: string, qty: number) {
        sells.push(tsym);
        if (tsym === 'STUCK') throw new Error('squareOffChunked: chunk 1/1 failed after selling 0/195 - Underlying error: NEVER-SHORT GUARD: nothing sellable for STUCK (sellable=0) - refusing to sell 195');
        return { avgPrice: 112, quantity: qty };
    } };
    const lm: any = new LegManager({ userId: 'T', ownerType: 'TestOwner', strategyRef: {} as any, getConfig: () => ({ maxInvestment: 100000 }) as any,
        getLastUnderlyingLtp: () => 25000, recordOutcome: (_o: string, p: number) => outcomes.push(p), ops } as any);
    lm.maxProfitTripped = true;
    lm.getLegsByToken().set('1', leg('1', 'STUCK', 195));
    lm.getLegsByToken().set('2', leg('2', 'GOOD', 390));
    return { lm, sells, outcomes };
}

async function main() {
    const lines: string[] = [];
    const origLog = Log.log;
    (Log as any).log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
    const oc: any = OrderClient.getInstance();
    let now = 1_000_000;
    const origNow = Date.now;
    Date.now = () => now;
    try {
        // Broker holds nothing: back-off, one alert, the GOOD leg sold in the same pass, closed neutral after the grace.
        oc.getLiveQuantity = async () => 0;
        oc.getOpenTrades = async () => [];
        let { lm, sells, outcomes } = await run(0);
        await lm.closeAllLegsAndCancelReEntriesInner();
        assert(sells.filter((s) => s === 'STUCK').length === 1 && sells.includes('GOOD'), 'first pass: stuck leg tried once, the other leg sold in the same pass');
        assert(lm.getLegsByToken().has('1') && !lm.getLegsByToken().has('2'), 'stuck leg stays tracked, sold leg is gone');
        for (let i = 0; i < 20; i++) { now += 200; await lm.closeAllLegsAndCancelReEntriesInner(); }
        assert(sells.filter((s) => s === 'STUCK').length === 1, 'ticks inside the 5 s back-off do not retry the sell');
        assert(lm.isMaxProfitTripped() === true, 'max-profit latch still held');
        now += 6_000; await lm.closeAllLegsAndCancelReEntriesInner();
        assert(sells.filter((s) => s === 'STUCK').length === 2, 'retried after the back-off');
        assert(lines.filter((l) => l.includes('ALERT')).length === 1, 'one ALERT only so far');
        for (let i = 0; i < 6; i++) { now += 61_000; await lm.closeAllLegsAndCancelReEntriesInner(); }
        assert(!lm.getLegsByToken().has('1'), 'broker holds none: the leg is closed after the grace');
        assert(outcomes.length === 1 && outcomes[0] === (112 - 100) * 390, 'only the really sold leg booked P&L (no invented P&L for the stuck leg)');
        assert(lines.some((l) => l.includes('closing the leg neutral')), 'closed-neutral ALERT logged');

        // Broker still holds the lots (resting sells cover them): never closed, keeps retrying with back-off, one alert per 10 min.
        lines.length = 0;
        oc.getLiveQuantity = async () => 195;
        ({ lm, sells } = await run(195));
        for (let i = 0; i < 40; i++) { await lm.closeAllLegsAndCancelReEntriesInner(); now += 61_000; }
        assert(lm.getLegsByToken().has('1'), 'a leg the broker still holds is never closed neutral');
        assert(sells.filter((s) => s === 'STUCK').length === 40, 'retried once per back-off window');
        const alerts = lines.filter((l) => l.includes('ALERT')).length;
        assert(alerts >= 1 && alerts <= 5, `ALERTs are rate-limited (${alerts} in 40 min)`);
    } finally {
        Date.now = origNow;
        (Log as any).log = origLog;
    }
    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
