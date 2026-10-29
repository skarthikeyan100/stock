/**
 * A partial sell must shrink the leg before the retry (review R5-5): a leg of 100 whose first sell confirms 40 retries with 60, not 100.
 * Run: node ./dist/test/legManagerPartialSell.test.js
 */
import ContinuousStrategy from '../strategy/ContinuousStrategy';
import { PartialSellError } from '../strategy/LegBrokerOps';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const lm = (new ContinuousStrategy('ContinuousStrategy') as any).legManager;
    const sells: number[] = [];
    let partial: number | null = 40;
    lm.currentOps = () => ({
        sell: async (_u: string, _t: string, _k: string, qty: number) => {
            sells.push(qty);
            if (partial !== null) { const p = partial; partial = null; throw new PartialSellError('only part confirmed', p); }
        },
    });
    const leg = { tsym: 'NIFTYX', token: 't1', exchange: 'NFO', totalQuantity: 100, avgPrice: 100, lastLtp: 110 };

    let threw = false;
    try { await lm.sellLeg(leg); } catch (e) { threw = e instanceof PartialSellError; }
    assert(threw, 'the partial sell still surfaces as a failure');
    assert(leg.totalQuantity === 60, `the leg shrinks by what was confirmed sold (left ${leg.totalQuantity})`);
    assert(lm.realizedPnL === 400, `the sold part's P&L is booked once (got ${lm.realizedPnL})`);

    await lm.sellLeg(leg);
    assert(sells.join(',') === '100,60', `the retry sells only the remaining 60 (sell sizes: ${sells.join(',')})`);

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
