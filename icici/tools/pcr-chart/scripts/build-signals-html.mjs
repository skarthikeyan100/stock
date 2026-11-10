// Builds signals-guide.html from data/signal-results.json (written by scripts/extra-signals.mjs).
// Usage: node scripts/build-signals-html.mjs [resultsJson] [outHtml]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const resultsPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'data', 'signal-results.json');
const outPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'signals-guide.html');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const days = results.days;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NIFTY signals: what the data says</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a64;--card:#ffffff;--line:#e4e1d8;--good:#2f7d5b;--bad:#b4493a;--warn:#b07a1c;--bar:#4a6fa5;--bar2:#9bb3d4;--ci:#1d1d1b}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#17181a;--fg:#ecebe6;--muted:#9c9a92;--card:#202225;--line:#33363a;--good:#5fb58a;--bad:#e07a6a;--warn:#d9a14a;--bar:#7fa3d6;--bar2:#4d6688;--ci:#ecebe6}}
:root[data-theme="dark"]{--bg:#17181a;--fg:#ecebe6;--muted:#9c9a92;--card:#202225;--line:#33363a;--good:#5fb58a;--bad:#e07a6a;--warn:#d9a14a;--bar:#7fa3d6;--bar2:#4d6688;--ci:#ecebe6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.7rem;margin:.2em 0 .1em}
h2{font-size:1.25rem;margin:2.2em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font-size:1.02rem;margin:1.2em 0 .3em}
p,li{max-width:70ch}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.verdict{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:640px){.verdict{grid-template-columns:1fr 1fr 1fr}}
.pill{display:inline-block;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
.good{color:var(--good)} .bad{color:var(--bad)} .warn{color:var(--warn)} .muted2{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:.92rem;margin:8px 0}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left;white-space:normal}
th{color:var(--muted);font-weight:600}
svg{width:100%;height:auto;display:block}
svg text{fill:var(--fg);font-size:12px}
svg .axis{fill:var(--muted);font-size:11px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:4px}
.legend{font-size:.85rem;color:var(--muted);margin-top:4px}
.grid2{display:grid;gap:14px;grid-template-columns:1fr}
@media (min-width:700px){.grid2{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<main>
<div class="muted" id="sub"></div>
<h1>NIFTY signals: what the data says</h1>
<p class="muted">Based on the captured days ${days.join(', ')}. Four sessions is a short sample, so every number below
is a first read and shows its uncertainty. Bars are hit rates (share of signals where NIFTY moved the signalled way).
The thin line is a 95% confidence interval from a day-level bootstrap, which resamples whole days.</p>

<h2>Summary</h2>
<div class="verdict">
  <div class="card"><span class="pill good">Strongest so far</span>
    <h3>Volatility from VIX</h3>
    <p>Higher India VIX goes with bigger next-15-minute NIFTY ranges. It predicts <em>how far</em> price moves, not which way.</p></div>
  <div class="card"><span class="pill warn">Weak lead</span>
    <h3>Futures buildup confirmed by PCR</h3>
    <p>Buildup with a matching PCR move hits about 58% at 5 minutes. The interval is wide and it has not beaten the plain buildup signal by a clear margin.</p></div>
  <div class="card"><span class="pill bad">No edge</span>
    <h3>Order-book imbalance</h3>
    <p>Bid/ask depth imbalance hits 48–50% from 30 seconds to 5 minutes, which is a coin flip after costs.</p></div>
</div>

<h2>1. Order-book imbalance (futures depth)</h2>
<div class="card">
  <p><strong>What it is.</strong> The share of resting orders on the bid side versus the ask side at the best price:
  <code>(bid qty − ask qty) / (bid qty + ask qty)</code>, from <code>tick.bq1</code> and <code>tick.sq1</code>.
  Positive means more buyers are waiting, negative means more sellers. The idea is that heavy one-sided depth pushes price the same way.</p>
  <svg id="obi-diagram" viewBox="0 0 520 150" role="img" aria-label="Order book imbalance diagram"></svg>
  <p class="legend">Illustration: bids on the left, asks on the right. Here 8,060 bid vs 65 ask gives OBI ≈ +0.98, a strong buy-side imbalance.</p>
  <h3>Hit rate by horizon (all ticks and strong |OBI| ≥ 0.5)</h3>
  <svg id="obi-chart" viewBox="0 0 640 260" role="img" aria-label="OBI hit rate by horizon"></svg>
  <p class="legend">Dashed line = 50% (coin flip). Dark bar = all ticks, light bar = strong imbalance only.</p>
  <p><strong>Reading:</strong> no horizon is clearly above 50%. The 30-second, 60-second and 5-minute results all have
  confidence intervals that cover 50%, and the average move is smaller than the assumed round-trip cost.
  Depth changes many times a second, so the same depth is counted many times. The effective sample is much smaller than the row count.</p>
</div>

<h2>2. Futures buildup, with and without PCR</h2>
<div class="card">
  <p><strong>What it is.</strong> Futures price and open interest over 5 minutes. Price up with OI up is long buildup (new buyers),
  price down with OI up is short buildup (new sellers). The PCR test asks whether the PCR move over 15 minutes agrees
  with the buildup direction.</p>
  <svg id="bu-diagram" viewBox="0 0 520 220" role="img" aria-label="Buildup quadrant"></svg>
  <p class="legend">The four futures statuses. Only long and short buildup are used here, because both price and OI rise.</p>
  <h3>Hit rate at 5 minutes</h3>
  <svg id="bu-chart" viewBox="0 0 640 230" role="img" aria-label="Buildup hit rate"></svg>
  <p class="legend">Blue = buildup alone, green = PCR confirms buildup, light blue = PCR contradicts buildup.</p>
  <h3>By session region (5-minute signals; cells with fewer than 50 signals are hidden)</h3>
  <div id="bu-regions"></div>
  <p><strong>Reading:</strong> the PCR-confirmed subset hits 58% overall, and 61–66% in the range and lunch periods, but
  its interval (about 56–61%) overlaps the plain-buildup result. The contradicted subset is 53%. The gap between confirmed
  and contradicted is the only part worth testing further, and it rests on about 800 overlapping signals from four days.</p>
</div>

<h2>3. Volatility from VIX (how far, not which way)</h2>
<div class="card">
  <p><strong>What it is.</strong> The NIFTY range (high minus low) over the next 15 minutes, compared with the India VIX
  level and its 15-minute change. VIX is the market's expected volatility, so higher VIX should mean bigger moves.</p>
  <svg id="vol-chart" viewBox="0 0 640 240" role="img" aria-label="Mean next-15-minute range by VIX bucket"></svg>
  <p class="legend">Mean next-15-minute NIFTY range, by VIX tercile pooled over the four days.</p>
  <p><strong>Reading:</strong> correlation of VIX level with the next 15-minute range is <strong id="r-vix"></strong>, and
  the 15-minute VIX change adds almost nothing (<strong id="r-dvix"></strong>). In practice, a high-VIX
  reading means you should expect a wider move, which matters for stop sizes and for option strategies that
  depend on movement. With four days, part of this may reflect one day: Nov 6 had the widest NIFTY range (530 pts) and a rising VIX.</p>
</div>

<h2>4. Session region results</h2>
<div class="card" id="region-card"></div>

<h2>5. What to do with this</h2>
<div class="card">
  <ul>
    <li><strong>Use VIX for sizing and risk, not for direction.</strong> It has the most support so far.</li>
    <li><strong>Keep the PCR-confirmed buildup filter on the watch list.</strong> Test it on more days before trading it.</li>
    <li><strong>Drop order-book imbalance as a direction signal for now.</strong> It may still be useful for execution (timing a fill), which we have not tested.</li>
    <li><strong>Do not read small region cells.</strong> Cells with fewer than 50 signals are hidden for that reason.</li>
  </ul>
  <p class="muted">Cost assumption: ${results.cost_pts} index points round trip, used only for the "net" column in the report.
  Replace it with your actual brokerage and slippage before judging any signal on net return.</p>
</div>

<h2>Caveats</h2>
<div class="card">
  <ul>
    <li>Four sessions. The README asks for 5–10 at minimum, and the region split needs several more to fill.</li>
    <li>Signals overlap in time, so the row counts overstate the sample. Confidence intervals come from whole-day resampling, which only partly corrects this.</li>
    <li>Several signals and horizons were tested, so some results will look good by chance.</li>
    <li>Academic work on intraday predictability is mixed. Order-book imbalance has documented short-horizon power in index futures, but it is regime-dependent and can be spoofed.</li>
  </ul>
</div>

<p class="muted" style="margin-top:28px">Generated from <code>data/signal-results.json</code> by <code>scripts/build-signals-html.mjs</code>.</p>
</main>

<script>
const R = ${JSON.stringify(results)};
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
};
const pct = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '%');
const f1 = (x) => (x == null ? '—' : x.toFixed(1));
document.getElementById('sub').textContent = 'Days: ' + R.days.join(' · ') + ' · cost assumption ' + R.cost_pts + ' pts';
document.getElementById('r-vix').textContent = R.volatility.r_vix_level_vs_range.toFixed(2);
document.getElementById('r-dvix').textContent = 'r = ' + R.volatility.r_dvix_vs_range.toFixed(2);

// ---- OBI diagram
(function obiDiagram() {
  const s = document.getElementById('obi-diagram');
  // bids grow left from the centre line, asks grow right; widths are proportional to size
  const cx = 260, scale = 200 / 8060;
  const bidQ = 8060, askQ = 65;
  el('line', { x1: cx, y1: 8, x2: cx, y2: 122, stroke: 'var(--muted)', 'stroke-dasharray': '4 3' }, s);
  el('text', { x: 10, y: 39 }, s, 'Bids');
  el('rect', { x: cx - bidQ * scale, y: 20, width: bidQ * scale, height: 30, fill: 'var(--good)', rx: 3 }, s);
  el('text', { x: cx - 8, y: 40, 'text-anchor': 'end', fill: '#fff', 'font-weight': 700 }, s, '8,060');
  el('text', { x: 10, y: 99 }, s, 'Asks');
  el('rect', { x: cx, y: 80, width: Math.max(2, askQ * scale), height: 30, fill: 'var(--bad)', rx: 3 }, s);
  el('text', { x: cx + 10, y: 100 }, s, '65');
  el('text', { x: 10, y: 140 }, s, 'OBI = (8060 − 65) / (8060 + 65) ≈ +0.98  (strong buy-side)');
})();

// ---- generic horizontal bar chart with CI
function barChart(svg, items, opts) {
  const W = 640, left = 210, right = 620, top = 26, rowH = 34;
  const x = (v) => left + ((v - 0.4) / (0.7 - 0.4)) * (right - left);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (top + rowH * items.length + 30));
  el('text', { x: left, y: 14, class: 'axis' }, svg, opts.axisLabel || '');
  for (const v of [0.4, 0.5, 0.6, 0.7]) {
    el('line', { x1: x(v), y1: top - 6, x2: x(v), y2: top + rowH * items.length, stroke: 'var(--line)' }, svg);
    el('text', { x: x(v), y: top + rowH * items.length + 16, 'text-anchor': 'middle', class: 'axis' }, svg, Math.round(v * 100) + '%');
  }
  el('line', { x1: x(0.5), y1: top - 6, x2: x(0.5), y2: top + rowH * items.length, stroke: 'var(--muted)', 'stroke-dasharray': '5 4' }, svg);
  items.forEach((it, i) => {
    const y = top + i * rowH;
    el('text', { x: left - 10, y: y + 16, 'text-anchor': 'end' }, svg, it.label);
    if (it.hit == null) { el('text', { x: left + 6, y: y + 16, class: 'axis' }, svg, 'n too small'); return; }
    el('rect', { x: left, y: y + 4, width: Math.max(0, x(it.hit) - left), height: 18, fill: it.color, rx: 3 }, svg);
    if (it.lo != null) {
      el('line', { x1: x(it.lo), y1: y + 13, x2: x(it.hi), y2: y + 13, stroke: 'var(--ci)', 'stroke-width': 2 }, svg);
      el('line', { x1: x(it.lo), y1: y + 7, x2: x(it.lo), y2: y + 19, stroke: 'var(--ci)', 'stroke-width': 2 }, svg);
      el('line', { x1: x(it.hi), y1: y + 7, x2: x(it.hi), y2: y + 19, stroke: 'var(--ci)', 'stroke-width': 2 }, svg);
    }
    el('text', { x: x(Math.max(it.hit, it.hi || 0)) + 8, y: y + 17, class: 'axis' }, svg, pct(it.hit) + (it.n ? '  (n=' + it.n + ')' : ''));
  });
}

