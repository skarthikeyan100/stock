// On-demand repair of TODAY's closedTrades rows whose entryPrice / exitPrice / realizedPnL were booked from one chunk's price instead of the
// order's quantity-weighted average fill price (ANT: the COMPLETE push's flprc is the LAST chunk's price; see src/ant/tradeBook.ts).
// It changes entryPrice, exitPrice, realizedPnL of EXISTING rows only (never inserts, never deletes), only when the evidence is unambiguous:
//   per broker and contract, the broker's own trade book (read-only GET localhost:<port>/broker/<b>/trades) is FIFO-matched at ORDER level
//   (ANT: the order average = the last execution row's tradedPrice, which is a cumulative average; Prism: quantity-weighted flprc over the order's
//   fills; Kite: weighted average_price; Breeze: average_cost, one row per order) and the closed rows (sorted by exitTime) take their lots from that FIFO.
//   A contract is SKIPPED (reported, untouched) when the total row quantity differs from the book's closed quantity (manual / other-user orders,
//   short round trips, rows opened on an earlier day) or when any row would move an entry/exit price by more than TOL (0.25): then the mapping
//   of rows to book lots is not provably the same trade.
// Idempotent (a second run finds nothing to change), each update is guarded on the old values, each change is logged to
// logs/closed-trade-repair-<date>.log and the old values are kept on the row as priceRepair.from.
// Usage:  node scripts/repair-closed-trades.js            dry run (default): prints old vs new per contract, writes nothing
//         node scripts/repair-closed-trades.js --apply    performs the updates
//         options: --port 3000  --broker ant|kite|prism|breeze (repeatable)
// The order process keeps its own in-memory copy of closed rows: after --apply the strategyPnl API shows the corrected rows only once that process
// has restarted (it reloads closedTrades from Mongo).
const http = require('http');
const fs = require('fs');
const path = require('path');
const TOL = 0.25;
const MIN_PNL_MOVE = 0.5; // a row whose P&L would move by less than half a rupee (rounding, e.g. Kite) is left alone; keeps the run idempotent
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = opt('--port', '3000');
const ONLY = args.flatMap((a, i) => (a === '--broker' ? [args[i + 1]] : []));
const BROKERS = ['kite', 'ant', 'breeze', 'prism'].filter((b) => !ONLY.length || ONLY.includes(b));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

const get = (p) => new Promise((res, rej) => {
    http.get({ host: 'localhost', port: PORT, path: p, timeout: 30000 }, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(`${p}: not JSON`)); } }); }).on('error', rej);
});

// IST day start as a UTC Date and the dd-mm-yyyy / dd-Mon-yyyy spellings of today.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ist = new Date(Date.now() + 330 * 60000);
const dayStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000);
const dd = String(ist.getUTCDate()).padStart(2, '0');
const TODAY_DMY = `${dd}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${ist.getUTCFullYear()}`;
const TODAY_BREEZE = `${dd}-${MON[ist.getUTCMonth()]}-${ist.getUTCFullYear()}`;

// Contract key shared by the broker spellings: underlying + last 5 digits (the strike) + CE/PE. Today's expiries are all one day's, so the expiry is not part of it.
const keyOf = (underlying, strike, type) => `${underlying}|${String(strike).slice(-5)}|${type}`;
function keyFromTsym(t) {
    const u = (t.match(/^[A-Z]+/) || [''])[0];
    let m = t.match(/(\d+)(CE|PE)$/); if (m) return keyOf(u, m[1], m[2]);
    m = t.match(/([CP])(\d+)$/); if (m) return keyOf(u, m[2], m[1] === 'C' ? 'CE' : 'PE');
    return null;
}
const parseDMYHMS = (s) => { const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - 330 * 60000 : 0; };

