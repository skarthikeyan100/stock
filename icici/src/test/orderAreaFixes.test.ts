/**
 * Focused checks for the order-process review fixes: exitMonitor aggregate sizing / zero-LTP guard /
 * broker-keyed entries, pending-reservation identity release, chunkedOrder partial-failure metadata.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/orderAreaFixes.test.js (from repo root)
 */
import { OptionQuote, Trade } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';
import bookkeeping from '../processes/order/bookkeeping';
import { buyChunked, squareOffChunked } from '../processes/order/chunkedOrder';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const mk = (user: string, token: string, qty: number, broker: any, target?: number, sl?: number): Trade => {
    const t = new Trade();
    t.tsym = `T${token}`; t.token = token; t.quantity = qty; t.price = 100; t.lastTradePrice = 100;
    t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = broker; t.targetPrice = target; t.stopLossPrice = sl;
    return t;
};
const tick = (token: string, ltp: number) => Object.assign(new OptionQuote(), { token, ltp });

async function main() {
    // 1. zero LTP must not trigger a stop-loss exit
    const exits: Trade[] = [];
    exitMonitor.onExit('kite', async (t) => { exits.push(t); });
    const a = mk('U1', 'TOK1', 65, 'kite', 150, 90);
    exitMonitor.registerTrade(a, 'NFO', 'kite');
    await exitMonitor.handleOptionTick(tick('TOK1', 0));
    assert(exits.length === 0, 'ltp 0 does not trigger SL exit');

    // 2. exit sized off the aggregate row, not the detached chunk
    const aggregate = mk('U1', 'TOK1', 195, 'kite');
    exitMonitor.setAggregateResolver((t, broker) => (t.token === 'TOK1' && broker === 'kite' ? aggregate : undefined));
    await exitMonitor.handleOptionTick(tick('TOK1', 80));
    assert(exits.length === 1 && exits[0].quantity === 195, 'exit uses the aggregate quantity (195), not the chunk (65)');
    assert(aggregate.lastTradePrice === 80, 'aggregate lastTradePrice refreshed from tick');
    exitMonitor.setAggregateResolver(() => undefined);

    // 3. same user+token on two brokers are independent entries
    const kiteExits: Trade[] = []; const antExits: Trade[] = [];
    exitMonitor.onExit('kite', async (t) => { kiteExits.push(t); });
    exitMonitor.onExit('ant', async (t) => { antExits.push(t); });
    exitMonitor.registerTrade(mk('U2', 'TOK2', 10, 'kite', 150, 90), 'NFO', 'kite');
    exitMonitor.registerTrade(mk('U2', 'TOK2', 20, 'ant', 150, 90), 'NFO', 'ant');
    await exitMonitor.handleOptionTick(tick('TOK2', 200));
    assert(kiteExits.length === 1 && antExits.length === 1, 'kite and ant entries for the same user+token both fire');

    // 4. reservation identity release inside an async context
    const e1 = bookkeeping.markPending('PU', 100, 'kite');
    const e2 = bookkeeping.markPending('PU', 100, 'kite');
    await bookkeeping.runWithReservation('PU', e1, async () => {
        bookkeeping.releasePending('PU', 'kite'); // chunk 1 fill
        bookkeeping.releasePending('PU', 'kite'); // chunk 2 fill - must not drain e2
    });
    assert((bookkeeping.pendingOrders.get('PU') ?? []).length === 1 && bookkeeping.pendingOrders.get('PU')![0] === e2, "chunk fills release only their own request's reservation");
    bookkeeping.releaseReservation('PU', e2);
    assert(!bookkeeping.pendingOrders.has('PU'), 'identity release clears the remaining reservation');

    // 5. chunkedOrder partial-failure metadata
    let n = 0;
    const exec: any = {
        brokerName: 'kite',
        buy: async (r: any) => { if (++n > 1) throw new Error('boom'); const t = new Trade(); t.quantity = r.quantity; t.price = 50; return t; },
        squareOff: async (_u: string, _s: string, q: number) => { if (++n > 1) throw new Error('boom'); const t = new Trade(); t.quantity = q; t.price = 50; return t; },
    };
    try {
        await buyChunked(exec, { userId: 'x', tradingSymbol: 'NIFTY1', brokerToken: '1', quantity: 3000, exchange: 'NFO' }, 1000);
        assert(false, 'buyChunked should throw');
    } catch (e: any) {
        assert(e.filledQuantity === 1000 && e.averagePrice === 50 && e.partial === true, 'buyChunked error carries filledQuantity/averagePrice');
    }
    n = 0;
    try {
        await squareOffChunked(exec, 'x', 'NIFTY1', 3000, 'NFO', 1000);
        assert(false, 'squareOffChunked should throw');
    } catch (e: any) {
        assert(e.filledQuantity === 1000 && e.partial === true, 'squareOffChunked error carries filledQuantity');
    }
    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