// ---- OBI hit-rate chart
(function obiChart() {
  const S = R.signals, items = [];
  for (const h of ['30s', '60s', '5m']) {
    const a = S['OBI all ticks, next ' + h], b = S['OBI strong |OBI|>=0.5, next ' + h];
    items.push({ label: 'all ticks, next ' + h, hit: a.hit, lo: a.boot.hit_lo, hi: a.boot.hit_hi, n: a.n, color: 'var(--bar)' });
    items.push({ label: 'strong, next ' + h, hit: b.hit, lo: b.boot.hit_lo, hi: b.boot.hit_hi, n: b.n, color: 'var(--bar2)' });
  }
  barChart(document.getElementById('obi-chart'), items, { axisLabel: 'hit rate' });
})();

// ---- buildup chart
(function buChart() {
  const S = R.signals;
  const keys = [['Futures buildup long/short, next 5m', 'buildup alone', 'var(--bar)'],
                ['Buildup confirmed by PCR move, next 5m', 'PCR confirms', 'var(--good)'],
                ['Buildup against PCR move, next 5m', 'PCR contradicts', 'var(--bar2)']];
  const items = keys.map(([k, label, color]) => ({ label, hit: S[k].hit, lo: S[k].boot.hit_lo, hi: S[k].boot.hit_hi, n: S[k].n, color }));
  barChart(document.getElementById('bu-chart'), items, { axisLabel: 'hit rate, 5-minute horizon' });

  // region table
  const regs = ['opening', 'range', 'lunch', 'closing'];
  let html = '<table><tr><th>Signal</th>' + regs.map((r) => '<th>' + r + '</th>').join('') + '</tr>';
  for (const [k, label] of [['Futures buildup long/short, next 5m', 'buildup alone'], ['Buildup confirmed by PCR move, next 5m', 'PCR confirms'], ['Buildup against PCR move, next 5m', 'PCR contradicts']]) {
    html += '<tr><td>' + label + '</td>';
    for (const r of regs) {
      const c = R.regions[k][r];
      html += '<td>' + (c.ok ? pct(c.hit) + ' <span class="muted">(n=' + c.n + ')</span>' : '<span class="muted">n&lt;50</span>') + '</td>';
    }
    html += '</tr>';
  }
  document.getElementById('bu-regions').innerHTML = html + '</table>';
})();

