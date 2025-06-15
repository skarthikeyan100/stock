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
const round = (num) => Math.round(num * 100) / 100;

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

export default class HighLotStrategy extends Strategy{
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    contract: string;
    token: string;
    price: number
    buyQuantity: number = 75

    constructor() {
        super()
        this.tradeMap = new Map();
        this.name = 'HighLotStrategy';
    }

    receive = (oldStats, newStats) =>  {
        if (newStats != null && oldStats != null) {
            this.previousWindowTrend = oldStats.close > oldStats.open ? 'UP' : 'DOWN';
            this.stats = newStats;

            console.log('PivotStrategy: OldStats ',this.previousWindowTrend)
            console.log('PivotStrategy: NewStats ',newStats)
            console.log('PivotStrategy: S1: ', newStats.results.pivot.S1, ' R1: ', newStats.results.pivot.R1)
    
        }
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        const token = quote.token
        return this.ordered && this.token == token;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        if (this.ordered == true) {
            if (quote.token == this.token) {
                console.log('HighLotStrategy: diff: ', (quote.ltp - this.price))
                if ((quote.ltp - this.price) >= 1) {
                    await Prism.getInstance().sellContract(this.contract, this.buyQuantity, quote.ltp) 
                    this.ordered = false;
                }
                if ((this.price - quote.ltp) <= -20) {
                    await Prism.getInstance().sellContract(this.contract, this.buyQuantity, quote.ltp) 
                    this.ordered = false;
                }
            }
        }
    }

    initialize = (order) => {
        this.contract = order.contract;
        this.token = order.token;
        this.ordered = true;
        this.price = order.price
    }

    clear = () => {
        this.contract = '';
        this.token = '';
        this.ordered = false;
        this.price = 0;
    }

    processNiftyQuote = async (quote) => {
        let order = null;
        if (this.isTimeInRange() && !this.ordered
        && this.stats != null && this.stats.results.eventName == 'priceUpdate_60' ) {
            const S1 = this.stats.results.pivot.S1
            const R1 =this.stats.results.pivot.R1
            console.log('HighLotStrategy: processNiftyQuote: ', quote.ltp, ' S1: ', S1, ' R1: ', R1, ' PrevWindowTrend: ', this.previousWindowTrend)
            if (this.stats != null && quote.token === 'NIFTY' && this.stats.S1 != -1 && this.stats.R1 != -1) {
                if ( quote.ltp < this.stats.results.pivot.S1  && this.previousWindowTrend === 'DOWN') {
                    console.log('HighLotStrategy: Buy PUT as support is breached')
                    order = await this.addOrder(quote.ltp, PUT, this.buyQuantity);
                    this.initialize(order);
                } else if ( quote.ltp > this.stats.results.pivot.R1  && this.previousWindowTrend === 'UP' ) {
                    console.log('HighLotStrategy: Buy CALL as resistance is breached')
                    const order = await this.addOrder(quote.ltp, CALL, this.buyQuantity);
                    this.initialize(order);
                } 
            }
        }
    }

    updateTrade = async (trade: Trade) => {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                console.log('HighLotStrategy: Sell ', trade.tsym, ' at ', round(trade.price + 1));
            }
            if (trade.action == this.SELL) {
                this.clear()
            }
        }
    }
}