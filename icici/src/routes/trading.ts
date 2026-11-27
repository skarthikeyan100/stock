import Log from '../util/Log';
import express from 'express';
import { Trade } from '../model/model';
import { getUser } from '../user';
import configService from '../prism/ConfigService';
import { computePnlSummary, periodFromInputs } from '../payout';
import Mongo from '../tools/mongo';
import ANT from '../ant/ANT';
import AntContractMaster from '../ant/AntContractMaster';
import { CanonicalSymbol, formatCanonicalSymbol, parseCanonicalSymbol } from '../model/CanonicalSymbol';
import { exchangeForIndex } from '../util/underlyings';
import OrderClient from '../processes/strategies/OrderClient';
import { disableAllAndLockProfits } from '../processes/lockAllProfits';
import { asyncRouter } from './asyncRouter';
import { isOpenedToday, openedFilterOf } from '../util/openedToday';
import { closedTradeRows } from '../util/closedTradeRows';
import { gateBuy, gateSetTarget } from '../levelGate';
import { normalizeLevel } from '../levelRules';
import { NOT_PLACED_TAG, ORDER_MAY_BE_LIVE_TAG } from '../ipc/orderProtocol';
import { wasFlashContractShown } from './priceFeed';
import { requireCsrfHeader, resolveUser, requireAuth, requireAdmin, requireSelfOrAdmin } from './session';
import { USER_BROKERS_TEXT, isUserBroker } from '../util/brokerName';

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
    if (q.right !== undefined && q.right !== '' && !['call', 'put'].includes(String(q.right))) return "right must be 'call' or 'put'"; // anything else used to become a PUT
    if (q.index !== undefined && !['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'].includes(String(q.index).toUpperCase())) return 'index must be NIFTY, SENSEX, BANKNIFTY or FINNIFTY';
    return null;
}

// Generic order placement - dispatches Kite-or-ANT internally via
// bookkeeping.getUserBroker (manualBuy/squareOff/setTargetStopLoss). Renamed
// from /prism/order/buy, /prism/squareoff, /prism/settarget - despite the
// old name, none of these ever called prismExecutor.ts; the "prism" prefix
// was actively misleading now that Prism is a real third broker with its own
// distinct routes elsewhere.
const MAX_FRONTEND_TRADES_PER_DAY = 3;

// A buy waits up to 5 minutes for its fill (BUY_FILL_WAIT), longer than the page's request can live (Cloudflare ends one after about 100 s). A buy
// still waiting after `afterMs` is answered "still waiting" and runs on; the same buy is refused while it does, so it is not placed twice, and it
// counts towards the daily trade limit. An object so a unit test can shorten it.
export const MANUAL_BUY_REPLY = { afterMs: 75_000 };
const STILL_WAITING = 'Your buy is placed and still waiting to fill. It is cancelled if it has not filled 5 minutes after placement. Check your positions before buying again.';
const buysWaiting = new Map<string, Set<string>>(); // user -> the buys (contract, or index / side / strike) still waiting

