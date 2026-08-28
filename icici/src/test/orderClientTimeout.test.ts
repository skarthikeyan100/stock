/**
 * Verifies OrderClient.request() rejects with a timeout error (instead of
 * hanging forever) when the order process never sends a response for a
 * pending request, and that a normal response still resolves correctly and
 * cleans up after itself. Overrides the private REQUEST_TIMEOUT_MS to a
 * short value so the test doesn't have to wait out the real production
 * timeout (90s by default - see OrderClient.ts).
 * Run: npm run build (compile), then: node ./dist/test/orderClientTimeout.test.js
 */

import OrderClient from '../processes/strategies/OrderClient';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    // --- Scenario 1: no response ever arrives -> must reject, not hang ---

    // TS `private static` is a compile-time-only restriction and doesn't
    // survive an `as any` cast, so this reaches the real field used by
    // request().
    (OrderClient as any).REQUEST_TIMEOUT_MS = 200;

    // Deliberately NOT OrderClient.getInstance() - a plain `new` so this test
    // never touches the real singleton other code paths rely on.
    const client: any = new OrderClient();
    // Simulate an already-connected socket that accepts writes but never
    // delivers a response - the scenario that used to hang forever.
    client.socket = { write: (_data: string) => true };
    client.connected = true;

    const start = Date.now();
    let caught: Error | null = null;
    try {
        await client.request('stats', 'Default', {});
    } catch (e: any) {
        caught = e;
    }
    const elapsed = Date.now() - start;

    assert(caught !== null, 'request() rejects instead of hanging when no response ever arrives');
    assert(!!caught && /timed out/i.test(caught.message), `rejection error mentions timeout (got: ${caught?.message})`);
    assert(elapsed < 2000, `rejection happens promptly, well under a hard 2s test ceiling (got ${elapsed}ms)`);
    assert(client.pending.size === 0, 'timed-out request is removed from the pending map (no leak)');

    // --- Scenario 2: a normal response before the timeout still resolves,
    // and does not leave a stray timer able to fire later ---

    (OrderClient as any).REQUEST_TIMEOUT_MS = 5000;
    const client2: any = new OrderClient();
    client2.connected = true;
    let sentId: string | null = null;
    client2.socket = {
        write: (data: string) => {
            const msg = JSON.parse(data);
            sentId = msg.id;
        },
    };

    const resultPromise = client2.request('stats', 'Default', {});
    // Simulate the order process replying, the same way OrderClient's own
    // readJsonLines handler in connect() does: delete from `pending` first,
    // then resolve.
    const waiter = client2.pending.get(sentId);
    client2.pending.delete(sentId);
    waiter.resolve({ kind: 'response', id: sentId, ok: true, result: { hello: 'world' } });

    const result = await resultPromise;
    assert(result?.result?.hello === 'world', 'a normal response still resolves correctly');
    assert(client2.pending.size === 0, 'resolved request is removed from the pending map');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
