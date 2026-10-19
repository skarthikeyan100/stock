// Builds per-minute premium-PCR + NIFTY rows for each backup day.
//
// Input : <backupsDir>/<Mon-DD>/csv/{OptionChain,OptionQuote,Quote}.csv
// Output: public/data/<YYYY-MM-DD>.json  and  public/data/index.json
//
// PCR here is a PREMIUM proxy, not OI PCR: the backups carry no OI.
//   pcr = sum(PE ltp) / sum(CE ltp) over strikes within WINDOW_POINTS of the
//   minute's NIFTY futures spot, using only strikes where both legs have a
//   price observed within MAX_STALE_MIN minutes.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const WINDOW_POINTS = 300;
const MAX_STALE_MIN = 5;
const DEFAULT_BACKUPS = '/home/karthikeyan/work/data/backups';
const DEFAULT_DAYS = ['Sep-01', 'Sep-02', 'Sep-03', 'Sep-04'];

const here = path.dirname(fileURLToPath(import.meta.url));
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

async function buildDay(backupsDir, folder) {
  const csvDir = path.join(backupsDir, folder, 'csv');

  // 1. Option chain snapshots -> one entry per minute (spot + CE strike set).
  const chain = new Map();
  await forEachRow(path.join(csvDir, 'OptionChain.csv'), (r) => {
    const minute = toMinute(r.fetchedAt);
    if (chain.has(minute)) return; // keep the first snapshot in each minute
    const legs = JSON.parse(r.values);
    const ceStrikes = new Set();
    for (const leg of legs) if (leg.optt === 'CE') ceStrikes.add(Math.round(Number(leg.strprc)));
    chain.set(minute, { spot: Number(r.spot), ceStrikes });
  });
  const minutes = [...chain.keys()].sort();
  if (minutes.length === 0) throw new Error(`${folder}: no OptionChain rows`);
  const day = minutes[0].slice(0, 10);

  // 2. NIFTY option LTPs -> last LTP per (minute, strike, type).
  const optTicks = new Map(); // minute -> Map("strike|CE/PE" -> ltp)
  await forEachRow(path.join(csvDir, 'OptionQuote.csv'), (r) => {
    if (r.index !== 'NIFTY') return;
    const m = toMinute(r.time);
    let bucket = optTicks.get(m);
    if (!bucket) optTicks.set(m, (bucket = new Map()));
    bucket.set(`${Math.round(Number(r.strike))}|${r.optionType}`, Number(r.ltp));
  });

  // 3. NIFTY index ticks -> OHLC per minute.
  const niftyBars = new Map();
  await forEachRow(path.join(csvDir, 'Quote.csv'), (r) => {
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

  // 4. Walk minutes in order, forward-filling option LTPs within the staleness cap.
  const lastSeen = new Map(); // "strike|type" -> { ltp, idx }
  const rows = [];
  let pcrMinutes = 0;
  let strikeSum = 0;
  let maxStaleSeen = 0;
  minutes.forEach((minute, idx) => {
    const { spot, ceStrikes } = chain.get(minute);
    const ticks = optTicks.get(minute);
    if (ticks) for (const [k, ltp] of ticks) lastSeen.set(k, { ltp, idx });

    let ce = 0;
    let pe = 0;
    let used = 0;
    for (const strike of ceStrikes) {
      if (Math.abs(strike - spot) > WINDOW_POINTS) continue;
      const c = lastSeen.get(`${strike}|CE`);
      const p = lastSeen.get(`${strike}|PE`);
      if (!c || !p) continue;
      if (idx - c.idx > MAX_STALE_MIN || idx - p.idx > MAX_STALE_MIN) continue;
      ce += c.ltp;
      pe += p.ltp;
      used++;
      maxStaleSeen = Math.max(maxStaleSeen, idx - c.idx, idx - p.idx);
    }
    const valid = used > 0 && ce > 0;
    const bar = niftyBars.get(minute) ?? null;
    rows.push({
      t: minute,
      spot,
      open: bar?.open ?? null,
      high: bar?.high ?? null,
      low: bar?.low ?? null,
      close: bar?.close ?? null,
      ce: valid ? ce : null,
      pe: valid ? pe : null,
      pcr: valid ? pe / ce : null,
      strikes: used,
    });
    if (valid) { pcrMinutes++; strikeSum += used; }
  });

  const niftyMinutes = rows.filter((r) => r.close !== null).length;
  const summary = {
    day,
    minutes: rows.length,
    pcrMinutes,
    niftyMinutes,
    avgStrikes: pcrMinutes ? +(strikeSum / pcrMinutes).toFixed(2) : 0,
    maxStaleSeen,
  };
  return { summary, file: { day, windowPoints: WINDOW_POINTS, maxStaleMin: MAX_STALE_MIN, rows } };
}

async function main() {
  const backupsDir = process.argv[2] ?? DEFAULT_BACKUPS;
  const folders = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_DAYS;
  fs.mkdirSync(outDir, { recursive: true });

  const index = [];
  for (const folder of folders) {
    console.log(`Building ${folder} ...`);
    const { summary, file } = await buildDay(backupsDir, folder);
    fs.writeFileSync(path.join(outDir, `${summary.day}.json`), JSON.stringify(file));
    index.push(summary);
    console.log(
      `  ${summary.day}: minutes=${summary.minutes} pcr=${summary.pcrMinutes} ` +
      `nifty=${summary.niftyMinutes} avgStrikes=${summary.avgStrikes} maxStale=${summary.maxStaleSeen}min`
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
