// One-off, idempotent: sets every user's profitSplitPercent (the USER's share of net profit) to 40, matching
// DEFAULT_PROFIT_SPLIT_PERCENT and the landing page / T&C (platform 60%, user 40%). Past payouts keep the split they were
// computed with (each payout stores its own profitSplitPercent snapshot) - only the `users` collection is touched.
// Run:  node scripts/migrate-profit-split.js [--dry-run]
const { MongoClient } = require('mongodb');
const DRY = process.argv.includes('--dry-run');
const TARGET = 40;

(async () => {
    const client = await MongoClient.connect('mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
    const users = client.db('stocks').collection('users');
    const total = await users.countDocuments({});
    const rows = await users.aggregate([{ $group: { _id: '$profitSplitPercent', n: { $sum: 1 } } }]).toArray();
    console.log(`users: ${total}; current profitSplitPercent distribution:`, rows.map((r) => `${r._id ?? '(unset)'}: ${r.n}`).join(', '));
    const q = { profitSplitPercent: { $ne: TARGET } };
    const n = await users.countDocuments(q);
    if (!DRY && n) await users.updateMany(q, { $set: { profitSplitPercent: TARGET } });
    console.log(`profitSplitPercent -> ${TARGET}: ${n} ${DRY ? 'would be ' : ''}updated`);
    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
