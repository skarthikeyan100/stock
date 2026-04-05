/**
 * Node.js analysis pipeline — equivalent to Python main.py (without ML).
 *
 * Loads quotes from MongoDB, builds candles at all intervals, computes all 59
 * indicators, runs per-indicator sequential scans at each threshold, and writes:
 *   output/threshold_comparison.csv
 *   output/threshold_N/indicator_success_rates.csv
 *
 * Key difference from analyze.ts: scans are per-indicator (not AND-combined) and
 * have no time limit — they resolve only when price hits target, stop-loss, or end
 * of data (matching Python labeler.per_indicator_success_rates with scan_end=inf).
 *
 * Usage:
 *   node ./dist/tools/pipeline.js [options]
 *
 * Options:
 *   --thresholds    Comma-separated list (default: 2,4,6,8,10,12,14,16,18,20)
 *   --stopLoss      Fixed stop-loss points (default: same as each threshold)
 *   --combinations  Include C(59,2)=1711 AND pair combinations
 *   --outputDir     Output directory (default: ./analysis/output)
 */
import * as fs from 'fs';
import * as path from 'path';
import Mongo from './mongo';
import { buildCandles } from '../lib/candle-builder';
import {
    calcRSI, calcRSIReversed,
    calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic,
    rsiName, rsiNameReversed, emaName, macdName, bollingerName, adxName, stochasticName,
} from '../lib/indicators';
import {
    INTERVALS, INTERVAL_LABELS,
    RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS,
} from '../lib/indicator-config';

// ── CLI argument parsing ──────────────────────────────────────────────────────

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const THRESHOLDS      = getArg('thresholds', '2,4,6,8,10,12,14,16,18,20')
                            .split(',').map(s => parseFloat(s.trim()));
const STOP_LOSS_ARG   = getArg('stopLoss', '');          // empty → defaults to each threshold
const INCLUDE_COMBOS  = hasFlag('combinations');
const REVERSE_RSI     = hasFlag('reverseRsi');            // adds 21 reversed RSI (total 80)
const DATE_FILTER     = getArg('date', '');               // optional: filter by date (YYYY-MM-DD)
const INTERVAL_FILTER = getArg('interval', '');           // optional: restrict to one interval in seconds e.g. 300 for 5min
const INDICATOR_ARG   = getArg('indicators', '');         // optional: comma-separated indicator names e.g. RSI_5_90_10
const OUTPUT_DIR      = getArg('outputDir',
                            path.join(__dirname, '../../analysis/output'));

// ── Column name list (59 base + optional 21 reversed RSI = 80 total) ──────────
//
// Matches Python feature_builder.py _build_column_names() exactly.

function buildBaseColumns(reverseRsi: boolean): string[] {
    const cols: string[] = [];
    for (const p of RSI_PARAMS)        cols.push(rsiName(p.period, p.overbought, p.oversold));
    for (const p of MACD_PARAMS)       cols.push(macdName(p.shortPeriod, p.longPeriod, p.signalPeriod));
    for (const p of BOLLINGER_PARAMS)  cols.push(bollingerName(p.period, p.numDeviations));
    for (const p of EMA_PARAMS)        cols.push(emaName(p.shortPeriod, p.longPeriod));
    for (const p of ADX_PARAMS)        cols.push(adxName(p.period));
    for (const p of STOCHASTIC_PARAMS) cols.push(stochasticName(p.kPeriod, p.dPeriod));
    if (reverseRsi) {
        for (const p of RSI_PARAMS)    cols.push(rsiNameReversed(p.period, p.overbought, p.oversold));
    }
    return cols;
}

// ── Feature builder: compute all indicators for each candle at one interval ───

interface CandleRow {
    time: number;
    close: number;
    high: number;
    low: number;
    interval: number;
    [col: string]: number | string | null;
}

