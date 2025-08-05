export default class AppConfig {
    settings: Settings
    sentimentStrategy: SentimentStrategy;
    buySellStrategy: BuySellStrategy;
    intermittentStrategy: IntermittentStrategy;
}

export class Settings {
    minPrice = 70
    maxPrice = 100
}

export class SentimentStrategy {
    enabled: boolean = false;
    averageThreshold: number =  5
    targetPrice: number =  2
    orderQuantity: number = 300
    sentiment: string = 'any'
    loopCount: number = 3
}

export class BuySellStrategy {
    enabled = false
    averageThreshold = 10
    targetPrice = 6
    initialQuantity = 75;
    stopEnabled: false;
    activateIntermittentCount = 3
    maxIterationCount = 4
    incrementFactor = 'iteration'
    incrementQuantity = 75
    logEnabled = true
}

export class IntermittentStrategy {
    enabled = false
    targetPrice = 2
    quantity = 900
    loopCount = 3
    threshold = 5
    logEnabled = true
}