// One-off, idempotent: rewrites legacy broker name 'zerodha' to 'kite' in persisted Mongo data.
// Run with the markets closed / no open positions:  node scripts/migrate-broker-names.js [--dry-run]
// Code also accepts 'zerodha' on read (src/util/brokerName.ts), but Mongo queries filter on the
// canonical name, so persisted rows must carry it.
const { MongoClient } = require('mongodb');
const DRY = process.argv.includes('--dry-run');
const LEGACY = 'zerodha', CANON = 'kite';

function rename(o) {
    if (Array.isArray(o)) return o.map(rename);
    if (o && typeof o === 'object' && !(o instanceof Date) && o.constructor === Object) {
        const out = {};
        for (const k of Object.keys(o)) {
            const nk = k === LEGACY ? CANON : k.startsWith(LEGACY + '_') ? CANON + k.slice(LEGACY.length) : k;
            out[nk] = rename(o[k]);
        }
        return out;
    }
    if (typeof o === 'string') return o === LEGACY ? CANON : o.startsWith(LEGACY + ':') ? CANON + o.slice(LEGACY.length) : o;
    return o;
}

(async () => {
    const client = await MongoClient.connect('mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
    const db = client.db('stocks');
    for (const name of ['Trade', 'closedTrades']) {
        const q = { broker: LEGACY };
        const n = await db.collection(name).countDocuments(q);
        if (!DRY && n) await db.collection(name).updateMany(q, { $set: { broker: CANON } });
        console.log(`${name}.broker: ${n} ${DRY ? 'would be ' : ''}updated`);
    }
    const latches = await db.collection('strategyLatches').find({ scope: new RegExp('^' + LEGACY + '(:|$)') }).toArray();
    for (const d of latches) if (!DRY) await db.collection('strategyLatches').updateOne({ _id: d._id }, { $set: { scope: rename(d.scope) } });
    console.log(`strategyLatches.scope: ${latches.length} ${DRY ? 'would be ' : ''}updated`);
    const states = await db.collection('bulkPcrStrategyState').find({}).toArray();
    let ns = 0;
    for (const d of states) {
        const { _id, ...rest } = d;
        const next = rename(rest);
        if (JSON.stringify(next) !== JSON.stringify(rest)) {
            ns++;
            if (!DRY) await db.collection('bulkPcrStrategyState').replaceOne({ _id }, next);
        }
    }
    console.log(`bulkPcrStrategyState: ${ns} ${DRY ? 'would be ' : ''}updated`);
    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
