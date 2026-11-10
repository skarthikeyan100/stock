// Replays one rule and exit cell through the REAL RuleBasedStrategy class (order client stubbed, Date.now set to the tick time) and
// compares its trades with the sweep engine's trades for the same day, rule and cell. Any difference is reported, not hidden.
import OrderClient from '../../processes/strategies/OrderClient';
import RuleBasedStrategy from '../../strategy/RuleBasedStrategy';
import { OptionQuote } from '../../model/model';
import { createStatsBuilder } from '../../processes/strategies/niftyStatsBuilder';
import { parseRuleIndicator } from '../../strategy/ruleIndicators';
import { DayData, LOT_SIZE, pickContract, istMinuteOfDay } from './data';
import { ExitCell } from './grid';
import { Costs, Trade, IntervalDay, rulesTrades } from './engine';

export interface RealTrade { contractKey: string; entryLtt: number; entryPx: number; exitLtt: number; exitPx: number; reason: string; }
export interface VerifyResult { day: string; real: RealTrade[]; openAtEnd: RealTrade | null; fast: Trade[]; mismatches: string[]; }

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function rawExit(spec: ExitCell['target'] | ExitCell['stop']): string | number {
    if (spec.kind === 'none') return 'none';
    return spec.kind === 'points' ? spec.value : `${spec.value}%`;
}

