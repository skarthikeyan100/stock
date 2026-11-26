/**
 * The day-rollover check of what an earlier day's state left unfinished (live 2026-11-26 07:46: ALERTs for legs the overAllMaxProfit lock sells had
 * closed the day before, while the strategies were disabled and so not told). A leg the platform's own sells cover is a plain line; an ALERT only when
 * they do not, once, with the record kept in the state file. An order booked only in part explains with its rest; an unconfirmed buy (pendingHedge) is
 * reported, never settled at the broker. Paper legs are never reported. Nothing is ordered, cancelled or booked at rollover.
 * Run: npx tsc, then: node ./dist/test/dayRolloverPlatformSells.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import bookkeeping from '../processes/order/bookkeeping';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import ExperimentalScaledStrategy from '../strategy/ExperimentalScaledStrategy';
import ExpiryStrategy from '../strategy/ExpiryStrategy';
import { carryOver, reportCarried, CarriedInput } from '../strategy/dayRollover';
import { Trade } from '../model/model';
import { localDayKey } from '../strategy/dayKey';
import Mongo from '../tools/mongo';
import { matches } from './fakeMongoMatch';
import Log from '../util/Log';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const yesterdayDate = new Date(Date.now() - 24 * 3600 * 1000);
const yesterday = localDayKey(yesterdayDate);
const T = yesterdayDate.getTime();

let sells: Record<string, any[] | null> = {};
let reads: any[][] = [];
let calls: string[] = [];
let openTradesFail = false;
let sellsHang = false; // the read never answers (the process dies during the check)
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        if (fn === 'platformSells') { reads.push(args); if (sellsHang) return new Promise(() => {}); const r = sells[`${args[1]}|${args[2]}`]; return r === undefined ? [] : r; }
        calls.push(fn);
        if (fn === 'getOpenTrades') { if (openTradesFail) throw new Error('order side down'); return []; }
        if (fn === 'getPendingSells') return [];
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;

let lines: string[] = [];
const realLog = Log.log;
(Log as any).log = (...a: any[]) => { lines.push(a.map(String).join(' ')); };
const print = (s: string) => realLog.call(Log, s);
const out = console.log.bind(console);
const alerts = () => lines.filter((l) => l.includes('ALERT') && l.includes('day rolled over'));
const normal = () => lines.filter((l) => l.includes('a normal close'));
const reset = () => { lines = []; reads = []; calls = []; sells = {}; openTradesFail = false; sellsHang = false; };
const reminders = () => lines.filter((l) => l.includes('still on record'));
const stored = (s: any) => JSON.parse(fs.readFileSync(s.stateFile(), 'utf8'));
const items = (s: any): any[] => (stored(s).carried ?? []).flatMap((b: any) => b.items);

const files: string[] = [];
const sell = (orderId: string, quantity: number, price = 240, at = T) => ({ orderId, quantity, price, at });
const leg = (id: string, tsym: string, extra: any = {}) => ({ id, tsym, token: id, exchange: 'NFO', strike: 25750, right: 'CE', role: 'root', entry: 250, qty: 390, soldQty: 0, soldValue: 0, hedged: true, doubled: true, status: 'open', sellQty: 390, sellPrice: 260, ...extra });

function make(Cls: any, id: string, legs: any[], extra: any = {}, broker = 'kite') {
    const s: any = new Cls(id);
    const file = `/tmp/day-rollover-${id}-${process.pid}.json`;
    files.push(file);
    fs.writeFileSync(file, JSON.stringify({ day: yesterday, legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: 20, pnlStarted: true, realizedPnl: 0, profitTripped: false, sellIdsTracked: true, seenSells: [], ...extra }));
    s.stateFile = () => file;
    s.cfg = () => ({ broker });
    s.watch = () => {}; s.unwatch = () => {};
    s.enabled = false;
    return s;
}
const load = async (s: any) => { s.ensureLoaded(); await s.rolloverCheck; };

(async () => {
    for (const [name, Cls] of [['SimpleContinuousStrategy', SimpleContinuousStrategy], ['ScaledHedgedStrategy', ScaledHedgedStrategy], ['ExperimentalScaledStrategy', ExperimentalScaledStrategy]] as [string, any][]) {
        out(`${name}: both sides closed by the platform's lock sells while disabled`);
        reset();
        sells = { 'kite|CE1': [sell('K1', 390, 244)], 'kite|PE1': [sell('K2', 390, 224.3)] };
        let s = make(Cls, `${name}-both`, [leg('L1', 'CE1'), leg('L2', 'PE1', { right: 'PE' })]);
        await s.reconcile(1, 0);
        assert(alerts().length === 0 && normal().length === 2, `two normal closes, no ALERT (${alerts().length}/${normal().length})`);
        assert(reads.length === 2 && reads.every((r) => r[3] === yesterday), 'the sells are asked for since the earlier day');
        assert(calls.every((c) => c === 'getOpenTrades' || c === 'getPendingSells'), `disabled: only reads (${calls.join(',')})`);
        const saved = stored(s);
        assert(saved.day === localDayKey() && Object.keys(saved.legs).length === 0 && saved.realizedPnl === 0 && items(s).length === 0, 'today starts empty; nothing carried or booked');
        lines = [];
        const again = new Cls(`${name}-both`) as any;
        again.stateFile = () => s.stateFile(); again.cfg = s.cfg;
        await load(again);
        assert(alerts().length === 0 && normal().length === 0, 'a restart after that says nothing');

        out(`${name}: no platform sell -> the ALERT as before`);
        reset();
        s = make(Cls, `${name}-none`, [leg('L1', 'CE1')]);
        await load(s);
        assert(alerts().length === 1 && alerts()[0].includes(`CE1 from ${yesterday} was still open when the day rolled over - check the broker position by hand`), 'ALERT');

        out(`${name}: partial lock fill, chunked sells, already-seen orders`);
        reset();
        sells = { 'kite|CE1': [sell('K1', 195)] };
        await load(make(Cls, `${name}-partial`, [leg('L1', 'CE1')]));
        assert(alerts().length === 1 && alerts()[0].includes('only 195 of 390'), 'half sold: ALERT naming what is explained');
        reset();
        sells = { 'kite|CE1': [sell('K1', 195), sell('K2', 195)] };
        await load(make(Cls, `${name}-chunks`, [leg('L1', 'CE1')]));
        assert(alerts().length === 0 && normal().length === 1, 'two chunks cover the leg');
        reset();
        sells = { 'kite|CE1': [sell('OLD', 390)] };
        await load(make(Cls, `${name}-seen`, [leg('L0', 'CE1', { status: 'closed', soldQty: 390 }), leg('L1', 'CE1')], { seenSells: ['OLD'] }));
        assert(alerts().length === 1, 'a sell the strategy already booked explains nothing again');
        reset();
        sells = { 'kite|CE1': [sell('K1', 130), sell('K2', 260)] };
        await load(make(Cls, `${name}-partseen`, [leg('L1', 'CE1', { soldQty: 130 })], { seenSells: ['K1'] }));
        assert(alerts().length === 0 && normal()[0].includes('260 lots') && normal()[0].includes('K2') && !normal()[0].includes('K1,'), 'a part-sold leg needs only its rest');

        out(`${name}: two legs on one contract`);
        reset();
        sells = { 'kite|CE1': [sell('K1', 390)] };
        await load(make(Cls, `${name}-two`, [leg('L1', 'CE1'), leg('L2', 'CE1')]));
        assert(normal().length === 1 && alerts().length === 1, 'the covered one is normal, the other alerts');
        reset();
        sells = { 'kite|CE1': [sell('K1', 780)] };
        await load(make(Cls, `${name}-twoall`, [leg('L1', 'CE1'), leg('L2', 'CE1')]));
        assert(normal().length === 2 && alerts().length === 0, 'one sell covering both');

        out(`${name}: legacy state (no seen ids), a sell after the load, brokers`);
        reset();
        sells = { 'kite|CE1': [sell('OLD', 390), sell('K2', 390)] };
        await load(make(Cls, `${name}-legacy`, [leg('L0', 'CE1', { status: 'closed', soldQty: 390 }), leg('L1', 'CE1')], { sellIdsTracked: undefined, seenSells: undefined }));
        assert(normal().length === 1 && alerts().length === 0, 'legacy: the seen quantity is skipped, the rest covers');
        reset();
        sells = { 'kite|CE1': [sell('LATER', 390, 240, Date.now() + 60_000)] };
        await load(make(Cls, `${name}-later`, [leg('L1', 'CE1')]));
        assert(alerts().length === 1, 'a sell made after the new day loaded is not evidence');
        reset();
        sells = { 'ant|CE1': [sell('A1', 390)] };
        await load(make(Cls, `${name}-antcfg`, [leg('L1', 'CE1')], {}, 'ant'));
        assert(normal().length === 1 && reads[0][1] === 'ant', "a legacy leg without a broker uses the block's broker");
        reset();
        sells = { 'ant|CE1': [sell('A1', 390)] };
        await load(make(Cls, `${name}-legbroker`, [leg('L1', 'CE1', { broker: 'ant' })], {}, 'paper'));
        assert(normal().length === 1 && reads[0][1] === 'ant', "the leg's own broker wins over a changed block");
        reset();
        await load(make(Cls, `${name}-paper`, [leg('L1', 'CE1', { broker: 'paper' })], {}, 'paper'));
        assert(alerts().length === 0 && normal().length === 0 && reads.length === 0, 'paper leg: nothing to check, nothing logged');

        const restart = async (from: any) => { const n = new Cls(from.userId) as any; n.stateFile = () => from.stateFile(); n.cfg = from.cfg; n.watch = () => {}; n.unwatch = () => {}; n.enabled = false; await load(n); return n; };

        out(`${name}: an unexplained leg is ALERTed once and stays on record`);
        reset();
        s = make(Cls, `${name}-once`, [leg('L1', 'CE1')]);
        await s.reconcile(1, 0);
        assert(alerts().length === 1 && stored(s).day === localDayKey() && items(s).length === 1 && items(s)[0].record.id === 'L1' && items(s)[0].alertedAt > 0, 'ALERT, record kept in the new state');
        lines = []; reads = [];
        let n = await restart(s);
        assert(alerts().length === 0 && reminders().length === 1 && reminders()[0].includes('kite CE1 (390)') && reads.length === 0, 'restart: a plain reminder, no ALERT');
        fs.writeFileSync(s.stateFile(), JSON.stringify({ ...stored(s), day: yesterday }));
        lines = [];
        n = await restart(s);
        n.save();
        assert(alerts().length === 0 && reminders().length === 1 && items(n).length === 1, 'a later day carries it on, still no ALERT');
        n.reset();
        assert(items(n).length === 1, 'reset keeps it');

        out(`${name}: restart during the check, and a save during the check`);
        reset(); sellsHang = true;
        s = make(Cls, `${name}-hang`, [leg('L1', 'CE1')]);
        s.ensureLoaded();
        assert(stored(s).day === yesterday, 'nothing is written before the check answers');
        s.save();
        assert(items(s).length === 1 && !items(s)[0].alertedAt, 'a save during the check keeps the unfinished item');
        sellsHang = false; lines = [];
        await restart(s);
        assert(alerts().length === 1 && items(s)[0].alertedAt > 0, 'the next start does the check and ALERTs once');

        out(`${name}: unreadable sells, then looked up again`);
        reset(); sells = { 'kite|CE1': null };
        s = make(Cls, `${name}-unread`, [leg('L1', 'CE1')]);
        s.ensureLoaded(); await s.rolloverCheck;
        assert(alerts().length === 1 && alerts()[0].includes('could not be read') && items(s)[0].recheck === true, 'ALERT, to be looked up again');
        lines = []; sells = { 'kite|CE1': [sell('K1', 390)] };
        await restart(s);
        assert(alerts().length === 0 && normal().length === 1 && items(s).length === 0, 'explained on the next start: plain line, record cleared');
        reset(); sells = { 'kite|CE1': null };
        s = make(Cls, `${name}-unread2`, [leg('L1', 'CE1')]);
        s.ensureLoaded(); await s.rolloverCheck;
        lines = []; sells = {};
        await restart(s);
        assert(alerts().length === 0 && items(s).length === 1 && items(s)[0].recheck === false, 'still unexplained on the next start: no second ALERT');

        out(`${name}: an order booked only in part explains with its rest`);
        reset(); sells = { 'kite|CE1': [sell('K1', 390)] };
        await load(make(Cls, `${name}-partqty`, [leg('L1', 'CE1', { soldQty: 130 })], { seenSells: ['K1'], sellQtys: { K1: 130 } }));
        assert(alerts().length === 0 && normal().length === 1 && normal()[0].includes('260 lots'), 'rollover: the 260 not booked explain the leg');
        reset(); sells = { 'kite|CE1': [sell('K1', 390)] };
        await load(make(Cls, `${name}-fullqty`, [leg('L1', 'CE1')], { seenSells: ['K1'], sellQtys: { K1: 390 } }));
        assert(alerts().length === 1, 'a fully booked order explains nothing more');
        reset(); sells = { 'kite|CE1': [sell('K1', 390, 240)] };
        s = make(Cls, `${name}-live`, [leg('L1', 'CE1', { hedged: true })], { day: localDayKey() });
        s.recordOutcome = () => {}; s.checkMaxProfit = async () => {}; s.afterLegClosed = async () => {};
        s.ensureLoaded();
        const event = () => Object.assign(new Trade(), { tsym: 'CE1', token: 'L1', action: 'Sell', quantity: 130, price: 240, brokerOrderId: 'K1', broker: 'kite' });
        await s.updateTrade(event());
        assert(s.state.legs.L1.soldQty === 130 && s.state.sellQtys.K1 === 130, 'the fill event records what it booked of the order');
        await s.reconcile(1, 0);
        assert(s.state.legs.L1.status === 'closed' && s.state.legs.L1.soldQty === 390 && s.state.realizedPnl === 390 * -10 && s.state.sellQtys.K1 === undefined, `same day: reconcile books the other 260 once (${s.state.realizedPnl})`);
        await s.updateTrade(event()); await s.reconcile(1, 0);
        assert(s.state.legs.L1.soldQty === 390 && s.state.realizedPnl === 390 * -10, 'nothing is booked twice');

        out(`${name}: an earlier day's unconfirmed buy`);
        const pending = (extra: any = {}) => ({ tsym: 'PE9', token: '9', exchange: 'NFO', strike: 25750, right: 'PE', premium: 200, qty: 260, same: false, at: T, ...extra });
        reset(); sells = { 'kite|CE1': [sell('K1', 390)] };
        s = make(Cls, `${name}-pend`, [leg('L1', 'CE1', { pendingHedge: pending() })]);
        await s.reconcile(1, 0);
        assert(alerts().length === 1 && alerts()[0].includes('unconfirmed hedge buy of 260 PE9 (recorded on leg L1 CE1)') && alerts()[0].includes('whether it filled is not known'), 'ALERT naming it');
        assert(calls.every((c) => c === 'getOpenTrades' || c === 'getPendingSells'), `disabled: nothing cancelled or ordered (${calls.join(',')})`);
        assert(items(s).length === 1 && items(s)[0].kind === 'pendingBuy' && items(s)[0].record.legId === 'L1' && items(s)[0].record.qty === 260, 'its record is kept');
        lines = [];
        await restart(s);
        assert(alerts().length === 0 && reminders()[0].includes('unconfirmed buy kite PE9 (260)'), 'restart: reminder only');
        reset(); sells = { 'kite|PE9': [sell('K9', 260)] };
        await load(make(Cls, `${name}-pendsold`, [leg('L1', 'CE1', { status: 'closed', soldQty: 390, pendingHedge: pending() })]));
        assert(alerts().length === 0 && normal().length === 1 && normal()[0].includes('had filled and was sold again'), 'on a closed leg, filled and sold by the platform: plain line');
        reset(); sells = { 'kite|PE9': [sell('K9', 130)] };
        await load(make(Cls, `${name}-pendpart`, [leg('L1', 'CE1', { status: 'closed', soldQty: 390, pendingHedge: pending() })]));
        assert(alerts().length === 1 && alerts()[0].includes('only 130 of 260'), 'partly explained: ALERT');
        reset(); sells = { 'kite|PE9': [sell('K9', 260)] };
        await load(make(Cls, `${name}-pendprio`, [leg('L1', 'CE1', { status: 'closed', soldQty: 390, pendingHedge: pending() }), leg('L2', 'PE9', { right: 'PE', qty: 260 })]));
        assert(normal().length === 1 && normal()[0].includes('260 lots shown open') && alerts().length === 1 && alerts()[0].includes('unconfirmed hedge buy'), 'a recorded leg is covered before the unconfirmed buy');
        reset();
        await load(make(Cls, `${name}-pendpaper`, [leg('L1', 'CE1', { broker: 'paper', status: 'closed', pendingHedge: pending() })], {}, 'paper'));
        assert(alerts().length === 0 && reads.length === 0, 'paper: nothing');

        out(`${name}: restart with a blocked reconcile`);
        reset(); openTradesFail = true;
        s = make(Cls, `${name}-blocked`, [leg('L1', 'CE1')]);
        await s.reconcile(1, 0); await s.rolloverCheck;
        assert(alerts().length === 1 && items(s).length === 1, 'reported, and the record is not lost');
    }

    out('the helper: unreadable sells are retried, then ALERT');
    const input: CarriedInput[] = [{ broker: 'kite', tsym: 'CE1', open: true, remaining: 390, accounted: 0, record: {}, alert: `CE1 from ${yesterday} was still open when the day rolled over - check the broker position by hand` }];
    const ctx = () => ({ tag: 'T', userId: 'u', batches: carryOver({ day: yesterday, sellIdsTracked: true, seenSells: [] }, input), persist: () => {}, attempts: 3, delayMs: 0 });
    reset(); sells = { 'kite|CE1': null };
    await reportCarried(ctx());
    assert(reads.length === 3 && alerts().length === 1 && alerts()[0].includes('could not be read'), 'three reads, then ALERT');
    reset(); sells = { 'kite|CE1': null };
    const p = reportCarried({ ...ctx(), delayMs: 20 });
    setTimeout(() => { sells = { 'kite|CE1': [sell('K1', 390)] }; }, 5);
    await p;
    assert(alerts().length === 0 && normal().length === 1, 'a read that succeeds on a retry is used');

    out('LimitEntryStrategy (ExpiryStrategy)');
    const lleg = (broker: string, tsym: string, status: string, extra: any = {}) => ({ broker, tsym, token: tsym, exchange: 'NFO', qty: 130, price: 42, status, placedAt: T, filledQty: status === 'resting' ? 0 : 130, boughtValue: 0, soldQty: 0, soldValue: 0, ...extra });
    const lmake = (id: string, legs: any[]) => {
        const s: any = new ExpiryStrategy(id);
        const file = `/tmp/day-rollover-${id}-${process.pid}.json`;
        files.push(file);
        fs.writeFileSync(file, JSON.stringify({ day: yesterday, keys: [], legs: Object.fromEntries(legs.map((l, i) => [`${l.broker}${i}`, l])), sellIdsTracked: true, seenSells: [] }));
        s.stateFile = () => file;
        return s;
    };
    reset();
    for (const status of ['resting', 'placing', 'filled']) await load(lmake(`paper-${status}`, [lleg('paper', 'P1', status)]));
    await load(lmake('paper-resting', [lleg('paper', 'P1', 'resting')]));
    assert(reminders().length === 0, 'and nothing is carried for them');
    assert(alerts().length === 0 && reads.length === 0, 'paper legs (resting, placing, filled) never alert, on any restart');
    reset();
    await load(lmake('real-resting', [lleg('kite', 'R1', 'resting')]));
    assert(alerts().length === 1 && alerts()[0].includes('kite R1 from') && alerts()[0].includes('was still resting (filled 0, sold 0)'), 'real resting entry with no sell: ALERT as before');
    const again = async (id: string) => { const n: any = new ExpiryStrategy(id); n.stateFile = () => `/tmp/day-rollover-${id}-${process.pid}.json`; await load(n); return n; };
    let r = await again('real-resting');
    lines = [];
    r = await again('real-resting');
    assert(alerts().length === 0 && reminders().length === 1, 'the next start says it once as a plain line, not an ALERT');
    assert(stored(r).day === localDayKey() && items(r).length === 1 && items(r)[0].record.tsym === 'R1' && items(r)[0].record.status === 'resting', "the leg's record is kept in the state file");
    r.reset();
    assert(items(r).length === 1 && Object.keys(stored(r).legs).length === 0, "reset keeps the earlier day's record");
    fs.writeFileSync(r.stateFile(), JSON.stringify({ ...stored(r), day: yesterday }));
    lines = [];
    r = await again('real-resting'); r.save();
    assert(alerts().length === 0 && items(r).length === 1, 'carried over a further day, no ALERT');
    reset();
    const fresh = new ExpiryStrategy('reset-first') as any;
    fs.writeFileSync(`/tmp/day-rollover-reset-first-${process.pid}.json`, JSON.stringify({ ...stored(r), day: localDayKey() }));
    files.push(`/tmp/day-rollover-reset-first-${process.pid}.json`);
    fresh.stateFile = () => `/tmp/day-rollover-reset-first-${process.pid}.json`;
    fresh.reset();
    assert(items(fresh).length === 1, 'a reset before the first load keeps it too');
    reset(); sellsHang = true;
    const hung = lmake('hung', [lleg('kite', 'R1', 'filled')]);
    hung.ensureLoaded();
    assert(stored(hung).day === yesterday, 'the earlier file is untouched while the check runs');
    hung.save();
    assert(items(hung).length === 1, 'a save during the check keeps the leg on record');
    sellsHang = false; lines = [];
    await again('hung');
    assert(alerts().length === 1, 'the next start ALERTs it once');
    reset();
    const lp = lmake('l-partqty', [lleg('kite', 'F1', 'filled', { soldQty: 65 })]);
    fs.writeFileSync(lp.stateFile(), JSON.stringify({ ...stored(lp), seenSells: ['K1'], sellQtys: { K1: 65 } }));
    sells = { 'kite|F1': [sell('K1', 130)] };
    await load(lp);
    assert(alerts().length === 0 && normal().length === 1, 'LimitEntry: the unbooked rest of a part-booked order explains the leg');
    reset();
    const lf: any = lmake('l-fill', []);
    lf.enabled = true; lf.unwatch = () => {}; lf.endIfIdle = async () => {};
    await load(lf);
    lf.state.legs = { kite0: lleg('kite', 'F1', 'filled') };
    const part = () => Object.assign(new Trade(), { tsym: 'F1', action: 'Sell', quantity: 65, price: 40, brokerOrderId: 'K5', broker: 'kite' });
    await lf.updateTrade(part());
    assert(lf.state.sellQtys.K5 === 65, 'a LimitEntry sell fill records what it booked');
    await lf.updateTrade(part());
    assert(lf.state.sellQtys.K5 === 130 && lf.state.seenSells.length === 1, 'and adds up over events of one order');
    reset(); sells = { 'kite|F1': [sell('K1', 130)] };
    await load(lmake('real-filled', [lleg('kite', 'F1', 'filled'), lleg('paper', 'P1', 'resting')]));
    assert(alerts().length === 0 && normal().length === 1, 'a filled leg the platform sold: normal close');
    reset(); sells = { 'kite|F1': [sell('K1', 65)] };
    await load(lmake('real-part', [lleg('kite', 'F1', 'filled')]));
    assert(alerts().length === 1 && alerts()[0].includes('only 65 of 130'), 'partly explained: ALERT');
    reset(); sells = { 'kite|F1': [sell('K1', 65)] };
    await load(lmake('real-halfsold', [lleg('kite', 'F1', 'filled', { filledQty: 65 })]));
    assert(alerts().length === 0 && normal().length === 1, 'a part-filled entry needs only what filled');
    reset(); sells = { 'kite|R1': [sell('K1', 130)] };
    await load(lmake('real-unseenfill', [lleg('kite', 'R1', 'resting')]));
    assert(alerts().length === 0 && normal().length === 1, 'a resting entry whose whole quantity the platform sold (filled unseen): normal close');
    reset(); sells = { 'kite|R1': [sell('K1', 65)] };
    await load(lmake('real-unseenpart', [lleg('kite', 'R1', 'resting')]));
    assert(alerts().length === 1, 'a resting entry only partly sold: ALERT');
    reset(); sells = { 'kite|F1': [sell('K1', 130)], 'ant|F1': [] };
    await load(lmake('two-brokers', [lleg('kite', 'F1', 'filled'), lleg('ant', 'F1', 'filled')]));
    assert(normal().length === 1 && alerts().length === 1 && alerts()[0].includes('ant F1'), "one broker's sells never explain another broker's leg");

    out('order side: platformSells since a day');
    const at = new Date(yesterdayDate); at.setHours(14, 41, 0, 0);
    const docs: Record<string, any[]> = {
        Trade: [{ user: 'u', tsym: 'CE1', action: 'Sell', broker: 'ant', brokerOrderId: 'A1', quantity: 195, price: 240, entryTime: at }],
        orderOwners: [{ orderId: 'A1', broker: 'ant', user: 'u' }],
    };
    const find = (name: string) => (f: any) => { const rows = (docs[name] ?? []).filter((d) => matches(d, f)); return { sort: () => ({ toArray: async () => rows }), toArray: async () => rows }; };
    (Mongo as any).instance = { db: { collection: (name: string) => ({ find: find(name) }) } };
    const today = await bookkeeping.platformSells('u', 'ant', 'CE1');
    const since = await bookkeeping.platformSells('u', 'ant', 'CE1', yesterday);
    const bad = await bookkeeping.platformSells('u', 'ant', 'CE1', 'junk');
    assert(today?.length === 0 && since?.length === 1 && since[0].quantity === 195 && bad?.length === 0, "yesterday's sell is read only when asked since yesterday");

    (Log as any).log = realLog;
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    print(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})();
