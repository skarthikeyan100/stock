// Backtest: iterate targetPriceDiff (1-30) x stopLossPriceDiff (5-30)
// Updates global settings + RateOfChangeStrategy in config.yml, runs server per combo.
// Usage: npx ts-node src/tools/backtest.ts
//    or: tsc && node dist/tools/backtest.js

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as http from 'http';

const BASE_CONFIG_PATH = path.join(__dirname, '../../config.yml');
const SERVER_READY = 'Icici server started';
const STATS_START = '=== BACKTEST STATS ===';
const BASE_PORT = 4000;
const CONCURRENCY = 10;

function buildConfig(targetPriceDiff: number, stopLossPriceDiff: number): any {
    const config: any = yaml.load(fs.readFileSync(BASE_CONFIG_PATH, 'utf8'));
    config.settings.targetPriceDiff = targetPriceDiff;
    config.settings.stopLossPriceDiff = stopLossPriceDiff;
    const roc = config.strategies?.find((s: any) => s.type === 'RateOfChangeStrategy');
    if (roc) {
        roc.targetPrice = targetPriceDiff;
        roc.stopLossPrice = stopLossPriceDiff;
    }
    return config;
}

function writeTempConfig(targetPriceDiff: number, stopLossPriceDiff: number, port: number): string {
    const tmpPath = path.join('/tmp', `backtest_config_${port}.yml`);
    const config = buildConfig(targetPriceDiff, stopLossPriceDiff);
    fs.writeFileSync(tmpPath, yaml.dump(config, { lineWidth: -1 }));
    return tmpPath;
}

function callConnect(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: 'localhost', port, path: '/connect', method: 'GET' },
            res => { res.resume(); resolve(res.statusCode ?? 0); }
        );
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('connect timeout')); });
        req.end();
    });
}

interface StatsResult {
    winRate: string | null;
    totalPnL: string | null;
    totalTrades: string | null;
}

// Strip log prefix like "[18:27:15] [Prism.exhausted] " from a line
const LOG_PREFIX = /^\[\d{2}:\d{2}:\d{2}\] \[.*?\] /;
const stripPrefix = (line: string) => line.replace(LOG_PREFIX, '').trim();

function parseStats(output: string): StatsResult {
    const lines = output.split('\n');
    const startIdx = lines.findIndex(l => l.includes(STATS_START));
    if (startIdx === -1) return { winRate: null, totalPnL: null, totalTrades: null };

    let headerLine: string | null = null;
    let dataLines: string[] = [];
    let sepCount = 0;
    let inTable = false;

    for (let i = startIdx; i < lines.length; i++) {
        const l = stripPrefix(lines[i]);
        if (!inTable && l.startsWith('+')) { inTable = true; sepCount++; continue; }
        if (!inTable) continue;
        if (l.startsWith('+')) { sepCount++; continue; }
        if (sepCount === 1 && !headerLine) { headerLine = l; continue; }
        if (sepCount >= 2) dataLines.push(l);
    }

    if (!headerLine) return { winRate: null, totalPnL: null, totalTrades: null };

    const parseCols = (line: string) => line.split('|').map(s => s.trim()).filter(s => s !== '');
    const headers = parseCols(headerLine);
    const winIdx = headers.findIndex(h => h === 'Win%');
    const pnlIdx = headers.findIndex(h => h.includes('P&L'));
    const tradesIdx = headers.findIndex(h => h.includes('Trade'));

    for (const line of dataLines) {
        const cols = parseCols(line);
        if (!cols.length) continue;
        if (cols[0]?.includes('RateOfChange')) {
            return {
                winRate: winIdx >= 0 ? cols[winIdx] : null,
                totalPnL: pnlIdx >= 0 ? cols[pnlIdx] : null,
                totalTrades: tradesIdx >= 0 ? cols[tradesIdx] : null,
            };
        }
    }

    // Debug: print the stats block so we can see what was captured
    const statsIdx = output.indexOf(STATS_START);
    if (statsIdx !== -1) {
        console.log('[debug] STATS block found but RateOfChange row not matched. Full block:');
        console.log(output.slice(statsIdx));
        console.log('[debug] headers:', headers);
        console.log('[debug] dataLines:', dataLines);
    } else {
        console.log('[debug] STATS block not found. Last 500 chars of output:');
        console.log(output.slice(-500));
    }

    return { winRate: null, totalPnL: null, totalTrades: null };
}

interface RunResult extends StatsResult {
    targetPriceDiff: number;
    stopLossPriceDiff: number;
}

