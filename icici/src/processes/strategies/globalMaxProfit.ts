import Log from '../../util/Log';
import configService from '../../prism/ConfigService';
import { configuredBrokersOf } from '../../util/brokerName';
import { isWithinTradingWindow } from '../../util/marketHours';
import { isOpenedToday } from '../../util/openedToday';
import { exchangeForTsym } from '../../util/underlyings';
import { globalMaxProfit } from '../../strategy/effectiveMaxProfit';
import { clearPrice, LockLeg, tripSellPrice, keepTripSell, TripGuard } from '../../strategy/maxProfitLock';
import { latchGlobalMaxProfit, globalMaxProfitLatchedBrokers } from '../../strategy/globalMaxProfitLatch';
import { NonFiniteAlert } from '../../strategy/finiteGuard';
import OrderClient from './OrderClient';
import type { Strategy } from '../../strategy/strategy';

// The GLOBAL maxProfit (config.yml settings.maxProfit: one number of rupees, the same for every broker) for every strategy that has no profit stop of its own, per strategy
// instance per broker. Strategies that DO have one (below) read the same setting themselves (effectiveMaxProfit), so they are skipped here.
// Same behaviour as SimpleContinuousStrategy: judged on day P&L (realized + open positions marked at the live price, trades opened today), a
// trip LOCKS the cap - every open position of that strategy on that broker gets one limit sell at the price that makes the total equal the cap
// (never the live bid) - and no new buy of that strategy on that broker is placed for the rest of the day (the latch is durable in Mongo, see
// globalMaxProfitLatch.ts, and enforced by the order process in bookkeeping.canPlaceOrder). A disabled strategy is never touched.
const OWN_MAX_PROFIT = new Set([
    'ContinuousStrategy', 'SupportResistanceStrategy', 'BulkPcrStrategy', 'BulkPcrAutoStartStrategy', 'SimpleContinuousStrategy', 'ScaledHedgedStrategy',
]);
const INTERVAL_MS = 5000;
const REPRICE_AFTER_MS = 20_000;

const placed = new Map<string, { qty: number; price: number; at: number }>(); // key user|broker|tsym: the trip sell this monitor rests
const tripGuard = new TripGuard(); // backoff of refused trip sells (in memory throttle only)
let running = false;

const nonFiniteAlert = new NonFiniteAlert();
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function markOf(t: any): Promise<number> {
    try {
        const ltp = await OrderClient.getInstance().getOptionLtp(t.user, { tradingSymbol: t.tsym, token: String(t.token), exchange: exchangeForTsym(t.tsym) });
        if (num(ltp) > 0) return num(ltp);
    } catch (e) { /* fall back to the last price the order process saw */ }
    return num(t.lastTradePrice) > 0 ? num(t.lastTradePrice) : num(t.price);
}

