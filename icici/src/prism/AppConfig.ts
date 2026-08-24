export interface StrategyInstanceConfig {
    type: string;
    userId?: string;
    enabled: boolean;
    lossLimit?: number;
    lotLimit?: number;
    maxInvestment?: number;
    useGTT?: boolean;
    [key: string]: any;
}

export default class AppConfig {
    settings: Settings
    strategies?: StrategyInstanceConfig[];
}

export class Settings {
    minPrice = 20
    maxPrice = 150
    targetPriceDiff = 5
    stopLossPriceDiff = 10
    trailingDistance = 3
    cooldownSeconds = 60
    logQuotes = false
    // Payout rules (src/payout.ts) - minimum all-time profit before a user's
    // first-ever payout, and the max % of a payout period's profit any single
    // day may contribute before the payout is blocked outright.
    safetyBufferAmount = 5000
    consistencyLimitPercent = 40
}
