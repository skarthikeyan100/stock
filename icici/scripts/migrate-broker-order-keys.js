// Idempotent backfill of the composite order key `<broker>:<orderId>` (src/util/orderKey.ts) onto existing Mongo documents.
// Default is a DRY RUN that only prints what it would do; pass --apply to write.
//   node scripts/migrate-broker-order-keys.js                         (dry run)
//   node scripts/migrate-broker-order-keys.js --apply
//   node scripts/migrate-broker-order-keys.js --apply --legacy-broker kite   (also key the docs that carry NO broker field as that broker; without the flag they are only reported)
// Collections / fields (only documents that have no key yet are touched, so a second run changes nothing):
//   Trade         brokerOrderId             -> brokerOrderKey
//   closedTrades  sellOrderId / buyOrderId  -> brokerOrderKey (the sell order's key) / buyOrderKey
//   orderOwners   orderId                   -> brokerOrderKey
// The key comes from the document's own `broker` field (legacy spellings 'zerodha', 'aliceblue', 'shoonya', 'icici' are normalised exactly as
// src/util/brokerName.ts does). A document with an order id but NO broker cannot be attributed from itself: it is counted and sampled in the report, and
// left unkeyed (the order process still matches it by raw id for the broker being processed, never across brokers) unless --legacy-broker names its broker.
// Then the indexes the process also creates at start-up are ensured (--apply only). Safe while the platform runs: it only adds a field that no reader requires.
const { MongoClient } = require('mongodb');

const ALIASES = { ant: 'ant', aliceblue: 'ant', 'alice blue': 'ant', 'alice-blue': 'ant', kite: 'kite', zerodha: 'kite', breeze: 'breeze', icici: 'breeze', 'icici direct': 'breeze', icicidirect: 'breeze', prism: 'prism', shoonya: 'prism', paper: 'paper' };
const normBroker = (b) => { if (typeof b !== 'string') return ''; const l = b.trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(ALIASES, l) ? ALIASES[l] : l; };
const keyOf = (broker, id) => `${normBroker(broker)}:${id}`;
const hasId = (v) => v != null && String(v) !== '';

// targets: [collection, id field, key field, optional [second id field, second key field]]
const TARGETS = [
    { col: 'Trade', idField: 'brokerOrderId', keyField: 'brokerOrderKey' },
    { col: 'closedTrades', idField: 'sellOrderId', keyField: 'brokerOrderKey', second: { idField: 'buyOrderId', keyField: 'buyOrderKey' } },
    { col: 'orderOwners', idField: 'orderId', keyField: 'brokerOrderKey' },
];

async function migrate(db, { apply = false, legacyBroker = null, log = console.log, batch = 500 } = {}) {
    const say = (m) => log(`${apply ? '' : '[dry-run] '}${m}`);
    const report = { keyed: 0, unattributable: 0, alreadyKeyed: 0, perCollection: {} };
    const legacy = legacyBroker ? normBroker(legacyBroker) : null;
    for (const t of TARGETS) {
        const col = db.collection(t.col);
        const rep = { scanned: 0, alreadyKeyed: 0, toKey: 0, unattributable: 0, samples: [] };
        const ops = [];
        const flush = async () => { if (apply && ops.length) { await col.bulkWrite(ops.splice(0), { ordered: false }); } else ops.length = 0; };
        const cur = col.find({ [t.idField]: { $exists: true, $nin: [null, ''] } });
        for await (const d of cur) {
            rep.scanned++;
            const set = {};
            const fields = [{ id: t.idField, key: t.keyField }, ...(t.second ? [{ id: t.second.idField, key: t.second.keyField }] : [])];
            let unattributed = false;
            for (const f of fields) {
                if (!hasId(d[f.id])) continue;
                if (d[f.key]) continue;
                const b = normBroker(d.broker) || legacy;
                if (!b) { unattributed = true; continue; }
                set[f.key] = keyOf(b, d[f.id]);
            }
            if (Object.keys(set).length) { rep.toKey++; ops.push({ updateOne: { filter: { _id: d._id, ...Object.fromEntries(Object.keys(set).map((k) => [k, { $exists: false }])) }, update: { $set: set } } }); if (ops.length >= batch) await flush(); }
            else if (unattributed) { rep.unattributable++; if (rep.samples.length < 5) rep.samples.push(`${d._id} ${t.idField}=${d[t.idField]}`); }
            else rep.alreadyKeyed++;
        }
        await flush();
        report.perCollection[t.col] = rep;
        report.keyed += rep.toKey; report.unattributable += rep.unattributable; report.alreadyKeyed += rep.alreadyKeyed;
        say(`${t.col}: scanned ${rep.scanned} document(s) with an order id: ${rep.toKey} ${apply ? 'keyed' : 'would be keyed'}, ${rep.alreadyKeyed} already keyed, ${rep.unattributable} cannot be attributed (no broker field)${rep.samples.length ? ` e.g. ${rep.samples.join('; ')}` : ''}`);
    }
    if (report.unattributable > 0 && !legacy) say(`${report.unattributable} document(s) have no broker field: they stay unkeyed (matched by raw id for the broker being processed only). If they are all one broker's, re-run with --legacy-broker <broker>`);
    if (apply) {
        await db.collection('Trade').createIndex({ brokerOrderKey: 1, action: 1 });
        await db.collection('closedTrades').createIndex({ brokerOrderKey: 1 }, { sparse: true });
        await db.collection('orderOwners').createIndex({ brokerOrderKey: 1 }, { sparse: true });
        say('indexes ensured: Trade {brokerOrderKey,action}, closedTrades {brokerOrderKey} sparse, orderOwners {brokerOrderKey} sparse');
    } else say('indexes that --apply ensures: Trade {brokerOrderKey,action}, closedTrades {brokerOrderKey} sparse, orderOwners {brokerOrderKey} sparse');
    return report;
}

module.exports = { migrate, keyOf, normBroker };

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const li = process.argv.indexOf('--legacy-broker');
    const legacyBroker = li > 0 ? process.argv[li + 1] : null;
    (async () => {
        const client = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/stocks', { useUnifiedTopology: true });
        try {
            await migrate(client.db(process.env.MONGO_DB || 'stocks'), { apply, legacyBroker });
            if (!apply) console.log('Dry run only. Re-run with --apply to write.');
        } finally { await client.close(); }
    })().catch((e) => { console.error('migration failed (documents already keyed stay keyed; re-running is safe):', e); process.exit(1); });
}
