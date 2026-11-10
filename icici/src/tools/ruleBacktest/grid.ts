// The search space: every indicator name the live builder computes, the rule combinations, and the exit grid.
import { RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from '../../lib/indicator-config';

// All 80 names (RSI 21 + contrarian RSI 21 + MACD 7 + EMA 9 + Bollinger 18 + ADX 2 + Stochastic 2), in a fixed order.
export function allIndicatorNames(): string[] {
    const names: string[] = [];
    for (const p of RSI_PARAMS) names.push(`RSI_${p.period}_${p.overbought}_${p.oversold}`);
    for (const p of RSI_PARAMS) names.push(`RSI_${p.period}_${p.overbought}_${p.oversold}_REV`);
    for (const p of MACD_PARAMS) names.push(`MACD_${p.shortPeriod}_${p.longPeriod}_${p.signalPeriod}`);
    for (const p of EMA_PARAMS) names.push(`EMA_${p.shortPeriod}_${p.longPeriod}`);
    for (const p of BOLLINGER_PARAMS) names.push(`Bollinger_${p.period}_${p.numDeviations}`);
    for (const p of ADX_PARAMS) names.push(`ADX_${p.period}`);
    for (const p of STOCHASTIC_PARAMS) names.push(`Stochastic_${p.kPeriod}_${p.dPeriod}`);
    return names;
}

export interface RuleSpec {
    id: string;              // stable id: `A+B+C|all` or `A+B|majority`
    indicators: string[];
    requireAll: boolean;
}

// Singles and pairs (all-agree; for two indicators majority = all-agree, so one mode). Triples and above add the majority variant too.
export function enumerateRules(names: string[], maxSize: number): RuleSpec[] {
    const rules: RuleSpec[] = [];
    const add = (idx: number[], requireAll: boolean) => {
        const indicators = idx.map((i) => names[i]);
        rules.push({ id: `${indicators.join('+')}|${requireAll ? 'all' : 'majority'}`, indicators, requireAll });
    };
    const combine = (size: number) => {
        const cur: number[] = [];
        const rec = (start: number) => {
            if (cur.length === size) {
                add(cur, true);
                if (size >= 3) add(cur, false);
                return;
            }
            for (let i = start; i < names.length; i++) {
                cur.push(i);
                rec(i + 1);
                cur.pop();
            }
        };
        rec(0);
    };
    for (let size = 1; size <= maxSize; size++) combine(size);
    return rules;
}

export type TargetSpec = { kind: 'none' } | { kind: 'points'; value: number } | { kind: 'percent'; value: number };
export type StopSpec = { kind: 'none' } | { kind: 'points'; value: number } | { kind: 'percent'; value: number };

export interface ExitCell {
    index: number;
    label: string;
    target: TargetSpec;
    stop: StopSpec;
    timeoutMinutes: number;
    // Grid coordinates, used to find neighbouring cells.
    ti: number; si: number; mi: number;
}

// 7 targets x 5 stops x 3 timeouts = 105 cells. Neighbours are the cells one step away in the list of each dimension.
export const TARGETS: { label: string; spec: TargetSpec }[] = [
    { label: 'none', spec: { kind: 'none' } },
    { label: '5pt', spec: { kind: 'points', value: 5 } },
    { label: '10pt', spec: { kind: 'points', value: 10 } },
    { label: '15pt', spec: { kind: 'points', value: 15 } },
    { label: '20pt', spec: { kind: 'points', value: 20 } },
    { label: '10%', spec: { kind: 'percent', value: 10 } },
    { label: '20%', spec: { kind: 'percent', value: 20 } },
];
export const STOPS: { label: string; spec: StopSpec }[] = [
    { label: 'none', spec: { kind: 'none' } },
    { label: '10pt', spec: { kind: 'points', value: 10 } },
    { label: '20pt', spec: { kind: 'points', value: 20 } },
    { label: '10%', spec: { kind: 'percent', value: 10 } },
    { label: '20%', spec: { kind: 'percent', value: 20 } },
];
export const TIMEOUTS = [15, 30, 60];

export function exitCells(): ExitCell[] {
    const cells: ExitCell[] = [];
    TARGETS.forEach((t, ti) => STOPS.forEach((s, si) => TIMEOUTS.forEach((m, mi) => {
        cells.push({ index: cells.length, label: `T=${t.label} S=${s.label} M=${m}m`, target: t.spec, stop: s.spec, timeoutMinutes: m, ti, si, mi });
    })));
    return cells;
}

// Cell indices of the cell itself and its neighbours (one step in each dimension, the others unchanged).
export function neighbourIndices(cells: ExitCell[]): number[][] {
    const at = (ti: number, si: number, mi: number) => ((ti * STOPS.length) + si) * TIMEOUTS.length + mi;
    return cells.map((c) => {
        const out = [c.index];
        for (const d of [-1, 1]) {
            if (c.ti + d >= 0 && c.ti + d < TARGETS.length) out.push(at(c.ti + d, c.si, c.mi));
            if (c.si + d >= 0 && c.si + d < STOPS.length) out.push(at(c.ti, c.si + d, c.mi));
            if (c.mi + d >= 0 && c.mi + d < TIMEOUTS.length) out.push(at(c.ti, c.si, c.mi + d));
        }
        return out;
    });
}
