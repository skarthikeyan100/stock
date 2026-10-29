/**
 * brokerLegOps (review R7-1/R7-4): one LegManager ops implementation that names the broker on every order call, replacing the ANT-only
 * ops and the default ops. Strategies never branch on a broker; SupportResistance with `broker: ant` now gets a working contract pick.
 * Run: node ./dist/test/legBrokerOps.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import { brokerLegOps, defaultLegOps, PartialSellError } from '../strategy/LegBrokerOps';
import { HEDGE_UNCONFIRMED_TAG } from '../ipc/orderProtocol';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const calls: { fn: string; args: any[] }[] = [];
    let buyError: Error | null = null;
    const oc: any = OrderClient.getInstance();
    oc.getContractByPriceRangeBare = async (...args: any[]) => { calls.push({ fn: 'pick', args }); return { tradingSymbol: 'NIFTY22700CE', antToken: 777, exchange: 'NFO', strike: 22700, premium: 120 }; };
    oc.buyContractBare = async (...args: any[]) => { calls.push({ fn: 'buy', args }); if (buyError) throw buyError; return { quantity: 65, price: 100 }; };
    oc.chunkedSquareOff = async (...args: any[]) => { calls.push({ fn: 'sell', args }); return { quantity: 65, avgPrice: 101 }; };
    oc.cancelOrderBare = async (...args: any[]) => { calls.push({ fn: 'cancel', args }); };
    oc.placeLimitBuyBare = async (...args: any[]) => { calls.push({ fn: 'limit', args }); return { orderId: 'L1' }; };

    for (const broker of ['ant', 'kite', 'breeze'] as const) {
        calls.length = 0;
        const ops = brokerLegOps(() => broker);
        const c = await ops.pickContract('u', 22750, 'CE', 100, [22800]);
        await ops.buy('u', 'NIFTY22700CE', '777', 65, 'NFO', 120);
        await ops.sell('u', 'NIFTY22700CE', '777', 65, 'NFO');
        await ops.cancel('u', 'o1', 'NFO');
        await ops.buyLimit('u', 'NIFTY22700CE', '777', 65, 'NFO', 99);
        const named = calls.map((x) => x.fn === 'pick' ? x.args[6] : x.fn === 'buy' ? x.args[6] : x.fn === 'sell' ? x.args[1].broker : x.fn === 'cancel' ? x.args[3] : x.args[6]);
        assert(named.length === 5 && named.every((b) => b === broker), `${broker}: every call (pick, buy, sell, cancel, limit buy) names the broker`);
        assert(c.token === '777' && c.strike === 22700 && c.premium === 120, `${broker}: the pick returns the ANT token and premium`);
        assert(calls[1].args[5] === 120, `${broker}: the premium hint reaches the buy (capital reservation)`);
    }

    // No broker key: route by the user's configured broker, exactly as before.
    calls.length = 0;
    await defaultLegOps.pickContract('u', 22750, 'CE', 100, []);
    await defaultLegOps.sell('u', 'T', 't', 65, 'NFO');
    assert(calls[0].args[6] === undefined && calls[1].args[1].broker === undefined, 'no broker configured: calls carry no broker (user routing)');

    // Unresolved fill is tagged so LegManager flags the tree for review instead of retrying a possibly-live buy.
    buyError = new Error('ANT order fill status unresolved after timeout');
    let tagged = '';
    try { await brokerLegOps(() => 'ant').buy('u', 'T', 't', 65, 'NFO', 100); } catch (e: any) { tagged = e.message; }
    assert(tagged.startsWith(HEDGE_UNCONFIRMED_TAG), 'an unresolved buy fill is tagged HEDGE_UNCONFIRMED');
    buyError = new Error('insufficient margin');
    let plain = '';
    try { await brokerLegOps(() => 'kite').buy('u', 'T', 't', 65, 'NFO', 100); } catch (e: any) { plain = e.message; }
    assert(plain === 'insufficient margin', 'any other buy error passes through unchanged');

    // A short sell result still becomes a PartialSellError (sold quantity carried).
    oc.chunkedSquareOff = async () => ({ quantity: 30, avgPrice: 100 });
    let err: any;
    try { await brokerLegOps(() => 'kite').sell('u', 'T', 't', 65, 'NFO'); } catch (e) { err = e; }
    assert(err instanceof PartialSellError && err.soldQty === 30, 'a partial sell result surfaces as PartialSellError(30)');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
