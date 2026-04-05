import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const PERIODS = [
    { label: '1-Week Return', days: 7 },
    { label: '1-Month Return', days: 30 },
    { label: '3-Month Return', days: 90 },
    { label: '6-Month Return', days: 180 },
    { label: '1-Year Return', days: 365 },
];

export interface HistoricalEntry {
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
}

export function readSymbols(filePath: string): string[] {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    return lines
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));
}

function subtractDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() - days);
    return d;
}

function findClosestPrice(history: HistoricalEntry[], targetDate: Date): number | null {
    if (history.length === 0) return null;
    let closest = history[0];
    let minDiff = Math.abs(history[0].date.getTime() - targetDate.getTime());
    for (const entry of history) {
        const diff = Math.abs(entry.date.getTime() - targetDate.getTime());
        if (diff < minDiff) {
            minDiff = diff;
            closest = entry;
        }
    }
    return closest.close;
}

function formatReturn(value: number | null): { text: string; positive: boolean | null } {
    if (value === null) return { text: 'N/A', positive: null };
    const sign = value >= 0 ? '+' : '';
    return { text: `${sign}${value.toFixed(2)}%`, positive: value >= 0 };
}

export async function fetchHistory(symbol: string): Promise<HistoricalEntry[]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000,
        });
        const chart = data?.chart?.result?.[0];
        if (!chart) return [];
        const timestamps: number[] = chart.timestamp || [];
        const q = chart.indicators?.quote?.[0] ?? {};
        const opens: number[] = q.open || [];
        const highs: number[] = q.high || [];
        const lows: number[] = q.low || [];
        const closes: number[] = q.close || [];
        return timestamps
            .map((ts, i) => ({
                date: new Date(ts * 1000),
                open: opens[i],
                high: highs[i],
                low: lows[i],
                close: closes[i],
            }))
            .filter(e => e.close != null && !isNaN(e.close));
    } catch (e) {
        console.error(`  Failed to fetch ${symbol}: ${(e as Error).message}`);
        return [];
    }
}

// PERIOD indices: 0=1W, 1=1M, 2=3M, 3=6M, 4=1Y
function computeWeightedScore(returns: (number | null)[]): number | null {
    // (1Y×4 + 6M×3 + 3M×2 + 1M×1) / 10  — 1W excluded
    const [, r1M, r3M, r6M, r1Y] = returns;
    if (r1M === null && r3M === null && r6M === null && r1Y === null) return null;
    let sum = 0, weight = 0;
    if (r1Y !== null) { sum += r1Y * 4; weight += 4; }
    if (r6M !== null) { sum += r6M * 3; weight += 3; }
    if (r3M !== null) { sum += r3M * 2; weight += 2; }
    if (r1M !== null) { sum += r1M * 1; weight += 1; }
    return weight > 0 ? sum / weight : null;
}

function computeRanks(symbols: string[], data: Map<string, (number | null)[]>): Map<string, number | null> {
    const avgRanks = new Map<string, number | null>();
    const rankSums = new Map<string, number>();
    const rankCounts = new Map<string, number>();
    symbols.forEach(s => { rankSums.set(s, 0); rankCounts.set(s, 0); });

    for (let i = 0; i < PERIODS.length; i++) {
        // collect (symbol, return) pairs where return is not null
        const valid = symbols
            .map(s => ({ s, v: (data.get(s) ?? [])[i] }))
            .filter(x => x.v !== null) as { s: string; v: number }[];
        valid.sort((a, b) => b.v - a.v); // best = rank 1
        valid.forEach((x, idx) => {
            rankSums.set(x.s, (rankSums.get(x.s) ?? 0) + (idx + 1));
            rankCounts.set(x.s, (rankCounts.get(x.s) ?? 0) + 1);
        });
    }

    for (const s of symbols) {
        const cnt = rankCounts.get(s) ?? 0;
        avgRanks.set(s, cnt > 0 ? (rankSums.get(s) ?? 0) / cnt : null);
    }
    return avgRanks;
}

