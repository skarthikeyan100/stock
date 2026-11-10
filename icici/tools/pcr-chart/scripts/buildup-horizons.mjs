// Futures status signals (all four) across lookback windows and outcome horizons, with a day-level bootstrap.
//
// Usage: node scripts/buildup-horizons.mjs [dataDir] [day ...]
// Status from futures price and OI change over the lookback L:
//   long buildup  (price up, OI up)    -> expects NIFTY up
//   short covering (price up, OI down) -> expects NIFTY up
//   short buildup (price down, OI up)  -> expects NIFTY down
//   long unwinding (price down, OI down) -> expects NIFTY down
// Outcome: NIFTY spot change over the horizon H, signed by the expected direction.
// Also prints the base rate: how often NIFTY rose over H, for an always-up comparison.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachRow } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', 'data');
const days = process.argv.slice(3).length
  ? process.argv.slice(3)
  : fs.readdirSync(dataDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const OPEN = 9 * 3600 + 30 * 60;
const N = 360;
const LOOKBACKS = [5, 15, 30];
const HORIZONS = [5, 15, 30, 60];
const STATUSES = [
  { name: 'long buildup', dir: 1, test: (dp, dO) => dp > 0 && dO > 0 },
  { name: 'short covering', dir: 1, test: (dp, dO) => dp > 0 && dO < 0 },
  { name: 'short buildup', dir: -1, test: (dp, dO) => dp < 0 && dO > 0 },
  { name: 'long unwinding', dir: -1, test: (dp, dO) => dp < 0 && dO < 0 },
];

const secOf = (ts) => Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60 + Number(ts.slice(17, 19));
const minOf = (sec) => Math.floor((sec - OPEN) / 60);

async function minuteSeries(file, valCol, filter = () => true) {
  const arr = new Array(N).fill(null);
  await forEachRow(file, (r) => {
    if (!filter(r)) return;
    const i = minOf(secOf(r.time));
    if (i < 0 || i >= N || r[valCol] === '') return;
    const v = Number(r[valCol]);
    if (!Number.isNaN(v)) arr[i] = v;
  });
  for (let i = 1; i < N; i++) if (arr[i] == null) arr[i] = arr[i - 1];
  return arr;
}

const day = {}; // key -> per-day {n, hits, sum}
const base = {}; // H -> per-day {n, ups}
const dayData = {};
for (const d of days) {
  const dir = path.join(dataDir, d);
  const spot = await minuteSeries(path.join(dir, 'Quote.csv'), 'ltp', (r) => r.index === 'NIFTY');
  const fut = await minuteSeries(path.join(dir, 'FutureQuote.csv'), 'ltp');
  const oi = await minuteSeries(path.join(dir, 'FutureQuote.csv'), 'oi');
  dayData[d] = { spot, fut, oi };

  for (const H of HORIZONS) {
    const b = { n: 0, ups: 0 };
    for (let i = 0; i + H < N; i++) {
      if (spot[i] == null || spot[i + H] == null) continue;
      const m = spot[i + H] - spot[i];
      if (m === 0) continue;
      b.n++; if (m > 0) b.ups++;
    }
    (base[H] ??= []).push({ day: d, ...b });
  }

  for (const L of LOOKBACKS) {
    for (const H of HORIZONS) {
      for (const st of STATUSES) {
        const key = `${st.name} | lookback ${L}m | next ${H}m`;
        const cell = { day: d, n: 0, hits: 0, sum: 0 };
        for (let i = L; i + H < N; i++) {
          if (fut[i] == null || fut[i - L] == null || oi[i] == null || oi[i - L] == null) continue;
          if (!st.test(fut[i] - fut[i - L], oi[i] - oi[i - L])) continue;
          if (spot[i] == null || spot[i + H] == null) continue;
          const m = (spot[i + H] - spot[i]) * st.dir;
          if (m === 0) continue;
          cell.n++; cell.sum += m; if (m > 0) cell.hits++;
        }
        (day[key] ??= []).push(cell);
      }
    }
  }
}

function bootstrap(stats, B = 5000) {
  const usable = stats.filter((s) => s.n > 0);
  if (!usable.length) return null;
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const hr = [];
  for (let b = 0; b < B; b++) {
    let n = 0, h = 0;
    for (let k = 0; k < usable.length; k++) { const s = usable[Math.floor(rand() * usable.length)]; n += s.n; h += s.hits; }
    if (n) hr.push(h / n);
  }
  hr.sort((a, b) => a - b);
  return [hr[Math.floor(0.025 * hr.length)], hr[Math.floor(0.975 * hr.length)]];
}

const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const lines = [];
lines.push(`Days: ${days.join(', ')}`);
lines.push('');
lines.push('Base rate (NIFTY rose over H, all minutes): ' + HORIZONS.map((H) => {
  const rows = base[H];
  const n = rows.reduce((s, r) => s + r.n, 0), u = rows.reduce((s, r) => s + r.ups, 0);
  return `${H}m ${pct(u / n)} (n=${n})`;
}).join(' | '));
lines.push('(An always-long rule hits this rate; an always-short rule hits 1 minus it.)');
lines.push('');
lines.push('Status | lookback | horizon | n | hit | 95% CI | per-day hit (' + days.map((d) => d.slice(5)).join(', ') + ')');
for (const [key, cells] of Object.entries(day)) {
  const n = cells.reduce((s, c) => s + c.n, 0), h = cells.reduce((s, c) => s + c.hits, 0);
  const ci = bootstrap(cells);
  const per = cells.map((c) => (c.n ? (c.hits / c.n * 100).toFixed(0) : '—')).join(', ');
  lines.push(`${key.padEnd(52)} n=${String(n).padStart(4)} hit=${pct(h / n).padStart(6)} CI ${ci ? pct(ci[0]) + '-' + pct(ci[1]) : '—'}  per-day ${per}`);
}
const out = lines.join('\n');
console.log(out);
const reportPath = path.resolve(here, '..', 'reports', 'buildup-horizons.txt');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, out + '\n');
