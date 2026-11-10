// Writes the sweep results: summary.md (read this first), rules.csv (one row per rule x interval at its best exit cell), trades-top.csv, run.json.
import * as fs from 'fs';
import * as path from 'path';
import { DayData, LOT_SIZE } from './data';
import { ExitCell } from './grid';
import { RuleRow, GATE } from './sweep';
import { Trade } from './engine';
import { VerifyResult } from './verify';

export interface ReportContext {
    outDir: string;
    startedAt: Date;
    runtimeSec: number;
    args: Record<string, string | number | boolean>;
    days: DayData[];
    dayMoves: { day: string; open: number; close: number; points: number }[];
    rulesCount: number;
    cells: ExitCell[];
    intervals: number[];
    rows: RuleRow[];           // all rule x interval rows, already ranked
    baselines: RuleRow[];      // always-CALL / always-PUT on the same candles and cells
    skipped: { ce: number; pe: number }[][]; // [interval index][day index]
    verified: { row: RuleRow; results: VerifyResult[] }[];
    topTrades: { row: RuleRow; trades: (Trade & { dayLabel?: string })[] } | null;
    costs: { costPerTrade: number; slippagePoints: number };
}

const f0 = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-IN') : 'n/a');
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const pf = (x: number | null) => (x === null ? 'n/a' : x === Infinity ? 'inf' : x.toFixed(2));

