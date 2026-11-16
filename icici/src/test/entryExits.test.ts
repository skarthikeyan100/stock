/**
 * Resting limit entries with exits to attach on the fill (src/processes/order/entryExits.ts): the row is durable, claimed once by the fill, dropped on a cancel.
 * attachProtection itself needs a booked trade and a broker, so here it is reached only as far as its own refusal (no open trade): the row must still be claimed once.
 * Run: npx tsc, then node ./dist/test/entryExits.test.js
 */
import { installFakeDb } from './fakeDb';
import { Trade } from '../model/model';
import { registerEntryExit, onEntryFill, onEntryCancelled } from '../processes/order/entryExits';

let failed = 0;
const assert = (c: boolean, m: string) => { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) { failed++; process.exitCode = 1; } };
const buy = (user: string, orderId: string) => { const t = new Trade(); t.action = 'Buy'; t.user = user; t.brokerOrderId = orderId; t.tsym = 'NIFTY26NOV24150CE'; t.price = 140; t.quantity = 65; return t; };

async function main() {
    const db = installFakeDb();
    const col = () => db.collection('entryExits');
    const row = (userId: string, orderId: string) => ({ userId, orderId, tsym: 'NIFTY26NOV24150CE', token: '1', exchange: 'NFO' as const, broker: 'kite' as const, targetPrice: 160, stopLossPrice: 120 });
    await registerEntryExit(row('c@x.com', 'o1'));
    await registerEntryExit(row('boss@x.com', 'o2'));
    assert((await col().find({}).toArray()).length === 2 && (await col().findOne({ orderId: 'o1' }) as any).day === new Date().toLocaleDateString('en-CA'), 'a resting entry is recorded with its day');
    await onEntryFill('c@x.com', { ...buy('c@x.com', 'other') } as Trade);
    assert((await col().find({}).toArray()).length === 2, 'a fill of some other order touches nothing');
    const sell = buy('c@x.com', 'o1'); sell.action = 'Sell';
    await onEntryFill('c@x.com', sell);
    assert((await col().find({}).toArray()).length === 2, 'a sell never claims an entry');
    await onEntryFill('c@x.com', buy('c@x.com', 'o1'));
    assert((await col().findOne({ orderId: 'o1' })) === null && (await col().findOne({ orderId: 'o2' })) !== null, 'the fill claims exactly its own row (the admin\'s mirror row is separate)');
    await onEntryFill('c@x.com', buy('c@x.com', 'o1')); // a repeated fill event
    assert((await col().find({}).toArray()).length === 1, 'a repeated fill event finds nothing left to attach');
    await onEntryCancelled('boss@x.com', 'o2');
    assert((await col().find({}).toArray()).length === 0, 'an entry that ended unfilled drops its exits');
    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
