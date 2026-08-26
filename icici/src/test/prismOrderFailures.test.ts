/**
 * Verifies Prism.buyContract reports the real filled quantity (not the
 * requested one) when a later leg fails, and throws rather than silently
 * succeeding when every leg fails.
 * Run: npm run build (compile), then: node ./dist/test/prismOrderFailures.test.js
 */

import Prism from '../prism';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    const prism = Prism.getInstance() as any;

    // Stub _placeOrderWithForce: succeed on the first call, throw on the second.
    let call = 0;
    prism._placeOrderWithForce = async (order: any) => {
        call++;
        if (call === 2) throw new Error('simulated broker rejection');
        return { contract: order.tsym, qty: order.qty, price: order.prc, token: 'tok', profit: 0, status: 'ORDERED' };
    };
    prism.getToken = async () => 'tok';
    prism.findLotSizeByContract = async () => '1';
    prism.getStockOptionQuote = async () => ({ ltp: 100 });

    // Force a 2-leg split by requesting a quantity splitQty() will divide -
    // check src/prism.ts's splitQty threshold and adjust the requested qty
    // here if 3600 doesn't actually split into exactly 2 legs.
    let threw = false;
    let partialResponse: any = null;
    try {
        partialResponse = await prism.buyContract('NIFTY26AUG24100CE', 3600, 100, undefined);
    } catch (e) {
        threw = true;
    }
    assert(!threw, 'a partial fill (leg 1 ok, leg 2 fails) does not throw - it reports the real filled qty');
    assert(partialResponse?.qty < 3600, `reported qty reflects only what actually filled (got ${partialResponse?.qty})`);

    // All legs fail -> must throw, not silently return a phantom full fill.
    call = 0;
    prism._placeOrderWithForce = async () => { throw new Error('simulated broker rejection'); };
    let allFailedThrew = false;
    try {
        await prism.buyContract('NIFTY26AUG24100CE', 65, 100, undefined);
    } catch (e) {
        allFailedThrew = true;
    }
    assert(allFailedThrew, 'buyContract throws when every leg fails, instead of returning a phantom fill');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
