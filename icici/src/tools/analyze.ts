/**
 * Node.js analysis tool — equivalent to Python focused_indicator.py + labeler.py.
 *
 * Loads quotes from MongoDB, builds candles, computes configured indicators,
 * runs a sequential scan (one active position at a time) with target/stop-loss
 * labeling, then prints a table and optionally writes a CSV.
 *
 * Usage:
 *   npx ts-node src/tools/analyze.ts [options]
 *
 * Options:
 *   --indicators  Comma-separated indicator names (default: RSI_5_80_20,EMA_30_70)
 *   --threshold   Target points (default: 10)
 *   --stopLoss    Stop-loss points (default: 5)
 *   --interval    Candle interval in seconds (default: 60)
 *   --output      CSV output file path (optional)
 *
 * Example:
 *   npx ts-node src/tools/analyze.ts --indicators RSI_5_80_20,EMA_30_70 --threshold 10 --stopLoss 5
 */
import * as fs from 'fs';
import * as path from 'path';
import Mongo from './mongo';
import { buildCandles, CandleData } from '../lib/candle-builder';
import { calcRSI, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic } from '../lib/indicators';

// ── CLI argument parsing ──────────────────────────────────────────────────────

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const INDICATORS   = getArg('indicators', 'RSI_5_80_20,EMA_30_70').split(',').map(s => s.trim());
const THRESHOLD    = parseFloat(getArg('threshold', '10'));
const STOP_LOSS    = parseFloat(getArg('stopLoss', '5'));
const INTERVAL     = parseInt(getArg('interval', '60'));
const OUTPUT_FILE  = getArg('output', '');

// ── Indicator signal computation ─────────────────────────────────────────────

function getSignal(name: string, closes: number[], highs: number[], lows: number[]): string | null {
    const parts = name.split('_');
    if (parts[0] === 'RSI' && parts.length >= 4) {
        return calcRSI(closes, parseInt(parts[1]), parseInt(parts[2]), parseInt(parts[3]))?.trend ?? null;
    }
    if (parts[0] === 'EMA' && parts.length === 3) {
        return calcEMACrossover(closes, parseInt(parts[1]), parseInt(parts[2]))?.trend ?? null;
    }
    if (parts[0] === 'MACD' && parts.length === 4) {
        return calcMACD(closes, parseInt(parts[1]), parseInt(parts[2]), parseInt(parts[3]))?.trend ?? null;
    }
    if (parts[0] === 'Bollinger' && parts.length === 3) {
        return calcBollinger(closes, parseInt(parts[1]), parseFloat(parts[2]))?.trend ?? null;
    }
    if (parts[0] === 'ADX' && parts.length === 2) {
        return calcADX(highs, lows, closes, parseInt(parts[1]))?.trend ?? null;
    }
    if (parts[0] === 'Stoch' && parts.length === 3) {
        return calcStochastic(highs, lows, closes, parseInt(parts[1]), parseInt(parts[2]))?.trend ?? null;
    }
    console.warn(`Unknown indicator format: ${name}`);
    return null;
}

/** AND-combine: all signals must be non-null, non-NEUTRAL, and unanimous. */
function andCombine(signals: (string | null)[]): string | null {
    if (signals.some(s => s === null || s === 'NEUTRAL')) return null;
    if (signals.every(s => s === 'UP'))   return 'UP';
    if (signals.every(s => s === 'DOWN')) return 'DOWN';
    return null;
}

// ── Sequential scan (mirrors Python labeler.per_indicator_success_rates) ─────

interface CandelRow {
    idx: number;
    time: number;
    close: number;
    signals: Record<string, string | null>;
    direction: string | null;
    label: string | null;
}

interface ActiveScan {
    idx: number;
    direction: string;
    candleTime: number;
    candleClose: number;
    scanEndTime: number;
}

