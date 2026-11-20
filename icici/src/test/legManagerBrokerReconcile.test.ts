/**
 * LegManager.reconcileLegsWithBroker: a leg whose lots were sold by hand at the broker (never booked: kiteExecutor 'not placed by this platform')
 * is closed neutral / shrunk BEFORE it feeds a max-profit total or a sell (live 2026-11-20 11:16:34: stale 195 CE leg inside cumulative=4036,
 * then a refused-sell loop). Nothing is ever sold, no P&L booked, a leg another strategy shares is not touched.
 * Run: node ./dist/test/legManagerBrokerReconcile.test.js
 */
import { LegManager } from '../strategy/LegManager';
import OrderClient from '../processes/strategies/OrderClient';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const leg = (token: string, tsym: string, qty: number, avg: number, ltp: number) => ({ legId: `L${token}`, token, tsym, strike: 25500, exchange: 'NFO' as const, right: 'CALL', entryPrice: avg, quantity: qty, isRoot: true,
    parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN' as const, avgPrice: avg, totalQuantity: qty, averagedLevels: new Set<number>(), lastLtp: ltp, legRef: `R${token}` });

let now = 10_000_000;
function make(broker: string, maxProfit = 4000) {
    const sells: string[] = []; const outcomes: number[] = [];
    const ops: any = { async sell(_u: string, tsym: string, _t: string, qty: number) { sells.push(tsym); return { avgPrice: 100, quantity: qty }; } };
    const lm: any = new LegManager({ userId: 'ContinuousStrategy', ownerType: 'TestOwner', strategyRef: {} as any, getBroker: () => broker,
        getConfig: () => ({ maxInvestment: 100000, maxProfit: String(maxProfit / 1000) + '%' }) as any, getLastUnderlyingLtp: () => 25000, recordOutcome: (_o: string, p: number) => outcomes.push(p), ops } as any);
    return { lm, sells, outcomes };
}
// A leg that has been the same size for 2 minutes.
async function settle(lm: any, token: string) { await lm.onOptionTick(token, lm.getLegsByToken().get(token)?.lastLtp ?? 100); now += 120_000; }

async function main() {
    const lines: string[] = [];
    const origLog = Log.log; (Log as any).log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
    const origNow = Date.now; Date.now = () => now;
    const oc: any = OrderClient.getInstance();
    const realSleep = global.setTimeout;
    (global as any).setTimeout = (fn: any, _ms?: number, ...r: any[]) => realSleep(fn, 0, ...r); // skip the 3 s confirmation wait
    try {
        // 1. The 2026-11-20 case: broker flat, no other holder. Stale CE leg (195 @114.77, ltp 116.7) inside a total that crosses max-profit.
        let live = 0; let reads = 0; let byUser: Record<string, number> = { ContinuousStrategy: 195 };
        oc.getContractHolders = async () => { reads++; return { live, byUser }; };
        let { lm, sells, outcomes } = make('kite');
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 116.7));
        lm.getLegsByToken().set('2', leg('2', 'PE', 65, 100, 100));
        await settle(lm, '1'); await settle(lm, '2');
        lm.realizedPnL = 3900; // 3900 realized + (116.7-114.77)*195 = +376 -> 4276 >= 4000 with the stale leg
        lm.lastVerifyAt = 0;
        oc.getContractHolders = async (_u: string, _b: string, tsym: string) => { reads++; return tsym === 'CE' ? { live: 0, byUser } : { live: 65, byUser: { ContinuousStrategy: 65 } }; };
        await lm.onOptionTick('2', 100);
        assert(!lm.getLegsByToken().has('1') && lm.getLegsByToken().has('2'), 'a leg the broker no longer holds is closed neutral; the held leg stays');
        assert(sells.length === 0 && outcomes.length === 0, 'nothing sold, no P&L booked');
        assert(lines.some((l) => l.includes('closing the leg neutral')), 'ALERT logged');
        assert(!lm.isMaxProfitTripped(), 'max-profit did NOT trip on the stale leg (total is 3900 without it)');

        // 2. A trip on a total that includes a stale leg: the verification runs first and the corrected total decides.
        ({ lm, sells, outcomes } = make('kite')); lines.length = 0; reads = 0;
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 116.7));
        oc.getContractHolders = async () => { reads++; return { live: 0, byUser: { ContinuousStrategy: 195 } }; };
        await settle(lm, '1'); lm.realizedPnL = 3900; lm.lastVerifyAt = 0;
        await lm.onOptionTick('1', 116.7);
        assert(reads >= 2 && !lm.getLegsByToken().has('1') && sells.length === 0, 'the trip candidate forced a broker read, the stale leg went, nothing sold');
        assert(!lm.isMaxProfitTripped(), 'no trip: 3900 < 4000 once the stale leg is gone');

        // 3. The same total with a leg the broker really holds: the trip is only delayed by the read and the latch is set.
        ({ lm, sells, outcomes } = make('kite')); lines.length = 0;
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 116.7));
        oc.getContractHolders = async () => ({ live: 195, byUser: { ContinuousStrategy: 195 } });
        await settle(lm, '1'); lm.realizedPnL = 3900; lm.lastVerifyAt = 0;
        await lm.onOptionTick('1', 116.7);
        assert(lm.isMaxProfitTripped() && sells.includes('CE'), 'a genuinely held leg: max-profit latches and the leg is sold');

        // 4. Partial external sell, nobody else on the contract: shrunk to the broker's quantity, nothing booked.
        ({ lm, sells, outcomes } = make('kite')); lines.length = 0;
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        oc.getContractHolders = async () => ({ live: 65, byUser: { ContinuousStrategy: 195 } });
        await settle(lm, '1'); lm.lastVerifyAt = 0;
        await lm.onOptionTick('1', 110);
        assert(lm.getLegsByToken().get('1')?.totalQuantity === 65 && outcomes.length === 0 && sells.length === 0, 'leg shrunk 195 -> 65, no P&L booked, nothing sold');

        // 5. Another strategy shares the contract: a partial shortfall is only alerted, the leg is untouched.
        ({ lm, sells, outcomes } = make('kite')); lines.length = 0;
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        oc.getContractHolders = async () => ({ live: 100, byUser: { ContinuousStrategy: 195, SimpleContinuousStrategy: 975 } });
        await settle(lm, '1'); lm.lastVerifyAt = 0;
        await lm.onOptionTick('1', 110);
        assert(lm.getLegsByToken().get('1')?.totalQuantity === 195, 'shared contract, broker holds some: leg not changed');
        assert(lines.some((l) => l.includes('cannot be told')), 'ALERT says whose lots cannot be told');
        // ...but when the broker is flat every holder's lots are gone: closed neutral even with other strategies on the contract.
        oc.getContractHolders = async () => ({ live: 0, byUser: { ContinuousStrategy: 195, SimpleContinuousStrategy: 975 } });
        lm.lastVerifyAt = 0; await lm.onOptionTick('1', 110);
        assert(!lm.getLegsByToken().has('1'), 'broker flat: closed neutral although another strategy is on the contract');

        // 6. Unreadable broker: nothing changes. A fresh leg (< 60 s): nothing changes. ANT is checked; breeze is not (reads flat on a bad session).
        ({ lm, sells, outcomes } = make('kite'));
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        oc.getContractHolders = async () => { throw new Error('session expired'); };
        await settle(lm, '1'); lm.lastVerifyAt = 0; await lm.onOptionTick('1', 110);
        assert(lm.getLegsByToken().has('1'), 'unreadable broker: leg kept (never closed on a guess)');
        ({ lm } = make('kite'));
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        oc.getContractHolders = async () => ({ live: 0, byUser: {} });
        await lm.onOptionTick('1', 110); now += 5_000; await lm.onOptionTick('1', 110);
        assert(lm.getLegsByToken().has('1'), 'a leg younger than the fill grace is not touched');
        ({ lm } = make('breeze'));
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        await settle(lm, '1'); await lm.onOptionTick('1', 110);
        assert(lm.getLegsByToken().has('1'), 'breeze: no proactive check');

        // 7. Rate limit: ticks inside the 30 s window do not read the broker again.
        ({ lm } = make('kite')); reads = 0;
        lm.getLegsByToken().set('1', leg('1', 'CE', 195, 114.77, 110));
        oc.getContractHolders = async () => { reads++; return { live: 195, byUser: { ContinuousStrategy: 195 } }; };
        await settle(lm, '1');
        for (let i = 0; i < 50; i++) { now += 100; await lm.onOptionTick('1', 110); }
        assert(reads <= 2, `50 ticks within 5 s cause at most 2 broker reads (${reads})`);
    } finally {
        Date.now = origNow; (global as any).setTimeout = realSleep; (Log as any).log = origLog;
    }
    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
