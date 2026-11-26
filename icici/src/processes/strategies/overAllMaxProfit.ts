import Log from '../../util/Log';
import Mongo from '../../tools/mongo';
import configService from '../../prism/ConfigService';
import { isWithinTradingWindow } from '../../util/marketHours';
import { isOpenedToday } from '../../util/openedToday';
import { localDayKey } from '../../strategy/dayKey';
import { NonFiniteAlert } from '../../strategy/finiteGuard';
import { disableAllAndLockProfits } from '../lockAllProfits';
import OrderClient from './OrderClient';
import { markPrice } from './markPrice';
import { restingByContract, cappedMarks } from './restingMarks';
import type { RestingSell } from '../../strategy/restingCover';

// settings.overAllMaxProfit (rupees, optional, absent = off): when the COMBINED day P&L of every strategy on every real broker (realized + open positions at
// the last tick price, markPrice.ts, trades opened today; the paper broker is not counted) reaches it, the lock-profits action runs once - every strategy is disabled in
// config.yml and every open long is limit-sold at its live price (disableAllAndLockProfits, the same code as POST /order/lock-profits).
// One trip per day, durable in Mongo (strategyLatches, ownerType 'OverAllMaxProfit'): re-enabling strategies afterwards does not trip it again
// the same day. A trip whose lock failed (`locked` false) is retried every cycle.
export const OVERALL_MAX_PROFIT_OWNER = 'OverAllMaxProfit';
const INTERVAL_MS = 60_000; // one check a minute (user's rule 2026-11-25)
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nonFiniteAlert = new NonFiniteAlert();
let running = false;

export function overAllMaxProfit(settings?: Record<string, any> | null): number {
    const v = (settings ?? (configService.getConfig().settings as any))?.overAllMaxProfit;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

const countedOpen = (stats: { trades: any[] }) => stats.trades.filter((t) => String(t.broker || 'kite') !== 'paper' && isOpenedToday(t.entryTime)
    && num(t.quantity) > 0 && Number.isFinite(Number(t.price)) && Number(t.price) > 0);

// `resting` (the contracts' resting sells) values the quantity they cover at no more than their price (restingMarks.ts).
export async function combinedPnl(stats: { trades: any[]; closedTrades: any[] }, resting?: Map<string, RestingSell[]>): Promise<number> {
    const mine = (t: any) => String(t.broker || 'kite') !== 'paper' && isOpenedToday(t.entryTime);
    const open = countedOpen(stats);
    const realized = stats.closedTrades.filter(mine).reduce((s, t) => s + num(t.realizedPnL), 0) + open.reduce((s, t) => s + num(t.realizedPnL), 0);
    // Tick price first; a throttled live quote only for a row no strategy here has a tick for (markPrice.ts).
    const marks = new Map<any, number>();
    for (const t of open) marks.set(t, await markPrice(t));
    const values = resting ? cappedMarks(open, marks, resting) : marks;
    return realized + open.reduce((s, t) => s + (values.get(t)! - num(t.price)) * num(t.quantity), 0);
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
            const stats = await orderClient.stats();
            let total = await combinedPnl(stats);
            // About to trip: judged again with the quantity covered by a resting sell valued at no more than its price (the sells are read first, then a fresh snapshot).
            if (Number.isFinite(total) && total >= cap) {
                const resting = await restingByContract(countedOpen(stats));
                total = await combinedPnl(await orderClient.stats(), resting);
            }
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
