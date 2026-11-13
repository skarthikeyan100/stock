import Log from '../util/Log';
import { sleep } from '../util/sleep';
import { Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';

// The retry every strategy's reconcile() used to carry its own copy of: ask the order side for this strategy's open trades, retrying
// for a while, and resolve undefined when it could not be read at all. The caller decides what failing closed means for it (block new
// entries, flag a position for manual review, ...). Defaults mirror the originals: 15 attempts, 2 s apart (about 30 s).
export async function fetchOpenTradesWithRetry(userId: string, tag: string, maxAttempts = 15, retryDelayMs = 2000): Promise<Trade[] | undefined> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await OrderClient.getInstance().getOpenTrades(userId);
        } catch (e) {
            Log.log(`[${tag}] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
            if (attempt < maxAttempts) await sleep(retryDelayMs);
        }
    }
    return undefined;
}

// Quantity the order side holds open for one contract of this strategy (matched by token, else tsym). undefined when it cannot be read.
// Read-only: used to tell a sell refused as "nothing sellable" because the position is gone (closed outside the platform) from one
// refused because the whole position already rests as a sell.
export async function heldQuantity(userId: string, token: string, tsym: string): Promise<number | undefined> {
    try {
        const open = await OrderClient.getInstance().getOpenTrades(userId);
        return open.filter((t: any) => String(t.token) === String(token) || t.tsym === tsym).reduce((s: number, t: any) => s + Math.max(0, Number(t.quantity) || 0), 0);
    } catch {
        return undefined;
    }
}
