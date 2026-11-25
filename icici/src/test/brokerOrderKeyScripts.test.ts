/**
 * scripts/migrate-broker-order-keys.js (backfill, dry-run default, idempotent, unattributable docs reported) and
 * scripts/repair-dropped-ant-fill-2026-11-25.js (dry-run default, idempotent, pre-check against the ANT book, post-check) on a fake database.
 * Run: npx tsc, then: node ./dist/test/brokerOrderKeyScripts.test.js
 */
import { matches } from './fakeMongoMatch';
import { normalizeBrokerName } from '../util/brokerName';
import { orderKey } from '../util/orderKey';
const mig = require('../../scripts/migrate-broker-order-keys.js');
const rep = require('../../scripts/repair-dropped-ant-fill-2026-11-25.js');

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }

function makeDb(data: Record<string, any[]>) {
    const idx: string[] = [];
    return {
        data, idx,
        collection: (name: string) => {
            const arr = (data[name] = data[name] ?? []);
            return {
                find: (f: any) => { const rows = arr.filter((d) => matches(d, f ?? {})); const c: any = { toArray: async () => rows, [Symbol.asyncIterator]: async function* () { for (const r of rows) yield r; } }; return c; },
                findOne: async (f: any) => arr.find((d) => matches(d, f)) ?? null,
                insertOne: async (d: any) => { arr.push({ ...d }); return {}; },
                bulkWrite: async (ops: any[]) => { for (const o of ops) { const u = o.updateOne; const d = arr.find((x) => matches(x, u.filter)); if (d) Object.assign(d, u.update.$set); } return {}; },
                createIndex: async (k: any) => { idx.push(`${name}:${JSON.stringify(k)}`); return ''; },
            };
        },
    };
}
const silent = () => undefined;

