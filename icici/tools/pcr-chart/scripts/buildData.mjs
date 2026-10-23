// Builds per-minute OI-PCR + NIFTY rows for each stored day.
//
// Input : <repo>/tools/pcr-chart/data/<YYYY-MM-DD>/{Pcr,Quote}.csv
//         (Mongo exports of the Pcr and Quote collections, as written by backupAndClearStocks)
// Output: public/data/<YYYY-MM-DD>.json  and  public/data/index.json
//
// pcr is the stored Pcr document's value (total put OI / total call OI over the subscribed
// NIFTY contracts); the last document in each minute wins.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = path.resolve(here, '..', 'data');
const outDir = path.resolve(here, '..', 'public', 'data');

// Minimal CSV line splitter: handles "quoted, fields" and "" escapes.
// None of the backup files contain embedded newlines.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function forEachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (!header) { header = cols; continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cols[i];
    fn(row);
  }
}

// "2026-09-02 09:15:40" -> "2026-09-02 09:15"
const toMinute = (ts) => ts.slice(0, 16);

async function buildDay(dataDir, folder) {
  const dir = path.join(dataDir, folder);

  // 1. Pcr documents -> last document per minute.
  const pcrByMinute = new Map();
  await forEachRow(path.join(dir, 'Pcr.csv'), (r) => {
    if (r.index !== 'NIFTY') return;
    const pcr = Number(r.pcr);
    pcrByMinute.set(toMinute(r.fetchedAt), {
      pcr: r.pcr === '' || !Number.isFinite(pcr) ? null : pcr,
      ceOi: Number(r.ceOi),
      peOi: Number(r.peOi),
      contracts: Number(r.contracts),
    });
  });
  const minutes = [...pcrByMinute.keys()].sort();
  if (minutes.length === 0) throw new Error(`${folder}: no Pcr rows`);
  const day = minutes[0].slice(0, 10);

  // 2. NIFTY index ticks -> OHLC per minute.
  const niftyBars = new Map();
  await forEachRow(path.join(dir, 'Quote.csv'), (r) => {
    if (r.index !== 'NIFTY') return;
    const ltp = Number(r.ltp);
    const m = toMinute(r.time);
    const b = niftyBars.get(m);
    if (!b) niftyBars.set(m, { open: ltp, high: ltp, low: ltp, close: ltp });
    else {
      b.high = Math.max(b.high, ltp);
      b.low = Math.min(b.low, ltp);
      b.close = ltp;
    }
  });

  // 3. One row per Pcr minute, joined with that minute's NIFTY bar.
  const rows = [];
  let pcrMinutes = 0;
  let contractSum = 0;
  for (const minute of minutes) {
    const p = pcrByMinute.get(minute);
    const bar = niftyBars.get(minute) ?? null;
    const valid = p.pcr !== null && p.contracts > 0;
    rows.push({
      t: minute,
      open: bar?.open ?? null,
      high: bar?.high ?? null,
      low: bar?.low ?? null,
      close: bar?.close ?? null,
      ceOi: valid ? p.ceOi : null,
      peOi: valid ? p.peOi : null,
      pcr: valid ? p.pcr : null,
      contracts: valid ? p.contracts : null,
    });
    if (valid) { pcrMinutes++; contractSum += p.contracts; }
  }

  const niftyMinutes = rows.filter((r) => r.close !== null).length;
  const summary = {
    day,
    minutes: rows.length,
    pcrMinutes,
    niftyMinutes,
    avgContracts: pcrMinutes ? +(contractSum / pcrMinutes).toFixed(2) : 0,
  };
  return { summary, file: { day, rows } };
}

async function main() {
  const dataDir = process.argv[2] ?? DEFAULT_DATA;
  const folders = process.argv.slice(3).length
    ? process.argv.slice(3)
    : fs.readdirSync(dataDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  fs.mkdirSync(outDir, { recursive: true });

  const index = [];
  for (const folder of folders) {
    console.log(`Building ${folder} ...`);
    const { summary, file } = await buildDay(dataDir, folder);
    fs.writeFileSync(path.join(outDir, `${summary.day}.json`), JSON.stringify(file));
    index.push(summary);
    console.log(
      `  ${summary.day}: minutes=${summary.minutes} pcr=${summary.pcrMinutes} ` +
      `nifty=${summary.niftyMinutes} avgContracts=${summary.avgContracts}`
    );
  }
  index.sort((a, b) => a.day.localeCompare(b.day));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Wrote ${index.length} day(s) to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
