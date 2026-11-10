// Loads backup days (<dir>/<Mon-DD>/csv/Quote.csv + OptionQuote.csv) for the RuleBased backtest, and picks the contract a signal would buy.
import * as fs from 'fs';
import { discoverDayFolders, loadNiftyTicks, loadNiftyOptionTicks, contractKey, NiftyTick, OptionTick } from '../backtestCsvUtils';

export const LOT_SIZE = 65;
export const STRIKE_STEP = 50;

export interface ContractPath {
    key: string;                 // `${strike}_${CE|PE}`
    tsym: string;
    strike: number;
    right: 'CE' | 'PE';
    ticks: OptionTick[];         // sorted by ltt, finite positive ltp only
}

export interface DayData {
    day: string;
    nifty: NiftyTick[];          // sorted, finite positive ltp only
    contracts: Map<string, ContractPath>;
    strikes: { CE: number[]; PE: number[] }; // recorded strikes per right, ascending
    rawNiftyRows: number;
    rawOptionRows: number;
    skippedOptionTicks: number;  // NaN / non-positive ltp rows dropped
    fileSizes: number;           // bytes, part of the reproducibility fingerprint
}

export function loadDays(baseDir: string): DayData[] {
    return discoverDayFolders(baseDir).map(({ day, niftyFile, optionFile }) => {
        const rawNifty = loadNiftyTicks(niftyFile);
        const rawOptions = loadNiftyOptionTicks(optionFile);
        const nifty = rawNifty.filter((t) => Number.isFinite(t.ltp) && t.ltp > 0 && Number.isFinite(t.ltt));
        const options = rawOptions.filter((t) => Number.isFinite(t.ltp) && t.ltp > 0 && Number.isFinite(t.ltt) && Number.isFinite(t.strike));

        const contracts = new Map<string, ContractPath>();
        for (const t of options) {
            const key = contractKey(t.strike, t.optionType);
            let c = contracts.get(key);
            if (!c) {
                c = { key, tsym: t.tsym, strike: t.strike, right: t.optionType, ticks: [] };
                contracts.set(key, c);
            }
            c.ticks.push(t);
        }
        const strikes = { CE: [] as number[], PE: [] as number[] };
        for (const c of contracts.values()) strikes[c.right].push(c.strike);
        strikes.CE.sort((a, b) => a - b);
        strikes.PE.sort((a, b) => a - b);

        return {
            day,
            nifty,
            contracts,
            strikes,
            rawNiftyRows: rawNifty.length,
            rawOptionRows: rawOptions.length,
            skippedOptionTicks: rawOptions.length - options.length,
            fileSizes: fs.statSync(niftyFile).size + fs.statSync(optionFile).size,
        };
    });
}

// The contract a signal buys: ATM = nearest 50 to the NIFTY price; CE for UP, PE for DOWN. The CSVs hold a fixed set of strikes per day, so
// the nearest recorded strike of that side is used; null when that strike is farther than maxStrikeDistance (or none is recorded).
export function pickContract(day: DayData, niftyLtp: number, right: 'CE' | 'PE', maxStrikeDistance: number): ContractPath | null {
    const atm = Math.round(niftyLtp / STRIKE_STEP) * STRIKE_STEP;
    const list = day.strikes[right];
    if (list.length === 0) return null;
    let best = list[0];
    for (const s of list) {
        if (Math.abs(s - atm) < Math.abs(best - atm)) best = s;
    }
    if (Math.abs(best - atm) > maxStrikeDistance) return null;
    return day.contracts.get(contractKey(best, right)) ?? null;
}

// Index of the first tick at or after ltt (ticks sorted by ltt), or ticks.length when none.
export function firstTickAtOrAfter(ticks: { ltt: number }[], ltt: number): number {
    let lo = 0;
    let hi = ticks.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ticks[mid].ltt < ltt) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// IST time of day in minutes (the CSV times are IST; ltt is epoch seconds stored as ms here).
export function istMinuteOfDay(ltMs: number): number {
    const sec = Math.floor(ltMs / 1000) + 19800; // UTC+05:30
    return Math.floor((((sec % 86400) + 86400) % 86400) / 60);
}
