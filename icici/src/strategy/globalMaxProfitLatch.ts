import Mongo from '../tools/mongo';
import Log from '../util/Log';
import { localDayKey } from './dayKey';

// Durable day latch of the GLOBAL maxProfit (config.yml settings.maxProfit, one rupee value for every broker) for strategies that have no profit stop of
// their own. One doc per (strategy userId, broker, day) in strategyLatches with ownerType 'GlobalMaxProfit', so it survives a restart and is
// readable by the order process, which refuses every new buy of a latched strategy+broker (bookkeeping.canPlaceOrder). The writer is the
// monitor in processes/strategies/globalMaxProfit.ts; Strategy.reset() (admin reset) clears it.
export const GLOBAL_MAX_PROFIT_OWNER = 'GlobalMaxProfit';

export async function latchGlobalMaxProfit(userId: string, broker: string, info: { pnl: number; cap: number }): Promise<boolean> {
    const key = { ownerType: GLOBAL_MAX_PROFIT_OWNER, userId, scope: broker, day: localDayKey() };
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) throw new Error('Mongo not connected');
            await col.updateOne(key, { $set: { maxProfitTripped: true, pnl: info.pnl, cap: info.cap, updatedAt: new Date() } }, { upsert: true });
            cache.set(`${userId}|${broker}`, { at: Date.now(), latched: true });
            return true;
        } catch (e) {
            if (attempt === 2) Log.log(`[GlobalMaxProfit] ALERT: could not persist the latch for ${userId} (${broker}):`, e);
        }
    }
    return false;
}

export async function clearGlobalMaxProfit(userId: string): Promise<void> {
    try {
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        if (col) await col.deleteMany({ ownerType: GLOBAL_MAX_PROFIT_OWNER, userId });
    } catch (e) {
        Log.log(`[GlobalMaxProfit] latch clear for ${userId} failed (continuing):`, e);
    }
    for (const k of [...cache.keys()]) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

const CACHE_MS = 3000;
const cache = new Map<string, { at: number; latched: boolean }>();

// Is `userId` latched today on `broker` (any broker when omitted)? A failed read answers false (not latched): the latch only protects
// profit, and a Mongo blip must not stop a strategy from trading; the monitor re-asserts the latch on its next cycle.
export async function isGlobalMaxProfitLatched(userId: string, broker?: string): Promise<boolean> {
    const k = `${userId}|${broker ?? '*'}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.latched;
    let latched = false;
    try {
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        if (col) {
            const q: any = { ownerType: GLOBAL_MAX_PROFIT_OWNER, userId, day: localDayKey(), maxProfitTripped: true };
            if (broker) q.scope = broker;
            latched = !!(await col.findOne(q));
        }
    } catch (e) {
        Log.log(`[GlobalMaxProfit] latch read for ${userId} failed (treated as not latched):`, e);
    }
    cache.set(k, { at: Date.now(), latched });
    return latched;
}

export async function globalMaxProfitLatchedBrokers(userId: string): Promise<string[]> {
    try {
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        if (!col) return [];
        const docs = await col.find({ ownerType: GLOBAL_MAX_PROFIT_OWNER, userId, day: localDayKey(), maxProfitTripped: true }).toArray();
        return docs.map((d: any) => String(d.scope));
    } catch (e) {
        return [];
    }
}
