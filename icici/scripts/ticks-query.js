#!/usr/bin/env node
// Read-only view of the option tick history (Mongo `tickHistory`, written by the data process, kept ~1 day).
//   node scripts/ticks-query.js NIFTY01DEC26P25750 2026-11-25 10:30 11:00 [--every 60]   price series of one contract (any broker's name,
//                                                                                          or the key NIFTY|2026-12-01|25750|PE)
//   node scripts/ticks-query.js --summary [2026-11-25]                                    contracts of the day: ticks, first and last tick
// As a module: markAt(db, nameOrKey, atMs) -> last tick of the contract at or before atMs ({ t, ltp, bp, sp, ... } or null).
// Reads dist/ (run `npx tsc` after a code change). Times are IST. Never writes.
const path = require('path');
const { keyFromTsym, istDay } = require('../dist/util/tickKey');

function toKey(nameOrKey) {
    if (nameOrKey.includes('|')) return nameOrKey.toUpperCase();
    let lookup;
    try {
        const M = require('../dist/ant/AntContractMaster').default.getInstance();
        lookup = (t) => {
            const h = M.findByAnyBrokerTradingSymbol(t, 'NFO') || M.findByAnyBrokerTradingSymbol(t, 'BFO');
            const r = h && M.findByToken(h.token);
            return r && { symbol: r.symbol, expiryMs: r.expiryMs, strike: r.strike, optionType: r.optionType };
        };
    } catch (e) { /* the master files are only needed for month-only / expiry-less spellings */ }
    return keyFromTsym(nameOrKey, lookup);
}

// Several feeds may carry one contract (ANT and Breeze): the series is by key and time, whichever source.
async function markAt(db, nameOrKey, atMs) {
    const key = toKey(nameOrKey);
    if (!key) return null;
    const rows = await db.collection('tickHistory').find({ key, t: { $lte: atMs }, ltp: { $exists: true } }).sort({ t: -1 }).limit(1).toArray();
    return rows[0] || null;
}
module.exports = { markAt, toKey };

async function main() {
    require('dotenv/config');
    const Mongo = require('../dist/tools/mongo').default;
    const argv = process.argv.slice(2);
    const everyAt = argv.indexOf('--every');
    const every = everyAt >= 0 ? Number(argv[everyAt + 1]) : 0;
    const pos = argv.filter((a, i) => !a.startsWith('--') && !(everyAt >= 0 && i === everyAt + 1));
    await Mongo.init();
    const col = Mongo.getInstance().db.collection('tickHistory');
    if (argv.includes('--summary')) {
        const day = pos[0] || istDay(Date.now());
        const rows = await col.aggregate([
            { $match: { day } },
            { $group: { _id: '$key', ticks: { $sum: 1 }, first: { $min: '$t' }, last: { $max: '$t' }, srcs: { $addToSet: '$src' }, tsyms: { $addToSet: '$tsym' } } },
            { $sort: { _id: 1 } },
        ]).toArray();
        const hms = (ms) => new Date(ms + 330 * 60000).toISOString().slice(11, 19);
        console.log(`${day}: ${rows.length} contract(s), ${rows.reduce((a, r) => a + r.ticks, 0)} tick(s)`);
        for (const r of rows) console.log(`${r._id}  ticks ${r.ticks}  ${hms(r.first)} - ${hms(r.last)}  ${r.srcs.join('+')}  ${r.tsyms.join(',')}`);
        return;
    }
    const [name, day, from, to] = pos;
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^\d{2}:\d{2}(:\d{2})?$/.test(from || '') || !/^\d{2}:\d{2}(:\d{2})?$/.test(to || '')) {
        console.error('usage: node scripts/ticks-query.js <contract|key> YYYY-MM-DD HH:MM HH:MM [--every SECONDS]\n       node scripts/ticks-query.js --summary [YYYY-MM-DD]');
        process.exit(2);
    }
    const key = toKey(name);
    if (!key) { console.error(`cannot read '${name}' as an option contract`); process.exit(2); }
    const at = (hm) => new Date(`${day}T${hm.length === 5 ? hm + ':00' : hm}+05:30`).getTime();
    const rows = await col.find({ key, t: { $gte: at(from), $lt: at(to) } }).sort({ t: 1 }).toArray();
    console.log(`${key}: ${rows.length} tick(s) ${day} ${from}-${to} IST`);
    let nextAt = 0;
    for (const r of rows) {
        if (every > 0) { if (r.t < nextAt) continue; nextAt = r.t + every * 1000; }
        const hms = new Date(r.t + 330 * 60000).toISOString().slice(11, 23);
        const f = (x) => (x === undefined ? '-' : x);
        console.log(`${hms}  ltp ${f(r.ltp)}  bid ${f(r.bp)} x${f(r.bq)}  ask ${f(r.sp)} x${f(r.sq)}  vol ${f(r.v)}  ap ${f(r.ap)}  ${r.src}`);
    }
}
if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1); });