router.post('/order/buy', requireAuth, async function (req: express.Request, res) {
    try {
        const { right, index, strikePrice, price, contract, targetPoints, stopLossPoints } = req.query;
        const user = resolveUser(req);
        const invalid = validateBuyQuery({ right, index, strikePrice, price, contract, targetPoints, stopLossPoints });
        if (invalid) { res.status(400).json({ error: invalid }); return; }
        Log.log('Resolved order while placing an order ', user);
        // A user sized by investmentAmount may start at most MAX_FRONTEND_TRADES_PER_DAY trades a day from the frontend; admins are exempt.
        const buyer = await getUser(user ?? '');
        // Level gating (src/levelGate.ts): a Beginner gets Flash Trade only, with the global target / stop-loss whatever the request carries.
        const settings = configService.getConfig().settings as any;
        const gate = gateBuy({
            role: buyer?.role, level: buyer?.proficiencyLevel, contract: contract as string | undefined,
            targetPoints: targetPoints ? parseFloat(targetPoints as string) : undefined,
            stopLossPoints: stopLossPoints ? parseFloat(stopLossPoints as string) : undefined,
            globalTarget: Number(settings?.targetPoints), globalStopLoss: Number(settings?.stopLossPoints),
        });
        if (!gate.allowed) { res.status(403).json({ error: gate.error }); return; }
        if (buyer && buyer.role !== 'admin' && buyer.investmentMode === 'investmentAmount') {
            const { trades, closedTrades } = await orderClient.stats(user);
            // One trade = one (broker, token, entryTime): a position closed in several pieces counts once.
            const started = new Set<string>();
            for (const t of [...trades, ...closedTrades]) {
                if (t.user === user && isOpenedToday(t.entryTime)) started.add(`${t.broker}|${t.token}|${new Date(t.entryTime).getTime()}`);
            }
            const waiting = buysWaiting.get(user)?.size ?? 0;
            if (started.size + waiting >= MAX_FRONTEND_TRADES_PER_DAY) {
                res.status(403).json({ error: `Trade limit reached: at most ${MAX_FRONTEND_TRADES_PER_DAY} trades a day in investment-amount mode (${started.size} today${waiting ? `, ${waiting} waiting to fill` : ''})` });
                return;
            }
        }
        const buyKey = contract ? String(contract) : `${index ?? ''}|${right ?? ''}|${strikePrice ?? ''}`;
        const mine = buysWaiting.get(user) ?? new Set<string>();
        if (mine.has(buyKey)) { res.status(409).json({ error: STILL_WAITING }); return; }
        mine.add(buyKey); // synchronous with the check: two clicks cannot both pass
        buysWaiting.set(user, mine);
        const order = orderClient.manualBuy(user, {
            index: index as any,
            right: right as string,
            contract: contract as string,
            strikePrice: strikePrice ? parseInt(strikePrice as string) : undefined,
            price: price ? parseFloat(price as string) : undefined,
            targetPoints: gate.targetPoints,
            stopLossPoints: gate.stopLossPoints,
        }).finally(() => {
            mine.delete(buyKey);
            if (mine.size === 0 && buysWaiting.get(user) === mine) buysWaiting.delete(user);
        });
        let timer: NodeJS.Timeout | undefined;
        const early = await Promise.race([
            order.then((result) => ({ result })),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MANUAL_BUY_REPLY.afterMs); }),
        ]).finally(() => clearTimeout(timer));
        if (early) { res.json(early.result); return; }
        order.then(() => Log.log(`[order] ${user}: the buy ${buyKey} answered as still waiting has completed`))
            .catch((e) => Log.log(`[order] ${user}: the buy ${buyKey} answered as still waiting FAILED:`, e));
        res.status(409).json({ error: STILL_WAITING });
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
        const { disabledStrategies, lock } = await disableAllAndLockProfits(orderClient, { broker, reprice });
        res.json({ disabledStrategies, lock });
    } catch (e: any) {
        Log.log('lock-profits failed:', e);
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});

// ============================== Orders at the clicked price ==============================
// The trading page's own buy and square-off: a resting LIMIT order at exactly the price the user saw when clicking (order/lockedEntry.ts,
// lockedSquareOff.ts). Never a market order: anything missing or unusable is refused. The same level gating, daily trade limit and (in the order
// process) risk limits as the market routes above. Paths of their own, so a server without them answers 404 instead of buying at market.

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const optionalPoints = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

// An order-process error as the page shows it (the [NOT_PLACED] / [ORDER_MAY_BE_LIVE] tags are for programs).
function sendOrderError(res: express.Response, e: any): void {
    const raw = String(e?.message ?? e);
    const mayBeLive = raw.includes(ORDER_MAY_BE_LIVE_TAG);
    const message = raw.split(NOT_PLACED_TAG).join('').split(ORDER_MAY_BE_LIVE_TAG).join('').trim();
    const error = mayBeLive ? `The order may be live at the broker - check your Active Positions and your broker before trying again. ${message}` : message;
    res.status(raw.includes(NOT_PLACED_TAG) ? 409 : 500).json({ error });
}

// Whether this server AND its order process take orders at a clicked price. false: the order process predates them (restart pending).
router.get('/order/locked-capability', requireAuth, async function (_req, res) {
    try {
        await orderClient.userOrderState();
        res.json({ lockedPrice: true });
    } catch (e: any) {
        if (/Unknown request type/.test(String(e?.message ?? e))) { res.json({ lockedPrice: false }); return; }
        res.status(503).json({ error: 'The order service is not reachable' });
    }
});

// One buy at a time per user from the check of the daily trade limit to the placed order, so two clicks cannot both pass it.
const buyChains = new Map<string, Promise<unknown>>();
function oneAtATime<T>(user: string, fn: () => Promise<T>): Promise<T> {
    const run = (buyChains.get(user) ?? Promise.resolve()).catch(() => undefined).then(fn);
    buyChains.set(user, run);
    run.catch(() => undefined).then(() => { if (buyChains.get(user) === run) buyChains.delete(user); });
    return run;
}

