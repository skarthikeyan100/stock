import { NiftyQuote, Trade } from "model/model";
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

export default class PivotStrategy implements Strategy {
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false

    constructor() {
        this.tradeMap = new Map();
        this.name = 'PivotStrategy';
    }

    receive(oldStats, newStats) {
        console.log('Received stats in PivotStrategy: ', oldStats, newStats)
        if (oldStats != null) {
            this.previousWindowTrend = oldStats.close > oldStats.open ? 'UP' : 'DOWN';
            this.stats = newStats;
    
        }
    }

    process(quote) {
        if (!this.ordered) {
            if (this.stats != null && !f.hasExceededTrades() && quote.token === 'NIFTY' && this.stats.S1 != -1 && this.stats.R1 != -1) {
                if ( quote.ltp < this.stats.results.pivot.S1  && this.previousWindowTrend === 'DOWN') {
                    console.log('Buy PUT as support is breached')
                    Prism.getInstance().buyIndex(NIFTY, quote.ltp, PUT);
                } else if ( quote.ltp > this.stats.results.pivot.R1  && this.previousWindowTrend === 'UP' ) {
                    console.log('Buy PUT as resistance is breached')
                    Prism.getInstance().buyIndex(NIFTY, quote.ltp, CALL);
                } 
            }
            this.ordered = true;
        }
    }
}