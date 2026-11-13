/**
 * manualBuyOnBreeze: a Breeze-account user's frontend buy (IPC 'manualBuy') places a guarded-quote limit buy, books the fill with
 * in-app target/stop levels, books a partial fill, refuses a non-lot quantity, and hands the admin mirror a 'breeze' leg.
 * Mocks only (no broker call). Run: node ./dist/test/manualBuyBreeze.test.js
 */
import Breeze from '../breeze/Breeze';
import ANT from '../ant/ANT';
import BreezeContractMaster, { FnoRecord } from '../breeze/BreezeContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import BreezeOrderNotifyStream from '../breeze/BreezeOrderNotifyStream';
import bookkeeping from '../processes/order/bookkeeping';
import { Trade } from '../model/model';
import { manualBuyOnBreeze } from '../processes/order/breezeExecutor';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const contract: FnoRecord = { token: 'BZ1', instrumentName: 'OPTIDX', shortName: 'NIFTY', series: 'OPTION', expiryDate: '17-Nov-2026', strikePrice: '25150', optionType: 'CE', lotSize: 65, tickSize: 0.05, companyName: 'NIFTY', exchange: 'NFO' };

async function main() {
    const placed: any[] = [];
    const booked: Trade[] = [];
    const registered: Trade[] = [];
    let fill: () => Promise<number> = async () => 120;

    const breeze: any = Breeze.getInstance();
    breeze.hasValidSession = async () => true;
    breeze.placeOrder = async (o: any) => { placed.push(o); return { orderId: `O${placed.length}` }; };
    // Breeze's own quote is stale: ask/ltp 100 while ANT's live ask is 120.
    breeze.getQuotes = async () => ({ Success: [{ best_bid_price: '99', best_offer_price: '100', ltp: '100' }] });
    breeze.getFillPrice = async () => fill();
    breeze.cancelOrder = async () => undefined;
    (BreezeOrderNotifyStream.getInstance() as any).waitForFill = async () => fill();
    (ANT.getInstance() as any).getLiveQuote = async () => ({ ltp: 118, bid: 117, ask: 120 });
    (BreezeContractMaster.getInstance() as any).findNearestExpiryOption = async () => contract;
    (BreezeContractMaster.getInstance() as any).findATMOption = async () => contract;
    (AntContractMaster.getInstance() as any).findExactOption = () => ({ token: 'A1', exch: 'NFO', tradingSymbol: 'x', lotSize: '65' });
    (bookkeeping as any).recordFill = async (t: Trade) => { booked.push(t); };

    // 1. canonical contract, default quantity (one lot), full fill.
    const trade = await manualBuyOnBreeze({ userId: 'BreezeUser', contract: 'NIFTY_25150_CE', targetPoints: 10, stopLossPoints: 5 });
    assert(placed.length === 1 && placed[0].action === 'buy' && placed[0].orderType === 'limit' && placed[0].exchangeCode === 'NFO', 'one limit buy placed on Breeze');
    assert(Number(placed[0].price) === 120, 'limit is the widest of the sources (ANT ask 120, not Breeze 100)');
    assert(Number(placed[0].quantity) === 65, 'default quantity is one lot');
    assert(trade.broker === 'breeze' && trade.token === 'BZ1' && trade.quantity === 65 && trade.price === 120 && trade.right === 'call', 'trade is a Breeze Buy on the contract token');
    assert(trade.targetPrice === 130 && trade.stopLossPrice === 115, 'target/stop levels set from the fill price (in-app exit, no GTT on Breeze)');
    assert(booked.length === 1 && booked[0] === trade, 'fill booked once');

    // 2. quantity that is not a whole number of lots: refused before any order.
    const before = placed.length;
    let err = '';
    try { await manualBuyOnBreeze({ userId: 'BreezeUser', contract: 'NIFTY_25150_CE', quantity: 70 }); } catch (e: any) { err = e.message; }
    assert(/multiple of the lot size/.test(err) && placed.length === before, 'non-lot quantity refused, nothing placed');

    // 3. strikePrice branch and index-ATM-free refusal when neither contract nor right.
    const t3 = await manualBuyOnBreeze({ userId: 'BreezeUser', right: 'put', strikePrice: 25150, quantity: 130 });
    assert(t3.quantity === 130 && placed[placed.length - 1].quantity === '130', 'strikePrice branch honours an explicit lot-multiple quantity');
    err = '';
    try { await manualBuyOnBreeze({ userId: 'BreezeUser' }); } catch (e: any) { err = e.message; }
    assert(/requires either contract or right/.test(err), 'neither contract nor right is refused');

    // 4. partial fill: the filled quantity is booked (with exit levels) and returned, not thrown away.
    fill = async () => { throw Object.assign(new Error('only partially filled'), { driftCancelled: true, filledQuantity: 65, averagePrice: 101 }); };
    const nBooked = booked.length;
    const t4 = await manualBuyOnBreeze({ userId: 'BreezeUser', contract: 'NIFTY_25150_CE', quantity: 130, targetPoints: 10, stopLossPoints: 5 });
    assert(t4.quantity === 65 && t4.price === 101 && booked.length === nBooked + 1 && booked[booked.length - 1].stopLossPrice === 96, 'partial fill booked once with exit levels and returned');

    // 5. nothing filled and cancelled cleanly: error propagates, nothing booked.
    fill = async () => { throw new Error('Breeze order did not fill within timeout'); };
    const nBooked5 = booked.length;
    err = '';
    try { await manualBuyOnBreeze({ userId: 'BreezeUser', contract: 'NIFTY_25150_CE' }); } catch (e: any) { err = e.message; }
    assert(/did not fill/.test(err) && booked.length === nBooked5, 'unfilled buy errors and books nothing');

    // 6. admin mirror hook receives a breeze leg whose place() buys through the same path for the admin.
    fill = async () => 120;
    let leg: any;
    await manualBuyOnBreeze({ userId: 'BreezeUser', contract: 'NIFTY_25150_CE', quantity: 130, mirror: (l) => { leg = l; } });
    assert(leg && leg.broker === 'breeze' && leg.token === 'BZ1' && leg.quantity === 130 && leg.exchange === 'NFO', 'mirror hook gets a breeze leg');
    const adminTrade: Trade = await leg.place('admin@x', 65);
    assert(adminTrade.user === 'admin@x' && adminTrade.quantity === 65 && adminTrade.broker === 'breeze', 'the admin share is a Breeze buy for the admin user');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
