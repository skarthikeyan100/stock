/**
 * Backtest of MandWStrategy on ONE day of stored ticks (default: the latest day found under --allDays). One simulated broker: the strategy is
 * one per-broker instance, exactly as in production (each broker acts on its own), so the result is per broker.
 *
 * Replay: the day's NIFTY ticks go to processNiftyQuote and the day's NIFTY option ticks to processOptionQuote (the watch of a sold contract
 * and the tick stop both run from them). The clock (Date / moment) is the tick time, so startTime, lastEntryTime, the pattern timeout, the
 * entry timeout and the end-of-day close all behave as live.
 *
 * Simulated broker: a limit buy fills at its limit on the first later tick at or below it; a resting target sell fills at its limit on the
 * first tick at or above it; the tick stop and the end-of-day close sell at the last tick price (no slippage, spread or brokerage). There is
 * no broker-side GTT here: attachProtection is refused, so the strategy takes its self-managed path (resting target sell + tick stop).
 * The global profit cap (settings.maxProfit) is simulated: when realized + open P&L reaches it, the open position is sold at the last tick
 * price and nothing more is bought (live, the monitor places a limit sell that locks the cap and the order process refuses new buys).
 *
 * Usage: tsc && MOCK_BROKER=true node ./dist/tools/MandWBacktest.js [--allDays <dir>] [--day Nov-13] [--startSide CE] [--startTime 09:20]
 *        [--target 10] [--stopLoss 10] [--timeout 30] [--quantity 65] [--maxProfit 5000] [--out report.html] [--verbose]
 */
import '../util/tz';
import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import { settingFor } from '../prism/configVocabulary';
import Log from '../util/Log';
import MandWStrategy from '../strategy/MandWStrategy';
import { getArg, getFlag, loadNiftyTicks, loadNiftyOptionTicks, buildContractDirectory, contractKey, fmtTime, round2, discoverDayFolders } from './backtestCsvUtils';
const tokenRouter = require('../processes/strategies/tokenRouter');
const latch = require('../strategy/globalMaxProfitLatch');

const VERBOSE = getFlag('verbose');
const DEBUG = !!process.env.MW_DEBUG;
const ALL_DAYS_DIR = getArg('allDays', fs.existsSync('/home/karthikeyan/later/data/backups') ? '/home/karthikeyan/later/data/backups' : '/home/karthikeyan/work/data/backups');
const STATE_FILE = path.join('/tmp', `mandw-backtest-${process.pid}.json`);

// ---- the clock: Date / moment read the tick time ----
const RealDate = Date;
let fakeNow = 0;
class FakeDate extends RealDate {
    constructor(...a: any[]) { super(...((a.length ? a : [fakeNow]) as [any])); }
    static now(): number { return fakeNow; }
}

interface Fill { tsym: string; qty: number; price: number; at: number }
interface Row { tsym: string; qty: number; buyAt: number; buyPx: number; sellAt: number | null; sellPx: number; why: string; pnl: number; total: number }

