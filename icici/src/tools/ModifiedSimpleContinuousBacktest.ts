/**
 * Backtest of ModifiedSimpleContinuousStrategy (a clone of SimpleContinuousStrategy; see its header for the rules: root = initialQuantity,
 * scaled hedge quantity, no double-up, one fixed CE and PE contract per cycle, a profitable first order restarts the contract selection). Same replay engine as SimpleContinuousBacktest
 * (real ticks, buys fill at the last tick price, a resting sell fills at its limit on the first tick at or above it, PCR from Pcr.csv,
 * nothing closes at the end of the day: open legs are marked at their last price). Writes an HTML report with ONE ROW PER BUY FILL.
 *
 * Usage: tsc && MOCK_BROKER=true node ./dist/tools/ModifiedSimpleContinuousBacktest.js [--allDays <dir>] [--initialQuantity 65]
 *        [--priceDiff N] [--maxProfit N] [--maxInvestment N, default 200000] [--only Nov-12,Nov-06] [--out report.html] [--verbose]
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import Log from '../util/Log';
import ModifiedSimpleContinuousStrategy from '../strategy/ModifiedSimpleContinuousStrategy';
import {
    getArg, getFlag, loadNiftyTicks, loadNiftyOptionTicks, buildContractDirectory, contractKey, fmtTime, round2,
    discoverDayFolders, BacktestOrderClient, ContractInfo,
} from './backtestCsvUtils';

const VERBOSE = getFlag('verbose');
const ALL_DAYS_DIR = getArg('allDays', '/home/karthikeyan/later/data/backups');
const STATE_FILE = path.join(__dirname, '../../.ModifiedSimpleContinuousStrategy.Backtest.json');

interface PcrRow { at: number; pcr: number }
function loadPcr(file: string): PcrRow[] {
    const rows: any[] = parse(fs.readFileSync(file, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true });
    return rows.filter((r) => r.index === 'NIFTY' && r.pcr !== '' && r.pcr != null)
        .map((r) => ({ at: Date.parse(String(r.fetchedAt).replace(' ', 'T') + '+05:30'), pcr: Number(r.pcr) }))
        .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.pcr)).sort((a, b) => a.at - b.at);
}

interface RestingSell { orderId: string; tsym: string; token: string; quantity: number; price: number }

class SimpleBacktestClient extends BacktestOrderClient {
    sells = new Map<string, RestingSell>();
    pcrRows: PcrRow[] = [];
    private seq = 0;
    constructor(private dir: Map<string, ContractInfo>) { super(dir, 'call'); }
    private tokenOfTsym(tsym: string): string | undefined { for (const c of this.dir.values()) if (c.tsym === tsym) return c.token; return undefined; }
    async getPCR(): Promise<number | null> { let v: number | null = null; for (const r of this.pcrRows) { if (r.at <= this.currentTime) v = r.pcr; else break; } return v; }
    async chunkedSquareOffLimit(_u: string, p: { tradingSymbol: string; instrumentId: string; quantity: number; price: number }): Promise<any> {
        const token = String(p.instrumentId);
        this.sells.set(token, { orderId: `SELL_${++this.seq}`, tsym: p.tradingSymbol, token, quantity: p.quantity, price: p.price });
        return { quantity: p.quantity };
    }
    async cancelRestingLimitSells(_u: string, p: { tradingSymbol: string }): Promise<{ filledQty: number; cancelFailed: boolean }> {
        const token = this.tokenOfTsym(p.tradingSymbol); if (token) this.sells.delete(token); return { filledQty: 0, cancelFailed: false };
    }
    async getPendingSells(_u: string, _b: string, tsym: string): Promise<{ quantity: number }[]> {
        const token = this.tokenOfTsym(tsym); const s = token ? this.sells.get(token) : undefined; return s ? [{ quantity: s.quantity }] : [];
    }
    async chunkedSquareOff(_u: string, p: { tradingSymbol: string; quantity: number }): Promise<any> {
        const token = this.tokenOfTsym(p.tradingSymbol); if (!token) throw new Error(`unknown contract ${p.tradingSymbol}`);
        const price = this.latestPrice.get(token.slice(4)); if (price == null) throw new Error(`No known price for ${p.tradingSymbol} at sell time`);
        this.closeLeg(token, price); return { quantity: p.quantity };
    }
}

interface BuyFill { tsym: string; qty: number; price: number; at: number; reason: string }
interface Row {
    tsym: string; qty: number; buyAt: number; buyPx: number; buyReason: string;
    sellAt?: number; sellPx?: number; sellReason: string; pnl: number; realized: number; unreal: number;
}
interface DayResult { day: string; first: number; last: number; rows: Row[]; realized: number; unrealized: number; open: number; tripped: boolean; maxInvested: number; maxTotal: number; minTotal: number; maxTotalAt: number; pcr: number | null; root: string }

async function runDay(niftyFile: string, optionFile: string, pcrFile: string, day: string): Promise<DayResult | null> {
    const niftyTicks = loadNiftyTicks(niftyFile);
    const optionTicks = loadNiftyOptionTicks(optionFile);
    if (!niftyTicks.length || !optionTicks.length) { console.error(`[${day}] no ticks - skipped`); return null; }
    const dir = buildContractDirectory(optionTicks);
    const mock = new SimpleBacktestClient(dir);
    mock.pcrRows = loadPcr(pcrFile);
    (OrderClient as any).instance = mock;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }

    const strategy: any = new ModifiedSimpleContinuousStrategy('Backtest');
    strategy.enabled = true;
    strategy.stateLoaded = true;

    const realNow = Date.now;
    Date.now = () => mock.currentTime || realNow();

    // Buy fills in order, and the strategy's own log events (root / hedged / doubled) in order: the k-th buy pairs with the k-th event.
    const buys: BuyFill[] = [];
    const events: string[] = [];
    let roots = 0;
    const logLines: string[] = [];
    const realLog = Log.log;
    (Log as any).log = (...a: any[]) => {
        const msg = a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        if (VERBOSE) logLines.push(`${fmtTime(mock.currentTime)} ${msg}`);
        const m = msg.match(/\] (root (CE|PE) \S+|hedged \S+ \((.*?)\) with \S+|added to \S+)/);
        if (m) {
            if (m[1].startsWith('root')) {
                roots++;
                events.push(roots === 1 ? 'Root entry: PCR direction, initialQuantity' : 'New root: the first order made its target with no hedge, so the contract selection ran again (PCR direction, ATM pick)');
            } else if (m[1].startsWith('hedged')) {
                const why = m[3];
                const from = msg.match(/hedged (\S+)/)![1];
                events.push(why === 'target met' ? `Same contract again after ${from} sold at a profit (quantity = initialQuantity)` : `${from} fell by priceDiff (${why}): buy the opposite contract, quantity scaled by the drop`);
            } else {
                const d = msg.match(/added to (\S+): \+(\d+) @\S+ \((\S+) fell/);
                events.push(`${d ? d[3] : 'The other leg'} fell by priceDiff: buy ${d ? d[1] : 'the opposite contract'} again (the same contract, added to its open leg; quantity scaled by the drop)`);
            }
        }
    };
    const origBuy = mock.buyContractBare.bind(mock);
    mock.buyContractBare = async (...a: Parameters<typeof origBuy>) => {
        const t = await origBuy(...a);
        buys.push({ tsym: String(a[1]), qty: Number(a[3]), price: Number(t.price), at: mock.currentTime, reason: '' });
        return t;
    };
    // Rows: split each close (the ledger blends adds) back into one row per buy fill since the previous close of that contract.
    const rows: Row[] = [];
    const since = new Map<string, BuyFill[]>(); // tsym -> buys since its last close
    let realized = 0;
    const unrealNow = (excludeTsym?: string): number => {
        let u = 0;
        for (const [token, e] of mock.openTrades) { if (e.tsym === excludeTsym) continue; const mk = mock.latestPrice.get(token.slice(4)); if (mk != null) u += (mk - e.entryPrice) * e.quantity; }
        return u;
    };
    const origClose = mock.closeLeg.bind(mock);
    mock.closeLeg = (token: string, price: number) => {
        const open = mock.openTrades.get(token);
        if (open) {
            const fills = since.get(open.tsym) ?? [];
            since.delete(open.tsym);
            const unreal = round2(unrealNow(open.tsym));
            let sumQ = 0; for (const f of fills) sumQ += f.qty;
            const use = sumQ === open.quantity && fills.length > 0 ? fills : [{ tsym: open.tsym, qty: open.quantity, price: open.entryPrice, at: open.entryTime, reason: 'blended (fills did not add up)' }];
            for (const f of use) {
                const pnl = (price - f.price) * f.qty;
                realized += pnl;
                rows.push({ tsym: open.tsym, qty: f.qty, buyAt: f.at, buyPx: f.price, buyReason: f.reason, sellAt: mock.currentTime, sellPx: price,
                    sellReason: price > f.price ? 'Resting limit sell filled at target (leg average + priceDiff)' : 'Resting sell of the blended leg (average + priceDiff) filled below this fill\'s own buy price', pnl: round2(pnl), realized: round2(realized), unreal });
            }
        }
        origClose(token, price);
    };

    let maxInvested = 0, maxTotal = -Infinity, minTotal = Infinity, maxTotalAt = 0;
    let buysSeen = 0;
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
            while (buysSeen < buys.length) { // attach the reason (the log event may land a moment after the buy returns) and index the fill
                const b = buys[buysSeen];
                if (events.length <= buysSeen) break;
                b.reason = events[buysSeen];
                const arr = since.get(b.tsym) ?? []; arr.push(b); since.set(b.tsym, arr);
                buysSeen++;
            }
            let inv = 0;
            for (const e of mock.openTrades.values()) inv += e.entryPrice * e.quantity;
            if (inv > maxInvested) maxInvested = inv;
            const total = realized + unrealNow();
            if (total > maxTotal) { maxTotal = total; maxTotalAt = mock.currentTime; }
            if (total < minTotal) minTotal = total;
        }
    } finally {
        Date.now = realNow;
        (Log as any).log = realLog;
    }

    // Open legs at the last tick: one row per buy fill, marked at the last price.
    let unrealized = 0;
    for (const [token, e] of mock.openTrades) {
        const mk = mock.latestPrice.get(token.slice(4));
        const fills = since.get(e.tsym) ?? [];
        let sumQ = 0; for (const f of fills) sumQ += f.qty;
        const use = sumQ === e.quantity && fills.length ? fills : [{ tsym: e.tsym, qty: e.quantity, price: e.entryPrice, at: e.entryTime, reason: 'blended (fills did not add up)' }];
        for (const f of use) {
            const pnl = mk != null ? (mk - f.price) * f.qty : 0;
            unrealized += pnl;
            rows.push({ tsym: e.tsym, qty: f.qty, buyAt: f.at, buyPx: f.price, buyReason: f.reason, sellAt: undefined, sellPx: mk, sellReason: 'STILL OPEN at the last tick (marked at the last price; the real strategy closes at eodCloseTime)', pnl: round2(pnl), realized: round2(realized), unreal: round2(unrealized) });
        }
    }
    if (VERBOSE) console.log(logLines.join('\n'));
    const root = rows.find((r) => r.buyReason.startsWith('Root'));
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    return {
        day, first: niftyTicks[0].ltt, last: niftyTicks[niftyTicks.length - 1].ltt, rows, realized: round2(realized), unrealized: round2(unrealized),
        open: mock.openTrades.size, tripped: strategy.state.profitTripped === true, maxInvested: Math.round(maxInvested),
        maxTotal: round2(maxTotal === -Infinity ? 0 : maxTotal), minTotal: round2(minTotal === Infinity ? 0 : minTotal), maxTotalAt, pcr: null, root: root ? root.tsym : '-',
    };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fm = (x: number) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cl = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function html(results: DayResult[], c: any): string {
    const tot = results.reduce((a, r) => a + r.realized + r.unrealized, 0);
    const parts: string[] = [];
    parts.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ModifiedSimpleContinuousStrategy backtest</title><style>
body{font:14px system-ui,sans-serif;margin:16px;color:#1b1f24;background:#fff}h1{font-size:20px}h2{font-size:16px;margin-top:28px}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;white-space:nowrap}td.rs{white-space:normal;min-width:260px}th{background:#f6f8fa}
.n{text-align:right;font-variant-numeric:tabular-nums}.pos{color:#1a7f37}.neg{color:#cf222e}tr.sub td{font-weight:600;background:#f6f8fa}ul.notes{line-height:1.5}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th,tr.sub td{background:#161b22}th,td{border-color:#30363d}.pos{color:#3fb950}.neg{color:#f85149}}</style></head><body>`);
    parts.push(`<h1>ModifiedSimpleContinuousStrategy: backtest on stored ticks</h1><p>Config: initialQuantity ${c.initialQuantity}, priceDiff ${c.priceDiff}, maxInvestment ${c.maxInvestment}, maxProfit ${c.maxProfit}, onePositionPerSide ${c.onePositionPerSide}. One simulated broker. Net over ${results.length} day(s): <b class="${cl(tot)}">${fm(tot)}</b></p>`);
    parts.push(`<div class="scroll"><table><thead><tr><th>Day</th><th>Root</th><th>Buys</th><th class="n">Realized</th><th class="n">Unrealized (open at last tick)</th><th class="n">Net</th><th class="n">Peak total P&amp;L</th><th>at</th><th class="n">Lowest total P&amp;L</th><th class="n">Peak cost of open legs</th><th>maxProfit tripped</th></tr></thead><tbody>`);
    for (const r of results) parts.push(`<tr><td>${r.day}</td><td>${esc(r.root)}</td><td class="n">${r.rows.length}</td><td class="n ${cl(r.realized)}">${fm(r.realized)}</td><td class="n ${cl(r.unrealized)}">${fm(r.unrealized)}</td><td class="n ${cl(r.realized + r.unrealized)}">${fm(r.realized + r.unrealized)}</td><td class="n">${fm(r.maxTotal)}</td><td>${fmtTime(r.maxTotalAt)}</td><td class="n">${fm(r.minTotal)}</td><td class="n">${fm(r.maxInvested)}</td><td>${r.tripped ? 'YES' : '-'}</td></tr>`);
    parts.push(`<tr class="sub"><td colspan="5">Total</td><td class="n ${cl(tot)}">${fm(tot)}</td><td colspan="5"></td></tr></tbody></table></div>`);
    const kind = (reason: string) => (reason.startsWith('Root') || reason.startsWith('New root') ? 'Root' : reason.startsWith('Same contract') ? 'Re-buy' : reason.includes('opposite') ? 'Hedge' : 'Add');
    for (const r of results) {
        // One leg = the buys of one contract that are sold together (same contract, same sell). Rows are the buys in time order with the leg's
        // running count / quantity / average / resting sell; the closing row carries the sell and the leg's P&L.
        const groups = new Map<string, Row[]>();
        for (const x of r.rows) { const k = `${x.tsym}|${x.sellAt ?? 'open'}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(x); }
        const legs = [...groups.values()].map((g) => g.sort((a, b) => a.buyAt - b.buyAt));
        const buysAll = r.rows.map((x) => ({ at: x.buyAt, sellAt: x.sellAt, cost: x.qty * x.buyPx }));
        const openCostAt = (t: number) => buysAll.filter((b) => b.at <= t && (b.sellAt == null || b.sellAt > t)).reduce((a, b) => a + b.cost, 0);
        const flat: { x: Row; n: number; N: number; cq: number; cc: number; last: boolean; legPnl: number }[] = [];
        for (const g of legs) {
            let cq = 0, cc = 0;
            const legPnl = g.reduce((a, x) => a + x.pnl, 0);
            g.forEach((x, i) => { cq += x.qty; cc += x.qty * x.buyPx; flat.push({ x, n: i + 1, N: g.length, cq, cc, last: i === g.length - 1, legPnl }); });
        }
        flat.sort((a, b) => a.x.buyAt - b.x.buyAt);
        parts.push(`<h2>${r.day}: ${fmtTime(r.first)} to ${fmtTime(r.last)}</h2><div class="scroll"><table><thead><tr><th>#</th><th>Contract</th><th>Type</th><th class="n">Buy no. in leg</th><th>Buy time</th><th class="n">Buy price</th><th class="n">Buy qty</th><th class="n">Buy cost</th><th class="n">Leg qty (cum.)</th><th class="n">Leg average</th><th class="n">Leg cost (cum.)</th><th class="n">Resting sell</th><th class="n">All open cost</th><th>Sell time</th><th class="n">Sell price</th><th class="n">Leg P&amp;L</th><th class="n">Realized (cumulative)</th></tr></thead><tbody>`);
        flat.forEach((f, i) => {
            const avg = f.cc / f.cq;
            const x = f.x;
            parts.push(`<tr><td>${i + 1}</td><td>${esc(x.tsym)}</td><td>${kind(x.buyReason)}</td><td class="n">${f.n} of ${f.N}</td><td>${fmtTime(x.buyAt)}</td><td class="n">${x.buyPx.toFixed(2)}</td><td class="n">${x.qty}</td><td class="n">${fm(x.qty * x.buyPx)}</td><td class="n">${f.cq}</td><td class="n">${avg.toFixed(2)}</td><td class="n">${fm(f.cc)}</td><td class="n">${(avg + Number(c.priceDiff)).toFixed(2)}</td><td class="n">${fm(openCostAt(x.buyAt))}</td>`
                + (f.last ? `<td>${x.sellAt ? fmtTime(x.sellAt) : 'open'}</td><td class="n">${x.sellPx != null ? x.sellPx.toFixed(2) : '-'}</td><td class="n ${cl(f.legPnl)}">${fm(f.legPnl)}</td><td class="n ${cl(x.realized)}">${fm(x.realized)}</td></tr>` : `<td></td><td></td><td></td><td></td></tr>`));
        });
        parts.push(`<tr class="sub"><td colspan="15">Day total (${r.rows.length} buys in ${legs.length} legs)</td><td class="n ${cl(r.realized + r.unrealized)}">${fm(r.realized + r.unrealized)}</td><td></td></tr></tbody></table></div>`);
    }
    parts.push(`<h2>Notes</h2><ul class="notes"><li>Ticks come from the stored backups. A leg is one contract's buys that are sold together: each row is one buy with the leg's running count, quantity, average and resting sell (average + priceDiff, re-placed after every add); the closing row shows the sale and the leg's total P&amp;L. Only days with Quote, OptionQuote and Pcr CSVs are replayed.</li><li>Buys fill at the last tick price of the contract and a resting sell at its limit on the first tick at or above it: no slippage, no spread, no brokerage. Nothing closes at the end of the day here: "STILL OPEN" rows are marked at the last tick.</li><li>"Peak total P&amp;L" is the maxProfit-style total (realized plus every open leg marked at the last tick), checked after every tick.</li><li>Unrealized (other legs) at an exit is the mark of the contracts still open at that moment, exact here because every tick is replayed.</li></ul></body></html>`);
    return parts.join('\n');
}

async function main() {
    const ov = (k: string) => getArg(k, '');
    const base: any = (configService.config.strategies || []).find((s: any) => s.type === 'SimpleContinuousStrategy');
    if (!base) throw new Error('no SimpleContinuousStrategy block in config.yml to copy the settings from');
    const block = {
        ...base, type: 'ModifiedSimpleContinuousStrategy', enabled: true, userId: 'ModifiedSimpleContinuousStrategy',
        initialQuantity: Number(ov('initialQuantity') || 65),
        ...(ov('maxProfit') ? { maxProfit: Number(ov('maxProfit')) } : {}), ...(ov('priceDiff') ? { priceDiff: Number(ov('priceDiff')) } : {}),
        maxInvestment: Number(ov('maxInvestment') || 200000), // honoured by every buy of the Modified strategy (user: 200000)
    };
    configService.config.strategies = [...(configService.config.strategies || []).filter((s: any) => s.type !== 'ModifiedSimpleContinuousStrategy'), block];
    const c: any = configService.getStrategyConfig('ModifiedSimpleContinuousStrategy');
    console.error(`Config: initialQuantity=${c.initialQuantity} maxInvestment=${c.maxInvestment} maxProfit=${c.maxProfit} priceDiff=${c.priceDiff} onePositionPerSide=${c.onePositionPerSide}`);

    const only = ov('only') ? new Set(ov('only').split(',')) : null;
    const results: DayResult[] = [];
    for (const d of discoverDayFolders(ALL_DAYS_DIR)) {
        if (only && !only.has(d.day)) continue;
        const pcrFile = path.join(path.dirname(d.niftyFile), 'Pcr.csv');
        if (!fs.existsSync(pcrFile)) { console.error(`[${d.day}] no Pcr.csv - skipped`); continue; }
        const r = await runDay(d.niftyFile, d.optionFile, pcrFile, d.day);
        if (r) { results.push(r); console.error(`[${d.day}] realized=${r.realized} unrealized=${r.unrealized} buys=${r.rows.length} peakTotal=${r.maxTotal}`); }
    }
    const out = ov('out') || path.join(__dirname, '../../backtest-ModifiedSimpleContinuous.html');
    fs.writeFileSync(out, html(results, c));
    console.log(`${out}  (${results.length} days, net ${round2(results.reduce((a, r) => a + r.realized + r.unrealized, 0))})`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
