/**
 * Backtest of HighLowStrategy on ONE day of stored ticks (default: the latest day under --allDays). One simulated broker (the config block's
 * broker, paper): the real strategy code runs; only the order client is simulated.
 *
 * Replay: the day's NIFTY ticks go to processNiftyQuote (they build the candles and fire the entry) and the day's option ticks to
 * processOptionQuote (the tick stop, the 5-minute checkpoint candles and the second target run from them). The clock (Date / moment) is the
 * tick time. Config comes from the HighLow block of config.yml (override: --target --stopLoss --quantity --candleMinutes --bodyDominance --closeLocation).
 *
 * Simulated broker: a limit buy fills at its limit on the first later tick at or below it; the checkpoint half sell, the stop, the second
 * target and the end-of-day close sell at the last tick price (no slippage, spread or brokerage). Only strikes present in the stored
 * OptionQuote data can be bought.
 *
 * Usage: tsc && MOCK_BROKER=true node ./dist/tools/HighLowBacktest.js [--allDays <dir>] [--day Nov-13] [--higherHighLow] [--confirmCandle] [--out report.html] [--verbose]
 */
import '../util/tz';
import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import Log from '../util/Log';
import HighLowStrategy from '../strategy/HighLowStrategy';
import { getArg, getFlag, loadNiftyTicks, loadNiftyOptionTicks, buildContractDirectory, contractKey, fmtTime, round2, discoverDayFolders } from './backtestCsvUtils';
const tokenRouter = require('../processes/strategies/tokenRouter');
const latch = require('../strategy/globalMaxProfitLatch');

const VERBOSE = getFlag('verbose');
const DEBUG = !!process.env.HL_DEBUG;
const ALL_DAYS_DIR = getArg('allDays', fs.existsSync('/home/karthikeyan/later/data/backups') ? '/home/karthikeyan/later/data/backups' : '/home/karthikeyan/work/data/backups');
const STATE_FILE = path.join('/tmp', `highlow-backtest-${process.pid}.json`);

// ---- the clock: Date / moment read the tick time ----
const RealDate = Date;
let fakeNow = 0;
class FakeDate extends RealDate {
    constructor(...a: any[]) { super(...((a.length ? a : [fakeNow]) as [any])); }
    static now(): number { return fakeNow; }
}

interface Row { tsym: string; qty: number; buyAt: number; buyPx: number; sellAt: number | null; sellPx: number; why: string; pnl: number; total: number }

