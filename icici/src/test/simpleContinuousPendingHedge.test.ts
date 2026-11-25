/**
 * SimpleContinuousStrategy: an unconfirmed hedge buy leaves hedged=true with a persisted pendingHedge record (2026-11-25 Breeze L12 / L3: the flag
 * stayed true with no hedge leg). The record is settled against the broker: cancelled with 0 filled -> flag cleared and the hedge retried
 * (hedgeWaiting); filled -> adopted as the hedge child; unreadable -> stays pending. A leg with a live hedge child is untouched; a stale flag with no
 * record (restart) is only reported, never cleared. No buy is placed while a record is pending.
 * Run: npx tsc, then: node ./dist/test/simpleContinuousPendingHedge.test.js
 */
import fs from 'fs';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import { localDayKey } from '../strategy/dayKey';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const leg = (id: string, right: 'CE' | 'PE', token: string, extra: any = {}) => ({ id, tsym: `N${token}${right}`, token, exchange: 'NFO', strike: 25950, right, role: 'root', entry: 264.8, qty: 195, soldQty: 0, soldValue: 0, hedged: true, status: 'open', sellQty: 195, sellPrice: 274.8, ...extra });
const pend = { tsym: 'NPE', token: '9', exchange: 'NFO', strike: 25950, right: 'PE', premium: 221, qty: 195, same: false, at: 1 };

function make(id: string, legs: any[], res: any) {
    const s: any = new SimpleContinuousStrategy(id);
    const file = `/tmp/pending-hedge-test-${id}-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl: 0, profitTripped: false }));
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {};
    s.resolveCalls = 0;
    s.resolveUnconfirmedBuy = async () => { s.resolveCalls++; return res; };
    s.placeSell = async () => {};
    s.ensureLoaded();
    return s;
}

(async () => {
    console.log('pending hedge, broker says nothing bought: flag cleared, hedge retried via hedgeWaiting, record gone');
    let s = make('A', [leg('L12', 'CE', '1', { pendingHedge: pend })], { kind: 'none' });
    assert(s.buysBlocked(), 'buys blocked while the record is pending');
    await s.settlePendingHedges(true);
    let l = s.state.legs.L12;
    assert(l.hedged === false && l.hedgeWaiting === true && l.pendingHedge === undefined, 'hedged false, hedgeWaiting true, record cleared');
    assert(!s.buysBlocked(), 'buys no longer blocked');
    assert(JSON.parse(fs.readFileSync(s.stateFile(), 'utf8')).legs.L12.hedged === false, 'persisted');

    console.log('settled through a manual-review reset');
    s = make('B', [leg('L12', 'CE', '1', { pendingHedge: pend })], { kind: 'none' });
    s.manualReview = true;
    s.reset();
    await new Promise((r) => setTimeout(r, 20));
    l = s.state.legs.L12;
    assert(s.manualReview === false && l.hedged === false && l.hedgeWaiting === true, 'reset clears the latch and the stale flag is cleared for the retry');

    console.log('pending hedge, broker holds it: adopted as the hedge child, flag stays true');
    s = make('C', [leg('L12', 'CE', '1', { pendingHedge: pend })], { kind: 'filled', qty: 195, price: 221 });
    await s.settlePendingHedges(true);
    const child = Object.values<any>(s.state.legs).find((x) => x.parentId === 'L12');
    assert(!!child && child.tsym === 'NPE' && child.qty === 195 && s.state.legs.L12.hedged === true && !s.state.legs.L12.pendingHedge, 'child adopted, parent stays hedged, record cleared');

    console.log('broker unreadable: stays pending, nothing cleared, no buy');
    s = make('D', [leg('L12', 'CE', '1', { pendingHedge: pend })], { kind: 'unknown', why: 'x' });
    await s.settlePendingHedges(true);
    assert(s.state.legs.L12.hedged === true && !!s.state.legs.L12.pendingHedge && s.buysBlocked(), 'still pending and blocked');
    let bought = 0;
    s.lastNiftyLtp = 25900;
    const orig = (await import('../processes/strategies/OrderClient')).default.getInstance();
    (orig as any).buyContractBare = async () => { bought++; throw new Error('should not buy'); };
    s.state.legs.L12.hedged = false; // even with the flag cleared, a pending record elsewhere blocks any hedge
    s.state.legs.L13 = leg('L13', 'PE', '2', { pendingHedge: pend });
    await s.hedge(s.state.legs.L12, 'adverse move');
    assert(bought === 0, 'no hedge buy while any record is pending');

    console.log('live hedge child: nothing touched, nothing reported as stale');
    s = make('E', [leg('L12', 'CE', '1'), leg('L13', 'PE', '2', { role: 'hedge', parentId: 'L12', hedged: false })], { kind: 'none' });
    await s.settlePendingHedges(true);
    assert(s.resolveCalls === 0 && s.state.legs.L12.hedged === true, 'hedged leg with a child untouched');

    console.log('restart with a stale flag and no record: not cleared (ALERT only)');
    const logs: string[] = [];
    const origLog = Log.log; (Log as any).log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
    s = make('F', [leg('L12', 'CE', '1')], { kind: 'none' });
    s.settlePendingHedges = async () => {};
    const OC: any = (await import('../processes/strategies/OrderClient')).default.getInstance();
    OC.getOpenTrades = async () => [{ token: '1', tsym: 'N1CE', quantity: 195, price: 264.8, action: 'Buy' }];
    OC.getPendingSells = async () => [{ quantity: 195 }];
    s.stateLoaded = true;
    try { await s.reconcile(1, 1); } catch (e) { logs.push('ERR ' + e); }
    (Log as any).log = origLog;
    assert(s.state.legs.L12.hedged === true, 'flag not cleared without evidence');
    assert(logs.some((m) => m.includes('ALERT') && m.includes('marked hedged but has no hedge leg')), 'ALERT names the leg');
    for (const f of fs.readdirSync('/tmp')) if (f.startsWith('pending-hedge-test-') && f.endsWith(`-${process.pid}.json`)) fs.unlinkSync(`/tmp/${f}`);
    process.exit(process.exitCode ?? 0);
})();
