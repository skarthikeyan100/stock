/**
 * Replays a day's real tick data (Quote.csv NIFTY index ticks + OptionQuote.csv option ticks + Pcr.csv) through a live
 * SimpleContinuousStrategy instance with a broker mock. Manual backtest tool, not wired into trading.
 *
 * Differs from ContinuousStrategyBacktest because SimpleContinuous works through resting limit SELLS and market buys:
 *  - a buy fills at the last known tick price of the contract (no slippage, no spread);
 *  - a resting sell fills at its LIMIT price on the first tick with ltp >= limit (the limit is the entry + priceDiff);
 *  - PCR comes from Pcr.csv: the latest row fetched at or before the simulated time (none yet = no entry, as live);
 *  - Date.now() is replaced by the simulated tick time, so the strategy's 5 s / 10 s / 30 s retry timers run on market time;
 *  - nothing closes at the end of the day (MOCK_BROKER disables the EOD close): open legs are reported at their last price.
 * Every config.yml field of the first SimpleContinuousStrategy block is used as-is except `enabled` (forced true) and
 * `brokers` (one simulated broker). Caveat: the contract directory keys a contract by strike+right only, so a day that
 * ticks two expiries of the same strike uses the first tsym seen.
 *
 * Usage: tsc && MOCK_BROKER=true node ./dist/tools/SimpleContinuousBacktest.js --allDays <baseDir> [--verbose]
 *        (baseDir/<Mon-DD>/csv/{Quote,OptionQuote,Pcr}.csv; a day without Pcr.csv is skipped)
 *        [--maxProfit <rupees>] [--priceDiff <points>] [--maxInvestment <rupees>] override the config for the run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import SimpleContinuousStrategy from '../strategy/SimpleContinuousStrategy';
import { CALL, PUT } from '../constants';
import {
    getArg, getFlag, loadNiftyTicks, loadNiftyOptionTicks, buildContractDirectory, contractKey, fmtTime, round2,
    discoverDayFolders, BacktestOrderClient, ContractInfo,
} from './backtestCsvUtils';

const VERBOSE = getFlag('verbose');
const ALL_DAYS_DIR = getArg('allDays', '/home/karthikeyan/later/data/backups');
const STATE_FILE = path.join(__dirname, '../../.SimpleContinuousStrategy.Backtest.json');

interface PcrRow { at: number; pcr: number }

function loadPcr(file: string): PcrRow[] {
    const rows: any[] = parse(fs.readFileSync(file, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true });
    return rows
        .filter((r) => r.index === 'NIFTY' && r.pcr !== '' && r.pcr != null)
        .map((r) => ({ at: Date.parse(String(r.fetchedAt).replace(' ', 'T') + '+05:30'), pcr: Number(r.pcr) }))
        .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.pcr))
        .sort((a, b) => a.at - b.at);
}

interface RestingSell { orderId: string; tsym: string; token: string; quantity: number; price: number }

class SimpleBacktestClient extends BacktestOrderClient {
    sells = new Map<string, RestingSell>(); // token -> resting sell
    pcrRows: PcrRow[] = [];
    private seq = 0;
    constructor(private dir: Map<string, ContractInfo>) { super(dir, 'call'); }

    private tokenOfTsym(tsym: string): string | undefined {
        for (const c of this.dir.values()) if (c.tsym === tsym) return c.token;
        return undefined;
    }

    async getPCR(): Promise<number | null> {
        let v: number | null = null;
        for (const r of this.pcrRows) { if (r.at <= this.currentTime) v = r.pcr; else break; }
        return v;
    }

    async chunkedSquareOffLimit(_u: string, p: { tradingSymbol: string; instrumentId: string; quantity: number; price: number }): Promise<any> {
        const token = String(p.instrumentId);
        this.sells.set(token, { orderId: `SELL_${++this.seq}`, tsym: p.tradingSymbol, token, quantity: p.quantity, price: p.price });
        return { quantity: p.quantity };
    }

    async cancelRestingLimitSells(_u: string, p: { tradingSymbol: string }): Promise<{ filledQty: number; cancelFailed: boolean }> {
        const token = this.tokenOfTsym(p.tradingSymbol);
        if (token) this.sells.delete(token);
        return { filledQty: 0, cancelFailed: false };
    }

    async getPendingSells(_u: string, _b: string, tsym: string): Promise<{ quantity: number }[]> {
        const token = this.tokenOfTsym(tsym);
        const s = token ? this.sells.get(token) : undefined;
        return s ? [{ quantity: s.quantity }] : [];
    }

    async chunkedSquareOff(_u: string, p: { tradingSymbol: string; quantity: number }): Promise<any> {
        const token = this.tokenOfTsym(p.tradingSymbol);
        if (!token) throw new Error(`unknown contract ${p.tradingSymbol}`);
        const key = token.slice(4);
        const price = this.latestPrice.get(key);
        if (price == null) throw new Error(`No known price for ${p.tradingSymbol} at sell time`);
        this.closeLeg(token, price);
        return { quantity: p.quantity };
    }
}

interface DaySummary {
    day: string; trades: number; wins: number; losses: number; realized: number; unrealized: number; openAtEnd: number;
    legsBought: number; tripped: boolean; root: string; maxInvested: number;
}

async function runDay(niftyFile: string, optionFile: string, pcrFile: string, day: string): Promise<DaySummary | null> {
    const niftyTicks = loadNiftyTicks(niftyFile);
    const optionTicks = loadNiftyOptionTicks(optionFile);
    if (!niftyTicks.length || !optionTicks.length) { console.error(`[${day}] no ticks - skipped`); return null; }
    const dir = buildContractDirectory(optionTicks);
    const mock = new SimpleBacktestClient(dir);
    mock.pcrRows = loadPcr(pcrFile);
    (OrderClient as any).instance = mock;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }

    const strategy: any = new SimpleContinuousStrategy('Backtest');
    strategy.enabled = true;
    strategy.stateLoaded = true;

    const realNow = Date.now;
    Date.now = () => mock.currentTime || realNow();
    let legsBought = 0;
    let maxInvested = 0;
    const origBuy = mock.buyContractBare.bind(mock);
    mock.buyContractBare = async (...a: Parameters<typeof origBuy>) => { legsBought++; return origBuy(...a); };

    try {
        let i = 0, j = 0;
        while (i < niftyTicks.length || j < optionTicks.length) {
            const n = niftyTicks[i], o = optionTicks[j];
            if (o === undefined || (n !== undefined && n.ltt <= o.ltt)) {
                mock.currentTime = n.ltt;
                const q = new NiftyQuote(); q.ltp = n.ltp; q.token = 'NIFTY'; q.ltt = n.ltt;
                await strategy.processNiftyQuote(q);
                i++;
            } else {
                mock.currentTime = o.ltt;
                const key = contractKey(o.strike, o.optionType);
                if (!Number.isNaN(o.ltp)) mock.latestPrice.set(key, o.ltp);
                const c = dir.get(key)!;
                const rest = mock.sells.get(c.token);
                if (rest && o.ltp >= rest.price) {
                    mock.sells.delete(c.token);
                    mock.closeLeg(c.token, rest.price);
                    const t = new Trade();
                    t.tsym = rest.tsym; t.token = c.token; t.quantity = rest.quantity; t.price = rest.price; t.lastTradePrice = rest.price;
                    t.action = 'Sell'; t.status = 'COMPLETE'; t.user = 'Backtest';
                    await strategy.updateTrade(t);
                }
                const oq = new OptionQuote(); oq.ltp = o.ltp; oq.token = c.token; oq.ltt = o.ltt;
                if (strategy.canHandleOptionQuote(oq)) await strategy.processOptionQuote(oq);
                j++;
            }
            let inv = 0;
            for (const e of mock.openTrades.values()) inv += e.entryPrice * e.quantity;
            if (inv > maxInvested) maxInvested = inv;
        }
    } finally {
        Date.now = realNow;
    }

    const realized = round2(mock.closedTrades.reduce((s, t) => s + t.pnl, 0));
    let unrealized = 0;
    const open: string[] = [];
    for (const [token, e] of mock.openTrades) {
        const mark = mock.latestPrice.get(token.slice(4));
        if (mark != null) unrealized += (mark - e.entryPrice) * e.quantity;
        open.push(`${e.tsym} qty=${e.quantity} entry=${round2(e.entryPrice)} mark=${mark != null ? round2(mark) : 'n/a'}`);
    }
    const stats = strategy.getStats();
    const state = strategy.state;
    const rootLeg: any = Object.values(state.legs).find((l: any) => l.role === 'root');
    if (VERBOSE) {
        console.log(`\n=== SimpleContinuous ${day} (${fmtTime(niftyTicks[0].ltt)}-${fmtTime(niftyTicks[niftyTicks.length - 1].ltt)}) ===`);
        mock.closedTrades.forEach((t, k) => console.log(`${String(k + 1).padStart(3)} ${t.tsym.padEnd(20)} ${fmtTime(t.entryTime)} ${round2(t.entryPrice).toFixed(2).padStart(8)} -> ${fmtTime(t.exitTime)} ${round2(t.exitPrice).toFixed(2).padStart(8)} qty=${t.quantity} pnl=${round2(t.pnl)}`));
        open.forEach((l) => console.log(`  OPEN ${l}`));
    }
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    return {
        day, trades: mock.closedTrades.length, wins: stats.wins, losses: stats.losses, realized, unrealized: round2(unrealized),
        openAtEnd: open.length, legsBought, tripped: state.profitTripped === true,
        root: rootLeg ? `${rootLeg.right} ${rootLeg.tsym}` : '-', maxInvested: Math.round(maxInvested),
    };
}

async function main() {
    const ov = (k: string) => getArg(k, '');
    configService.config.strategies = (configService.config.strategies || []).map((s: any) =>
        s.type === 'SimpleContinuousStrategy'
            ? { ...s, enabled: true, ...(ov('maxProfit') ? { maxProfit: Number(ov('maxProfit')) } : {}), ...(ov('priceDiff') ? { priceDiff: Number(ov('priceDiff')) } : {}), ...(ov('maxInvestment') ? { maxInvestment: Number(ov('maxInvestment')) } : {}) }
            : s
    );
    const c: any = configService.getStrategyConfig('SimpleContinuousStrategy');
    console.error(`Config: maxInvestment=${c.maxInvestment} maxProfit=${c.maxProfit} priceDiff=${c.priceDiff} onePositionPerSide=${c.onePositionPerSide} (per simulated broker)`);

    const days = discoverDayFolders(ALL_DAYS_DIR);
    const out: DaySummary[] = [];
    for (const d of days) {
        const pcrFile = path.join(path.dirname(d.niftyFile), 'Pcr.csv');
        if (!fs.existsSync(pcrFile)) { console.error(`[${d.day}] no Pcr.csv - skipped`); continue; }
        const s = await runDay(d.niftyFile, d.optionFile, pcrFile, d.day);
        if (s) out.push(s);
    }
    console.log(`\n${'day'.padEnd(7)} ${'root'.padEnd(26)} ${'bought'.padStart(6)} ${'closed'.padStart(6)} ${'W/L'.padStart(7)} ${'realized'.padStart(10)} ${'unreal.'.padStart(10)} ${'total'.padStart(10)} ${'open'.padStart(4)} ${'maxInvested'.padStart(11)} trip`);
    for (const s of out) {
        console.log(`${s.day.padEnd(7)} ${s.root.padEnd(26)} ${String(s.legsBought).padStart(6)} ${String(s.trades).padStart(6)} ${(s.wins + '/' + s.losses).padStart(7)} ${s.realized.toFixed(0).padStart(10)} ${s.unrealized.toFixed(0).padStart(10)} ${(s.realized + s.unrealized).toFixed(0).padStart(10)} ${String(s.openAtEnd).padStart(4)} ${String(s.maxInvested).padStart(11)} ${s.tripped ? 'YES' : '-'}`);
    }
    const r = out.reduce((a, s) => a + s.realized, 0), u = out.reduce((a, s) => a + s.unrealized, 0);
    console.log(`TOTAL realized=${round2(r)} unrealized=${round2(u)} net=${round2(r + u)} over ${out.length} day(s)`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
