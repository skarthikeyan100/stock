// SupportResistance dynamic-detector backtest
// Auto-discovers all folders in /home/karthikeyan/work/data/backups/*/csv/Quote.csv
// Replays each day's NIFTY ticks through the dynamic support/resistance detector
// (../lib/supportResistance.ts, same one src/tools/SupportResistanceHypothesisTest.ts
// uses) and simulates a target/stop-loss walk-forward on every breach (CE on
// resistance breach, PE on support breach) - not a coin-flip.
//
// Usage: tsc && node ./dist/test/supportResistanceBacktest.js
// No parameters needed - automatically scans backups directory. Tuning values
// come from the `srHypothesis:` block in config.yml (or $CONFIG_PATH), shared
// with SupportResistanceHypothesisTest.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parse } from 'csv-parse/sync';
import { initSRState, processTick, SRConfig } from '../lib/supportResistance';

const BACKUPS_DIR = '/home/karthikeyan/work/data/backups';

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../config.yml');
const rawConfig = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;
const srConfig = rawConfig.srHypothesis;

const SR_CONFIG: SRConfig = {
  confirmWindowMs: srConfig.confirmWindowMin * 60_000,
  maxJump: srConfig.maxJump,
  maxRangeWidth: srConfig.maxRangeWidth,
  buffer: srConfig.buffer,
  breachBuffer: srConfig.breachBuffer,
  breachConfirmMs: srConfig.breachConfirmSec * 1000,
};
const TARGET_POINTS: number = srConfig.target;
const STOPLOSS_POINTS: number = srConfig.stopLoss;
const POINTS_MULTIPLIER = 50; // matches the previous mock's per-point P&L convention

interface Tick {
  ltp: number;
  ltt: number; // epoch ms
}

interface RangeRecord {
  support: number;
  resistance: number;
  lockedAt: number;
  lockIndex: number;
  breachedAt: number | null;
  breachIndex: number | null;
  direction: 'support' | 'resistance' | 'EOD' | null;
}

interface BacktestResult {
  folder: string;
  niftyTicks: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  totalPnL: number;
  winRate: number;
  avgPnL: number;
  error?: string;
}

function parseQuoteCSV(csvPath: string): Array<any> {
  const content = fs.readFileSync(csvPath, 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
  });
}

function loadNiftyTicks(csvPath: string): Tick[] {
  const rows = parseQuoteCSV(csvPath);
  const ticks = rows
    .filter(r => r.index === 'NIFTY')
    .map(r => ({ ltp: Number(r.ltp), ltt: Number(r.ltt) * 1000 }))
    .filter(t => t.ltp > 0);
  ticks.sort((a, b) => a.ltt - b.ltt);
  return ticks;
}

// Walks forward from a breach to find whether target or stop-loss is hit first.
// Returns the P&L in points (positive = target hit, negative = stop-loss hit,
// null = still open at end of day - excluded from win/loss counts).
function simulateTrade(ticks: Tick[], range: RangeRecord): number | null {
  if (range.direction !== 'support' && range.direction !== 'resistance') return null;
  if (range.breachIndex === null) return null;

  const entryPrice = ticks[range.breachIndex].ltp;
  const isResistance = range.direction === 'resistance';
  const targetPrice = isResistance ? entryPrice + TARGET_POINTS : entryPrice - TARGET_POINTS;
  const slPrice = isResistance ? entryPrice - STOPLOSS_POINTS : entryPrice + STOPLOSS_POINTS;

  for (let i = range.breachIndex + 1; i < ticks.length; i++) {
    const ltp = ticks[i].ltp;
    const targetHit = isResistance ? ltp >= targetPrice : ltp <= targetPrice;
    const slHit = isResistance ? ltp <= slPrice : ltp >= slPrice;
    if (targetHit || slHit) {
      // If a single tick crosses both bounds at once, assume the worse outcome
      // (stop-loss) - we can't know the intra-tick path.
      return slHit ? -STOPLOSS_POINTS * POINTS_MULTIPLIER : TARGET_POINTS * POINTS_MULTIPLIER;
    }
  }

  return null; // OPEN_EOD
}

function backtestFolder(folderName: string, quoteFile: string): BacktestResult {
  const result: BacktestResult = {
    folder: folderName,
    niftyTicks: 0,
    totalTrades: 0,
    winTrades: 0,
    lossTrades: 0,
    totalPnL: 0,
    winRate: 0,
    avgPnL: 0,
  };

  try {
    if (!fs.existsSync(quoteFile)) {
      result.error = 'Quote.csv not found';
      return result;
    }

    const ticks = loadNiftyTicks(quoteFile);
    if (ticks.length === 0) {
      result.error = 'No NIFTY quotes found';
      return result;
    }
    result.niftyTicks = ticks.length;

    let state = initSRState();
    const ranges: RangeRecord[] = [];
    let current: RangeRecord | null = null;

    for (let i = 0; i < ticks.length; i++) {
      const { state: nextState, event } = processTick(state, ticks[i], SR_CONFIG);
      state = nextState;

      if (event.type === 'LOCKED') {
        current = {
          support: event.support,
          resistance: event.resistance,
          lockedAt: event.lockedAt,
          lockIndex: i,
          breachedAt: null,
          breachIndex: null,
          direction: null,
        };
        ranges.push(current);
      } else if (event.type === 'BREACH' && current) {
        current.breachedAt = event.ltt;
        current.breachIndex = i;
        current.direction = event.direction;
        current = null;
      }
    }
    if (current) current.direction = 'EOD';

    const pnls = ranges
      .map(r => simulateTrade(ticks, r))
      .filter((p): p is number => p !== null);

    const wins = pnls.filter(p => p > 0).length;
    const losses = pnls.filter(p => p < 0).length;
    const totalPnL = pnls.reduce((a, b) => a + b, 0);

    return {
      ...result,
      totalTrades: pnls.length,
      winTrades: wins,
      lossTrades: losses,
      totalPnL,
      winRate: pnls.length > 0 ? (wins / pnls.length) * 100 : 0,
      avgPnL: pnls.length > 0 ? totalPnL / pnls.length : 0,
    };
  } catch (e: any) {
    result.error = e.message || String(e);
    return result;
  }
}

