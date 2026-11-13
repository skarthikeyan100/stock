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
    /** 'HH:mm' (default 15:45, at or after the close): when the end-of-day broker -> Mongo sync runs; `npm run sync` runs it on demand */
    eodReconcileTime?: string
    /** 0-100: share of every frontend user's lots the admin user mirrors with a real order (floor to whole lots); 0 or absent = no mirror */
    mirrorPercentage?: number
    /** true: the anonymous /demo page replays a recorded day (CSV backups) instead of the live feed (routes/demoReplay.ts) */
    demoReplay?: boolean
    /** '<Mon-DD>' folder of the recorded day to replay, e.g. 'Nov-13' */
    demoReplayDate?: string
    /** replay speed multiplier (1 = recorded speed; default 10) */
    demoReplaySpeed?: number
    /** backup directory holding <Mon-DD>/csv/{Quote,OptionQuote}.csv (default ~/later/data/backups) */
    demoReplayDir?: string
    /** while set, the EOD email API sends every user's email to this one address (subject prefixed [TEST for <user>]); remove it to email real users */
    eodEmailTestRecipient?: string
}
