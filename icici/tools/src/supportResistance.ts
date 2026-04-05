import * as fs from 'fs';
import * as path from 'path';
import { fetchHistory, readSymbols, HistoricalEntry } from './stockReturns';

// ─── Pivot Points ────────────────────────────────────────────────────────────

interface PivotLevels {
    pp: number;
    r1: number; r2: number; r3: number;
    s1: number; s2: number; s3: number;
}

function standardPivot(h: number, l: number, c: number): PivotLevels {
    const pp = (h + l + c) / 3;
    return {
        pp,
        r1: 2 * pp - l,
        r2: pp + (h - l),
        r3: h + 2 * (pp - l),
        s1: 2 * pp - h,
        s2: pp - (h - l),
        s3: l - 2 * (h - pp),
    };
}

function fibonacciPivot(h: number, l: number, c: number): PivotLevels {
    const pp = (h + l + c) / 3;
    const range = h - l;
    return {
        pp,
        r1: pp + 0.382 * range,
        r2: pp + 0.618 * range,
        r3: pp + 1.000 * range,
        s1: pp - 0.382 * range,
        s2: pp - 0.618 * range,
        s3: pp - 1.000 * range,
    };
}

function camarillaPivot(h: number, l: number, c: number) {
    const range = h - l;
    return {
        r1: c + 1.1 * range / 12,
        r2: c + 1.1 * range / 6,
        r3: c + 1.1 * range / 4,
        r4: c + 1.1 * range / 2,
        s1: c - 1.1 * range / 12,
        s2: c - 1.1 * range / 6,
        s3: c - 1.1 * range / 4,
        s4: c - 1.1 * range / 2,
    };
}

// ─── Swing Highs / Lows ──────────────────────────────────────────────────────

interface SwingLevel { price: number; date: Date; }

function findSwings(history: HistoricalEntry[], N = 5): { highs: SwingLevel[]; lows: SwingLevel[] } {
    const highs: SwingLevel[] = [];
    const lows: SwingLevel[] = [];
    for (let i = N; i < history.length - N; i++) {
        const h = history[i].high;
        const l = history[i].low;
        const isSwingHigh = history.slice(i - N, i).every(e => e.high < h) &&
                            history.slice(i + 1, i + N + 1).every(e => e.high < h);
        const isSwingLow  = history.slice(i - N, i).every(e => e.low > l) &&
                            history.slice(i + 1, i + N + 1).every(e => e.low > l);
        if (isSwingHigh) highs.push({ price: h, date: history[i].date });
        if (isSwingLow)  lows.push({ price: l, date: history[i].date });
    }
    // return most recent 3 of each
    return {
        highs: highs.slice(-3).reverse(),
        lows:  lows.slice(-3).reverse(),
    };
}

// ─── Price Cluster Zones ─────────────────────────────────────────────────────

interface ClusterZone { price: number; touches: number; }

