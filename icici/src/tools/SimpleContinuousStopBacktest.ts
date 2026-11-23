/**
 * Offline what-if for a hard stop on SimpleContinuousStrategy. Replays recorded ticks (Quote / OptionQuote / Pcr CSV backups, same inputs and the same
 * mock broker as SimpleContinuousBacktest.ts) through the REAL strategy class, and injects a stop from the replay loop: when an open leg's tick is at or
 * below entry - S, its resting sell is cancelled and the leg is sold at (tick - slippage), delivered to the strategy as an ordinary sell fill. No
 * order, broker or network call is made; nothing in src/strategy is changed.
 *
 * Variants (S = 0 is the baseline, no stop):
 *   i   stop only: the strategy's own rule after a loss sell applies (an un-hedged leg is hedged once with the opposite right, as it would have been
 *       by its adverse move; an already hedged leg buys nothing).
 *   ii  stop + ONE extra opposite hedge when the leg was already hedged (the extra hedge is then hedged by the normal adverse-move rule).
 *   iii like ii, but the extra hedge is NOT hedged in turn (hedged = true on creation).
 * An extra hedge is never stopped itself (chain capped at one). Every other leg may be stopped.
 *
 * LIMITS (read before trusting a number): a buy fills at the last tick (no bid/ask exists in the recorded data, so the bid-resting buy and its fill
 * rate are NOT modelled); the roots are the replay's own (config at run time, PCR from Pcr.csv), not the actual roots of the day; no EOD close (open
 * legs are marked at the last tick); the recorded window holds only 6 CE + 6 PE strikes, a hedge needing another strike stalls (counted).
 *
 * Usage: tsc --outDir .bt-dist && MOCK_BROKER=true node .bt-dist/tools/SimpleContinuousStopBacktest.js [--allDays <dir>] [--days Nov-17,Nov-20] [--out file.json]
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import Log from '../util/Log';
import {
    getArg, loadNiftyTicks, loadNiftyOptionTicks, buildContractDirectory, contractKey, round2,
    discoverDayFolders, BacktestOrderClient, ContractInfo, NiftyTick, OptionTick,
} from './backtestCsvUtils';

const ALL_DAYS_DIR = getArg('allDays', '/home/karthikeyan/later/data/backups');
const ONLY_DAYS = getArg('days', '').split(',').filter(Boolean);
const OUT_FILE = getArg('out', '');
const USER = `StopBacktest${process.pid}`; // per process, so two runs in parallel never share a state file
const STATE_FILE = path.join(__dirname, `../../.SimpleContinuousStrategy.${USER}.json`);
const MIN = 60_000;

interface PcrRow { at: number; pcr: number }
function loadPcr(file: string): PcrRow[] {
    const rows: any[] = parse(fs.readFileSync(file, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true });
    return rows.filter((r) => r.index === 'NIFTY' && r.pcr !== '' && r.pcr != null)
        .map((r) => ({ at: Date.parse(String(r.fetchedAt).replace(' ', 'T') + '+05:30'), pcr: Number(r.pcr) }))
        .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.pcr)).sort((a, b) => a.at - b.at);
}

interface RestingSell { tsym: string; token: string; quantity: number; price: number }
class Client extends BacktestOrderClient {
    sells = new Map<string, RestingSell>();
    pcrRows: PcrRow[] = [];
    constructor(private dir: Map<string, ContractInfo>) { super(dir, 'call'); }
    private tokenOfTsym(tsym: string): string | undefined { for (const c of this.dir.values()) if (c.tsym === tsym) return c.token; return undefined; }
    async getPCR(): Promise<number | null> { let v: number | null = null; for (const r of this.pcrRows) { if (r.at <= this.currentTime) v = r.pcr; else break; } return v; }
    async chunkedSquareOffLimit(_u: string, p: { tradingSymbol: string; instrumentId: string; quantity: number; price: number }): Promise<any> {
        const token = String(p.instrumentId);
        this.sells.set(token, { tsym: p.tradingSymbol, token, quantity: p.quantity, price: p.price });
        return { quantity: p.quantity };
    }
    async cancelRestingLimitSells(_u: string, p: { tradingSymbol: string }): Promise<{ filledQty: number; cancelFailed: boolean }> {
        const token = this.tokenOfTsym(p.tradingSymbol); if (token) this.sells.delete(token);
        return { filledQty: 0, cancelFailed: false };
    }
    async getPendingSells(_u: string, _b: string, tsym: string): Promise<{ quantity: number }[]> {
        const token = this.tokenOfTsym(tsym); const s = token ? this.sells.get(token) : undefined;
        return s ? [{ quantity: s.quantity }] : [];
    }
    async chunkedSquareOff(_u: string, p: { tradingSymbol: string; quantity: number }): Promise<any> {
        const token = this.tokenOfTsym(p.tradingSymbol); if (!token) throw new Error(`unknown contract ${p.tradingSymbol}`);
        const price = this.latestPrice.get(token.slice(4)); if (price == null) throw new Error('no price');
        this.closeLeg(token, price); return { quantity: p.quantity };
    }
}

export interface Variant { name: string; S: number; mode: 'i' | 'ii' | 'iii'; slip: number; maxProfit: number }
interface StopEvent {
    tsym: string; right: string; entry: number; stopPrice: number; qty: number; at: number; wasHedged: boolean; pnl: number;
    reachedTargetLater: boolean; laterMax: number; closeMark: number; heldToCloseCounterfactual: number;
    oppChange: { m5?: number; m15?: number; m30?: number };
}
export interface RunResult {
    day: string; variant: string; net: number; realized: number; unrealized: number; grossWin: number; grossLoss: number; legs: number;
    stops: StopEvent[]; extraLegs: number; extraPnl: number; maxDrawdown: number; stalledHedges: number; tripped: boolean; openAtEnd: number;
}

interface DayData { day: string; nifty: NiftyTick[]; options: OptionTick[]; dir: Map<string, ContractInfo>; pcr: PcrRow[]; series: Map<string, { t: number; p: number }[]> }

function loadDay(d: { day: string; niftyFile: string; optionFile: string }): DayData | null {
    const pcrFile = path.join(path.dirname(d.niftyFile), 'Pcr.csv');
    if (!fs.existsSync(pcrFile)) return null;
    const nifty = loadNiftyTicks(d.niftyFile), options = loadNiftyOptionTicks(d.optionFile);
    if (!nifty.length || !options.length) return null;
    const series = new Map<string, { t: number; p: number }[]>();
    for (const o of options) { if (Number.isNaN(o.ltp)) continue; const k = contractKey(o.strike, o.optionType); (series.get(k) ?? series.set(k, []).get(k)!).push({ t: o.ltt, p: o.ltp }); }
    return { day: d.day, nifty, options, dir: buildContractDirectory(options), pcr: loadPcr(pcrFile), series };
}

function priceAt(arr: { t: number; p: number }[] | undefined, t: number): number | undefined {
    if (!arr || !arr.length) return undefined;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 ? arr[ans].p : undefined;
}

async function runVariant(day: DayData, v: Variant): Promise<RunResult> {
    const mock = new Client(day.dir);
    mock.pcrRows = day.pcr;
    (OrderClient as any).instance = mock;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    configService.config.strategies = (configService.config.strategies || []).map((s: any) =>
        s.type === 'SimpleContinuousStrategy' ? { ...s, enabled: true, maxProfit: v.maxProfit } : s);
    const strategy: any = new SimpleContinuousStrategy(USER);
    strategy.enabled = true; strategy.stateLoaded = true;
    const realNow = Date.now; Date.now = () => mock.currentTime || realNow();
    const priceDiff = Number((configService.getStrategyConfig('SimpleContinuousStrategy') as any).priceDiff);
    const stops: StopEvent[] = [];
    const extraParents = new Set<string>(); // leg ids whose stop should produce an extra hedge that is not yet created
    let stalled = 0, closedSum = 0, seenClosed = 0, peak = 0, maxDd = 0, lastNifty = 0;
    const origBuy = mock.buyContractBare.bind(mock);
    mock.buyContractBare = async (...a: Parameters<typeof origBuy>) => { try { return await origBuy(...a); } catch (e) { stalled++; throw e; } };

    const flagExtras = () => {
        if (extraParents.size === 0) return;
        for (const leg of Object.values<any>(strategy.state.legs)) {
            if (leg.role === 'hedge' && leg.parentId && extraParents.has(leg.parentId) && !leg.extra) {
                leg.extra = true;
                if (v.mode === 'iii') leg.hedged = true;
                extraParents.delete(leg.parentId);
            }
        }
    };
    const mark = (): number => {
        while (seenClosed < mock.closedTrades.length) closedSum += mock.closedTrades[seenClosed++].pnl;
        let u = 0;
        for (const [token, e] of mock.openTrades) { const m = mock.latestPrice.get(token.slice(4)); if (m != null) u += (m - e.entryPrice) * e.quantity; }
        return closedSum + u;
    };
    const oppositeChange = (right: string, t: number): StopEvent['oppChange'] => {
        const opp = right === 'CE' ? 'PE' : 'CE';
        let best: string | undefined, bd = Infinity;
        for (const c of day.dir.values()) if (c.optionType === opp && Math.abs(c.strike - lastNifty) < bd) { bd = Math.abs(c.strike - lastNifty); best = contractKey(c.strike, c.optionType); }
        const arr = best ? day.series.get(best) : undefined;
        const p0 = priceAt(arr, t); const out: StopEvent['oppChange'] = {};
        if (p0 == null) return out;
        for (const [k, m] of [['m5', 5], ['m15', 15], ['m30', 30]] as const) { const p = priceAt(arr, t + m * MIN); if (p != null) out[k] = round2(p - p0); }
        return out;
    };
    const takeStop = async (leg: any, ltp: number, t: number) => {
        leg.stopped = true;
        const price = Math.max(0.05, Math.round((ltp - v.slip) * 20) / 20);
        const wasHedged = !!leg.hedged;
        const qty = leg.qty - leg.soldQty;
        const arr = day.series.get(contractKey(leg.strike, leg.right));
        let laterMax = -Infinity;
        if (arr) for (const x of arr) if (x.t > t && x.p > laterMax) laterMax = x.p;
        const closeMark = arr && arr.length ? arr[arr.length - 1].p : ltp;
        const reached = laterMax >= leg.entry + priceDiff;
        stops.push({
            tsym: leg.tsym, right: leg.right, entry: leg.entry, stopPrice: price, qty, at: t, wasHedged, pnl: (price - leg.entry) * qty, reachedTargetLater: reached,
            laterMax: laterMax === -Infinity ? NaN : laterMax, closeMark, heldToCloseCounterfactual: ((reached ? leg.entry + priceDiff : closeMark) - leg.entry) * qty,
            oppChange: oppositeChange(leg.right, t),
        });
        mock.sells.delete(leg.token);
        mock.closeLeg(leg.token, price);
        if (v.mode !== 'i' && wasHedged) { leg.hedged = false; leg.hedgeWaiting = false; extraParents.add(leg.id); }
        const tr = new Trade();
        tr.tsym = leg.tsym; tr.token = leg.token; tr.quantity = qty; tr.price = price; tr.lastTradePrice = price; tr.action = 'Sell'; tr.status = 'COMPLETE'; tr.user = USER;
        await strategy.updateTrade(tr);
        flagExtras();
    };

    try {
        let i = 0, j = 0; const N = day.nifty, O = day.options;
        while (i < N.length || j < O.length) {
            const n = N[i], o = O[j];
            if (o === undefined || (n !== undefined && n.ltt <= o.ltt)) {
                mock.currentTime = n.ltt; lastNifty = n.ltp;
                const q = new NiftyQuote(); q.ltp = n.ltp; q.token = 'NIFTY'; q.ltt = n.ltt;
                await strategy.processNiftyQuote(q); flagExtras(); i++;
            } else {
                mock.currentTime = o.ltt;
                const key = contractKey(o.strike, o.optionType);
                if (!Number.isNaN(o.ltp)) mock.latestPrice.set(key, o.ltp);
                const c = day.dir.get(key)!;
                const rest = mock.sells.get(c.token);
                if (rest && o.ltp >= rest.price) {
                    mock.sells.delete(c.token); mock.closeLeg(c.token, rest.price);
                    const t = new Trade();
                    t.tsym = rest.tsym; t.token = c.token; t.quantity = rest.quantity; t.price = rest.price; t.lastTradePrice = rest.price; t.action = 'Sell'; t.status = 'COMPLETE'; t.user = USER;
                    await strategy.updateTrade(t); flagExtras();
                }
                if (v.S > 0 && !Number.isNaN(o.ltp) && !strategy.state.profitTripped) {
                    for (const leg of Object.values<any>(strategy.state.legs)) {
                        if (leg.status === 'open' && leg.token === c.token && !leg.stopped && !leg.extra && o.ltp <= leg.entry - v.S) await takeStop(leg, o.ltp, o.ltt);
                    }
                }
                const oq = new OptionQuote(); oq.ltp = o.ltp; oq.token = c.token; oq.ltt = o.ltt;
                if (strategy.canHandleOptionQuote(oq)) await strategy.processOptionQuote(oq);
                j++;
                const m = mark(); if (m > peak) peak = m; if (peak - m > maxDd) maxDd = peak - m;
            }
        }
    } finally { Date.now = realNow; }

    let grossWin = 0, grossLoss = 0, extraPnl = 0, extraLegs = 0, legs = 0;
    for (const leg of Object.values<any>(strategy.state.legs)) {
        legs++;
        const sold = leg.soldQty > 0 ? leg.soldValue - leg.soldQty * leg.entry : 0;
        const rem = leg.qty - leg.soldQty;
        const lastKey = contractKey(leg.strike, leg.right);
        const m = leg.status === 'open' && rem > 0 ? (mock.latestPrice.get(lastKey) ?? leg.entry) : leg.entry;
        const pnl = sold + (leg.status === 'open' ? (m - leg.entry) * rem : 0);
        if (pnl >= 0) grossWin += pnl; else grossLoss += pnl;
        if (leg.extra) { extraLegs++; extraPnl += pnl; }
    }
    const realized = round2(mock.closedTrades.reduce((s, t) => s + t.pnl, 0));
    let unrealized = 0;
    for (const [token, e] of mock.openTrades) { const m = mock.latestPrice.get(token.slice(4)); if (m != null) unrealized += (m - e.entryPrice) * e.quantity; }
    const tripped = strategy.state.profitTripped === true;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    return {
        day: day.day, variant: v.name, net: round2(realized + unrealized), realized, unrealized: round2(unrealized), grossWin: round2(grossWin), grossLoss: round2(grossLoss), legs,
        stops, extraLegs, extraPnl: round2(extraPnl), maxDrawdown: round2(maxDd), stalledHedges: stalled, tripped, openAtEnd: mock.openTrades.size,
    };
}

async function main() {
    Log.log = () => { /* silence the strategy's per-order lines */ };
    const S_LIST = [10, 20, 30, 40, 50, 60, 80], SLIPS = [0, 2, 4], MODES: Variant['mode'][] = ['i', 'ii', 'iii'];
    const profitCfg = Number((configService.getStrategyConfig('SimpleContinuousStrategy') as any).maxProfit);
    // The config's cap trips on the first two winners of most days and ends the day (no stop ever matters), so the grid runs uncapped; the capped baseline is kept for reference.
    const scenarios = [{ label: 'nocap', maxProfit: 1e9 }];
    const variants: Variant[] = [{ name: `cap${profitCfg}|base`, S: 0, mode: 'i', slip: 0, maxProfit: profitCfg }];
    for (const sc of scenarios) {
        variants.push({ name: `${sc.label}|base`, S: 0, mode: 'i', slip: 0, maxProfit: sc.maxProfit });
        for (const S of S_LIST) for (const mode of MODES) for (const slip of SLIPS) variants.push({ name: `${sc.label}|S${S}|${mode}|slip${slip}`, S, mode, slip, maxProfit: sc.maxProfit });
    }
    const days = discoverDayFolders(ALL_DAYS_DIR).filter((d) => ONLY_DAYS.length === 0 || ONLY_DAYS.includes(d.day));
    const all: RunResult[] = [];
    for (const d of days) {
        const t0 = Date.now();
        const data = loadDay(d); if (!data) { console.error(`[${d.day}] skipped (no ticks / Pcr.csv)`); continue; }
        for (const v of variants) all.push(await runVariant(data, v));
        console.error(`[${d.day}] ${variants.length} runs in ${Math.round((Date.now() - t0) / 1000)}s`);
        if (OUT_FILE) fs.writeFileSync(OUT_FILE, JSON.stringify(all));
    }
    if (OUT_FILE) fs.writeFileSync(OUT_FILE, JSON.stringify(all));
    console.log(`runs=${all.length}`);
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
