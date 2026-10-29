/**
 * LegManager buys and sells go through the chunked path (review R5-6): a 3510-lot order becomes freeze-sized chunks, a later chunk's
 * failure after earlier fills returns the filled part (buy) or a PartialSellError carrying it (sell), and a first-chunk failure throws.
 * Run: node ./dist/test/chunkedLegOps.test.js
 */
import { Trade } from '../model/model';
import { marketBuyBareChunked } from '../processes/order/chunkedOrder';
import { chunkedLegSell, PartialSellError } from '../strategy/LegBrokerOps';
import OrderClient from '../processes/strategies/OrderClient';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

function fakeExecutor(failOnCall: number | null) {
    const sizes: number[] = [];
    const ex: any = {
        marketBuy: async (_u: string, tsym: string, token: string, qty: number) => {
            sizes.push(qty);
            if (failOnCall !== null && sizes.length === failOnCall) throw new Error('rejected');
            return Object.assign(new Trade(), { tsym, token, quantity: qty, price: 100 + sizes.length, action: 'Buy', status: 'COMPLETE' });
        },
    };
    return { ex, sizes };
}

async function main() {
    const a = fakeExecutor(null);
    const t = await marketBuyBareChunked(a.ex, 'u', 'NIFTYX', 'tok', 3510, 'NFO', 1755);
    assert(a.sizes.join(',') === '1755,1755' && t.quantity === 3510, `3510 splits into two freeze-sized orders (sizes ${a.sizes.join(',')}, filled ${t.quantity})`);
    assert(t.price === 101.5, `the returned price is volume-weighted (${t.price})`);

    const one = fakeExecutor(null);
    const single = await marketBuyBareChunked(one.ex, 'u', 'NIFTYX', 'tok', 650, 'NFO', 1755);
    assert(one.sizes.join(',') === '650' && single.quantity === 650, 'a small order is still one order');

    const b = fakeExecutor(2);
    const partial = await marketBuyBareChunked(b.ex, 'u', 'NIFTYX', 'tok', 3510, 'NFO', 1755);
    assert(partial.quantity === 1755, 'a second-chunk failure returns the 1755 that did fill (so it is tracked), not an error');

    const c = fakeExecutor(1);
    let threw = false;
    try { await marketBuyBareChunked(c.ex, 'u', 'NIFTYX', 'tok', 3510, 'NFO', 1755); } catch { threw = true; }
    assert(threw, 'a first-chunk failure with nothing filled propagates');

    // chunkedLegSell: partial results and mid-run failures both become PartialSellError carrying what sold.
    const oc: any = OrderClient.getInstance();
    oc.chunkedSquareOff = async () => ({ quantity: 1000, avgPrice: 100 });
    let err: any;
    try { await chunkedLegSell('u', 'NIFTYX', 3510); } catch (e) { err = e; }
    assert(err instanceof PartialSellError && err.soldQty === 1000, 'a stopped run (1000/3510 confirmed) -> PartialSellError(1000)');

    oc.chunkedSquareOff = async () => { throw new Error('squareOffChunked: chunk 2/2 failed after selling 1755/3510 - 1755 qty NOT sold. Manual review required.'); };
    err = undefined;
    try { await chunkedLegSell('u', 'NIFTYX', 3510); } catch (e) { err = e; }
    assert(err instanceof PartialSellError && err.soldQty === 1755, 'a chunk failing after 1755 sold -> PartialSellError(1755)');

    oc.chunkedSquareOff = async () => { throw new Error('squareOffChunked: chunk 1/2 failed after selling 0/3510 - nothing sold'); };
    err = undefined;
    try { await chunkedLegSell('u', 'NIFTYX', 3510); } catch (e) { err = e; }
    assert(err && !(err instanceof PartialSellError), 'a first-chunk failure stays an ordinary error');

    oc.chunkedSquareOff = async () => ({ quantity: 3510, avgPrice: 100 });
    err = undefined;
    try { await chunkedLegSell('u', 'NIFTYX', 3510); } catch (e) { err = e; }
    assert(err === undefined, 'a fully confirmed sell returns normally');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
