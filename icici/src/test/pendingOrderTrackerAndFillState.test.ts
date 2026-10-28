/**
 * Pending-order tracker (all four brokers share it), the shared fill-wait tail (cancelThenRecheck) and the "order may be live"
 * propagation through buyChunked.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/pendingOrderTrackerAndFillState.test.js (from repo root)
 */
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import { PendingOrderTracker, OrderStatus, PendingOrder } from '../processes/order/pendingOrderTracker';
import { buyChunked } from '../processes/order/chunkedOrder';
import { cancelThenRecheck, fillStateUnknownError } from '../util/fillWait';
import { BrokerExecutor } from '../processes/order/BrokerExecutor';
import { markNotPlaced, isNotPlaced } from '../util/notPlaced';

function assert(condition: boolean, message: string) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`);
    if (!condition) process.exitCode = 1;
}

interface TestOrder extends PendingOrder { token: string }
const order = (orderId: string, quantity = 75): TestOrder => ({ orderId, userId: 'U1', tradingSymbol: 'NIFTYTEST', token: 'TOK', quantity, exchange: 'NFO', action: 'Sell' });

function makeTracker(statuses: Map<string, OrderStatus>, opts: { bookAtAnyPrice?: boolean; rowPrice?: number } = {}) {
    return new PendingOrderTracker<TestOrder, null, 'ant'>({
        broker: 'ant',
        collection: 'testPendingOrders',
        label: 'Test',
        tokenOf: (o) => o.token,
        bookAtAnyPrice: opts.bookAtAnyPrice,
        statusOf: async (o) => statuses.get(o.orderId) ?? { status: 'PENDING' },
        rowPrice: () => opts.rowPrice ?? NaN,
        fromDoc: (row) => row as TestOrder,
    });
}

async function main() {
    const booked: Trade[] = [];
    (bookkeeping as any).recordFill = async (t: Trade) => { booked.push(t); };

    // 1. COMPLETE books the whole order at the fill price and untracks it
    {
        const statuses = new Map<string, OrderStatus>([['A1', { status: 'COMPLETE', fillPrice: 101.5 }]]);
        const tracker = makeTracker(statuses);
        tracker.track(order('A1'));
        booked.length = 0;
        await tracker.poll();
        assert(booked.length === 1 && booked[0].quantity === 75 && booked[0].price === 101.5 && booked[0].broker === 'ant' && booked[0].token === 'TOK', 'COMPLETE books qty/price/broker/token');
        assert(tracker.find('U1', 'NIFTYTEST').length === 0, 'COMPLETE untracks the order');
    }

    // 2. COMPLETE with no usable price: kept tracked and not booked, unless the adapter books at any price
    {
        const statuses = new Map<string, OrderStatus>([['A2', { status: 'COMPLETE' }]]);
        const strict = makeTracker(statuses);
        strict.track(order('A2'));
        booked.length = 0;
        await strict.poll();
        assert(booked.length === 0 && strict.find('U1', 'NIFTYTEST').length === 1, 'no price: not booked, still tracked');
        const lenient = makeTracker(statuses, { bookAtAnyPrice: true });
        lenient.track(order('A2'));
        await lenient.poll();
        assert(booked.length === 1 && booked[0].price === 0, 'bookAtAnyPrice books at 0');
    }

    // 3. CANCELLED after a partial fill: the partial is booked, listeners hear only the remainder
    {
        const statuses = new Map<string, OrderStatus>([['A3', { status: 'CANCELLED', fillPrice: 100, filledQuantity: 40 }]]);
        const tracker = makeTracker(statuses);
        const heard: number[] = [];
        tracker.onCancelled((_u, _t, _tok, qty) => { heard.push(qty); });
        tracker.track(order('A3'));
        booked.length = 0;
        await tracker.poll();
        assert(booked.length === 1 && booked[0].quantity === 40, 'partial fill booked');
        assert(heard.length === 1 && heard[0] === 35, 'listeners told the unfilled remainder (35)');
        assert(tracker.find('U1', 'NIFTYTEST').length === 0, 'cancelled order untracked');
    }

    // 4. skipListener leaves re-placement to the next morning; a throwing listener does not stop the others
    {
        const statuses = new Map<string, OrderStatus>([
            ['A4', { status: 'CANCELLED', skipListener: true }],
            ['A5', { status: 'CANCELLED' }],
        ]);
        const tracker = makeTracker(statuses);
        const heard: string[] = [];
        tracker.onCancelled(() => { throw new Error('listener boom'); });
        tracker.onCancelled((_u, _t, _tok, _q, _e, _a, _b, orderId) => { heard.push(orderId); });
        tracker.track(order('A4'));
        tracker.track(order('A5'));
        await tracker.poll();
        assert(heard.length === 1 && heard[0] === 'A5', 'skipListener suppresses A4; a throwing first listener does not block the second for A5');
    }

    // 5. resolveFill hook (ANT's trade-book path) decides the booked quantity/price
    {
        const statuses = new Map<string, OrderStatus>([['A6', { status: 'CANCELLED', filledQuantity: 20 }]]);
        const tracker = new PendingOrderTracker<TestOrder, null, 'ant'>({
            broker: 'ant', collection: 'testPendingOrders', label: 'Test', tokenOf: (o) => o.token,
            statusOf: async (o) => statuses.get(o.orderId) ?? { status: 'PENDING' },
            resolveFill: async () => ({ quantity: 20, price: 99 }),
            fromDoc: (row) => row as TestOrder,
        });
        const heard: number[] = [];
        tracker.onCancelled((_u, _t, _tok, qty) => { heard.push(qty); });
        tracker.track(order('A6'));
        booked.length = 0;
        await tracker.poll();
        assert(booked.length === 1 && booked[0].quantity === 20 && booked[0].price === 99 && heard[0] === 55, 'resolveFill booked 20 @ 99, remainder 55 reported');
    }

    // 6. cancelThenRecheck: the re-check always runs; cancelFailed is explicit
    {
        const r1 = await cancelThenRecheck({ label: 't', cancel: async () => { throw undefined; }, recheck: async (failed) => ({ outcome: failed ? 'full' : 'none', avgPrice: 5 }) as any });
        assert(r1.cancelFailed && r1.result?.outcome === 'full', 'a cancel that rejects with undefined still counts as failed, and the re-check ran');
        const r2 = await cancelThenRecheck({ label: 't', cancel: async () => {}, recheck: async () => { throw new Error('recheck down'); } });
        assert(!r2.cancelFailed && !!r2.recheckError && r2.result === undefined, 'a failing re-check is reported, not swallowed');
        const e = fillStateUnknownError('x', true) as any;
        assert(e.fillStateUnknown === true && e.orderMayBeLive === true && !e.driftCancelled, 'fillStateUnknownError flags (not driftCancelled)');
    }

    // 7. buyChunked: a drift-cancel partial whose cancel failed is returned with orderMayBeLive; an unknown fill state is thrown with the flags
    {
        const exec = (buy: (n: number) => Promise<Trade>): BrokerExecutor => ({ brokerName: 'kite', buy: async (r: any) => buy(r.quantity) } as any);
        const filled = (q: number) => Object.assign(new Trade(), { quantity: q, price: 100 });
        let call = 0;
        const live = await buyChunked(exec(async (q) => {
            call++;
            if (call === 1) return filled(q);
            throw Object.assign(new Error('drift'), { driftCancelled: true, filledQuantity: 10, averagePrice: 101, orderMayBeLive: true });
        }), { userId: 'U1', tradingSymbol: 'T', instrumentId: 'I', quantity: 200, exchange: 'NFO' } as any, 100);
        assert(live.quantity === 110 && live.orderMayBeLive === true, 'booked 100 + 10 returned, flagged orderMayBeLive');

        let threw: any;
        call = 0;
        try {
            await buyChunked(exec(async (q) => {
                call++;
                if (call === 1) return filled(q);
                throw fillStateUnknownError('chunk 2', true);
            }), { userId: 'U1', tradingSymbol: 'T', instrumentId: 'I', quantity: 200, exchange: 'NFO' } as any, 100);
        } catch (e) { threw = e; }
        assert(!!threw && threw.fillStateUnknown === true && threw.orderMayBeLive === true && threw.filledQuantity === 100, 'unknown fill state thrown with flags and the 100 already booked');

        let refused: any;
        try {
            await buyChunked(exec(async () => { throw markNotPlaced(new Error('margin')); }), { userId: 'U1', tradingSymbol: 'T', instrumentId: 'I', quantity: 100, exchange: 'NFO' } as any, 100);
        } catch (e) { refused = e; }
        assert(!!refused && isNotPlaced(refused), 'a clean refusal of the first chunk stays "not placed"');
    }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