export function writeReport(ctx: ReportContext): void {
    fs.mkdirSync(ctx.outDir, { recursive: true });
    const D = ctx.days.length;
    const gateRows = ctx.rows.filter((r) => r.gate);
    const robustRows = ctx.rows.filter((r) => r.robust);
    const tests = ctx.rulesCount * ctx.intervals.length * ctx.cells.length;

    const md: string[] = [];
    md.push(`# RuleBasedStrategy backtest`);
    md.push('');
    md.push(`Run: ${ctx.startedAt.toISOString()} (${ctx.runtimeSec.toFixed(0)} s). Output: \`${ctx.outDir}\``);
    md.push('');
    md.push(`## Read this first`);
    md.push('');
    md.push(`- **Data is ${D} days only** (${ctx.days.map((d) => d.day).join(', ')}). Every number below describes these days; it is a shortlist to test further, not proof.`);
    const allUp = ctx.dayMoves.every((m) => m.points > 0);
    const allDown = ctx.dayMoves.every((m) => m.points < 0);
    if (allUp || allDown) {
        md.push(`- **One-directional regime:** NIFTY ${allUp ? 'rose' : 'fell'} on every day (${ctx.dayMoves.map((m) => `${m.day} ${m.points >= 0 ? '+' : ''}${m.points.toFixed(0)}`).join(', ')}). Rules that buy the favoured side look better than they are.`);
    }
    md.push(`- **Multiple testing:** ${f0(tests)} tests (${f0(ctx.rulesCount)} rules x ${ctx.intervals.length} intervals x ${ctx.cells.length} exit cells). Each rule's exit cell is chosen from ${ctx.cells.length} options, so the gate is optimistic. The leave-one-day-out column is the check against that.`);
    md.push(`- **Contracts:** the CSVs record a fixed set of strikes per day. A signal whose ATM strike is more than ${ctx.args.maxStrikeDistance} points from the nearest recorded strike of that side cannot be traded: it is dropped from P&L and from the trade count (the counts are in the coverage table below). The hit rate still counts it.`);
    md.push(`- **Costs:** ${ctx.costs.costPerTrade} rupees per trade and ${ctx.costs.slippagePoints} points of slippage per side. Lot size ${LOT_SIZE}.`);
    md.push('');
    md.push(`## Method`);
    md.push('');
    md.push(`- Candles: 10:00-15:00 IST entries only, from NIFTY ticks at ${ctx.intervals.map((s) => `${s / 60} min`).join(', ')} (the live builder is 5 min only; 15 and 30 min are the backtest's own builder with the same indicator code).`);
    md.push(`- Indicators restart each day from the first tick (same as after a live restart). Highs and lows are closes, as in the live builder.`);
    md.push(`- Signal: the same consensus as the live strategy (all agree, or majority with \`requireAll: false\`). One position per rule.`);
    md.push(`- Option P&L: buy the ATM CE on UP or PE on DOWN at the first option tick after the signal, exit by timeout, then target, then stop on each option tick (the live order of checks); at day end the last tick. P&L per trade = (exit - entry) x ${LOT_SIZE} less costs.`);
    md.push(`- Direction hit rate: a signal is a hit if NIFTY moves X points in the predicted direction before X points against it, before the day ends (X = 10, 15, 20).`);
    md.push(`- Best exit cell per rule: the cell with the best median total P&L over itself and its one-step neighbours, so a single lucky cell does not win.`);
    md.push(`- Gate ("consistent"): signals >= ${GATE.minSignals} and hit rate at ${GATE.hitX} points > ${Math.round(GATE.minHitRate * 1000) / 10}%; trades >= ${GATE.minTrades}; net P&L > 0; positive on >= ${Math.ceil(D * GATE.minDaysFraction)} of ${D} days; profit factor > ${GATE.minProfitFactor}.`);
    md.push(`- Robust = gate passed AND leave-one-day-out net > 0 (the best exit on the other days, scored on the day left out).`);
    md.push('');
    md.push(`## Data coverage`);
    md.push('');
    md.push(`| Day | NIFTY open | NIFTY close | Move (pts) | NIFTY ticks | Option ticks | Skipped NaN option ticks | Strikes CE | Strikes PE | Untradable signal candles (CE / PE), per interval |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|`);
    ctx.days.forEach((d, i) => {
        const m = ctx.dayMoves[i];
        const skips = ctx.intervals.map((iv, k) => `${iv / 60}m ${ctx.skipped[k][i].ce} / ${ctx.skipped[k][i].pe}`).join('; ');
        md.push(`| ${d.day} | ${m.open.toFixed(2)} | ${m.close.toFixed(2)} | ${m.points >= 0 ? '+' : ''}${m.points.toFixed(0)} | ${f0(d.rawNiftyRows)} | ${f0(d.rawOptionRows)} | ${f0(d.skippedOptionTicks)} | ${d.strikes.CE.length ? `${d.strikes.CE[0]}-${d.strikes.CE[d.strikes.CE.length - 1]}` : '-'} | ${d.strikes.PE.length ? `${d.strikes.PE[0]}-${d.strikes.PE[d.strikes.PE.length - 1]}` : '-'} | ${skips} |`);
    });
    md.push('');
    md.push(`## Results by interval`);
    md.push('');
    md.push(`| Interval | Rules x cells tested | Pass the gate | Robust (gate + leave-one-day-out > 0) | Robust rules with net above always-CALL | Mean 15-pt hit rate: robust rules / always-CALL |`);
    md.push(`|---|---|---|---|---|---|`);
    for (const iv of ctx.intervals) {
        const rs = ctx.rows.filter((r) => r.interval === iv);
        const robust = rs.filter((r) => r.robust);
        const call = ctx.baselines.find((b) => b.interval === iv && b.id.includes('CALL'));
        const hits = robust.map((r) => r.hitRate[GATE.hitX]).filter((x): x is number => x !== null);
        const meanHit = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : null;
        const beat = call ? robust.filter((r) => r.best.net > call.best.net).length : 0;
        md.push(`| ${iv / 60} min | ${f0(rs.length)} rules x ${ctx.cells.length} cells | ${f0(rs.filter((r) => r.gate).length)} | ${f0(robust.length)} | ${f0(beat)} of ${f0(robust.length)} (always-CALL net ${call ? f0(call.best.net) : 'n/a'}) | ${pct(meanHit)} / ${pct(call?.hitRate[GATE.hitX] ?? null)} |`);
    }
    md.push('');
    md.push(`A rule that makes less than always-CALL on the same candles in this sample is not showing an edge: the sample's direction is the explanation.`);
    md.push('');
    const table = (title: string, rows: RuleRow[], limit: number) => {
        md.push(`## ${title}`);
        md.push('');
        if (rows.length === 0) { md.push('None.'); md.push(''); return; }
        md.push(`| # | Rule | Interval | Signals | Hit 10/15/20 | Trades | Win % | Net P&L | PF | Days + | Max DD | Best exit cell | LODO net | Gate | Robust |`);
        md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
        rows.slice(0, limit).forEach((r, i) => {
            const winPct = r.best.trades ? r.best.wins / r.best.trades : null;
            md.push(`| ${i + 1} | ${r.id} | ${r.interval / 60}m | ${r.signals} | ${pct(r.hitRate[10])} / ${pct(r.hitRate[15])} / ${pct(r.hitRate[20])} | ${r.best.trades} | ${pct(winPct)} | ${f0(r.best.net)} | ${pf(r.profitFactor)} | ${r.daysPositive}/${D} | ${f0(r.maxDrawdown)} | ${r.bestLabel} | ${f0(r.lodoNet)} | ${r.gate ? 'yes' : 'no'} | ${r.robust ? 'yes' : 'no'} |`);
        });
        md.push('');
    };
    md.push(`## Baselines: the same direction on every candle, no indicator`);
    md.push('');
    md.push(`A rule should beat these on the same days. If a baseline passes the gate, the market direction alone explains the result.`);
    md.push('');
    md.push(`| Baseline | Interval | Trades | Win % | Net P&L | PF | Days + | Best exit cell | Gate | Robust |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const b of ctx.baselines) {
        const winPct = b.best.trades ? b.best.wins / b.best.trades : null;
        md.push(`| ${b.id} | ${b.interval / 60}m | ${b.best.trades} | ${pct(winPct)} | ${f0(b.best.net)} | ${pf(b.profitFactor)} | ${b.daysPositive}/${D} | ${b.bestLabel} | ${b.gate ? 'yes' : 'no'} | ${b.robust ? 'yes' : 'no'} |`);
    }
    md.push('');
    table('Robust rules (gate passed and leave-one-day-out net > 0)', robustRows, 50);
    table('Rules that pass the gate', gateRows.filter((r) => !r.robust), 50);
    table('Top 30 by ranking (days positive, hit rate, net, drawdown), whether or not they pass', ctx.rows, 30);

    md.push(`## Verification against the real RuleBasedStrategy`);
    md.push('');
    md.push(`The top rules above were replayed through the real \`RuleBasedStrategy\` class (order client stubbed, \`Date.now\` = tick time) and their trades compared with the sweep engine's trades, day by day. Zero mismatches means the sweep and the live code agree.`);
    md.push('');
    if (ctx.verified.length === 0) md.push('Not run.');
    for (const v of ctx.verified) {
        const mism = v.results.reduce((a, r) => a + r.mismatches.length, 0);
        md.push(`- **${v.row.id} @ ${v.row.interval / 60}m, ${v.row.bestLabel}:** ${mism === 0 ? 'no mismatches' : `${mism} mismatches`} over ${v.results.length} days (real closed trades ${v.results.reduce((a, r) => a + r.real.length, 0)}, sweep trades ${v.results.reduce((a, r) => a + r.fast.length, 0)}).`);
        for (const r of v.results) for (const m of r.mismatches.slice(0, 3)) md.push(`  - ${r.day}: ${m}`);
    }
    md.push('');
    if (ctx.topTrades) {
        md.push(`## Trades of the top rule (${ctx.topTrades.row.id} @ ${ctx.topTrades.row.interval / 60}m, ${ctx.topTrades.row.bestLabel})`);
        md.push('');
        md.push(`Per day: ${ctx.topTrades.trades.length} trades in total are in \`trades-top.csv\`.`);
        md.push('');
    }

    fs.writeFileSync(path.join(ctx.outDir, 'summary.md'), md.join('\n') + '\n');

    const csv: string[] = [];
    csv.push(['rule_id', 'indicators', 'require_all', 'interval_s', 'signals', 'hit_rate_10', 'hit_rate_15', 'hit_rate_20', 'best_cell', 'trades', 'wins', 'net_pnl',
        'profit_factor', 'days_positive', 'max_drawdown', 'neighbourhood_median', 'lodo_net', 'lodo_positive_days', 'gate', 'robust', 'gate_failures',
        ...ctx.days.map((d) => `pnl_${d.day}`)].join(','));
    for (const r of ctx.rows) {
        csv.push([
            r.id, r.indicators.join('+'), r.requireAll, r.interval, r.signals,
            r.hitRate[10] ?? '', r.hitRate[15] ?? '', r.hitRate[20] ?? '', r.bestLabel.replace(/,/g, ';'), r.best.trades, r.best.wins,
            r.best.net.toFixed(2), r.profitFactor === null ? '' : r.profitFactor === Infinity ? 'inf' : r.profitFactor.toFixed(3),
            r.daysPositive, r.maxDrawdown.toFixed(2), r.neighbourhoodMedian.toFixed(2), r.lodoNet.toFixed(2), r.lodoPositiveDays,
            r.gate, r.robust, r.gateFailures.join('; ').replace(/,/g, ';'),
            ...r.best.dayNet.map((x) => x.toFixed(2)),
        ].join(','));
    }
    fs.writeFileSync(path.join(ctx.outDir, 'rules.csv'), csv.join('\n') + '\n');

    if (ctx.topTrades) {
        const t: string[] = ['day,contract,dir,signal_time_ms,entry_time_ms,entry_px,exit_time_ms,exit_px,reason,pnl_rupees'];
        for (const tr of ctx.topTrades.trades) {
            t.push([tr.dayLabel ?? '', tr.tsym, tr.dir === 1 ? 'CE' : 'PE', tr.signalLtt, tr.entryLtt, tr.entryPx, tr.exitLtt, tr.exitPx, tr.reason, tr.pnl.toFixed(2)].join(','));
        }
        fs.writeFileSync(path.join(ctx.outDir, 'trades-top.csv'), t.join('\n') + '\n');
    }

    fs.writeFileSync(path.join(ctx.outDir, 'run.json'), JSON.stringify({
        startedAt: ctx.startedAt.toISOString(), runtimeSec: ctx.runtimeSec, args: ctx.args, costs: ctx.costs, rules: ctx.rulesCount,
        intervals: ctx.intervals, cells: ctx.cells.length, gate: GATE,
        days: ctx.days.map((d) => ({ day: d.day, niftyRows: d.rawNiftyRows, optionRows: d.rawOptionRows, skippedOptionTicks: d.skippedOptionTicks, fileBytes: d.fileSizes })),
    }, null, 2) + '\n');
}
