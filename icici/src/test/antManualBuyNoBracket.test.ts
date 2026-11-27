/**
 * A manual ANT buy is never a broker bracket (also for a GTT user): the platform watches target / stop itself, so the position can be edited and
 * squared off from the trading page like any other. The latest buy's levels are the ones shown on the position and enforced.
 * Strategy buys (enterPosition's default) still use a bracket.
 * Run: npx tsc && node ./dist/test/antManualBuyNoBracket.test.js
 */
import ANT from '../ant/ANT';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import AntContractMaster from '../ant/AntContractMaster';
import Mongo from '../tools/mongo';
import bookkeeping from '../processes/order/bookkeeping';
import * as exitMonitor from '../processes/order/exitMonitor';
import { enterPosition, manualBuyOnAnt } from '../processes/order/antExecutor';
import { setTargetStopLoss } from '../processes/order/kiteExecutor';
import { OptionQuote } from '../model/model';

function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) process.exitCode = 1; }

(Mongo as any).getInstance = () => undefined;
let orders: string[] = [];
let brackets = 0;
let price = 100;
let n = 0;
(ANT as any).instance = {
    placeOrder: async (o: any) => { orders.push(`${o.transactionType} ${o.quantity}`); return { orderNo: `ant-nb-${++n}` }; },
    placeBracketOrder: async () => { brackets++; return { orderNo: `ant-nb-bo-${++n}` }; },
    getLiveQuote: async () => ({ ltp: price, bid: price - 0.05, ask: price + 0.05 }),
    getQuote: async () => price,
    getFillPrice: async () => price,
};
(AntOrderNotifyStream as any).instance = { waitForFill: async () => price };
const contract = { token: 'nb-tok', exch: 'NFO', tradingSymbol: 'NIFTY01DEC26C25900', lotSize: '65' };
(AntContractMaster as any).getInstance = () => ({ findATMOption: () => contract, findNearestExpiryOption: () => contract });

const USER = 'nb-user';
bookkeeping.updateUserSettings(USER, { lossLimit: 1e9, lotLimit: 100, maxInvestment: 1e9, investmentMode: 'lotCount', accountCapital: 100000, useGTT: true } as any);
const row = () => bookkeeping.trades.find((t) => t.user === USER && t.tsym === contract.tradingSymbol);
const tick = async (ltp: number) => { const q = new OptionQuote(); q.token = contract.token; q.ltp = ltp; q.ltt = Date.now(); await exitMonitor.handleOptionTick(q); };
const buy = (targetPoints: number, stopLossPoints: number) => manualBuyOnAnt({ userId: USER, right: 'call', strikePrice: 25900, targetPoints, stopLossPoints });

async function main() {
    let sold: Array<{ qty: number; stop?: number }> = [];
    exitMonitor.setAggregateResolver((t) => bookkeeping.trades.find((x) => x.tsym === t.tsym && x.user === t.user));
    exitMonitor.onExit('ant', async (t) => { sold.push({ qty: t.quantity, stop: t.stopLossPrice }); });

    console.log('first manual buy');
    await buy(10, 10);
    assert(brackets === 0 && orders.join() === 'BUY 65', `a plain order, no bracket, although the user uses GTT (${orders.join()}, brackets ${brackets})`);
    assert(!!row() && row()!.antOrderNo === undefined && row()!.targetPrice === 110 && row()!.stopLossPrice === 90, `the position holds the target / stop itself (${row()?.targetPrice} / ${row()?.stopLossPrice})`);

    console.log('add-more');
    price = 120;
    await buy(10, 5);
    assert(row()!.quantity === 130 && row()!.targetPrice === 130 && row()!.stopLossPrice === 115, `the position shows the latest buy's levels (${row()?.targetPrice} / ${row()?.stopLossPrice})`);

    console.log('editing the position changes what is enforced');
    row()!.lastTradePrice = 120;
    await setTargetStopLoss(USER, contract.token, 20, 12, 'ant');
    const newStop = row()!.stopLossPrice!;
    assert(newStop === row()!.price - 12, `the stop is changed (${newStop})`);
    await tick(newStop + 1);
    assert(sold.length === 0, 'above the new stop nothing is sold (the old stop 115 is gone)');
    await tick(newStop - 0.1);
    assert(sold.length === 1 && sold[0].qty === 130, `the in-app monitor sells the whole position at the new stop (${JSON.stringify(sold)})`);

    console.log('the latest levels are enforced without any edit');
    bookkeeping.trades.splice(bookkeeping.trades.indexOf(row()!), 1);
    exitMonitor.unregisterTrade(USER, contract.token);
    price = 100;
    await buy(10, 10);
    price = 120;
    await buy(10, 5);
    sold = [];
    await tick(114.9);
    assert(sold.length === 1 && sold[0].qty === 130, `sold at the latest stop for the whole position (${JSON.stringify(sold)})`);

    console.log('a strategy entry still uses a bracket');
    brackets = 0;
    await enterPosition('nb-strategy', contract.tradingSymbol, contract.token, 65, 'NFO', 10, 10);
    assert(brackets === 1, 'bracket kept for strategy buys');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.log('FAIL:', e); process.exit(1); });
