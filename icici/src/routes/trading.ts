import Log from '../util/Log';
import express from 'express';
import { Trade } from '../model/model';
import configService from '../prism/ConfigService';
import { computePnlSummary, periodFromInputs } from '../payout';
import Mongo from '../tools/mongo';
import ANT from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import { CanonicalSymbol, formatCanonicalSymbol, parseCanonicalSymbol } from '../model/CanonicalSymbol';
import { exchangeForIndex } from '../util/underlyings';
import OrderClient from '../processes/strategies/OrderClient';
import { asyncRouter } from './asyncRouter';
import { isOpenedToday, openedFilterOf } from '../util/openedToday';
import { closedTradeRows } from '../util/closedTradeRows';
import { requireCsrfHeader, resolveUser, requireAuth, requireAdmin } from './session';

const router = asyncRouter();
const orderClient = OrderClient.getInstance();

// ============================== Order Placement & Execution ==============================

// Shared validator for /order/buy's query string: a non-finite or non-positive number must be refused here (400) rather
// than reach the order process as NaN/null.
function validateBuyQuery(q: Record<string, unknown>): string | null {
    const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
    const strike = num(q.strikePrice);
    if (strike !== undefined && !(Number.isInteger(strike) && strike > 0)) return 'strikePrice must be a positive integer';
    const price = num(q.price);
    if (price !== undefined && !(Number.isFinite(price) && price > 0)) return 'price must be a positive number';
    for (const k of ['targetPoints', 'stopLossPoints']) {
        const v = num(q[k]);
        if (v !== undefined && !(Number.isFinite(v) && v >= 0)) return `${k} must be a number >= 0`;
    }
    for (const k of ['right', 'index', 'contract']) {
        if (q[k] !== undefined && typeof q[k] !== 'string') return `${k} must be a string`;
    }
    if (q.index !== undefined && !['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'].includes(String(q.index).toUpperCase())) return 'index must be NIFTY, SENSEX, BANKNIFTY or FINNIFTY';
    return null;
}

// Generic order placement - dispatches Kite-or-ANT internally via
// bookkeeping.getUserBroker (manualBuy/squareOff/setTargetStopLoss). Renamed
// from /prism/order/buy, /prism/squareoff, /prism/settarget - despite the
// old name, none of these ever called prismExecutor.ts; the "prism" prefix
// was actively misleading now that Prism is a real third broker with its own
// distinct routes elsewhere.
router.post('/order/buy', requireAuth, async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract, targetPoints, stopLossPoints } = req.query;
        const user = resolveUser(req);
        const invalid = validateBuyQuery({ right, index, strikePrice, price, contract, targetPoints, stopLossPoints });
        if (invalid) { res.status(400).json({ error: invalid }); return; }
        Log.log('Resolved order while placing an order ', user);
        const result = await orderClient.manualBuy(user, {
            index: index as any,
            right: right as string,
            contract: contract as string,
            strikePrice: strikePrice ? parseInt(strikePrice as string) : undefined,
            price: price ? parseFloat(price as string) : undefined,
            targetPoints: targetPoints ? parseFloat(targetPoints as string) : undefined,
            stopLossPoints: stopLossPoints ? parseFloat(stopLossPoints as string) : undefined,
        });
        res.json(result);
    } catch (e: any) {
        Log.log(e);
        res.status(e?.message?.includes('limit') ? 403 : 500).json({ error: e?.message ?? String(e) });
    }
});