function resolveScan(
    scan: ActiveScan,
    currentTime: number,
    rawLtt: number[],
    rawLtp: number[],
    threshold: number,
    stopLoss: number
): 'good' | 'bad' | 'oscillating' | 'continue' {
    const effectiveEnd = Math.min(currentTime, scan.scanEndTime);
    const mask = rawLtt.filter((t, i) => t > scan.candleTime && t <= effectiveEnd).map((_, i) => {
        const idx = rawLtt.findIndex((t, j) => t > scan.candleTime && t <= effectiveEnd && j >= i);
        return idx;
    });

    // Collect prices in window
    const windowPrices: number[] = [];
    const windowIdxs: number[] = [];
    for (let i = 0; i < rawLtt.length; i++) {
        if (rawLtt[i] > scan.candleTime && rawLtt[i] <= effectiveEnd) {
            windowPrices.push(rawLtp[i]);
            windowIdxs.push(i);
        }
    }

    if (windowPrices.length === 0) {
        return currentTime >= scan.scanEndTime ? 'oscillating' : 'continue';
    }

    let tIdx: number | null = null;
    let sIdx: number | null = null;

    if (scan.direction === 'UP') {
        const target = scan.candleClose + threshold;
        const stop   = scan.candleClose - stopLoss;
        for (let i = 0; i < windowPrices.length; i++) {
            if (tIdx === null && windowPrices[i] >= target) tIdx = i;
            if (sIdx === null && windowPrices[i] <= stop)   sIdx = i;
        }
    } else {
        const target = scan.candleClose - threshold;
        const stop   = scan.candleClose + stopLoss;
        for (let i = 0; i < windowPrices.length; i++) {
            if (tIdx === null && windowPrices[i] <= target) tIdx = i;
            if (sIdx === null && windowPrices[i] >= stop)   sIdx = i;
        }
    }

    if (tIdx !== null && sIdx !== null) return tIdx < sIdx ? 'good' : 'bad';
    if (tIdx !== null) return 'good';
    if (sIdx !== null) return 'bad';
    return currentTime >= scan.scanEndTime ? 'oscillating' : 'continue';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    await Mongo.init();
    const db = Mongo.getInstance().db;

    // Load raw quotes sorted by time
    const rawQuotes = await db.collection('NiftyQuote').find({}).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${rawQuotes.length} quotes`);

    const rawLtt = rawQuotes.map(q => Number(q.ltt));
    const rawLtp = rawQuotes.map(q => Number(q.ltp));

    // Build candles using shared lib (same algorithm as Python CandleBuilder)
    const candles = buildCandles(rawQuotes, INTERVAL);
    console.error(`Built ${candles.length} ${INTERVAL}s candles`);
    console.error(`Indicators: ${INDICATORS.join(', ')}`);
    console.error(`Threshold: ${THRESHOLD}  StopLoss: ${STOP_LOSS}`);

    // Pass 1: compute indicator values for each candle
    const rows: CandelRow[] = [];
    const closes: number[] = [];
    const highs: number[]  = [];
    const lows: number[]   = [];

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        closes.push(c.close);
        highs.push(c.high);
        lows.push(c.low);

        const signals: Record<string, string | null> = {};
        for (const name of INDICATORS) {
            signals[name] = getSignal(name, closes, highs, lows);
        }
        const direction = andCombine(Object.values(signals));

        rows.push({ idx: i, time: c.time, close: c.close, signals, direction, label: null });
    }

    // Pass 2: sequential scan (mirrors Python labeler.per_indicator_success_rates)
    let activeScan: ActiveScan | null = null;
    // Use 30-min hold time by default (matches maxHoldTimeMinutes=30 in RuleBasedStrategy)
    const maxHoldSeconds = 30 * 60;

    for (const row of rows) {
        // Step 1: resolve active scan up to this candle's time
        if (activeScan !== null) {
            const result = resolveScan(activeScan, row.time, rawLtt, rawLtp, THRESHOLD, STOP_LOSS);
            if (result === 'good' || result === 'bad') {
                rows[activeScan.idx].label = result;
                activeScan = null;
            } else if (result === 'oscillating') {
                activeScan = null; // label stays null
            }
        }

        // Step 2: start new scan if signal and no active scan
        if (activeScan === null && row.direction !== null) {
            activeScan = {
                idx:         row.idx,
                direction:   row.direction,
                candleTime:  row.time,
                candleClose: row.close,
                scanEndTime: row.time + maxHoldSeconds,
            };
        }
    }

    // Print results table
    const indCols = INDICATORS.map(n => n.padStart(12)).join('  ');
    console.log(`${'idx'.padStart(4)}  ${'close'.padStart(8)}  ${indCols}  ${'direction'.padStart(10)}  ${'label'.padStart(10)}`);
    console.log('-'.repeat(4 + 2 + 8 + 2 + INDICATORS.length * 14 + 2 + 10 + 2 + 10));

    let goodCount = 0, badCount = 0, oscillatingCount = 0;
    for (const row of rows) {
        const sigCols = INDICATORS.map(n => (row.signals[n] ?? 'null').padStart(12)).join('  ');
        const dir     = (row.direction ?? 'null').padStart(10);
        const lbl     = (row.label ?? '-').padStart(10);
        console.log(`${String(row.idx).padStart(4)}  ${row.close.toFixed(2).padStart(8)}  ${sigCols}  ${dir}  ${lbl}`);
        if (row.label === 'good')       goodCount++;
        else if (row.label === 'bad')  badCount++;
        else if (row.direction !== null && row.label === null) oscillatingCount++;
    }

    const total = goodCount + badCount;
    const rate  = total > 0 ? (goodCount / total * 100).toFixed(1) : 'N/A';
    console.error(`\nResults: good=${goodCount} bad=${badCount} oscillating=${oscillatingCount} total=${total} success_rate=${rate}%`);

    // Optional CSV output
    if (OUTPUT_FILE) {
        const headers = ['idx', 'time', 'close', ...INDICATORS, 'direction', 'label'];
        const lines   = [headers.join(',')];
        for (const row of rows) {
            const vals = [
                row.idx, row.time, row.close.toFixed(2),
                ...INDICATORS.map(n => row.signals[n] ?? ''),
                row.direction ?? '',
                row.label ?? '',
            ];
            lines.push(vals.join(','));
        }
        fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
        console.error(`CSV written to ${OUTPUT_FILE}`);
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
