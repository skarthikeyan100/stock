export interface StrategyInstanceConfig {
    type: string;
    userId?: string;
    enabled: boolean;
    lossLimit?: number;
    lotLimit?: number;
    maxExposure?: number; // canonical (REFACTOR_PLAN.md section 3)
    /** @deprecated use maxExposure */
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
    targetPoints = 5
    stopLossPoints = 10
    /** @deprecated use targetPoints */
    targetPriceDiff = 5
    /** @deprecated use stopLossPoints */
    stopLossPriceDiff = 10
    trailingDistance = 3
    cooldownSeconds = 60
    logQuotes = false
}
