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

const stopLossThreshold = 10
const buyAgainDiff = 10
const targetPrice = 10

const round = (num) => Math.round(num * 100) / 100;


//Strategy: If support is breached, buy put?. If resistance is breached, buy CALL

export default class BiDirectionStrategy extends Strategy {
    call: OrderInfo = {} as OrderInfo
    put: OrderInfo = {} as OrderInfo
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    expectedProfit = 2000
    maxLoss = 10000
    isCallActive = false
    isPutActive = false
    sellCallOrderPlaced = false
    sellPutOrderPlaced = false
    

    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'BiDirectionStrategy';
        console.log('BiDirectionStrategy: constructor called')
    }

    receive(oldStats, newStats) {
        this.stats = newStats;
        console.log('BiDirectionStrategy: isNewStats null? ', newStats == null)
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {

        const token = quote.token
        if (this.call && this.call.token && token == this.call.token) {
            return true
        }

        if (this.put && this.put.token && token == this.put.token) {
            return true
        }
        return false;

    }

    async processOptionQuote(quote: OptionQuote) {
        if (this.ordered == true) {
            const profit = this.findProfit(quote.token, quote.ltp)

            if (profit > this.expectedProfit) {
                await this.closeStrategy()
            }

            if (profit < -this.maxLoss) {
                await this.closeStrategy()
            }

            // Handle negative direction

            if (this.call && this.call.token && this.call.token == quote.token 
                && !(this.call.status == OrderStatus.ORDERED)
                && (quote.ltp - this.call.lastOrderedPrice) < -stopLossThreshold) {
                    console.log('BiDirectionStrategy: buy call contract ', this.call.contract, ' at ', quote.ltp)
                    this.call.lastOrderedPrice = quote.ltp
                    this.call.status = OrderStatus.ORDERED
                    await Prism.getInstance().buyContract(this.call?.contract, quote.ltp)
            }

            if (this.put && this.put.token && this.put.token == quote.token
                && !(this.put.status == OrderStatus.ORDERED)
                && (quote.ltp - this.put.lastOrderedPrice - quote.ltp) < -stopLossThreshold) {
                    console.log('BiDirectionStrategy: buy put contract ', this.put.contract, ' at ', quote.ltp)                
                    this.put.lastOrderedPrice = quote.ltp
                    this.put.status = OrderStatus.ORDERED
                    await Prism.getInstance().buyContract(this.put.contract, quote.ltp)
            }

            // Handle positive direction

            if (this.call && this.call.token && this.call.token == quote.token && 
                (quote.ltp - this.call.price) >= targetPrice && !this.sellCallOrderPlaced) {
                    console.log('Attempting to sell a call contract: ', this.sellCallOrderPlaced)
                    if (!this.sellCallOrderPlaced) {
                        console.log('BiDirectionStrategy: sell call contract ', this.call.contract, ' at ', quote.ltp)
                        await Prism.getInstance().sellContract(this.call.contract, this.call.qty, quote.ltp)
                        await this.openCallTrade();

                        this.sellCallOrderPlaced = true
                        this.isCallActive = false
                    }
            }

            if (this.put && this.put.token && this.put.token == quote.token && 
                (quote.ltp - this.put.price) >= targetPrice && !this.sellPutOrderPlaced) {
                    console.log('Attempting to sell a put contract: ', this.sellPutOrderPlaced)
                    if (!this.sellPutOrderPlaced) {
                        console.log('BiDirectionStrategy: sell put contract ', this.put.contract, ' at ', quote.ltp)
                        await Prism.getInstance().sellContract(this.put.contract, this.put.qty, quote.ltp)
                        await this.openPutTrade();
                        this.sellPutOrderPlaced = true
                        this.isPutActive = false
                    }
            }

        }
    }

    openPutTrade = async () => {
        const putInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.high, PUT);
        console.log('After ordering this.put: ', putInfo)
        if (putInfo) {
            this.put = putInfo
            this.isPutActive = true
            console.log('Put Trade is open now, so cannot place any PUT order')
        }
    }

    openCallTrade = async () => {
        const callInfo : OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.low, CALL);
        console.log('After ordering this.call: ', callInfo)
        if (callInfo) {
            this.call = callInfo
            this.isCallActive = true
            console.log('Call Trade is open now, so cannot place any CALL order')
        }
    }
    
    async processNiftyQuote(quote: NiftyQuote) {
        
        // if (this.stats != null) {
        //     console.log(this.getClassName(), ' eventName: ', this.stats.results.eventName )
        //     console.log(this.getClassName(), ' ordered: ', this.ordered, ' putOpened: ', this.putOpened, ' callOpened: ', this.callOpened )
        // }
        if (this.isTimeInRange() && this.stats != null && 
            this.stats.results.eventName == 'priceUpdate_60' && !this.ordered)  {

                this.ordered = true;
                console.log('BiDirectionStrategy: Buy CALL and PUT as high is ', this.stats.high, ' and low is ', this.stats.low)
                await this.openCallTrade()
                await this.openPutTrade()
            }
        }


    closeStrategy = async () => {
        console.log('BiDirectionStrategy: closeStrategy called')
        if (this.call && this.call.contract) {
            await Prism.getInstance().sell(this.call.contract, this.call.qty, this.call.price)
        }
        
        if (this.put && this.put?.contract) {
            await Prism.getInstance().sell(this.put.contract, this.put.qty, this.put.price)
        }
        

        this.call = {} as OrderInfo
        this.put = {} as OrderInfo
        this.ordered = false;
        this.isCallActive = false;
        this.isPutActive = false;
        this.orderMap.clear();

    }

    findProfit = (token, ltp) => {
        let profit = 0
        if (this.call && this.call.token == token) {
            this.call.profit = (ltp - this.call.price) * this.call.qty
        }

        if (this.put && this.put?.token == token) {
            this.put.profit = (ltp - this.put.price) * this.put.qty
        }

        profit += this.call?.profit ? this.call?.profit: 0;
        profit += this.put?.profit ? this.put?.profit: 0;

        if (token == this.call?.token) {
            process.stdout.write('\nBiDirectionStrategy: ltp: ' + ltp + ' call diff: ' + round(ltp - this.call.lastOrderedPrice));
        }
        if (token == this.put?.token) {
            process.stdout.write('\nBiDirectionStrategy: ltp: ' + ltp + ' put diff: ' + round(ltp - this.put.lastOrderedPrice));
        }
        process.stdout.write(' Profit: ' + round(profit) + ' call: '+ round(this.call.profit) + ' put: ' + round(this.put.profit) + '\n')
        return profit
    }

    isPending = () => this.call?.contract && this.put?.contract;

    updateTrade(trade: Trade) {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.token)
        if (trade.action === this.BUY) {
            if (trade.right == CALL && this.call) {
                this.call.status = OrderStatus.BOUGHT;
                this.call.lastOrderedPrice = trade.ltp
                const totalAmount = (this.call?.qty * this.call?.price) + (trade.quantity * trade.ltp)
                this.call.qty = this.call?.qty + trade.quantity
                this.call.price = totalAmount / this.call?.qty
            }
            if (trade.right == PUT && this.put) {
                this.put.status = OrderStatus.BOUGHT;
                this.put.lastOrderedPrice = trade.ltp
                const totalAmount = (this.put?.qty * this.put?.price) + (trade.quantity * trade.ltp)
                this.put.qty = this.put?.qty + trade.quantity
                this.put.price = totalAmount / this.put?.qty
            }

            console.log('After Buy Trade, call: ', this.call, ' put: ', this.put)
            
        }

        if (trade.action === this.SELL) {
            if (trade.right == PUT) {
                this.put = {} as OrderInfo
                this.sellPutOrderPlaced = false;
            }
            if (trade.right == CALL) {
                this.call = {} as OrderInfo
                this.sellCallOrderPlaced = false;
            }
            console.log('After Sell Trade, call: ', this.call, ' put: ', this.put)

        }
    }
}