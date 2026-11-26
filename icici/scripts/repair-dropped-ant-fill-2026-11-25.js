// One-off repair of 2026-11-25: the ANT hedge buy 26112500161991 (SimpleContinuousStrategy-ANT, NIFTY01DEC26P25700, 195 @ 204.30, 13:34:40 IST) was dropped by the
// fill dedupe because a Prism order of another contract held the same Noren-style order id. It left no raw Trade doc and no closedTrades row; its sell
// (26112500162000, 195 @ 214.30, 13:35:24.8 IST) is stored. This inserts both, shaped like their neighbours, so the platform's ANT closed-trade total equals ANT's own
// realized P&L again (+1,950 = 195 x (214.30 - 204.30)).
// Default is a DRY RUN; pass --apply to write. Idempotent: a second run finds both documents and writes nothing. Does NOT touch any other document, state file or order.
//   node scripts/repair-dropped-ant-fill-2026-11-25.js            (dry run: prints the pre-checks and what it would insert)
//   node scripts/repair-dropped-ant-fill-2026-11-25.js --apply
//   options: --port 3000 (platform web server for the ANT trade-book pre-check and the post-check), --skip-broker-check (apply without the trade-book pre-check)
// Pre-check: GET /broker/ant/trades must hold the buy (BUY, 195, 204.30, instrument 47836) and the sell (SELL, 195, 214.30). Unreachable = the apply is refused unless
// --skip-broker-check. Post-check (read-only): the REPAIRED day's (2026-11-25 IST) ant closedTrades realized in Mongo against ANT's own realized P&L
// (/broker/ant/positions, sum of realizedPnl). ANT's positions carry the current day only, so on any later day the post-check is skipped (there is nothing to
// compare the repaired day with).
// The running order process keeps closed rows in memory: GET /strategyPnl shows the repaired row only after its next restart (it reloads closedTrades from Mongo).
const http = require('http');
const { randomUUID } = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const FIX = {
    user: 'SimpleContinuousStrategy-ANT', broker: 'ant', tsym: 'NIFTY01DEC26P25700', token: '47836', quantity: 195,
    buy: { orderId: '26112500161991', price: 204.3, at: new Date('2026-11-25T08:04:40.000Z') },
    sell: { orderId: '26112500162000', price: 214.3, at: new Date('2026-11-25T08:05:24.810Z') },
};
const key = (id) => `ant:${id}`;
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const istDay = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);