// Lock profits: (1) writes enabled: false on every enabled strategy to config.yml (one atomic write, hot-reloaded by every
// process). A disabled strategy takes no action at all - no entries, hedges, refills, stops or exits - so nothing can buy
// behind the lock. (2) The order process then cancels resting buys and limit-sells every open long at its broker live price
// (orderProcess.ts's lockProfits), so realized P&L ends >= the open P&L at the call. Query: ?broker=kite|breeze|ant (omitted
// = every broker with an open position), ?reprice=true to re-price a lock that is still resting. To trade again, set
// enabled: true on the strategies you want in config.yml and POST /reconcile.
router.post('/order/lock-profits', requireAdmin, async function (req, res) {
    try {
        const broker = typeof req.query.broker === 'string' && req.query.broker.trim() ? req.query.broker.trim() : undefined;
        const reprice = req.query.reprice === 'true';
        // Persist the disables before touching an order; a write that fails stops the call here, with nothing sold.
        const cfg = configService.getConfig();
        const toDisable = (cfg.strategies || []).filter((s: any) => s.enabled);
        const disabledStrategies = toDisable.map((s: any) => s.userId || s.type);
        toDisable.forEach((s: any) => { s.enabled = false; });
        configService.writeConfig(cfg);
        configService.reloadNow();
        const lock = await orderClient.lockProfits({ broker, reprice });
        res.json({ disabledStrategies, lock });
    } catch (e: any) {
        Log.log('lock-profits failed:', e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

router.post('/order/squareoff', requireAuth, async function (req, res) {
    try {
        const { token, qty, tsym } = req.query;
        const user = resolveUser(req);
        if (qty !== undefined && !(Number.isInteger(Number(qty)) && Number(qty) > 0)) { res.status(400).json({ error: 'qty must be a positive integer' }); return; }
        if ((token !== undefined && typeof token !== 'string') || (tsym !== undefined && typeof tsym !== 'string') || (!token && !tsym)) { res.status(400).json({ error: 'token or tsym is required' }); return; }
        await orderClient.squareOff(user, {
            token: token as string,
            tsym: tsym as string,
            quantity: qty ? Number(qty) : undefined,
        });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

router.post('/order/settarget', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints } = req.body;
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        if (typeof token !== 'string' || !(typeof targetPoints === 'number' && Number.isFinite(targetPoints) && targetPoints >= 0) || !(typeof stopLossPoints === 'number' && Number.isFinite(stopLossPoints) && stopLossPoints >= 0)) {
            res.status(400).json({ error: 'token must be a string; targetPoints and stopLossPoints must be numbers >= 0' });
            return;
        }
        const user = resolveUser(req);
        await orderClient.setTargetStopLoss(user, token, targetPoints, stopLossPoints);
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});


// ============================== Trade & Position Queries ==============================

// Live figures for the contract picked in Search & Buy (?contract=NIFTY_25550_CE, the same canonical string /order/buy takes). Read-only.
// Resolves the contract the buy would use (nearest expiry, same as findNearestExpiryOption in estimateOptionPrice) for the CE and the PE at
// that strike, so the panel shows OI for both sides. Figures come from ANT (see ANT.getContractSnapshot) - ANT is the platform's price source
// on every broker, since Kite's quote endpoints are refused for this account.
router.get('/order/contract-quote', requireAuth, async function (req: express.Request, res) {
    let canonical: CanonicalSymbol;
    try {
        canonical = parseCanonicalSymbol(String(req.query.contract ?? ''));
    } catch {
        res.status(400).json({ error: 'contract must look like NIFTY_25550_CE' });
        return;
    }
    try {
        const exch = exchangeForIndex(canonical.symbol);
        const master = AntContractMaster.getInstance();
        const lookup = (optionType: 'CE' | 'PE') => master.findNearestExpiryOption({ symbol: canonical.symbol, exch, strike: canonical.strike, optionType });
        const selected = lookup(canonical.optionType);
        const ce = canonical.optionType === 'CE' ? selected : lookup('CE');
        const pe = canonical.optionType === 'PE' ? selected : lookup('PE');
        const snap = await ANT.getInstance().getContractSnapshot(selected.exch, String(selected.token), String(ce.token), String(pe.token));
        res.json({ contract: formatCanonicalSymbol(canonical), tradingSymbol: selected.tradingSymbol, strike: canonical.strike, optionType: canonical.optionType, expiry: Number.isFinite(selected.expiryMs) ? new Date(selected.expiryMs).toISOString().slice(0, 10) : null, lotSize: Number(selected.lotSize) || null, fetchedAt: new Date().toISOString(), ...snap });
    } catch (e: any) {
        Log.log(`[contract-quote] ${req.query.contract}: ${e?.message ?? e}`);
        res.status(503).json({ error: `Quote unavailable: ${e?.message ?? e}` });
    }
});


// Per-strategy realized (closed trades) and unrealized (open positions) P&L for the current `order` session,
// used by the monitor-strategies skill's "status" report. Optional ?match=<regex> filters on Trade.strategy, falling back to Trade.user (bare broker orders carry no strategy).
// Optional ?by=broker groups the same rows by broker instead of by strategy (the row's `strategy` field then holds the broker name;
// a trade with no broker field is a legacy kite row).
// Optional ?opened=today counts only trades OPENED today (IST day of Trade.entryTime), realized and unrealized alike: a trade bought on an
// earlier day and sold today, or still open from an earlier day, is left out. A trade with no entryTime counts as opened today (see
// util/openedToday.ts). Absent or ?opened=all keeps every trade (the route's own default, for other callers); the status script passes it.
router.get('/strategyPnl', requireAdmin, async function (req: express.Request, res) {
    try {
        const stats = await orderClient.stats();
        const re = req.query.match ? new RegExp(String(req.query.match), 'i') : null;
        const byBroker = req.query.by === 'broker';
        const todayOnly = openedFilterOf(req.query.opened) === 'today';
        const wanted = (t: Trade) => !todayOnly || isOpenedToday(t.entryTime);
        res.setHeader('X-Opened-Filter', todayOnly ? 'today' : 'all'); // lets the status script tell a server that predates ?opened from one that applied it
        // ?closed=1: one row per CLOSED trade (user, broker, contract, qty, entry/exit price, realized P&L, times) instead of the grouped totals
        // (scripts/strategy-status.sh users). The header tells the script a server that has this option from one that ignored it.
        if (req.query.closed === '1') {
            res.setHeader('X-Closed-Rows', '1');
            res.json(closedTradeRows(stats.closedTrades as Trade[], re, todayOnly));
            return;
        }
        const rows = new Map<string, { strategy: string; realized: number; unrealized: number; open: number; closed: number }>();
        const row = (t: Trade) => {
            const key = byBroker ? String(t.broker || 'kite') : (t.strategy || t.user || '(none)');
            if (!rows.has(key)) rows.set(key, { strategy: key, realized: 0, unrealized: 0, open: 0, closed: 0 });
            return rows.get(key)!;
        };
        for (const t of stats.closedTrades as Trade[]) {
            if (re && !re.test(t.strategy || t.user || '')) continue;
            if (!wanted(t)) continue;
            const r = row(t); r.closed++; r.realized += Number(t.realizedPnL) || 0;
        }
        const openTrades = (stats.trades as Trade[]).filter((t) => (!re || re.test(t.strategy || t.user || '')) && wanted(t));
        // The order process never fills Trade.unrealizedPnL (only the legacy in-process Monitor does) and keeps lastTradePrice
        // fresh only for trades whose exits it monitors itself (resting-sell and reconcile-restored legs stay at their entry price),
        // so price each open trade from a live quote, falling back to lastTradePrice when the quote call fails.
        const liveLtp = new Map<Trade, number>();
        await Promise.all(openTrades.map(async (t) => {
            try {
                if (!t.token) return;
                const exchange = /^(SENSEX|BANKEX)/i.test(t.tsym || '') ? 'BFO' : 'NFO';
                const q = await ANT.getInstance().getLiveQuote(exchange, String(t.token));
                if (q.ltp > 0) liveLtp.set(t, q.ltp);
            } catch (e) { /* fall back to lastTradePrice below */ }
        }));
        // ?detail=1: one row per open position (strategy, broker, contract, quantity, bought price, live price, unrealized) instead of the
        // grouped totals - the status script's unrealized table (by broker and strategy) is built from it.
        if (req.query.detail === '1') {
            res.json(openTrades.map((t) => {
                const ltp = liveLtp.get(t) ?? Number(t.lastTradePrice);
                const mark = (ltp - Number(t.price)) * Number(t.quantity);
                return {
                    strategy: t.strategy || t.user || '(none)', user: t.user, broker: String(t.broker || 'kite'), tsym: t.tsym,
                    quantity: Number(t.quantity), price: Number(t.price), ltp: Number.isFinite(ltp) ? ltp : null, liveQuote: liveLtp.has(t),
                    unrealized: Number.isFinite(mark) ? +mark.toFixed(2) : 0,
                    targetPrice: Number(t.targetPrice) > 0 ? Number(t.targetPrice) : null, stopLossPrice: Number(t.stopLossPrice) > 0 ? Number(t.stopLossPrice) : null,
                };
            }));
            return;
        }
        for (const t of openTrades) {
            const mark = ((liveLtp.get(t) ?? Number(t.lastTradePrice)) - Number(t.price)) * Number(t.quantity);
            const r = row(t); r.open++; r.unrealized += Number.isFinite(mark) ? mark : 0;
            r.realized += Number(t.realizedPnL) || 0; // partial exits on a still-open trade
        }
        res.json([...rows.values()].map((r) => ({ ...r, realized: +r.realized.toFixed(2), unrealized: +r.unrealized.toFixed(2) })));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});




router.get('/admin/trades/closed', requireAdmin, async function (req, res) {
    try {
        const { user, from, to } = req.query as { user?: string; from?: string; to?: string };
        const query: any = {};
        if (user) query.user = user;
        // Date-only from/to are IST calendar days (a plain new Date('YYYY-MM-DD') is UTC midnight = 05:30 IST, which made a Day filter a
        // zero-width window and dropped the last day of Week/Month). `to` is inclusive of its whole day: [from 00:00 IST, to+1 00:00 IST).
        if (from || to) {
            const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
            const istStart = (d: string) => (dateOnly.test(d) ? new Date(`${d}T00:00:00+05:30`) : new Date(d));
            const range: any = {};
            if (from) range.$gte = istStart(from);
            if (to) range.$lt = dateOnly.test(to) ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 60 * 60 * 1000) : new Date(to);
            if ((range.$gte && Number.isNaN(range.$gte.getTime())) || (range.$lt && Number.isNaN(range.$lt.getTime()))) {
                res.status(400).json({ error: 'from/to must be valid dates' });
                return;
            }
            query.exitTime = range;
        }
        const trades = await Mongo.getInstance().db.collection('closedTrades').find(query).sort({ exitTime: -1 }).toArray();
        res.json(trades);
    } catch (e) {
        Log.log('Admin get closed trade history error:', e);
        res.sendStatus(500);
    }
});

// "Eligible" P&L (excludes forfeited profit) for the Trades tab's date-range
// summary - single user only (forfeiture is computed against that user's
// investmentAmount). breakdown=week (Month view) additionally buckets by
// trading week; otherwise the whole [from,to] range is one figure (Day/Week
// views).
router.get('/admin/trades/pnl-summary', requireAdmin, async function (req, res) {
    try {
        const { user, from, to, breakdown } = req.query as { user?: string; from?: string; to?: string; breakdown?: string };
        if (!user || !from || !to) {
            res.status(400).json({ error: 'user, from and to are required' });
            return;
        }
        let period: { start: Date; end: Date };
        try { period = periodFromInputs(from, to); } catch (e: any) { res.status(400).json({ error: e.message }); return; }
        const summary = await computePnlSummary(user, period.start, period.end, breakdown === 'week');
        res.json(summary);
    } catch (e) {
        Log.log('Admin get P&L summary error:', e);
        res.sendStatus(500);
    }
});

// Admin, all-users (or one user via ?user=) view of currently open trades -
// mirrors /admin/trades/closed's optional-user-filter shape, but reads the
// same in-memory order-process bookkeeping /openTrades does (open trades
// aren't in Mongo until they close).
router.get('/admin/trades/open', requireAdmin, async function (req, res) {
    try {
        const { user } = req.query as { user?: string };
        const stats = await orderClient.stats();
        const trades = user ? stats.trades.filter((t: Trade) => t.user === user) : stats.trades;
        res.json(trades);
    } catch (e) {
        Log.log('Admin get open trades error:', e);
        res.sendStatus(500);
    }
});




export default router;
