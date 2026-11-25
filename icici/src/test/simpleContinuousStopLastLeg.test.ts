/**
 * SimpleContinuousStrategy: a stop-loss close of the LAST leg of the chain must not end the cycle (2026-11-25 Breeze: the leg carried a stale
 * hedged=true with no hedge leg, so after its stop nothing could place an order). With nothing open / waiting / in flight the closed leg is hedged
 * again: a loss buys the opposite right (PE stopped -> CE), a profit the same one. With another leg open nothing extra is placed; a restarted root
 * is left alone; a stopped strategy places nothing.
 * Run: npx tsc, then: node ./dist/test/simpleContinuousStopLastLeg.test.js
 */
import fs from 'fs';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import { localDayKey } from '../strategy/dayKey';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const leg = (id: string, right: 'CE' | 'PE', token: string, extra: any = {}) => ({ id, tsym: `N${token}${right}`, token, exchange: 'NFO', strike: 25750, right, role: 'hedge', entry: 224.75, qty: 195, soldQty: 0, soldValue: 0, hedged: true, status: 'open', sellQty: 0, sellPrice: 0, ...extra });

function make(id: string, legs: any[]) {
    const s: any = new SimpleContinuousStrategy(id);
    const file = `/tmp/stop-last-leg-test-${id}-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl: 0, profitTripped: false }));
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {};
    s.checkMaxProfit = async () => {};
    s.recordOutcome = () => {};
    s.hedgeCalls = [] as any[];
    s.hedge = async (l: any, reason: string, same: boolean) => { s.hedgeCalls.push({ id: l.id, reason, same, hedgedAtCall: l.hedged }); };
    s.ensureLoaded();
    return s;
}
const sell = (token: string, price: number) => Object.assign(new Trade(), { action: 'Sell', token, tsym: `N${token}PE`, quantity: 195, price });

(async () => {
    console.log('last leg (PE) stopped with a stale hedged flag, nothing else open');
    let s = make('A', [leg('L1', 'CE', '1', { role: 'root', status: 'closed', soldQty: 195, soldValue: 1 }), leg('L3', 'PE', '3')]);
    await s.updateTrade(sell('3', 174));
    assert(s.state.legs.L3.status === 'closed', 'leg closed');
    assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].id === 'L3', 'one hedge placed from the stopped leg');
    assert(s.hedgeCalls[0].same === false && s.hedgeCalls[0].hedgedAtCall === false, 'opposite right (PE stopped -> CE), flag cleared first');

    console.log('another leg still open: nothing extra');
    s = make('B', [leg('L2', 'CE', '2'), leg('L3', 'PE', '3')]);
    await s.updateTrade(sell('3', 174));
    assert(s.hedgeCalls.length === 0, 'no hedge call (the open leg continues the chain)');

    console.log('a hedge waiting to be placed: nothing extra');
    s = make('C', [leg('L2', 'CE', '2', { status: 'closed', hedged: false, hedgeWaiting: true }), leg('L3', 'PE', '3')]);
    await s.updateTrade(sell('3', 174));
    assert(s.hedgeCalls.length === 0, 'no extra hedge');

    console.log('a restarted root closing is not hedged');
    s = make('D', [leg('L1', 'PE', '3', { role: 'root', restarted: true })]);
    await s.updateTrade(sell('3', 235));
    assert(s.hedgeCalls.length === 0, 'restarted root: no hedge');

    console.log('a profit close of the stale last leg buys the same right');
    s = make('E', [leg('L3', 'PE', '3')]);
    await s.updateTrade(sell('3', 235));
    assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].same === true, 'same right on a profit');

    console.log('a hedge buy in flight: nothing extra');
    s = make('F', [leg('L3', 'PE', '3')]);
    s.pendingSides.add('CE');
    await s.updateTrade(sell('3', 174));
    assert(s.hedgeCalls.length === 0, 'in flight: no extra hedge');

    for (const f of fs.readdirSync('/tmp')) if (f.startsWith('stop-last-leg-test-') && f.endsWith(`-${process.pid}.json`)) fs.unlinkSync(`/tmp/${f}`);
    process.exit(process.exitCode ?? 0);
})();