function get(port, path) {
    return new Promise((resolve) => {
        const req = http.get({ host: 'localhost', port, path, timeout: 25000 }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Does ANT's trade book hold the fix's buy and sell? -> {ok, reason}
function checkBook(book, fix = FIX) {
    if (!book || book.success !== true || !Array.isArray(book.trades)) return { ok: false, reason: 'ANT trade book unreadable' };
    const rows = (id, side) => book.trades.filter((r) => String(r.brokerOrderId) === id && String(r.transactionType).toUpperCase() === side && String(r.instrumentId) === fix.token);
    const sum = (rs) => rs.reduce((a, r) => a + (Number(r.filledQuantity) || 0), 0);
    const last = (rs) => (rs.length ? Number(rs[rs.length - 1].tradedPrice) : NaN);
    const b = rows(fix.buy.orderId, 'BUY'), s = rows(fix.sell.orderId, 'SELL');
    if (sum(b) !== fix.quantity) return { ok: false, reason: `ANT book has ${sum(b)} bought on order ${fix.buy.orderId}, expected ${fix.quantity}` };
    if (sum(s) !== fix.quantity) return { ok: false, reason: `ANT book has ${sum(s)} sold on order ${fix.sell.orderId}, expected ${fix.quantity}` };
    if (Math.abs(last(b) - fix.buy.price) > 0.051) return { ok: false, reason: `ANT book buy price ${last(b)} != ${fix.buy.price}` };
    if (Math.abs(last(s) - fix.sell.price) > 0.051) return { ok: false, reason: `ANT book sell price ${last(s)} != ${fix.sell.price}` };
    return { ok: true, reason: `ANT book confirms BUY ${fix.quantity} @ ${last(b)} (order ${fix.buy.orderId}) and SELL ${fix.quantity} @ ${last(s)} (order ${fix.sell.orderId})` };
}

async function repair(db, { apply = false, book = null, skipBrokerCheck = false, positions = null, log = console.log, now = new Date() } = {}) {
    const say = (m) => log(`${apply ? '' : '[dry-run] '}${m}`);
    const out = { insertedTrade: false, insertedClosed: false, refused: null, postCheck: null };
    const pre = checkBook(book);
    say(`pre-check: ${pre.reason}`);
    if (!pre.ok && !skipBrokerCheck) { out.refused = pre.reason; say(apply ? 'REFUSED: nothing written (use --skip-broker-check only if the book was verified another way)' : 'an --apply would be refused until the book confirms the fills'); return out; }

    // 1. the raw buy doc
    const trades = db.collection('Trade'), closed = db.collection('closedTrades');
    const haveBuy = await trades.findOne({ action: 'Buy', $or: [{ brokerOrderKey: key(FIX.buy.orderId) }, { brokerOrderKey: { $exists: false }, brokerOrderId: FIX.buy.orderId, broker: FIX.broker }] });
    const haveSell = await trades.findOne({ action: 'Sell', $or: [{ brokerOrderKey: key(FIX.sell.orderId) }, { brokerOrderKey: { $exists: false }, brokerOrderId: FIX.sell.orderId, broker: FIX.broker }] });
    if (!haveSell) { out.refused = `the sell ${FIX.sell.orderId} is not stored in Trade: this repair expects it (nothing written)`; say(out.refused); return out; }
    if (haveBuy) say(`Trade buy ${key(FIX.buy.orderId)} already stored (_id ${haveBuy._id}): not inserted`);
    else {
        const doc = { _id: new ObjectId(), user: FIX.user, open: true, tsym: FIX.tsym, token: FIX.token, quantity: FIX.quantity, price: FIX.buy.price, lastTradePrice: FIX.buy.price, action: 'Buy', status: 'COMPLETE', broker: FIX.broker, brokerOrderId: FIX.buy.orderId, brokerOrderKey: key(FIX.buy.orderId), entryTime: FIX.buy.at, repairedManually: true };
        say(`insert Trade: ${FIX.user} Buy ${FIX.quantity} ${FIX.tsym} @ ${FIX.buy.price} order ${key(FIX.buy.orderId)} at ${FIX.buy.at.toISOString()} (repairedManually)`);
        if (apply) { await trades.insertOne(doc); }
        out.insertedTrade = true;
    }
    // 2. the closed-trade row (idempotent by the sell's key, else by the exact trade)
    const haveClosed = await closed.findOne({ user: FIX.user, tsym: FIX.tsym, broker: FIX.broker, quantity: FIX.quantity, entryPrice: FIX.buy.price, exitPrice: FIX.sell.price });
    if (haveClosed) say(`closedTrades row for ${FIX.tsym} ${FIX.buy.price} -> ${FIX.sell.price} already stored (_id ${haveClosed._id}): not inserted`);
    else {
        const pnl = FIX.quantity * (FIX.sell.price - FIX.buy.price);
        const row = { _id: randomUUID(), user: FIX.user, tsym: FIX.tsym, token: FIX.token, quantity: FIX.quantity, entryPrice: FIX.buy.price, exitPrice: FIX.sell.price, realizedPnL: pnl, entryTime: FIX.buy.at, exitTime: FIX.sell.at, broker: FIX.broker, createdAt: new Date(), sellOrderId: FIX.sell.orderId, brokerOrderKey: key(FIX.sell.orderId), buyOrderKey: key(FIX.buy.orderId), repairedManually: true };
        say(`insert closedTrades: ${FIX.user} ${FIX.tsym} ${FIX.quantity} ${FIX.buy.price} -> ${FIX.sell.price} realized ${f2(pnl)} (exit ${FIX.sell.at.toISOString()})`);
        if (apply) await closed.insertOne(row);
        out.insertedClosed = true;
    }
    // 3. post-check: Mongo's ANT closed realized for the repaired day vs ANT's own realized (the dry run shows what it will be after the writes)
    const day = istDay(FIX.sell.at);
    if (istDay(now) !== day) { say(`post-check skipped: ANT's positions are for ${istDay(now)}, the repaired fill is of ${day} (compare that day's total with ANT's own report for it)`); return out; }
    const dayStart = new Date(`${day}T00:00:00+05:30`);
    const rows = await closed.find({ broker: FIX.broker, exitTime: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) } }).toArray();
    let mongoRealized = rows.reduce((a, r) => a + (Number(r.realizedPnL) || 0), 0);
    if (!apply) mongoRealized += (out.insertedClosed ? FIX.quantity * (FIX.sell.price - FIX.buy.price) : 0);
    if (positions && positions.success === true && Array.isArray(positions.positions)) {
        const antRealized = positions.positions.reduce((a, p) => a + (Number(p.realizedPnl) || 0), 0);
        const diff = mongoRealized - antRealized;
        out.postCheck = { mongoRealized, antRealized, diff };
        say(`post-check: Mongo ant closedTrades realized ${f2(mongoRealized)}${apply ? '' : ' (with the row this run would add)'} vs ANT realizedPnl ${f2(antRealized)}: difference ${f2(diff)} ${Math.abs(diff) <= 30 ? '(within the rounding tolerance)' : '(STILL DIFFERENT: run scripts/strategy-status.sh reconcile for the contract)'}`);
    } else say('post-check skipped: ANT positions unreadable (run scripts/strategy-status.sh reconcile afterwards)');
    return out;
}

module.exports = { repair, checkBook, FIX };

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const pi = process.argv.indexOf('--port');
    const port = pi > 0 ? Number(process.argv[pi + 1]) : 3000;
    (async () => {
        const client = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
        try {
            const book = await get(port, '/broker/ant/trades');
            const positions = await get(port, '/broker/ant/positions');
            const r = await repair(client.db(process.env.MONGO_DB || 'stocks'), { apply, book, positions, skipBrokerCheck: process.argv.includes('--skip-broker-check') });
            if (!apply) console.log('Dry run only. Re-run with --apply to write.');
            if (r.refused) process.exitCode = 2;
        } finally { await client.close(); }
    })().catch((e) => { console.error('repair failed:', e); process.exit(1); });
}
