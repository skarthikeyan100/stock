import { NiftyQuote, Trade } from "model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'
import moment from "moment";

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

export default class DiffStrategy extends Strategy {
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    diff: number
    expectedDiff = 10

    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'DiffStrategy';
        this.diff = null;
    }

    receive(oldStats, newStats) {
        console.log('DiffStrategy: isOldStats null? ', oldStats == null)
        console.log('DiffStrategy: isNewStats null? ', newStats == null)
        this.stats = newStats;
        this.diff = newStats.close - newStats.open
        console.log('Difference in new stats: ', this.diff)
    }

    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(10).minute(0);
        const endTime = moment().hour(15).minute(0);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    async process(quote) {
        if (this.stats.results.eventName == 'priceUpdate_300') {
            if (this.isTimeInRange() && this.diff != null && this.ordered == false) {
                if (this.diff > this.expectedDiff ) {
                    console.log('DiffStrategy: Buy CALL as diff is ', this.diff)
                    await this.addOrder(quote.ltp, CALL)
                } else if (this.diff < -this.expectedDiff) {
                    console.log('DiffStrategy: Buy PUT as diff is ', this.diff)                
                    await this.addOrder(quote.ltp, PUT)
                }
            }
        }
    }

}