import { NiftyQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import moment from "moment";

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

export default class BiDirectionStrategy extends Strategy {
    calls: Array<OrderInfo> = []
    puts: Array<OrderInfo> = []
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    expectedProfit = 2000

    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'BiDirectionStrategy';
    }

    receive(oldStats, newStats) {
        this.stats = newStats;
        console.log('BiDirectionStrategy: isNewStats null? ', newStats == null)
    }

    async process(quote: NiftyQuote) {
        console.log('BiDirectionStrategy: isTimeInRange? ', this.isTimeInRange() )
        if (this.stats != null) {
            console.log('BiDirectionStrategy: eventName: ', this.stats.results.eventName, ' ordered: ', this.ordered )
        }
        
        if (this.isTimeInRange() && this.stats != null && 
            this.stats.results.eventName == 'priceUpdate_300' && !this.ordered) {
            console.log('BiDirectionStrategy: Buy CALL and PUT as high is ', this.stats.high, ' and low is ', this.stats)

            const putInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.high, PUT);
            this.puts.push(putInfo)

            const callInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.low, CALL);
            this.calls.push(callInfo)
            
            this.ordered = true;
        } else if (this.ordered == true) {
            const profit = this.findProfit(quote.token, quote.ltp)
            if (profit > this.expectedProfit) {
                await this.closeStrategy()
            }
        }
         

    }

    closeStrategy = async () => {
        this.calls.forEach( async c => {  
            await Prism.getInstance().sell(c.contract, c.qty, c.price)
        })

        this.puts.forEach( async p => {  
            await Prism.getInstance().sell(p.contract, p.qty, p.price)
        })
    }

    findProfit = (contract, ltp) => {
        const call  = this.calls.find( c => c.contract == contract);
        if (call) {
            call.profit = ltp - call.price
        }
        const put  = this.puts.find( p => p.contract == contract);
        if (put) {
            put.profit = ltp - put.price
        }

        let profit = 0;
        this.calls.forEach( c => {
            if (c.profit) {
                profit += c.profit
            }
        })

        this.puts.forEach( p => {
            if (p.profit) {
                profit += p.profit
            }
        })
        return profit;
    }

    isPending = () => this.calls.length == 0 && this.puts.length == 0;

    updateTrade(trade: Trade) {
        console.log('Bidirection Strategy: action: ', trade.action, ' ', trade.token)
        if (trade.action === this.BUY) {
            if (trade.right == PUT) {
                const t = this.puts.find( t => t.contract === trade.tsym);
                t.status = OrderStatus.BOUGHT;
            }
            if (trade.right == CALL) {
                const t = this.calls.find( t => t.contract === trade.tsym);
                t.status = OrderStatus.BOUGHT;
            }
        }

        if (trade.action === this.SELL) {
            if (trade.right == PUT) {
                this.puts = this.puts.filter( t => t.contract !== trade.tsym);
            }
            if (trade.right == CALL) {
                this.calls = this.calls.filter( t => t.contract !== trade.tsym);
            }
        }

        const tradeInProgress = this.orderMap.has(trade.token)
        console.log(this.getClassName(), ': updateTrade: ', trade.tsym, ' tradeInProgress: ', tradeInProgress)

        if (tradeInProgress && trade.action === 'SELL') {
            this.ordered = false;
            this.orderMap.delete(trade.tsym);
        }
    }
}