async function main() {
    const days = discoverDayFolders(ALL_DAYS_DIR);
    if (days.length === 0) throw new Error(`no day folders under ${ALL_DAYS_DIR}`);
    const want = getArg('day', '');
    const d = want ? days.find((x) => x.day === want) : days[days.length - 1]; // discoverDayFolders sorts by date: the last is the latest
    if (!d) throw new Error(`day ${want} not found under ${ALL_DAYS_DIR} (have ${days.map((x) => x.day).join(', ')})`);
    console.error(`Day ${d.day}: ${d.niftyFile}`);

    const niftyTicks = loadNiftyTicks(d.niftyFile);
    const optionTicks = loadNiftyOptionTicks(d.optionFile);
    if (!niftyTicks.length || !optionTicks.length) throw new Error('no ticks');
    const dir = buildContractDirectory(optionTicks);
    const byToken = new Map<string, { key: string; tsym: string }>();
    for (const [key, c] of dir) byToken.set(c.token, { key, tsym: c.tsym });
    console.error(`NIFTY ticks ${niftyTicks.length}, option ticks ${optionTicks.length}, contracts ${dir.size} (${[...dir.keys()].join(' ')})`);

    // ---- the clock ----
    fakeNow = niftyTicks[0].ltt;
    (global as any).Date = FakeDate;
    const dayStart = moment(fakeNow).startOf('day').add(9, 'hours');
    MandWStrategy.processStartedAt = dayStart.clone().subtract(30, 'minutes');

    // ---- the instance ----
    const cap = Number(getArg('maxProfit', '') || (configService.getConfig().settings as any)?.maxProfit || 0);
    const cfg: any = {
        type: 'MandWStrategy', userId: 'MandW-Backtest', enabled: true, quantity: Number(getArg('quantity', '65')),
        startSide: getArg('startSide', 'CE').toUpperCase(), startTime: getArg('startTime', '09:20'),
        target: Number(getArg('target', '10')), stopLoss: Number(getArg('stopLoss', '10')),
        patternTimeoutMinutes: Number(getArg('timeout', '30')), lastEntryTime: getArg('lastEntryTime', '15:00'), brokers: ['kite'], index: 'NIFTY',
    };
    const settings = configService.getConfig().settings as any;
    const strategy: any = new MandWStrategy(cfg.userId);
    strategy.enabled = true;
    strategy.stateLoaded = true;
    strategy.cfg = () => cfg;
    strategy.setting = (key: string) => settingFor(cfg, settings, key);
    strategy.stateFile = () => STATE_FILE;
    try { fs.unlinkSync(STATE_FILE); } catch { /* none */ }
    console.error(`Config: ${JSON.stringify(cfg)} maxProfit=${cap} eodCloseTime=${settings?.eodCloseTime ?? 'default'} entryTimeoutMinutes=${settings?.entryTimeoutMinutes ?? '-'}`);

    // ---- the simulated broker ----
    const latest = new Map<string, number>(); // contract key -> last price
    const pendingBuys = new Map<string, { orderId: string; tsym: string; token: string; qty: number; limit: number }>();
    const restingSells = new Map<string, { token: string; tsym: string; qty: number; price: number }>(); // by tsym
    let open: { tsym: string; token: string; qty: number; price: number; at: number } | null = null;
    const rows: Row[] = [];
    let realized = 0, seq = 0, tripped = false, trippedAt = 0, peak = -Infinity, trough = Infinity;
    const events: string[] = [];
    const lastPrice = (token: string) => latest.get(byToken.get(token)?.key ?? '');
    const sellOpen = async (price: number, why: string) => {
        if (!open) return;
        const o = open;
        open = null;
        const pnl = (price - o.price) * o.qty;
        realized += pnl;
        rows.push({ tsym: o.tsym, qty: o.qty, buyAt: o.at, buyPx: o.price, sellAt: fakeNow, sellPx: price, why, pnl: round2(pnl), total: round2(realized) });
        restingSells.delete(o.tsym);
        await strategy.updateTrade({ tsym: o.tsym, broker: 'kite', action: 'Sell', quantity: o.qty, price, brokerOrderId: `S${++seq}` });
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
                case 'brokerPlaceLimitSellBare': {
                    const p = a[1];
                    restingSells.set(p.tradingSymbol, { token: p.instrumentToken, tsym: p.tradingSymbol, qty: p.quantity, price: p.price });
                    return { orderId: `S${++seq}` };
                }
                case 'cancelRestingLimitSells': restingSells.delete(a[1].tradingSymbol); return { filledQty: 0, cancelFailed: false };
                case 'cancelRestingLimitBuys':
                    for (const [id, b] of pendingBuys) if (b.tsym === a[1].tradingSymbol) pendingBuys.delete(id);
                    return { filledQty: 0, cancelFailed: false };
                case 'chunkedSquareOff': {
                    const tsym = a[1].tradingSymbol;
                    const tok = open && open.tsym === tsym ? open.token : undefined;
                    const p = tok ? lastPrice(tok) : undefined;
                    if (p == null) throw new Error(`nothing to sell / no price for ${tsym}`);
                    await sellOpen(p, openWhy);
                    return { quantity: a[1].quantity };
                }
                default: return {};
            }
        },
    });
    (OrderClient as any).getInstance = () => client;
    tokenRouter.watchTokenOnSource = () => {};
    tokenRouter.unwatchTokenOnSource = () => {};
    latch.isGlobalMaxProfitLatched = async () => tripped;
    let openWhy = 'closed by the strategy';

    // Strategy log lines (pattern / flip / watch events), stamped with the simulated time.
    const realLog = Log.log;
    (Log as any).log = (...a: any[]) => {
        const msg = a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
        if (!msg.includes('[MandW:')) return;
        const line = `${fmtTime(fakeNow)} ${msg.replace(/^\[MandW:[^\]]*\]\s*/, '')}`;
        events.push(line);
        if (/STOP hit/.test(msg)) openWhy = 'tick stop (market sell at the tick that crossed it)';
        else if (/closing .* \(end of day\)/.test(msg)) openWhy = 'end-of-day close';
        else if (/closing /.test(msg)) openWhy = msg.replace(/^.*\(([^)]*)\).*$/, '$1');
        if (VERBOSE) console.error(line);
    };

    const markTotal = () => realized + (open ? ((lastPrice(open.token) ?? open.price) - open.price) * open.qty : 0);
    if (DEBUG) console.error('entering loop');
    let i = 0, j = 0;
    const wall = RealDate.now();
    try {
        while (i < niftyTicks.length || j < optionTicks.length) {
            const n = niftyTicks[i], o = optionTicks[j];
            if (o === undefined || (n !== undefined && n.ltt <= o.ltt)) {
                fakeNow = n.ltt;
                if (DEBUG && i < 3) console.error('nifty tick', i, n.ltp);
                await strategy.processNiftyQuote({ ltp: n.ltp, token: 'NIFTY', ltt: String(Math.floor(n.ltt / 1000)), prevClose: n.ltp });
                i++;
            } else {
                fakeNow = o.ltt;
                if (DEBUG && j < 3) console.error('option tick', j, o.ltp);
                const key = contractKey(o.strike, o.optionType);
                const c = dir.get(key)!;
                if (!Number.isNaN(o.ltp) && o.ltp > 0) latest.set(key, o.ltp);
                // a resting limit buy fills at its limit on the first later tick at or below it
                for (const [id, b] of pendingBuys) {
                    if (b.token === c.token && o.ltp > 0 && o.ltp <= b.limit) {
                        pendingBuys.delete(id);
                        open = { tsym: b.tsym, token: b.token, qty: b.qty, price: b.limit, at: fakeNow };
                        await strategy.updateTrade({ tsym: b.tsym, broker: 'kite', action: 'Buy', quantity: b.qty, price: b.limit, brokerOrderId: id });
                    }
                }
                // a resting target sell fills at its limit on the first tick at or above it
                const rest = restingSells.get(c.tsym);
                if (rest && open && open.tsym === c.tsym && o.ltp >= rest.price) await sellOpen(rest.price, 'resting limit sell filled at the target');
                const oq = { token: c.token, ltp: o.ltp, ltt: String(Math.floor(o.ltt / 1000)) };
                if (strategy.canHandleOptionQuote(oq)) await strategy.processOptionQuote(oq);
                j++;
            }
            if ((i + j) % 50000 === 0) console.error(`  progress ${i}/${niftyTicks.length} nifty, ${j}/${optionTicks.length} option, ${fmtTime(fakeNow)}, ${((RealDate.now() - wall) / 1000).toFixed(1)}s`);
            const total = markTotal();
            if (total > peak) peak = total;
            if (total < trough) trough = total;
            if (cap > 0 && !tripped && total >= cap) {
                tripped = true;
                trippedAt = fakeNow;
                events.push(`${fmtTime(fakeNow)} SIMULATED MAX PROFIT TRIPPED: total ${round2(total)} >= ${cap} - the open position is sold at the last price, no further buys`);
                for (const [id] of pendingBuys) pendingBuys.delete(id);
                openWhy = 'max profit cap (simulated)';
                await sellOpen(lastPrice(open ? (open as any).token : '') ?? 0, openWhy).catch(() => {});
            }
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
    const out = getArg('out', '') || path.join(__dirname, `../../backtest-MandW-${d.day}.html`);
    fs.writeFileSync(out, report(d.day, cfg, cap, rows, events, { net, realized: round2(realized), unrealized: round2(unrealized), peak, trough, tripped, trippedAt, wins, first: niftyTicks[0].ltt, last: niftyTicks[niftyTicks.length - 1].ltt }));
    console.log(`${out}  (${d.day}: ${rows.length} trades, ${wins} winners, realized ${round2(realized)}, open ${round2(unrealized)}, net ${net}, peak ${round2(peak)}, lowest ${round2(trough)}${tripped ? ', max profit tripped at ' + fmtTime(trippedAt) : ''})`);
    process.exit(0);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fm = (x: number) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cl = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

function report(day: string, cfg: any, cap: number, rows: Row[], events: string[], s: any): string {
    const p: string[] = [];
    p.push(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MandWStrategy backtest ${day}</title><style>
body{font:14px system-ui,sans-serif;margin:16px;color:#1b1f24;background:#fff}h1{font-size:20px}h2{font-size:16px;margin-top:24px}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;white-space:nowrap}td.w{white-space:normal}th{background:#f6f8fa}
.n{text-align:right;font-variant-numeric:tabular-nums}.pos{color:#1a7f37}.neg{color:#cf222e}pre{white-space:pre-wrap;line-height:1.45;font-size:13px}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{background:#161b22}th,td{border-color:#30363d}.pos{color:#3fb950}.neg{color:#f85149}}</style></head><body>`);
    p.push(`<h1>MandWStrategy backtest: ${day}, ${fmtTime(s.first)} to ${fmtTime(s.last)}</h1><p>One broker (each broker is its own instance). Config: ${esc(JSON.stringify({ ...cfg, userId: undefined, type: undefined, enabled: undefined }))}; global maxProfit ${cap || 'off'}.</p>`);
    p.push(`<p>${rows.length} trades, ${s.wins} winners. Realized <b class="${cl(s.realized)}">${fm(s.realized)}</b>, open at the last tick <b class="${cl(s.unrealized)}">${fm(s.unrealized)}</b>, net <b class="${cl(s.net)}">${fm(s.net)}</b>. Peak total ${fm(s.peak)}, lowest ${fm(s.trough)}.${s.tripped ? ` Max profit tripped at ${fmtTime(s.trippedAt)} (simulated).` : ''}</p>`);
    p.push(`<h2>Trades</h2><div class="scroll"><table><thead><tr><th>#</th><th>Contract</th><th class="n">Qty</th><th>Buy time</th><th class="n">Buy</th><th>Sell time</th><th class="n">Sell</th><th>Exit</th><th class="n">P&amp;L</th><th class="n">Cumulative</th></tr></thead><tbody>`);
    rows.forEach((r, k) => p.push(`<tr><td>${k + 1}</td><td>${esc(r.tsym)}</td><td class="n">${r.qty}</td><td>${fmtTime(r.buyAt)}</td><td class="n">${r.buyPx.toFixed(2)}</td><td>${r.sellAt ? fmtTime(r.sellAt) : 'open'}</td><td class="n">${r.sellPx.toFixed(2)}</td><td class="w">${esc(r.why)}</td><td class="n ${cl(r.pnl)}">${fm(r.pnl)}</td><td class="n ${cl(r.total)}">${fm(r.total)}</td></tr>`));
    p.push(`</tbody></table></div><h2>Strategy events (pattern / flip / watch)</h2><pre>${esc(events.join('\n'))}</pre>`);
    p.push(`<h2>Notes</h2><ul><li>Real stored ticks of one day. Buys are limit orders at the option's LTP and fill at the limit on the first later tick at or below it; the target is a resting limit sell filled at its limit on the first tick at or above it; the stop and the end-of-day close sell at the last tick price. No slippage, spread or brokerage; no broker-side GTT.</li><li>Only the strikes present in the stored OptionQuote data can be bought: a reversal whose ATM strike has no ticks is logged as "could not start entry".</li><li>The max profit cap is simulated by selling the open position at the last price when total P&amp;L reaches it.</li></ul></body></html>`);
    return p.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
