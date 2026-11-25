/**
 * `scripts/strategy-status.sh reconcile`: per broker and per contract, the broker's own realized P&L (kite / ant / prism day-average, breeze FIFO: the figures
 * `status net` uses) against the platform's closedTrades realized, printing every contract that differs by more than 1.5 rupees x lots with the likely cause.
 * READ-ONLY: GETs the platform's own routes (/broker/<b>/trades, /strategyPnl?closed=1) and reads Mongo (Trade, to name the cause); writes nothing.
 * Usage: node dist/tools/reconcileRealized.js [port]
 * Exit code 0 always (it is a report); the last line says how many contracts differ.
 */
import http from 'http';
import { MongoClient } from 'mongodb';
import { breezeTsym } from '../breeze/BreezeContractMaster';
import { timedFillsFromKite, timedFillsFromAnt, parseBrokerTime } from '../processes/order/timedFills';
import { brokerRealizedByContract, platformRealizedByContract, compareRealized, likelyCause, type BookFill, type RealizedDiff } from '../util/realizedReconcile';
import { orderKey } from '../util/orderKey';
import AntContractMaster from '../ant/AntContractMaster';

const BROKERS = ['kite', 'ant', 'prism', 'breeze'] as const;
const IST = 330 * 60000;
const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

function get(port: number, path: string): Promise<any> {
    return new Promise((resolve) => {
        const req = http.get({ host: 'localhost', port, path, timeout: 25000 }, (res) => {
            let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

let masterLoaded = false;
function antMaster(): AntContractMaster { const m = AntContractMaster.getInstance(); if (!masterLoaded) { m.preload({ bfo: true }); masterLoaded = true; } return m; }
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// The broker's trade-book rows of the IST day `day` as fills (oldest first for breeze: its book lists newest first, a row has a date only).
export function fillsFromBook(broker: string, rows: any[], day: string): BookFill[] | null {
    if (broker === 'kite') return timedFillsFromKite(rows).fills.filter((f) => istDay(f.at) === day).map((f) => ({ tsym: f.tsym, action: f.action, qty: f.qty, price: f.price, orderId: f.orderId, at: f.at }));
    if (broker === 'ant') {
        const book = timedFillsFromAnt(rows);
        if (book.untimed.length > 0) return null;
        // The ANT trade book's tradingSymbol is the UNDERLYING ('NIFTY'): the contract is the instrument id (token), resolved through the contract master.
        const tsymOf = (f: { tsym: string; token?: string }) => (f.token ? antMaster().findByToken(f.token)?.tradingSymbol : undefined) ?? f.tsym;
        return book.fills.filter((f) => istDay(f.at) === day).map((f) => ({ tsym: tsymOf(f), action: f.action, qty: f.qty, price: f.price, orderId: f.orderId, at: f.at }));
    }
    if (broker === 'prism') {
        const out: BookFill[] = [];
        for (const r of rows) {
            const at = parseBrokerTime(r.fltm);
            if (at == null || istDay(at) !== day || !(num(r.flqty) > 0)) continue;
            out.push({ tsym: String(r.tsym), action: r.trantype === 'S' ? 'Sell' : 'Buy', qty: num(r.flqty), price: num(r.flprc), orderId: String(r.norenordno), at });
        }
        return out;
    }
    // breeze: trade_date is a date only ('25-Nov-2026'); the list is newest first, so reverse it and number the rows to keep the order.
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const dayOfRow = (d: string) => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(d)); return m ? `${m[3]}-${String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1]}` : ''; };
    const out: BookFill[] = [];
    [...rows].reverse().forEach((r, i) => {
        if (dayOfRow(r.trade_date) !== day) return;
        const optionType = r.right === 'Call' ? 'CE' : r.right === 'Put' ? 'PE' : '';
        if (!optionType || (r.action !== 'Buy' && r.action !== 'Sell')) return;
        out.push({ tsym: breezeTsym(String(r.stock_code), String(r.expiry_date), r.strike_price, optionType as 'CE' | 'PE'), action: r.action, qty: num(r.quantity), price: num(r.average_cost), orderId: String(r.order_id), at: i });
    });
    return out;
}

export interface ReconcileInput { broker: string; fills: BookFill[] | null; platformRows: any[]; storedKeys?: Set<string>; otherBrokerIds?: Set<string>; storedSellQty?: Map<string, number> }

// Pure: one broker's differences with causes (tested without a network).
export function reconcileBroker(inp: ReconcileInput, day: string): { diffs: RealizedDiff[]; note?: string } {
    if (!inp.fills) return { diffs: [], note: 'trade book unreadable or rows without a fill time: not compared' };
    const dayStart = new Date(`${day}T00:00:00+05:30`).getTime();
    const rows = inp.platformRows.filter((r) => r.exitTime && istDay(new Date(r.exitTime).getTime()) === day);
    const carried = new Set(rows.filter((r) => r.entryTime && new Date(r.entryTime).getTime() < dayStart).map((r) => String(r.tsym)));
    const platformMap = platformRealizedByContract(rows.filter((r) => !carried.has(String(r.tsym))));
    const fills = inp.fills.filter((f) => !carried.has(f.tsym));
    const brokerMap = brokerRealizedByContract(inp.broker, fills);
    if (!brokerMap) return { diffs: [], note: 'FIFO order unknown: not compared' };
    const qtyOf = (tsym: string) => fills.filter((f) => f.tsym === tsym && f.action === 'Sell').reduce((a, f) => a + f.qty, 0) || fills.filter((f) => f.tsym === tsym).reduce((a, f) => a + f.qty, 0);
    const stored = inp.storedKeys ?? new Set<string>();
    const diffs = compareRealized(inp.broker, brokerMap, platformMap, qtyOf, (tsym, diff) => {
        const mine = fills.filter((f) => f.tsym === tsym);
        const closedQty = rows.filter((r) => String(r.tsym) === tsym).reduce((a, r) => a + num(r.quantity), 0);
        const storedSell = inp.storedSellQty?.get(tsym);
        const noRow = storedSell != null && storedSell > closedQty ? [`stored sell qty ${storedSell} > closed qty ${closedQty}`] : [];
        if (!inp.storedKeys) return diff < 0 ? 'platform lower than the broker (Mongo evidence unavailable)' : 'platform higher than the broker (Mongo evidence unavailable)';
        return likelyCause(mine, stored, (id) => orderKey(inp.broker, id), inp.otherBrokerIds ?? new Set(), diff, noRow);
    });
    return { diffs, note: carried.size ? `${carried.size} contract(s) carried from an earlier day left out: ${[...carried].join(', ')}` : undefined };
}

const f2 = (n: number) => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
    const port = Number(process.argv[2]) || 3000;
    const day = istDay(Date.now());
    const closedAll = await get(port, '/strategyPnl?closed=1&opened=all');
    if (!Array.isArray(closedAll)) { console.log('ERROR: platform /strategyPnl?closed=1 is unreachable or predates the closed-row option'); return; }
    let mongo: MongoClient | null = null; let db: any = null;
    try { mongo = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017', { useUnifiedTopology: true, serverSelectionTimeoutMS: 4000 } as any); db = mongo.db('stocks'); } catch { db = null; }
    let total = 0;
    console.log(`BROKER   CONTRACT                     BROKER REALIZED  PLATFORM REALIZED       DIFF   TOL  LIKELY CAUSE (${day})`);
    for (const broker of BROKERS) {
        const book = await get(port, `/broker/${broker}/trades`);
        if (!book || book.success !== true || !Array.isArray(book.trades)) { console.log(`${broker.padEnd(8)} ERROR: trade book unavailable`); continue; }
        const fills = fillsFromBook(broker, book.trades, day);
        const platformRows = closedAll.filter((r: any) => String(r.broker) === broker).map((r: any) => ({ tsym: r.tsym, realizedPnL: r.realizedPnL, quantity: r.quantity, entryTime: r.entryTime, exitTime: r.exitTime }));
        let storedKeys: Set<string> | undefined; let other: Set<string> | undefined; let storedSellQty: Map<string, number> | undefined;
        if (db) {
            try {
                const docs = await db.collection('Trade').find({ entryTime: { $gte: new Date(`${day}T00:00:00+05:30`) } }).project({ brokerOrderId: 1, brokerOrderKey: 1, broker: 1, action: 1, tsym: 1, quantity: 1 }).toArray();
                const mine = docs.filter((d: any) => (!d.broker || String(d.broker).toLowerCase() === broker || (broker === 'kite' && /^zerodha$/i.test(String(d.broker)))));
                storedKeys = new Set(mine.map((d: any) => `${d.action}|${d.brokerOrderKey ?? orderKey(d.broker ?? broker, d.brokerOrderId)}`));
                const ids = new Set((fills ?? []).map((f) => String(f.orderId)));
                other = new Set(docs.filter((d: any) => d.broker && String(d.broker).toLowerCase() !== broker && ids.has(String(d.brokerOrderId))).map((d: any) => String(d.brokerOrderId)));
                storedSellQty = new Map();
                for (const d of mine) if (d.action === 'Sell') storedSellQty.set(String(d.tsym), (storedSellQty.get(String(d.tsym)) ?? 0) + num(d.quantity));
            } catch { /* causes fall back to generic */ }
        }
        const r = reconcileBroker({ broker, fills, platformRows, storedKeys, otherBrokerIds: other, storedSellQty }, day);
        if (r.note) console.log(`${broker.padEnd(8)} (${r.note})`);
        for (const d of r.diffs) { total++; console.log(`${broker.padEnd(8)} ${d.tsym.padEnd(28)} ${f2(d.brokerRealized).padStart(15)} ${f2(d.platformRealized).padStart(18)} ${f2(d.diff).padStart(10)} ${f2(d.tolerance).padStart(5)}  ${d.cause}`); }
        if (!r.diffs.length && fills) console.log(`${broker.padEnd(8)} all contracts agree (platform closedTrades = broker realized within 1.5 rupees x lots)`);
    }
    console.log(total === 0 ? '\nRECONCILE OK: every contract agrees' : `\nRECONCILE: ${total} contract(s) differ - see the likely cause on each line`);
    if (mongo) await mongo.close();
}

if (require.main === module) main().catch((e) => { console.log('ERROR:', e?.message ?? e); }).finally(() => process.exit(0));
