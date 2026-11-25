/**
 * Breeze order terminal-state classification (live 2026-11-25 11:53, order 202611253800004502: status Cancelled, cancelled_quantity 195,
 * pending_quantity 195, average_price 0). A Cancelled order with 0 filled is final and, with a failed second cancel, counts as cancelled
 * through cancelOrderWithFillRecheck. Mocks only. Run: node ./dist/test/breezeOrderTerminal.test.js
 */
import { classifyBreezeOrderRecord } from '../processes/order/breezeExecutor';
import { cancelOrderWithFillRecheck, OrderAlreadyFilledError } from '../processes/order/BrokerExecutor';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

const live = { status: 'Cancelled', quantity: '195', cancelled_quantity: '195', pending_quantity: '195', average_price: '0' };

async function run(record: any, cancelFails: boolean): Promise<string> {
    let untracked = false;
    try {
        await cancelOrderWithFillRecheck({
            orderId: 'x', label: 't',
            cancel: async () => { if (cancelFails) throw new Error('Modification/Cancellation of Order is not possible:Please verify the order status'); },
            isFilled: async () => { const c = classifyBreezeOrderRecord(record); return { filledQuantity: c.filledQuantity, terminal: c.terminal }; },
            untrack: () => { untracked = true; }, beginCancel: () => {}, endCancel: () => {}, silenceListeners: () => {},
        });
        return untracked ? 'cancelled' : 'left-tracked';
    } catch (e: any) {
        return e instanceof OrderAlreadyFilledError ? 'filled' : 'error';
    }
}

async function main() {
    let c = classifyBreezeOrderRecord(live);
    assert(c.terminal && c.filledQuantity === 0, 'exact live payload: Cancelled, cancelled 195, pending 195, filled 0 -> terminal, 0 filled');
    assert((await run(live, true)) === 'cancelled', 'live payload + failed cancel -> treated as cancelled (no manual review)');
    assert((await run(live, false)) === 'cancelled', 'live payload + successful cancel -> cancelled');

    c = classifyBreezeOrderRecord({ status: 'Ordered', quantity: '195', cancelled_quantity: '0', pending_quantity: '195', average_price: '0' });
    assert(!c.terminal && c.filledQuantity === 0, 'still-open Ordered payload -> not terminal');
    assert((await run({ status: 'Ordered', quantity: '195', cancelled_quantity: '0', pending_quantity: '195', average_price: '0' }, true)) === 'error', 'open + failed cancel -> cancel error rethrown, stays tracked');
    c = classifyBreezeOrderRecord({ status: 'Partially Executed', quantity: '195', cancelled_quantity: '0', pending_quantity: '65', average_price: '220' });
    assert(!c.terminal && c.filledQuantity === 130, 'Partially Executed -> not terminal, real filled 130');

    const part = { status: 'Cancelled', quantity: '195', cancelled_quantity: '65', pending_quantity: '65', average_price: '220' };
    c = classifyBreezeOrderRecord(part);
    assert(c.terminal && c.filledQuantity === 130 && c.avgPrice === 220, 'partial then cancelled (pending stale) -> terminal, filled 130');
    assert((await run(part, true)) === 'filled', 'partial then cancelled + failed cancel -> OrderAlreadyFilledError (partial path)');

    c = classifyBreezeOrderRecord({ status: 'Executed', quantity: '195', cancelled_quantity: '0', pending_quantity: '0', average_price: '221' });
    assert(c.terminal && c.filledQuantity === 195, 'Executed -> terminal, full fill');
    c = classifyBreezeOrderRecord({ status: 'Rejected', quantity: '195', cancelled_quantity: '0', pending_quantity: '0', average_price: '0' });
    assert(c.terminal && c.filledQuantity === 0, 'Rejected -> terminal, 0 filled');
    c = classifyBreezeOrderRecord({ status: 'EXPIRED ', quantity: '195', cancelled_quantity: '0', pending_quantity: '195', average_price: '0' });
    assert(c.terminal && c.filledQuantity === 0, 'casing/whitespace variant Expired -> terminal');
    c = classifyBreezeOrderRecord({ status: 'cancelled', quantity: '195', cancelled_quantity: '195', pending_quantity: '0', average_price: '' });
    assert(c.terminal && c.filledQuantity === 0, 'lower-case cancelled, blank average_price -> terminal, 0');
    c = classifyBreezeOrderRecord({ status: 'SomethingNew', quantity: '195', cancelled_quantity: '0', pending_quantity: '0', average_price: '0' });
    assert(!c.terminal, 'unknown status -> not terminal (fail closed)');
    c = classifyBreezeOrderRecord({ quantity: '195', cancelled_quantity: '0', pending_quantity: '0', average_price: '221' });
    assert(c.terminal && c.filledQuantity === 195, 'no status, pending 0 -> legacy terminal full fill');
    c = classifyBreezeOrderRecord({ quantity: '195', cancelled_quantity: '0', pending_quantity: '195', average_price: '0' });
    assert(!c.terminal, 'no status, pending > 0 -> not terminal');

    console.log(process.exitCode === 1 ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