// lines: the block's rules (each a list of indicator names). fastDirs: the sweep engine's direction per candle for the same block.
export async function verifyDay(
    day: DayData, idy: IntervalDay, lines: string[][], requireAll: boolean, fastDirs: Int8Array, cell: ExitCell, costs: Costs, maxStrikeDistance: number,
): Promise<VerifyResult> {
    const interval = idy.interval;
    const tsymToKey = new Map<string, string>();
    for (const c of day.contracts.values()) tsymToKey.set(c.tsym, c.key);

    // Stub order client: contract and token come from the recorded CSV strikes; orders are not sent anywhere.
    let niftyLtp = 0;
    let pendingBuy: { tsym: string; qty: number } | null = null;
    let pendingSell: { tsym: string; qty: number; price: number } | null = null;
    let fillEntry: { key: string; entryLtt: number; entryPx: number } | null = null;
    let curTick = { ltt: 0, ltp: 0 };
    const real: RealTrade[] = [];
    const stub: any = {
        getContractByPriceRange: async (_u: string, right: string) => {
            const c = pickContract(day, niftyLtp, right === 'call' ? 'CE' : 'PE', maxStrikeDistance);
            return c ? c.tsym : null;
        },
        getToken: async (_u: string, tsym: string) => `OPT_${tsymToKey.get(tsym)}`,
        getOpenTrades: async () => [],
    };
    const origGetInstance = (OrderClient as any).getInstance;
    (OrderClient as any).getInstance = () => stub;

    const origNow = Date.now;
    let nowMs = 0;
    Date.now = () => nowMs;
    const origLog = console.log;
    console.log = () => undefined;

    try {
        const s: any = new RuleBasedStrategy(`RuleBlock-verify`);
        s.enabled = true;
        s.ruleNames = lines;
        s.parsed = lines.map((names) => names.map((n) => parseRuleIndicator(n)));
        s.indicatorError = null;
        // Same window as the live rule (10:00-15:00 IST), read from the simulated clock.
        s.isTimeInRange = () => { const m = istMinuteOfDay(nowMs); return m >= 600 && m < 900; };
        s.getConfig = () => ({ enabled: true, indicators: lines.map((names) => names.join(',')), quantity: LOT_SIZE, maxHoldTimeMinutes: cell.timeoutMinutes, logEnabled: false, requireAllIndicators: requireAll });
        s.setting = (k: string) => (k === 'target' ? rawExit(cell.target) : k === 'stopLoss' ? rawExit(cell.stop) : k === 'maxHoldTimeMinutes' ? (Number.isFinite(cell.timeoutMinutes) ? cell.timeoutMinutes : 'none') : k === 'cooldownSeconds' ? 0 : undefined);
        s.buyContract = async (contract: string, qty: number) => { pendingBuy = { tsym: contract, qty }; return { contract, price: 0, qty, token: '' }; };
        s.sellContract = async (contract: string, qty: number, price?: number) => { pendingSell = { tsym: contract, qty, price: Number(price) }; };
        s.recordOutcome = (outcome: string) => {
            if (!fillEntry) return;
            real.push({ contractKey: fillEntry.key, entryLtt: fillEntry.entryLtt, entryPx: fillEntry.entryPx, exitLtt: curTick.ltt, exitPx: pendingExitPx, reason: outcome });
            fillEntry = null;
        };
        let pendingExitPx = 0;
        const origSell = s.sellContract;
        s.sellContract = async (contract: string, qty: number, price?: number) => { pendingExitPx = Number(price); return origSell(contract, qty, price); };

        const builder = createStatsBuilder(interval);
        // Merged feed: NIFTY first on equal times (the order the strategy would see them live).
        const opts: { ltt: number; ltp: number; key: string; tsym: string }[] = [];
        for (const c of day.contracts.values()) for (const t of c.ticks) opts.push({ ltt: t.ltt, ltp: t.ltp, key: c.key, tsym: c.tsym });
        opts.sort((a, b) => a.ltt - b.ltt);
        let j = 0;

        const dispatchOption = async (o: { ltt: number; ltp: number; key: string; tsym: string }) => {
            curTick = { ltt: o.ltt, ltp: o.ltp };
            nowMs = o.ltt;
            const contract = s.contract;
            if (!contract || contract.token !== `OPT_${o.key}`) return;
            if (pendingBuy && pendingBuy.tsym === o.tsym) {
                const b = pendingBuy;
                pendingBuy = null;
                fillEntry = { key: o.key, entryLtt: o.ltt, entryPx: o.ltp };
                await s.updateTrade({ tsym: b.tsym, action: 'Buy', quantity: b.qty, price: o.ltp });
            }
            await s.processOptionQuote(Object.assign(new OptionQuote(), { token: `OPT_${o.key}`, ltp: o.ltp }));
            if (pendingSell) {
                const p = pendingSell;
                pendingSell = null;
                await s.updateTrade({ tsym: p.tsym, action: 'Sell', quantity: p.qty, price: p.price });
            }
        };

        for (const t of day.nifty) {
            while (j < opts.length && opts[j].ltt < t.ltt) { await dispatchOption(opts[j]); j++; }
            niftyLtp = t.ltp;
            nowMs = t.ltt;
            const r = builder.record(t.ltp, t.ltt / 1000);
            if (r) {
                s.receive(r.oldStats, r.newStats);
                await flush();
            }
        }
        while (j < opts.length) { await dispatchOption(opts[j]); j++; }

        const openContract = s.contract;
        const openAtEnd: RealTrade | null = openContract && fillEntry
            ? { contractKey: fillEntry.key, entryLtt: fillEntry.entryLtt, entryPx: fillEntry.entryPx, exitLtt: 0, exitPx: 0, reason: 'open' }
            : null;

        // Fast engine for the same day/rule/cell
        const fast = rulesTrades(idy, fastDirs, cell, costs);
        const mismatches: string[] = [];
        const fastClosed = fast.filter((t) => t.reason !== 'eod');
        const key = (t: { contractKey: string; entryLtt: number; exitLtt: number; exitPx: number; reason: string }) =>
            `${t.contractKey}@${t.entryLtt}>${t.exitLtt}:${t.exitPx}:${t.reason}`;
        const realSet = new Map<string, number>();
        for (const r of real) realSet.set(key(r), (realSet.get(key(r)) ?? 0) + 1);
        for (const f of fastClosed) {
            const k = key({ contractKey: f.contractKey, entryLtt: f.entryLtt, exitLtt: f.exitLtt, exitPx: f.exitPx, reason: f.reason });
            const n = realSet.get(k) ?? 0;
            if (n === 0) mismatches.push(`fast-only closed trade ${k}`);
            else realSet.set(k, n - 1);
        }
        for (const [k, n] of realSet) if (n > 0) mismatches.push(`real-only closed trade ${k}`);
        const fastEod = fast.find((t) => t.reason === 'eod') ?? null;
        if (fastEod && !openAtEnd) mismatches.push(`fast leaves an open position at day end (entry ${fastEod.entryLtt}), real closed it`);
        if (!fastEod && openAtEnd) mismatches.push(`real leaves an open position at day end (entry ${openAtEnd.entryLtt}), fast did not`);
        if (fastEod && openAtEnd && fastEod.entryLtt !== openAtEnd.entryLtt) mismatches.push(`open position differs: fast entry ${fastEod.entryLtt}, real ${openAtEnd.entryLtt}`);

        return { day: day.day, real, openAtEnd, fast, mismatches };
    } finally {
        Date.now = origNow;
        console.log = origLog;
        (OrderClient as any).getInstance = origGetInstance;
    }
}

