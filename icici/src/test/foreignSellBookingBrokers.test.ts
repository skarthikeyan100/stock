/**
 * Non-platform sells that took the platform's lots, for ant / prism / breeze (extends foreignSellBooking.test.ts, which covers kite and the pure rule).
 * Rows are the real shapes: the Shoonya order book rows are copied from logs/orchestrator-2026-11-20.log (norentm 'HH:MM:SS DD-MM-YYYY', exch_tm
 * 'DD-MM-YYYY HH:MM:SS', trantype 'B'/'S', fillshares, avgprc); the ANT trade book from ANT.getTrades (brokerOrderId, transactionType, tradingSymbol,
 * instrumentId, filledQuantity, tradedPrice); the Breeze trade list from docs/status/urgent.md (order_id, action, stock_code, expiry_date, strike_price, right, quantity,
 * average_cost, trade_date). The ANT/Breeze TIME field name is not confirmed anywhere in the repo, so those books are tested both with a plausible time
 * field (auto-detected) and without any (ALERT only, nothing booked, logged single-holder fallback in the sync).
 * Run: npx tsc, then: MOCK_BROKER=true node ./dist/test/foreignSellBookingBrokers.test.js
 */
process.env.MOCK_BROKER = 'true';
import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';
import ANT from '../ant/ANT';
import Breeze from '../breeze/Breeze';
import Prism from '../prism';
import { parseBrokerTime, timedFillsFromPrism, timedFillsFromAnt, timedFillsFromBreeze, resetRowKeysLogged } from '../processes/order/timedFills';

