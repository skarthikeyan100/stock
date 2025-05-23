import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

export default class PivotStrategy extends Strategy{
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any

    constructor() {
        super()
        this.tradeMap = new Map();
        this.name = 'PivotStrategy';
    }

    receive(oldStats, newStats) {
        console.log('PivotStrategy: isOldStats null? ', oldStats == null)
        console.log('PivotStrategy: isNewStats null? ', newStats == null)
        if (oldStats != null) {
            this.previousWindowTrend = oldStats.close > oldStats.open ? 'UP' : 'DOWN';
            this.stats = newStats;
        }
    }

    async processNiftyQuote(quote) {
        if (!f.hasExceededTrades()) {
            if (this.isTimeInRange() && !this.ordered) {
                if (this.stats != null && quote.token === 'NIFTY' && this.stats.S1 != -1 && this.stats.R1 != -1) {
                    if ( quote.ltp < this.stats.results.pivot.S1  && this.previousWindowTrend === 'DOWN') {
                        console.log('PivotStrategy: Buy PUT as support is breached')
                        await this.addOrder(quote.ltp, PUT);
                    } else if ( quote.ltp > this.stats.results.pivot.R1  && this.previousWindowTrend === 'UP' ) {
                        console.log('PivotStrategy: Buy PUT as resistance is breached')
                        await this.addOrder(quote.ltp, CALL);
                    } 
                }
            }
        }
    }

    processOptionQuote(quote: OptionQuote) {
    }

}