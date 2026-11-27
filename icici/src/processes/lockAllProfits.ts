import Log from '../util/Log';
import configService from '../prism/ConfigService';
import type OrderClient from './strategies/OrderClient';

// The lock-profits action behind POST /order/lock-profits and the combinedMaxProfit monitor (one code path for both): (1) writes enabled: false on every
// enabled strategy to config.yml (one atomic write, hot-reloaded by every process), so nothing can buy behind the lock; a write that fails stops
// here with nothing sold. (2) The order process cancels resting buys and limit-sells every open long at its live price (orderProcess.ts's lockProfits).
export async function disableAllAndLockProfits(orderClient: OrderClient, opts: { broker?: string; reprice?: boolean } = {}): Promise<{ disabledStrategies: string[]; lock: any }> {
    const cfg = configService.getConfig();
    const toDisable = (cfg.strategies || []).filter((s: any) => s.enabled);
    const disabledStrategies = toDisable.map((s: any) => s.userId || s.type);
    toDisable.forEach((s: any) => { s.enabled = false; });
    try {
        configService.writeConfig(cfg);
    } catch (writeErr) {
        toDisable.forEach((s: any) => { s.enabled = true; }); // the file was not changed: this process's copy must not claim it was
        throw writeErr;
    }
    configService.reloadNow();
    if (disabledStrategies.length) Log.log(`[lockProfits] disabled in config.yml: ${disabledStrategies.join(', ')}`);
    const lock = await orderClient.lockProfits({ broker: opts.broker, reprice: opts.reprice });
    return { disabledStrategies, lock };
}
