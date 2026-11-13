/**
 * SimpleContinuousStrategy / ScaledHedgedStrategy reconcile of legs sold outside the platform (2026-11-13: kite legs stayed 'open' in the state
 * file although the broker sold them and the sync booked the closes), against a stubbed OrderClient:
 *   - a leg with no open trade is marked closed (ALERT), neutral P&L (realizedPnl untouched), its resting sell record cleared, and it is unwatched
 *   - a partly held leg continues with the held quantity
 *   - a leg still held is kept, every other leg is judged on its own (CE gone, PE held)
 *   - reconcile places nothing; a refused sell ("nothing sellable") for a leg the order side no longer holds closes it, one for a held leg does not
 * Run: npx tsc, then: node ./dist/test/simpleContinuousOutsideClose.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { localDayKey } from '../strategy/dayKey';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let open: any[] = [];
let calls: string[] = [];
let sellError: Error | null = null;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (..._args: any[]) => {
        calls.push(fn);
        if (fn === 'getOpenTrades') return open;
        if (fn === 'getPendingSells') return [];
        if (fn === 'chunkedSquareOffLimit' && sellError) throw sellError;
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;

const leg = (id: string, tsym: string, token: string, right: 'CE' | 'PE') => ({ id, tsym, token, exchange: 'NFO', strike: 25000, right, role: 'root', entry: 250, qty: 650, soldQty: 0, soldValue: 0, hedged: true, doubled: true, status: 'open', sellQty: 650, sellPrice: 260, sellShortfall: 0 });

function make(Cls: any, id: string, legs: any[], realizedPnl = 1234) {
    const s: any = new Cls(id);
    const file = `/tmp/outside-close-test-${id}-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl, profitTripped: false }));
    s.stateFile = () => file;
    s.enabled = false; // a disabled strategy's reconcile still runs
    s.watch = () => {}; s.unwatch = () => {};
    return s;
}

(async () => {
    for (const [name, Cls] of [['SimpleContinuousStrategy', SimpleContinuousStrategy], ['ScaledHedgedStrategy', ScaledHedgedStrategy]] as [string, any][]) {
        console.log(`${name}: both legs sold outside`);
        open = []; calls = [];
        let s = make(Cls, `T-${name}-1`, [leg('L1', 'N25350CE', '45404', 'CE'), leg('L2', 'N25200PE', '45395', 'PE')]);
        await s.reconcile(1, 0);
        assert(Object.values<any>(s.state.legs).every((l) => l.status === 'closed'), 'both legs closed');
        assert(Object.values<any>(s.state.legs).every((l) => l.sellQty === 0), 'resting-sell records cleared');
        assert(s.state.realizedPnl === 1234, 'realizedPnl untouched (neutral: the sync booked the real P&L)');
        assert(JSON.parse(fs.readFileSync(s.stateFile(), 'utf8')).legs.L1.status === 'closed', 'closed state persisted to the file');
        assert(!calls.some((c) => c !== 'getOpenTrades' && c !== 'getPendingSells'), `reconcile placed no order (calls: ${[...new Set(calls)].join(',')})`);

        console.log(`${name}: CE gone, PE partly held (325 of 650)`);
        open = [{ token: '45395', tsym: 'N25200PE', quantity: 325, price: 249 }];
        s = make(Cls, `T-${name}-2`, [leg('L1', 'N25350CE', '45404', 'CE'), leg('L2', 'N25200PE', '45395', 'PE')]);
        await s.reconcile(1, 0);
        assert(s.state.legs.L1.status === 'closed' && s.state.legs.L2.status === 'open', 'CE closed, PE stays open');
        assert(s.state.legs.L2.qty === 325, 'PE continues with the 325 held (sells are sized to it, never 650)');

        console.log(`${name}: a refused sell for a position the order side does not hold closes the leg; for a held one it does not`);
        open = [];
        s = make(Cls, `T-${name}-3`, [{ ...leg('L1', 'N25350CE', '45404', 'CE'), sellQty: 0 }]);
        sellError = new Error('NEVER-SHORT GUARD: nothing sellable for N25350CE (sellable=0) - refusing to sell 650');
        s.ensureLoaded();
        await s.placeSell(s.state.legs.L1);
        assert(s.state.legs.L1.status === 'closed', 'not held + nothing sellable: leg closed, no retry storm');
        open = [{ token: '45404', tsym: 'N25350CE', quantity: 650, price: 250 }];
        s = make(Cls, `T-${name}-4`, [{ ...leg('L1', 'N25350CE', '45404', 'CE'), sellQty: 0 }]);
        s.ensureLoaded();
        await s.placeSell(s.state.legs.L1);
        assert(s.state.legs.L1.status === 'open', 'held + nothing sellable (already rests): leg stays open');
        sellError = null;
    }
    for (const f of fs.readdirSync('/tmp')) if (f.startsWith('outside-close-test-') && f.endsWith(`-${process.pid}.json`)) fs.unlinkSync(`/tmp/${f}`);
    process.exit(process.exitCode ?? 0);
})();
