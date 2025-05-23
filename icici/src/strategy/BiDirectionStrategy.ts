import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
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

const stopLossThreshold= 1000
const buyAgainDiff = 20
const targetPrice = 10

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

export default class BiDirectionStrategy extends Strategy {
    call: OrderInfo = {} as OrderInfo
    put: OrderInfo = {} as OrderInfo
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

    canHandleOptionQuote(quote: OptionQuote): boolean {
        const token = quote.token
        const hasContract = this.call.token == token || this.put.token == token
        return hasContract ? true: false;
    }

    async processOptionQuote(quote: OptionQuote) {
        if (this.ordered == true) {
            const profit = this.findProfit(quote.token, quote.ltp)

            console.log('BiDirectionStrategy: profit: ', profit, ' call profit: ', this.call.profit, ' put profit: ', this.put.profit)
            if (profit > this.expectedProfit) {
                await this.closeStrategy()
            }

            // Handle negative direction

            if (this.call && this.call.token && this.call.token == quote.token && 
                (this.call.lastOrderedPrice - quote.ltp) < -stopLossThreshold) {
                console.log('BiDirectionStrategy: buy call at ', quote.ltp)
                this.call.lastOrderedPrice = quote.ltp
                this.call.status = OrderStatus.ORDERED
                await Prism.getInstance().buyContract(this.call.contract, quote.ltp)
            }

            if (this.put && this.put.token && this.put.token == quote.token && 
                (this.put.lastOrderedPrice - quote.ltp) < -stopLossThreshold) {
                console.log('BiDirectionStrategy: buy put at ', quote.ltp)
                this.put.lastOrderedPrice = quote.ltp
                this.put.status = OrderStatus.ORDERED

                await Prism.getInstance().buyContract(this.put.contract, quote.ltp)
            }

            // Handle positive direction

            if (this.call && this.call.token && this.call.token == quote.token && 
                (quote.ltp - this.call.price) >= targetPrice) {
                console.log('BiDirectionStrategy: buy call at ', quote.ltp)
                await Prism.getInstance().sellContract(this.call.contract, this.call.qty, quote.ltp)
                //Stup Monitor price
            }

            if (this.put && this.put.token && this.put.token == quote.token && 
                (quote.ltp - this.put.price) >= targetPrice) {
                console.log('BiDirectionStrategy: buy put at ', quote.ltp)
                await Prism.getInstance().sellContract(this.put.contract, this.call.qty, quote.ltp)
            }

        }
    }
    
    async processNiftyQuote(quote: NiftyQuote) {
        
        // if (this.stats != null) {
        //     console.log(this.getClassName(), ' eventName: ', this.stats.results.eventName )
        //     console.log(this.getClassName(), ' this.isTimeInRange(): ', this.isTimeInRange() )
        //     console.log(this.getClassName(), ' ordered: ', this.ordered )
        // }
        if (this.isTimeInRange() && this.stats != null && 
            this.stats.results.eventName == 'priceUpdate_60' && !this.ordered) {
            console.log('BiDirectionStrategy: Buy CALL and PUT as high is ', this.stats.high, ' and low is ', this.stats)

            const putInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.high, PUT);
            this.put = putInfo

            const callInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.low, CALL);
            this.call = callInfo
            
            this.ordered = true;
        }
        
        
    }

    closeStrategy = async () => {
        if (this.call && this.call.contract) {
            await Prism.getInstance().sell(this.call.contract, this.call.qty, this.call.price)
        }
        
        if (this.call && this.call.contract) {
            await Prism.getInstance().sell(this.put.contract, this.put.qty, this.put.price)
        }
        

        this.call = {} as OrderInfo
        this.put = {} as OrderInfo
        this.ordered = false;
        this.orderMap.clear();

    }

    findProfit = (contract, ltp) => {
        let profit = 0
        if (this.call && this.call.contract == contract) {
            this.call.profit = (ltp - this.call.price) * this.call.qty
        }

        if (this.put && this.put.contract == contract) {
            this.put.profit = (ltp - this.put.price) * this.call.qty
        }
        profit += this.call.profit ? this.call.profit: 0;
        profit += this.put.profit ? this.put.profit: 0;
        return profit
    }

    isPending = () => this.call.contract && this.put.contract;

    updateTrade(trade: Trade) {
        console.log('Bidirection Strategy: action: ', trade.action, ' ', trade.token)
        if (trade.action === this.BUY) {
            if (trade.right == CALL) {
                this.call.status = OrderStatus.BOUGHT;
                this.call.lastOrderedPrice = trade.ltp
                const totalAmount = (this.call.qty * this.call.price) + (trade.quantity * trade.ltp)
                this.call.qty = this.call.qty + trade.quantity
                this.call.price = totalAmount / this.call.qty
            }
            if (trade.right == PUT) {
                this.put.status = OrderStatus.BOUGHT;
                this.put.lastOrderedPrice = trade.ltp
                const totalAmount = (this.put.qty * this.put.price) + (trade.quantity * trade.ltp)
                this.put.qty = this.put.qty + trade.quantity
                this.put.price = totalAmount / this.put.qty
            }
            
        }

        if (trade.action === this.SELL) {
            if (trade.right == PUT) {
                this.put = {} as OrderInfo
            }
            if (trade.right == CALL) {
                this.call = {} as OrderInfo
            }
        }
    }
}