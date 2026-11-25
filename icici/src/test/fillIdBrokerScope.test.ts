/**
 * Fill dedupe is scoped to the broker. Live 2026-11-25 13:34: ANT buy 26112500161991 (NIFTY01DEC26P25700) collided with a Shoonya/Prism buy of ANOTHER contract
 * stored under the same Noren-style id at 11:17, so recordFill dropped the ANT fill as 'already stored in Mongo', the open row never existed in memory and the
 * later sell hit 'has no open position in memory'.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/fillIdBrokerScope.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }

const docs: any[] = [];
import { matches } from './fakeMongoMatch';
const fakeDb = {
    collection: (name: string) => ({
        find: (f: any) => { const c: any = { sort: () => c, toArray: async () => (name === 'Trade' ? docs.filter((d) => matches(d, f ?? {})) : []), project: () => c }; return c; },
        findOne: async (f: any) => (name === 'Trade' ? docs.find((d) => matches(d, f)) ?? null : null),
        insertOne: async () => ({}), createIndex: async () => ({}),
        updateOne: async () => ({ upsertedCount: 1 }), updateMany: async () => ({}), deleteOne: async () => ({}), replaceOne: async () => ({}), countDocuments: async () => 0,
    }),
};
(Mongo as any).instance = { db: fakeDb, insert: async (obj: any) => { docs.push({ ...obj }); } };
const b: any = bookkeeping;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buy(user: string, broker: string, tsym: string, id: string, qty = 195, price = 204.3): Trade {
    const t = new Trade(); t.tsym = tsym; t.token = '47836'; t.quantity = qty; t.price = price; t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = broker as any; t.brokerOrderId = id;
    return t;
}
const open = (user: string, broker: string, tsym: string) => b.trades.find((t: Trade) => t.user === user && t.broker === broker && t.tsym === tsym && Number(t.quantity) > 0);

async function main() {
    b.trades.length = 0; b.closedTrades.length = 0; b.processedFillIds.clear(); docs.length = 0;
    const ID = '26112500161991';
    // 11:17 Prism buy of another contract under the same id
    await bookkeeping.recordFill(buy('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26C25950', ID, 195, 264.63));
    await sleep(50);
    assert(!!open('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26C25950'), 'prism buy registered');
    // 13:34 ANT buy of the hedge contract with the SAME id (executor path)
    await bookkeeping.recordFill(buy('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', ID));
    await sleep(50);
    const antRow = open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700');
    assert(!!antRow && antRow.quantity === 195, 'ANT buy with a colliding Noren id is registered in memory (not dropped as already stored)');
    assert(docs.filter((d) => d.brokerOrderId === ID).length === 2, 'both raw fill docs stored (one per broker)');
    // same-second Prism buy of the same contract name, other user, own id
    await bookkeeping.recordFill(buy('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26P25700', '26112500300163'));
    await sleep(50);
    assert(open('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26P25700')?.quantity === 195 && open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195, 'same contract name on ANT and Prism: two separate rows, 195 each');
    // genuine redelivery on the same broker is still ignored (in-process and after a restart: processedFillIds cleared, Mongo doc stays)
    await bookkeeping.recordFill(buy('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', ID));
    assert(open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195, 'in-process redelivery on the same broker is ignored');
    b.processedFillIds.clear();
    await bookkeeping.recordFill(buy('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', ID));
    assert(open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195, 'redelivery after a restart (id only in Mongo) on the same broker is ignored');
    // the resting sell then books against the in-memory row (no 'no open position' path)
    const sell = buy('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', '26112500162000', 195, 214.3); sell.action = 'Sell';
    await bookkeeping.recordFill(sell);
    await sleep(50);
    assert(!open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700') && !!open('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26P25700'), 'ANT sell closes the ANT row; the Prism user\'s row is unaffected');
    assert(b.closedTrades.some((c: any) => c.user === 'SimpleContinuousStrategy-ANT' && c.tsym === 'NIFTY01DEC26P25700'), 'closed trade written from the in-memory row');
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
