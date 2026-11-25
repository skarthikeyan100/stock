/**
 * SimpleContinuousStrategy / ScaledHedgedStrategy: a platform sell whose fill event the strategy missed (2026-11-25 12:10, ANT stop loss: the order
 * process booked the sell, the event sat in the fill queue behind a hedge buy, the retry was refused as nothing sellable and the leg was closed as an outside
 * close without its -9399). Covered here:
 *   - two users on the SAME contract token: a fill for one reaches only that user's leg
 *   - onFillBooked books the sell at once while the follow-up (hedge buy) is still running (the fill queue is not held)
 *   - a refused sell ("nothing sellable") for a leg the platform's own sell emptied books the real P&L at the booked price, runs the follow-up, no outside-close ALERT
 *   - the late event of that order is not booked again, nor onto another open leg of the contract
 *   - a leg no platform sell explains is still closed outside (neutral, ALERT); a partial cover books what it covers and closes the rest neutral
 * Run: npx tsc, then: node ./dist/test/simpleContinuousMissedSellFill.test.js
 */
import fs from 'fs';
import OrderClient from '../processes/strategies/OrderClient';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import ScaledHedgedStrategy from '../strategy/ScaledHedgedStrategy';
import { localDayKey } from '../strategy/dayKey';
import Log from '../util/Log';
import { Trade } from '../model/model';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let platformSells: any[] = [];
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (..._args: any[]) => {
        if (fn === 'getOpenTrades') return [];
        if (fn === 'platformSells') return platformSells;
        if (fn === 'getPendingSells') return [];
        return {};
    },
});
(OrderClient as any).getInstance = () => fake;

const leg = (id: string, extra: any = {}) => ({ id, tsym: 'NIFTY01DEC26C25950', token: '47893', exchange: 'NFO', strike: 25950, right: 'CE', role: 'hedge', entry: 270.3, qty: 195, soldQty: 0, soldValue: 0, hedged: true, status: 'open', sellQty: 0, sellPrice: 0, ...extra });
const sell = (orderId: string, qty: number, price: number) => Object.assign(new Trade(), { tsym: 'NIFTY01DEC26C25950', action: 'Sell', quantity: qty, price, brokerOrderId: orderId, broker: 'ant' });

function make(Cls: any, id: string, legs: any[]) {
    const s: any = new Cls(id);
    const file = `/tmp/missed-sell-fill-test-${id}-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ day: localDayKey(), legs: Object.fromEntries(legs.map((l) => [l.id, l])), seq: legs.length, pnlStarted: true, realizedPnl: 0, profitTripped: false, sellIdsTracked: true, seenSells: [] }));
    s.stateFile = () => file;
    s.watch = () => {}; s.unwatch = () => {};
    s.checkMaxProfit = async () => {};
    s.recordOutcome = () => {};
    s.hedgeCalls = [] as string[];
    s.hedge = async (l: any, reason: string) => { s.hedgeCalls.push(`${l.id}:${reason}`); };
    s.ensureLoaded();
    return s;
}

(async () => {
    for (const [name, Cls] of [['SimpleContinuousStrategy', SimpleContinuousStrategy], ['ScaledHedgedStrategy', ScaledHedgedStrategy]] as [string, any][]) {
        console.log(`${name}: two users on one token, the fill reaches only its own user's leg`);
        const prism = make(Cls, `${name}-Prism`, [leg('L15', { entry: 271.4 })]);
        const ant = make(Cls, `${name}-ANT`, [leg('L15')]);
        await ant.updateTrade(sell('A1', 195, 222.1));
        assert(ant.state.legs.L15.status === 'closed' && Math.round(ant.state.realizedPnl) === -9399, 'ANT leg closed at -9399');
        assert(prism.state.legs.L15.status === 'open' && prism.state.realizedPnl === 0, 'Prism leg untouched');

        console.log(`${name}: onFillBooked books at once while the follow-up (hedge) is still running`);
        const slow = make(Cls, `${name}-slow`, [leg('L15')]);
        let release: () => void = () => {};
        slow.afterLegClosed = () => new Promise<void>((r) => { release = r; });
        await slow.onFillBooked(sell('S1', 195, 219.4));
        assert(slow.state.legs.L15.status === 'closed' && Math.abs(slow.state.realizedPnl - 195 * (219.4 - 270.3)) < 0.01, 'sell booked, call returned before the follow-up finished');
        release();

        console.log(`${name}: refused sell, the platform's own sell emptied the leg -> booked as a normal close at the booked price`);
        platformSells = [{ orderId: 'A2', quantity: 195, price: 222.1, at: 1 }];
        const logs: string[] = [];
        const origLog = Log.log; (Log as any).log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
        let s = make(Cls, `${name}-gone`, [leg('L15', { hedged: false }), leg('L16', { tsym: 'OTHER', token: '9' })]);
        const refused = await s.closeIfNotHeld(s.state.legs.L15, new Error('NEVER-SHORT GUARD: nothing sellable for X'));
        (Log as any).log = origLog;
        assert(refused === true && s.state.legs.L15.status === 'closed', 'leg closed');
        assert(Math.round(s.state.realizedPnl) === -9399 && s.state.legs.L15.soldQty === 195, 'realizedPnl carries the real -9399');
        assert(!logs.some((l) => /closed outside the platform/.test(l)), 'no outside-close ALERT');
        assert(s.hedgeCalls.length === 1 && s.hedgeCalls[0].startsWith('L15:'), `chain follow-up ran (${s.hedgeCalls.join(',')})`);
        assert(s.state.seenSells.includes('A2'), 'order id recorded as seen');
        console.log(`${name}: the late event of that order is not booked again nor onto another open leg of the contract`);
        s.state.legs.L17 = leg('L17', { entry: 260 });
        await s.updateTrade(sell('A2', 195, 222.1));
        assert(s.state.legs.L17.status === 'open' && s.state.legs.L17.soldQty === 0 && Math.round(s.state.realizedPnl) === -9399, 'late duplicate ignored');

        console.log(`${name}: no platform sell behind it -> closed outside, neutral, ALERT`);
        platformSells = [];
        const logs2: string[] = [];
        (Log as any).log = (...a: any[]) => { logs2.push(a.map(String).join(' ')); };
        s = make(Cls, `${name}-outside`, [leg('L15')]);
        await s.closeIfNotHeld(s.state.legs.L15, new Error('nothing sellable'));
        (Log as any).log = origLog;
        assert(s.state.legs.L15.status === 'closed' && s.state.realizedPnl === 0 && s.hedgeCalls.length === 0, 'closed neutral, no follow-up');
        assert(logs2.some((l) => /closed outside the platform/.test(l)), 'ALERT logged');

        console.log(`${name}: platform sell covers only part -> the covered part is booked, the rest closed neutral`);
        platformSells = [{ orderId: 'A3', quantity: 65, price: 222.1, at: 1 }];
        s = make(Cls, `${name}-part`, [leg('L15')]);
        await s.closeIfNotHeld(s.state.legs.L15, new Error('nothing sellable'));
        assert(s.state.legs.L15.status === 'closed' && s.state.legs.L15.soldQty === 65 && Math.round(s.state.realizedPnl) === Math.round(65 * (222.1 - 270.3)), 'covered 65 lots booked, leg closed');
    }
    process.exit(process.exitCode ?? 0); // the strategies leave timers behind
})();
