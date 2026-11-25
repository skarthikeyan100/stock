/**
 * SimpleContinuousStrategy / ScaledHedgedStrategy: the follow-up of a closed leg is never lost (live 2026-11-25 12:48, ScaledHedged PE L25: its resting sell
 * filled, the strategy was told only by the next restart's reconcile, which books the close but places no order, so the leg stayed hedged:false forever).
 *   - reconcile books the platform's own sell of the last leg: hedgeWaiting + hedgeSame are set (persisted), NO order is placed in reconcile
 *   - the tick retry then hedges: a profit close buys the same right, a loss close the opposite right
 *   - a first order that made its target is marked restarted (no same-direction re-buy)
 *   - today's stale state (closed, hedged:false, sold by the platform, nothing waiting) heals at reconcile; an outside close, a partial close, a disabled or
 *     stopped strategy, a leg with a child, an older stale leaf are NOT touched
 *   - ScaledHedged: the last closed leg with a stale hedged:true and nothing open continues the chain (chainDead); with an open leg it does not
 *   - reset() marks never-hedged leaves hedged so a deliberate stop is not revived
 * Run: npx tsc, then: node ./dist/test/chainLostFollowUp.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { localDayKey } from '../strategy/dayKey';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let platformSells: any[] = [];
let openTrades: any[] = [];
const orderCalls: string[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (..._args: any[]) => {
        if (fn === 'getOpenTrades') return openTrades;
        if (fn === 'platformSells') return platformSells;
        if (fn === 'getPendingSells') return [];
        orderCalls.push(fn);
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;

const CE = { id: 'L17', tsym: 'NIFTY26D0125950CE', token: '47893', exchange: 'NFO', strike: 25950, right: 'CE', role: 'root', entry: 265, qty: 130, soldQty: 0, soldValue: 0, hedged: true, status: 'open', sellQty: 0, sellPrice: 0 };
const PE = (id: string, parentId: string, extra: any = {}) => ({ id, tsym: 'NIFTY26D0125950PE', token: '47894', exchange: 'NFO', strike: 25950, right: 'PE', role: 'hedge', parentId, entry: 321, qty: 130, soldQty: 0, soldValue: 0, hedged: false, status: 'open', sellQty: 130, sellPrice: 331, ...extra });
const ceHeld = { tsym: CE.tsym, token: CE.token, quantity: 130, price: 265, originalEntryPrice: 265 };

function make(Cls: any, id: string, legs: any[], extra: any = {}) {
    const s: any = new Cls(id);
    const file = `/tmp/chain-lost-follow-up-${id}-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length + 16, pnlStarted: true, realizedPnl: 0, profitTripped: false, sellIdsTracked: true, seenSells: [], ...extra }));
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {};
    s.checkMaxProfit = async () => {};
    s.recordOutcome = () => {};
    s.enabled = true;
    s.hedgeCalls = [] as any[];
    s.hedge = async (l: any, reason: string, same = false) => { s.hedgeCalls.push({ id: l.id, reason, same }); };
    s.ensureLoaded();
    return s;
}
async function reconcile(s: any) {
    const o = Log.log; (Log as any).log = () => {};
    try { await s.reconcile(1, 0); } finally { (Log as any).log = o; }
}

(async () => {
    for (const [name, Cls] of [['SimpleContinuousStrategy', SimpleContinuousStrategy], ['ScaledHedgedStrategy', ScaledHedgedStrategy]] as [string, any][]) {
        openTrades = [ceHeld];
        console.log(`${name}: reconcile books the platform's profit sell of the last leg -> hedgeWaiting (same right), no order in reconcile, the tick retry hedges`);
        platformSells = [{ orderId: 'K1', quantity: 130, price: 331, at: 1 }];
        let s = make(Cls, `${name}-profit`, [{ ...CE }, PE('L25', 'L24', { hedgeWaiting: true, hedgeSame: false })]);
        orderCalls.length = 0;
        await reconcile(s);
        let l = s.state.legs.L25;
        assert(l.status === 'closed' && l.soldQty === 130, 'L25 booked closed by the platform sell');
        assert(l.hedgeWaiting === true && l.hedgeSame === true && l.hedged === false, 'hedgeWaiting set, same right (profit)');
        assert(orderCalls.length === 0 && s.hedgeCalls.length === 0, 'reconcile placed no order and did not hedge');
        assert(JSON.parse(fs.readFileSync(s.stateFile(), 'utf8')).legs.L25.hedgeWaiting === true, 'persisted');
        s.lastWaitingHedgeRetry = 0;
        await s.retryWaitingHedges();
        assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].id === 'L25' && s.hedgeCalls[0].same === true, 'tick retry hedges L25 buying the same right');

        console.log(`${name}: a loss close buys the opposite right`);
        platformSells = [{ orderId: 'K2', quantity: 130, price: 300, at: 1 }];
        s = make(Cls, `${name}-loss`, [{ ...CE }, PE('L25', 'L24')]);
        await reconcile(s);
        l = s.state.legs.L25;
        assert(l.hedgeWaiting === true && l.hedgeSame === false, 'hedgeWaiting set, opposite right (loss)');
        s.lastWaitingHedgeRetry = 0;
        await s.retryWaitingHedges();
        assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].same === false, 'tick retry hedges the opposite right');

        console.log(`${name}: a first order that made its target is marked restarted (no same-direction re-buy)`);
        platformSells = [{ orderId: 'K3', quantity: 130, price: 331, at: 1 }];
        s = make(Cls, `${name}-root`, [PE('L1', undefined, { role: 'root', parentId: undefined, hedged: false })]);
        openTrades = [];
        await reconcile(s);
        l = s.state.legs.L1;
        assert(l.hedged === true && l.restarted === true && !l.hedgeWaiting, 'root: hedged + restarted, nothing waiting');
        openTrades = [ceHeld];

        console.log(`${name}: today's stale state (closed, hedged:false, sold by the platform, nothing waiting) heals at reconcile`);
        platformSells = [{ orderId: 'K1', quantity: 130, price: 331, at: 1 }];
        s = make(Cls, `${name}-stale`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', sellQty: 0, soldQty: 130, soldValue: 130 * 331 })], { seenSells: ['K1'] });
        await reconcile(s);
        assert(s.state.legs.L25.hedgeWaiting === true && s.state.legs.L25.hedgeSame === true, 'stale L25 queued for its hedge (same right)');

        console.log(`${name}: NOT healed: an outside close, a partial close, a leg with a child, an older stale leaf, a disabled / stopped strategy`);
        platformSells = [];
        s = make(Cls, `${name}-outside`, [{ ...CE }, PE('L25', 'L24')]);
        await reconcile(s);
        assert(s.state.legs.L25.status === 'closed' && !s.state.legs.L25.hedgeWaiting, 'outside close (no platform sell): untouched');
        s = make(Cls, `${name}-partial`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', soldQty: 65, soldValue: 65 * 331, sellQty: 0 })]);
        await reconcile(s);
        assert(!s.state.legs.L25.hedgeWaiting, 'partial close: untouched');
        s = make(Cls, `${name}-child`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 }), { ...PE('L26', 'L25'), tsym: 'X', token: '1' }]);
        openTrades = [ceHeld, { tsym: 'X', token: '1', quantity: 130, price: 321 }];
        await reconcile(s);
        assert(!s.state.legs.L25.hedgeWaiting, 'leg with a child: untouched');
        openTrades = [ceHeld];
        s = make(Cls, `${name}-older`, [{ ...CE }, PE('L20', 'L19', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 }), PE('L21', 'L20', { status: 'closed', hedged: true, soldQty: 130, soldValue: 130 * 300, sellQty: 0, tsym: 'Y', token: '2' }), PE('L22', 'L21', { status: 'closed', hedged: true, restarted: true, soldQty: 130, soldValue: 130 * 300, sellQty: 0, tsym: 'Z', token: '3' })]);
        await reconcile(s);
        assert(!s.state.legs.L20.hedgeWaiting, 'older legs: untouched');
        s = make(Cls, `${name}-disabled`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 })]);
        s.enabled = false;
        await reconcile(s);
        assert(!s.state.legs.L25.hedgeWaiting, 'disabled: untouched');
        s = make(Cls, `${name}-stopped`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 })], { profitTripped: true });
        await reconcile(s);
        assert(!s.state.legs.L25.hedgeWaiting, 'max-profit tripped: untouched');
        // idempotent: a second reconcile with the hedge queued changes nothing
        platformSells = [];
        s = make(Cls, `${name}-twice`, [{ ...CE }, PE('L25', 'L24', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 })]);
        await reconcile(s); await reconcile(s);
        assert(s.state.legs.L25.hedgeWaiting === true && s.hedgeCalls.length === 0, 'second reconcile: still queued once, no order');

        console.log(`${name}: reset() marks never-hedged leaves hedged (a deliberate stop is not revived)`);
        s = make(Cls, `${name}-reset`, [{ ...CE, status: 'closed', soldQty: 130, soldValue: 1, hedged: true, restarted: false }, PE('L25', 'L17', { status: 'closed', soldQty: 130, soldValue: 130 * 331, sellQty: 0 })], { profitTripped: true });
        s.settlePendingHedges = async () => {};
        s.reset();
        assert(s.state.legs.L25.hedged === true, 'closed leaf marked hedged by reset');
    }

    console.log('ScaledHedgedStrategy: last closed leg with a stale hedged:true and nothing open continues the chain');
    let s: any = make(ScaledHedgedStrategy, 'dead', [PE('L25', 'L24', { status: 'closed', hedged: true, soldQty: 130, soldValue: 130 * 300, sellQty: 0 })]);
    await s.afterLegClosed(s.state.legs.L25);
    assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].same === false && s.state.legs.L25.hedged === false, 'loss: hedge called (opposite right)');
    s = make(ScaledHedgedStrategy, 'alive', [{ ...CE }, PE('L25', 'L24', { status: 'closed', hedged: true, soldQty: 130, soldValue: 130 * 300, sellQty: 0 })]);
    await s.afterLegClosed(s.state.legs.L25);
    assert(s.hedgeCalls.length === 0 && s.state.legs.L25.hedged === true, 'an open leg exists: nothing done');
    s = make(ScaledHedgedStrategy, 'child', [PE('L25', 'L24', { status: 'closed', hedged: true, soldQty: 130, soldValue: 130 * 300, sellQty: 0 }), { ...PE('L26', 'L25'), status: 'closed', hedged: true, soldQty: 130, soldValue: 130 * 300 }]);
    await s.afterLegClosed(s.state.legs.L25);
    assert(s.hedgeCalls.length === 0, 'a leg follows it: nothing done');
    process.exit(process.exitCode ?? 0);
})();
