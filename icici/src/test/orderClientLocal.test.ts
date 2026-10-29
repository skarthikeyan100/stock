/**
 * OrderClient in-process mode (the merged trading process, review decision 2): requests reach the order handler without a socket,
 * results and pushed notifications are JSON-cloned like the socket path, failures and timeouts surface the same way.
 * Run: node ./dist/test/orderClientLocal.test.js
 */
import OrderClient from '../processes/strategies/OrderClient';
import type { OrderRequest, OrderResponse } from '../ipc/orderProtocol';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

async function main() {
    const client: any = OrderClient.getInstance();
    assert(client.isConnected() === false, 'not connected before a handler is attached');

    const source = { allowed: true, nested: { n: 1 }, when: new Date('2026-10-29T10:00:00Z') };
    let seen: OrderRequest | undefined;
    let mode: 'ok' | 'notok' | 'throw' | 'hang' = 'ok';
    client.useLocalServer(async (req: OrderRequest): Promise<OrderResponse> => {
        seen = req;
        if (mode === 'throw') throw new Error('handler blew up');
        if (mode === 'hang') return new Promise<OrderResponse>(() => {});
        if (mode === 'notok') return { kind: 'response', id: req.id, ok: false, error: 'refused: limit' };
        return { kind: 'response', id: req.id, ok: true, result: source };
    });
    assert(client.isConnected() === true, 'attaching the handler marks the client connected');
    client.connect(); // must not open a socket
    assert(client.socket === null, 'connect() is a no-op in-process (no socket)');

    const payload = { a: 1 };
    const result = await client.canPlaceOrder('u1');
    assert(result.allowed === true && seen?.type === 'canPlaceOrder' && seen?.userId === 'u1', 'a request reaches the handler and its result comes back');
    result.nested.n = 99;
    assert(source.nested.n === 1, 'the returned result is a clone: mutating it cannot touch the order side\'s object');
    assert(typeof result.when === 'string', 'values are JSON-serialised like the socket path (Date becomes a string)');
    void payload;

    mode = 'notok';
    let err = '';
    try { await client.canPlaceOrder('u1'); } catch (e: any) { err = e.message; }
    assert(err === 'refused: limit', 'an ok:false response throws the order side\'s error text');

    mode = 'throw';
    err = '';
    try { await client.canPlaceOrder('u1'); } catch (e: any) { err = e.message; }
    assert(err === 'handler blew up', 'a throwing handler rejects the caller with its message');

    mode = 'hang';
    (OrderClient as any).REQUEST_TIMEOUT_MS = 200;
    err = '';
    try { await client.canPlaceOrder('u1'); } catch (e: any) { err = e.message; }
    assert(/timed out/.test(err), 'a handler that never answers hits the normal request timeout');

    // Pushed notifications
    const fills: any[] = [];
    const cancels: any[] = [];
    let positions = 0;
    client.onFill((userId: string, trade: any, openQuantity?: number) => fills.push({ userId, trade, openQuantity }));
    client.onCancelled((userId: string, n: any) => cancels.push({ userId, n }));
    client.onPositionsChanged(() => { positions++; });
    const trade = { tsym: 'X', quantity: 65 };
    client.deliverLocal({ kind: 'fill', userId: 'u1', trade, openQuantity: 65 });
    client.deliverLocal({ kind: 'cancelled', userId: 'u1', tradingSymbol: 'X', reason: 'cancelled' });
    client.deliverLocal({ kind: 'positionsChanged' });
    assert(fills.length === 1 && fills[0].userId === 'u1' && fills[0].openQuantity === 65, 'a fill push reaches the fill handler with its net quantity');
    assert(fills[0].trade !== trade && fills[0].trade.quantity === 65, 'the pushed trade is a clone');
    assert(cancels.length === 1 && cancels[0].n.tradingSymbol === 'X' && positions === 1, 'cancelled and positionsChanged pushes are delivered too');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
    process.exit(process.exitCode ?? 0);
}
main();
