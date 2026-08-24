/**
 * Replays NIFTY tick-data CSVs (columns: token,ltp,ltt - ltt in epoch
 * seconds) through a simple windowed rate-of-change momentum hypothesis:
 * within a trailing time window, if the magnitude of the point change
 * (|close - open|) exceeds a threshold, bet that the move continues - buy
 * a CE if close > open, a PE if close < open - and simulate the outcome in
 * NIFTY points against a target/stop-loss, the same way
 * SupportResistanceHypothesisTest.ts does for the S/R hypothesis.
 *
 * Not wired into RateOfChangeStrategy, which trades velocity/acceleration
 * over a fixed number of received datapoints (not a wall-clock window) and
 * against real option premiums, not underlying points. This is a standalone
 * analysis tool - see RateOfChangeStrategy.ts to understand the live logic.
 *
 * Usage:
 *   tsc && node ./dist/tools/RateOfChangeHypothesisTest.js --files day1.csv,day2.csv
 *
 * By default this sweeps a grid of window lengths and thresholds (see the
 * `rocHypothesis:` block in config.yml) and reports every combination that
 * produced at least `minWins` decided wins with a 100% win rate, combined
 * across all supplied days. Pass --window and --threshold together to skip
 * the grid and print a detailed per-trade table for one specific config.
 *
 * Options:
 *   --files      Comma-separated list of NIFTY tick CSVs, one per day (required)
 *   --window     Window length in minutes (single-run mode; requires --threshold)
 *   --threshold  Rate-of-change magnitude threshold in points (single-run mode)
 *
 * All other tuning values (target, stopLoss, cooldownSec, minWins, and the
 * grid ranges) live under the `rocHypothesis:` block in config.yml (or
 * $CONFIG_PATH), not as CLI flags.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parse } from 'csv-parse/sync';

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const FILES_ARG = getArg('files', '');
const WINDOW_ARG = getArg('window', '');
const THRESHOLD_ARG = getArg('threshold', '');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../config.yml');
const rawConfig = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;
const rocConfig = rawConfig.rocHypothesis;

const TARGET_POINTS: number = rocConfig.target;
const STOPLOSS_POINTS: number = rocConfig.stopLoss;
const COOLDOWN_MS: number = rocConfig.cooldownSec * 1000;
const MIN_WINS: number = rocConfig.minWins;
const WINDOW_GRID_MIN: number[] = rocConfig.windowGridMin;
const THRESHOLD_GRID: number[] = rocConfig.thresholdGrid;
const CSV_OUT: boolean = !!rocConfig.csvOutput;

interface Tick {
    ltp: number;
    ltt: number; // epoch ms
}

interface DayData {
    label: string;
    ticks: Tick[];
}

interface TradeOutcome {
    day: string;
    direction: 'CE' | 'PE';
    entryPrice: number;
    entryAt: number;
    rateOfChange: number;
    targetPrice: number;
    slPrice: number;
    outcome: 'TARGET' | 'STOPLOSS' | 'OPEN_EOD';
    hitAt: number | null;
    timeToHitMs: number | null;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function fmtTime(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(11, 19);
}

function fmtDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m${String(s).padStart(2, '0')}s`;
}

function loadNiftyTicks(filePath: string): DayData {
    const content = fs.readFileSync(filePath, 'utf-8');
    const records: any[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const ticks = records
        .filter(r => r.token === 'NIFTY' && r.ltt)
        .map(r => ({ ltp: Number(r.ltp), ltt: Number(r.ltt) * 1000 }));
    ticks.sort((a, b) => a.ltt - b.ltt);
    const label = ticks.length ? new Date(ticks[0].ltt).toISOString().slice(0, 10) : path.basename(filePath);
    return { label, ticks };
}

// Single pass: while no trade is active, slide a trailing window of length
// windowMs behind the current tick and check whether the magnitude of the
// point change across it clears `threshold`. If so, "buy" in the direction
// of the move (CE on close>open, PE on close<open) at the current price,
// then track forward tick-by-tick until target or stop-loss is hit. Only one
// trade is open at a time, mirroring RateOfChangeStrategy's `this.contract`
// gate, and a cooldown after each close avoids immediately re-triggering off
// the same window.
function simulateDay(day: DayData, windowMs: number, threshold: number): TradeOutcome[] {
    const { ticks, label } = day;
    const trades: TradeOutcome[] = [];
    if (ticks.length === 0) return trades;

    let active: Omit<TradeOutcome, 'outcome' | 'hitAt' | 'timeToHitMs' | 'day'> | null = null;
    let windowStart = 0;
    let cooldownUntil = 0;

    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];

        if (active) {
            const isCE = active.direction === 'CE';
            const targetHit = isCE ? tick.ltp >= active.targetPrice : tick.ltp <= active.targetPrice;
            const slHit = isCE ? tick.ltp <= active.slPrice : tick.ltp >= active.slPrice;
            if (targetHit || slHit) {
                // A tick that crosses both bounds at once is scored as the worse
                // outcome (stop-loss), same convention as the S/R hypothesis tool.
                const outcome: TradeOutcome['outcome'] = slHit ? 'STOPLOSS' : 'TARGET';
                trades.push({ ...active, day: label, outcome, hitAt: tick.ltt, timeToHitMs: tick.ltt - active.entryAt });
                active = null;
                cooldownUntil = tick.ltt + COOLDOWN_MS;
            }
            continue;
        }

        while (ticks[windowStart].ltt < tick.ltt - windowMs) windowStart++;

        if (tick.ltt - ticks[0].ltt < windowMs) continue; // not enough history for a full window yet
        if (tick.ltt < cooldownUntil) continue;

        const open = ticks[windowStart].ltp;
        const close = tick.ltp;
        const change = close - open;
        const rateOfChange = Math.abs(change);

        if (rateOfChange > threshold && change !== 0) {
            const direction: 'CE' | 'PE' = change > 0 ? 'CE' : 'PE';
            const entryPrice = close;
            const targetPrice = direction === 'CE' ? entryPrice + TARGET_POINTS : entryPrice - TARGET_POINTS;
            const slPrice = direction === 'CE' ? entryPrice - STOPLOSS_POINTS : entryPrice + STOPLOSS_POINTS;
            active = { direction, entryPrice, entryAt: tick.ltt, rateOfChange, targetPrice, slPrice };
        }
    }

    if (active) {
        trades.push({ ...active, day: label, outcome: 'OPEN_EOD', hitAt: null, timeToHitMs: null });
    }

    return trades;
}

function summarize(trades: TradeOutcome[]) {
    const wins = trades.filter(t => t.outcome === 'TARGET').length;
    const losses = trades.filter(t => t.outcome === 'STOPLOSS').length;
    const openEod = trades.filter(t => t.outcome === 'OPEN_EOD').length;
    const decided = wins + losses;
    const winRate = decided ? round2((wins / decided) * 100) : 0;
    return { wins, losses, openEod, decided, winRate };
}

function printTrades(trades: TradeOutcome[]) {
    console.log(`\n${'#'.padStart(3)}  ${'day'.padStart(10)}  ${'side'.padStart(4)}  ${'entry'.padStart(9)}  ${'roc'.padStart(7)}  ${'target'.padStart(9)}  ${'sl'.padStart(9)}  ${'outcome'.padStart(9)}  ${'entryAt'.padStart(8)}  ${'timeToHit'.padStart(9)}`);
    console.log('-'.repeat(100));
    trades.forEach((t, i) => {
        const timeStr = t.timeToHitMs !== null ? fmtDuration(t.timeToHitMs) : '-';
        console.log(
            `${String(i + 1).padStart(3)}  ${t.day.padStart(10)}  ${t.direction.padStart(4)}  ${round2(t.entryPrice).toFixed(2).padStart(9)}  ${round2(t.rateOfChange).toFixed(2).padStart(7)}  ${round2(t.targetPrice).toFixed(2).padStart(9)}  ${round2(t.slPrice).toFixed(2).padStart(9)}  ${t.outcome.padStart(9)}  ${fmtTime(t.entryAt).padStart(8)}  ${timeStr.padStart(9)}`
        );
    });
}

async function main() {
    if (!FILES_ARG) {
        console.error('Usage: node ./dist/tools/RateOfChangeHypothesisTest.js --files day1.csv,day2.csv [--window N --threshold N]');
        process.exit(1);
    }

    const days = FILES_ARG.split(',').map(f => loadNiftyTicks(f.trim()));
    for (const d of days) {
        console.error(`Loaded ${d.ticks.length} NIFTY ticks for ${d.label}`);
        if (d.ticks.length === 0) {
            console.error(`No NIFTY rows found for ${d.label} - aborting`);
            process.exit(1);
        }
    }
    console.error(`Config: target=${TARGET_POINTS} stopLoss=${STOPLOSS_POINTS} cooldownSec=${rocConfig.cooldownSec} minWins=${MIN_WINS}`);

    // --- Single-run mode: one specific window/threshold, full trade detail ---
    if (WINDOW_ARG && THRESHOLD_ARG) {
        const windowMin = Number(WINDOW_ARG);
        const threshold = Number(THRESHOLD_ARG);
        const windowMs = windowMin * 60_000;

        const allTrades: TradeOutcome[] = [];
        for (const day of days) {
            allTrades.push(...simulateDay(day, windowMs, threshold));
        }

        console.log(`\n=== window=${windowMin}min threshold=${threshold} ===`);
        printTrades(allTrades);

        const { wins, losses, openEod, decided, winRate } = summarize(allTrades);
        console.log('\n--- trade summary ---');
        console.log(`total trades:  ${allTrades.length}`);
        console.log(`target hits:   ${wins}`);
        console.log(`stop-loss hits:${losses}`);
        console.log(`open at EOD:   ${openEod}`);
        console.log(`win rate:      ${decided ? winRate + '%' : 'n/a'} (of ${decided} decided)`);

        if (CSV_OUT) {
            const outDir = path.join(__dirname, '../../analysis/output');
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, `roc_trades_w${windowMin}_t${threshold}.csv`);
            const lines = ['day,side,entryPrice,rateOfChange,targetPrice,slPrice,outcome,entryAt,timeToHitMs'];
            for (const t of allTrades) {
                lines.push(`${t.day},${t.direction},${round2(t.entryPrice)},${round2(t.rateOfChange)},${round2(t.targetPrice)},${round2(t.slPrice)},${t.outcome},${fmtTime(t.entryAt)},${t.timeToHitMs ?? ''}`);
            }
            fs.writeFileSync(outPath, lines.join('\n') + '\n');
            console.error(`Wrote ${outPath}`);
        }

        process.exit(0);
    }

    // --- Grid-search mode: sweep window x threshold, surface configs that
    // clear minWins decided wins at a 100% win rate, combined across all days ---
    console.error(`Grid: windows=[${WINDOW_GRID_MIN.join(',')}]min thresholds=[${THRESHOLD_GRID.join(',')}]pts (${WINDOW_GRID_MIN.length * THRESHOLD_GRID.length} combos)`);

    interface GridResult { windowMin: number; threshold: number; trades: number; wins: number; losses: number; openEod: number; winRate: number; }
    const results: GridResult[] = [];

    for (const windowMin of WINDOW_GRID_MIN) {
        const windowMs = windowMin * 60_000;
        for (const threshold of THRESHOLD_GRID) {
            const allTrades: TradeOutcome[] = [];
            for (const day of days) {
                allTrades.push(...simulateDay(day, windowMs, threshold));
            }
            const { wins, losses, openEod, decided, winRate } = summarize(allTrades);
            results.push({ windowMin, threshold, trades: allTrades.length, wins, losses, openEod, winRate: decided ? winRate : 0 });
        }
    }

    console.log(`\n${'window'.padStart(6)}  ${'thresh'.padStart(6)}  ${'trades'.padStart(6)}  ${'wins'.padStart(4)}  ${'losses'.padStart(6)}  ${'openEod'.padStart(7)}  ${'winRate'.padStart(7)}`);
    console.log('-'.repeat(55));
    for (const r of results) {
        console.log(
            `${String(r.windowMin).padStart(6)}  ${String(r.threshold).padStart(6)}  ${String(r.trades).padStart(6)}  ${String(r.wins).padStart(4)}  ${String(r.losses).padStart(6)}  ${String(r.openEod).padStart(7)}  ${(r.trades > r.openEod ? r.winRate + '%' : 'n/a').padStart(7)}`
        );
    }

    const matches = results
        .filter(r => r.losses === 0 && r.wins >= MIN_WINS)
        .sort((a, b) => b.wins - a.wins || a.windowMin - b.windowMin || a.threshold - b.threshold);

    console.log(`\n--- configs with >=${MIN_WINS} wins and 0 losses (100% win rate) ---`);
    if (matches.length === 0) {
        console.log('none found in the swept grid - widen windowGridMin/thresholdGrid in config.yml and re-run');
    } else {
        for (const m of matches) {
            console.log(`window=${m.windowMin}min threshold=${m.threshold}pts -> ${m.wins} wins / 0 losses (${m.openEod} open at EOD)`);
        }
        const best = matches[0];
        console.log(`\nBest candidate: window=${best.windowMin}min threshold=${best.threshold}pts. Re-run with --window ${best.windowMin} --threshold ${best.threshold} to see the per-trade detail.`);
    }

    if (CSV_OUT) {
        const outDir = path.join(__dirname, '../../analysis/output');
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `roc_grid.csv`);
        const lines = ['windowMin,threshold,trades,wins,losses,openEod,winRate'];
        for (const r of results) {
            lines.push(`${r.windowMin},${r.threshold},${r.trades},${r.wins},${r.losses},${r.openEod},${r.winRate}`);
        }
        fs.writeFileSync(outPath, lines.join('\n') + '\n');
        console.error(`Wrote ${outPath}`);
    }

    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
