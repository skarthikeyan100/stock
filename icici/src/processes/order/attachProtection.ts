import Log from '../../util/Log';
import Kite from '../../kite/Kite';
import { roundToTick } from '../../util/tick';
import bookkeeping from './bookkeeping';
import * as exitMonitor from './exitMonitor';
import { exchangeForTsym } from '../../util/underlyings';

// Attaches an absolute target / stop-loss to a position that is ALREADY open (a filled limit buy), unlike finalizeEntry which runs
// at entry. Used by RecommendationStrategy. Mirrors kiteExecutor.setTargetStopLoss: finds the open row in bookkeeping, sets its
// prices, and arms the broker-side exit where the broker has one.
//   kite  - two-leg GTT (OCO), exitMonitor watch-only for live P&L; if the GTT call fails, in-app exitMonitor takes over.
//   ant   - no post-fill bracket/cover exists (a BO/cover must be the entry order), so the in-app exitMonitor owns the exit.
//   other - refused; the caller falls back to its own tick-driven stop.
// Returns how the position is protected.
export type ProtectionMode = 'gtt' | 'exitMonitor';

export async function attachProtection(
    userId: string,
    broker: 'kite' | 'ant' | 'breeze' | 'prism',
    tradingSymbol: string,
    targetPrice: number,
    stopLossPrice: number,
): Promise<{ mode: ProtectionMode; gttTriggerId?: number }> {
    if (broker !== 'kite' && broker !== 'ant') {
        throw new Error(`attachProtection: no post-fill target/stop-loss primitive for ${broker}`);
    }
    const trade = bookkeeping.trades.find((t) => t.tsym === tradingSymbol && t.user === userId && (t.broker ?? 'kite') === broker);
    if (!trade) throw new Error(`attachProtection: no open ${broker} trade for ${tradingSymbol} (${userId})`);
    if (!trade.token) throw new Error(`attachProtection: ${tradingSymbol} has no token - exit could not be monitored`);

    const target = roundToTick(targetPrice);
    const stop = roundToTick(stopLossPrice);
    const entry = trade.price;
    if (!(stop > 0) || !(stop < entry) || !(entry < target)) {
        throw new Error(`attachProtection: need 0 < stopLoss < entry < target (stopLoss=${stop}, entry=${entry}, target=${target})`);
    }
    const exchange = exchangeForTsym(tradingSymbol);
    trade.targetPrice = target;
    trade.stopLossPrice = stop;
    trade.targetPoints = roundToTick(target - entry);

    if (broker === 'kite' && bookkeeping.getUserUseGTT(userId)) {
        try {
            trade.gttTriggerId = await Kite.getInstance().placeTargetStopLossGTT(
                trade.tsym, exchange, trade.quantity, entry, target - entry, entry - stop, entry,
            );
            exitMonitor.registerTrade(trade, exchange, 'kite', true);
            bookkeeping.notifyTargetStopLossChanged();
            return { mode: 'gtt', gttTriggerId: trade.gttTriggerId };
        } catch (e) {
            Log.log(`[order] attachProtection: GTT placement failed for ${tradingSymbol} (${userId}) - falling back to in-app target/SL monitoring:`, e);
        }
    }
    exitMonitor.registerTrade(trade, exchange, broker);
    bookkeeping.notifyTargetStopLossChanged();
    return { mode: 'exitMonitor' };
}

// Removes whatever attachProtection armed on a position (the Kite GTT, the in-app exitMonitor watch) so the caller can close it
// by hand without a trigger firing later against a flat account. Idempotent; a GTT delete failure throws (the trigger may be live).
export async function cancelProtection(
    userId: string,
    broker: 'kite' | 'ant' | 'breeze' | 'prism',
    tradingSymbol: string,
): Promise<{ gttDeleted: boolean }> {
    const trade = bookkeeping.trades.find((t) => t.tsym === tradingSymbol && t.user === userId && (t.broker ?? 'kite') === broker);
    if (!trade) return { gttDeleted: false };
    let gttDeleted = false;
    if (trade.gttTriggerId != null) {
        await Kite.getInstance().deleteGTT(trade.gttTriggerId);
        trade.gttTriggerId = undefined as any;
        gttDeleted = true;
    }
    if (trade.token && (broker === 'kite' || broker === 'ant')) exitMonitor.unregisterTrade(userId, trade.token, broker);
    bookkeeping.notifyTargetStopLossChanged();
    return { gttDeleted };
}