let failed = false;
function assert(c: boolean, m: string) { console.log(`  ${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) failed = true; }

const docs: any[] = [];
const fakeDb = {
    collection: (name: string) => ({
        find: (f: any) => {
            const rows = name === 'Trade' ? docs.filter((d) => (f?.brokerOrderId?.$exists ? d.brokerOrderId != null : true)) : [];
            const c: any = { sort: () => c, toArray: async () => rows, project: () => c };
            return c;
        },
        findOne: async (f: any) => (name === 'Trade' ? docs.find((d) => d.brokerOrderId === f?.brokerOrderId && d.action === f?.action) ?? null : null),
        insertOne: async () => ({}), createIndex: async () => ({}),
        updateOne: async () => ({ upsertedCount: 1 }), updateMany: async () => ({}), deleteOne: async () => ({}), replaceOne: async () => ({}), countDocuments: async () => 0,
    }),
};
(Mongo as any).instance = { db: fakeDb, insert: async (obj: any) => { docs.push({ ...obj }); } };
const b: any = bookkeeping;
const notified: Trade[] = [];
bookkeeping.onFill((_u, t) => { notified.push(t); });
const reset = () => { docs.length = 0; notified.length = 0; b.trades.length = 0; b.closedTrades.length = 0; b.processedFillIds.clear(); b.foreignShortfallAlerted.clear(); b.untimedForeignOrders.clear(); resetRowKeysLogged(); };

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 10, 20, hh, mm, ss) - 5.5 * 3600_000;
function platformTrade(broker: string, tsym: string, user: string, qty: number, price: number, entryIst: number, token = '55555'): Trade {
    const t = new Trade(); t.tsym = tsym; t.token = token; t.quantity = qty; t.price = price; t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = broker as any; t.open = true; t.right = 'CE' as any; t.entryTime = new Date(entryIst);
    return t;
}
let nextId = 0;
const uniq = (s: string) => `${s}${++nextId}`;

async function main() {
    // (0) time parsing: IST independent of the server TZ; a date alone is not a time
    assert(parseBrokerTime('11:10:05 20-11-2026') === ist(11, 10, 5), 'Shoonya norentm "HH:MM:SS DD-MM-YYYY" = IST');
    assert(parseBrokerTime('20-11-2026 11:10:05') === ist(11, 10, 5), 'Shoonya exch_tm "DD-MM-YYYY HH:MM:SS" = IST');
    assert(parseBrokerTime('2026-11-20 11:10:05') === ist(11, 10, 5) && parseBrokerTime('2026-11-20T11:10:05+05:30') === ist(11, 10, 5) && parseBrokerTime('2026-11-20T05:40:05Z') === ist(11, 10, 5), 'ISO without offset = IST; with offset / Z honoured');
    assert(parseBrokerTime('20-Nov-2026 11:10:05') === ist(11, 10, 5), 'Breeze "DD-Mon-YYYY HH:MM:SS" = IST');
    assert(parseBrokerTime('20-Nov-2026') === null && parseBrokerTime('09-Nov-2026') === null && parseBrokerTime('') === null && parseBrokerTime('x') === null, 'a date alone (Breeze trade_date) is not a time');
    assert(parseBrokerTime(new Date(ist(11, 10, 5))) === ist(11, 10, 5) && parseBrokerTime(ist(11, 10, 5)) === ist(11, 10, 5) && parseBrokerTime(Math.floor(ist(11, 10, 5) / 1000)) === ist(11, 10, 5), 'Date / epoch ms / epoch s');

    // ---- PRISM (Shoonya order book) ----
    const PT = 'NIFTY23NOV26C25550';
    const prismRow = (id: string, trantype: 'B' | 'S', qty: number, avg: number, hh: number, mm: number, status = 'COMPLETE', prd = 'M') => ({
        norenordno: id, tsym: PT, trantype, prctyp: 'LMT', status, fillshares: String(qty), qty: String(qty), avgprc: String(avg), prd, s_prdt_ali: prd === 'M' ? 'NRML' : 'MIS',
        norentm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:01 20-11-2026`, exch_tm: `20-11-2026 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:01`, token: '<redacted>',
    });
    const prism: any = Prism.getInstance();
    let prismNet = 0;
    let prismBook: any[] = [];
    prism.hasValidSession = async () => true;
    prism.getOrderBook = async () => prismBook;
    b.readBrokerRows = async () => [{ tsyms: [PT], tokens: [], qty: prismNet }];
    reset();
    const P1 = uniq('P'), M0 = uniq('M'), M3 = uniq('M');
    prism.placedOrderIds.add(P1); // placed by this process, fill not booked yet
    prismBook = [
        prismRow(M0, 'S', 130, 109, 10, 37), // the user's earlier manual sell: predates the platform's buy -> never excess
        prismRow(P1, 'B', 130, 114.5, 10, 50),
        prismRow(M3, 'S', 130, 104, 11, 10), // the user's sell that took the platform's lots
        { ...prismRow(uniq('X'), 'S', 65, 90, 11, 11, 'REJECTED'), fillshares: '0' }, // a rejected order: no fill
    ];
    const tr = platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5));
    b.trades.push(tr); prismNet = 0;
    let n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    const sold = docs.filter((d) => d.action === 'Sell');
    assert(n === 1 && sold.length === 1 && sold[0].brokerOrderId === M3 && sold[0].price === 104 && sold[0].quantity === 130 && sold[0].broker === 'prism', `prism: booked the 11:10 manual sell @104 (not the 10:37 @109): ${sold.map((d) => d.brokerOrderId + '@' + d.price)}`);
    assert(b.trades.length === 0 && notified.length === 0, 'prism sync flavour: position closed, strategies not notified');
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && docs.filter((d) => d.action === 'Sell').length === 1, 'prism: a second run / restart books nothing more (order id already stored)');
    // restart mid-state: the leg is restored from the broker, Mongo has the Sell
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5))); b.processedFillIds.clear();
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && docs.filter((d) => d.action === 'Sell').length === 1, 'prism: restart with the position restored does not book twice');
    // the platform's own sell (placed by this process, fill not booked yet) is never foreign
    reset();
    const PS = uniq('PS'); prism.placedOrderIds.add(PS);
    prismBook = [prismRow(PS, 'S', 130, 120, 11, 20)];
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5))); prismNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1 && docs.length === 0, "prism: the platform's own placed sell (fill not booked yet) is not booked as a manual sell");
    // user's own manual buy then sell covers: no excess
    reset();
    const MB = uniq('MB'), MS = uniq('MS');
    prismBook = [prismRow(MB, 'B', 130, 100, 11, 0), prismRow(MS, 'S', 130, 104, 11, 10)];
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5))); prismNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1, "prism: manual buy 130 + manual sell 130 = the user's own lots, nothing booked");
    // a partially filled then cancelled manual sell counts by its filled part (CANCELED row with fillshares)
    reset();
    const MC = uniq('MC');
    prismBook = [{ ...prismRow(MC, 'S', 65, 104, 11, 10, 'CANCELED'), qty: '130' }];
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5))); prismNet = 65;
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 1 && docs.some((d) => d.brokerOrderId === MC && d.quantity === 65) && b.trades[0]?.quantity === 65, 'prism: partial fill of a cancelled manual sell booked for its filled 65; the leg keeps 65');
    // NRML long + MIS short rows: the net is not a sale of the platform's lots
    reset();
    b.readBrokerRows = async () => [{ tsyms: [PT], tokens: [], qty: 130 }, { tsyms: [PT], tokens: [], qty: -130 }];
    prismBook = [prismRow(uniq('MM'), 'S', 130, 104, 11, 10, 'COMPLETE', 'I')];
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5)));
    n = await bookkeeping.bookForeignSellShortfall('prism', { notifyStrategies: false, graceMs: 0, confirm: false });
    // aggregate 0 < 130 but one row is long: mixed products -> ALERT only
    assert(n === 0 && b.trades.length === 1, 'prism: long NRML row next to a short MIS row (net 0) is not booked');
    assert(/long in one product and short in another/.test(await bookkeeping.explainNeverShort('prism', PT)), 'prism: NEVER-SHORT cause line names the mixed products');
    b.readBrokerRows = async () => [{ tsyms: [PT], tokens: [], qty: prismNet }];
    // the cause line for a plain manual sell
    reset(); prismNet = 0; const MX = uniq('MX');
    prismBook = [prismRow(MX, 'S', 130, 104, 11, 10)];
    b.trades.push(platformTrade('prism', PT, 'SimpleContinuous-Prism', 130, 114.5, ist(10, 50, 5)));
    assert(new RegExp(`YES, a non-platform sell explains it.*${MX} \\(130 @ 104\\.00\\)`).test(await bookkeeping.explainNeverShort('prism', PT)), 'prism: the NEVER-SHORT cause line names the order id');
    // normaliser: executed rows only, order id = trade id
    const nb = timedFillsFromPrism(prismBook);
    assert(nb.fills.length === 1 && nb.fills[0].tradeId === MX && nb.fills[0].at === ist(11, 10, 1) && nb.fills[0].action === 'Sell', 'prism normaliser: one row, IST time, side from trantype');

    // ---- ANT (trade book) ----
    const AT = 'NIFTY26NOV25550CE';
    const ant: any = ANT.getInstance();
    const antRow = (id: string, tx: 'BUY' | 'SELL', qty: number, px: number, timeField?: [string, string], tradeId?: string) => ({
        brokerOrderId: id, exchangeOrderId: '1000' + id, transactionType: tx, tradingSymbol: AT, instrumentId: '55555', filledQuantity: qty, tradedPrice: px, product: 'LONGTERM',
        ...(timeField ? { [timeField[0]]: timeField[1] } : {}), ...(tradeId ? { tradeId } : {}),
    });
    let antBook: any[] = [];
    ant.getTrades = async () => antBook;
    let antNet = 0;
    b.readBrokerRows = async () => [{ tsyms: [AT], tokens: ['55555'], qty: antNet }];
    reset();
    const A1 = uniq('26112000'), AM0 = uniq('26112000'), AM3 = uniq('26112000');
    ant.placedOrderIds.add(A1);
    antBook = [
        antRow(AM0, 'SELL', 195, 109, ['fillTimestamp', '2026-11-20 10:37:00']),
        antRow(A1, 'BUY', 195, 114, ['fillTimestamp', '2026-11-20 10:50:00']),
        // ANT trade-book semantics (src/ant/tradeBook.ts, commit 61aadf3): a row's tradedPrice is the order's CUMULATIVE AVERAGE after that execution, and the
        // order's average is its highest-exchangeTradeId row. Executions 130 @104 then 65 @105 therefore come back as rows 104 and (130*104+65*105)/195.
        { ...antRow(AM3, 'SELL', 130, 104, ['fillTimestamp', '2026-11-20 11:10:00'], 'T1'), exchangeTradeId: '900001' },
        { ...antRow(AM3, 'SELL', 65, (130 * 104 + 65 * 105) / 195, ['fillTimestamp', '2026-11-20 11:10:01'], 'T2'), exchangeTradeId: '900002' },
    ];
    b.trades.push(platformTrade('ant', AT, 'ContinuousStrategy-Ant', 195, 114, ist(10, 50, 5))); antNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('ant', { notifyStrategies: false, graceMs: 0, confirm: false });
    const asold = docs.filter((d) => d.action === 'Sell');
    assert(n === 1 && asold.length === 1 && asold[0].brokerOrderId === AM3 && asold[0].quantity === 195 && Math.abs(asold[0].price - (130 * 104 + 65 * 105) / 195) < 1e-9, `ant: partial executions of one manual order booked together at their average (${asold[0]?.price})`);
    assert(!docs.some((d) => d.brokerOrderId === AM0), 'ant: the earlier manual sell is not booked');
    // ANT trade book without any time field: ALERT only, nothing booked
    reset();
    antBook = [antRow(uniq('26112000'), 'SELL', 195, 104)];
    b.trades.push(platformTrade('ant', AT, 'ContinuousStrategy-Ant', 195, 114, ist(10, 50, 5))); antNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('ant', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1 && docs.length === 0, 'ant: no fill time in the trade book -> nothing booked (ALERT)');
    assert(/gave no fill time/.test(await bookkeeping.explainNeverShort('ant', AT)), 'ant: the NEVER-SHORT cause line says the time is missing');
    // ... and the sync's logged fallback (single holder) for exactly that untimed order
    const rows = [{ tsyms: [AT], tokens: ['55555'], qty: 0 }];
    const fills = [{ orderId: antBook[0].brokerOrderId, action: 'Sell' as const, tsym: AT, token: '55555', qty: 195, price: 104 }];
    const mism: any[] = [];
    const nf = await b.bookMissingSellFills('ant', fills, rows, mism);
    assert(nf === 1 && b.trades.length === 0 && docs.some((d) => d.action === 'Sell' && d.price === 104), 'ant: untimed order -> the logged single-holder FALLBACK books it in the sync');
    // a sell that is still a TRACKED resting order (the 15 s poll has not seen it fill) is delivered like a polled fill: the strategy is told (live 2026-11-25 12:48);
    // one that is not tracked is booked silently as before
    for (const tracked of [true, false]) {
        reset();
        const TR = uniq('26112000');
        b.untimedForeignOrders.add(`ant:${TR}`);
        b.trades.push(platformTrade('ant', AT, 'ContinuousStrategy-Ant', 195, 114, ist(10, 50, 5)));
        b.setPendingOrderSource(() => (tracked ? [{ orderId: TR, userId: 'ContinuousStrategy-Ant', tradingSymbol: AT, action: 'Sell' as const, quantity: 195 }] : []));
        const told: string[] = [];
        b.fillListeners.push((_u: string, t: any) => { if (t.brokerOrderId === TR) told.push(t.brokerOrderId); });
        const nt = await b.bookMissingSellFills('ant', [{ orderId: TR, action: 'Sell' as const, tsym: AT, token: '55555', qty: 195, price: 104 }], rows, []);
        b.fillListeners.pop();
        assert(nt === 1 && b.trades.length === 0, `sync books the fill (${tracked ? 'tracked' : 'untracked'})`);
        assert(told.length === (tracked ? 1 : 0), tracked ? 'a tracked resting sell: the strategies are told (fill listeners run)' : 'an untracked sell is booked silently');
        b.setPendingOrderSource(() => []);
    }
    // timed book + ownerless sell: bookMissingSellFills no longer guesses
    reset();
    const AMX = uniq('26112000');
    b.trades.push(platformTrade('ant', AT, 'ContinuousStrategy-Ant', 195, 114, ist(10, 50, 5)));
    const mism2: any[] = [];
    const nf2 = await b.bookMissingSellFills('ant', [{ orderId: AMX, action: 'Sell', tsym: AT, token: '55555', qty: 195, price: 104 }], rows, mism2);
    assert(nf2 === 0 && b.trades.length === 1 && mism2.length === 1, 'ant: an ownerless sell that the time-aware path did not claim is reported, not guessed onto the single holder');
    // normaliser auto-detection prefers a fill/trade key over an order key
    const t = timedFillsFromAnt([{ ...antRow('1', 'BUY', 1, 1), orderTime: '2026-11-20 10:00:00', tradeTime: '2026-11-20 10:05:00' }]);
    assert(t.fills[0].at === ist(10, 5, 0), 'ant normaliser: a trade-time key wins over an order-time key');

    // ---- BREEZE (trade list) ----
    const BT = 'NIFTY26N2425550CE'; // breezeTsym(NIFTY, 24-Nov-2026, 25550, CE) is computed below from the row
    const breeze: any = Breeze.getInstance();
    const brRow = (id: string, action: 'Buy' | 'Sell', qty: number, px: number, expiry = '24-Nov-2026', extra: any = {}) => ({
        order_id: id, action, stock_code: 'NIFTY', expiry_date: expiry, strike_price: 25550, right: 'Call', quantity: String(qty), average_cost: String(px), trade_date: '20-Nov-2026', ...extra,
    });
    let brBook: any[] = [];
    breeze.hasValidSession = async () => true;
    breeze.getTradeList = async () => ({ Success: brBook });
    const canon = timedFillsFromBreeze([brRow('x', 'Buy', 1, 1, '24-Nov-2026', { order_datetime: '20-Nov-2026 10:00:00' })]).fills[0];
    const BTS = canon.tsym;
    assert(canon.aliases!.includes('NIFTY25550CE') && /^NIFTY/.test(BTS) && BTS !== 'NIFTY25550CE', `breeze normaliser: expiry-bearing tsym ${BTS} with the old expiry-less spelling as an alias`);
    let brNet = 0;
    b.readBrokerRows = async () => [{ tsyms: [BTS, 'NIFTY25550CE'], tokens: [], qty: brNet }];
    reset();
    // trade_date only (what the repo proves): untimed -> nothing booked
    const B1 = '202611203800010000', BM = '202611203800010020';
    brBook = [brRow(B1, 'Buy', 195, 114), brRow(BM, 'Sell', 195, 104)];
    breeze.placedOrderIds.add(B1);
    b.trades.push(platformTrade('breeze', BTS, 'ContinuousStrategy-Breeze', 195, 114, ist(10, 50, 5), '')); brNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('breeze', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1 && docs.length === 0, 'breeze: the trade list carries a trade_date only -> no fill time -> nothing booked (ALERT)');
    // with a full date-time field the same book is attributed
    reset();
    brBook = [
        brRow('202611203800009000', 'Sell', 195, 109, '24-Nov-2026', { order_datetime: '20-Nov-2026 10:37:00' }),
        brRow(B1, 'Buy', 195, 114, '24-Nov-2026', { order_datetime: '20-Nov-2026 10:50:00' }),
        brRow(BM, 'Sell', 195, 104, '24-Nov-2026', { order_datetime: '20-Nov-2026 11:10:00' }),
    ];
    b.trades.push(platformTrade('breeze', BTS, 'ContinuousStrategy-Breeze', 195, 114, ist(10, 50, 5), '')); brNet = 0;
    n = await bookkeeping.bookForeignSellShortfall('breeze', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 1 && docs.filter((d) => d.action === 'Sell').length === 1 && docs.find((d) => d.action === 'Sell')?.brokerOrderId === BM && docs.find((d) => d.action === 'Sell')?.price === 104, 'breeze: with a time field the 11:10 sell is booked @104, the 10:37 one is not');
    // a platform trade with the OLD expiry-less name and two expiries in the book -> ambiguous, nothing booked
    reset();
    brBook = [
        brRow(BM, 'Sell', 195, 104, '24-Nov-2026', { order_datetime: '20-Nov-2026 11:10:00' }),
        brRow('202611203800010030', 'Buy', 195, 90, '01-Dec-2026', { order_datetime: '20-Nov-2026 10:00:00' }),
    ];
    b.trades.push(platformTrade('breeze', 'NIFTY25550CE', 'ContinuousStrategy-Breeze', 195, 114, ist(10, 50, 5), '')); brNet = 0;
    b.readBrokerRows = async () => [{ tsyms: [BTS, 'NIFTY25550CE'], tokens: [], qty: 0 }];
    n = await bookkeeping.bookForeignSellShortfall('breeze', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1, 'breeze: an expiry-less platform tsym with two expiries in the trade list is not attributed');
    // legacy-named platform trade with one expiry only: attributed through the alias
    reset();
    brBook = [brRow('202611203800010099', 'Sell', 195, 104, '24-Nov-2026', { order_datetime: '20-Nov-2026 11:10:00' })]; // fresh id: the owner ledger is process-wide
    b.trades.push(platformTrade('breeze', 'NIFTY25550CE', 'ContinuousStrategy-Breeze', 195, 114, ist(10, 50, 5), ''));
    n = await bookkeeping.bookForeignSellShortfall('breeze', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 1, 'breeze: an expiry-less platform tsym with one expiry in the trade list is attributed through the alias');
    // 'No Data Found' = empty book
    reset();
    breeze.getTradeList = async () => { throw new Error('Error: No Data Found'); };
    b.trades.push(platformTrade('breeze', BTS, 'ContinuousStrategy-Breeze', 195, 114, ist(10, 50, 5), ''));
    b.readBrokerRows = async () => [{ tsyms: [BTS], tokens: [], qty: 0 }];
    n = await bookkeeping.bookForeignSellShortfall('breeze', { notifyStrategies: false, graceMs: 0, confirm: false });
    assert(n === 0 && b.trades.length === 1, 'breeze: an empty trade list books nothing');

    // ---- own-order sets of the clients ----
    assert(ant.isOwnOrder(A1) === true && ant.isOwnOrder('nope') === false && breeze.isOwnOrder(B1) === true && prism.isOwnOrder(P1) === true, 'ANT / Breeze / Prism clients answer isOwnOrder from their placed-order sets');

    console.log(failed ? 'FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
