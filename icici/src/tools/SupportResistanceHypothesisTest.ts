/**
 * Replays a day's NIFTY ticks (from a CSV export of the `Quote` collection)
 * through the dynamic support/resistance detector in ../lib/supportResistance.ts,
 * to validate the hypothesis that price consolidates into stable, holdable
 * ranges rather than whipsawing - and, for every breach, simulates buying the
 * option the breach implies (CE on a resistance breach, PE on a support
 * breach) to see whether a configured target is hit before a configured
 * stop-loss.
 *
 * Not wired into live trading - SupportResistanceStrategy still uses static
 * config.supportPrice/config.resistancePrice. This is a manual analysis tool
 * to run once a day's data has been collected.
 *
 * Usage:
 *   tsc && node ./dist/tools/SupportResistanceHypothesisTest.js --file /path/to/Quote.csv
 *
 * Options:
 *   --file    Path to a Quote.csv export (columns: _id,ltp,ltt,token,time,index) (required)
 *
 * All tuning values (confirmWindowMin, maxJump, maxRangeWidth, buffer, target,
 * stopLoss, csvOutput) live under the `srHypothesis:` block in config.yml
 * (or $CONFIG_PATH), not as CLI flags.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parse } from 'csv-parse/sync';
import { initSRState, processTick, SRConfig } from '../lib/supportResistance';

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

const FILE_PATH = getArg('file', '');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../config.yml');
const rawConfig = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;
const srConfig = rawConfig.srHypothesis;

const CONFIRM_WINDOW_MIN: number = srConfig.confirmWindowMin;
const MAX_JUMP: number = srConfig.maxJump;
const MAX_RANGE_WIDTH: number = srConfig.maxRangeWidth;
const BUFFER_POINTS: number = srConfig.buffer;
const TARGET_POINTS: number = srConfig.target;
const STOPLOSS_POINTS: number = srConfig.stopLoss;
const BREACH_BUFFER: number = srConfig.breachBuffer;
const BREACH_CONFIRM_SEC: number = srConfig.breachConfirmSec;
const HELD_MIN_SEC: number = srConfig.heldMinSec;
const HELD_MAX_SEC: number = srConfig.heldMaxSec;
const HELD_MIN_MS = HELD_MIN_SEC * 1000;
const HELD_MAX_MS = HELD_MAX_SEC * 1000;
const CSV_OUT: boolean = !!srConfig.csvOutput;

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
    heldMs: number | null;
}

interface TradeOutcome {
    direction: 'support' | 'resistance';
    entryPrice: number;
    entryAt: number;
    targetPrice: number;
    slPrice: number;
    outcome: 'TARGET' | 'STOPLOSS' | 'OPEN_EOD';
    hitAt: number | null;
    timeToHitMs: number | null;
    ups: number;
    downs: number;
    avgUpMove: number;
    avgDownMove: number;
    momentumConfirmed: boolean;
    magnitudeConfirmed: boolean;
    heldMs: number;
    heldConfirmed: boolean;
}

// Counts tick-to-tick up/down moves while a range was LOCKED (from the tick
// after it locked, through the breaching tick), and the average size of each,
// to check whether the breach direction agrees with the prevailing momentum
// during the lock - both by count and by typical move size.
function countUpsDowns(ticks: Tick[], range: RangeRecord): { ups: number; downs: number; avgUpMove: number; avgDownMove: number } {
    let ups = 0;
    let downs = 0;
    let upSum = 0;
    let downSum = 0;
    const end = range.breachIndex ?? ticks.length - 1;
    for (let i = range.lockIndex + 1; i <= end; i++) {
        const diff = ticks[i].ltp - ticks[i - 1].ltp;
        if (diff > 0) { ups++; upSum += diff; }
        else if (diff < 0) { downs++; downSum += -diff; }
    }
    return { ups, downs, avgUpMove: ups ? upSum / ups : 0, avgDownMove: downs ? downSum / downs : 0 };
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

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function loadNiftyTicks(filePath: string): Tick[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const records: any[] = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const ticks = records
        .filter(r => r.index === 'NIFTY')
        .map(r => ({ ltp: Number(r.ltp), ltt: Number(r.ltt) * 1000 }));
    ticks.sort((a, b) => a.ltt - b.ltt);
    return ticks;
}

function simulateTrade(ticks: Tick[], range: RangeRecord): TradeOutcome | null {
    if (range.direction !== 'support' && range.direction !== 'resistance') return null;
    if (range.breachIndex === null) return null;

    const entryTick = ticks[range.breachIndex];
    const entryPrice = entryTick.ltp;
    const entryAt = entryTick.ltt;
    const isResistance = range.direction === 'resistance';
    const targetPrice = isResistance ? entryPrice + TARGET_POINTS : entryPrice - TARGET_POINTS;
    const slPrice = isResistance ? entryPrice - STOPLOSS_POINTS : entryPrice + STOPLOSS_POINTS;

    const { ups, downs, avgUpMove, avgDownMove } = countUpsDowns(ticks, range);
    // Resistance breach implies an upward move (buy CE) - only trust it if up-ticks
    // outnumbered down-ticks while the range was locked, and vice versa for support.
    const momentumConfirmed = isResistance ? ups > downs : downs > ups;
    // Same idea but weighted by typical move size instead of raw tick count - a few
    // large up-moves can outweigh many small down-ticks (or vice versa).
    const magnitudeConfirmed = isResistance ? avgUpMove > avgDownMove : avgDownMove > avgUpMove;
    // How long the range held LOCKED before breaching - found (on 2026-08-19/20 data) that
    // breaches in a ~7-11min "sweet spot" won 5/5: too fast looks like a whipsaw, too slow
    // looks like an exhausted range. Bounds are tunable via heldMinSec/heldMaxSec so this can
    // be re-tested as more days are collected, rather than trusted outright.
    const heldMs = range.heldMs ?? (entryAt - range.lockedAt);
    const heldConfirmed = heldMs >= HELD_MIN_MS && heldMs <= HELD_MAX_MS;

    for (let i = range.breachIndex + 1; i < ticks.length; i++) {
        const t = ticks[i];
        const targetHit = isResistance ? t.ltp >= targetPrice : t.ltp <= targetPrice;
        const slHit = isResistance ? t.ltp <= slPrice : t.ltp >= slPrice;
        if (targetHit || slHit) {
            // If a single tick crosses both bounds at once, assume the worse outcome (stop-loss) -
            // we can't know the intra-tick path.
            const outcome: TradeOutcome['outcome'] = slHit ? 'STOPLOSS' : 'TARGET';
            return { direction: range.direction, entryPrice, entryAt, targetPrice, slPrice, outcome, hitAt: t.ltt, timeToHitMs: t.ltt - entryAt, ups, downs, avgUpMove, avgDownMove, momentumConfirmed, magnitudeConfirmed, heldMs, heldConfirmed };
        }
    }

    return { direction: range.direction, entryPrice, entryAt, targetPrice, slPrice, outcome: 'OPEN_EOD', hitAt: null, timeToHitMs: null, ups, downs, avgUpMove, avgDownMove, momentumConfirmed, magnitudeConfirmed, heldMs, heldConfirmed };
}

async function main() {
    if (!FILE_PATH) {
        console.error('Usage: node ./dist/tools/SupportResistanceHypothesisTest.js --file /path/to/Quote.csv');
        process.exit(1);
    }

    const ticks = loadNiftyTicks(FILE_PATH);
    const label = ticks.length ? new Date(ticks[0].ltt).toISOString().slice(0, 10) : 'unknown';
    console.error(`Loaded ${ticks.length} NIFTY ticks for ${label}`);
    if (ticks.length === 0) {
        console.error('No NIFTY rows found in file - aborting');
        process.exit(1);
    }

    const config: SRConfig = {
        confirmWindowMs: CONFIRM_WINDOW_MIN * 60_000,
        maxJump: MAX_JUMP,
        maxRangeWidth: MAX_RANGE_WIDTH,
        buffer: BUFFER_POINTS,
        breachBuffer: BREACH_BUFFER,
        breachConfirmMs: BREACH_CONFIRM_SEC * 1000,
    };
    console.error(`Config: confirmWindow=${CONFIRM_WINDOW_MIN}min maxJump=${MAX_JUMP} maxRangeWidth=${MAX_RANGE_WIDTH} buffer=${BUFFER_POINTS} target=${TARGET_POINTS} stopLoss=${STOPLOSS_POINTS} breachBuffer=${BREACH_BUFFER} breachConfirmSec=${BREACH_CONFIRM_SEC} heldMinSec=${HELD_MIN_SEC} heldMaxSec=${HELD_MAX_SEC}`);

    let state = initSRState();
    const ranges: RangeRecord[] = [];
    let current: RangeRecord | null = null;
    let lockedTicks = 0;

    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        const { state: nextState, event } = processTick(state, tick, config);
        state = nextState;
        if (state.phase === 'LOCKED') lockedTicks++;

        if (event.type === 'LOCKED') {
            current = { support: event.support, resistance: event.resistance, lockedAt: event.lockedAt, lockIndex: i, breachedAt: null, breachIndex: null, direction: null, heldMs: null };
            ranges.push(current);
        } else if (event.type === 'BREACH' && current) {
            current.breachedAt = event.ltt;
            current.breachIndex = i;
            current.direction = event.direction;
            current.heldMs = event.heldMs;
            current = null;
        }
    }

    if (current) {
        const lastTick = ticks[ticks.length - 1];
        current.direction = 'EOD';
        current.heldMs = lastTick.ltt - current.lockedAt;
    }

    console.log(`\n${'#'.padStart(3)}  ${'support'.padStart(9)}  ${'resistance'.padStart(10)}  ${'width'.padStart(6)}  ${'lockedAt'.padStart(8)}  ${'breach'.padStart(10)}  ${'held'.padStart(8)}`);
    console.log('-'.repeat(70));
    ranges.forEach((r, i) => {
        const width = round2(r.resistance - r.support);
        const breachStr = r.direction === 'EOD' ? 'held to EOD' : r.direction ?? '-';
        const heldStr = r.heldMs !== null ? fmtDuration(r.heldMs) : '-';
        console.log(
            `${String(i + 1).padStart(3)}  ${round2(r.support).toFixed(2).padStart(9)}  ${round2(r.resistance).toFixed(2).padStart(10)}  ${width.toFixed(2).padStart(6)}  ${fmtTime(r.lockedAt).padStart(8)}  ${breachStr.padStart(10)}  ${heldStr.padStart(8)}`
        );
    });

    const breached = ranges.filter(r => r.direction === 'support' || r.direction === 'resistance');
    const avgWidth = ranges.length ? round2(ranges.reduce((s, r) => s + (r.resistance - r.support), 0) / ranges.length) : 0;
    const avgHeldMs = breached.length ? breached.reduce((s, r) => s + (r.heldMs ?? 0), 0) / breached.length : 0;
    const supportBreaches = breached.filter(r => r.direction === 'support').length;
    const resistanceBreaches = breached.filter(r => r.direction === 'resistance').length;
    const dayMs = ticks[ticks.length - 1].ltt - ticks[0].ltt;
    const lockedPct = ticks.length ? round2((lockedTicks / ticks.length) * 100) : 0;

    console.log('\n--- summary ---');
    console.log(`ranges locked:        ${ranges.length}`);
    console.log(`avg width:            ${avgWidth}`);
    console.log(`avg hold duration:    ${breached.length ? fmtDuration(avgHeldMs) : 'n/a'} (excludes ranges held to EOD)`);
    console.log(`breaches - support:   ${supportBreaches}`);
    console.log(`breaches - resistance:${resistanceBreaches}`);
    console.log(`held to EOD:          ${ranges.length - breached.length}`);
    console.log(`% of day LOCKED:      ${lockedPct}%`);
    console.log(`day span:             ${fmtDuration(dayMs)}`);

    // --- Trade simulation: CE on resistance breach, PE on support breach ---
    const trades: TradeOutcome[] = breached
        .map(r => simulateTrade(ticks, r))
        .filter((t): t is TradeOutcome => t !== null);

    console.log(`\n${'#'.padStart(3)}  ${'side'.padStart(4)}  ${'entry'.padStart(9)}  ${'target'.padStart(9)}  ${'sl'.padStart(9)}  ${'outcome'.padStart(9)}  ${'timeToHit'.padStart(9)}  ${'ups'.padStart(4)}  ${'downs'.padStart(5)}  ${'avgUp'.padStart(6)}  ${'avgDown'.padStart(7)}  ${'momentum'.padStart(8)}  ${'magnitude'.padStart(9)}  ${'held'.padStart(8)}  ${'heldOK'.padStart(6)}`);
    console.log('-'.repeat(150));
    trades.forEach((t, i) => {
        const side = t.direction === 'resistance' ? 'CE' : 'PE';
        const timeStr = t.timeToHitMs !== null ? fmtDuration(t.timeToHitMs) : '-';
        const momentumStr = t.momentumConfirmed ? 'CONFIRM' : 'AGAINST';
        const magnitudeStr = t.magnitudeConfirmed ? 'CONFIRM' : 'AGAINST';
        const heldStr = t.heldConfirmed ? 'YES' : 'no';
        console.log(
            `${String(i + 1).padStart(3)}  ${side.padStart(4)}  ${round2(t.entryPrice).toFixed(2).padStart(9)}  ${round2(t.targetPrice).toFixed(2).padStart(9)}  ${round2(t.slPrice).toFixed(2).padStart(9)}  ${t.outcome.padStart(9)}  ${timeStr.padStart(9)}  ${String(t.ups).padStart(4)}  ${String(t.downs).padStart(5)}  ${round2(t.avgUpMove).toFixed(2).padStart(6)}  ${round2(t.avgDownMove).toFixed(2).padStart(7)}  ${momentumStr.padStart(8)}  ${magnitudeStr.padStart(9)}  ${fmtDuration(t.heldMs).padStart(8)}  ${heldStr.padStart(6)}`
        );
    });

    const targetHits = trades.filter(t => t.outcome === 'TARGET');
    const slHits = trades.filter(t => t.outcome === 'STOPLOSS');
    const openTrades = trades.filter(t => t.outcome === 'OPEN_EOD');
    const decided = targetHits.length + slHits.length;
    const winRate = decided ? round2((targetHits.length / decided) * 100) : 0;
    const avgTimeToTarget = targetHits.length ? targetHits.reduce((s, t) => s + (t.timeToHitMs ?? 0), 0) / targetHits.length : 0;
    const avgTimeToSl = slHits.length ? slHits.reduce((s, t) => s + (t.timeToHitMs ?? 0), 0) / slHits.length : 0;

    console.log('\n--- trade summary ---');
    console.log(`total trades:         ${trades.length}`);
    console.log(`target hits:          ${targetHits.length}`);
    console.log(`stop-loss hits:       ${slHits.length}`);
    console.log(`open at EOD:          ${openTrades.length}`);
    console.log(`win rate:             ${decided ? winRate + '%' : 'n/a'} (of decided trades)`);
    console.log(`avg time to target:   ${targetHits.length ? fmtDuration(avgTimeToTarget) : 'n/a'}`);
    console.log(`avg time to stoploss: ${slHits.length ? fmtDuration(avgTimeToSl) : 'n/a'}`);

    // --- Momentum-confirmed subset: only trades where up/down tick counts while
    // LOCKED agreed with the breach direction (downs>ups for support, ups>downs for resistance) ---
    const confirmedTrades = trades.filter(t => t.momentumConfirmed);
    const confirmedDecided = confirmedTrades.filter(t => t.outcome !== 'OPEN_EOD');
    const confirmedTargetHits = confirmedTrades.filter(t => t.outcome === 'TARGET');
    const confirmedWinRate = confirmedDecided.length ? round2((confirmedTargetHits.length / confirmedDecided.length) * 100) : 0;

    console.log('\n--- momentum-confirmed subset (downs>ups on support breach, ups>downs on resistance breach) ---');
    console.log(`confirmed trades:     ${confirmedTrades.length} / ${trades.length}`);
    console.log(`win rate (confirmed): ${confirmedDecided.length ? confirmedWinRate + '%' : 'n/a'} (of ${confirmedDecided.length} decided)`);

    // --- Magnitude-confirmed subset: same idea, but weighted by avg move size instead
    // of raw tick count (a few big moves can outweigh many small ticks the other way) ---
    const magConfirmedTrades = trades.filter(t => t.magnitudeConfirmed);
    const magConfirmedDecided = magConfirmedTrades.filter(t => t.outcome !== 'OPEN_EOD');
    const magConfirmedTargetHits = magConfirmedTrades.filter(t => t.outcome === 'TARGET');
    const magConfirmedWinRate = magConfirmedDecided.length ? round2((magConfirmedTargetHits.length / magConfirmedDecided.length) * 100) : 0;

    console.log('\n--- magnitude-confirmed subset (avgDownMove>avgUpMove on support breach, avgUpMove>avgDownMove on resistance breach) ---');
    console.log(`confirmed trades:     ${magConfirmedTrades.length} / ${trades.length}`);
    console.log(`win rate (confirmed): ${magConfirmedDecided.length ? magConfirmedWinRate + '%' : 'n/a'} (of ${magConfirmedDecided.length} decided)`);

    // --- Held-duration-confirmed subset: only trades where the range held LOCKED for
    // between heldMinSec and heldMaxSec before breaching (found 5/5 wins in this window
    // on 2026-08-19/20 - re-test as more days are added, don't trust outright) ---
    const heldConfirmedTrades = trades.filter(t => t.heldConfirmed);
    const heldConfirmedDecided = heldConfirmedTrades.filter(t => t.outcome !== 'OPEN_EOD');
    const heldConfirmedTargetHits = heldConfirmedTrades.filter(t => t.outcome === 'TARGET');
    const heldConfirmedWinRate = heldConfirmedDecided.length ? round2((heldConfirmedTargetHits.length / heldConfirmedDecided.length) * 100) : 0;

    console.log(`\n--- held-duration-confirmed subset (${HELD_MIN_SEC}s <= heldMs <= ${HELD_MAX_SEC}s) ---`);
    console.log(`confirmed trades:     ${heldConfirmedTrades.length} / ${trades.length}`);
    console.log(`win rate (confirmed): ${heldConfirmedDecided.length ? heldConfirmedWinRate + '%' : 'n/a'} (of ${heldConfirmedDecided.length} decided)`);

    if (CSV_OUT) {
        const outDir = path.join(__dirname, '../../analysis/output');
        fs.mkdirSync(outDir, { recursive: true });

        const rangesPath = path.join(outDir, `sr_hypothesis_${label}.csv`);
        const rangeLines = ['support,resistance,width,lockedAt,breach,heldMs'];
        for (const r of ranges) {
            rangeLines.push(`${round2(r.support)},${round2(r.resistance)},${round2(r.resistance - r.support)},${fmtTime(r.lockedAt)},${r.direction ?? ''},${r.heldMs ?? ''}`);
        }
        fs.writeFileSync(rangesPath, rangeLines.join('\n') + '\n');
        console.error(`Wrote ${rangesPath}`);

        const tradesPath = path.join(outDir, `sr_trades_${label}.csv`);
        const tradeLines = ['side,entryPrice,targetPrice,slPrice,outcome,timeToHitMs,ups,downs,avgUpMove,avgDownMove,momentumConfirmed,magnitudeConfirmed,heldMs,heldConfirmed'];
        for (const t of trades) {
            const side = t.direction === 'resistance' ? 'CE' : 'PE';
            tradeLines.push(`${side},${round2(t.entryPrice)},${round2(t.targetPrice)},${round2(t.slPrice)},${t.outcome},${t.timeToHitMs ?? ''},${t.ups},${t.downs},${round2(t.avgUpMove)},${round2(t.avgDownMove)},${t.momentumConfirmed},${t.magnitudeConfirmed},${t.heldMs},${t.heldConfirmed}`);
        }
        fs.writeFileSync(tradesPath, tradeLines.join('\n') + '\n');
        console.error(`Wrote ${tradesPath}`);
    }

    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
