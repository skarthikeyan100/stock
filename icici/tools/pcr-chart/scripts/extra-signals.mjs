// Extra signals on the captured days, with honest scoring.
//
// Usage: node scripts/extra-signals.mjs [dataDir] [day ...]
// Writes data/signal-results.json (read by scripts/build-signals-html.mjs) and prints a report.
//
// Signals:
//   A. Futures order-book imbalance (OBI) at tick level: (bq1 - sq1) / (bq1 + sq1), outcome = mid-price change
//      over 30s / 60s / 5m. Tested on all ticks and on strong ticks (|OBI| >= 0.5).
//   B. Futures buildup (long/short only, 5m) confirmed or contradicted by the PCR move over 15m.
//   C. Volatility target: next 15m realised range of NIFTY vs VIX level and VIX change (correlation and buckets).
//   D. Baseline: futures buildup (long/short, 5m) alone, for comparison.
//
// Scoring: per-day stats, then a day-level block bootstrap (resample whole days) for the hit rate and average move.
// COST_PTS (env, default 2) is an ASSUMED round-trip cost in index points, used only for the cost-adjusted average.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachRow } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', 'data');
const days = process.argv.slice(3).length
  ? process.argv.slice(3)
  : fs.readdirSync(dataDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const COST = Number(process.env.COST_PTS ?? 2);
const OUT = process.env.OUT ?? path.join(dataDir, 'signal-results.json');
const OPEN = 9 * 3600 + 30 * 60;
const CLOSE = 15 * 3600 + 30 * 60;
const N = 360;
const REGIONS = [['opening', 0, 60], ['range', 60, 150], ['lunch', 150, 240], ['closing', 240, 360]];
const MIN_CELL = 50;

const secOf = (ts) => Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60 + Number(ts.slice(17, 19));
const minOf = (sec) => Math.floor((sec - OPEN) / 60);
const regionOf = (i) => REGIONS.find(([, a, b]) => i >= a && i < b)?.[0] ?? null;
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const corr = (a, b) => {
  const p = a.map((v, i) => [v, b[i]]).filter(([x, y]) => x != null && y != null);
  if (p.length < 10) return null;
  const mx = mean(p.map(([x]) => x)), my = mean(p.map(([, y]) => y));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};

// deterministic PRNG so the bootstrap is reproducible
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- per-day loading ---------------------------------------------------------------------------------------
async function loadFutureTicks(dir) {
  const ticks = [];
  await forEachRow(path.join(dir, 'FutureQuote.csv'), (r) => {
    const t = secOf(r.time);
    if (t < OPEN || t >= CLOSE) return;
    const bp = Number(r['tick.bp1']), sp = Number(r['tick.sp1']);
    const bq = Number(r['tick.bq1']), sq = Number(r['tick.sq1']);
    if (!(bp > 0 && sp > 0)) return;
    ticks.push({ t, mid: (bp + sp) / 2, obi: bq + sq > 0 ? (bq - sq) / (bq + sq) : null });
  });
  return ticks.sort((a, b) => a.t - b.t);
}

// minute series: last value per minute, forward-filled
async function minuteSeries(file, timeCol, valCol, filter = () => true) {
  const arr = new Array(N).fill(null);
  if (!fs.existsSync(file)) return arr;
  await forEachRow(file, (r) => {
    if (!filter(r)) return;
    const s = secOf(r[timeCol]);
    const i = minOf(s);
    if (i < 0 || i >= N) return;
    const v = Number(r[valCol]);
    if (!Number.isNaN(v) && r[valCol] !== '') arr[i] = v;
  });
  for (let i = 1; i < N; i++) if (arr[i] == null) arr[i] = arr[i - 1];
  return arr;
}

// ---- A. tick-level OBI -------------------------------------------------------------------------------------
// outcome: mid change from tick j to the first tick at or after t+H (tolerance 30s)
function obiOutcomes(ticks, H, strong) {
  const out = []; // {sig, move, region}
  let k = 0;
  for (let j = 0; j < ticks.length; j++) {
    const { t, mid, obi } = ticks[j];
    if (obi == null || (strong ? Math.abs(obi) < 0.5 : obi === 0)) continue;
    while (k < ticks.length && ticks[k].t < t + H) k++;
    if (k >= ticks.length || ticks[k].t - (t + H) > 30) continue;
    const move = ticks[k].mid - mid;
    if (move === 0) continue;
    out.push({ sig: sign(obi), move, region: regionOf(minOf(t)), minute: minOf(t) });
  }
  return out;
}

// ---- minute-level signals ---------------------------------------------------------------------------------
function buildupSignal(fut, oi) {
  // long/short buildup only, 5m window: LB => +1, SB => -1, else 0
  const sig = new Array(N).fill(0);
  for (let i = 5; i < N; i++) {
    if (fut[i] == null || fut[i - 5] == null || oi[i] == null || oi[i - 5] == null) continue;
    const dP = fut[i] - fut[i - 5], dO = oi[i] - oi[i - 5];
    if (dP > 0 && dO > 0) sig[i] = 1;
    if (dP < 0 && dO > 0) sig[i] = -1;
  }
  return sig;
}

function minuteOutcomes(sig, spot, h = 5) {
  const out = [];
  for (let i = 0; i + h < N; i++) {
    const s = sign(sig[i]);
    if (!s || spot[i] == null || spot[i + h] == null) continue;
    const move = spot[i + h] - spot[i];
    if (move === 0) continue;
    out.push({ sig: s, move, region: regionOf(i), minute: i });
  }
  return out;
}

// ---- stats --------------------------------------------------------------------------------------------------
const summarise = (rows) => {
  const n = rows.length;
  const hits = rows.filter((r) => r.sig * r.move > 0).length;
  const sum = rows.reduce((s, r) => s + r.sig * r.move, 0);
  return { n, hits, sum };
};

// day-level block bootstrap of the pooled hit rate and mean signed move
function bootstrap(dayStats, B = 5000) {
  const usable = dayStats.filter((d) => d.n > 0);
  if (!usable.length) return null;
  const rand = rng(42);
  const hr = [], mv = [];
  for (let b = 0; b < B; b++) {
    let n = 0, h = 0, s = 0;
    for (let k = 0; k < usable.length; k++) {
      const d = usable[Math.floor(rand() * usable.length)];
      n += d.n; h += d.hits; s += d.sum;
    }
    if (n) { hr.push(h / n); mv.push(s / n); }
  }
  hr.sort((a, b) => a - b); mv.sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { hit_lo: q(hr, 0.025), hit_hi: q(hr, 0.975), avg_lo: q(mv, 0.025), avg_hi: q(mv, 0.975) };
}

// ---- main -----------------------------------------------------------------------------------------------------
const results = { cost_pts: COST, days, signals: {}, regions: {}, volatility: {}, horizons: {} };
const perDay = {}; // signal -> [{day, n, hits, sum}]
const pool = {};   // signal -> [{sig, move, region, day}]
const add = (name, day, rows) => {
  (pool[name] ??= []).push(...rows.map((r) => ({ ...r, day })));
  (perDay[name] ??= []).push({ day, ...summarise(rows) });
};
const volRows = [];

for (const day of days) {
  const dir = path.join(dataDir, day);
  const ticks = await loadFutureTicks(dir);
  const spot = await minuteSeries(path.join(dir, 'Quote.csv'), 'time', 'ltp', (r) => r.index === 'NIFTY');
  const fut = await minuteSeries(path.join(dir, 'FutureQuote.csv'), 'time', 'ltp');
  const oi = await minuteSeries(path.join(dir, 'FutureQuote.csv'), 'time', 'oi');
  const vix = await minuteSeries(path.join(dir, 'VixQuote.csv'), 'time', 'ltp');
  const pcr = await minuteSeries(path.join(dir, 'Pcr.csv'), 'fetchedAt', 'pcr', (r) => r.index === 'NIFTY');

  for (const [label, H] of [['30s', 30], ['60s', 60], ['5m', 300]]) {
    add(`OBI all ticks, next ${label}`, day, obiOutcomes(ticks, H, false));
    add(`OBI strong |OBI|>=0.5, next ${label}`, day, obiOutcomes(ticks, H, true));
  }

  const bu = buildupSignal(fut, oi);
  const buOut = minuteOutcomes(bu, spot, 5);
  add('Futures buildup long/short, next 5m', day, buOut);

  // B. PCR move over 15m, compared with the buildup direction
  const dPcr = pcr.map((v, i) => (i >= 15 && v != null && pcr[i - 15] != null ? v - pcr[i - 15] : null));
  const confirmed = bu.map((s, i) => (s && dPcr[i] != null && sign(dPcr[i]) === s ? s : 0));
  const contra = bu.map((s, i) => (s && dPcr[i] != null && sign(dPcr[i]) === -s ? s : 0));
  add('Buildup confirmed by PCR move, next 5m', day, minuteOutcomes(confirmed, spot, 5));
  add('Buildup against PCR move, next 5m', day, minuteOutcomes(contra, spot, 5));

  // C. volatility target: next 15m realised range vs VIX at the signal minute
  for (let i = 0; i + 15 < N; i++) {
    const w = spot.slice(i, i + 16).filter((v) => v != null);
    if (w.length < 10 || vix[i] == null || vix[i] === 0) continue;
    const dV = i >= 5 && vix[i - 5] ? vix[i] - vix[i - 5] : null;
    volRows.push({ range: Math.max(...w) - Math.min(...w), vix: vix[i], dVix: dV, day, region: regionOf(i) });
  }
}

// regions for the strongest OBI signal, and the baseline
const summaryRows = {};
for (const name of Object.keys(pool)) {
  const rows = pool[name];
  const overall = summarise(rows);
  const boot = bootstrap(perDay[name]);
  summaryRows[name] = {
    n: overall.n,
    hit: overall.n ? overall.hits / overall.n : null,
    avg: overall.n ? overall.sum / overall.n : null,
    avg_net: overall.n ? overall.sum / overall.n - COST : null,
    days: perDay[name].filter((d) => d.n > 0).length,
    boot,
  };
  const reg = {};
  for (const [r] of REGIONS) {
    const s = summarise(rows.filter((x) => x.region === r));
    reg[r] = { n: s.n, hit: s.n ? s.hits / s.n : null, avg: s.n ? s.sum / s.n : null, ok: s.n >= MIN_CELL };
  }
  results.regions[name] = reg;
}
results.signals = summaryRows;

// volatility target
const vr = volRows;
results.volatility = {
  n: vr.length,
  r_vix_level_vs_range: corr(vr.map((x) => x.vix), vr.map((x) => x.range)),
  r_dvix_vs_range: corr(vr.map((x) => x.dVix), vr.map((x) => x.range)),
  mean_range_by_vix: [],
  mean_range_by_dvix: [],
};
// VIX terciles (pooled)
const sortedVix = vr.map((x) => x.vix).sort((a, b) => a - b);
const cut = [sortedVix[Math.floor(sortedVix.length / 3)], sortedVix[Math.floor((2 * sortedVix.length) / 3)]];
const bucket = (v) => (v < cut[0] ? 'low' : v < cut[1] ? 'mid' : 'high');
for (const b of ['low', 'mid', 'high']) {
  const xs = vr.filter((x) => bucket(x.vix) === b).map((x) => x.range);
  results.volatility.mean_range_by_vix.push({ bucket: b, n: xs.length, mean_range: mean(xs) });
}
for (const [b, test] of [['VIX falling (15m)', (x) => x.dVix < 0], ['VIX rising (15m)', (x) => x.dVix > 0]]) {
  const xs = vr.filter((x) => x.dVix != null && test(x)).map((x) => x.range);
  results.volatility.mean_range_by_dvix.push({ bucket: b, n: xs.length, mean_range: mean(xs) });
}
results.volatility.vix_cuts = cut;

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

// ---- report -------------------------------------------------------------------------------------------------
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
console.log(`Days: ${days.join(', ')}   cost assumption: ${COST} pts round trip\n`);
console.log('Signal'.padEnd(46), 'n'.padStart(6), 'hit%'.padStart(7), '95% CI hit'.padStart(16), 'avg'.padStart(7), 'net'.padStart(7), 'days'.padStart(5));
for (const [name, s] of Object.entries(summaryRows)) {
  const ci = s.boot ? `${f(s.boot.hit_lo * 100, 0)}-${f(s.boot.hit_hi * 100, 0)}` : '—';
  console.log(name.padEnd(46), String(s.n).padStart(6), f(s.hit * 100, 1).padStart(7), ci.padStart(16), f(s.avg).padStart(7), f(s.avg_net).padStart(7), String(s.days).padStart(5));
}
console.log('\nBy session region (cells with n<50 suppressed):');
for (const [name, reg] of Object.entries(results.regions)) {
  const cells = REGIONS.map(([r]) => (reg[r].ok ? `${r} ${f(reg[r].hit * 100, 0)}% (n=${reg[r].n})` : `${r} n<50`));
  console.log(`  ${name}: ${cells.join(' | ')}`);
}
const v = results.volatility;
console.log(`\nVolatility target (next 15m NIFTY range, n=${v.n}):`);
console.log(`  r(VIX level, range) = ${f(v.r_vix_level_vs_range)}   r(15m VIX change, range) = ${f(v.r_dvix_vs_range)}`);
for (const b of v.mean_range_by_vix) console.log(`  VIX ${b.bucket.padEnd(4)} mean range ${f(b.mean_range, 1)} pts (n=${b.n})`);
for (const b of v.mean_range_by_dvix) console.log(`  ${b.bucket.padEnd(18)} mean range ${f(b.mean_range, 1)} pts (n=${b.n})`);