function discoverDayFolders(): { day: string; quoteFile: string }[] {
  const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };

  if (!fs.existsSync(BACKUPS_DIR)) {
    console.error(`Backups directory not found: ${BACKUPS_DIR}`);
    return [];
  }

  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const found: { day: string; quoteFile: string; sortKey: number }[] = [];

  for (const entry of entries) {
    const quoteFile = path.join(BACKUPS_DIR, entry.name, 'csv', 'Quote.csv');
    if (!fs.existsSync(quoteFile)) {
      console.error(`[${entry.name}] Missing Quote.csv under csv/ - skipping`);
      continue;
    }

    const match = entry.name.match(/^([A-Za-z]{3})-(\d{1,2})$/);
    const sortKey = match && MONTHS[match[1]] !== undefined
      ? MONTHS[match[1]] * 100 + Number(match[2])
      : Number.MAX_SAFE_INTEGER;

    found.push({ day: entry.name, quoteFile, sortKey });
  }

  found.sort((a, b) => a.sortKey - b.sortKey || a.day.localeCompare(b.day));
  return found.map(({ day, quoteFile }) => ({ day, quoteFile }));
}

function printResultsTable(results: BacktestResult[]): void {
  const validResults = results.filter(r => !r.error);
  const errorResults = results.filter(r => r.error);

  if (validResults.length === 0) {
    console.log('\nNo successful backtests to report');
    if (errorResults.length > 0) {
      console.log('\nErrors:');
      errorResults.forEach(r => {
        console.log(`  ${r.folder}: ${r.error}`);
      });
    }
    return;
  }

  // Sort by win rate descending
  validResults.sort((a, b) => b.winRate - a.winRate);

  console.log(`\n=== SupportResistance Backtest (dynamic detector): all days (${validResults.length}) ===\n`);
  console.log(
    `${'day'.padEnd(10)}  ${'niftyTk'.padStart(8)}  ${'trades'.padStart(6)}  ${'wins'.padStart(5)}  ${'losses'.padStart(6)}  ${'winRate'.padStart(8)}  ${'totalPnL'.padStart(12)}  ${'avgPnL'.padStart(10)}`
  );
  console.log('-'.repeat(85));

  const tableLines = [
    `\n=== SupportResistance Backtest (dynamic detector): all days (${validResults.length}) ===\n`,
    `${'day'.padEnd(10)}  ${'niftyTk'.padStart(8)}  ${'trades'.padStart(6)}  ${'wins'.padStart(5)}  ${'losses'.padStart(6)}  ${'winRate'.padStart(8)}  ${'totalPnL'.padStart(12)}  ${'avgPnL'.padStart(10)}`,
    '-'.repeat(85),
  ];

  for (const r of validResults) {
    const winRateStr = r.totalTrades > 0 ? r.winRate.toFixed(1) + '%' : 'n/a';
    const line = `${r.folder.padEnd(10)}  ${String(r.niftyTicks).padStart(8)}  ${String(r.totalTrades).padStart(6)}  ${String(r.winTrades).padStart(5)}  ${String(r.lossTrades).padStart(6)}  ${winRateStr.padStart(8)}  ${r.totalPnL.toFixed(2).padStart(12)}  ${r.avgPnL.toFixed(2).padStart(10)}`;
    console.log(line);
    tableLines.push(line);
  }

  if (errorResults.length > 0) {
    console.log('\n=== ERRORS ===');
    tableLines.push('\n=== ERRORS ===');
    errorResults.forEach(r => {
      const line = `${r.folder}: ${r.error}`;
      console.log(line);
      tableLines.push(line);
    });
  }

  // Save results
  const resultsPath = path.join(__dirname, '../../supportresistance_backtest_results.txt');
  fs.writeFileSync(resultsPath, tableLines.join('\n'));
  console.log(`\nResults saved to supportresistance_backtest_results.txt`);
}

async function main(): Promise<void> {
  console.log(`SupportResistance Backtest (dynamic detector) - scanning ${BACKUPS_DIR}`);
  console.log(
    `Config: confirmWindow=${srConfig.confirmWindowMin}min maxJump=${srConfig.maxJump} maxRangeWidth=${srConfig.maxRangeWidth} buffer=${srConfig.buffer} target=${TARGET_POINTS} stopLoss=${STOPLOSS_POINTS} breachBuffer=${srConfig.breachBuffer} breachConfirmSec=${srConfig.breachConfirmSec}\n`
  );

  const days = discoverDayFolders();

  if (days.length === 0) {
    console.log(`No backup folders found in ${BACKUPS_DIR}`);
    console.log('Expected structure: backups/<Mon-DD>/csv/Quote.csv');
    return;
  }

  console.log(`Backtesting ${days.length} day(s)...\n`);

  const results: BacktestResult[] = [];
  for (let i = 0; i < days.length; i++) {
    const { day, quoteFile } = days[i];
    console.log(`[${i + 1}/${days.length}] ${day}...`);
    const result = backtestFolder(day, quoteFile);
    results.push(result);
    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      console.log(
        `  → ticks=${result.niftyTicks} trades=${result.totalTrades} win=${result.winRate.toFixed(1)}% pnl=${result.totalPnL.toFixed(2)}`
      );
    }
  }

  printResultsTable(results);
}

main().catch(console.error);