// ---- buildup diagram
(function buDiagram() {
  const s = document.getElementById('bu-diagram');
  const boxes = [
    [0, 0, 'Long buildup', 'price ↑, OI ↑', 'new buyers → upward', 'var(--good)'],
    [1, 0, 'Short buildup', 'price ↓, OI ↑', 'new sellers → downward', 'var(--bad)'],
    [0, 1, 'Short covering', 'price ↑, OI ↓', 'shorts exit (not used)', 'var(--muted)'],
    [1, 1, 'Long unwinding', 'price ↓, OI ↓', 'longs exit (not used)', 'var(--muted)'],
  ];
  boxes.forEach(([c, r, t, a, b, col]) => {
    const x = 20 + c * 260, y = 20 + r * 100;
    el('rect', { x, y, width: 240, height: 86, rx: 8, fill: 'var(--card)', stroke: col, 'stroke-width': 1.5 }, s);
    el('text', { x: x + 12, y: y + 24, 'font-weight': 700 }, s, t);
    el('text', { x: x + 12, y: y + 46, class: 'axis' }, s, a);
    el('text', { x: x + 12, y: y + 66, class: 'axis' }, s, b);
  });
})();

// ---- volatility chart
(function volChart() {
  const svg = document.getElementById('vol-chart');
  const V = R.volatility;
  const bars = V.mean_range_by_vix;
  const max = Math.max(...bars.map((b) => b.mean_range)) * 1.15;
  const W = 640, H = 240, left = 60, base = 200, top = 20;
  const bw = 120, gap = 80;
  el('line', { x1: left, y1: base, x2: W - 20, y2: base, stroke: 'var(--line)' }, svg);
  bars.forEach((b, i) => {
    const h = (b.mean_range / max) * (base - top);
    const x = left + 40 + i * (bw + gap);
    el('rect', { x, y: base - h, width: bw, height: h, fill: i === 2 ? 'var(--bad)' : 'var(--bar)', rx: 4 }, svg);
    el('text', { x: x + bw / 2, y: base - h - 8, 'text-anchor': 'middle' }, svg, b.mean_range.toFixed(1) + ' pts');
    el('text', { x: x + bw / 2, y: base + 18, 'text-anchor': 'middle', class: 'axis' }, svg, 'VIX ' + b.bucket + ' (n=' + b.n + ')');
  });
  el('text', { x: 4, y: 14, class: 'axis' }, svg, 'mean next-15m range (pts)');
})();

// ---- region card
(function regionCard() {
  const card = document.getElementById('region-card');
  const rows = Object.entries(R.regions);
  let html = '<p>Hit rate by session region for each signal. Cells with fewer than 50 signals are hidden.</p><table><tr><th>Signal</th><th>opening</th><th>range</th><th>lunch</th><th>closing</th></tr>';
  for (const [name, reg] of rows) {
    html += '<tr><td>' + name + '</td>' + ['opening', 'range', 'lunch', 'closing'].map((r) => '<td>' + (reg[r].ok ? pct(reg[r].hit) : '<span class="muted">n&lt;50</span>') + '</td>').join('') + '</tr>';
  }
  card.innerHTML = html + '</table><p class="muted">Opening 09:30–10:30, range 10:30–12:00, lunch 12:00–13:30, closing 13:30–15:30 IST.</p>';
})();
</script>
</body>
</html>
`;

fs.writeFileSync(outPath, html);
console.log('wrote', outPath);
