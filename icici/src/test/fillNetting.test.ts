/**
 * Verifies the restart-reconcile fill netting: one owner per broker order id, per-user FIFO netting, ambiguity is not guessed.
 * Shapes are the real 2026-10-27 incident (a Kite sell booked under two users; two strategies sharing one Kite contract).
 * Run: npm run build (compile), then: node ./dist/test/fillNetting.test.js
 */

import { collapseFillsByOrderId, netFifoLots, pairFillsFifo, FillDoc } from '../processes/order/fillNetting';

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

console.log('pairFillsFifo: each Sell closes the oldest Buy lots; a Sell with no Buy is reported, not paired');
{
    const fills = [
        fill('S', 'Buy', 390, 240.1, 'B1'),
        fill('S', 'Sell', 390, 150, 'S1'),          // the 2026-11-11 Breeze Momentum close: one piece, -90.1 x 390
        fill('S', 'Buy', 325, 261.85, 'B2'),
        fill('S', 'Buy', 325, 205, 'B3'),
        fill('S', 'Sell', 650, 157.97, 'S2'),       // closes two lots at once: weighted entry
        fill('S', 'Sell', 65, 100, 'S3'),           // nothing left to close
    ];
    const { pieces, unmatched } = pairFillsFifo(fills);
    assert(pieces.length === 2, 'two closed pieces');
    assert(pieces[0].qty === 390 && pieces[0].entryPrice === 240.1 && pieces[0].sell.brokerOrderId === 'S1', 'first piece: 390 from 240.1 closed by S1');
    assert(pieces[1].qty === 650 && Math.abs(pieces[1].entryPrice - 233.425) < 1e-9, 'second piece: 650 at the weighted entry 233.425');
    assert(unmatched.length === 1 && unmatched[0].qty === 65 && unmatched[0].sell.brokerOrderId === 'S3', 'the sell with no Buy is unmatched');
    const part = pairFillsFifo([fill('S', 'Buy', 100, 10, 'B'), fill('S', 'Sell', 30, 12, 'S'), fill('S', 'Sell', 70, 11, 'T')]);
    assert(part.pieces.length === 2 && part.pieces[0].qty === 30 && part.pieces[1].qty === 70 && part.unmatched.length === 0, 'a partial sell and its remainder are two pieces');
}
