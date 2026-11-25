// Idempotent, live-safe migration of the orderOwners ledger to broker-scoped ownership (open-review-items 140).
// Default is a DRY RUN that only prints what it would do; pass --apply to execute.
//   node scripts/migrate-order-owners-index.js            (dry run)
//   node scripts/migrate-order-owners-index.js --apply
// Steps (each skipped when already done):
//   1. duplicate (orderId, broker) documents (first writer = earliest `at` stays; the rest are copied to orderOwnersDuplicates, then deleted)
//   2. legacy rows without a `broker` field get the broker of the Trade rows that carry the same brokerOrderId, only when that is ONE broker
//   3. create the unique index {orderId:1, broker:1}, and ONLY THEN drop the old index on orderId alone
// The order process runs steps 3 on its own at startup (ensureOrderIndexes) when no duplicates exist; this script is for the duplicates / backfill
// and for doing it ahead of a restart. Safe while the platform runs: no read depends on the dropped index, and a failed step leaves the old index.
const { MongoClient } = require('mongodb');
const APPLY = process.argv.includes('--apply');
const URL = process.env.MONGO_URL || 'mongodb://localhost:27017/stocks';
const DB = process.env.MONGO_DB || 'stocks';
const say = (m) => console.log(`${APPLY ? '' : '[dry-run] '}${m}`);
const sameKeys = (k, want) => k && Object.keys(want).length === Object.keys(k).length && Object.entries(want).every(([f, d]) => k[f] === d);

(async () => {
    const client = await MongoClient.connect(URL, { useUnifiedTopology: true });
    try {
        const db = client.db(DB);
        const col = db.collection('orderOwners');
        // 1. duplicates
        const groups = await col.aggregate([
            { $group: { _id: { orderId: '$orderId', broker: { $ifNull: ['$broker', null] } }, ids: { $push: { _id: '$_id', at: '$at' } }, n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
        ]).toArray();
        let removed = 0;
        for (const g of groups) {
            const sorted = g.ids.slice().sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
            const extra = sorted.slice(1).map((x) => x._id);
            say(`duplicate orderId ${g._id.orderId} broker ${g._id.broker}: keep ${sorted[0]._id}, remove ${extra.length}`);
            if (APPLY) {
                const docs = await col.find({ _id: { $in: extra } }).toArray();
                if (docs.length) await db.collection('orderOwnersDuplicates').insertMany(docs.map((d) => ({ ...d, movedAt: new Date() })));
                removed += (await col.deleteMany({ _id: { $in: extra } })).deletedCount;
            }
        }
        say(`${groups.length} duplicate group(s)${APPLY ? `, ${removed} document(s) moved to orderOwnersDuplicates and removed` : ''}`);
        // 2. backfill the broker of legacy rows
        const legacy = await col.find({ broker: { $in: [null, ''] } }).toArray();
        let filled = 0, ambiguous = 0, unknown = 0;
        for (const r of legacy) {
            const brokers = (await db.collection('Trade').distinct('broker', { brokerOrderId: String(r.orderId) })).filter(Boolean);
            const canon = Array.from(new Set(brokers.map((b) => (/^\s*zerodha\s*$/i.test(b) ? 'kite' : b))));
            if (canon.length === 1) { filled++; if (APPLY) await col.updateOne({ _id: r._id }, { $set: { broker: canon[0] } }); }
            else if (canon.length > 1) ambiguous++; else unknown++;
        }
        say(`legacy rows without broker: ${legacy.length} (${filled} ${APPLY ? 'backfilled' : 'would be backfilled'}, ${ambiguous} ambiguous, ${unknown} no Trade row: left as is; a legacy row still answers for any broker)`);
        // 3. indexes: create the new one first, then drop the old one
        const indexes = await col.indexes().catch(() => []);
        const hasNew = indexes.some((i) => sameKeys(i.key, { orderId: 1, broker: 1 }) && i.unique === true);
        const old = indexes.find((i) => sameKeys(i.key, { orderId: 1 }));
        if (hasNew) say('unique index {orderId:1, broker:1} already exists');
        else { say('create unique index {orderId:1, broker:1}'); if (APPLY) await col.createIndex({ orderId: 1, broker: 1 }, { unique: true }); }
        if (old) { say(`drop old index ${old.name}${old.unique ? ' (unique on orderId alone)' : ''}`); if (APPLY) await col.dropIndex(old.name); }
        else say('old index on orderId alone does not exist');
        if (!APPLY) console.log('Dry run only. Re-run with --apply to execute.');
    } finally {
        await client.close();
    }
})().catch((e) => { console.error('migration failed (nothing after the failing step ran; the old index is untouched unless it was already dropped):', e); process.exit(1); });
