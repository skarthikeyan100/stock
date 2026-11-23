/**
 * 2026-11-23 14:18: two freeze-quantity parts of one entry filled in the same instant; the strategy booked the second part twice (3185 vs 2470 held) and then
 * retried the exit extension every second with an ALERT each time. Checks: bookkeeping hands each listener its own fill's quantity; one order never books more
 * than it was placed for; a failing top-up backs off, alerts a bounded number of times, and corrects the leg to the broker's position; a real extra fill still extends.
 * Run: npx tsc, then: node ./dist/test/fillDoubleBooking.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import RecommendationStrategy from '../strategy/RecommendationStrategy';
import bookkeeping from '../processes/order/bookkeeping';
import { Trade } from '../model/model';
import configService from '../prism/ConfigService';
(configService.getConfig().settings as any).eodCloseTime = '23:59';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

let calls: { fn: string; args: any[] }[] = [];
let n = 0;
let held = 0;
let sellFails = false;
const fake: any = new Proxy({}, {
    get: (_t, fn: string) => async (...args: any[]) => {
        calls.push({ fn, args });
        switch (fn) {
            case 'resolveOptionContract': return { tsym: `NIFTY${args[1].strike}${args[1].right}`, token: 'T1', exchange: 'NFO' };
            case 'placeLimitBuyBare': return { orderId: `B${++n}` };
            case 'brokerPlaceLimitSellBare': if (sellFails) throw new Error('paper: nothing sellable'); return { orderId: 'S1' };
            case 'getOrderPrice': return { price: 100, bid: 100, ask: 100.05, ltp: 100, spread: 0.05 };
            case 'attachProtection': throw new Error('no protection primitive');
            case 'getOpenTrades': return held > 0 ? [{ tsym: 'NIFTY22750CE', broker: 'paper', quantity: held, price: 100 }] : [];
            default: return {};
        }
    },
});
(OrderClient as any).getInstance = () => fake;
(AntContractMaster as any).getInstance = () => ({ entryStrike: () => 22750 });
const alerts: string[] = [];
const origLog = console.log;

function make(userId: string): any {
    const cfg = { type: 'RecommendationStrategy', userId, contract: '22750 CE', entryPrice: 100, targetPrice: 130, stopLoss: 80, entryOffset: 0, maxInvestment: 300000, brokers: ['paper'], startTime: '00:00' };
    const s: any = new RecommendationStrategy(userId);
    s.enabled = true;
    s.cfg = () => cfg;
    s.stateFile = () => `/tmp/fill-double-${userId}-${process.pid}.json`;
    return s;
}
const fill = (id: string, qty: number) => Object.assign(new Trade(), { tsym: 'NIFTY22750CE', action: 'Buy', quantity: qty, price: 100, broker: 'paper', token: 'T1', brokerOrderId: id });

(async () => {
    console.log('bookkeeping: concurrent fills of one contract');
    const seen: number[] = [];
    bookkeeping.onFill((_u, t) => { if (t.tsym === 'NIFTYRACE') seen.push(t.quantity); });
    const mk = (id: string, q: number) => Object.assign(new Trade(), { tsym: 'NIFTYRACE', token: 'TR', action: 'Buy', quantity: q, price: 40, broker: 'paper', user: 'RaceUser', brokerOrderId: id, status: 'COMPLETE' });
    await Promise.all([bookkeeping.recordFill(mk('P1', 1755)), bookkeeping.recordFill(mk('P2', 715))]);
    assert(seen.length === 2 && seen[0] === 1755 && seen[1] === 715, `listeners got 1755 and 715 (got ${seen.join(', ')})`);
    assert(bookkeeping.getOpenTrades('RaceUser').reduce((s, t) => s + t.quantity, 0) === 2470, 'the open position is 2470');

    console.log('strategy: two parts, over-sized delivery is clamped');
    let s = make('FDB-1');
    await s.processNiftyQuote({ ltp: 22700 });
    const leg = s.legs()[0];
    const chunks = leg.chunks;
    assert(chunks.length === 2, `entry split in two orders (got ${chunks.length})`);
    const total = leg.qty;
    await s.updateTrade(fill('B1', chunks[0].qty));
    await s.updateTrade(fill('B2', total)); // mis-sized: the whole aggregate for the second order
    assert(leg.filledQty === total, `filled ${leg.filledQty} == ordered ${total}`);
    await s.updateTrade(fill('B2', 500)); // the order has nothing left
    assert(leg.filledQty === total, 'a further fill for a fully filled order is not booked');

    console.log('strategy: failing top-up backs off, bounded alerts, corrects to broker');
    calls = []; n = 0; sellFails = false;
    s = make('FDB-2');
    await s.processNiftyQuote({ ltp: 22700 });
    const l2 = s.legs()[0];
    await s.updateTrade(fill('B1', l2.chunks[0].qty)); // exit placed over the first part
    sellFails = true;
    held = l2.chunks[0].qty; // broker holds only what really filled
    const logs: string[] = [];
    console.log = (...a: any[]) => { logs.push(a.join(' ')); };
    await s.updateTrade(fill('B2', 100)); // real extra fill, extension fails (attempt 1)
    for (let i = 0; i < 20; i++) await s.housekeeping(); // 20 retries in a row: back-off lets none through
    console.log = origLog;
    const topAlerts = logs.filter((m) => /could not extend the exit/.test(m)).length;
    assert(topAlerts === 1, `one alert for 21 attempts inside the back-off (got ${topAlerts})`);
    l2.topUpRetryAt = Date.now() - 1; // the back-off elapses: second failure, broker holds less -> leg corrected
    await s.housekeeping();
    assert(l2.filledQty === l2.chunks[0].qty, `leg corrected to the broker's ${held} (got ${l2.filledQty})`);

    console.log('strategy: a real late fill still extends the exit');
    calls = []; n = 0; sellFails = false;
    s = make('FDB-3');
    await s.processNiftyQuote({ ltp: 22700 });
    const l3 = s.legs()[0];
    await s.updateTrade(fill('B1', l3.chunks[0].qty));
    await s.updateTrade(fill('B2', l3.chunks[1].qty));
    const sells = calls.filter((c) => c.fn === 'brokerPlaceLimitSellBare');
    assert(sells.length >= 2 && l3.exitQty === l3.filledQty, `exit covers ${l3.exitQty}/${l3.filledQty} in ${sells.length} sells`);
    process.exit(process.exitCode ?? 0);
})();
