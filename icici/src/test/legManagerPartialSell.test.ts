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

    // The fill price the sell reports is what P&L is booked at (R5-14), not the tick that triggered it.
    lm.currentOps = () => ({ sell: async () => ({ quantity: 60, avgPrice: 108.5 }) });
    const px = await lm.sellLeg({ ...leg, totalQuantity: 60 });
    assert(px === 108.5, `sellLeg returns the reported fill price (got ${px})`);
    lm.currentOps = () => ({ sell: async () => undefined });
    assert((await lm.sellLeg({ ...leg, totalQuantity: 60 })) === undefined, 'no reported price -> undefined (the caller falls back to the tick)');

    // A target-hit sell books P&L at the fill, not the trigger tick.
    const strat = new ContinuousStrategy('ContinuousStrategy') as any;
    const lm2 = strat.legManager;
    lm2.currentOps = () => ({ sell: async () => ({ quantity: 65, avgPrice: 104 }) });
    const target = { legId: 'L1', token: 'tk', tsym: 'NIFTYX', strike: 22500, exchange: 'NFO', right: 'call', entryPrice: 100, quantity: 65, isRoot: false,
        parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN', avgPrice: 100, totalQuantity: 65, averagedLevels: new Set(), legRef: 'r', parentLegRef: null };
    lm2.legsByToken.set('tk', target);
    await lm2.onOptionTick('tk', 110); // far above the target: the position actually filled at 104
    assert(lm2.realizedPnL === (104 - 100) * 65, `P&L is booked at the fill price 104, not the 110 tick (got ${lm2.realizedPnL})`);

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
