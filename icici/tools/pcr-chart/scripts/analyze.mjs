// Price-action analysis over the stored day folders.
//
// Usage: node scripts/analyze.mjs [dataDir] [day ...]
// Reads data/<YYYY-MM-DD>/{Quote,OptionQuote}.csv (always) and FutureQuote.csv / VixQuote.csv (when present).
//
// Every directional signal is scored the same way: at each minute with a non-zero signal, did NIFTY move the
// signalled way over the next 5/15/30 minutes, and by how many points on average (signed with the signal).
// Pooled across days at the end. One day is indicative only; look for consistency over >= 5 sessions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachRow } from './csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HORIZONS = [5, 15, 30];
const RATE = 0.065; // risk-free rate for Black-Scholes; IV is insensitive to it over a few days
const STALE = 5; // minutes an option price may be carried forward
const OPEN_MIN = 9 * 60 + 30;
const N = 360; // minutes 09:30 .. 15:29

const minuteIdx = (ts) => Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) - OPEN_MIN;
const hhmm = (i) => { const m = i + OPEN_MIN; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));

function corr(a, b) {
  const p = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) p.push([a[i], b[i]]);
  const n = p.length;
  if (n < 10) return { r: null, n };
  const mx = p.reduce((s, [x]) => s + x, 0) / n;
  const my = p.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, n };
}