function buildHtml(symbols: string[], data: Map<string, (number | null)[]>): string {
    // --- Compute scores ---
    const weightedScores = new Map<string, number | null>();
    const momentum12_1 = new Map<string, number | null>();

    for (const sym of symbols) {
        const returns = data.get(sym) ?? [];
        weightedScores.set(sym, computeWeightedScore(returns));
        const r1M = returns[1], r1Y = returns[4];
        momentum12_1.set(sym, r1M !== null && r1Y !== null ? r1Y - r1M : null);
    }

    const rankScores = computeRanks(symbols, data);

    // Sort columns by weighted score descending (nulls last)
    const sorted = [...symbols].sort((a, b) => {
        const sa = weightedScores.get(a), sb = weightedScores.get(b);
        if (sa === null && sb === null) return 0;
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sb - sa;
    });

    // Assign display ranks based on sorted order (for rank score display)
    const displayRank = new Map<string, number>();
    [...sorted].forEach((s, i) => displayRank.set(s, i + 1));

    // --- Return rows ---
    const returnRows = PERIODS.map((period, i) => {
        const cells = sorted.map(sym => {
            const val = (data.get(sym) ?? [])[i] ?? null;
            const { text, positive } = formatReturn(val);
            const color = positive === null ? '#888' : positive ? '#16a34a' : '#dc2626';
            const bg = positive === null ? '#f9fafb' : positive ? '#f0fdf4' : '#fef2f2';
            return `<td style="text-align:right;color:${color};background:${bg};font-weight:600;">${text}</td>`;
        }).join('');
        return `<tr><td style="font-weight:600;white-space:nowrap;">${period.label}</td>${cells}</tr>`;
    }).join('\n');

    // --- Score rows ---
    const scoreRowStyle = 'border-top:2px solid #94a3b8;';

    const weightedRow = (() => {
        const cells = sorted.map(sym => {
            const val = weightedScores.get(sym) ?? null;
            const { text, positive } = formatReturn(val);
            const color = positive === null ? '#888' : positive ? '#16a34a' : '#dc2626';
            const bg = positive === null ? '#f9fafb' : positive ? '#f0fdf4' : '#fef2f2';
            return `<td style="text-align:right;color:${color};background:${bg};font-weight:700;${scoreRowStyle}">${text}</td>`;
        }).join('');
        return `<tr><td style="font-weight:700;white-space:nowrap;${scoreRowStyle}">Weighted Score</td>${cells}</tr>`;
    })();

    const rankRow = (() => {
        const cells = sorted.map(sym => {
            const rank = displayRank.get(sym) ?? null;
            if (rank === null) return `<td style="text-align:right;color:#888;">N/A</td>`;
            const isTop3 = rank <= 3;
            const color = isTop3 ? '#b45309' : '#64748b';
            const bg = isTop3 ? '#fffbeb' : '#f9fafb';
            const text = `#${rank}`;
            return `<td style="text-align:right;color:${color};background:${bg};font-weight:700;">${text}</td>`;
        }).join('');
        return `<tr><td style="font-weight:700;white-space:nowrap;">Rank Score</td>${cells}</tr>`;
    })();

    const momentum12_1Row = (() => {
        const cells = sorted.map(sym => {
            const val = momentum12_1.get(sym) ?? null;
            const { text, positive } = formatReturn(val);
            const color = positive === null ? '#888' : positive ? '#16a34a' : '#dc2626';
            const bg = positive === null ? '#f9fafb' : positive ? '#f0fdf4' : '#fef2f2';
            return `<td style="text-align:right;color:${color};background:${bg};font-weight:700;">${text}</td>`;
        }).join('');
        return `<tr><td style="font-weight:700;white-space:nowrap;">12-1 Momentum</td>${cells}</tr>`;
    })();

    const headers = sorted.map(s => {
        const isNse = s.toUpperCase().endsWith('.NS');
        const isBse = s.toUpperCase().endsWith('.BO');
        const displayName = s.replace(/\.(NS|BO)$/i, '');
        const badge = isNse
            ? `<span style="font-size:9px;background:#f97316;color:#fff;border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle;">NSE</span>`
            : isBse
            ? `<span style="font-size:9px;background:#8b5cf6;color:#fff;border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle;">BSE</span>`
            : '';
        return `<th style="padding:8px 12px;white-space:nowrap;background:#1e293b;color:#f8fafc;">${displayName}${badge}</th>`;
    }).join('');

    const now = new Date().toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Stock Returns</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; margin: 0; padding: 24px; }
    h1 { color: #0f172a; margin-bottom: 4px; }
    p.subtitle { color: #64748b; margin-top: 0; margin-bottom: 20px; font-size: 14px; }
    .wrapper { overflow-x: auto; }
    table { border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.1); min-width: 100%; }
    th, td { padding: 8px 14px; border: 1px solid #e2e8f0; font-size: 14px; }
    th:first-child { background: #0f172a; color: #f8fafc; text-align: left; }
    td:first-child { background: #f8fafc; }
    tr:hover td { filter: brightness(0.97); }
  </style>
</head>
<body>
  <h1>Stock Returns</h1>
  <p class="subtitle">Generated: ${now}</p>
  <div class="wrapper">
    <table>
      <thead>
        <tr>
          <th style="background:#0f172a;color:#f8fafc;">Period</th>
          ${headers}
        </tr>
      </thead>
      <tbody>
        ${returnRows}
        ${weightedRow}
        ${rankRow}
        ${momentum12_1Row}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

async function main() {
    const stocksFile = path.join(__dirname, '..', 'stocks.txt');
    const symbols = readSymbols(stocksFile);

    if (symbols.length === 0) {
        console.error('No symbols found in stocks.txt');
        process.exit(1);
    }

    console.log(`Fetching data for ${symbols.length} symbols: ${symbols.join(', ')}\n`);

    const today = new Date();
    const data = new Map<string, (number | null)[]>();

    for (const symbol of symbols) {
        process.stdout.write(`  ${symbol}... `);
        const history = await fetchHistory(symbol);

        if (history.length === 0) {
            data.set(symbol, PERIODS.map(() => null));
            console.log('no data');
            continue;
        }

        history.sort((a, b) => a.date.getTime() - b.date.getTime());
        const currentPrice = history[history.length - 1].close;

        const returns = PERIODS.map(period => {
            const target = subtractDays(today, period.days);
            const pastPrice = findClosestPrice(history, target);
            if (pastPrice === null || pastPrice === 0) return null;
            return ((currentPrice - pastPrice) / pastPrice) * 100;
        });

        data.set(symbol, returns);
        console.log(`✓ current=${currentPrice.toFixed(2)}`);
    }

    const html = buildHtml(symbols, data);
    const outPath = path.join(__dirname, '..', 'returns.html');
    fs.writeFileSync(outPath, html, 'utf-8');

    console.log(`\nDone! Output written to: ${outPath}`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
