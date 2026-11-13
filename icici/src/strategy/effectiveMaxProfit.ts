import configService from '../prism/ConfigService';

// The global maxProfit (config.yml `settings.maxProfit`): ONE positive number of rupees, the same for every broker. It applies to EVERY
// strategy; each strategy instance on each of its brokers is judged separately against it (its own P&L on that broker, not a shared pool).
// A strategy block's own `maxProfit` overrides it for that strategy. Absent / 0 / not a positive number = no global cap. Read at each call,
// so a config edit applies live.
export function globalMaxProfit(settings?: Record<string, any> | null): number {
    const v = (settings ?? (configService.getConfig().settings as any))?.maxProfit;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// Rupee cap for one strategy instance on one broker: the block's own maxProfit when it sets one, else the global value.
// `ownRupees` is the block's own cap already converted to rupees (undefined when the block does not set it).
export function effectiveMaxProfit(ownRupees: number | undefined | null, settings?: Record<string, any> | null): number {
    if (ownRupees !== undefined && ownRupees !== null) return Number.isFinite(ownRupees) && ownRupees > 0 ? ownRupees : 0;
    return globalMaxProfit(settings);
}
