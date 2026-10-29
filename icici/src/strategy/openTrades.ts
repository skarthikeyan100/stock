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
