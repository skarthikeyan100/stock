// One-off: sets every user's profitSplitPercent (the USER's share of net profit) to an EXPLICIT value.
// The old version hard-coded 40 and applied it to everyone, which would have overwritten the level-based splits
// (settings.levelRules: beginner 35, advanced 25; DEFAULT_PROFIT_SPLIT_PERCENT = 35). It now changes nothing unless
// both --to <percent> and --apply are given; without --apply it only reports what would change.
// Past payouts keep the split they were computed with (each payout stores its own snapshot) - only `users` is touched.
// Run:  node scripts/migrate-profit-split.js --to 35            (report only)
//       node scripts/migrate-profit-split.js --to 35 --apply    (write)
const { MongoClient } = require('mongodb');
const APPLY = process.argv.includes('--apply');
const toIdx = process.argv.indexOf('--to');
const TARGET = toIdx >= 0 ? Number(process.argv[toIdx + 1]) : NaN;
if (!(TARGET > 0 && TARGET < 100)) {
    console.error('Refusing to run: pass --to <percent between 0 and 100> (there is no default). Add --apply to write; without it this is a report only.');
    process.exit(2);
}

(async () => {
    const client = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
    const users = client.db('stocks').collection('users');
    const total = await users.countDocuments({});
    const rows = await users.aggregate([{ $group: { _id: '$profitSplitPercent', n: { $sum: 1 } } }]).toArray();
    console.log(`users: ${total}; current profitSplitPercent distribution:`, rows.map((r) => `${r._id ?? '(unset)'}: ${r.n}`).join(', '));
    const q = { profitSplitPercent: { $ne: TARGET } };
    const n = await users.countDocuments(q);
    if (APPLY && n) await users.updateMany(q, { $set: { profitSplitPercent: TARGET } });
    console.log(`profitSplitPercent -> ${TARGET}: ${n} ${APPLY ? '' : 'would be '}updated`);
    await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