router.post('/order/buy-locked', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { contract, index, right, strikePrice, token, limitPrice, targetPoints, stopLossPoints } = req.body ?? {};
        const user = resolveUser(req);
        if (!positive(limitPrice)) { res.status(400).json({ error: 'limitPrice (the price shown when you clicked) must be a positive number' }); return; }
        if (typeof token !== 'string' || !token) { res.status(400).json({ error: 'token of the priced contract is required' }); return; }
        if (!optionalPoints(targetPoints) || !optionalPoints(stopLossPoints)) { res.status(400).json({ error: 'targetPoints and stopLossPoints must be numbers >= 0' }); return; }
        if (contract !== undefined) {
            try { if (typeof contract !== 'string') throw new Error(); parseCanonicalSymbol(contract); }
            catch { res.status(400).json({ error: 'contract must look like NIFTY_25550_CE' }); return; }
        } else if (!(right === 'call' || right === 'put') || !(index === 'NIFTY' || index === 'SENSEX') || !(Number.isInteger(strikePrice) && strikePrice > 0)) {
            res.status(400).json({ error: "either contract, or right ('call'/'put'), index (NIFTY/SENSEX) and strikePrice" });
            return;
        }
        const buyer = await getUser(user ?? '');
        const settings = configService.getConfig().settings as any;
        const gate = gateBuy({
            role: buyer?.role, level: buyer?.proficiencyLevel, contract: contract as string | undefined,
            targetPoints: targetPoints ?? undefined, stopLossPoints: stopLossPoints ?? undefined,
            globalTarget: Number(settings?.targetPoints), globalStopLoss: Number(settings?.stopLossPoints),
        });
        if (!gate.allowed) { res.status(403).json({ error: gate.error }); return; }
        // A Beginner has Flash Trade only: the strike must be the one the server itself put on their button, never one they chose.
        if (contract === undefined && buyer?.role !== 'admin' && normalizeLevel(buyer?.proficiencyLevel) !== 'advanced' && !wasFlashContractShown(user, index, right, strikePrice)) {
            res.status(403).json({ error: 'The price on screen has expired - check the new price and click again' });
            return;
        }
        await oneAtATime(user, async () => {
            if (buyer && buyer.role !== 'admin' && buyer.investmentMode === 'investmentAmount') {
                const { trades, closedTrades } = await orderClient.stats(user);
                const started = new Set<string>();
                const openContracts = new Set<string>();
                for (const t of [...trades, ...closedTrades]) {
                    if (t.user === user && isOpenedToday(t.entryTime)) started.add(`${t.broker}|${t.token}|${new Date(t.entryTime).getTime()}`);
                }
                for (const t of trades) if (t.user === user) openContracts.add(`${t.broker}|${t.token}`);
                // A resting buy that has not filled yet will be a trade of today once it does (one per contract; adding to an open one is not new).
                const resting = new Set<string>();
                for (const o of (await orderClient.userOrderState()).pending) {
                    if (o.userId === user && o.action === 'Buy' && !openContracts.has(`${o.broker}|${o.token}`)) resting.add(`${o.broker}|${o.token}`);
                }
                const waiting = resting.size + (buysWaiting.get(user)?.size ?? 0); // resting limit buys and market buys still waiting for their fill
                if (started.size + waiting >= MAX_FRONTEND_TRADES_PER_DAY) {
                    res.status(403).json({ error: `Trade limit reached: at most ${MAX_FRONTEND_TRADES_PER_DAY} trades a day in investment-amount mode (${started.size} today${waiting ? `, ${waiting} waiting to fill` : ''})` });
                    return;
                }
            }
            res.json(await orderClient.manualBuyLocked(user, {
                ...(contract !== undefined ? { contract } : { index, right, strikePrice }),
                token, limitPrice, targetPoints: gate.targetPoints, stopLossPoints: gate.stopLossPoints,
            }));
        });
    } catch (e: any) {
        Log.log(e);
        sendOrderError(res, e);
    }
});