async function main() {
    const days = discoverDayFolders(ALL_DAYS_DIR);
    if (days.length === 0) throw new Error(`no day folders under ${ALL_DAYS_DIR}`);
    const want = getArg('day', '');
    const d = want ? days.find((x) => x.day === want) : days[days.length - 1];
    if (!d) throw new Error(`day ${want} not found under ${ALL_DAYS_DIR} (have ${days.map((x) => x.day).join(', ')})`);
    console.error(`Day ${d.day}: ${d.niftyFile}`);

    const niftyTicks = loadNiftyTicks(d.niftyFile);
    const optionTicks = loadNiftyOptionTicks(d.optionFile);
    if (!niftyTicks.length || !optionTicks.length) throw new Error('no ticks');
    const dir = buildContractDirectory(optionTicks);
    const byToken = new Map<string, { key: string; tsym: string }>();
    for (const [key, c] of dir) byToken.set(c.token, { key, tsym: c.tsym });
    console.error(`NIFTY ticks ${niftyTicks.length}, option ticks ${optionTicks.length}, contracts ${dir.size}`);

    fakeNow = niftyTicks[0].ltt;
    (global as any).Date = FakeDate;

    const settings = configService.getConfig().settings as any;
    const block: any = (configService.getConfig().strategies as any[]).find((s) => s.type === 'HighLowStrategy');
    if (!block) throw new Error('no HighLowStrategy block in config.yml');
    const cfg: any = { ...block, userId: 'HighLow-Backtest', enabled: true };
    for (const k of ['target', 'stopLoss', 'quantity', 'candleMinutes', 'bodyDominance', 'closeLocation']) { const v = getArg(k, ''); if (v !== '') cfg[k] = Number(v); }
    for (const k of ['higherHighLow', 'confirmCandle']) { if (getFlag(k)) cfg[k] = true; if (getArg(k, '') === 'false') cfg[k] = false; }
    const brokerName = String((cfg.brokers && cfg.brokers[0]) || 'paper');
    const strategy: any = new HighLowStrategy(cfg.userId);
    strategy.enabled = true;
    strategy.stateLoaded = true;
    strategy.cfg = () => cfg;
    strategy.setting = (key: string) => settingFor(cfg, settings, key);
    strategy.stateFile = () => STATE_FILE;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    console.error(`Config: ${JSON.stringify(cfg)} eodCloseTime=${settings?.eodCloseTime ?? 'default'}`);

    const latest = new Map<string, number>();
    const pendingBuys = new Map<string, { orderId: string; tsym: string; token: string; qty: number; limit: number }>();
    let open: { tsym: string; token: string; qty: number; price: number; at: number } | null = null;
    const rows: Row[] = [];
    let realized = 0, seq = 0, peak = -Infinity, trough = Infinity;
    const events: string[] = [];
    let why = 'closed by the strategy';
    const lastPrice = (token: string) => latest.get(byToken.get(token)?.key ?? '');
    const sell = async (qty: number, price: number, reason: string) => {
        if (!open) return;
        const q = Math.min(qty, open.qty);
        const pnl = (price - open.price) * q;
        realized += pnl;
        rows.push({ tsym: open.tsym, qty: q, buyAt: open.at, buyPx: open.price, sellAt: fakeNow, sellPx: price, why: reason, pnl: round2(pnl), total: round2(realized) });
        const o = open;
        open = o.qty - q > 0 ? { ...o, qty: o.qty - q } : null;
        await strategy.updateTrade({ tsym: o.tsym, broker: brokerName, action: 'Sell', quantity: q, price, brokerOrderId: `S${++seq}` });
    };
    const client: any = new Proxy({}, {
        get: (_t, fn: string) => async (...a: any[]) => {
            switch (fn) {
                case 'resolveOptionContract': {
                    const c = dir.get(contractKey(a[1].strike, a[1].right));
                    if (!c) throw new Error(`no ticks for ${a[1].strike}${a[1].right} in the stored data`);
                    return { tsym: c.tsym, token: c.token, exchange: 'NFO' };
                }
                case 'getOptionLtp': {
                    const p = lastPrice(a[1].token);
                    if (!(p! > 0)) throw new Error(`no price yet for ${a[1].tradingSymbol}`);
                    return p;
                }
                case 'placeLimitBuyBare': {
                    const orderId = `B${++seq}`;
                    pendingBuys.set(orderId, { orderId, tsym: a[1], token: a[2], qty: a[3], limit: a[4] });
                    return { orderId };
                }
                case 'attachProtection': throw new Error('no broker-side protection in the backtest');
                case 'brokerPlaceLimitSellBare': throw new Error('HighLow places no resting sells');
                case 'cancelRestingLimitSells': return { filledQty: 0, cancelFailed: false };
                case 'cancelRestingLimitBuys':
                    for (const [id, b] of pendingBuys) if (b.tsym === a[1].tradingSymbol) pendingBuys.delete(id);
                    return { filledQty: 0, cancelFailed: false };
                case 'chunkedSquareOff': {
                    const tsym = a[1].tradingSymbol;
                    const p = open && open.tsym === tsym ? lastPrice(open.token) : undefined;
                    if (p == null) throw new Error(`nothing to sell / no price for ${tsym}`);
                    await sell(a[1].quantity, p, why);
                    return { quantity: a[1].quantity };
                }
                default: return {};
            }
        },
    });
    (OrderClient as any).getInstance = () => client;
    tokenRouter.watchTokenOnSource = () => {};
    tokenRouter.unwatchTokenOnSource = () => {};
    latch.isGlobalMaxProfitLatched = async () => false;

    const realLog = Log.log;
    (Log as any).log = (...a: any[]) => {
        const msg = a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        if (!msg.includes('[HighLow:')) return;
        const line = `${fmtTime(fakeNow)} ${msg.replace(/^\[HighLow:[^\]]*\]\s*/, '')}`;
        events.push(line);
        if (/STOP hit/.test(msg)) why = 'stop (tick at or below the stop)';
        else if (/SECOND TARGET/.test(msg)) why = 'second target';
        else if (/CHECKPOINT:/.test(msg)) why = 'checkpoint: half sold at market';
        else if (/closing .* \(end of day\)/.test(msg)) why = 'end-of-day close';
        else if (/closing /.test(msg)) why = msg.replace(/^.*\(([^)]*)\).*$/, '$1');
        if (VERBOSE) console.error(line);
    };

    const markTotal = () => realized + (open ? ((lastPrice(open.token) ?? open.price) - open.price) * open.qty : 0);
    let i = 0, j = 0;
    const wall = RealDate.now();
    try {
        while (i < niftyTicks.length || j < optionTicks.length) {
            const n = niftyTicks[i], o = optionTicks[j];
            if (o === undefined || (n !== undefined && n.ltt <= o.ltt)) {
                fakeNow = n.ltt;
                await strategy.processNiftyQuote({ ltp: n.ltp, token: 'NIFTY', ltt: String(Math.floor(n.ltt / 1000)), prevClose: n.ltp });
                i++;
            } else {
                fakeNow = o.ltt;
                const key = contractKey(o.strike, o.optionType);
                const c = dir.get(key)!;
                if (!Number.isNaN(o.ltp) && o.ltp > 0) latest.set(key, o.ltp);
                for (const [id, b] of pendingBuys) {
                    if (b.token === c.token && o.ltp > 0 && o.ltp <= b.limit) {
                        pendingBuys.delete(id);
                        open = { tsym: b.tsym, token: b.token, qty: b.qty, price: b.limit, at: fakeNow };
                        await strategy.updateTrade({ tsym: b.tsym, broker: brokerName, action: 'Buy', quantity: b.qty, price: b.limit, brokerOrderId: id });
                    }
                }
                const oq = { token: c.token, ltp: o.ltp, ltt: String(Math.floor(o.ltt / 1000)) };
                if (strategy.canHandleOptionQuote(oq)) await strategy.processOptionQuote(oq);
                j++;
            }
            if ((i + j) % 100000 === 0) console.error(`  progress ${i}/${niftyTicks.length} nifty, ${j}/${optionTicks.length} option, ${fmtTime(fakeNow)}, ${((RealDate.now() - wall) / 1000).toFixed(1)}s`);
            const total = markTotal();
            if (total > peak) peak = total;
            if (total < trough) trough = total;
        }
    } finally {
        (global as any).Date = RealDate;
        (Log as any).log = realLog;
    }

    let unrealized = 0;
    if (open) {
        const o: any = open;
        const mk = lastPrice(o.token) ?? o.price;
        unrealized = (mk - o.price) * o.qty;
        rows.push({ tsym: o.tsym, qty: o.qty, buyAt: o.at, buyPx: o.price, sellAt: null, sellPx: mk, why: 'STILL OPEN at the last tick', pnl: round2(unrealized), total: round2(realized + unrealized) });
    }
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }

    const net = round2(realized + unrealized);
    const wins = rows.filter((r) => r.pnl > 0).length;
    const out = getArg('out', '') || path.join(__dirname, `../../backtest-HighLow-${d.day}.html`);
    fs.writeFileSync(out, report(d.day, cfg, rows, events, { net, realized: round2(realized), unrealized: round2(unrealized), peak, trough, wins, first: niftyTicks[0].ltt, last: niftyTicks[niftyTicks.length - 1].ltt }));
    console.log(`${out}  (${d.day}: ${rows.length} sells, ${wins} winners, realized ${round2(realized)}, open ${round2(unrealized)}, net ${net}, peak ${round2(peak)}, lowest ${round2(trough)})`);
    process.exit(0);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fm = (x: number) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cl = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function report(day: string, cfg: any, rows: Row[], events: string[], s: any): string {
    const p: string[] = [];
    p.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HighLowStrategy backtest ${day}</title><style>
body{font:14px system-ui,sans-serif;margin:16px;color:#1b1f24;background:#fff}h1{font-size:20px}h2{font-size:16px;margin-top:24px}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;white-space:nowrap}td.w{white-space:normal}th{background:#f6f8fa}
.n{text-align:right;font-variant-numeric:tabular-nums}.pos{color:#1a7f37}.neg{color:#cf222e}pre{white-space:pre-wrap;line-height:1.45;font-size:13px}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{background:#161b22}th,td{border-color:#30363d}.pos{color:#3fb950}.neg{color:#f85149}}</style></head><body>`);
    p.push(`<h1>HighLowStrategy backtest: ${day}, ${fmtTime(s.first)} to ${fmtTime(s.last)}</h1><p>One broker (each broker is its own instance). Config: ${esc(JSON.stringify({ ...cfg, userId: undefined, type: undefined, enabled: undefined }))}.</p>`);
    p.push(`<p>${rows.length} trades, ${s.wins} winners. Realized <b class="${cl(s.realized)}">${fm(s.realized)}</b>, open at the last tick <b class="${cl(s.unrealized)}">${fm(s.unrealized)}</b>, net <b class="${cl(s.net)}">${fm(s.net)}</b>. Peak total ${fm(s.peak)}, lowest ${fm(s.trough)}.</p>`);
    p.push(`<h2>Trades</h2><div class="scroll"><table><thead><tr><th>#</th><th>Contract</th><th class="n">Qty</th><th>Buy time</th><th class="n">Buy</th><th>Sell time</th><th class="n">Sell</th><th>Exit</th><th class="n">P&amp;L</th><th class="n">Cumulative</th></tr></thead><tbody>`);
    rows.forEach((r, k) => p.push(`<tr><td>${k + 1}</td><td>${esc(r.tsym)}</td><td class="n">${r.qty}</td><td>${fmtTime(r.buyAt)}</td><td class="n">${r.buyPx.toFixed(2)}</td><td>${r.sellAt ? fmtTime(r.sellAt) : 'open'}</td><td class="n">${r.sellPx.toFixed(2)}</td><td class="w">${esc(r.why)}</td><td class="n ${cl(r.pnl)}">${fm(r.pnl)}</td><td class="n ${cl(r.total)}">${fm(r.total)}</td></tr>`));
    p.push(`</tbody></table></div><h2>Strategy events (candles / entries / exits)</h2><pre>${esc(events.join('\n'))}</pre>`);
    p.push(`<h2>Notes</h2><ul><li>Real stored ticks of one day. Buys are limit orders at the option's LTP and fill at the limit on the first later tick at or below it; the checkpoint half sell, the second target, the stop and the end-of-day close sell at the last tick price. No slippage, spread or brokerage; no broker-side GTT.</li><li>Only the strikes present in the stored OptionQuote data can be bought.</li></ul></body></html>`);
    return p.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
