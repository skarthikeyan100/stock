/**
 * The canonical composite order key `<broker>:<orderId>` (util/orderKey.ts) and everything that keys on it. ANT and Prism/Shoonya issue colliding
 * Noren-style order ids (live 2026-11-25: ANT 26112500161991 == an earlier Prism order's id).
 * Covers: the helper and its Mongo filter (keyed and legacy docs), the collision log, the fill dedupe + the persisted brokerOrderKey on Trade and
 * closedTrades rows, a restart (memory cleared, Mongo kept), legacy docs without a key, reservations, the locked-sell ledger and its reload, the strategies'
 * duplicate-delivery guard, the sync's fill keys, and the same-day realized-P&L reconcile on the P25700 scenario.
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/orderKeyBrokerPrefix.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';
import Log from '../util/Log';
import { orderKey, orderKeyOf, orderIdFilter, stampOrderKey, noteOrderId, resetOrderIdCollisionLog, parseOrderKey } from '../util/orderKey';
import { isDuplicateFill, resetSeenFills } from '../processes/strategies/duplicateFill';
import { recordLockedSells, isLockedSell, loadLockedSellsFromMongo } from '../processes/order/lockedSells';
import { matches } from './fakeMongoMatch';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }
const logs: string[] = [];
const realLog = Log.log;
Log.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cols: Record<string, any[]> = { Trade: [], closedTrades: [], lockedSells: [], orderOwners: [] };
const fakeDb = {
    collection: (name: string) => {
        const arr = (cols[name] = cols[name] ?? []);
        return {
            find: (f: any) => { const c: any = { sort: () => c, project: () => c, toArray: async () => arr.filter((d) => matches(d, f ?? {})) }; return c; },
            findOne: async (f: any) => arr.find((d) => matches(d, f)) ?? null,
            insertOne: async (d: any) => { arr.push({ ...d }); return {}; },
            replaceOne: async (f: any, d: any) => { const i = arr.findIndex((x) => matches(x, f)); if (i >= 0) arr[i] = { ...d }; else arr.push({ ...d }); return {}; },
            deleteOne: async (f: any) => { const i = arr.findIndex((x) => matches(x, f)); if (i >= 0) arr.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
            createIndex: async () => ({}), updateOne: async () => ({ upsertedCount: 1 }), updateMany: async () => ({}), countDocuments: async () => 0,
        };
    },
};
(Mongo as any).instance = { db: fakeDb, insert: async (obj: any) => { cols.Trade.push({ ...obj }); } };
const b: any = bookkeeping;

function fill(user: string, broker: string, tsym: string, id: string, action: 'Buy' | 'Sell', qty = 195, price = 204.3): Trade {
    const t = new Trade(); t.tsym = tsym; t.token = '47836'; t.quantity = qty; t.price = price; t.action = action; t.status = 'COMPLETE'; t.user = user; t.broker = broker as any; t.brokerOrderId = id;
    return t;
}
const open = (user: string, broker: string, tsym: string) => b.trades.find((t: Trade) => t.user === user && t.broker === broker && t.tsym === tsym && Number(t.quantity) > 0);

async function main() {
    const ID = '26112500161991';
    console.log('(1) the helper');
    assert(orderKey('ant', ID) === `ant:${ID}` && orderKey('zerodha', '9') === 'kite:9' && orderKey(undefined, '9') === 'kite:9' && orderKey('Shoonya', '1') === 'prism:1', 'one format, legacy broker spellings normalised, none = kite');
    assert(orderKeyOf({ broker: 'ant', brokerOrderId: ID }) === `ant:${ID}` && orderKeyOf({ broker: 'ant' }) === undefined && parseOrderKey(`ant:${ID}`)?.orderId === ID, 'orderKeyOf / parseOrderKey');
    const stamped = stampOrderKey({ broker: 'ant', brokerOrderId: ID } as any);
    assert(stamped.brokerOrderKey === `ant:${ID}`, 'stampOrderKey writes brokerOrderKey beside the raw brokerOrderId');
    const docs = [
        { _id: 1, broker: 'prism', brokerOrderId: ID, brokerOrderKey: `prism:${ID}` },
        { _id: 2, broker: 'ant', brokerOrderId: ID, brokerOrderKey: `ant:${ID}` },
        { _id: 3, broker: 'prism', brokerOrderId: ID }, // legacy, no key
        { _id: 4, brokerOrderId: ID }, // legacy, no key, no broker
        { _id: 5, broker: 'Zerodha', brokerOrderId: ID }, // legacy kite spelling
    ];
    const hit = (broker: string) => docs.filter((d) => matches(d, orderIdFilter(broker, ID))).map((d) => d._id).sort().join(',');
    assert(hit('ant') === '2,4', 'ANT lookup: its keyed doc and the broker-less legacy doc; never the Prism docs (keyed or legacy)');
    assert(hit('prism') === '1,3,4', 'Prism lookup: its keyed and legacy docs and the broker-less legacy doc, not ANT\'s');
    assert(hit('kite') === '4,5', 'Kite lookup: the legacy Zerodha-spelled doc and the broker-less one');

    console.log('(2) the collision log');
    resetOrderIdCollisionLog(); logs.length = 0;
    noteOrderId('prism', ID); noteOrderId('prism', ID);
    assert(logs.length === 0, 'the same broker twice is not a collision');
    noteOrderId('ant', ID); noteOrderId('ant', ID); noteOrderId('prism', ID);
    const col = logs.filter((l) => l.includes('INFO') && l.includes(ID));
    assert(col.length === 1 && col[0].includes('prism') && col[0].includes('ant'), 'exactly one INFO line naming both brokers');
    assert(noteOrderId('ant', ID, Date.now() + 2 * 86400000) === false, 'a new day starts clean');

    console.log('(3) fill dedupe, persisted keys, closed-trade rows, restart');
    b.trades.length = 0; b.closedTrades.length = 0; b.processedFillIds.clear(); for (const k of Object.keys(cols)) cols[k].length = 0;
    resetOrderIdCollisionLog(); logs.length = 0;
    await bookkeeping.recordFill(fill('SimpleContinuousStrategy-Prism', 'prism', 'NIFTY01DEC26C25950', ID, 'Buy', 195, 264.63));
    await sleep(30);
    await bookkeeping.recordFill(fill('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', ID, 'Buy'));
    await sleep(30);
    assert(open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195, 'the ANT buy with the colliding id is registered');
    const raw = cols.Trade.filter((d) => d.brokerOrderId === ID);
    assert(raw.length === 2 && raw.some((d) => d.brokerOrderKey === `prism:${ID}`) && raw.some((d) => d.brokerOrderKey === `ant:${ID}`), 'both raw docs carry brokerOrderId AND brokerOrderKey');
    assert(logs.some((l) => l.includes('INFO') && l.includes('two brokers') && l.includes(ID)), 'the collision was logged');
    b.processedFillIds.clear(); // restart: memory gone, Mongo stays
    await bookkeeping.recordFill(fill('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', ID, 'Buy'));
    assert(open('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195 && cols.Trade.filter((d) => d.brokerOrderKey === `ant:${ID}`).length === 1, 'redelivery after a restart is ignored via the keyed doc (no second row, no second doc)');
    await bookkeeping.recordFill(fill('SimpleContinuousStrategy-ANT', 'ant', 'NIFTY01DEC26P25700', '26112500162000', 'Sell', 195, 214.3));
    await sleep(80);
    const closedRow = cols.closedTrades.find((r) => r.user === 'SimpleContinuousStrategy-ANT');
    assert(!!closedRow && closedRow.sellOrderId === '26112500162000' && closedRow.brokerOrderKey === 'ant:26112500162000', 'the closed-trade row carries the sell order id and its composite key');
    // legacy docs (written before brokerOrderKey): a Prism doc without a key never blocks an ANT fill; a broker-less doc blocks only the broker being processed
    b.trades.length = 0; b.processedFillIds.clear(); cols.Trade.length = 0;
    cols.Trade.push({ _id: 'L1', user: 'U', tsym: 'X', action: 'Buy', broker: 'prism', brokerOrderId: 'LEG1', entryTime: new Date() });
    cols.Trade.push({ _id: 'L2', user: 'U', tsym: 'X', action: 'Buy', brokerOrderId: 'LEG2', entryTime: new Date() }); // no broker, no key
    await bookkeeping.recordFill(fill('U', 'ant', 'NIFTY01DEC26P25700', 'LEG1', 'Buy'));
    assert(open('U', 'ant', 'NIFTY01DEC26P25700')?.quantity === 195, 'a legacy Prism doc (no key) does not drop an ANT fill of the same id');
    await bookkeeping.recordFill(fill('U', 'prism', 'NIFTY01DEC26P25700', 'LEG1', 'Buy'));
    assert(open('U', 'prism', 'NIFTY01DEC26P25700') === undefined, 'the same legacy doc still dedupes a Prism redelivery (broker + raw id fallback)');
    const antEvent = fill('U', 'ant', 'NIFTY01DEC26P25800', 'LEG2', 'Buy');
    await bookkeeping.recordFill(antEvent);
    assert(open('U', 'ant', 'NIFTY01DEC26P25800') === undefined, 'a broker-less legacy doc matches the broker being processed by raw id');

    console.log('(4) reservations');
    b.pendingOrders.clear();
    const e1 = b.markPending('U1', 1000, 'prism'); e1.orderId = ID;
    assert(b.releaseReservationForOrder(ID, 'ant') === false && b.pendingOrders.get('U1')?.length === 1, 'an ANT fill/cancel with the same id does not release the Prism reservation');
    assert(b.releaseReservationForOrder(ID, 'prism') === true && !b.pendingOrders.has('U1'), 'the Prism one releases it');

    console.log('(5) locked sells ledger (restart reload)');
    await recordLockedSells('U', 'prism', 'NIFTY01DEC26P25700', '47836', 'NFO', 214.3, [ID]);
    await recordLockedSells('U', 'ant', 'NIFTY01DEC26P25700', '47836', 'NFO', 215, [ID]);
    assert(isLockedSell('prism', ID) && isLockedSell('ant', ID) && cols.lockedSells.length === 2, 'two ledger rows for one id on two brokers (no overwrite)');
    const rows = cols.lockedSells.map((r) => ({ ...r, day: new Date().toLocaleDateString('en-CA') }));
    cols.lockedSells.length = 0; cols.lockedSells.push(...rows);
    await loadLockedSellsFromMongo();
    assert(isLockedSell('prism', ID) && isLockedSell('ant', ID) && !isLockedSell('kite', ID), 'after a restart both rows are reloaded under their own broker key');

    console.log('(6) the strategies\' duplicate-delivery guard');
    resetSeenFills();
    const mk = (broker: string) => ({ brokerOrderId: ID, broker: broker as any, action: 'Buy', quantity: 195 });
    assert(isDuplicateFill(mk('prism')) === false && isDuplicateFill(mk('ant')) === false, 'same id, side and size on two brokers: both delivered');
    assert(isDuplicateFill(mk('ant')) === true, 'a real redelivery on the same broker is still dropped');

    console.log('(7) the sync\'s fill keys');
    cols.Trade.length = 0;
    cols.Trade.push({ _id: 'p', user: 'P', tsym: 'NIFTY01DEC26C25950', action: 'Buy', broker: 'prism', brokerOrderId: ID, brokerOrderKey: `prism:${ID}`, entryTime: new Date() });
    cols.Trade.push({ _id: 'q', user: 'P', tsym: 'NIFTY01DEC26C25950', action: 'Buy', broker: 'prism', brokerOrderId: 'OLD', entryTime: new Date() }); // legacy, no key
    const antKeys = await b.mongoFillKeys('ant');
    const prismKeys = await b.mongoFillKeys('prism');
    assert(!antKeys.keys.has(`Buy|ant:${ID}`) && prismKeys.keys.has(`Buy|prism:${ID}`) && prismKeys.keys.has('Buy|prism:OLD'), 'a Prism doc is not "the ANT fill is stored"; a legacy doc is keyed from its broker');

    console.log('(8) same-day realized reconcile on the P25700 scenario');
    cols.Trade.length = 0; cols.closedTrades.length = 0;
    const T0 = new Date(); T0.setHours(13, 0, 0, 0);
    cols.Trade.push({ _id: 'x1', user: 'SimpleContinuousStrategy-Prism', tsym: 'NIFTY01DEC26P25700', action: 'Buy', broker: 'prism', brokerOrderId: ID, brokerOrderKey: `prism:${ID}`, quantity: 195, entryTime: T0 });
    cols.Trade.push({ _id: 'x2', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', action: 'Sell', broker: 'ant', brokerOrderId: '26112500162000', brokerOrderKey: 'ant:26112500162000', quantity: 195, entryTime: T0 });
    cols.closedTrades.push({ _id: 'c0', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', broker: 'ant', quantity: 195, entryPrice: 212.8, exitPrice: 222.8, realizedPnL: 1950, entryTime: new Date(T0.getTime() - 60000), exitTime: new Date(T0.getTime() + 60000) });
    const at = (m: number) => T0.getTime() + m * 60000;
    b.readTimedFills = async () => ({
        fills: [
            { orderId: ID, tradeId: ID, action: 'Buy', tsym: 'NIFTY', token: '47836', qty: 195, price: 204.3, at: at(-3) },
            { orderId: '26112500162000', tradeId: 'a', action: 'Sell', tsym: 'NIFTY', token: '47836', qty: 195, price: 214.3, at: at(-2) },
            { orderId: 'B2', tradeId: 'b', action: 'Buy', tsym: 'NIFTY', token: '47836', qty: 195, price: 212.8, at: at(-1.5) },
            { orderId: 'S2', tradeId: 'c', action: 'Sell', tsym: 'NIFTY', token: '47836', qty: 195, price: 222.8, at: at(0) },
        ], untimed: [],
    });
    // the ANT trade book names the underlying; the contract comes from the token through the contract master: stub it
    const AntContractMaster = require('../ant/AntContractMaster').default;
    const realFind = AntContractMaster.getInstance().findByToken;
    AntContractMaster.getInstance().findByToken = (t: string) => (t === '47836' ? { tradingSymbol: 'NIFTY01DEC26P25700' } : undefined);
    const out: any[] = [];
    const diffs = await b.collectRealizedMismatches('ant', out);
    AntContractMaster.getInstance().findByToken = realFind;
    assert(diffs.length === 1 && diffs[0].tsym === 'NIFTY01DEC26P25700' && Math.abs(diffs[0].diff + 1950) < 0.01, 'the contract is flagged: platform lower than ANT by 1,950');
    assert(/order-id collision/.test(diffs[0]?.cause ?? '') && /26112500161991/.test(diffs[0]?.cause ?? ''), 'the cause names the dropped fill and the id collision');
    assert(out.length === 1 && out[0].kind === 'realizedGap', 'reported as a realizedGap mismatch (logged as an ALERT by the EOD sync)');
    // after the repair rows exist the contract agrees
    cols.Trade.push({ _id: 'x3', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', action: 'Buy', broker: 'ant', brokerOrderId: ID, brokerOrderKey: `ant:${ID}`, quantity: 195, entryTime: T0 });
    cols.closedTrades.push({ _id: 'c1', user: 'SimpleContinuousStrategy-ANT', tsym: 'NIFTY01DEC26P25700', broker: 'ant', quantity: 195, entryPrice: 204.3, exitPrice: 214.3, realizedPnL: 1950, entryTime: new Date(at(-3)), exitTime: new Date(at(-2)), brokerOrderKey: 'ant:26112500162000' });
    AntContractMaster.getInstance().findByToken = (t: string) => (t === '47836' ? { tradingSymbol: 'NIFTY01DEC26P25700' } : undefined);
    const out2: any[] = [];
    const diffs2 = await b.collectRealizedMismatches('ant', out2);
    AntContractMaster.getInstance().findByToken = realFind;
    assert(diffs2.length === 0 && out2.length === 0, 'with the missing row present nothing is flagged');

    Log.log = realLog;
    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { Log.log = realLog; console.error(e); process.exit(1); });
