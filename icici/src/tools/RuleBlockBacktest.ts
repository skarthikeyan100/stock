/**
 * Backtest of ONE RuleBasedStrategy block as configured in config.yml: its rules (each line of `indicators`), combined the way the live
 * strategy combines them (any rule fires -> buy, rules that disagree on a candle -> no trade), one position at a time, with the block's own
 * target / stopLoss / maxHoldTimeMinutes. It also scores the block over every exit cell and replays it through the real RuleBasedStrategy.
 *
 *   npm run backtest:ruleBlock -- [--allDays <dir>] [--userId RuleBased] [--costPerTrade 0] [--slippagePoints 0]
 *                                 [--maxStrikeDistance 100] [--out <dir>]
 *
 * Output: <out>/summary.md (read first), <out>/trades.csv (the configured exits, every trade with the rules that fired).
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getArg } from './backtestCsvUtils';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import { exitRulesFrom, ExitRule, timeoutFrom } from '../strategy/exitRules';
import { parseRuleLines, parseRuleIndicator } from '../strategy/ruleIndicators';
import { loadDays, DayData, LOT_SIZE } from './ruleBacktest/data';
import { allIndicatorNames, exitCells, neighbourIndices, ExitCell, TargetSpec, StopSpec } from './ruleBacktest/grid';
import { buildIntervalDay, parseAll, rulesTrades, blockDirections, ruleDirections, directionStats, IntervalDay, Trade, Costs, DIRECTION_XS } from './ruleBacktest/engine';
import { evaluateRule, RuleRow, GATE } from './ruleBacktest/sweep';
import { verifyDay, VerifyResult } from './ruleBacktest/verify';

const INTERVAL = 300; // the live strategy builds 5-minute candles only

function toSpec(rule: ExitRule | null): TargetSpec {
    if (!rule) return { kind: 'none' };
    return rule.kind === 'points' ? { kind: 'points', value: rule.value } : { kind: 'percent', value: rule.value };
}

function labelOf(spec: TargetSpec | StopSpec): string {
    if (spec.kind === 'none') return 'none';
    return spec.kind === 'points' ? `${spec.value}pt` : `${spec.value}%`;
}

interface Summary {
    trades: number; wins: number; winPct: number | null; net: number; grossProfit: number; grossLoss: number;
    profitFactor: number | null; dayNet: number[]; daysPositive: number; maxDrawdown: number;
}

function summarize(tradesByDay: Trade[][]): Summary {
    let n = 0;
    let wins = 0;
    let gp = 0;
    let gl = 0;
    const seq: number[] = [];
    const dayNet = tradesByDay.map((ts) => ts.reduce((a, t) => a + t.pnl, 0));
    for (const ts of tradesByDay) {
        for (const t of ts) {
            n++;
            if (t.pnl > 0) { wins++; gp += t.pnl; } else if (t.pnl < 0) gl += -t.pnl;
            seq.push(t.pnl);
        }
    }
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const p of seq) {
        cum += p;
        if (cum > peak) peak = cum;
        if (peak - cum > dd) dd = peak - cum;
    }
    return {
        trades: n, wins, winPct: n ? wins / n : null, net: dayNet.reduce((a, b) => a + b, 0), grossProfit: gp, grossLoss: gl,
        profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, dayNet, daysPositive: dayNet.filter((x) => x > 0).length, maxDrawdown: dd,
    };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const pf = (x: number | null) => (x === null ? 'n/a' : x === Infinity ? 'inf' : x.toFixed(2));
const f0 = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : 'n/a');

async function main(): Promise<void> {
    const startedAt = new Date();
    const allDays = getArg('allDays', path.join(os.homedir(), 'later', 'data', 'backups'));
    const costs: Costs = { costPerTrade: Number(getArg('costPerTrade', '0')), slippagePoints: Number(getArg('slippagePoints', '0')) };
    const maxStrikeDistance = Number(getArg('maxStrikeDistance', '100'));
    const userId = getArg('userId', '');
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const outDir = getArg('out', path.join('backtest-results', `ruleblock-${stamp}`));

    // --- the block, as configured ---
    const config = configService.getConfig();
    const blocks = (config.strategies || []).filter((s: any) => s.type === 'RuleBasedStrategy' && (!userId || s.userId === userId));
    if (blocks.length === 0) throw new Error(userId ? `no RuleBasedStrategy block with userId ${userId}` : 'no RuleBasedStrategy block in config.yml');
    if (blocks.length > 1) console.error(`[ruleBlock] ${blocks.length} RuleBased blocks; using the first (pass --userId to choose)`);
    const block: any = blocks[0];
    const settings = (config.settings || {}) as Record<string, any>;
    const lines = parseRuleLines(block.indicators);
    if (lines.length === 0) throw new Error('the block has no rules');
    const requireAll = block.requireAllIndicators !== false;
    const exits = exitRulesFrom(settingFor(block, settings, 'target'), settingFor(block, settings, 'stopLoss'), 'RuleBased block');
    const maxHoldMin = timeoutFrom(settingFor(block, settings, 'maxHoldTimeMinutes'), 'RuleBased block');
    const maxHold = maxHoldMin ?? Infinity; // Infinity = no timeout
    const configuredCell: ExitCell = {
        index: -1,
        label: `T=${exits.target ? labelOf(toSpec(exits.target)) : 'none'} S=${exits.stop ? labelOf(toSpec(exits.stop)) : 'none'} M=${maxHoldMin ?? 'none'}${maxHoldMin === null ? '' : 'm'}`,
        target: toSpec(exits.target), stop: toSpec(exits.stop), timeoutMinutes: maxHold, ti: -1, si: -1, mi: -1,
    };

    // --- data and signals ---
    const names = allIndicatorNames();
    const nameIndex = new Map(names.map((n, i) => [n, i] as [string, number]));
    const parsed = parseAll(names);
    const ruleIdx = lines.map((l) => l.map((n) => {
        parseRuleIndicator(n); // throws with the reason if the name is not computed live
        const i = nameIndex.get(n);
        if (i === undefined) throw new Error(`indicator ${n} is not in the search space`);
        return i;
    }));

    const days: DayData[] = loadDays(allDays);
    if (days.length === 0) throw new Error(`no backup days under ${allDays}`);
    const idys: IntervalDay[] = days.map((d) => buildIntervalDay(d, INTERVAL, parsed, maxStrikeDistance));
    const block_ = days.map((_, d) => blockDirections(idys[d], ruleIdx, requireAll));
    const dirs = block_.map((b) => b.dirs);
    const dirOf = new Map(idys.map((x, i) => [x, dirs[i]] as [IntervalDay, Int8Array]));

    // --- the configured exits, all days ---
    const tradesByDay = idys.map((idy, d) => rulesTrades(idy, dirs[d], configuredCell, costs));
    const s = summarize(tradesByDay);
    const dirStatsByDay = idys.map((idy, d) => directionStats(idy, dirs[d]));
    const sumHits: Record<number, { h: number; m: number }> = {};
    let signals = 0;
    for (const X of DIRECTION_XS) sumHits[X] = { h: 0, m: 0 };
    for (const ds of dirStatsByDay) {
        signals += ds.signals;
        for (const X of DIRECTION_XS) { sumHits[X].h += ds.hits[X]; sumHits[X].m += ds.misses[X]; }
    }
    const conflicts = block_.reduce((a, b) => a + b.conflicts, 0);
    const baseCall = summarize(idys.map((idy) => rulesTrades(idy, new Int8Array(idy.ltt.length).fill(1), configuredCell, costs)));
    const basePut = summarize(idys.map((idy) => rulesTrades(idy, new Int8Array(idy.ltt.length).fill(-1), configuredCell, costs)));

    // --- every exit cell ---
    const cells = exitCells();
    const neigh = neighbourIndices(cells);
    const blockSpec = { id: 'BLOCK', indicators: lines.flat(), requireAll };
    const grid: RuleRow = evaluateRule(blockSpec, [], idys, cells, neigh, costs, undefined, (idy) => dirOf.get(idy)!);

    // --- rules individually: how often each fires in the window ---
    const ruleStats = lines.map((names_, r) => {
        let fires = 0;
        let up = 0;
        let down = 0;
        idys.forEach((idy) => {
            const rd = ruleDirections(idy, ruleIdx[r], requireAll);
            for (let c = 0; c < rd.length; c++) {
                if (!idy.inWindow[c] || rd[c] === 0) continue;
                fires++;
                if (rd[c] === 1) up++; else down++;
            }
        });
        return { label: names_.join(', '), fires, up, down };
    });

    // --- the real strategy, same exits, all days ---
    const verified: VerifyResult[] = [];
    for (let d = 0; d < days.length; d++) {
        verified.push(await verifyDay(days[d], idys[d], lines, requireAll, dirs[d], configuredCell, costs, maxStrikeDistance));
    }
    const mismatches = verified.reduce((a, v) => a + v.mismatches.length, 0);

    // --- outputs ---
    fs.mkdirSync(outDir, { recursive: true });
    const tradeRows: string[] = ['day,contract,dir,signal_time_ms,entry_time_ms,entry_px,exit_time_ms,exit_px,reason,pnl_rupees,rules_fired_at_signal'];
    idys.forEach((idy, d) => {
        const c_ = new Map<number, number>();
        idy.ltt.forEach((t, c) => c_.set(t, c));
        for (const t of tradesByDay[d]) {
            const c = c_.get(t.signalLtt);
            const fired = c === undefined ? '' : lines.filter((_, r) => ruleDirections(idy, ruleIdx[r], requireAll)[c] === t.dir).map((l) => l.join('+')).join(' | ');
            tradeRows.push([days[d].day, t.tsym, t.dir === 1 ? 'CE' : 'PE', t.signalLtt, t.entryLtt, t.entryPx, t.exitLtt, t.exitPx, t.reason, t.pnl.toFixed(2), `"${fired}"`].join(','));
        }
    });
    fs.writeFileSync(path.join(outDir, 'trades.csv'), tradeRows.join('\n') + '\n');

    const md: string[] = [];
    md.push(`# RuleBasedStrategy block backtest`);
    md.push('');
    md.push(`Run: ${startedAt.toISOString()}. Days: ${days.map((d) => d.day).join(', ')} (${days.length}). Output: \`${outDir}\``);
    md.push('');
    md.push(`## The block as configured`);
    md.push('');
    md.push(`| Rule | Indicators must agree |`);
    md.push(`|---|---|`);
    lines.forEach((l) => md.push(`| ${l.join(' + ')} | ${requireAll ? 'all' : 'majority'} |`));
    md.push('');
    md.push(`Exits: ${configuredCell.label} (block values; settings fill any missing). Quantity ${LOT_SIZE}. Costs: ${costs.costPerTrade} rupees per trade, ${costs.slippagePoints} points per side.`);
    md.push('');
    md.push(`## Result with the configured exits (${configuredCell.label})`);
    md.push('');
    md.push(`| | Block | Always CALL | Always PUT |`);
    md.push(`|---|---|---|---|`);
    md.push(`| Trades | ${s.trades} | ${baseCall.trades} | ${basePut.trades} |`);
    md.push(`| Win % | ${pct(s.winPct)} | ${pct(baseCall.winPct)} | ${pct(basePut.winPct)} |`);
    md.push(`| Net P&L (rupees) | ${f0(s.net)} | ${f0(baseCall.net)} | ${f0(basePut.net)} |`);
    md.push(`| Profit factor | ${pf(s.profitFactor)} | ${pf(baseCall.profitFactor)} | ${pf(basePut.profitFactor)} |`);
    md.push(`| Days positive | ${s.daysPositive}/${days.length} | ${baseCall.daysPositive}/${days.length} | ${basePut.daysPositive}/${days.length} |`);
    md.push(`| Max drawdown | ${f0(s.maxDrawdown)} | ${f0(baseCall.maxDrawdown)} | ${f0(basePut.maxDrawdown)} |`);
    md.push('');
    md.push(`Per day (block): ${days.map((d, i) => `${d.day} ${f0(s.dayNet[i])} (${tradesByDay[i].length} trades)`).join('; ')}.`);
    md.push('');
    md.push(`Signals: ${signals} in-window candles where the block gave a direction. Direction hit rate (NIFTY moves X points the predicted way first): ` +
        DIRECTION_XS.map((X) => `${X} pts ${pct(sumHits[X].h + sumHits[X].m ? sumHits[X].h / (sumHits[X].h + sumHits[X].m) : null)}`).join(', ') + '.');
    md.push('');
    md.push(`Conflicts: ${conflicts} in-window candles where rules said UP and DOWN together (no trade).`);
    md.push('');
    md.push(`## Each rule on its own (signals in the window)`);
    md.push('');
    md.push(`| Rule | Candles it fires | UP | DOWN |`);
    md.push(`|---|---|---|---|`);
    ruleStats.forEach((r) => md.push(`| ${r.label} | ${r.fires} | ${r.up} | ${r.down} |`));
    md.push('');
    md.push(`## Every exit cell for this block (the best one is chosen from the neighbourhood, as in the rule sweep)`);
    md.push('');
    md.push(`Best cell: **${grid.bestLabel}**: ${grid.best.trades} trades, net ${f0(grid.best.net)}, profit factor ${pf(grid.profitFactor)}, ${grid.daysPositive}/${days.length} days positive, max drawdown ${f0(grid.maxDrawdown)}, leave-one-day-out net ${f0(grid.lodoNet)}.`);
    md.push('');
    md.push(`Gate (${GATE.minSignals}+ signals, hit rate at ${GATE.hitX} pts above ${Math.round(GATE.minHitRate * 1000) / 10}%, 8+ trades, net > 0, positive on ${Math.ceil(days.length * GATE.minDaysFraction)}+ days, profit factor > ${GATE.minProfitFactor}): ${grid.gate ? 'PASS' : 'FAIL: ' + grid.gateFailures.join('; ')}.`);
    md.push('');
    md.push(`## Check against the real RuleBasedStrategy`);
    md.push('');
    md.push(mismatches === 0
        ? `No mismatches over ${days.length} days: the real strategy class takes the same trades as this backtest.`
        : `${mismatches} mismatches; first ones: ${verified.flatMap((v) => v.mismatches.map((m) => `${v.day}: ${m}`)).slice(0, 5).join(' | ')}`);
    md.push('');
    md.push(`## Limits`);
    md.push('');
    md.push(`- ${days.length} days, all rising (${days.map((d) => d.day).join(', ')}). Compare the block with always-CALL above before reading anything into it.`);
    md.push(`- Option prices are the recorded ticks; fills are at the first tick after the signal; no brokerage or slippage unless the flags are set.`);
    md.push(`- Only 5-minute candles, the interval the live strategy runs.`);
    fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n') + '\n');

    console.log(`Block: ${lines.length} rules, ${configuredCell.label}`);
    console.log(`Configured exits: ${s.trades} trades, net ${f0(s.net)}, PF ${pf(s.profitFactor)}, ${s.daysPositive}/${days.length} days positive`);
    console.log(`Always CALL: ${baseCall.trades} trades, net ${f0(baseCall.net)}; always PUT: ${basePut.trades} trades, net ${f0(basePut.net)}`);
    console.log(`Conflicts: ${conflicts}. Best exit cell over the grid: ${grid.bestLabel}, net ${f0(grid.best.net)}. Gate: ${grid.gate ? 'PASS' : 'FAIL'}`);
    console.log(`Real-strategy check: ${mismatches} mismatches`);
    console.log(`Report: ${path.join(outDir, 'summary.md')}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