function findClusters(history: HistoricalEntry[], topN = 3): ClusterZone[] {
    const atr = history.slice(-14).reduce((sum, e) => sum + (e.high - e.low), 0) / 14;
    const bucketSize = atr * 0.5;
    if (bucketSize === 0) return [];

    const counts = new Map<number, number>();
    const snap = (price: number) => Math.round(price / bucketSize) * bucketSize;

    for (const e of history) {
        const bH = snap(e.high);
        const bL = snap(e.low);
        counts.set(bH, (counts.get(bH) ?? 0) + 1);
        counts.set(bL, (counts.get(bL) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([price, touches]) => ({ price, touches }))
        .sort((a, b) => b.price - a.price);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toFixed(2); }

function levelRow(label: string, value: number, current: number, isResistance: boolean) {
    const diff = ((value - current) / current * 100).toFixed(1);
    const sign = value >= current ? '+' : '';
    const color = isResistance ? '#dc2626' : '#16a34a';
    const bg    = isResistance ? '#fef2f2' : '#f0fdf4';
    return `<tr>
      <td style="color:#64748b;font-size:12px;">${label}</td>
      <td style="text-align:right;font-weight:600;color:${color};">${fmt(value)}</td>
      <td style="text-align:right;color:#94a3b8;font-size:12px;background:${bg};">${sign}${diff}%</td>
    </tr>`;
}

function buildCard(sym: string, history: HistoricalEntry[]): string {
    if (history.length < 10) {
        return `<div class="card"><h3>${sym}</h3><p style="color:#888">Insufficient data</p></div>`;
    }

    const prev = history[history.length - 2];
    const last = history[history.length - 1];
    const current = last.close;

    const std  = standardPivot(prev.high, prev.low, prev.close);
    const fib  = fibonacciPivot(prev.high, prev.low, prev.close);
    const cam  = camarillaPivot(prev.high, prev.low, prev.close);
    const swings = findSwings(history);
    const clusters = findClusters(history);

    const displayName = sym.replace(/\.(NS|BO)$/i, '');

    const stdRows = [
        levelRow('R3', std.r3, current, true),
        levelRow('R2', std.r2, current, true),
        levelRow('R1', std.r1, current, true),
        `<tr style="background:#e2e8f0;"><td colspan="3" style="text-align:center;font-weight:700;font-size:13px;">PP ${fmt(std.pp)} &nbsp;|&nbsp; Current ${fmt(current)}</td></tr>`,
        levelRow('S1', std.s1, current, false),
        levelRow('S2', std.s2, current, false),
        levelRow('S3', std.s3, current, false),
    ].join('');

    const fibRows = [
        levelRow('R3', fib.r3, current, true),
        levelRow('R2', fib.r2, current, true),
        levelRow('R1', fib.r1, current, true),
        `<tr style="background:#e2e8f0;"><td colspan="3" style="text-align:center;font-weight:700;font-size:13px;">PP ${fmt(fib.pp)}</td></tr>`,
        levelRow('S1', fib.s1, current, false),
        levelRow('S2', fib.s2, current, false),
        levelRow('S3', fib.s3, current, false),
    ].join('');

    const camRows = [
        levelRow('R4 ★', cam.r4, current, true),
        levelRow('R3', cam.r3, current, true),
        levelRow('R2', cam.r2, current, true),
        levelRow('R1', cam.r1, current, true),
        `<tr style="background:#e2e8f0;"><td colspan="3" style="text-align:center;font-weight:700;font-size:13px;">Close ${fmt(prev.close)}</td></tr>`,
        levelRow('S1', cam.s1, current, false),
        levelRow('S2', cam.s2, current, false),
        levelRow('S3', cam.s3, current, false),
        levelRow('S4 ★', cam.s4, current, false),
    ].join('');

    const swingRows = [
        ...swings.highs.map(s => `<tr><td style="color:#dc2626;">Swing H</td><td style="text-align:right;font-weight:600;">${fmt(s.price)}</td><td style="text-align:right;color:#94a3b8;font-size:11px;">${s.date.toLocaleDateString()}</td></tr>`),
        ...swings.lows.map(s  => `<tr><td style="color:#16a34a;">Swing L</td><td style="text-align:right;font-weight:600;">${fmt(s.price)}</td><td style="text-align:right;color:#94a3b8;font-size:11px;">${s.date.toLocaleDateString()}</td></tr>`),
    ].join('') || `<tr><td colspan="3" style="color:#888">Not enough data</td></tr>`;

    const clusterRows = clusters.map(z =>
        `<tr>
          <td style="color:#7c3aed;">Zone</td>
          <td style="text-align:right;font-weight:600;">${fmt(z.price)}</td>
          <td style="text-align:right;color:#94a3b8;font-size:12px;">${z.touches} touches</td>
        </tr>`
    ).join('') || `<tr><td colspan="3" style="color:#888">None</td></tr>`;

    const mini = (label: string, val: number) =>
        `<div style="text-align:center"><div style="font-size:10px;color:#64748b;">${label}</div><div style="font-weight:600;">${fmt(val)}</div></div>`;

    return `
<div class="card">
  <div class="card-header">
    <span class="sym">${displayName}</span>
    <span class="price">${fmt(current)}</span>
  </div>
  <div class="ohlc-bar">
    ${mini('Open', last.open)} ${mini('High', last.high)} ${mini('Low', last.low)} ${mini('Close', last.close)}
  </div>
  <div class="grid3">
    <div class="section">
      <div class="section-title">Standard Pivots</div>
      <table class="lvl-table">${stdRows}</table>
    </div>
    <div class="section">
      <div class="section-title">Fibonacci Pivots</div>
      <table class="lvl-table">${fibRows}</table>
    </div>
    <div class="section">
      <div class="section-title">Camarilla Pivots</div>
      <table class="lvl-table">${camRows}</table>
    </div>
  </div>
  <div class="grid2">
    <div class="section">
      <div class="section-title">Swing Highs &amp; Lows</div>
      <table class="lvl-table">${swingRows}</table>
    </div>
    <div class="section">
      <div class="section-title">Price Cluster Zones</div>
      <table class="lvl-table">${clusterRows}</table>
    </div>
  </div>
</div>`;
}

async function main() {
    const stocksFile = path.join(__dirname, '..', 'stocks.txt');
    const symbols = readSymbols(stocksFile);

    if (symbols.length === 0) {
        console.error('No symbols found in stocks.txt');
        process.exit(1);
    }

    console.log(`Fetching OHLC for ${symbols.length} symbols...\n`);

    const cards: string[] = [];
    for (const sym of symbols) {
        process.stdout.write(`  ${sym}... `);
        const history = await fetchHistory(sym);
        history.sort((a, b) => a.date.getTime() - b.date.getTime());
        cards.push(buildCard(sym, history));
        console.log(history.length > 0 ? `✓ ${history.length} bars` : 'no data');
    }

    const now = new Date().toLocaleString();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Support &amp; Resistance</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f1f5f9; margin:0; padding:24px; }
    h1 { color:#0f172a; margin-bottom:4px; }
    p.sub { color:#64748b; margin-top:0; margin-bottom:24px; font-size:14px; }
    .card { background:white; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,.1); margin-bottom:24px; padding:16px; }
    .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .sym { font-size:20px; font-weight:700; color:#0f172a; }
    .price { font-size:20px; font-weight:700; color:#2563eb; }
    .ohlc-bar { display:flex; gap:16px; background:#f8fafc; border-radius:6px; padding:8px 12px; margin-bottom:12px; }
    .grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:12px; }
    .grid2 { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
    .section { border:1px solid #e2e8f0; border-radius:6px; padding:10px; }
    .section-title { font-size:11px; font-weight:700; text-transform:uppercase; color:#94a3b8; margin-bottom:8px; letter-spacing:.05em; }
    .lvl-table { width:100%; border-collapse:collapse; font-size:13px; }
    .lvl-table td { padding:3px 4px; }
    @media(max-width:900px){ .grid3{grid-template-columns:1fr 1fr;} }
    @media(max-width:600px){ .grid3,.grid2{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <h1>Support &amp; Resistance</h1>
  <p class="sub">Generated: ${now} &nbsp;|&nbsp; Based on previous day's OHLC. % shows distance from current price.</p>
  ${cards.join('\n')}
</body>
</html>`;

    const outPath = path.join(__dirname, '..', 'support_resistance.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log(`\nDone! Output: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