function buildFeatures(
    candles: ReturnType<typeof buildCandles>,
    intervalSeconds: number,
    reverseRsi: boolean,
    indicatorFilter: Set<string> = new Set(),
): CandleRow[] {
    const rows: CandleRow[] = [];
    const closes: number[] = [];
    const highs: number[]  = [];
    const lows: number[]   = [];
    const needHighLow = indicatorFilter.size === 0
        || [...indicatorFilter].some(n => n.startsWith('ADX_') || n.startsWith('STOCH_'));

    for (const c of candles) {
        closes.push(c.close);
        if (needHighLow) { highs.push(c.high); lows.push(c.low); }

        const row: CandleRow = { time: c.time, close: c.close, high: c.high, low: c.low, interval: intervalSeconds };

        for (const p of RSI_PARAMS) {
            const name = rsiName(p.period, p.overbought, p.oversold);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcRSI(closes, p.period, p.overbought, p.oversold)?.trend ?? null;
        }
        for (const p of MACD_PARAMS) {
            const name = macdName(p.shortPeriod, p.longPeriod, p.signalPeriod);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcMACD(closes, p.shortPeriod, p.longPeriod, p.signalPeriod)?.trend ?? null;
        }
        for (const p of BOLLINGER_PARAMS) {
            const name = bollingerName(p.period, p.numDeviations);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcBollinger(closes, p.period, p.numDeviations)?.trend ?? null;
        }
        for (const p of EMA_PARAMS) {
            const name = emaName(p.shortPeriod, p.longPeriod);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcEMACrossover(closes, p.shortPeriod, p.longPeriod)?.trend ?? null;
        }
        for (const p of ADX_PARAMS) {
            const name = adxName(p.period);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcADX(highs, lows, closes, p.period)?.trend ?? null;
        }
        for (const p of STOCHASTIC_PARAMS) {
            const name = stochasticName(p.kPeriod, p.dPeriod);
            if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
            row[name] = calcStochastic(highs, lows, closes, p.kPeriod, p.dPeriod)?.trend ?? null;
        }
        // Reversed RSI: overbought→UP, oversold→DOWN (contrarian)
        if (reverseRsi) {
            for (const p of RSI_PARAMS) {
                const name = rsiNameReversed(p.period, p.overbought, p.oversold);
                if (indicatorFilter.size > 0 && !indicatorFilter.has(name)) continue;
                row[name] = calcRSIReversed(closes, p.period, p.overbought, p.oversold)?.trend ?? null;
            }
        }

        console.log(`[VERIFY] Candle: interval=${intervalSeconds} time=${c.time} open=${c.open} high=${c.high} low=${c.low} close=${c.close}`);
        if ('RSI_5_90_10' in row && row['RSI_5_90_10'] !== null) {
            console.log(`[VERIFY] Signal: interval=${intervalSeconds} time=${c.time} close=${c.close} RSI_5_90_10=${row['RSI_5_90_10']}`);
        }

        rows.push(row);
    }
    return rows;
}

// ── AND pair combination builder (matches Python CombinationBuilder) ──────────

function addCombinations(rows: CandleRow[], baseCols: string[]): string[] {
    const comboCols: string[] = [];
    for (let i = 0; i < baseCols.length; i++) {
        for (let j = i + 1; j < baseCols.length; j++) {
            const name = `${baseCols[i]}__AND__${baseCols[j]}`;
            comboCols.push(name);
            for (const row of rows) {
                const v1 = row[baseCols[i]];
                const v2 = row[baseCols[j]];
                row[name] = (v1 === v2 && (v1 === 'UP' || v1 === 'DOWN')) ? v1 : 'NEUTRAL';
            }
        }
    }
    return comboCols;
}

// ── Per-indicator sequential scan ─────────────────────────────────────────────
//
// Mirrors Python Labeler.per_indicator_success_rates() with scan_end_time=inf.
// One active scan per indicator — blocks new signals until resolved.
// No time limit: resolves only when target/stop hit or end of data.
//
// Optimised: rawPtr advances forward monotonically per indicator (O(n) total,
// not O(n²)) so that re-processing the same raw ticks never occurs.

interface SuccessRateRow {
    indicator: string;
    good: number;
    bad: number;
    oscillating: number;
    total: number;
    success_rate: number;
    interval_label: string;
}

