/**
 * All four brokers implement the same BrokerExecutor interface with no capability special-cases (review R6-9: Prism stays and matches
 * Kite / ANT / Breeze). Structural check for every broker, plus the Prism behaviours that used to differ: limit buy, contract by price
 * range, a partial buy fill that is booked before the error, and NFO-only exchange handling.
 * Run: node ./dist/test/brokerParityMatrix.test.js
 */
import { KiteExecutor, AntExecutor, PrismExecutor, BreezeExecutor } from '../processes/order/brokerExecutors';
import * as priceRange from '../processes/order/antExecutor';
import Prism from '../prism';
import PrismContractMaster from '../prism/PrismContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import bookkeeping from '../processes/order/bookkeeping';
import * as pendingPrism from '../processes/order/pendingPrismLimitOrders';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const METHODS = ['enterShort', 'buyToClose', 'marketBuy', 'marketSell', 'placeLimitBuy', 'getLiveQuantity', 'resolveContract',
    'getContractByPriceRange', 'findPendingOrders', 'buy', 'squareOff', 'squareOffLimit', 'cancelOrder'];

async function main() {
    for (const ex of [KiteExecutor, AntExecutor, PrismExecutor, BreezeExecutor]) {
        const missing = METHODS.filter((m) => typeof (ex as any)[m] !== 'function');
        assert(missing.length === 0, `${ex.brokerName} implements the whole interface${missing.length ? ' (missing ' + missing.join(',') + ')' : ''}`);
        assert((ex as any).capabilities === undefined, `${ex.brokerName} has no capability flags left`);
    }

    // ---- Prism behaviours ----
    const prism: any = Prism.getInstance();
    const placed: any[] = [];
    prism.placeLimitBuyBare = async (...args: any[]) => { placed.push(args); return { orderId: 'P-1' }; };
    const r = await PrismExecutor.placeLimitBuy('u', 'NIFTY26N0322500CE', 'tokA', 130, 98.5, 'NFO');
    assert(r.orderId === 'P-1' && placed[0][3] === 98.5, 'Prism placeLimitBuy places a limit buy at the given price');
    assert(pendingPrism.findPendingOrdersForSymbol('u', 'NIFTY26N0322500CE').some((o) => o.orderId === 'P-1' && o.action === 'Buy'), 'and tracks it as a pending Buy so its fill is booked later');

    // contract by price range: same strike priority as the other brokers
    (priceRange as any).estimateOptionPricesBatch = async (_i: string, c: { strike: number; optionType: string }[]) =>
        new Map(c.map((x) => [`${x.strike}_${x.optionType}`, { premium: x.strike === 22700 ? 120 : 40, antToken: 'ant-' + x.strike }]));
    (PrismContractMaster as any).getInstance = () => ({ findNearestExpiryOption: (_i: string, strike: number, right: string) => ({ token: String(strike), tradingSymbol: `NIFTY${strike}${right}` }) });
    (AntContractMaster as any).getInstance = () => ({
        findNearestExpiryOption: (p: any) => ({ token: 'a' + p.strike, tradingSymbol: `NIFTY${p.strike}${p.optionType}`, exch: 'NFO', lotSize: '65' }),
        // ANT's price-range pick resolves the contract from the token the premium came from (ant-<strike> in the stub above).
        findByToken: (t: string) => { const strike = Number(t.replace('ant-', '')); return { token: t, strike, optionType: 'CE', exch: 'NFO', tradingSymbol: `NIFTY${strike}CE`, lotSize: '65' }; },
    });
    const c = await PrismExecutor.getContractByPriceRange(22750, 'CE', 'NIFTY', 100, new Set());
    assert(c.strike === 22700 && c.premium === 120 && c.antToken === 'ant-22700' && c.lotSize === 65 && c.tradingSymbol === 'NIFTY22700CE', 'Prism getContractByPriceRange picks the first strike clearing the premium, with ANT token and lot size');
    const ca = await AntExecutor.getContractByPriceRange(22750, 'CE', 'NIFTY', 100, new Set());
    assert(ca.strike === 22700 && ca.antToken === 'ant-22700', 'ANT getContractByPriceRange behaves the same');
    let threw = false;
    try { await PrismExecutor.getContractByPriceRange(22750, 'CE', 'NIFTY', 100, new Set([22700])); } catch { threw = true; }
    assert(threw, 'an excluded strike is skipped, and nothing clearing the premium throws the shared error');

    // NFO only
    for (const [name, call] of [
        ['squareOff', () => PrismExecutor.squareOff('u', 'X', 1, 'BFO')],
        ['cancelOrder', () => PrismExecutor.cancelOrder('o', 'BFO')],
        ['placeLimitBuy', () => PrismExecutor.placeLimitBuy('u', 'X', 't', 1, 1, 'BFO')],
        ['getContractByPriceRange', () => PrismExecutor.getContractByPriceRange(80000, 'CE', 'SENSEX', 100, new Set())],
    ] as [string, () => Promise<unknown>][]) {
        let err = '';
        try { await call(); } catch (e: any) { err = String(e?.message); }
        assert(/NFO only/.test(err), `Prism ${name} refuses BFO instead of treating it as NFO`);
    }

    // A buy cancelled after a partial fill is booked before the error surfaces.
    prism.getStockOptionQuote = async () => ({ ltp: 100 });
    prism.placeLimitBuyBare = async () => ({ orderId: 'P-2' });
    prism.getOrderStatus = async () => ({ status: 'CANCELED', filledQuantity: 40, fillPrice: 100 });
    let partial: any;
    try {
        await PrismExecutor.buy({ userId: 'PrismPartialUser', tradingSymbol: 'NIFTY26N0322600CE', brokerToken: 'tokP', quantity: 130, exchange: 'NFO' } as any);
    } catch (e) { partial = e; }
    const row = bookkeeping.trades.find((t) => t.user === 'PrismPartialUser' && t.tsym === 'NIFTY26N0322600CE');
    assert(partial?.partial === true && partial.filledQuantity === 40, 'the partial fill still surfaces on the error');
    assert(!!row && row.quantity === 40 && row.broker === 'prism', 'and the 40 lots that did fill are booked (not orphaned at the broker)');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
