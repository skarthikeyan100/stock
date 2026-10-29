import Log from '../util/Log';
import express from 'express';
import { Trade } from '../model/model';
import configService from '../prism/ConfigService';
import { computePnlSummary } from '../payout';
import Mongo from '../tools/mongo';
import ANT from '../ant/ANT';
import OrderClient from '../processes/strategies/OrderClient';
import { asyncRouter } from './asyncRouter';
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


// Per-strategy realized (closed trades) and unrealized (open positions) P&L for the current `order` session,
// used by the monitor-strategies skill's "status" report. Optional ?match=<regex> filters on Trade.strategy, falling back to Trade.user (bare broker orders carry no strategy).
router.get('/strategyPnl', requireAdmin, async function (req: express.Request, res) {
    try {
        const stats = await orderClient.stats();
        const re = req.query.match ? new RegExp(String(req.query.match), 'i') : null;
        const rows = new Map<string, { strategy: string; realized: number; unrealized: number; open: number; closed: number }>();
        const row = (t: Trade) => {
            const key = t.strategy || t.user || '(none)';
            if (!rows.has(key)) rows.set(key, { strategy: key, realized: 0, unrealized: 0, open: 0, closed: 0 });
            return rows.get(key)!;
        };
        for (const t of stats.closedTrades as Trade[]) {
            if (re && !re.test(t.strategy || t.user || '')) continue;
            const r = row(t); r.closed++; r.realized += Number(t.realizedPnL) || 0;
        }
        const openTrades = (stats.trades as Trade[]).filter((t) => !re || re.test(t.strategy || t.user || ''));
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
        if (from || to) {
            query.exitTime = {};
            if (from) query.exitTime.$gte = new Date(from);
            if (to) query.exitTime.$lte = new Date(to);
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
        const summary = await computePnlSummary(user, new Date(from), new Date(to), breakdown === 'week');
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