export async function checkOne(userId: string, broker: string, cap: number, stats: { trades: any[]; closedTrades: any[] }, latchedBrokers: Set<string>): Promise<void> {
    const mine = (t: any) => t.user === userId && String(t.broker || 'kite') === broker && isOpenedToday(t.entryTime);
    // A trade whose price or quantity is not a positive finite number cannot be valued (num() would turn it into 0 and book a fake profit of
    // mark x qty): it is left out of the total and of the lock, and alerted once per 10 min. A non-finite realizedPnL counts 0 (under-counts: safe).
    const badTrades = stats.trades.filter((t) => mine(t) && num(t.quantity) > 0 && !(Number.isFinite(Number(t.price)) && Number(t.price) > 0));
    if (badTrades.length) nonFiniteAlert.report(`${userId}|${broker}:trades`, `[GlobalMaxProfit] ${userId} ${broker}: open trade(s) with an unusable price skipped from the max-profit total: ${badTrades.map((t) => `${t.tsym} price=${String(t.price)}`).join('; ')}`);
    const open = stats.trades.filter((t) => mine(t) && num(t.quantity) > 0 && Number.isFinite(Number(t.price)) && Number(t.price) > 0);
    const badRealized = [...stats.closedTrades.filter(mine), ...open].filter((t) => t.realizedPnL != null && !Number.isFinite(Number(t.realizedPnL)));
    if (badRealized.length) nonFiniteAlert.report(`${userId}|${broker}:realized`, `[GlobalMaxProfit] ${userId} ${broker}: trade(s) with a non-numeric realizedPnL counted as 0: ${badRealized.map((t) => `${t.tsym} realizedPnL=${String(t.realizedPnL)}`).join('; ')}`);
    let realized = stats.closedTrades.filter(mine).reduce((s, t) => s + num(t.realizedPnL), 0);
    realized += open.reduce((s, t) => s + num(t.realizedPnL), 0); // partial exits of a still-open trade
    const marks = new Map<any, number>();
    for (const t of open) marks.set(t, await markOf(t));
    const unrealized = open.reduce((s, t) => s + (marks.get(t)! - num(t.price)) * num(t.quantity), 0);
    const total = realized + unrealized;

    if (!latchedBrokers.has(broker)) {
        if (!Number.isFinite(total)) { nonFiniteAlert.report(`${userId}|${broker}:total`, `[GlobalMaxProfit] ${userId} ${broker}: total is ${String(total)} - NOT tripping`); return; }
        if (!(total >= cap)) return;
        if (!(await latchGlobalMaxProfit(userId, broker, { pnl: total, cap }))) return; // not durable: retry next cycle rather than act on a latch that would vanish
        latchedBrokers.add(broker);
        Log.log(`[GlobalMaxProfit] MAX PROFIT TRIPPED - ${userId} on ${broker}: total=${Math.round(total)} threshold=${cap} (realized=${Math.round(realized)}) - locking the cap on ${open.length} open position(s), no new orders for the rest of the day`);
    }

    // Latched: every open position of this strategy on this broker rests ONE limit sell at the price that clears the cap.
    const legs = new Map<any, LockLeg>();
    for (const t of open) legs.set(t, { qty: num(t.quantity), soldQty: 0, entry: num(t.price), pnlRef: num(t.price), lastLtp: marks.get(t), sellQty: 0, sellPrice: 0 });
    // `realized` already includes the partial exits of open trades, so the legs carry only their remaining quantity (soldQty 0).
    for (const t of open) {
        const key = `${userId}|${broker}|${t.tsym}`;
        const leg = legs.get(t)!;
        const key2 = key;
        if (!tripGuard.due(key2)) continue; // a refused placement is retried with a growing delay, not every cycle
        const clear = clearPrice(leg, [...legs.values()], realized, cap);
        // Never below the marketable floor (last price less 5%, tightening after a refusal): a clearPrice far under the market is refused by the exchange band.
        const price = tripSellPrice(clear, marks.get(t), tripGuard.attempts(key2));
        try {
            const rec = placed.get(key);
            const instrumentId = String(t.token);
            if (rec) {
                if (Date.now() - rec.at < REPRICE_AFTER_MS || keepTripSell(rec.price, clear, marks.get(t))) continue;
                const res = await OrderClient.getInstance().cancelRestingLimitSells(userId, { tradingSymbol: t.tsym, broker: broker as any });
                if (res.cancelFailed) { Log.log(`[GlobalMaxProfit] ${userId} ${broker}: could not cancel the resting sell of ${t.tsym}, retrying`); continue; }
                placed.delete(key);
                if (res.filledQty > 0) continue; // part or all sold while cancelling: the next cycle sizes what is really left from fresh stats
            } else {
                // A sell from before a restart of this monitor may still rest (its price is unknown): leave it, it is re-priced only by us.
                const pending = await OrderClient.getInstance().getPendingSells(userId, broker, t.tsym);
                if (pending.reduce((s, p) => s + num(p.quantity), 0) >= num(t.quantity)) { placed.set(key, { qty: num(t.quantity), price: 0, at: Date.now() }); continue; }
            }
            await OrderClient.getInstance().chunkedSquareOffLimit(userId, { tradingSymbol: t.tsym, instrumentId, quantity: num(t.quantity), price, broker: broker as any });
            tripGuard.ok(key2);
            placed.set(key, { qty: num(t.quantity), price, at: Date.now() });
            Log.log(`[GlobalMaxProfit] ${userId} ${broker}: resting sell ${t.tsym} qty=${num(t.quantity)} @${price} (locks ${cap})`);
        } catch (e) {
            const n = tripGuard.fail(key2);
            if (tripGuard.shouldLogFailure(n)) Log.log(`[GlobalMaxProfit] ALERT: ${userId} ${broker}: trip sell for ${t.tsym} @${price} failed (failure ${n}, retried with backoff):`, e);
        }
    }
}

async function runOnce(list: Strategy[]): Promise<void> {
    if (running || !isWithinTradingWindow()) return;
    running = true;
    try {
        const candidates: Array<{ userId: string; brokers: string[] }> = [];
        for (const s of list) {
            if (OWN_MAX_PROFIT.has(s.getClassName()) || !s.enabled || !s.stateLoaded) continue; // a disabled strategy takes no action of any kind
            const cfg = configService.getInstances().find((c) => (c.userId || c.type) === s.userId);
            if (!cfg || cfg.enabled === false) continue;
            candidates.push({ userId: s.userId, brokers: configuredBrokersOf(cfg) });
        }
        if (candidates.length === 0) return;
        const stats = await OrderClient.getInstance().stats();
        for (const c of candidates) {
            const latched = new Set(await globalMaxProfitLatchedBrokers(c.userId));
            for (const broker of c.brokers) {
                // No global cap set: nothing to judge or lock (a latch set earlier today keeps blocking new buys in the order process).
                const cap = globalMaxProfit();
                if (!(cap > 0)) continue;
                try { await checkOne(c.userId, broker, cap, stats, latched); } catch (e) { Log.log(`[GlobalMaxProfit] ${c.userId} ${broker} check failed:`, e); }
            }
        }
    } catch (e) {
        Log.log('[GlobalMaxProfit] cycle failed:', e);
    } finally {
        running = false;
    }
}

export function startGlobalMaxProfitMonitor(list: () => Strategy[]): void {
    setInterval(() => { void runOnce(list()); }, INTERVAL_MS).unref?.();
}
