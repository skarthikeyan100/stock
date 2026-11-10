// Scores every rule x interval over every exit cell, picks the cell whose neighbourhood does best, and applies the consistency gate.
import { RuleSpec, ExitCell } from './grid';
import { IntervalDay, Costs, Trade, ruleDirections, rulesTrades, directionStats, DIRECTION_XS } from './engine';

export const GATE = {
    minSignals: 20,          // signals (firing candles in the window) needed for the direction hit rate to count
    minHitRate: 0.55,        // direction hit rate at X = 15 points
    hitX: 15,
    minTrades: 8,
    minProfitFactor: 1.2,
    minDaysFraction: 0.75,   // positive on at least this share of the days (4 days -> 3)
};

export interface CellStats {
    cellIndex: number;
    trades: number;
    wins: number;
    grossProfit: number;
    grossLoss: number;
    net: number;
    dayNet: number[];        // per day, in day order
    dayTrades: number[];
    seq: number[];           // trade P&L in time order across the days
}

export interface RuleRow {
    id: string;
    indicators: string[];
    requireAll: boolean;
    interval: number;
    signals: number;
    hitRate: Record<number, number | null>;
    hitCounts: Record<number, { hits: number; misses: number }>;
    best: CellStats;
    bestLabel: string;
    neighbourhoodMedian: number;
    daysPositive: number;
    profitFactor: number | null;
    maxDrawdown: number;
    lodoNet: number;
    lodoPositiveDays: number;
    lodoPicks: number[];
    gate: boolean;
    robust: boolean;         // gate passed and the leave-one-day-out net is positive
    gateFailures: string[];
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function emptyCell(cellIndex: number, days: number): CellStats {
    return { cellIndex, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, net: 0, dayNet: new Array(days).fill(0), dayTrades: new Array(days).fill(0), seq: [] };
}

function addTrade(cs: CellStats, dayIdx: number, t: Trade): void {
    cs.trades++;
    if (t.pnl > 0) { cs.wins++; cs.grossProfit += t.pnl; }
    else if (t.pnl < 0) cs.grossLoss += -t.pnl;
    cs.net += t.pnl;
    cs.dayNet[dayIdx] += t.pnl;
    cs.dayTrades[dayIdx]++;
    cs.seq.push(t.pnl);
}

function maxDrawdown(seq: number[]): number {
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const p of seq) {
        cum += p;
        if (cum > peak) peak = cum;
        if (peak - cum > dd) dd = peak - cum;
    }
    return dd;
}

// Leave-one-day-out: for each day, the cell with the best total over the OTHER days, scored on the day that was left out.
function leaveOneDayOut(cells: CellStats[], days: number): { net: number; positiveDays: number; picks: number[] } {
    let net = 0;
    let positiveDays = 0;
    const picks: number[] = [];
    for (let h = 0; h < days; h++) {
        let bestIdx = 0;
        let bestOther = -Infinity;
        cells.forEach((cs, i) => {
            let other = 0;
            for (let d = 0; d < days; d++) if (d !== h) other += cs.dayNet[d];
            if (other > bestOther) { bestOther = other; bestIdx = i; }
        });
        const score = cells[bestIdx].dayNet[h];
        picks.push(cells[bestIdx].cellIndex);
        net += score;
        if (score > 0) positiveDays++;
    }
    return { net, positiveDays, picks };
}