// ---- Black-Scholes implied volatility (bisection) --------------------------------------------------------
const cnd = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
function bs(isCall, S, K, T, sigma) {
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (RATE + (sigma * sigma) / 2) * T) / sd;
  const d2 = d1 - sd;
  const disc = Math.exp(-RATE * T);
  return isCall ? S * cnd(d1) - K * disc * cnd(d2) : K * disc * cnd(-d2) - S * cnd(-d1);
}
function impliedVol(isCall, S, K, T, price) {
  const intrinsic = Math.max(0, isCall ? S - K * Math.exp(-RATE * T) : K * Math.exp(-RATE * T) - S);
  if (!(price > intrinsic + 0.05) || T <= 0) return null;
  let lo = 0.01, hi = 3;
  if (bs(isCall, S, K, T, hi) < price) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (bs(isCall, S, K, T, mid) < price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// "NIFTY27OCT26C22650" -> expiry 2026-10-27 15:30 IST, as a Date
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function expiryOf(tsym) {
  const m = /^NIFTY(\d\d)([A-Z]{3})(\d\d)[CP]/.exec(tsym);
  if (!m) return null;
  return new Date(Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 10, 0)); // 15:30 IST = 10:00 UTC
}

// ---- pooled scoring --------------------------------------------------------------------------------------
const pooled = new Map(); // "name|h" -> { n, hits, sum }
function score(name, signal, spot, perDayLines) {
  for (const h of HORIZONS) {
    let n = 0, hits = 0, sum = 0;
    for (let i = 0; i + h < N; i++) {
      const s = sign(signal[i] ?? 0);
      if (!s || spot[i] == null || spot[i + h] == null) continue;
      const move = (spot[i + h] - spot[i]) * s;
      n++; sum += move; if (move > 0) hits++;
      const key = `${name}|${h}`;
      const t = pooled.get(key) ?? { n: 0, hits: 0, sum: 0 };
      t.n++; t.sum += move; if (move > 0) t.hits++;
      pooled.set(key, t);
    }
    perDayLines.push(`  ${name.padEnd(34)} next ${String(h).padStart(2)}m  n=${String(n).padStart(3)}  hit ${n ? fmt((hits / n) * 100, 0) : '—'}%  avg ${n ? fmt(sum / n) : '—'} pts`);
  }
}

// ---- loading ---------------------------------------------------------------------------------------------
async function loadDay(dir) {
  const spot = new Array(N).fill(null);
  const hi = new Array(N).fill(null);
  const lo = new Array(N).fill(null);
  await forEachRow(path.join(dir, 'Quote.csv'), (r) => {
    if (r.index !== 'NIFTY') return;
    const i = minuteIdx(r.time);
    if (i < 0 || i >= N) return;
    const p = Number(r.ltp);
    spot[i] = p;
    hi[i] = hi[i] == null ? p : Math.max(hi[i], p);
    lo[i] = lo[i] == null ? p : Math.min(lo[i], p);
  });
  for (let i = 1; i < N; i++) if (spot[i] == null) spot[i] = spot[i - 1];

  // options: last ltp per minute per contract, oi carried forward
  const opts = new Map(); // tsym -> { strike, isCall, expiry, ltp[N], oi[N] }
  await forEachRow(path.join(dir, 'OptionQuote.csv'), (r) => {
    if (r.index !== 'NIFTY') return;
    const i = minuteIdx(r.time);
    if (i < 0 || i >= N) return;
    let o = opts.get(r.tsym);
    if (!o) opts.set(r.tsym, (o = { strike: Number(r.strike), isCall: r.optionType === 'CE', expiry: expiryOf(r.tsym), ltp: new Array(N).fill(null), oi: new Array(N).fill(null) }));
    o.ltp[i] = Number(r.ltp);
    if (r.oi !== '') o.oi[i] = Number(r.oi);
  });
  for (const o of opts.values()) {
    let lastOi = null;
    let lastLtp = null;
    let age = 0;
    for (let i = 0; i < N; i++) {
      if (o.oi[i] != null) lastOi = o.oi[i]; else o.oi[i] = lastOi;
      if (o.ltp[i] != null) { lastLtp = o.ltp[i]; age = 0; } else if (lastLtp != null && ++age <= STALE) o.ltp[i] = lastLtp;
    }
  }

  let fut = null;
  const fp = path.join(dir, 'FutureQuote.csv');
  if (fs.existsSync(fp)) {
    fut = { ltp: new Array(N).fill(null), oi: new Array(N).fill(null), vol: new Array(N).fill(null) };
    await forEachRow(fp, (r) => {
      const i = minuteIdx(r.time);
      if (i < 0 || i >= N) return;
      fut.ltp[i] = Number(r.ltp);
      if (r.oi !== '') fut.oi[i] = Number(r.oi);
      if (r.vol !== '') fut.vol[i] = Number(r.vol);
    });
    for (let i = 1; i < N; i++) for (const k of ['ltp', 'oi', 'vol']) if (fut[k][i] == null) fut[k][i] = fut[k][i - 1];
  }
  let vix = null;
  const vp = path.join(dir, 'VixQuote.csv');
  if (fs.existsSync(vp)) {
    vix = new Array(N).fill(null);
    await forEachRow(vp, (r) => { const i = minuteIdx(r.time); if (i >= 0 && i < N) vix[i] = Number(r.ltp); });
    for (let i = 1; i < N; i++) if (vix[i] == null) vix[i] = vix[i - 1];
  }
  return { spot, hi, lo, opts: [...opts.values()], fut, vix };
}

// ---- per-day analysis ------------------------------------------------------------------------------------
async function analyzeDay(day, dir) {
  const { spot, hi, lo, opts, fut, vix } = await loadDay(dir);
  const out = [`\n=== ${day} ===`];
  const first = spot.findIndex((v) => v != null);
  const valid = spot.filter((v) => v != null);
  out.push(`NIFTY ${fmt(spot[first])} -> ${fmt(spot[N - 1])}  range ${fmt(Math.min(...lo.filter((v) => v != null)))}-${fmt(Math.max(...hi.filter((v) => v != null)))}  (${valid.length} minutes with a price)`);

  // 1+2. ATM straddle and implied volatility
  const straddle = new Array(N).fill(null), atmIv = new Array(N).fill(null), skew = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (spot[i] == null) continue;
    const byStrike = new Map();
    for (const o of opts) {
      if (o.ltp[i] == null || !o.expiry) continue;
      const e = byStrike.get(o.strike) ?? {};
      e[o.isCall ? 'ce' : 'pe'] = o;
      byStrike.set(o.strike, e);
    }
    const both = [...byStrike.entries()].filter(([, e]) => e.ce && e.pe);
    if (!both.length) continue;
    both.sort((a, b) => Math.abs(a[0] - spot[i]) - Math.abs(b[0] - spot[i]));
    const [k, e] = both[0];
    if (Math.abs(k - spot[i]) > 75) continue;
    straddle[i] = e.ce.ltp[i] + e.pe.ltp[i];
    const T = (e.ce.expiry.getTime() - dayMs(day, i)) / (365 * 864e5);
    const ivc = impliedVol(true, spot[i], k, T, e.ce.ltp[i]);
    const ivp = impliedVol(false, spot[i], k, T, e.pe.ltp[i]);
    if (ivc != null && ivp != null) atmIv[i] = (ivc + ivp) / 2;
    // skew: put IV two strikes below minus call IV two strikes above (when both traded)
    const pLow = byStrike.get(k - 100)?.pe, cHigh = byStrike.get(k + 100)?.ce;
    if (pLow && cHigh) {
      const a = impliedVol(false, spot[i], k - 100, T, pLow.ltp[i]);
      const b = impliedVol(true, spot[i], k + 100, T, cHigh.ltp[i]);
      if (a != null && b != null) skew[i] = a - b;
    }
  }
  const sIdx = (arr) => { const a = arr.findIndex((v) => v != null); let b = N - 1; while (b > 0 && arr[b] == null) b--; return [a, b]; };
  const [s0, s1] = sIdx(straddle);
  if (s0 >= 0) {
    out.push(`Straddle (ATM CE+PE): ${fmt(straddle[s0])} at ${hhmm(s0)} -> ${fmt(straddle[s1])} at ${hhmm(s1)} (${fmt(((straddle[s1] / straddle[s0]) - 1) * 100, 1)}%); day range ${fmt(Math.max(...hi.filter((v) => v != null)) - Math.min(...lo.filter((v) => v != null)), 0)} pts vs open straddle ${fmt(straddle[s0], 0)}`);
  }
  const [v0, v1] = sIdx(atmIv);
  if (v0 >= 0) out.push(`ATM IV: ${fmt(atmIv[v0] * 100, 1)}% at ${hhmm(v0)} -> ${fmt(atmIv[v1] * 100, 1)}% at ${hhmm(v1)}`);

  const d = (arr, k) => arr.map((v, i) => (v != null && i >= k && arr[i - k] != null ? v - arr[i - k] : null));
  const past5 = d(spot, 5);
  const next5 = spot.map((v, i) => (i + 5 < N && v != null && spot[i + 5] != null ? spot[i + 5] - v : null));
  const abs = (arr) => arr.map((v) => (v == null ? null : Math.abs(v)));
  const dIv = d(atmIv, 5), dStr = d(straddle, 5), dSkew = d(skew, 5);
  const c = (a, b) => fmt(corr(a, b).r);
  out.push(`IV change (5m) vs NIFTY move: past r=${c(dIv, past5)}  next r=${c(dIv, next5)}  | vs next |move| r=${c(dIv, abs(next5))}`);
  out.push(`Straddle change (5m) vs NIFTY move: past r=${c(dStr, past5)}  next r=${c(dStr, next5)}  | vs next |move| r=${c(dStr, abs(next5))}`);
  out.push(`Put-call skew change (5m) vs NIFTY move: past r=${c(dSkew, past5)}  next r=${c(dSkew, next5)}`);

  // 3. OI walls
  const wallC = new Array(N).fill(null), wallP = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    let bc = null, bp = null;
    for (const o of opts) {
      if (o.oi[i] == null) continue;
      if (o.isCall && (!bc || o.oi[i] > bc.oi)) bc = { k: o.strike, oi: o.oi[i] };
      if (!o.isCall && (!bp || o.oi[i] > bp.oi)) bp = { k: o.strike, oi: o.oi[i] };
    }
    wallC[i] = bc?.k ?? null; wallP[i] = bp?.k ?? null;
  }
  const changes = (arr) => arr.reduce((acc, v, i) => (v != null && i && arr[i - 1] != null && v !== arr[i - 1] ? acc + 1 : acc), 0);
  out.push(`OI walls among subscribed strikes: call wall ${wallC[N - 1]} (${changes(wallC)} changes), put wall ${wallP[N - 1]} (${changes(wallP)} changes)`);
  let touches = 0, held = 0;
  for (let i = 0; i + 15 < N; i++) {
    if (spot[i] == null) continue;
    // first minute of a touch: within 15 pts of a wall, and not within 15 pts the minute before
    const near = (w) => w != null && Math.abs(spot[i] - w) <= 15;
    const nearPrev = (w) => i > 0 && w != null && spot[i - 1] != null && Math.abs(spot[i - 1] - w) <= 15;
    if (near(wallC[i]) && !nearPrev(wallC[i]) && spot[i] <= wallC[i] + 15) { touches++; if (spot[i + 15] < spot[i]) held++; }
    if (near(wallP[i]) && !nearPrev(wallP[i])) { touches++; if (spot[i + 15] > spot[i]) held++; }
  }
  out.push(`Wall touches (within 15 pts): ${touches}; price bounced back over the next 15m in ${held}`);

  // 4. structure
  const rets = spot.map((v, i) => (i && v != null && spot[i - 1] != null ? v - spot[i - 1] : null));
  const hourStats = [];
  for (let h = 0; h < 6; h++) {
    const seg = rets.slice(h * 60, h * 60 + 60);
    const a = seg.slice(1), b = seg.slice(0, -1);
    const sd = Math.sqrt(seg.filter((v) => v != null).reduce((s, v) => s + v * v, 0) / Math.max(1, seg.filter((v) => v != null).length));
    hourStats.push(`${hhmm(h * 60)}: ac=${fmt(corr(a, b).r)} rv=${fmt(sd)}`);
  }
  out.push(`1-min return autocorr (ac) and rms move (rv) by hour: ${hourStats.join(' | ')}`);
  const maxI = hi.reduce((m, v, i) => (v != null && (m < 0 || v > hi[m]) ? i : m), -1);
  const minI = lo.reduce((m, v, i) => (v != null && (m < 0 || v < lo[m]) ? i : m), -1);
  out.push(`Day high ${fmt(hi[maxI])} at ${hhmm(maxI)}, day low ${fmt(lo[minI])} at ${hhmm(minI)}`);
  for (const w of [15, 30]) {
    const orHigh = Math.max(...hi.slice(0, w).filter((v) => v != null));
    const orLow = Math.min(...lo.slice(0, w).filter((v) => v != null));
    let ev = null;
    for (let i = w; i < N; i++) {
      if (hi[i] != null && hi[i] > orHigh) { ev = ['up', i, orHigh]; break; }
      if (lo[i] != null && lo[i] < orLow) { ev = ['down', i, orLow]; break; }
    }
    out.push(ev
      ? `Opening range ${w}m ${fmt(orLow, 0)}-${fmt(orHigh, 0)}: first break ${ev[0]} at ${hhmm(ev[1])}; close ${fmt(spot[N - 1] - ev[2])} pts from the broken edge`
      : `Opening range ${w}m ${fmt(orLow, 0)}-${fmt(orHigh, 0)}: no break`);
  }

  // 5. OI-only bias: put OI added minus call OI added over 5 minutes (put writing = support, bullish)
  const oiBias = new Array(N).fill(null);
  for (let i = 5; i < N; i++) {
    let s = 0, any = false;
    for (const o of opts) {
      if (o.oi[i] == null || o.oi[i - 5] == null) continue;
      s += (o.isCall ? -1 : 1) * (o.oi[i] - o.oi[i - 5]); any = true;
    }
    if (any) oiBias[i] = s;
  }
  out.push('Signals (hit = NIFTY moved the signalled way):');
  score('OI-only bias (put OI added - call OI added)', oiBias, spot, out);
  score('IV falling = up, IV rising = down', dIv.map((v) => (v == null ? null : -v)), spot, out);
  score('Skew rising = down', dSkew.map((v) => (v == null ? null : -v)), spot, out);

  // 6-9. futures and VIX, when captured
  if (fut) {
    const dF = d(fut.ltp, 5), dOi = d(fut.oi, 5);
    const status = (i) => {
      if (dF[i] == null || dOi[i] == null || !dF[i] || !dOi[i]) return 0;
      return dF[i] > 0 ? (dOi[i] > 0 ? 2 : 1) : (dOi[i] > 0 ? -2 : -1); // LB +2, SC +1, SB -2, LU -1
    };
    const st = Array.from({ length: N }, (_, i) => status(i));
    out.push(`Futures: ${fmt(fut.ltp[0])} -> ${fmt(fut.ltp[N - 1])}, OI ${fut.oi[0]} -> ${fut.oi[N - 1]}`);
    score('Futures buildup (all four statuses)', st.map(sign), spot, out);
    score('Futures buildup (long/short buildup only)', st.map((v) => (Math.abs(v) === 2 ? sign(v) : 0)), spot, out);
    let pv = 0, vv = 0;
    const vwapSig = new Array(N).fill(null);
    for (let i = 1; i < N; i++) {
      const dv = (fut.vol[i] ?? 0) - (fut.vol[i - 1] ?? 0);
      if (dv > 0 && fut.ltp[i] != null) { pv += fut.ltp[i] * dv; vv += dv; }
      if (vv) vwapSig[i] = fut.ltp[i] - pv / vv;
    }
    score('Futures above/below its VWAP', vwapSig, spot, out);
    const basis = fut.ltp.map((v, i) => (v != null && spot[i] != null ? v - spot[i] : null));
    score('Basis widening = up', d(basis, 5), spot, out);
    if (vix) {
      const dV = d(vix, 5);
      for (const [label, want] of [['VIX rising', 1], ['VIX falling', -1]]) {
        score(`Futures buildup (all) when ${label}`, st.map((v, i) => (sign(dV[i] ?? 0) === want ? sign(v) : 0)), spot, out);
      }
    }
  } else {
    out.push('No FutureQuote.csv for this day: futures buildup / VWAP / basis / VIX-regime checks skipped.');
  }
  if (vix) out.push(`VIX ${fmt(vix[0])} -> ${fmt(vix[N - 1])}`);
  console.log(out.join('\n'));
}

// minutes since 00:00 UTC of the given IST day -> epoch ms for minute index i (IST = UTC+5:30)
function dayMs(day, i) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, OPEN_MIN + i - 330);
}

async function main() {
  const dataDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', 'data');
  const days = process.argv.slice(3).length
    ? process.argv.slice(3)
    : fs.readdirSync(dataDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const day of days) await analyzeDay(day, path.join(dataDir, day));

  console.log('\n=== Pooled over', days.length, 'day(s) ===');
  const names = [...new Set([...pooled.keys()].map((k) => k.split('|')[0]))];
  for (const name of names) {
    const cells = HORIZONS.map((h) => {
      const t = pooled.get(`${name}|${h}`);
      return t ? `${h}m n=${t.n} hit ${fmt((t.hits / t.n) * 100, 0)}% avg ${fmt(t.sum / t.n)}` : `${h}m —`;
    });
    console.log(`${name.padEnd(46)} ${cells.join(' | ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
