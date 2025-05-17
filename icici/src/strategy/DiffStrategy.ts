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

export default class DiffStrategy implements Strategy {
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    diff: number

    constructor() {
        this.tradeMap = new Map();
        this.name = 'DiffStrategy';
        this.diff = null;
    }

    receive(oldStats, newStats) {
        this.stats = newStats;
        this.diff = newStats.close - newStats.open
    }

    process(quote) {
        if (this.diff != null && this.ordered == false) {
            if (this.diff > 5 ) {
                console.log('Buy CALL as diff is ', this.diff)
                Prism.getInstance().buyIndex(NIFTY, quote.ltp, CALL);
            } else if (this.diff < -5) {
                console.log('Buy PUT as diff is ', this.diff)                
                Prism.getInstance().buyIndex(NIFTY, quote.ltp, PUT);
            }
            this.ordered = true;
        }
    }
}