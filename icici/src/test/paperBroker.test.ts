/**
 * The paper broker (processes/order/paperExecutor.ts) and HighLowStrategy's pure pieces: the two-candle signal, config validation, instance
 * expansion. Nothing here touches Mongo or a real broker.
 * Run: npx tsc, then: node ./dist/test/paperBroker.test.js
 */
import '../util/tz';
import bookkeeping from '../processes/order/bookkeeping';
import { PaperExecutor, onPaperTick, resetPaperBook, PAPER_TRACKER } from '../processes/order/paperExecutor';
import { getExecutorByBroker } from '../processes/order/brokerExecutors';
import { OrderAlreadyFilledError } from '../processes/order/BrokerExecutor';
import { highLowSignal } from '../strategy/HighLowStrategy';
import { validateConfigFile } from '../prism/configValidation';
import { expandBrokerInstances, instanceUserIdFor } from '../util/strategyInstances';
import { isBrokerName, isUserBroker, normalizeBrokerName } from '../util/brokerName';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const USER = 'PaperTestUser';
const TSYM = 'NIFTY26NOV24100CE';
const TOK = 'paperTok1';

async function main() {
    console.log('HighLow signal');
    const c1 = { high: 100, low: 90 };
    assert(highLowSignal(c1, { close: 110 }) === 'CE', 'close 10 above c1 high = CE');
    assert(highLowSignal(c1, { close: 109.9 }) === undefined, 'close 9.9 above c1 high = none');
    assert(highLowSignal(c1, { close: 101 }) === undefined, 'close above c1 high by less than 10 = none');
    assert(highLowSignal(c1, { close: 80 }) === 'PE', 'close 10 below c1 low = PE');
    assert(highLowSignal(c1, { close: 80.1 }) === undefined, 'close 9.9 below c1 low = none');
    assert(highLowSignal(c1, { close: 89 }) === undefined, 'close below c1 low by less than 10 = none');
    assert(highLowSignal(c1, { close: 95 }) === undefined, 'close inside c1 range = none');
    assert(highLowSignal(c1, { close: 100 }) === undefined, 'close equal c1 high = none');
    assert(highLowSignal({ high: 25360.85, low: 25340 }, { close: 25370.85 }) === 'CE', 'float: 25360.85 + 10 = CE');
    assert(highLowSignal({ high: NaN, low: 90 }, { close: 101 }) === undefined, 'NaN = none');

    console.log('broker names');
    assert(isBrokerName('paper') && normalizeBrokerName(' Paper ') === 'paper', 'paper is a broker name');
    assert(!isUserBroker('paper'), 'paper is not a user broker');
    assert(instanceUserIdFor('HighLow-NIFTY', 'paper') === 'HighLow-NIFTY-Paper', 'instance suffix');
    assert(getExecutorByBroker('paper') === PaperExecutor, 'executor lookup');

    console.log('config validation');
    const base = { type: 'HighLowStrategy', enabled: true, userId: 'H', brokers: ['paper'], target: 10, stopLoss: 8 };
    const check = (blk: any, settings: any = {}) => validateConfigFile({ settings, strategies: [{ ...base, ...blk }] });
    assert(check({ quantity: 130 }).length === 0, 'quantity alone is valid');
    assert(check({ maxInvestment: 100000 }).length === 0, 'maxInvestment alone is valid');
    assert(check({}).some((e) => /exactly one of quantity or maxInvestment/.test(e)), 'neither is refused');
    assert(check({ quantity: 130, maxInvestment: 100000 }).some((e) => /exactly one/.test(e)), 'both is refused');
    assert(check({ quantity: 100 }).some((e) => /multiple of the NIFTY lot/.test(e)), 'non-lot quantity refused');
    assert(check({ quantity: 130, stopLoss: 'none' }).some((e) => /stopLoss must not be 'none'/.test(e)), "stopLoss 'none' refused");
    assert(check({ quantity: 130, target: undefined }).some((e) => /target is not set/.test(e)), 'missing target refused');
    assert(check({ quantity: 130, trailDistance: -1 }).some((e) => /trailDistance/.test(e)), 'bad trailDistance refused');
    assert(check({ quantity: 130, brokers: ['nope'] }).some((e) => /unknown broker/.test(e)), 'unknown broker refused');
    assert(expandBrokerInstances({ type: 'HighLowStrategy', userId: 'H', brokers: ['paper', 'kite'] } as any).length === 1, 'HighLow is one multi-broker instance');

    console.log('paper executor: buy fills at once, after the call returned');
    resetPaperBook();
    const placed = await PaperExecutor.placeLimitBuy(USER, TSYM, TOK, 130, 100, 'NFO');
    assert(typeof placed.orderId === 'string' && placed.orderId.startsWith('PAPER-'), 'returns an order id');
    assert(bookkeeping.trades.filter((t) => t.user === USER).length === 0, 'not booked before the caller has the id');
    await wait();
    let open = bookkeeping.trades.filter((t) => t.user === USER && t.broker === 'paper');
    assert(open.length === 1 && open[0].quantity === 130 && open[0].price === 100, 'booked in memory at the limit price');
    assert(await PaperExecutor.getLiveQuantity(TSYM) === 130, 'live quantity = 130');
    try { await PaperExecutor.cancelOrder(placed.orderId); assert(false, 'cancel of a filled order throws'); } catch (e) { assert(e instanceof OrderAlreadyFilledError && e.filledQuantity === 130, 'cancel of a filled order = OrderAlreadyFilledError(130)'); }

    console.log('paper executor: resting sell fills on a crossing tick only');
    const sell = await PaperExecutor.squareOffLimit(USER, TSYM, TOK, 130, 'NFO', 110);
    assert(sell.quantity === 130 && PAPER_TRACKER.find(USER, TSYM).length === 1, 'sell rests');
    await onPaperTick({ token: TOK, ltp: 109.5 });
    assert(bookkeeping.trades.some((t) => t.user === USER && t.broker === 'paper' && t.quantity === 130), 'below the limit: still open');
    try { await PaperExecutor.squareOffLimit(USER, TSYM, TOK, 65, 'NFO', 120); assert(false, 'oversell refused'); } catch { assert(true, 'a second sell beyond the held quantity is refused (never short)'); }
    await onPaperTick({ token: TOK, ltp: 110.5 });
    assert(!bookkeeping.trades.some((t) => t.user === USER && t.broker === 'paper'), 'at/above the limit: sold, position closed');
    const closed = bookkeeping.closedTrades.filter((t) => t.user === USER && t.broker === 'paper');
    assert(closed.length === 1 && closed[0].realizedPnL === 1300, `closed at the limit price: P&L 1300 (got ${closed[0]?.realizedPnL})`);
    assert(PAPER_TRACKER.find(USER, TSYM).length === 0, 'book is empty');

    console.log('paper executor: squareOff cancels the resting sell and sells the rest at the last tick');
    await PaperExecutor.placeLimitBuy(USER, TSYM, TOK, 130, 100, 'NFO');
    await wait();
    await PaperExecutor.squareOffLimit(USER, TSYM, TOK, 65, 'NFO', 130);
    await onPaperTick({ token: TOK, ltp: 95 });
    const exit = await PaperExecutor.squareOff(USER, TSYM, 130, 'NFO');
    assert(exit.quantity === 130 && exit.price === 95, `market exit of all 130 at the last tick 95 (got ${exit.quantity} @ ${exit.price})`);
    assert(PAPER_TRACKER.find(USER, TSYM).length === 0 && !bookkeeping.trades.some((t) => t.user === USER && t.broker === 'paper'), 'resting sell cancelled, position flat');
    const flat = await PaperExecutor.squareOff(USER, TSYM, 130, 'NFO');
    assert(flat.quantity === 0, 'square-off of a flat position is an empty trade, not an error');

    console.log('paper executor: nothing is stored in Mongo');
    assert(!bookkeeping.trades.some((t) => t.broker === 'paper' && t.user === USER), 'no leftover');
}

main().catch((e) => { console.log('  FAIL: threw', e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