function perIndicatorSuccessRates(
    rows: CandleRow[],
    allCols: string[],
    rawLtt: number[],
    rawLtp: number[],
    threshold: number,
    stopLoss: number,
    intervalLabel: string,
): SuccessRateRow[] {
    const results: SuccessRateRow[] = [];

    for (const indicator of allCols) {
        let good = 0, bad = 0, oscillating = 0;

        // Active scan state
        let scanning     = false;
        let scanDir      = '';
        let scanClose    = 0;
        let scanStartTime = 0;
        let target       = 0;
        let stop         = 0;
        let targetHit    = false;
        let stopHit      = false;
        let targetHitAt  = 0;  // sequential counter when target was first hit
        let stopHitAt    = 0;  // sequential counter when stop was first hit
        let pricesChecked = 0;

        let rawPtr = 0;  // monotonically advancing pointer into rawLtt/rawLtp

        for (const row of rows) {
            // ── Step 1: advance through raw prices up to this candle time ──
            if (scanning) {
                while (rawPtr < rawLtt.length && rawLtt[rawPtr] <= row.time) {
                    if (rawLtt[rawPtr] > scanStartTime) {
                        const price = rawLtp[rawPtr];

                        if (!targetHit) {
                            const hit = scanDir === 'UP' ? price >= target : price <= target;
                            if (hit) { targetHit = true; targetHitAt = pricesChecked; }
                        }
                        if (!stopHit) {
                            const hit = scanDir === 'UP' ? price <= stop : price >= stop;
                            if (hit) { stopHit = true; stopHitAt = pricesChecked; }
                        }
                        pricesChecked++;

                        if (targetHit || stopHit) {
                            rawPtr++;
                            break;  // First hit found; no need to scan further
                        }
                    }
                    rawPtr++;
                }

                // Resolve scan if target or stop (or both) hit
                if (targetHit && stopHit) {
                    if (targetHitAt < stopHitAt) good++; else bad++;
                    scanning = false;
                } else if (targetHit) {
                    good++;
                    scanning = false;
                } else if (stopHit) {
                    bad++;
                    scanning = false;
                }
                // else: neither hit yet — scan continues to next candle
            }

            // ── Advance rawPtr past this candle when not scanning ──────────
            if (!scanning) {
                while (rawPtr < rawLtt.length && rawLtt[rawPtr] <= row.time) rawPtr++;
            }

            // ── Step 2: start new scan if signal present and none active ──
            const direction = row[indicator] as string | null;
            if (!scanning && (direction === 'UP' || direction === 'DOWN')) {
                scanning      = true;
                scanDir       = direction;
                scanClose     = row.close;
                scanStartTime = row.time;
                target        = direction === 'UP' ? scanClose + threshold : scanClose - threshold;
                stop          = direction === 'UP' ? scanClose - stopLoss  : scanClose + stopLoss;
                targetHit     = false;
                stopHit       = false;
                targetHitAt   = 0;
                stopHitAt     = 0;
                pricesChecked = 0;
                // rawPtr already points past row.time — correct starting position
            }
        }

        // Unresolved scan after all candles → oscillating
        if (scanning) oscillating++;

        const total = good + bad;
        results.push({
            indicator,
            good,
            bad,
            oscillating,
            total,
            success_rate: total > 0 ? Math.round(good / total * 10000) / 100 : 0,
            interval_label: intervalLabel,
        });
    }

    return results.sort((a, b) => b.success_rate - a.success_rate);
}

// ── CSV writer ────────────────────────────────────────────────────────────────

