// The sweep engine: per day and candle interval it builds the candles and every indicator signal once, the contract and entry tick each
// candle's UP/DOWN signal would buy, and the direction outcomes. Each rule x exit cell is then a cheap walk over those cached pieces.
import { createStatsBuilder } from '../../processes/strategies/niftyStatsBuilder';
import { parseRuleIndicator, ruleSignal, consensusOf, RuleIndicator } from '../../strategy/ruleIndicators';
import { DayData, ContractPath, LOT_SIZE, pickContract, firstTickAtOrAfter, istMinuteOfDay } from './data';
import { RuleSpec, ExitCell, TargetSpec, StopSpec } from './grid';

export const DIRECTION_XS = [10, 15, 20]; // points NIFTY must move, in the predicted direction, before it moves that far against

export interface Costs { costPerTrade: number; slippagePoints: number; }

// Entry window, the same as the live rule (isTimeInRange: 10:00-15:00).
const WINDOW_START_MIN = 10 * 60;
const WINDOW_END_MIN = 15 * 60;

export interface Candidate {
    contract: ContractPath | null; // null: no contract in range (the rule cannot trade this signal, the strategy stays free)
    entryIdx: number;              // index of the first option tick at/after the signal; -1 = the buy never fills (blocks until day end)
}

export interface IntervalDay {
    day: string;
    interval: number;
    ltt: number[];                 // candle close tick time (ms)
    ltp: number[];                 // candle close price
    inWindow: boolean[];
    sig: Int8Array[];              // per indicator index (see names), +1 UP / -1 DOWN / 0 none
    outcome: Map<number, Int8Array>; // per direction X: +1 NIFTY hit UP first, -1 DOWN first, 0 none before the day ends
    cand: [Candidate, Candidate][];  // per candle: [UP -> CE, DOWN -> PE]
    niftyRows: number;
    cache: Map<string, Trade>;     // sim cache: `${c}|${dir}|${cell}`
    skippedCE: number;             // in-window candles whose ATM CE strike is not recorded within the distance limit
    skippedPE: number;
}

export interface Trade {
    contractKey: string;
    tsym: string;
    dir: 1 | -1;
    signalLtt: number;
    entryLtt: number;
    entryPx: number;
    exitLtt: number;
    exitPx: number;
    reason: 'win' | 'loss' | 'timeout' | 'eod';
    pnl: number;                   // rupees, after costs
}

export function buildIntervalDay(day: DayData, interval: number, parsed: RuleIndicator[], maxStrikeDistance: number): IntervalDay {
    const builder = createStatsBuilder(interval);
    const ltt: number[] = [];
    const ltp: number[] = [];
    const results: any[] = [];
    for (const t of day.nifty) {
        const r = builder.record(t.ltp, t.ltt / 1000);
        if (r) {
            ltt.push(t.ltt);
            ltp.push(t.ltp);
            results.push(r.newStats.results);
        }
    }
    const n = ltt.length;
    const inWindow = ltt.map((ms) => {
        const m = istMinuteOfDay(ms);
        return m >= WINDOW_START_MIN && m < WINDOW_END_MIN;
    });

    const sig = parsed.map((ind) => {
        const arr = new Int8Array(n);
        for (let c = 0; c < n; c++) {
            const s = ruleSignal(ind, results[c]);
            arr[c] = s === 'UP' ? 1 : s === 'DOWN' ? -1 : 0;
        }
        return arr;
    });

    const outcome = new Map<number, Int8Array>();
    for (const X of DIRECTION_XS) {
        const arr = new Int8Array(n);
        for (let c = 0; c < n; c++) {
            const base = ltp[c];
            for (let i = firstTickAtOrAfter(day.nifty, ltt[c] + 1); i < day.nifty.length; i++) {
                const p = day.nifty[i].ltp;
                if (p >= base + X) { arr[c] = 1; break; }
                if (p <= base - X) { arr[c] = -1; break; }
            }
        }
        outcome.set(X, arr);
    }

    const cand: [Candidate, Candidate][] = [];
    let skippedCE = 0;
    let skippedPE = 0;
    for (let c = 0; c < n; c++) {
        const make = (right: 'CE' | 'PE'): Candidate => {
            const contract = pickContract(day, ltp[c], right, maxStrikeDistance);
            if (!contract) return { contract: null, entryIdx: -1 };
            const e = firstTickAtOrAfter(contract.ticks, ltt[c]);
            return { contract, entryIdx: e < contract.ticks.length ? e : -1 };
        };
        const ce = make('CE');
        const pe = make('PE');
        cand.push([ce, pe]);
        if (inWindow[c] && !ce.contract) skippedCE++;
        if (inWindow[c] && !pe.contract) skippedPE++;
    }

    return { day: day.day, interval, ltt, ltp, inWindow, sig, outcome, cand, niftyRows: day.nifty.length, cache: new Map(), skippedCE, skippedPE };
}

