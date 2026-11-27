// Buys an executor waits for (PendingOrderTracker.awaitBuy, marked with `cancelAfter`) can rest at the broker for BUY_FILL_WAIT. This sweep takes
// such a buy back when it must not rest any longer:
//  - its wait time is over and nobody waits for it any more (the process restarted in the middle of the wait, or the waiter's own cancel failed);
//  - the end-of-day close came after it was placed (a strategy's buy only: a frontend user's own buy is not part of any strategy's day);
//  - the strategy hit the global max profit on that broker after placing it.
// A waiter that is still there sees the cancelled status at its next poll and books whatever filled, as after its own timeout.
import Log from '../../util/Log';
import configService from '../../prism/ConfigService';
import { isPastEodClose, DEFAULT_EOD_CLOSE_TIME } from '../../util/eodClose';
import { BUY_FILL_WAIT } from '../../util/fillWait';
import { isGlobalMaxProfitLatched } from '../../strategy/globalMaxProfitLatch';
import { OrderAlreadyFilledError, OptionExchange } from './BrokerExecutor';
import { TRACKERS, TRACKER_BROKERS } from './pendingTrackers';

export type WaitedBuyCanceller = (broker: string, userId: string, orderId: string, exchange: OptionExchange) => Promise<void>;

// A failed cancel is repeated, but not on every sweep; after FAST_TRIES only every SLOW_RETRY_MS (an order the broker no longer knows).
const RETRY_MS = 30_000;
const FAST_TRIES = 5;
const SLOW_RETRY_MS = 10 * 60_000;
const tries = new Map<string, { at: number; n: number }>();

function isStrategyUser(userId: string): boolean {
    try {
        return configService.getInstances().some((c) => (c.userId || c.type) === userId);
    } catch {
        return false;
    }
}

export async function sweepWaitedBuys(cancel: WaitedBuyCanceller, now: number = Date.now()): Promise<void> {
    for (const broker of TRACKER_BROKERS) {
        for (const o of TRACKERS[broker].all()) {
            if (o.action !== 'Buy' || !o.cancelAfter) continue;
            const key = `${broker}:${o.orderId}`;
            const last = tries.get(key);
            if (last && now - last.at < (last.n >= FAST_TRIES ? SLOW_RETRY_MS : RETRY_MS)) continue;
            let why: string | undefined;
            if (now >= o.cancelAfter && !TRACKERS[broker].isHeld?.(o.orderId)) why = `unfilled ${BUY_FILL_WAIT.ms / 60_000} min after placement and nobody is waiting for it`;
            else if (isStrategyUser(o.userId)) {
                const placedAt = o.cancelAfter - BUY_FILL_WAIT.ms;
                if (isPastEodClose(DEFAULT_EOD_CLOSE_TIME, new Date(now)) && !isPastEodClose(DEFAULT_EOD_CLOSE_TIME, new Date(placedAt))) why = 'the end-of-day close';
                else if (await isGlobalMaxProfitLatched(o.userId, broker)) why = 'the global max profit is hit';
            }
            if (!why) continue;
            tries.set(key, { at: now, n: (last?.n ?? 0) + 1 });
            Log.log(`[order] cancelling the waiting buy ${o.orderId} ${o.tradingSymbol} qty=${o.quantity} (${o.userId}, ${broker}): ${why}`);
            try {
                await cancel(broker, o.userId, o.orderId, o.exchange);
            } catch (e) {
                if (e instanceof OrderAlreadyFilledError) Log.log(`[order] waiting buy ${o.orderId} (${o.userId}, ${broker}) had filled ${e.filledQuantity} - it is booked by its waiter or the pending poll`);
                else Log.log(`[order] ALERT: could not cancel the waiting buy ${o.orderId} ${o.tradingSymbol} (${o.userId}, ${broker}) - retried, check the broker:`, e);
            }
        }
    }
}

// Every waited buy of one user, cancelled at once (the drawdown breach): not awaited by the caller's exits.
export async function cancelWaitedBuysOf(userId: string, cancel: WaitedBuyCanceller, why: string): Promise<void> {
    for (const broker of TRACKER_BROKERS) {
        for (const o of TRACKERS[broker].all().filter((p) => p.action === 'Buy' && !!p.cancelAfter && p.userId === userId)) {
            Log.log(`[order] cancelling the waiting buy ${o.orderId} ${o.tradingSymbol} qty=${o.quantity} (${userId}, ${broker}): ${why}`);
            await cancel(broker, userId, o.orderId, o.exchange).catch((e) => Log.log(`[order] cancelling the waiting buy ${o.orderId} failed:`, e));
        }
    }
}