// Each loader returns orders [{id, side:'B'|'S', key, qty, price, at, seq}] for today, price = the order's quantity-weighted average fill price.
async function loadOrders(broker) {
    const r = await get(`/broker/${broker}/trades`);
    if (!r || r.success !== true || !Array.isArray(r.trades)) throw new Error(`${broker} trade book unreadable`);
    const rows = r.trades; const orders = new Map();
    const add = (id, side, key, qty, price, at, seq) => { if (!id || !key || !(qty > 0)) return; const k = `${side}|${id}`; const o = orders.get(k) || { id, side, key, qty: 0, value: 0, at: 0, seq: 0 }; o.qty += qty; o.value += qty * price; o.at = Math.max(o.at, at); o.seq = Math.max(o.seq, seq); orders.set(k, o); };
    if (broker === 'kite') rows.forEach((t, i) => add(String(t.order_id), t.transaction_type === 'BUY' ? 'B' : 'S', keyFromTsym(String(t.tradingsymbol)), num(t.quantity), num(t.average_price), Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(t.fill_timestamp)) ? String(t.fill_timestamp) : String(t.fill_timestamp).replace(' ', 'T') + '+05:30') || 0, i)); // zone-less Kite time is IST, not the shell's zone
    else if (broker === 'prism') rows.forEach((t, i) => { if (String(t.fltm || '').slice(0, 10) !== TODAY_DMY) return; add(String(t.norenordno), t.trantype === 'B' ? 'B' : 'S', keyFromTsym(String(t.tsym)), num(t.flqty), num(t.flprc), parseDMYHMS(t.fltm), i); });
    else if (broker === 'breeze') rows.forEach((t, i) => { if (t.trade_date !== TODAY_BREEZE) return; add(String(t.order_id), t.action === 'Buy' ? 'B' : 'S', keyOf(String(t.stock_code), t.strike_price, t.right === 'Call' ? 'CE' : 'PE'), num(t.quantity), num(t.average_cost), 0, rows.length - i); });
    else if (broker === 'ant') {
        // The ANT trade book's tradedPrice is a CUMULATIVE average of the order's executions so far, not the execution's own price: the order's
        // average is the row of its LAST execution (highest exchangeTradeId; same rule as src/ant/tradeBook.ts).
        const last = new Map();
        for (const t of rows) { const id = String(t.brokerOrderId); const n = Number(t.exchangeTradeId); const c = last.get(id); if (!c || (Number.isFinite(n) && n > c.n)) last.set(id, { n: Number.isFinite(n) ? n : -1, p: num(t.tradedPrice) }); }
        rows.forEach((t, i) => {
            if (String(t.fillTimestamp || '').slice(0, 10) !== TODAY_DMY) return;
            const m = String(t.formattedInstrumentName || '').match(/^(\S+) .* (\d+) (CE|PE)$/);
            add(String(t.brokerOrderId), String(t.transactionType).toUpperCase() === 'BUY' ? 'B' : 'S', m ? keyOf(m[1], m[2], m[3]) : null, num(t.filledQuantity), last.get(String(t.brokerOrderId)).p, parseDMYHMS(t.fillTimestamp), i);
        });
    }
    return [...orders.values()].map((o) => ({ ...o, price: o.value / o.qty }));
}

// FIFO per contract over orders in time order: returns {key: [{q, buy, sell}]} closed pairs and the number of sold units with no earlier buy.
function fifo(orders, broker) {
    const sorted = [...orders].sort((a, b) => (broker === 'breeze' ? a.seq - b.seq : (a.at - b.at) || (num(a.id) - num(b.id))));
    const lots = new Map(), pairs = new Map(), naked = new Map();
    for (const o of sorted) {
        const L = lots.get(o.key) || lots.set(o.key, []).get(o.key);
        if (o.side === 'B') { L.push({ q: o.qty, px: o.price }); continue; }
        let rem = o.qty; const P = pairs.get(o.key) || pairs.set(o.key, []).get(o.key);
        while (rem > 1e-9 && L.length) { const c = Math.min(rem, L[0].q); P.push({ q: c, buy: L[0].px, sell: o.price }); L[0].q -= c; rem -= c; if (L[0].q <= 1e-9) L.shift(); }
        if (rem > 1e-9) naked.set(o.key, (naked.get(o.key) || 0) + rem);
    }
    return { pairs, naked };
}