// Direction a rule gives at each candle, using the live consensus function.
// The block's direction per candle, as the live strategy combines its rules: any rule UP and any rule DOWN on the same candle is a
// conflict (no trade); otherwise the side that fired. `conflicts` counts in-window candles where the rules disagree.
export function blockDirections(idy: IntervalDay, ruleIndexes: number[][], requireAll: boolean): { dirs: Int8Array; conflicts: number } {
    const perRule = ruleIndexes.map((ix) => ruleDirections(idy, ix, requireAll));
    const n = idy.ltt.length;
    const out = new Int8Array(n);
    let conflicts = 0;
    for (let c = 0; c < n; c++) {
        let up = false;
        let down = false;
        for (const d of perRule) {
            if (d[c] === 1) up = true;
            else if (d[c] === -1) down = true;
        }
        if (up && down) {
            if (idy.inWindow[c]) conflicts++;
            out[c] = 0;
        } else {
            out[c] = up ? 1 : down ? -1 : 0;
        }
    }
    return { dirs: out, conflicts };
}

export function ruleDirections(idy: IntervalDay, indexes: number[], requireAll: boolean): Int8Array {
    const n = idy.ltt.length;
    const out = new Int8Array(n);
    const values: (string | null)[] = new Array(indexes.length);
    for (let c = 0; c < n; c++) {
        for (let k = 0; k < indexes.length; k++) {
            const code = idy.sig[indexes[k]][c];
            values[k] = code === 1 ? 'UP' : code === -1 ? 'DOWN' : null;
        }
        const d = consensusOf(values, requireAll);
        out[c] = d === 'UP' ? 1 : d === 'DOWN' ? -1 : 0;
    }
    return out;
}

// Simulates one position: fill at the entry tick, then the strategy's own order of checks on each later option tick (timeout, target,
// stop). With no exit before the contract's last tick, the position leaves at that last tick ('eod').
export function simulate(contract: ContractPath, entryIdx: number, cell: ExitCell, costs: Costs, dir: 1 | -1, signalLtt: number): Trade {
    const ticks = contract.ticks;
    const fill = ticks[entryIdx].ltp;
    const entryLtt = ticks[entryIdx].ltt;
    const tdist = distance(cell.target, fill);
    const sdist = distance(cell.stop, fill);
    const maxMs = cell.timeoutMinutes * 60_000;
    let exitIdx = ticks.length - 1;
    let reason: Trade['reason'] = 'eod';
    for (let j = entryIdx + 1; j < ticks.length; j++) {
        const t = ticks[j];
        if (t.ltt - entryLtt >= maxMs) { exitIdx = j; reason = 'timeout'; break; }
        if (tdist !== null && t.ltp >= fill + tdist) { exitIdx = j; reason = 'win'; break; }
        if (sdist !== null && t.ltp <= fill - sdist) { exitIdx = j; reason = 'loss'; break; }
    }
    const exitPx = ticks[exitIdx].ltp;
    const pnl = ((exitPx - costs.slippagePoints) - (fill + costs.slippagePoints)) * LOT_SIZE - costs.costPerTrade;
    return {
        contractKey: contract.key, tsym: contract.tsym, dir, signalLtt, entryLtt, entryPx: fill,
        exitLtt: ticks[exitIdx].ltt, exitPx, reason, pnl,
    };
}

function distance(spec: TargetSpec | StopSpec, base: number): number | null {
    if (spec.kind === 'none') return null;
    return spec.kind === 'points' ? spec.value : base * spec.value / 100;
}

// The trades one rule makes on one day with one exit cell. One position per rule: a new signal is taken only after the last exit.
export function rulesTrades(idy: IntervalDay, dirs: Int8Array, cell: ExitCell, costs: Costs): Trade[] {
    const trades: Trade[] = [];
    let busyUntil = -Infinity;
    for (let c = 0; c < dirs.length; c++) {
        const d = dirs[c];
        if (d === 0 || !idy.inWindow[c]) continue;
        // The strategy reads a NIFTY tick before the option tick with the same time, so an exit at the same time still blocks.
        if (idy.ltt[c] <= busyUntil) continue;
        const cand = idy.cand[c][d === 1 ? 0 : 1];
        if (!cand.contract) continue;
        if (cand.entryIdx < 0) { busyUntil = Infinity; continue; }
        const key = `${c}|${d}|${cell.index}`;
        let trade = idy.cache.get(key);
        if (!trade) {
            trade = simulate(cand.contract, cand.entryIdx, cell, costs, d === 1 ? 1 : -1, idy.ltt[c]);
            idy.cache.set(key, trade);
        }
        trades.push(trade);
        busyUntil = trade.exitLtt;
    }
    return trades;
}

// Direction hits for one rule on one day: signals that fire in the window, and for each X whether NIFTY moved X the predicted way first.
export function directionStats(idy: IntervalDay, dirs: Int8Array): { signals: number; hits: Record<number, number>; misses: Record<number, number> } {
    const hits: Record<number, number> = {};
    const misses: Record<number, number> = {};
    let signals = 0;
    for (const X of DIRECTION_XS) { hits[X] = 0; misses[X] = 0; }
    for (let c = 0; c < dirs.length; c++) {
        const d = dirs[c];
        if (d === 0 || !idy.inWindow[c]) continue;
        signals++;
        for (const X of DIRECTION_XS) {
            const o = idy.outcome.get(X)![c];
            if (o === d) hits[X]++;
            else if (o === -d) misses[X]++;
        }
    }
    return { signals, hits, misses };
}

export function ruleIndexes(rule: RuleSpec, nameIndex: Map<string, number>): number[] {
    return rule.indicators.map((n) => {
        const i = nameIndex.get(n);
        if (i === undefined) throw new Error(`indicator not in the search space: ${n}`);
        return i;
    });
}

export function parseAll(names: string[]): RuleIndicator[] {
    return names.map((n) => parseRuleIndicator(n));
}