router.post('/order/squareoff-locked', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { token, broker, price, qty } = req.body ?? {};
        if (typeof token !== 'string' || !token) { res.status(400).json({ error: 'token is required' }); return; }
        if (broker !== undefined && !(typeof broker === 'string' && isUserBroker(broker))) { res.status(400).json({ error: `broker must be ${USER_BROKERS_TEXT}` }); return; }
        if (!positive(price)) { res.status(400).json({ error: 'price (the price shown when you clicked) must be a positive number' }); return; }
        if (qty !== undefined && !(Number.isInteger(qty) && qty > 0)) { res.status(400).json({ error: 'qty must be a positive integer' }); return; }
        const out = await orderClient.squareOffLocked(resolveUser(req), { token, broker, price, quantity: qty });
        if (!out.results.some((r) => r.ok)) { res.status(409).json({ error: out.results.map((r) => `${r.broker}: ${r.error}`).join('; ') }); return; }
        res.json(out);
    } catch (e: any) {
        Log.log(e);
        sendOrderError(res, e);
    }
});

// Cancels one of the caller's own resting orders placed above.
router.post('/order/cancel', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { broker, orderId } = req.body ?? {};
        if (!(typeof broker === 'string' && isUserBroker(broker)) || typeof orderId !== 'string' || !orderId) { res.status(400).json({ error: 'broker and orderId are required' }); return; }
        res.json(await orderClient.cancelUserOrder(resolveUser(req), { broker, orderId }));
    } catch (e: any) {
        Log.log(e);
        sendOrderError(res, e);
    }
});

