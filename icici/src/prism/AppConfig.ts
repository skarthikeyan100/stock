export interface StrategyInstanceConfig {
    type: string;
    userId?: string;
    enabled: boolean;
    lossLimit?: number;
    lotLimit?: number;
    maxInvestment?: number; // per broker
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
    targetPoints = 5
    stopLossPoints = 10
    /** @deprecated use targetPoints */
    targetPriceDiff = 5
    /** @deprecated use stopLossPoints */
    stopLossPriceDiff = 10
    trailingDistance = 3
    cooldownSeconds = 60
    logQuotes = false
    /** 'HH:mm': the one end-of-day close time for every strategy (never a per-strategy key) */
    eodCloseTime?: string
}