// Evaluates one rule on one interval over all days (days in the same order as the IntervalDay list).
// fixedDir: a baseline with no indicator, that takes the same direction on every candle (+1 always CALL, -1 always PUT).
export function evaluateRule(rule: RuleSpec, indexes: number[], days: IntervalDay[], cells: ExitCell[], neighbours: number[][], costs: Costs, fixedDir?: 1 | -1, dirsFn?: (idy: IntervalDay) => Int8Array): RuleRow {
    const D = days.length;
    const stats = cells.map((c) => emptyCell(c.index, D));
    let signals = 0;
    const hitCounts: Record<number, { hits: number; misses: number }> = {};
    for (const X of DIRECTION_XS) hitCounts[X] = { hits: 0, misses: 0 };

    days.forEach((idy, d) => {
        const dirs = dirsFn ? dirsFn(idy) : fixedDir !== undefined ? new Int8Array(idy.ltt.length).fill(fixedDir) : ruleDirections(idy, indexes, rule.requireAll);
        const ds = directionStats(idy, dirs);
        signals += ds.signals;
        for (const X of DIRECTION_XS) {
            hitCounts[X].hits += ds.hits[X];
            hitCounts[X].misses += ds.misses[X];
        }
        for (const cell of cells) {
            for (const t of rulesTrades(idy, dirs, cell, costs)) addTrade(stats[cell.index], d, t);
        }
    });

    const totals = stats.map((s) => s.net);
    const neighbourhood = neighbours.map((ns) => median(ns.map((j) => totals[j])));
    let bestIdx = 0;
    for (let i = 1; i < stats.length; i++) {
        if (neighbourhood[i] > neighbourhood[bestIdx] || (neighbourhood[i] === neighbourhood[bestIdx] && totals[i] > totals[bestIdx])) bestIdx = i;
    }
    const best = stats[bestIdx];
    const daysPositive = best.dayNet.filter((x) => x > 0).length;
    const grossLoss = best.grossLoss;
    const profitFactor = grossLoss > 0 ? best.grossProfit / grossLoss : best.grossProfit > 0 ? Infinity : null;
    const hitRate: Record<number, number | null> = {};
    for (const X of DIRECTION_XS) {
        const h = hitCounts[X];
        hitRate[X] = h.hits + h.misses > 0 ? h.hits / (h.hits + h.misses) : null;
    }
    const lodo = leaveOneDayOut(stats, D);

    const required = Math.ceil(D * GATE.minDaysFraction);
    const hr = hitRate[GATE.hitX];
    const gateFailures: string[] = [];
    if (signals < GATE.minSignals) gateFailures.push(`signals ${signals} < ${GATE.minSignals}`);
    if (hr === null || hr <= GATE.minHitRate) gateFailures.push(`hit rate ${hr === null ? 'n/a' : (hr * 100).toFixed(1) + '%'} <= ${GATE.minHitRate * 100}%`);
    if (best.trades < GATE.minTrades) gateFailures.push(`trades ${best.trades} < ${GATE.minTrades}`);
    if (!(best.net > 0)) gateFailures.push(`net ${best.net.toFixed(0)} <= 0`);
    if (daysPositive < required) gateFailures.push(`positive days ${daysPositive} < ${required} of ${D}`);
    if (profitFactor === null || profitFactor <= GATE.minProfitFactor) gateFailures.push(`profit factor ${profitFactor === null ? 'n/a' : profitFactor.toFixed(2)} <= ${GATE.minProfitFactor}`);

    const gate = gateFailures.length === 0;
    return {
        id: rule.id,
        indicators: rule.indicators,
        requireAll: rule.requireAll,
        interval: days[0]?.interval ?? 0,
        signals,
        hitRate,
        hitCounts,
        best,
        bestLabel: cells[bestIdx].label,
        neighbourhoodMedian: neighbourhood[bestIdx],
        daysPositive,
        profitFactor,
        maxDrawdown: maxDrawdown(best.seq),
        lodoNet: lodo.net,
        lodoPositiveDays: lodo.positiveDays,
        lodoPicks: lodo.picks,
        gate,
        robust: gate && lodo.net > 0,
        gateFailures,
    };
}

// Ranking used for every table: days positive, then direction hit rate, then net P&L, then the smaller drawdown.
export function compareRows(a: RuleRow, b: RuleRow): number {
    if (b.daysPositive !== a.daysPositive) return b.daysPositive - a.daysPositive;
    const ha = a.hitRate[GATE.hitX] ?? -1;
    const hb = b.hitRate[GATE.hitX] ?? -1;
    if (hb !== ha) return hb - ha;
    if (b.best.net !== a.best.net) return b.best.net - a.best.net;
    if (a.maxDrawdown !== b.maxDrawdown) return a.maxDrawdown - b.maxDrawdown;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
