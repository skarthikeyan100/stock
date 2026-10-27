/**
 * Verifies the restart-reconcile fill netting: one owner per broker order id, per-user FIFO netting, ambiguity is not guessed.
 * Shapes are the real 2026-10-27 incident (a Kite sell booked under two users; two strategies sharing one Kite contract).
 * Run: npm run build (compile), then: node ./dist/test/fillNetting.test.js
 */

import { collapseFillsByOrderId, netFifoLots, FillDoc } from '../processes/order/fillNetting';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

let t = 0;
function fill(user: string, action: 'Buy' | 'Sell', quantity: number, price: number, brokerOrderId?: string): FillDoc {
    return { user, action, quantity, price, brokerOrderId, entryTime: ++t };
}

function heldBy(fills: FillDoc[], user: string): number {
    return netFifoLots(fills.filter((f) => f.user === user)).reduce((s, l) => s + l.remaining, 0);
}

console.log('A sell booked under two users: the ledger owner keeps it, the other copy is dropped');
{
    const fills = [
        fill('BulkPcr-NIFTY', 'Buy', 1690, 57, 'B1'),
        fill('ContinuousStrategy', 'Buy', 130, 58.75, 'C1'),
        fill('ContinuousStrategy', 'Sell', 1690, 59.8, 'S1'), // wrong owner, booked first
        fill('BulkPcr-NIFTY', 'Sell', 1690, 59.8, 'S1'),      // re-booked after the restart
    ];
    const r = collapseFillsByOrderId(fills, (id) => (id === 'S1' ? 'BulkPcr-NIFTY' : undefined));
    assert(r.ambiguousOrderIds.length === 0, 'owner known -> not ambiguous');
    assert(heldBy(r.fills, 'BulkPcr-NIFTY') === 0, 'BulkPcr nets to 0 (its sell counts)');
    assert(heldBy(r.fills, 'ContinuousStrategy') === 130, 'ContinuousStrategy keeps its 130 (the sell is not charged to it)');
}

console.log('The same sell under two users and no recorded owner: ambiguous, never guessed');
{
    const fills = [
        fill('BulkPcr-NIFTY', 'Buy', 1690, 57, 'B1'),
        fill('ContinuousStrategy', 'Sell', 1690, 59.8, 'S1'),
        fill('BulkPcr-NIFTY', 'Sell', 1690, 59.8, 'S1'),
    ];
    const r = collapseFillsByOrderId(fills, () => undefined);
    assert(r.ambiguousOrderIds.length === 1 && r.ambiguousOrderIds[0] === 'S1', 'S1 reported ambiguous');
}

console.log('A ledger owner that is not among the booked users does not resolve it');
{
    const fills = [fill('A', 'Sell', 10, 1, 'S1'), fill('B', 'Sell', 10, 1, 'S1')];
    const r = collapseFillsByOrderId(fills, () => 'C');
    assert(r.ambiguousOrderIds.length === 1, 'still ambiguous');
}

console.log('One user booking the same order twice counts it once');
{
    const fills = [fill('U', 'Buy', 100, 50, 'B1'), fill('U', 'Sell', 40, 55, 'S1'), fill('U', 'Sell', 40, 55, 'S1')];
    const r = collapseFillsByOrderId(fills, () => undefined);
    assert(r.fills.length === 2 && r.ambiguousOrderIds.length === 0, 'duplicate dropped');
    assert(heldBy(r.fills, 'U') === 60, 'holds 60, not 20');
}

console.log('Two owners sharing one contract with no sells (Kite 22800CE): 1690 + 390 = 2080');
{
    const fills = [
        fill('BulkPcr-NIFTY', 'Buy', 1690, 58.75, 'B1'),
        fill('ContinuousStrategy', 'Buy', 130, 62.5, 'C1'),
        fill('ContinuousStrategy', 'Buy', 130, 53.5, 'C2'),
        fill('ContinuousStrategy', 'Buy', 130, 42.45, 'C3'),
    ];
    const r = collapseFillsByOrderId(fills, () => undefined);
    assert(r.fills.length === 4 && r.ambiguousOrderIds.length === 0, 'nothing dropped, nothing ambiguous');
    assert(heldBy(r.fills, 'BulkPcr-NIFTY') === 1690, 'BulkPcr holds 1690');
    assert(heldBy(r.fills, 'ContinuousStrategy') === 390, 'ContinuousStrategy holds 390');
    assert(heldBy(r.fills, 'BulkPcr-NIFTY') + heldBy(r.fills, 'ContinuousStrategy') === 2080, 'sums to the broker net of 2080');
}

console.log('FIFO: a partial sell consumes the oldest lot first');
{
    const lots = netFifoLots([fill('U', 'Buy', 100, 10), fill('U', 'Buy', 50, 20), fill('U', 'Sell', 120, 30)]);
    assert(lots.length === 1 && lots[0].remaining === 30 && lots[0].doc.price === 20, 'leaves 30 of the second lot');
}

console.log('Fills without an order id are untouched');
{
    const fills = [fill('U', 'Buy', 10, 1), fill('U', 'Buy', 10, 1)];
    const r = collapseFillsByOrderId(fills, () => undefined);
    assert(r.fills.length === 2, 'both kept');
}
