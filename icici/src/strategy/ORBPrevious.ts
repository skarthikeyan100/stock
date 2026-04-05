import Log from '../util/Log';
import { Strategy, Outcome } from "./strategy";
import { NiftyQuote, OptionQuote, Trade } from "model/model";
import { throwStatement } from "@babel/types";

class Variables {
    startTime
    endTime
    high
    low

}
export class ORBPrevious extends Strategy {
    processNiftyQuote(quote: NiftyQuote) {
        throw new Error("Method not implemented.");
    }
    processOptionQuote(quote: OptionQuote) {
        throw new Error("Method not implemented.");
    }
    receive(oldStats: any, newStats: any) {
        throw new Error("Method not implemented.");
    }
    tradeMap: Map<String, Trade> = new Map();
    variablesMap: Map<String, Variables> = new Map();
    name = 'ORBPrevious'

    time = 30 * 60 // 30 mins or 1800 seconds

    process(quote: NiftyQuote) {
        // const v = this.variablesMap.get(token);
        // if (v) {
        //     Log.log('Token: ', token, ' v: ', v, ' variablesMap ', this.variablesMap);
        //     Log.log('High: ',  v.high, ' Low: ', v.low, ' quote: ', quote.ltp, 'startTime: ', v.startTime, ' endTime: ', v.endTime)
    
        // }

        // if (this.tradeMap.get(token) != null) {
        //     return Outcome.PENDING_CLOSURE;
        // }
        // if (v.startTime) {
        //     Log.log('Set StartTime')
        //     v.startTime = quote.ltt;
        // }
        // if (!v.endTime) {
        //     //set high
        //     if (!v.high) {
        //         v.high = quote.ltp;
        //     } else if (quote.ltp > v.high) {
        //         v.high = quote.ltp;
        //     }

        //     //set low
        //     if (!v.low) {
        //         v.low = quote.ltp;
        //     } else if (quote.ltp < v.low) {
        //         v.low = quote.ltp;
        //     }

        //     // set end time
        //     if (quote.ltt - v.startTime >= this.time) {
        //         v.endTime = quote.ltt;
        //     }
        // } else {
        //     if (quote.ltp < v.low) {
        //         // return Outcome.PUT
        //     }
        //     if (quote.ltp > v.high) {
        //         // return Outcome.CALL
        //     }
        // }

        // this.variablesMap.set(token, v);
        // // return Outcome.WAIT;

    }

    addTrade(trade: Trade) {
        this.tradeMap.set(trade.token, trade);
    }

}
