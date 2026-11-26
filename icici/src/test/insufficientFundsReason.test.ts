/**
 * The broker's own refusal reason must reach the strategy, so a refusal for insufficient funds can be recognised (insufficientFunds.ts):
 * Kite (rejected after acceptance), Prism (rejected order-book row) and ANT (HTTP 4xx refusal body). Stubbed brokers, no network.
 * Run: npx tsc, then: node ./dist/test/insufficientFundsReason.test.js
 */
import Kite from '../kite/Kite';
import Prism from '../prism';
import ANT, { antAxiosInstance } from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import { getExecutorByBroker } from '../processes/order/brokerExecutors';
import { isInsufficientFunds } from '../strategy/insufficientFunds';
import { isNotPlaced } from '../util/notPlaced';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}
const failure = async (p: () => Promise<any>): Promise<any> => { try { await p(); } catch (e) { return e; } return undefined; };

(async () => {
    console.log('kite: REJECTED with a status_message');
    const kite: any = Kite.getInstance();
    kite.kc = { getOrderHistory: async () => [{ status: 'REJECTED', filled_quantity: 0, status_message: 'Insufficient funds. Required margin is 95417.84 but available margin is 74251.80.' }] };
    let e = await failure(() => kite.getFillPrice('K1', 1, 1));
    assert(isInsufficientFunds(e) && isNotPlaced(e) && /Kite order K1 REJECTED/.test(e.message), `reason on the error, still definitely not placed: ${e?.message}`);
    kite.kc = { getOrderHistory: async () => [{ status: 'CANCELLED', filled_quantity: 0 }] };
    e = await failure(() => kite.getFillPrice('K2', 1, 1));
    assert(e.message === 'Kite order K2 CANCELLED', 'no reason: the message is unchanged');

    console.log('ant: the placement is answered with HTTP 400');
    const ant: any = ANT.getInstance();
    ant.authHeader = () => ({});
    (antAxiosInstance as any).post = async () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { status: 'Not_Ok', message: 'RED:Margin Shortfall:INR 10.00 Available:INR 1.00' } } }); };
    e = await failure(() => ant.submitOrder('placeOrder', [{ instrumentId: '1' }]));
    assert(isInsufficientFunds(e) && isNotPlaced(e) && /status code 400/.test(e.message), `reason on the error, still definitely not placed: ${e?.message}`);

    console.log('prism: the order-book row is REJECTED with a rejreason');
    const realPrism: any = Prism.getInstance();
    const rejreason = 'RED:Margin Shortfall:INR 1425466.76 Available:INR 162095.21 for C-X [SHOONYA]';
    const st = await realPrism.getOrderStatus('P1', [{ norenordno: 'P1', status: 'REJECTED', fillshares: '0', rejreason }]);
    assert(st.status === 'REJECTED' && st.reason === rejreason, 'getOrderStatus reports the reason');
    (Prism as any).instance = { placeLimitBuyBare: async () => ({ orderId: 'P2' }), getOrderStatus: async () => ({ status: 'REJECTED', filledQuantity: 0, reason: rejreason }), currentToken: () => 't', getOrderBook: async () => [] };
    (ANT as any).instance = { getLiveQuote: async () => ({ ltp: 100, bid: 99.95, ask: 100.05 }) };
    (AntContractMaster as any).getInstance = () => ({ findByAnyBrokerTradingSymbol: () => undefined });
    e = await failure(() => getExecutorByBroker('prism', 'test').marketBuy('U', 'NIFTY01DEC26C25900', 'tok', 65, 'NFO'));
    assert(isInsufficientFunds(e) && isNotPlaced(e), `the buy's error carries the reason: ${e?.message}`);

    console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
})().catch((e) => { console.log(e); process.exit(1); });