router.post('/order/squareoff', requireAuth, async function (req, res) {
    try {
        const { token, qty, tsym, broker } = req.query;
        const user = resolveUser(req);
        if (broker !== undefined && !(typeof broker === 'string' && isUserBroker(broker))) { res.status(400).json({ error: `broker must be ${USER_BROKERS_TEXT}` }); return; }
        if (qty !== undefined && !(Number.isInteger(Number(qty)) && Number(qty) > 0)) { res.status(400).json({ error: 'qty must be a positive integer' }); return; }
        if ((token !== undefined && typeof token !== 'string') || (tsym !== undefined && typeof tsym !== 'string') || (!token && !tsym)) { res.status(400).json({ error: 'token or tsym is required' }); return; }
        await orderClient.squareOff(user, {
            token: token as string,
            tsym: tsym as string,
            quantity: qty ? Number(qty) : undefined,
            broker: broker as string | undefined,
        });
        res.sendStatus(200);
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

router.post('/order/settarget', requireAuth, requireCsrfHeader, async function (req: express.Request, res) {
    try {
        const { token, targetPoints, stopLossPoints, broker } = req.body;
        if (broker !== undefined && !isUserBroker(broker)) { res.status(400).json({ error: `broker must be ${USER_BROKERS_TEXT}` }); return; }
        if (!token || targetPoints == null || stopLossPoints == null) {
            res.status(400).json({ error: 'Missing token, targetPoints, or stopLossPoints' });
            return;
        }
        if (typeof token !== 'string' || !(typeof targetPoints === 'number' && Number.isFinite(targetPoints) && targetPoints >= 0) || !(typeof stopLossPoints === 'number' && Number.isFinite(stopLossPoints) && stopLossPoints >= 0)) {
            res.status(400).json({ error: 'token must be a string; targetPoints and stopLossPoints must be numbers >= 0' });
            return;
        }
        const user = resolveUser(req);
        const caller = user ? await getUser(user) : null;
        const gate = gateSetTarget({ role: caller?.role, level: caller?.proficiencyLevel, targetPoints, stopLossPoints });
        if (!gate.allowed) { res.status(403).json({ error: gate.error }); return; }
        try {
            await orderClient.setTargetStopLoss(user, token, targetPoints, stopLossPoints, broker);
        } catch (e: any) {
            // Why the levels were not changed is shown to the user (a level already crossed, a refused GTT change).
            Log.log(e);
            res.status(409).json({ error: String(e?.message ?? e).replace(/^setTargetStopLoss:\s*/, '') });
            return;
        }
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
        // Real trades only: the paper broker (in memory, nothing in Mongo) is reported only by the "status paper" check, so a paper trade
        // is left out here by ITS broker (a strategy that ran on kite earlier and is on paper now keeps its real trades and loses only the paper ones).
        const isPaper = (t: Trade) => String(t.broker || '') === 'paper';
        const re = req.query.match ? new RegExp(String(req.query.match), 'i') : null;
        const byBroker = req.query.by === 'broker';
        const todayOnly = openedFilterOf(req.query.opened) === 'today';
        const wanted = (t: Trade) => !todayOnly || isOpenedToday(t.entryTime);
        res.setHeader('X-Opened-Filter', todayOnly ? 'today' : 'all'); // lets the status script tell a server that predates ?opened from one that applied it
        // ?closed=1: one row per CLOSED trade (user, broker, contract, qty, entry/exit price, realized P&L, times) instead of the grouped totals
        // (scripts/strategy-status.sh users). The header tells the script a server that has this option from one that ignored it.
        if (req.query.closed === '1') {
            res.setHeader('X-Closed-Rows', '1');
            res.json(closedTradeRows((stats.closedTrades as Trade[]).filter((t) => !isPaper(t)), re, todayOnly));
            return;
        }
        const rows = new Map<string, { strategy: string; realized: number; unrealized: number; open: number; closed: number }>();
        const row = (t: Trade) => {
            const key = byBroker ? String(t.broker || 'kite') : (t.strategy || t.user || '(none)');
            if (!rows.has(key)) rows.set(key, { strategy: key, realized: 0, unrealized: 0, open: 0, closed: 0 });
            return rows.get(key)!;
        };
        for (const t of stats.closedTrades as Trade[]) {
            if (isPaper(t)) continue;
            if (re && !re.test(t.strategy || t.user || '')) continue;
            if (!wanted(t)) continue;
            const r = row(t); r.closed++; r.realized += Number(t.realizedPnL) || 0;
        }
        const openTrades = (stats.trades as Trade[]).filter((t) => !isPaper(t) && (!re || re.test(t.strategy || t.user || '')) && wanted(t));
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




// Closed-trade filter shared by the admin and the per-user routes. Date-only from/to are IST calendar days (a plain new Date('YYYY-MM-DD')
// is UTC midnight = 05:30 IST, which made a Day filter a zero-width window and dropped the last day of Week/Month). `to` is inclusive of
// its whole day: [from 00:00 IST, to+1 00:00 IST). Returns an error message for an unparseable date.
function closedTradesQuery(user: string | undefined, from?: string, to?: string): { query: any } | { error: string } {
    const query: any = {};
    if (user) query.user = user;
    if (from || to) {
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
        const range: any = {};
        if (from) range.$gte = dateOnly.test(from) ? new Date(`${from}T00:00:00+05:30`) : new Date(from);
        if (to) range.$lt = dateOnly.test(to) ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 60 * 60 * 1000) : new Date(to);
        if ((range.$gte && Number.isNaN(range.$gte.getTime())) || (range.$lt && Number.isNaN(range.$lt.getTime()))) return { error: 'from/to must be valid dates' };
        query.exitTime = range;
    }
    return { query };
}

router.get('/admin/trades/closed', requireAdmin, async function (req, res) {
    try {
        const { user, from, to } = req.query as { user?: string; from?: string; to?: string };
        const q = closedTradesQuery(user, from, to);
        if ('error' in q) { res.status(400).json({ error: q.error }); return; }
        const trades = await Mongo.getInstance().db.collection('closedTrades').find(q.query).sort({ exitTime: -1 }).toArray();
        res.json(trades);
    } catch (e) {
        Log.log('Admin get closed trade history error:', e);
        res.sendStatus(500);
    }
});

// A trader's own trades, for the Profile > Trades tab (same shapes as the admin routes above, scoped to :email; an admin may read any).
router.get('/users/:email/trades/closed', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { from, to } = req.query as { from?: string; to?: string };
        const q = closedTradesQuery(req.params.email, from, to);
        if ('error' in q) { res.status(400).json({ error: q.error }); return; }
        res.json(await Mongo.getInstance().db.collection('closedTrades').find(q.query).sort({ exitTime: -1 }).toArray());
    } catch (e) {
        Log.log('Get user closed trades error:', e);
        res.sendStatus(500);
    }
});

router.get('/users/:email/trades/open', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const stats = await orderClient.stats();
        res.json(stats.trades.filter((t: Trade) => t.user === req.params.email));
    } catch (e) {
        Log.log('Get user open trades error:', e);
        res.sendStatus(500);
    }
});

router.get('/users/:email/trades/pnl-summary', requireSelfOrAdmin('email'), async function (req, res) {
    try {
        const { from, to, breakdown } = req.query as { from?: string; to?: string; breakdown?: string };
        if (!from || !to) { res.status(400).json({ error: 'from and to are required' }); return; }
        let period: { start: Date; end: Date };
        try { period = periodFromInputs(from, to); } catch (e: any) { res.status(400).json({ error: e.message }); return; }
        res.json(await computePnlSummary(req.params.email, period.start, period.end, breakdown === 'week'));
    } catch (e) {
        Log.log('Get user P&L summary error:', e);
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