async function main() {
    console.log('(1) migration');
    assert(['zerodha', 'aliceblue', 'Shoonya', 'ICICI', 'ant', 'xyz'].every((n) => mig.normBroker(n) === normalizeBrokerName(n)), 'the script\'s broker normalisation equals src/util/brokerName.ts');
    assert(mig.keyOf('Zerodha', '7') === orderKey('Zerodha', '7'), 'the script\'s key equals the TypeScript helper\'s');
    const data = () => ({
        Trade: [
            { _id: 1, broker: 'ant', brokerOrderId: 'A1' }, { _id: 2, broker: 'prism', brokerOrderId: 'A1' },
            { _id: 3, broker: 'Zerodha', brokerOrderId: 'K1' }, { _id: 4, brokerOrderId: 'N1' }, { _id: 5, broker: 'ant', brokerOrderId: 'A2', brokerOrderKey: 'ant:A2' }, { _id: 6, broker: 'ant' },
        ],
        closedTrades: [{ _id: 'c1', broker: 'ant', sellOrderId: 'A1', buyOrderId: 'A0' }, { _id: 'c2', broker: 'ant' }],
        orderOwners: [{ _id: 'o1', broker: 'prism', orderId: 'A1' }, { _id: 'o2', orderId: 'Z9' }],
    });
    const db: any = makeDb(data());
    const dry = await mig.migrate(db, { apply: false, log: silent });
    assert(db.data.Trade.every((d: any) => d._id === 5 || d.brokerOrderKey === undefined) && db.idx.length === 0, 'dry run writes nothing (no key, no index)');
    assert(dry.keyed === 5 && dry.unattributable === 2, 'dry run counts 5 to key (3 Trade, 1 closed row, 1 owner) and 2 unattributable (no broker field)');
    const run1 = await mig.migrate(db, { apply: true, log: silent });
    const t = (id: number) => db.data.Trade.find((d: any) => d._id === id);
    assert(t(1).brokerOrderKey === 'ant:A1' && t(2).brokerOrderKey === 'prism:A1' && t(3).brokerOrderKey === 'kite:K1', 'keys written from each doc\'s own broker (ANT and Prism with one id get two keys; Zerodha -> kite)');
    assert(t(4).brokerOrderKey === undefined && t(5).brokerOrderKey === 'ant:A2' && t(6).brokerOrderKey === undefined, 'a doc with no broker stays unkeyed, an existing key is untouched, a doc with no order id is skipped');
    assert(db.data.closedTrades[0].brokerOrderKey === 'ant:A1' && db.data.closedTrades[0].buyOrderKey === 'ant:A0' && db.data.orderOwners[0].brokerOrderKey === 'prism:A1', 'closedTrades (sell + buy key) and orderOwners are keyed');
    assert(db.idx.length === 3, 'the three indexes are ensured on --apply');
    const run2 = await mig.migrate(db, { apply: true, log: silent });
    assert(run1.keyed === 5 && run2.keyed === 0 && run2.unattributable === 2, 'a second run changes nothing (idempotent) and still reports the 2 unattributable docs');
    const run3 = await mig.migrate(db, { apply: true, legacyBroker: 'kite', log: silent });
    assert(t(4).brokerOrderKey === 'kite:N1' && db.data.orderOwners[1].brokerOrderKey === 'kite:Z9' && run3.unattributable === 0, '--legacy-broker keys the broker-less docs as the named broker');

    console.log('(2) repair of the dropped ANT fill');
    const book = { success: true, trades: [
        { brokerOrderId: '26112500161991', transactionType: 'BUY', instrumentId: '47836', filledQuantity: 195, tradedPrice: 204.3 },
        { brokerOrderId: '26112500162000', transactionType: 'SELL', instrumentId: '47836', filledQuantity: 195, tradedPrice: 214.3 },
    ] };
    const positions = { success: true, positions: [{ realizedPnl: 3357.25 }] };
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const exitT = new Date(`${day}T13:00:00+05:30`);
    const mk = () => makeDb({
        Trade: [{ _id: 's', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', action: 'Sell', broker: 'ant', brokerOrderId: '26112500162000', quantity: 195, price: 214.3 }],
        closedTrades: [{ _id: 'x', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', broker: 'ant', quantity: 195, entryPrice: 212.8, exitPrice: 222.8, realizedPnL: 3357.25 - 1950, exitTime: exitT }],
    });
    const rdb: any = mk();
    const dr = await rep.repair(rdb, { apply: false, book, positions, log: silent });
    assert(dr.insertedTrade && dr.insertedClosed && rdb.data.Trade.length === 1 && rdb.data.closedTrades.length === 1, 'dry run reports both inserts and writes none');
    assert(dr.postCheck && Math.abs(dr.postCheck.diff) < 30, 'the dry run\'s post-check projects the platform total equal to ANT\'s own realized');
    const refused = await rep.repair(mk(), { apply: true, book: null, positions, log: silent });
    assert(!!refused.refused && !refused.insertedTrade, 'apply without the ANT book confirming the fills is refused');
    const wrong = await rep.repair(mk(), { apply: true, book: { success: true, trades: [] }, positions, log: silent });
    assert(!!wrong.refused, 'apply is refused when the book does not hold the fills');
    const ap = await rep.repair(rdb, { apply: true, book, positions, log: silent });
    const buyDoc = rdb.data.Trade.find((d: any) => d.action === 'Buy');
    assert(!!buyDoc && buyDoc.brokerOrderId === '26112500161991' && buyDoc.brokerOrderKey === 'ant:26112500161991' && buyDoc.repairedManually === true && buyDoc.status === 'COMPLETE' && buyDoc.token === '47836' && buyDoc.quantity === 195 && buyDoc.price === 204.3 && buyDoc.broker === 'ant' && buyDoc.user === 'SimpleContinuousStrategy-ANT', 'the raw Buy doc has the neighbours\' shape plus brokerOrderKey and repairedManually');
    const row = rdb.data.closedTrades.find((r: any) => r.entryPrice === 204.3);
    assert(!!row && row.exitPrice === 214.3 && row.realizedPnL === 1950 && row.quantity === 195 && row.sellOrderId === '26112500162000' && row.brokerOrderKey === 'ant:26112500162000' && row.exitTime.toISOString() === '2026-11-25T08:05:24.810Z', 'the closedTrades row: entry 204.30, exit 214.30, pnl 1950, sell order 26112500162000 at 08:05:24.8Z');
    assert(ap.postCheck && Math.abs(ap.postCheck.diff) < 30, 'post-check after the apply: Mongo ANT realized equals ANT\'s realizedPnl');
    const again = await rep.repair(rdb, { apply: true, book, positions, log: silent });
    assert(!again.insertedTrade && !again.insertedClosed && rdb.data.Trade.length === 2 && rdb.data.closedTrades.length === 2, 'a second run writes nothing (idempotent)');

    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
