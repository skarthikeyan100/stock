/**
 * Gap-Screener Generate
 *
 * Runs the external Chartink-based screener project
 * (/home/karthikeyan/tools/ohlc/screener.ts, a separate, unrelated Node
 * project) and copies its output CSV into this project so
 * GapScreenerOptionQuote.ts (gapscreener:start) has a local
 * gap-screener.csv to read.
 *
 * Usage:
 *   npm run gapscreener:generate
 *
 * No CLI arguments — source/destination paths are fixed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SCREENER_PROJECT_DIR = '/home/karthikeyan/tools/ohlc';
const SCREENER_OUTPUT_CSV = path.join(SCREENER_PROJECT_DIR, 'gap-screener.csv');
// Anchored to process.cwd() (always the repo root - every gapscreener:*
// npm script, and both cron wrapper scripts, run from there), NOT __dirname:
// __dirname in compiled code is dist/tools/gapscreener/, which would put
// this CSV in the build-output tree instead of alongside its TS source.
const GAPSCREENER_DIR = path.join(process.cwd(), 'src', 'tools', 'gapscreener');
const LOCAL_OUTPUT_CSV = path.join(GAPSCREENER_DIR, 'gap-screener.csv');

async function main(): Promise<void> {
    console.log('=== Gap-Screener Generate ===');
    console.log(`Running screener in: ${SCREENER_PROJECT_DIR}`);
    execSync('npm start', { cwd: SCREENER_PROJECT_DIR, stdio: 'inherit' });

    if (!fs.existsSync(SCREENER_OUTPUT_CSV)) {
        throw new Error(`Screener did not produce ${SCREENER_OUTPUT_CSV}`);
    }

    fs.copyFileSync(SCREENER_OUTPUT_CSV, LOCAL_OUTPUT_CSV);
    console.log(`[gapScreenerGenerate] Copied ${SCREENER_OUTPUT_CSV} -> ${LOCAL_OUTPUT_CSV}`);
}

main()
    .catch((err) => {
        console.error('Fatal error:', err.message);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
