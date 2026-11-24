import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import configService from '../../prism/ConfigService';
import { isWithinTradingWindow } from '../../util/marketHours';
import { isOpenedToday } from '../../util/openedToday';
import { localDayKey } from '../../strategy/dayKey';
import { NonFiniteAlert } from '../../strategy/finiteGuard';
import { disableAllAndLockProfits } from '../lockAllProfits';
import { markOf } from './globalMaxProfit';
import OrderClient from './OrderClient';

// settings.overAllMaxProfit (rupees, optional, absent = off): when the COMBINED day P&L of every strategy on every real broker (realized + open positions at
// the live price, trades opened today; the paper broker is not counted) reaches it, the lock-profits action runs once - every strategy is disabled in
// config.yml and every open long is limit-sold at its live price (disableAllAndLockProfits, the same code as POST /order/lock-profits).
// One trip per day, durable in Mongo (strategyLatches, ownerType 'OverAllMaxProfit'): re-enabling strategies afterwards does not trip it again
// the same day. A trip whose lock failed (`locked` false) is retried every cycle.
export const OVERALL_MAX_PROFIT_OWNER = 'OverAllMaxProfit';
const INTERVAL_MS = 5000;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nonFiniteAlert = new NonFiniteAlert();
let running = false;

export function overAllMaxProfit(settings?: Record<string, any> | null): number {
    const v = (settings ?? (configService.getConfig().settings as any))?.overAllMaxProfit;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export async function combinedPnl(stats: { trades: any[]; closedTrades: any[] }): Promise<number> {
    const mine = (t: any) => String(t.broker || 'kite') !== 'paper' && isOpenedToday(t.entryTime);
    const open = stats.trades.filter((t) => mine(t) && num(t.quantity) > 0 && Number.isFinite(Number(t.price)) && Number(t.price) > 0);
    const realized = stats.closedTrades.filter(mine).reduce((s, t) => s + num(t.realizedPnL), 0) + open.reduce((s, t) => s + num(t.realizedPnL), 0);
    let unrealized = 0;
    for (const t of open) unrealized += ((await markOf(t)) - num(t.price)) * num(t.quantity);
    return realized + unrealized;
}

const latchKey = () => ({ ownerType: OVERALL_MAX_PROFIT_OWNER, userId: 'ALL', scope: 'all', day: localDayKey() });

async function readLatch(): Promise<{ locked: boolean } | null> {
    const col = Mongo.getInstance()?.db.collection('strategyLatches');
    if (!col) throw new Error('Mongo not connected');
    const doc: any = await col.findOne(latchKey());
    return doc?.tripped ? { locked: doc.locked === true } : null;
}

async function runOnce(orderClient: OrderClient): Promise<void> {
    if (running || !isWithinTradingWindow()) return;
    const cap = overAllMaxProfit();
    if (!(cap > 0)) return;
    running = true;
    try {
        const latch = await readLatch();
        if (!latch) {
            const total = await combinedPnl(await orderClient.stats());
            if (!Number.isFinite(total)) { nonFiniteAlert.report('overall:total', `[OverAllMaxProfit] total is ${String(total)} - NOT tripping`); return; }
            if (!(total >= cap)) return;
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) throw new Error('Mongo not connected');
            await col.updateOne(latchKey(), { $set: { tripped: true, locked: false, pnl: total, cap, updatedAt: new Date() } }, { upsert: true }); // durable before anything is sold
            Log.log(`[OverAllMaxProfit] TRIPPED - combined total=${Math.round(total)} threshold=${cap} - disabling every strategy and locking profits`);
        } else if (latch.locked) return;
        const res = await disableAllAndLockProfits(orderClient);
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        await col?.updateOne(latchKey(), { $set: { locked: true, updatedAt: new Date() } });
        Log.log(`[OverAllMaxProfit] lock-profits done: disabled ${res.disabledStrategies.length} strategies, locked P&L ${Math.round(num(res.lock?.totalLockedPnl))}`);
    } catch (e) {
        Log.log('[OverAllMaxProfit] ALERT: cycle failed (retried next cycle):', e);
    } finally {
        running = false;
    }
}

export function startOverAllMaxProfitMonitor(): void {
    const client = OrderClient.getInstance();
    setInterval(() => { void runOnce(client); }, INTERVAL_MS).unref?.();
}
