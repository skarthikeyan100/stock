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

export default class BiDirectionStrategy implements Strategy {
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false

    constructor() {
        this.tradeMap = new Map();
        this.name = 'BiDirectionStrategy';
    }

    receive(oldStats, newStats) {
        this.stats = newStats;
    }

    process(quote) {
        if (this.stats != null && !this.ordered) {
            console.log('Buy CALL and PUT as high is ', this.stats.high, ' and low is ', this.stats)
            Prism.getInstance().buyIndex(NIFTY, this.stats.high, PUT);
            Prism.getInstance().buyIndex(NIFTY, this.stats.low, CALL);
            this.ordered = true;
        }

    }
}