(async () => {
    const { MongoClient } = require('mongodb');
    const client = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
    const col = client.db('stocks').collection('closedTrades');
    const logLines = []; const changes = [];
    const tot = {};
    for (const broker of BROKERS) {
        let orders; try { orders = await loadOrders(broker); } catch (e) { console.log(`${broker}: SKIPPED (${e.message})`); continue; }
        const { pairs, naked } = fifo(orders, broker);
        const rows = await col.find({ broker, exitTime: { $gte: dayStart } }).sort({ exitTime: 1 }).toArray();
        const byKey = new Map();
        for (const r of rows) { const k = keyFromTsym(String(r.tsym)); const L = byKey.get(k) || byKey.set(k, []).get(k); L.push(r); }
        console.log(`\n=== ${broker}: ${rows.length} closed row(s) today, ${orders.length} broker order(s)`);
        console.log('contract                 rows  qty   old realized  new realized  diff     status');
        let oldT = 0, newT = 0;
        for (const [key, list] of [...byKey.entries()].sort()) {
            const oldSum = list.reduce((a, r) => a + r.realizedPnL, 0); oldT += oldSum;
            const qty = list.reduce((a, r) => a + r.quantity, 0);
            const P = (pairs.get(key) || []).map((p) => ({ ...p })); const bookQty = P.reduce((a, p) => a + p.q, 0);
            const label = (key || 'unknown').padEnd(24);
            const skip = (why) => { newT += oldSum; console.log(`${label} ${String(list.length).padStart(4)} ${String(qty).padStart(5)} ${oldSum.toFixed(2).padStart(13)} ${oldSum.toFixed(2).padStart(13)} ${'0.00'.padStart(8)}  SKIPPED: ${why}`); };
            if (list.some((r) => !(r.entryTime >= dayStart))) { skip('a row was opened before today'); continue; }
            if ((naked.get(key) || 0) > 0) { skip(`book sells ${naked.get(key)} with no earlier buy today`); continue; }
            if (Math.abs(bookQty - qty) > 1e-9) { skip(`rows hold ${qty} closed, book closed ${bookQty}`); continue; }
            const plan = []; let bad = null;
            for (const r of list) {
                let rem = r.quantity, bv = 0, sv = 0;
                while (rem > 1e-9) { const p = P[0]; const c = Math.min(rem, p.q); bv += c * p.buy; sv += c * p.sell; p.q -= c; rem -= c; if (p.q <= 1e-9) P.shift(); }
                const entry = r2(bv / r.quantity), exit = r2(sv / r.quantity), pnl = r2(sv - bv);
                if (Math.abs(entry - r.entryPrice) > TOL || Math.abs(exit - r.exitPrice) > TOL) { bad = `row ${r._id} entry ${r.entryPrice}->${entry} exit ${r.exitPrice}->${exit} moves more than ${TOL}`; break; }
                plan.push({ r, entry, exit, pnl });
            }
            if (bad) { skip(bad); continue; }
            const newSum = plan.reduce((a, x) => a + (Math.abs(x.pnl - x.r.realizedPnL) >= MIN_PNL_MOVE ? x.pnl : x.r.realizedPnL), 0);
            newT += newSum;
            const nChg = plan.filter((x) => Math.abs(x.pnl - x.r.realizedPnL) >= MIN_PNL_MOVE);
            console.log(`${label} ${String(list.length).padStart(4)} ${String(qty).padStart(5)} ${oldSum.toFixed(2).padStart(13)} ${newSum.toFixed(2).padStart(13)} ${(newSum - oldSum).toFixed(2).padStart(8)}  ${nChg.length ? `${nChg.length} row(s) to update` : 'ok'}`);
            for (const x of nChg) changes.push({ broker, key, ...x });
        }
        tot[broker] = { oldT, newT };
        console.log(`${broker.padEnd(8)} TOTAL old ${oldT.toFixed(2)}  new ${newT.toFixed(2)}  diff ${(newT - oldT).toFixed(2)}`);
    }
    console.log('\n' + (changes.length ? `${changes.length} row(s) would change:` : 'nothing to change'));
    for (const c of changes) console.log(`  ${c.broker} ${c.r.user} ${c.r.tsym} qty ${c.r.quantity}: entry ${c.r.entryPrice}->${c.entry}  exit ${c.r.exitPrice}->${c.exit}  pnl ${c.r.realizedPnL.toFixed(2)}->${c.pnl.toFixed(2)}`);
    if (APPLY && changes.length) {
        const at = new Date();
        for (const c of changes) {
            const res = await col.updateOne({ _id: c.r._id, entryPrice: c.r.entryPrice, exitPrice: c.r.exitPrice, realizedPnL: c.r.realizedPnL }, { $set: { entryPrice: c.entry, exitPrice: c.exit, realizedPnL: c.pnl, priceRepair: { at, from: { entryPrice: c.r.entryPrice, exitPrice: c.r.exitPrice, realizedPnL: c.r.realizedPnL } } } });
            logLines.push(`${at.toISOString()} ${c.broker} ${c.r._id} ${c.r.user} ${c.r.tsym} qty ${c.r.quantity} entry ${c.r.entryPrice}->${c.entry} exit ${c.r.exitPrice}->${c.exit} pnl ${c.r.realizedPnL}->${c.pnl} matched=${res.matchedCount}`);
        }
        const dir = path.join(__dirname, '..', 'logs'); fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `closed-trade-repair-${TODAY_DMY}.log`), logLines.join('\n') + '\n');
        console.log(`applied ${logLines.length} update(s); logged to logs/closed-trade-repair-${TODAY_DMY}.log`);
    } else if (!APPLY) console.log('(dry run: nothing written; add --apply to write)');
    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
