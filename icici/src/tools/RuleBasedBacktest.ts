/**
 * RuleBasedStrategy backtest over the backup CSV days (default ~/later/data/backups/<Mon-DD>/csv).
 *
 *   npm run backtest:ruleBased -- [--allDays <dir>] [--intervals 300,900,1800] [--maxSize 2] [--verifyTop 5]
 *                                 [--costPerTrade 0] [--slippagePoints 0] [--maxStrikeDistance 100] [--out <dir>]
 *
 * Every rule of 1..maxSize indicators (from the 80 live names) x 3 candle intervals x 105 exit cells is scored. The top rules are then
 * replayed through the real RuleBasedStrategy class to check the sweep and the live code agree. Output: <out>/summary.md first.
 * Deterministic: the same inputs give the same files.
 */
import * as os from 'os';
import * as path from 'path';
import { getArg } from './backtestCsvUtils';
import { loadDays, pickContract, DayData } from './ruleBacktest/data';
import { allIndicatorNames, enumerateRules, exitCells, neighbourIndices, RuleSpec } from './ruleBacktest/grid';
import { buildIntervalDay, parseAll, ruleIndexes, rulesTrades, ruleDirections, IntervalDay, Trade } from './ruleBacktest/engine';
import { evaluateRule, compareRows, RuleRow } from './ruleBacktest/sweep';
import { verifyDay, VerifyResult } from './ruleBacktest/verify';
import { writeReport } from './ruleBacktest/report';

async function main(): Promise<void> {
    const startedAt = new Date();
    const t0 = process.hrtime.bigint();
    const allDays = getArg('allDays', path.join(os.homedir(), 'later', 'data', 'backups'));
    const intervals = getArg('intervals', '300,900,1800').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const maxSize = Number(getArg('maxSize', '2'));
    const verifyTop = Number(getArg('verifyTop', '5'));
    const costs = { costPerTrade: Number(getArg('costPerTrade', '0')), slippagePoints: Number(getArg('slippagePoints', '0')) };
    const maxStrikeDistance = Number(getArg('maxStrikeDistance', '100'));
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const outDir = getArg('out', path.join('backtest-results', `rulebased-${stamp}`));
    if (!(maxSize >= 1) || intervals.length === 0) throw new Error('--maxSize must be >= 1 and --intervals must list seconds');

    const log = (msg: string) => console.error(`[ruleBacktest ${((Number(process.hrtime.bigint() - t0)) / 1e9).toFixed(0)}s] ${msg}`);
    const days: DayData[] = loadDays(allDays);
    if (days.length === 0) throw new Error(`no backup days with Quote.csv and OptionQuote.csv under ${allDays}`);
    log(`days: ${days.map((d) => d.day).join(', ')}`);

    const names = allIndicatorNames();
    const parsed = parseAll(names);
    const nameIndex = new Map(names.map((n, i) => [n, i] as [string, number]));
    const rules: RuleSpec[] = enumerateRules(names, maxSize);
    const rulesById = new Map(rules.map((r) => [r.id, r] as [string, RuleSpec]));
    const cells = exitCells();
    const neighbours = neighbourIndices(cells);
    log(`${names.length} indicator names, ${rules.length} rules, ${cells.length} exit cells, intervals ${intervals.join(',')} s`);

    const idysByInterval = new Map<number, IntervalDay[]>();
    const rows: RuleRow[] = [];
    for (const iv of intervals) {
        const idys = days.map((d) => buildIntervalDay(d, iv, parsed, maxStrikeDistance));
        idysByInterval.set(iv, idys);
        log(`interval ${iv}s: candles per day ${idys.map((x) => x.ltt.length).join('/')}`);
        rules.forEach((rule, i) => {
            if (i > 0 && i % 500 === 0) log(`interval ${iv}s: ${i}/${rules.length} rules`);
            rows.push(evaluateRule(rule, ruleIndexes(rule, nameIndex), idys, cells, neighbours, costs));
        });
    }
    rows.sort(compareRows);
    // Baselines with no indicator: the same direction on every in-window candle. A rule has to do better than these on the same days.
    const baselines: RuleRow[] = [];
    for (const iv of intervals) {
        const idys = idysByInterval.get(iv)!;
        for (const dir of [1, -1] as const) {
            const spec: RuleSpec = { id: `BASELINE always ${dir === 1 ? 'CALL' : 'PUT'}|none`, indicators: [], requireAll: true };
            baselines.push(evaluateRule(spec, [], idys, cells, neighbours, costs, dir));
        }
    }
    log(`scored ${rows.length} rule x interval rows; gate passes ${rows.filter((r) => r.gate).length}, robust ${rows.filter((r) => r.robust).length}`);

    const verified: { row: RuleRow; results: VerifyResult[] }[] = [];
    for (const row of rows.slice(0, verifyTop)) {
        const rule = rulesById.get(row.id)!;
        const idys = idysByInterval.get(row.interval)!;
        const cell = cells[row.best.cellIndex];
        log(`verifying ${row.id} @ ${row.interval}s ${cell.label} through the real strategy`);
        const results: VerifyResult[] = [];
        for (let d = 0; d < days.length; d++) {
            results.push(await verifyDay(days[d], idys[d], [rule.indicators], rule.requireAll, ruleDirections(idys[d], ruleIndexes(rule, nameIndex), rule.requireAll), cell, costs, maxStrikeDistance));
        }
        verified.push({ row, results });
    }

    let topTrades: { row: RuleRow; trades: (Trade & { dayLabel?: string })[] } | null = null;
    if (rows.length > 0) {
        const top = rows[0];
        const rule = rulesById.get(top.id)!;
        const idys = idysByInterval.get(top.interval)!;
        const cell = cells[top.best.cellIndex];
        const trades: (Trade & { dayLabel?: string })[] = [];
        idys.forEach((idy, d) => {
            const dirs = ruleDirections(idy, ruleIndexes(rule, nameIndex), rule.requireAll);
            for (const t of rulesTrades(idy, dirs, cell, costs)) trades.push({ ...t, dayLabel: days[d].day });
        });
        topTrades = { row: top, trades };
    }

    const dayMoves = days.map((d) => {
        const open = d.nifty[0]?.ltp ?? 0;
        const close = d.nifty[d.nifty.length - 1]?.ltp ?? 0;
        return { day: d.day, open, close, points: close - open };
    });
    const runtimeSec = Number(process.hrtime.bigint() - t0) / 1e9;
    writeReport({
        outDir, startedAt, runtimeSec, args: { allDays, intervals: intervals.join(','), maxSize, verifyTop, maxStrikeDistance, costPerTrade: costs.costPerTrade, slippagePoints: costs.slippagePoints },
        days, dayMoves, rulesCount: rules.length, cells, intervals, rows, baselines, verified, topTrades, costs,
        skipped: intervals.map((iv) => idysByInterval.get(iv)!.map((x) => ({ ce: x.skippedCE, pe: x.skippedPE }))),
    });
    log(`report written to ${outDir}/summary.md`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
