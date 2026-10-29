// Dumps one IST trading day's Trade fills, closedTrades and legLineage from Mongo into <outdir> as JSON,
// for scripts/trades-summary.py. Usage: node scripts/trades-summary-dump.js YYYY-MM-DD <outdir>
// Reads the compiled output (dist/), so run `npx tsc` first if dist/ is stale.
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const Mongo = require('../dist/tools/mongo').default;

const [date, outDir] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !outDir) {
    console.error('usage: node scripts/trades-summary-dump.js YYYY-MM-DD <outdir>');
    process.exit(2);
}
const from = new Date(`${date}T00:00:00+05:30`);
const to = new Date(from.getTime() + 24 * 3600 * 1000);

(async () => {
    await Mongo.init();
    const db = Mongo.getInstance().db;
    fs.mkdirSync(outDir, { recursive: true });
    const write = (name, rows) => {
        fs.writeFileSync(path.join(outDir, name), JSON.stringify(rows));
        console.log(name, rows.length);
    };
    write('closed.json', await db.collection('closedTrades').find({ exitTime: { $gte: from, $lt: to } }).sort({ exitTime: 1 }).toArray());
    write('trade.json', await db.collection('Trade').find({ entryTime: { $gte: from, $lt: to } }).sort({ entryTime: 1 }).toArray());
    write('lineage.json', await db.collection('legLineage').find({ createdAt: { $gte: from, $lt: to } }).sort({ createdAt: 1 }).toArray());
    process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
