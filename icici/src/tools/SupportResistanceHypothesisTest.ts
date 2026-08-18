/**
 * Replays a day's NIFTY ticks (from the `Quote` collection, populated by the
 * external Data project) through the dynamic support/resistance detector in
 * ../lib/supportResistance.ts, to validate the hypothesis that price
 * consolidates into stable, holdable ranges rather than whipsawing.
 *
 * Not wired into live trading - SupportResistanceStrategy still uses static
 * config.supportPrice/config.resistancePrice. This is a manual analysis tool
 * to run once a day's data has been collected.
 *
 * Usage:
 *   npm run sr:hypothesis -- --date 2026-08-18
 *
 * Options:
 *   --date              Target day, YYYY-MM-DD (required)
 *   --confirmWindowMin  Consolidation window in minutes (default: 2)
 *   --maxJump           Max tick-to-tick delta before restarting the window, in points (default: 15)
 *   --maxRangeWidth     Max (max-min) within the window to count as consolidating, in points (default: 30)
 *   --buffer            Points added outside observed min/max when locking (default: 10)
 *   --csv               Also write the per-range table to analysis/output/sr_hypothesis_<date>.csv
 */
import * as fs from 'fs';
import * as path from 'path';
import Mongo from './mongo';
import { initSRState, processTick, SRConfig } from '../lib/supportResistance';

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const DATE = getArg('date', '');
const CONFIRM_WINDOW_MIN = parseFloat(getArg('confirmWindowMin', '2'));
const MAX_JUMP = parseFloat(getArg('maxJump', '15'));
const MAX_RANGE_WIDTH = parseFloat(getArg('maxRangeWidth', '30'));
const BUFFER_POINTS = parseFloat(getArg('buffer', '10'));
const CSV_OUT = hasFlag('csv');

interface RangeRecord {
    support: number;
    resistance: number;
    lockedAt: number;
    breachedAt: number | null;
    direction: 'support' | 'resistance' | 'EOD' | null;
    heldMs: number | null;
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

async function main() {
    if (!DATE) {
        console.error('Usage: npm run sr:hypothesis -- --date YYYY-MM-DD [--confirmWindowMin N] [--maxJump N] [--maxRangeWidth N] [--buffer N] [--csv]');
        process.exit(1);
    }

    await Mongo.init();
    const db = Mongo.getInstance().db;

    const query = { index: 'NIFTY', $or: [{ date: DATE }, { time: { $regex: `^${DATE}` } }] };
    const rawQuotes = await db.collection('Quote').find(query).sort({ ltt: 1 }).toArray();
    console.error(`Loaded ${rawQuotes.length} NIFTY ticks for ${DATE}`);
    if (rawQuotes.length === 0) {
        console.error('No data for that date - aborting');
        process.exit(1);
    }

    const config: SRConfig = {
        confirmWindowMs: CONFIRM_WINDOW_MIN * 60_000,
        maxJump: MAX_JUMP,
        maxRangeWidth: MAX_RANGE_WIDTH,
        buffer: BUFFER_POINTS,
    };
    console.error(`Config: confirmWindow=${CONFIRM_WINDOW_MIN}min maxJump=${MAX_JUMP} maxRangeWidth=${MAX_RANGE_WIDTH} buffer=${BUFFER_POINTS}`);

    let state = initSRState();
    const ranges: RangeRecord[] = [];
    let current: RangeRecord | null = null;
    let lockedTicks = 0;

    for (const q of rawQuotes) {
        const ltt = Number(q.ltt) * 1000;
        const { state: nextState, event } = processTick(state, { ltp: Number(q.ltp), ltt }, config);
        state = nextState;
        if (state.phase === 'LOCKED') lockedTicks++;

        if (event.type === 'LOCKED') {
            current = { support: event.support, resistance: event.resistance, lockedAt: event.lockedAt, breachedAt: null, direction: null, heldMs: null };
            ranges.push(current);
        } else if (event.type === 'BREACH' && current) {
            current.breachedAt = event.ltt;
            current.direction = event.direction;
            current.heldMs = event.heldMs;
            current = null;
        }
    }

    if (current) {
        const lastTick = rawQuotes[rawQuotes.length - 1];
        current.direction = 'EOD';
        current.heldMs = Number(lastTick.ltt) * 1000 - current.lockedAt;
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
    const dayMs = (Number(rawQuotes[rawQuotes.length - 1].ltt) - Number(rawQuotes[0].ltt)) * 1000;
    const lockedPct = rawQuotes.length ? round2((lockedTicks / rawQuotes.length) * 100) : 0;

    console.log('\n--- summary ---');
    console.log(`ranges locked:        ${ranges.length}`);
    console.log(`avg width:            ${avgWidth}`);
    console.log(`avg hold duration:    ${breached.length ? fmtDuration(avgHeldMs) : 'n/a'} (excludes ranges held to EOD)`);
    console.log(`breaches - support:   ${supportBreaches}`);
    console.log(`breaches - resistance:${resistanceBreaches}`);
    console.log(`held to EOD:          ${ranges.length - breached.length}`);
    console.log(`% of day LOCKED:      ${lockedPct}%`);
    console.log(`day span:             ${fmtDuration(dayMs)}`);

    if (CSV_OUT) {
        const outDir = path.join(__dirname, '../../analysis/output');
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `sr_hypothesis_${DATE}.csv`);
        const lines = ['support,resistance,width,lockedAt,breach,heldMs'];
        for (const r of ranges) {
            lines.push(`${round2(r.support)},${round2(r.resistance)},${round2(r.resistance - r.support)},${fmtTime(r.lockedAt)},${r.direction ?? ''},${r.heldMs ?? ''}`);
        }
        fs.writeFileSync(outPath, lines.join('\n') + '\n');
        console.error(`Wrote ${outPath}`);
    }

    process.exit(0);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
