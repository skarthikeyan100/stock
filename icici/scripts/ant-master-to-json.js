#!/usr/bin/env node
// Converts AliceBlue's raw contract-master CSV (Exch,Exchange Segment,Symbol,
// Token,Instrument Type,Option Type,Strike Price,Instrument Name,Formatted Ins
// Name,Trading Symbol,Expiry Date,Lot Size,Tick Size - column order confirmed
// live 2026-10-13, differs slightly between NFO/BFO) into the {"NFO": [...]}/
// {"BFO": [...]} JSON shape AntContractMaster.ts expects.
//
// 'Expiry Date' arrives as 'YYYY-MM-DD' - AntContractMaster.ts parses it with
// parseInt() and compares against Date.now() truncated to the day, so it must
// be converted to an epoch-ms-at-midnight-UTC string here, matching the
// existing cached file's format exactly.
//
// Usage: node ant-master-to-json.js <in.csv> <out.json> <ROOT_KEY>
//   ROOT_KEY is 'NFO' or 'BFO'.
const fs = require('fs');

const [, , inPath, outPath, rootKey] = process.argv;
if (!inPath || !outPath || !rootKey) {
    console.error('Usage: node ant-master-to-json.js <in.csv> <out.json> <NFO|BFO>');
    process.exit(1);
}

const text = fs.readFileSync(inPath, 'utf8');
const lines = text.split('\n').filter((l) => l.length > 0);
const header = lines[0].split(',');

const MIN_RECORDS = 100; // a real NFO/BFO master has thousands of rows; fewer means an HTML/empty/garbled download
if (!/Token/i.test(lines[0] || '') || !/Expiry/i.test(lines[0] || '')) {
    console.error(`[ant-master-to-json] ${inPath} does not look like a contract master (unexpected header) - aborting`);
    process.exit(2);
}

let skippedNoExpiry = 0;
const records = [];
for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length !== header.length) continue; // skip malformed/truncated rows
    const rec = {};
    header.forEach((h, idx) => { rec[h] = cols[idx]; });
    const expiryMs = Date.parse(rec['Expiry Date'] + 'T00:00:00.000Z');
    if (!Number.isFinite(expiryMs)) { skippedNoExpiry++; continue; } // would otherwise be stored as the string 'NaN'
    rec['Expiry Date'] = String(expiryMs);
    records.push(rec);
}

if (records.length < MIN_RECORDS) {
    console.error(`[ant-master-to-json] only ${records.length} valid records in ${inPath} (need >= ${MIN_RECORDS}) - refusing to write ${outPath}`);
    process.exit(3);
}
if (skippedNoExpiry > 0) console.log(`[ant-master-to-json] ${rootKey}: skipped ${skippedNoExpiry} rows without a valid expiry`);

// Write beside the target and rename, so a reader never sees a half-written file.
const tmpPath = `${outPath}.tmp-${process.pid}`;
fs.writeFileSync(tmpPath, JSON.stringify({ [rootKey]: records }));
fs.renameSync(tmpPath, outPath);
console.log(`[ant-master-to-json] ${rootKey}: wrote ${records.length} records to ${outPath}`);