function runServer(targetPriceDiff: number, stopLossPriceDiff: number, port: number): Promise<StatsResult> {
    return new Promise((resolve) => {
        const configPath = writeTempConfig(targetPriceDiff, stopLossPriceDiff, port);

        const proc = spawn('node', ['dist/server.js'], {
            cwd: path.join(__dirname, '../..'),
            env: { ...process.env, PORT: String(port), CONFIG_PATH: configPath, MOCK_BROKER: 'true', MOCK_QUOTES: 'true' },
        });

        let output = '';
        let serverReady = false;
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            proc.kill('SIGTERM');
            const stats = parseStats(output);
            console.log(`  → done: trades=${stats.totalTrades ?? 'N/A'} win=${stats.winRate ?? 'N/A'} pnl=${stats.totalPnL ?? 'N/A'}`);
            resolve(stats);
        };

        const onData = (chunk: Buffer) => {
            const text = chunk.toString();
            output += text;
            // process.stdout.write(text);

            if (!serverReady && text.includes(SERVER_READY)) {
                serverReady = true;
                // Retry /connect until it succeeds (server may not be accepting yet)
                const tryConnect = async (attempts = 0) => {
                    try {
                        await callConnect(port);
                    } catch (e: any) {
                        if (attempts < 10) setTimeout(() => tryConnect(attempts + 1), 500);
                        else console.log(`  [dbg] /connect failed after 10 attempts on port ${port}`);
                    }
                };
                setTimeout(() => tryConnect(), 300);
            }
        };

        // Poll every 10s: check if stats block is fully printed
        let lastOutputLen = 0;
        const poll = setInterval(() => {
            if (done) { clearInterval(poll); return; }

            const statsIdx = output.indexOf(STATS_START);
            if (statsIdx !== -1) {
                const block = output.slice(statsIdx);
                const seps = (block.match(/\+[-+]+\+/g) || []).length;
                // console.log(`  [dbg] poll: STATS found, separators=${seps}`);
                if (seps >= 3) {
                    clearInterval(poll);
                    finish();
                    return;
                }
            } else {
                // console.log(`  [dbg] poll: waiting for STATS (output=${output.length} chars)`);
            }

            // If no new output for 2 consecutive polls, server is stalled — give up
            if (output.length === lastOutputLen) {
                console.log(`  [dbg] poll: no new output, killing stalled server`);
                clearInterval(poll);
                finish();
                return;
            }
            lastOutputLen = output.length;
        }, 10_000);

        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', () => { clearInterval(poll); if (!done) { done = true; resolve(parseStats(output)); } });
        proc.on('exit', () => { clearInterval(poll); if (!done) { done = true; resolve(parseStats(output)); } });
    });
}

function printResultsTable(results: RunResult[]): void {
    results.sort((a, b) => {
        const wa = parseFloat(a.winRate ?? '') || -1;
        const wb = parseFloat(b.winRate ?? '') || -1;
        if (wb !== wa) return wb - wa;
        return (parseFloat(b.totalPnL ?? '') || 0) - (parseFloat(a.totalPnL ?? '') || 0);
    });

    const cols = ['Target', 'StopLoss', 'Trades', 'Win%', 'P&L'];
    const rows = results.map(r => [
        String(r.targetPriceDiff),
        String(r.stopLossPriceDiff),
        String(r.totalTrades ?? 'N/A'),
        r.winRate ?? 'N/A',
        String(r.totalPnL ?? 'N/A'),
    ]);

    const widths = cols.map((c, i) =>
        Math.max(c.length, ...rows.map(r => r[i].length))
    );
    const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    const fmt = (row: string[]) => '|' + row.map((v, i) => ` ${v.padEnd(widths[i])} `).join('|') + '|';

    const tableLines = [
        '\n=== BACKTEST RESULTS (sorted by Win%) ===',
        sep, fmt(cols), sep,
        ...rows.map(fmt),
        sep,
    ];

    tableLines.forEach(l => console.log(l));
    fs.writeFileSync(
        path.join(__dirname, '../../backtest_results.txt'),
        tableLines.join('\n')
    );
    console.log('\nResults saved to backtest_results.txt');
}

async function main(): Promise<void> {
    const targets = Array.from({ length: 30 }, (_, i) => i + 1);     // 1–30
    const stopLosses = Array.from({ length: 26 }, (_, i) => i + 5);  // 5–30
    const combinations: [number, number][] = targets.flatMap(t => stopLosses.map(sl => [t, sl] as [number, number]));
    const total = combinations.length;

    console.log(`Backtest: ${total} combinations, concurrency=${CONCURRENCY}\n`);

    const results: RunResult[] = [];
    let started = 0;
    let finished = 0;

    await new Promise<void>((resolveDone) => {
        function runNext() {
            while (started - finished < CONCURRENCY && started < total) {
                const [target, sl] = combinations[started];
                const port = BASE_PORT + (started % CONCURRENCY);
                const idx = ++started;
                console.log(`[${idx}/${total}] target=${target} stopLoss=${sl} port=${port} starting...`);

                runServer(target, sl, port).then(stats => {
                    finished++;
                    console.log(`[${finished}/${total}] target=${target} stopLoss=${sl} → trades=${stats.totalTrades ?? 'N/A'} win=${stats.winRate ?? 'N/A'} pnl=${stats.totalPnL ?? 'N/A'}`);
                    results.push({ targetPriceDiff: target, stopLossPriceDiff: sl, ...stats });
                    if (finished === total) resolveDone();
                    else runNext();
                }).catch((e: any) => {
                    finished++;
                    console.error(`[${finished}/${total}] target=${target} stopLoss=${sl} error: ${e.message}`);
                    results.push({ targetPriceDiff: target, stopLossPriceDiff: sl, winRate: null, totalPnL: null, totalTrades: null });
                    if (finished === total) resolveDone();
                    else runNext();
                });
            }
        }
        runNext();
    });

    printResultsTable(results);
}

main().catch(console.error);
