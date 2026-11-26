/**
 * An ANT / Prism entry buy whose outcome the order process cannot establish (cancel failed, status unreadable) is left on the pending-order poller, as
 * Kite and Breeze entry buys already are: a strategy's cancelRestingLimitBuys then finds it (a failed cancel never reads as "nothing rests", which let
 * the buy be placed again), a late fill is booked, and its later cancel is not told to strategies. A buy proven dead is not tracked.
 * Stubbed brokers, no Mongo. Run: npx tsc, then: node ./dist/test/unresolvedEntryBuyTracked.test.js
 */
import ANT from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import Prism from '../prism';
import bookkeeping from '../processes/order/bookkeeping';
import { enterPosition } from '../processes/order/antExecutor';
import { getExecutorByBroker } from '../processes/order/brokerExecutors';
import { TRACKERS } from '../processes/order/pendingTrackers';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
// Prism's fill wait sleeps 2.5 s between its status polls: shortened so the test stays well inside the runner's timeout.
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = (fn: any, ms?: number, ...args: any[]) => realSetTimeout(fn, ms === 2500 ? 1 : ms, ...args);

let status: { status: string; filledQuantity: number; fillPrice?: number } = { status: 'PENDING', filledQuantity: 0 };
let cancelFails = true;
let statusThrows = false;
let orderNo = '';
const cancel = async () => {
    if (cancelFails) throw new Error('cancel refused');
    status = { status: 'CANCELLED', filledQuantity: 0 };
};
const readStatus = async () => {
    if (statusThrows) throw new Error('order book unreadable');
    return status;
};
(ANT as any).instance = {
    placeOrder: async () => ({ orderNo }),
    getLiveQuote: async () => ({ ltp: 100, bid: 99.95, ask: 100.05 }),
    getFillPrice: async () => { throw new Error('no fill within the wait'); },
    getFilledFromTradeBook: async () => ({ quantity: 0, avgPrice: 0 }),
    cancelOrder: cancel,
    getOrderStatus: readStatus,
    hasValidSession: async () => true,
    isOwnOrder: () => true,
};
(AntOrderNotifyStream as any).instance = { waitForFill: async () => { throw new Error('no push'); } };
(AntContractMaster as any).getInstance = () => ({ findByAnyBrokerTradingSymbol: () => undefined });
(Prism as any).instance = {
    placeLimitBuyBare: async () => ({ orderId: orderNo }),
    cancelOrder: cancel,
    getOrderStatus: readStatus,
    getOrderBook: async () => [],
    getPositions: async () => [],
    currentToken: () => 'token',
};

const cancelledSeen: string[] = [];
TRACKERS.ant.onCancelled((...a: any[]) => cancelledSeen.push(String(a[7])));
TRACKERS.prism.onCancelled((...a: any[]) => cancelledSeen.push(String(a[7])));

async function failedBuy(broker: 'ant' | 'prism', id: string, user: string): Promise<any> {
    orderNo = id;
    try {
        await getExecutorByBroker(broker, 'test').marketBuy(user, 'NIFTY01DEC26C25900', 'tok', 65, 'NFO');
    } catch (e) {
        return e;
    }
    return undefined;
}
const reset = () => { status = { status: 'PENDING', filledQuantity: 0 }; cancelFails = true; statusThrows = false; };

async function scenarios(broker: 'ant' | 'prism') {
    console.log(`${broker}: cancel failed, order still open`);
    reset();
    const user = `U-${broker}`;
    const find = () => TRACKERS[broker].find(user, 'NIFTY01DEC26C25900');
    const executor = getExecutorByBroker(broker, 'test');
    const e = await failedBuy(broker, `${broker}-1`, user);
    assert(!!e && e.orderMayBeLive === true && !e.notPlaced, 'the buy fails tagged as possibly live');
    assert(find().length === 1 && find()[0].action === 'Buy' && find()[0].orderId === `${broker}-1` && (find()[0] as any).quiet === true, 'the order is on the pending poller');
    let threw = false;
    try { await executor.cancelOrder(`${broker}-1`, 'NFO'); } catch { threw = true; }
    assert(threw && find().length === 1, 'a later cancel that still fails reports the failure and keeps the order');
    cancelFails = false;
    await executor.cancelOrder(`${broker}-1`, 'NFO');
    assert(find().length === 0, 'a later cancel that succeeds ends the tracking');

    console.log(`${broker}: the poll sees it cancelled`);
    reset();
    await failedBuy(broker, `${broker}-2`, user);
    status = { status: 'CANCELLED', filledQuantity: 0 };
    await TRACKERS[broker].poll();
    assert(find().length === 0 && !cancelledSeen.includes(`${broker}-2`), 'untracked, and no strategy is told of a cancelled order it did not rest');

    console.log(`${broker}: it fills late`);
    reset();
    await failedBuy(broker, `${broker}-3`, user);
    status = { status: 'COMPLETE', filledQuantity: 65, fillPrice: 101 };
    await TRACKERS[broker].poll();
    assert(find().length === 0 && bookkeeping.trades.some((t) => t.user === user && t.brokerOrderId === `${broker}-3` && t.quantity === 65), 'the late fill is booked');

    console.log(`${broker}: proven unfilled`);
    reset();
    cancelFails = false;
    const dead = await failedBuy(broker, `${broker}-4`, user);
    assert(!!dead && !dead.orderMayBeLive && find().length === 0, 'cancelled with 0 filled: not tracked, not tagged');
}

async function main() {
    await scenarios('ant');
    console.log('ant: a cover order parent is not put on the poller');
    reset();
    orderNo = 'ant-cover';
    (ANT as any).instance.placeCoverOrder = async () => ({ orderNo });
    await enterPosition('U-cover', 'NIFTY01DEC26C25900', 'tok', 65, 'NFO', 0, 10, 'cover').catch(() => undefined);
    assert(TRACKERS.ant.find('U-cover', 'NIFTY01DEC26C25900').length === 0, 'not tracked');

    await scenarios('prism');
    console.log('prism: the status read itself fails during the fill wait');
    reset();
    statusThrows = true;
    const e = await failedBuy('prism', 'prism-5', 'U-prism-5');
    assert(!!e && e.orderMayBeLive === true && TRACKERS.prism.find('U-prism-5', 'NIFTY01DEC26C25900').length === 1, 'tracked and tagged: nobody cancelled it');
    console.log('prism: rejected');
    reset();
    status = { status: 'REJECTED', filledQuantity: 0 };
    const r = await failedBuy('prism', 'prism-6', 'U-prism-6');
    assert(!!r && r.orderNotPlaced !== false && !r.orderMayBeLive && TRACKERS.prism.find('U-prism-6', 'NIFTY01DEC26C25900').length === 0, 'not tracked');

    console.log(process.exitCode ? 'FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