function writeCSV(filePath: string, rows: object[]): void {
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) {
        const vals = headers.map(h => {
            const v = (row as any)[h];
            return v === null || v === undefined ? '' : String(v);
        });
        lines.push(vals.join(','));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    console.error(`  Wrote ${filePath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    await Mongo.init();
    const db = Mongo.getInstance().db;
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // ── Phase 1: Load data ─────────────────────────────────────────────────
    console.error('=== Phase 1: Loading data ===');
    const query = DATE_FILTER ? { date: DATE_FILTER } : {};
    if (DATE_FILTER) console.error(`  Filtering by date: ${DATE_FILTER}`);
    const rawQuotes = await db.collection('Quote').find(query).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${rawQuotes.length} raw quotes`);

    const rawLtt = rawQuotes.map(q => Number(q.ltt));
    const rawLtp = rawQuotes.map(q => Number(q.ltp));

    const indicatorFilter = INDICATOR_ARG
        ? new Set(INDICATOR_ARG.split(',').map(s => s.trim()))
        : new Set<string>();

    let baseCols = buildBaseColumns(REVERSE_RSI);
    if (indicatorFilter.size > 0) {
        baseCols = baseCols.filter(c => indicatorFilter.has(c));
        console.error(`Indicator filter: [${[...indicatorFilter].join(', ')}] → ${baseCols.length} matched`);
    } else {
        console.error(`Base indicators: ${baseCols.length} (${REVERSE_RSI ? '80 with reversed RSI' : '59'})`);
    }

    // ── Phase 2: Build candles + compute features at each interval ─────────
    console.error('\n=== Phase 2: Building candles and computing indicators ===');
    const intervalRows = new Map<number, CandleRow[]>();

    const activeIntervals = INTERVAL_FILTER
        ? INTERVALS.filter(i => i === parseInt(INTERVAL_FILTER))
        : INTERVALS;
    if (INTERVAL_FILTER) console.error(`  Restricted to interval: ${INTERVAL_LABELS[parseInt(INTERVAL_FILTER)] || INTERVAL_FILTER}s`);

    for (const interval of activeIntervals) {
        const label   = INTERVAL_LABELS[interval];
        const candles = buildCandles(rawQuotes, interval);
        console.error(`  ${label}: ${candles.length} candles`);
        if (candles.length < 5) { console.error(`    Skipping — too few candles`); continue; }
        intervalRows.set(interval, buildFeatures(candles, interval, REVERSE_RSI, indicatorFilter));
    }

    // ── Phase 2b: AND pair combinations (optional) ─────────────────────────
    let allCols = [...baseCols];
    if (INCLUDE_COMBOS) {
        console.error('\nGenerating AND pair combinations...');
        for (const rows of intervalRows.values()) {
            const comboCols = addCombinations(rows, baseCols);
            if (allCols.length === baseCols.length) {
                allCols = [...baseCols, ...comboCols];
            }
        }
        console.error(`Total indicators (with combinations): ${allCols.length}`);
    }

    // ── Phase 3: Multi-threshold analysis ──────────────────────────────────
    console.error('\n=== Phase 3: Multi-threshold analysis ===');
    console.error(`Thresholds: [${THRESHOLDS.join(', ')}]`);

    const allSummaryRows: object[] = [];

    for (const threshold of THRESHOLDS) {
        const stopLoss = STOP_LOSS_ARG !== '' ? parseFloat(STOP_LOSS_ARG) : threshold;
        console.error(`\n  Threshold=${threshold}, StopLoss=${stopLoss}`);

        const thresholdDir = path.join(OUTPUT_DIR, `threshold_${threshold}`);
        fs.mkdirSync(thresholdDir, { recursive: true });

        const allIntervalRows: SuccessRateRow[] = [];

        for (const [interval, rows] of intervalRows) {
            const label = INTERVAL_LABELS[interval];
            console.error(`    ${label}: scanning ${allCols.length} indicators...`);

            const sr = perIndicatorSuccessRates(rows, allCols, rawLtt, rawLtp, threshold, stopLoss, label);
            for (const r of sr) allIntervalRows.push(r);

            const totalGood = sr.reduce((s, r) => s + r.good, 0);
            const totalBad  = sr.reduce((s, r) => s + r.bad, 0);
            const overall   = (totalGood + totalBad) > 0
                ? Math.round(totalGood / (totalGood + totalBad) * 10000) / 100 : 0;
            console.error(`      good=${totalGood} bad=${totalBad} overall_rate=${overall}%`);

            // Per-threshold summary rows for threshold_comparison.csv
            sr.forEach((r, i) => allSummaryRows.push({
                threshold,
                interval_label: label,
                rank: i + 1,
                indicator: r.indicator,
                good_count: r.good,
                bad_count: r.bad,
                success_rate: r.success_rate,
                total_good: totalGood,
                total_bad: totalBad,
                overall_success_rate: overall,
            }));
        }

        // Per-threshold combined CSV (all intervals, matches Python indicator_success_rates.csv)
        writeCSV(path.join(thresholdDir, 'indicator_success_rates.csv'), allIntervalRows);
    }

    // ── Phase 4: Write threshold_comparison.csv ────────────────────────────
    const dateSuffix = DATE_FILTER ? `_${DATE_FILTER}` : '';
    const outputFile = `threshold_comparison${dateSuffix}.csv`;
    console.error(`\n=== Phase 4: Writing ${outputFile} ===`);
    writeCSV(path.join(OUTPUT_DIR, outputFile), allSummaryRows);

    console.error('\nDone.');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
