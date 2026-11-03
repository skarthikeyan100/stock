// Predefined read-only Mongo queries for strategy status (cheap in tokens vs reading orchestrator.log).
// Usage: node scripts/strategy-db.js <query> [arg] [YYYY-MM-DD]      (day defaults to today, IST)
//   open [strategy]     net position per strategy+contract+broker from the day's fills (Buy - Sell), with avg buy; only non-zero nets
//   resting [strategy]  resting limit orders (pendingLimitOrders): the sells/buys the platform believes are live
//   fills <tsym|strategy> [day]  the day's fills for a contract (or strategy), oldest first, compact
//   pnl [day]           realized P&L from closedTrades per strategy+broker for the day
//   anomalies [day]     net < 0 (sold more than bought) and fills with quantity above the freeze size
//   latches             strategyLatches
// "strategy" and "tsym" match by substring, case-insensitive. Reads Mongo directly (stocks db), no process needed.
process.env.NODE_NO_WARNINGS = '1';
const { MongoClient } = require('mongodb');
const [q, arg, dayArg] = process.argv.slice(2);
const dayOf = (s) => { const d = s || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); const from = new Date(`${d}T00:00:00+05:30`); return { d, from, to: new Date(from.getTime() + 864e5) }; };
const rx = (s) => ({ $regex: String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });
const hhmmss = (t) => new Date(t.getTime() + 5.5 * 3600e3).toISOString().slice(11, 19);
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

(async () => {
    const c = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017', { useUnifiedTopology: true });
    const db = c.db('stocks');
    const looksLikeTsym = (s) => /\d/.test(s || '') && /(CE|PE)$/i.test(s);
    try {
        if (q === 'open' || q === 'anomalies') {
            const day = dayOf(q === 'anomalies' ? arg : dayArg);
            const match = { entryTime: { $gte: day.from, $lt: day.to }, status: 'COMPLETE' };
            if (q === 'open' && arg) match.user = rx(arg);
            const rows = await db.collection('Trade').aggregate([{ $match: match }, { $group: {
                _id: { u: '$user', t: '$tsym', b: '$broker' },
                buyQty: { $sum: { $cond: [{ $eq: ['$action', 'Buy'] }, '$quantity', 0] } },
                buyVal: { $sum: { $cond: [{ $eq: ['$action', 'Buy'] }, { $multiply: ['$quantity', '$price'] }, 0] } },
                sellQty: { $sum: { $cond: [{ $eq: ['$action', 'Sell'] }, '$quantity', 0] } },
                sellVal: { $sum: { $cond: [{ $eq: ['$action', 'Sell'] }, { $multiply: ['$quantity', '$price'] }, 0] } },
                maxFill: { $max: '$quantity' }, last: { $max: '$entryTime' } } }, { $sort: { '_id.u': 1, last: 1 } }]).toArray();
            console.log(`${day.d} (fills in Trade; NRML positions held from an earlier day are not included)`);
            let n = 0;
            for (const r of rows) {
                const net = r.buyQty - r.sellQty;
                if (q === 'open' && net === 0) continue;
                if (q === 'anomalies' && !(net < 0 || r.maxFill > 1755)) continue;
                n++;
                console.log(`${pad(r._id.u, 28)} ${pad(r._id.b || '-', 6)} ${pad(r._id.t, 20)} net ${String(net).padStart(6)}  bought ${r.buyQty} avg ${r.buyQty ? f2(r.buyVal / r.buyQty) : '-'}  sold ${r.sellQty} avg ${r.sellQty ? f2(r.sellVal / r.sellQty) : '-'}  last ${hhmmss(r.last)}${r.maxFill > 1755 ? '  MAXFILL ' + r.maxFill : ''}`);
            }
            if (!n) console.log(q === 'open' ? 'no open net positions from today\'s fills' : 'no anomalies');
        } else if (q === 'resting') {
            const rows = await db.collection('pendingLimitOrders').find(arg ? { userId: rx(arg) } : {}).toArray();
            for (const r of rows) console.log(`${pad(r.userId, 28)} ${pad(r.action, 4)} ${pad(r.tradingSymbol, 20)} qty ${r.quantity}  order ${r.orderId}`);
            if (!rows.length) console.log('no resting limit orders recorded');
            for (const col of ['pendingAntLimitOrders', 'pendingBreezeLimitOrders']) {
                const n = await db.collection(col).countDocuments();
                if (n) console.log(`${col}: ${n}`);
            }
        } else if (q === 'fills') {
            if (!arg) throw new Error('fills needs a tsym or strategy');
            const day = dayOf(dayArg);
            const filter = { entryTime: { $gte: day.from, $lt: day.to } };
            if (looksLikeTsym(arg)) filter.tsym = rx(arg); else filter.user = rx(arg);
            const rows = await db.collection('Trade').find(filter).sort({ entryTime: 1 }).toArray();
            for (const r of rows) console.log(`${hhmmss(r.entryTime)} ${pad(r.user, 26)} ${pad(r.broker || '-', 6)} ${pad(r.action, 4)} ${pad(r.tsym, 20)} qty ${String(r.quantity).padStart(5)} @ ${r.price}  order ${r.brokerOrderId}`);
            console.log(`${rows.length} fills`);
        } else if (q === 'pnl') {
            const day = dayOf(arg);
            const rows = await db.collection('closedTrades').aggregate([{ $match: { exitTime: { $gte: day.from, $lt: day.to } } },
                { $group: { _id: { u: '$user', b: '$broker' }, n: { $sum: 1 }, pnl: { $sum: '$realizedPnL' } } }, { $sort: { '_id.u': 1 } }]).toArray();
            let t = 0;
            for (const r of rows) { t += r.pnl; console.log(`${pad(r._id.u, 28)} ${pad(r._id.b || '-', 6)} closed ${String(r.n).padStart(3)}  realized ${f2(r.pnl).padStart(11)}`); }
            console.log(`${pad('TOTAL', 36)} realized ${f2(t).padStart(11)}   (${day.d})`);
        } else if (q === 'latches') {
            for (const r of await db.collection('strategyLatches').find().toArray()) console.log(JSON.stringify(r));
        } else {
            console.log('usage: node scripts/strategy-db.js open|resting|fills|pnl|anomalies|latches [arg] [YYYY-MM-DD]');
            process.exitCode = 2;
        }
    } finally { await c.close(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
