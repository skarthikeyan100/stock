export interface StrategyInstanceConfig {
    type: string;
    userId?: string;
    enabled: boolean;
    lossLimit?: number;
    lotLimit?: number;
    maxInvestment?: number;
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
}
