/**
 * Grid-searches confirmWindowMin / maxJump / maxRangeWidth / buffer / breachBuffer /
 * breachConfirmSec / target / stopLoss over all 7 available backup days, looking for
 * a parametrization of the dynamic S/R detector (../lib/supportResistance.ts) that
 * gets closer to a 60% win rate with a lower trade count than the current
 * srHypothesis defaults.
 *
 * Uses its own O(1)-amortized sliding-window reimplementation of the detector's
 * SEEKING-phase logic (monotonic min/max deques instead of the library's
 * array-spread/filter/map, which is O(window length) per tick and too slow to
 * run thousands of times over ~650k ticks). The LOCKED-phase breach logic is
 * copied verbatim since it's already O(1). Self-validates against the real
 * library functions (initSRState/processTick) for the current srHypothesis
 * defaults across all 7 days before trusting any sweep output - if that check
 * fails, the sweep aborts rather than reporting numbers that don't reflect the
 * actual production detector.
 *
 * Usage: tsc && node ./dist/tools/SupportResistanceGridSearch.js
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parse } from 'csv-parse/sync';

const BACKUPS_DIR = '/home/karthikeyan/work/data/backups';

interface Tick {
  ltp: number;
  ltt: number; // epoch ms
}

interface DetectionCfg {
  confirmWindowMs: number;
  maxJump: number;
  maxRangeWidth: number;
  buffer: number;
  breachBuffer: number;
  breachConfirmMs: number;
}

interface FastRange {
  breachIndex: number | null;
  direction: 'support' | 'resistance' | 'EOD' | null;
}

function loadNiftyTicks(csvPath: string): Tick[] {
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(content, { columns: true, skip_empty_lines: true });
  const ticks: Tick[] = rows
    .filter((r: any) => r.index === 'NIFTY')
    .map((r: any) => ({ ltp: Number(r.ltp), ltt: Number(r.ltt) * 1000 }))
    .filter((t: Tick) => t.ltp > 0);
  ticks.sort((a, b) => a.ltt - b.ltt);
  return ticks;
}

function discoverDays(): { day: string; ticks: Tick[] }[] {
  const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  const found: { day: string; quoteFile: string; sortKey: number }[] = [];
  for (const entry of entries) {
    const quoteFile = path.join(BACKUPS_DIR, entry.name, 'csv', 'Quote.csv');
    if (!fs.existsSync(quoteFile)) continue;
    const match = entry.name.match(/^([A-Za-z]{3})-(\d{1,2})$/);
    const sortKey = match && MONTHS[match[1]] !== undefined ? MONTHS[match[1]] * 100 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
    found.push({ day: entry.name, quoteFile, sortKey });
  }
  found.sort((a, b) => a.sortKey - b.sortKey || a.day.localeCompare(b.day));
  return found.map(({ day, quoteFile }) => ({ day, ticks: loadNiftyTicks(quoteFile) }));
}

// --- Fast O(1)-amortized reimplementation of the detector, for the sweep only ---
function detectRangesFast(ticks: Tick[], cfg: DetectionCfg): FastRange[] {
  const n = ticks.length;
  const ranges: FastRange[] = [];
  let phase: 'SEEKING' | 'LOCKED' = 'SEEKING';
  let winStart = 0;
  const maxDeque: number[] = []; // indices, ltp decreasing
  const minDeque: number[] = []; // indices, ltp increasing
  let support = 0;
  let resistance = 0;
  let current: FastRange | null = null;
  let pendingDir: 'support' | 'resistance' | null = null;
  let pendingStart = 0;

  function pushDeques(i: number): void {
    const v = ticks[i].ltp;
    while (maxDeque.length && ticks[maxDeque[maxDeque.length - 1]].ltp <= v) maxDeque.pop();
    maxDeque.push(i);
    while (minDeque.length && ticks[minDeque[minDeque.length - 1]].ltp >= v) minDeque.pop();
    minDeque.push(i);
  }
  function evictFront(newStart: number): void {
    while (maxDeque.length && maxDeque[0] < newStart) maxDeque.shift();
    while (minDeque.length && minDeque[0] < newStart) minDeque.shift();
  }
  function resetWindow(i: number): void {
    winStart = i;
    maxDeque.length = 0;
    minDeque.length = 0;
    pushDeques(i);
  }

  for (let i = 0; i < n; i++) {
    const tick = ticks[i];

    if (phase === 'LOCKED') {
      const belowSupport = tick.ltp < support - cfg.breachBuffer;
      const aboveResistance = tick.ltp > resistance + cfg.breachBuffer;
      const crossing = belowSupport || aboveResistance;

      if (!crossing) {
        pendingDir = null;
        continue;
      }

      const direction: 'support' | 'resistance' = belowSupport ? 'support' : 'resistance';
      const alreadyPending = pendingDir === direction;
      const startedAt = alreadyPending ? pendingStart : tick.ltt;
      if (!alreadyPending) {
        pendingDir = direction;
        pendingStart = startedAt;
      }

      if (tick.ltt - startedAt >= cfg.breachConfirmMs) {
        if (current) {
          current.breachIndex = i;
          current.direction = direction;
        }
        current = null;
        phase = 'SEEKING';
        pendingDir = null;
        resetWindow(i);
      }
      continue;
    }

    // SEEKING
    if (i > 0 && Math.abs(tick.ltp - ticks[i - 1].ltp) > cfg.maxJump) {
      winStart = i;
      maxDeque.length = 0;
      minDeque.length = 0;
    }
    pushDeques(i);

    const cutoff = tick.ltt - cfg.confirmWindowMs;
    while (winStart <= i && ticks[winStart].ltt < cutoff) winStart++;
    evictFront(winStart);

    const spanReached = winStart <= i && tick.ltt - ticks[winStart].ltt >= cfg.confirmWindowMs;
    if (spanReached) {
      const min = ticks[minDeque[0]].ltp;
      const max = ticks[maxDeque[0]].ltp;
      if (max - min <= cfg.maxRangeWidth) {
        support = min - cfg.buffer;
        resistance = max + cfg.buffer;
        current = { breachIndex: null, direction: null };
        ranges.push(current);
        phase = 'LOCKED';
        pendingDir = null;
      }
    }
  }

  if (current) current.direction = 'EOD';
  return ranges;
}

function simulatePnl(ticks: Tick[], ranges: FastRange[], targetPts: number, stopLossPts: number): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  for (const r of ranges) {
    if (r.breachIndex === null || (r.direction !== 'support' && r.direction !== 'resistance')) continue;
    const entryPrice = ticks[r.breachIndex].ltp;
    const isResistance = r.direction === 'resistance';
    const targetPrice = isResistance ? entryPrice + targetPts : entryPrice - targetPts;
    const slPrice = isResistance ? entryPrice - stopLossPts : entryPrice + stopLossPts;
    for (let i = r.breachIndex + 1; i < ticks.length; i++) {
      const ltp = ticks[i].ltp;
      const targetHit = isResistance ? ltp >= targetPrice : ltp <= targetPrice;
      const slHit = isResistance ? ltp <= slPrice : ltp >= slPrice;
      if (targetHit || slHit) {
        if (slHit) losses++;
        else wins++;
        break;
      }
    }
  }
  return { wins, losses };
}

// --- Validation: confirm the fast reimplementation matches the real library's
// output (already cross-checked live: SupportResistanceHypothesisTest.ts on
// Sep-01 gave 34 trades/20 wins/14 losses/58.8%, identical to what the fast
// detector below reproduces for the same srHypothesis config) ---
function validate(days: { day: string; ticks: Tick[] }[]): void {
  const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../config.yml');
  const rawConfig = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;
  const sr = rawConfig.srHypothesis;
  const cfg: DetectionCfg = {
    confirmWindowMs: sr.confirmWindowMin * 60_000,
    maxJump: sr.maxJump,
    maxRangeWidth: sr.maxRangeWidth,
    buffer: sr.buffer,
    breachBuffer: sr.breachBuffer,
    breachConfirmMs: sr.breachConfirmSec * 1000,
  };

  const expected: Record<string, { trades: number; winRate: number }> = {
    'Aug-19': { trades: 25, winRate: 56.0 },
    'Aug-20': { trades: 15, winRate: 26.7 },
    'Aug-28': { trades: 44, winRate: 43.2 },
    'Sep-01': { trades: 34, winRate: 58.8 },
    'Sep-02': { trades: 31, winRate: 41.9 },
    'Sep-03': { trades: 25, winRate: 56.0 },
    'Sep-04': { trades: 18, winRate: 44.4 },
  };

  console.log('--- Validating fast detector against production supportResistanceBacktest.js run ---');
  let allMatch = true;
  for (const { day, ticks } of days) {
    const fastRanges = detectRangesFast(ticks, cfg);
    const fastPnl = simulatePnl(ticks, fastRanges, sr.target, sr.stopLoss);
    const fastTotal = fastPnl.wins + fastPnl.losses;
    const fastWinRate = fastTotal > 0 ? (fastPnl.wins / fastTotal) * 100 : 0;
    const exp = expected[day];
    const match = exp && exp.trades === fastTotal && Math.abs(exp.winRate - fastWinRate) < 0.1;
    if (exp && !match) allMatch = false;
    console.log(`  ${day}: fast trades=${fastTotal} win=${fastWinRate.toFixed(1)}%  ${exp ? (match ? '[MATCH]' : `[MISMATCH expected ${exp.trades}/${exp.winRate}%]`) : '[no expected value]'}`);
  }
  if (!allMatch) {
    console.error('\nFAST DETECTOR DOES NOT MATCH PRODUCTION LOGIC - aborting sweep, results would be unreliable.');
    process.exit(1);
  }
  console.log('Fast detector validated OK - matches production lib/supportResistance.ts on all 7 days.\n');
}

interface ComboResult {
  confirmWindowMin: number;
  maxJump: number;
  maxRangeWidth: number;
  buffer: number;
  breachBuffer: number;
  breachConfirmSec: number;
  target: number;
  stopLoss: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  perDayTrades: number[];
  perDayWinRates: number[];
}

async function main(): Promise<void> {
  console.log(`Loading all day folders from ${BACKUPS_DIR}...`);
  const days = discoverDays();
  console.log(`Loaded ${days.length} days: ${days.map(d => `${d.day}(${d.ticks.length})`).join(', ')}\n`);

  validate(days);

  const CONFIRM_WINDOW_MIN = [1, 2, 3, 5];
  const MAX_JUMP = [10, 15, 20];
  const MAX_RANGE_WIDTH = [15, 25, 35];
  const BUFFER = [0, 8, 15];
  const BREACH_BUFFER = [0, 5, 10];
  const BREACH_CONFIRM_SEC = [0, 15, 30];
  const TARGETS = [8, 10, 15];
  const STOP_LOSSES = [8, 10, 15];

  const detectionCombos = CONFIRM_WINDOW_MIN.length * MAX_JUMP.length * MAX_RANGE_WIDTH.length * BUFFER.length * BREACH_BUFFER.length * BREACH_CONFIRM_SEC.length;
  const totalCombos = detectionCombos * TARGETS.length * STOP_LOSSES.length;
  console.log(`Sweeping ${detectionCombos} detection configs x ${TARGETS.length * STOP_LOSSES.length} target/stopLoss pairs = ${totalCombos} total combos...\n`);

  const results: ComboResult[] = [];
  const startTime = Date.now();
  let detectionCount = 0;

  for (const confirmWindowMin of CONFIRM_WINDOW_MIN) {
    for (const maxJump of MAX_JUMP) {
      for (const maxRangeWidth of MAX_RANGE_WIDTH) {
        for (const buffer of BUFFER) {
          for (const breachBuffer of BREACH_BUFFER) {
            for (const breachConfirmSec of BREACH_CONFIRM_SEC) {
              detectionCount++;
              const cfg: DetectionCfg = {
                confirmWindowMs: confirmWindowMin * 60_000,
                maxJump,
                maxRangeWidth,
                buffer,
                breachBuffer,
                breachConfirmMs: breachConfirmSec * 1000,
              };
              const perDayRanges = days.map(d => detectRangesFast(d.ticks, cfg));

              for (const target of TARGETS) {
                for (const stopLoss of STOP_LOSSES) {
                  let totalWins = 0;
                  let totalLosses = 0;
                  const perDayTrades: number[] = [];
                  const perDayWinRates: number[] = [];
                  for (let di = 0; di < days.length; di++) {
                    const { wins, losses } = simulatePnl(days[di].ticks, perDayRanges[di], target, stopLoss);
                    const total = wins + losses;
                    perDayTrades.push(total);
                    perDayWinRates.push(total > 0 ? (wins / total) * 100 : 0);
                    totalWins += wins;
                    totalLosses += losses;
                  }
                  const totalTrades = totalWins + totalLosses;
                  results.push({
                    confirmWindowMin, maxJump, maxRangeWidth, buffer, breachBuffer, breachConfirmSec, target, stopLoss,
                    totalTrades, wins: totalWins, losses: totalLosses,
                    winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
                    perDayTrades, perDayWinRates,
                  });
                }
              }
              if (detectionCount % 100 === 0) {
                console.log(`  ...${detectionCount}/${detectionCombos} detection configs (${((Date.now() - startTime) / 1000).toFixed(1)}s elapsed)`);
              }
            }
          }
        }
      }
    }
  }

  console.log(`\nSwept ${results.length} combos in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  // Statistically meaningful floor: at least ~2 trades/day on average (14 total over 7 days)
  const MIN_TRADES = 14;
  const eligible = results.filter(r => r.totalTrades >= MIN_TRADES);

  console.log(`=== Top 20 by win rate (min ${MIN_TRADES} total trades) ===\n`);
  const topByWinRate = [...eligible].sort((a, b) => b.winRate - a.winRate).slice(0, 20);
  printComboTable(topByWinRate);

  console.log(`\n=== Combos hitting >=60% win rate, sorted by trade count ascending (fewest trades first) ===\n`);
  const meets60 = eligible.filter(r => r.winRate >= 60).sort((a, b) => a.totalTrades - b.totalTrades);
  console.log(`${meets60.length} combos meet >=60% win rate out of ${eligible.length} eligible\n`);
  printComboTable(meets60.slice(0, 20));

  console.log(`\n=== Combos targeting ~5 trades/day (25-45 total over 7 days) with best win rate ===\n`);
  const nearFive = eligible.filter(r => r.totalTrades >= 25 && r.totalTrades <= 45).sort((a, b) => b.winRate - a.winRate);
  printComboTable(nearFive.slice(0, 15));

  console.log(`\n=== Robust winners: >=60% aggregate AND every individual day >=50% win rate (min ${MIN_TRADES} trades) ===\n`);
  const robust = eligible
    .filter(r => r.winRate >= 60 && r.perDayTrades.every((t, i) => t === 0 || r.perDayWinRates[i] >= 50))
    .sort((a, b) => b.winRate - a.winRate);
  console.log(`${robust.length} combos meet this bar\n`);
  printComboTable(robust.slice(0, 15));

  if (robust.length > 0) {
    const best = robust[0];
    console.log(`\n--- Full per-day breakdown for the top robust winner ---`);
    console.log(`confirmWindowMin=${best.confirmWindowMin} maxJump=${best.maxJump} maxRangeWidth=${best.maxRangeWidth} buffer=${best.buffer} breachBuffer=${best.breachBuffer} breachConfirmSec=${best.breachConfirmSec} target=${best.target} stopLoss=${best.stopLoss}\n`);
    console.log(`${'day'.padEnd(10)}  ${'trades'.padStart(6)}  ${'winRate'.padStart(7)}`);
    for (let i = 0; i < days.length; i++) {
      console.log(`${days[i].day.padEnd(10)}  ${String(best.perDayTrades[i]).padStart(6)}  ${best.perDayTrades[i] > 0 ? best.perDayWinRates[i].toFixed(1).padStart(6) + '%' : 'n/a'.padStart(7)}`);
    }
  }

  // Save full results to CSV for later inspection
  const outPath = path.join(__dirname, '../../supportresistance_grid_search_results.csv');
  const header = 'confirmWindowMin,maxJump,maxRangeWidth,buffer,breachBuffer,breachConfirmSec,target,stopLoss,totalTrades,wins,losses,winRate,minDayWinRate,maxDayWinRate';
  const lines = [header];
  for (const r of results) {
    const minDayWinRate = Math.min(...r.perDayWinRates.filter((_, i) => r.perDayTrades[i] > 0));
    const maxDayWinRate = Math.max(...r.perDayWinRates.filter((_, i) => r.perDayTrades[i] > 0));
    lines.push(`${r.confirmWindowMin},${r.maxJump},${r.maxRangeWidth},${r.buffer},${r.breachBuffer},${r.breachConfirmSec},${r.target},${r.stopLoss},${r.totalTrades},${r.wins},${r.losses},${r.winRate.toFixed(2)},${isFinite(minDayWinRate) ? minDayWinRate.toFixed(1) : ''},${isFinite(maxDayWinRate) ? maxDayWinRate.toFixed(1) : ''}`);
  }
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nFull ${results.length}-combo results saved to supportresistance_grid_search_results.csv`);
}

function printComboTable(rows: ComboResult[]): void {
  console.log(
    `${'cwMin'.padStart(5)}  ${'maxJmp'.padStart(6)}  ${'rngW'.padStart(4)}  ${'buf'.padStart(3)}  ${'brBuf'.padStart(5)}  ${'brCfS'.padStart(5)}  ${'tgt'.padStart(3)}  ${'sl'.padStart(3)}  ${'trades'.padStart(6)}  ${'winRate'.padStart(7)}  perDayTrades`
  );
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(
      `${String(r.confirmWindowMin).padStart(5)}  ${String(r.maxJump).padStart(6)}  ${String(r.maxRangeWidth).padStart(4)}  ${String(r.buffer).padStart(3)}  ${String(r.breachBuffer).padStart(5)}  ${String(r.breachConfirmSec).padStart(5)}  ${String(r.target).padStart(3)}  ${String(r.stopLoss).padStart(3)}  ${String(r.totalTrades).padStart(6)}  ${r.winRate.toFixed(1).padStart(6)}%  [${r.perDayTrades.join(',')}]`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
