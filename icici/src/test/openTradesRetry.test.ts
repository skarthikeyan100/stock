/**
 * The shared open-trades retry (review R4-6): retries a failing read, gives the trades back as soon as one read works, and resolves
 * undefined (never throws) when every attempt failed, so each strategy can fail closed in its own way.
 * Run: node ./dist/test/openTradesRetry.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import { fetchOpenTradesWithRetry } from '../strategy/openTrades';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const oc: any = OrderClient.getInstance();
    let calls = 0;
    oc.getOpenTrades = async () => { calls++; if (calls < 3) throw new Error('not connected'); return [{ tsym: 'X', quantity: 65 }]; };
    const ok = await fetchOpenTradesWithRetry('u', 'Test', 5, 1);
    assert(calls === 3 && ok?.length === 1, `two failures then a read: returned on attempt ${calls}`);

    calls = 0;
    oc.getOpenTrades = async () => { calls++; throw new Error('down'); };
    const none = await fetchOpenTradesWithRetry('u', 'Test', 4, 1);
    assert(none === undefined && calls === 4, `all ${calls} attempts failed: undefined, no throw`);

    calls = 0;
    oc.getOpenTrades = async () => { calls++; return []; };
    const empty = await fetchOpenTradesWithRetry('u', 'Test', 5, 1);
    assert(Array.isArray(empty) && empty.length === 0 && calls === 1, 'an empty list is a valid answer (no retry)');
    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
