import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import { NIFTY, CALL, PUT } from '../constants'

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}
const round = (num) => Math.round(num * 100) / 100;

const contraThreshold = 4
const targetPrice = 3
const buyQuantity: number = 300
const stopLossThreshold = 20
const buyAgainDiff = 2 // Price is reduced to this amount to create a position again

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

class Order {
    contract: string
    token: string
    qty: number
    price: number
    active: boolean = false

    BUY = 'Buy'
    SELL = 'Sell'

    // (this class's own addOrder was dead code - callers use Strategy.addOrder
    // via `this.addOrder(...)` on HighLotStrategy itself, not on this helper.)

    initialize(order: any) {
        this.contract = order.contract;
        this.token = order.token;
        this.qty = order.qty;
        this.price = order.price;
        this.active = true;
    }

    clear = () => {
        this.contract = '';
        this.token = '';
        this.qty = 0;
        this.price = 0;
        this.active = false;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }

    processOptionQuote = async (quote: OptionQuote): Promise<boolean> => {
        let addContraOrder = false;
        if (this.active && quote.token == this.token) {
            Log.log('HighLotStrategy: diff: ', (quote.ltp - this.price))
            const diff = quote.ltp - this.price
            if ( diff >= targetPrice) {
                Log.log('ProcessOptionQuote: Sell as targetPrice is reached, diff: ', diff)
                // await Prism.getInstance().sellContract(this.strategy, this.contract, this.qty, quote.ltp) 
                Log.log("************************** REVISIT **************")
                this.clear()
            } else if (diff <= -contraThreshold && diff > stopLossThreshold) {
                Log.log('ProcessOptionQuote: Add Contra Order contra? ', diff <= -contraThreshold, ' stoploss? ', diff > stopLossThreshold)
                addContraOrder = true;
            } else if (diff <= -stopLossThreshold) {
                Log.log('HighLotStrategy: Selling for stop loss')
                // await Prism.getInstance().sellContract(this.strategy, this.contract, this.qty, quote.ltp) 
                Log.log("************************** REVISIT **************")
                this.clear()
            } else {
                Log.log('NOthing happened in processOptionQuote, diff: ', diff)
            }

        }
        return addContraOrder
    }

    updateTrade = async (trade: Trade) => {
        Log.log('HighLotStrategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                this.qty = this.qty + trade.quantity
                this.price = round(totalAmount / this.qty)
            }

            if (trade.action == this.SELL) {
                this.clear();
            }
        }
    }    
}

export default class HighLotStrategy extends Strategy{
    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    callOrder: Order;
    putOrder: Order
    

    constructor(userId?: string) {
        super(userId)
        this.tradeMap = new Map();
        this.name = 'HighLotStrategy';
    }

    receive = (oldStats, newStats) =>  {
        if (newStats != null) {
            Log.log(newStats.results.eventName, ': stddev: ', newStats.stdDeviation)
        }
        this.stats = newStats;
    }


    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        const token = quote.token
        return this.callOrder.canHandleOptionQuote(token) || this.putOrder.canHandleOptionQuote(token)
    }

    processOptionQuote = async (quote: OptionQuote) => {
        if (this.ordered == true) {
            if (this.putOrder) {
                Log.log('Put Order is available')
                const addCallOrder = await this.putOrder.processOptionQuote(quote);
                if (addCallOrder) {
                    Log.log('Call Order: ', this.putOrder)
                    if (!this.callOrder || !this.callOrder.active) {
                        Log.log('HighLotStrategy: Buying CALL as PUT price has reduced')
                        const order = await this.addOrder(quote.ltp, CALL, buyQuantity);
                        this.callOrder = new Order();
                        this.callOrder.initialize(order);
                    }
                }

            }

            if (this.callOrder) {
                Log.log('Call Order is available')
                const addPutOrder = await this.callOrder.processOptionQuote(quote);

                if (addPutOrder) {
                    Log.log('Put Order: ', this.putOrder)
                    if (!this.putOrder || !this.putOrder.active) {
                        Log.log('HighLotStrategy: Buying PUT as CALL price has reduced')
                        Log.log('Quote is ', quote )
                        const order = await this.addOrder(quote.ltp, PUT, buyQuantity);
                        this.putOrder = new Order();
                        this.putOrder.initialize(order);
                    }
                }

            }
        }
    }

    isStdDeviationInRange = () => {
        const intervals = [10, 15, 30, 45, 60, 120, 300];
        const stdDev = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
        let trigger = true
        if (this.stats ) {
            for (let i = 0; i < intervals.length; i++) {
                trigger = this.stats.results.eventName == `priceUpdate_${intervals[i]}` && this.stats.stdDeviation < stdDev[i];
                Log.log(`HighLotStrategy: Checking Std Deviation for ${intervals[i]} seconds: `, this.stats.stdDeviation, ' < ', stdDev[i]);
                if (this.stats.results.eventName == `priceUpdate_${intervals[i]}` && this.stats.stdDeviation < stdDev[i]) {
                    Log.log(`HighLotStrategy: Std Deviation is within range for ${intervals[i]} seconds: `, this.stats.stdDeviation, ' < ', stdDev[i]);
                    return true;
                }
            }
        }
        return trigger;
    }

    processNiftyQuote = async (quote) => {
        if (this.isTimeInRange() && !this.ordered && this.isStdDeviationInRange()) {
            Log.log('HighLotStrategy: Buy CALL as standard deviation is low')
            const order = await this.addOrder(quote.ltp, CALL, buyQuantity);
            this.callOrder = new Order();
            this.callOrder.initialize(order);
        }
    }

    updateTrade = async (trade: Trade) => {
        if (this.callOrder) {
            this.callOrder.updateTrade(trade);
        }
        if (this.putOrder) {
            this.putOrder.updateTrade(trade);
        }

        // This goes in a loop, so monitor and close manually
        if (this.callOrder && this.callOrder.active && this.putOrder && !this.putOrder.active) {
            Log.log('CALL is active, but PUT is not active. Buying PUT again');
            const order = await this.addOrder(round(trade.ltp - buyAgainDiff), PUT, buyQuantity);
            this.putOrder.initialize(order);
        }
 
        if (this.callOrder && !this.callOrder.active && this.putOrder && this.putOrder.active) {
            Log.log('CALL is not active, but PUT is active. Buying CALL again');
            const order = await this.addOrder(round(trade.ltp - buyAgainDiff), CALL, buyQuantity);
            this.putOrder.initialize(order);

        }
    }
}