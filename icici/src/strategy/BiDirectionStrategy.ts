import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';

import moment from "moment";

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"

}

const stopLossThreshold = 20
const buyAgainDiff = 2 // After sell
const targetPrice = 5

const round = (num) => Math.round(num * 100) / 100;


//Strategy: If support is breached, buy put?. If resistance is breached, buy CALL

class Contract {
    contract: string;
    price: number;
    qty: number;
    token: string;
    lastOrderedPrice: number;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    buyOrderPlaced = false
    sellOrderPlaced = false
    status: OrderStatus = OrderStatus.PENDING;
    escalateQuantity = 750
    isEscalated = false
    realized: number = 0;
    iterationCount: number = 1;

    constructor(contract, price, qty, token) {
        this.contract = contract;
        this.price = price;
        this.qty = qty;
        this.token = token;
        this.lastOrderedPrice = price;
    }

    toString = () => {
        return `Contract: ${this.contract}, Price: ${this.price}, Qty: ${this.qty}, Token: ${this.token}, Last Ordered Price: ${this.lastOrderedPrice}, Profit: ${this.profit}`;
    }

    clear = () => {
        this.qty = 0;
        this.lastOrderedPrice = 0;
        this.price = 0;
        this.profit = 0;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }

    escalate = async () => {
        if (this.ltp && !this.isEscalated) {
            console.log('BiDirectionStrategy: escalate put contract ')
            this.isEscalated = true
            await Prism.getInstance().buyContract(this.contract, this.ltp - 2, this.escalateQuantity)
        }
    }

    processOptionQuote = async (quote: OptionQuote) => {

        this.ltp = quote.ltp;
        //Handle negative direction
        if (this.token && this.token == quote.token
            && !this.buyOrderPlaced
            && (quote.ltp - this.lastOrderedPrice) < -stopLossThreshold) {
            
            this.lastOrderedPrice = quote.ltp
            this.buyOrderPlaced = true
            // if (this.qty > 1200) {
            //     console.log('Sell for loss for the contract ', this.contract )
            //     await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
            // } else {
                console.log('BiDirectionStrategy: buy call contract ', this.contract, ' at ', quote.ltp)
                this.iterationCount++
                const qty = this.iterationCount * 75;

                if (this.iterationCount < 10) {
                    await Prism.getInstance().buyContract(this.contract, quote.ltp, qty)
                } else {
                    console.log('BiDirectionStrategy: Iteration count exceeded for contract ', this.contract)
                }

                
            // }
            
        }

        //Handle positive direction

        if (this.token && this.token == quote.token &&
            (quote.ltp - this.price) >= targetPrice && !this.sellOrderPlaced) {
            console.log('Attempting to sell a contract: ', this.contract)
            if (!this.sellOrderPlaced) {
                this.sellOrderPlaced = true
                this.isEscalated = false
                console.log('BiDirectionStrategy: sell call contract ', this.contract, ' at ', quote.ltp)
                await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
            }
        }
    }

    updateTrade = async (trade: Trade) => {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                this.status = OrderStatus.BOUGHT;
                this.buyOrderPlaced = false;
                this.lastOrderedPrice = round(trade.price)
                const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                this.qty = this.qty + trade.quantity
                this.price = round(totalAmount / this.qty)

                console.log('Bidirection Strategy: After Buy Trade, contract: ', this)
                const buyAt = round(this.lastOrderedPrice - stopLossThreshold)
                const sellAt = round(this.price + targetPrice)

                console.log('Bidirection Strategy: buy ', this.contract, ' at ', buyAt, ' sell at : ', sellAt)

            }

            if (trade.action == this.SELL) {
                this.sellOrderPlaced = false;
                const bought = this.price * this.qty;
                this.clear();
                const sold = trade.price * trade.quantity
                this.realized = sold - bought
                const price = round(trade.price - buyAgainDiff)
                console.log('Realized Profit: ', this.realized)
                console.log('After sell, Place a buy order for put contract: ', this.contract, ' at price: ', price)
                await Prism.getInstance().buyContract(this.contract, price, 75)

                console.log('After Sell Trade, contract: ', this)
            }
        }

    }
}

export default class BiDirectionStrategy extends Strategy {
    call: Contract = {} as Contract
    put: Contract = {} as Contract
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    expectedProfit = 2000
    maxLoss = 10000
    escalateQuantity = 750
    escalateTrigger = 450
    callEscalated = false
    putEscalated = false
    isCallActive = false
    isPutActive = false
    sellCallOrderPlaced = false
    sellPutOrderPlaced = false
    buyCallOrderPlaced = false
    buyPutOrderPlaced = false


    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'BiDirectionStrategy';
        console.log('BiDirectionStrategy: constructor called')
    }

    receive = (oldStats, newStats) => {
        this.stats = newStats;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        const token = quote.token
        return this.call.canHandleOptionQuote(token) || this.put.canHandleOptionQuote(token)
    }

    processOptionQuote = async (quote: OptionQuote) => {
        if (this.ordered == true) {
            const unrealized = this.findProfit(quote.token, quote.ltp)

            if (this.call && this.put) {
                const realized = this.call.realized + this.put.realized 
                const profit = this.call.realized + this.put.realized + unrealized;
                console.log('Realized: ', round(realized), ' Unrealized: ', round(unrealized), ' Total: ' + round(profit))
                
                const msg = { 
                    'realized': round(realized),
                    'unrealized': round(unrealized),
                    'total': round(profit),
                    'call': {
                        'token': this.call.contract,
                        'price': this.call.price,
                        'qty': this.call.qty,
                        'ltp': quote.ltp
                    },
                    'put': {
                        'token': this.put.contract,
                        'price': this.put.price,
                        'qty': this.put.qty,
                        'ltp': quote.ltp
                    }

                }
                myEmitter.emit('status', msg);

            }
            

            // if (profit > this.expectedProfit) {
            //     await this.closeStrategy()
            // }

            // if (profit < -this.maxLoss) {
            //     await this.closeStrategy()
            // }

            if (this.call.processOptionQuote) {
                await this.call.processOptionQuote(quote);
            }

            if (this.put.processOptionQuote) {
                await this.put.processOptionQuote(quote)
            }
        }
    }

    openPutTrade = async () => {
        const putInfo: OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.high, PUT);
        console.log('After ordering this.put: ', putInfo)
        if (putInfo) {
            putInfo.qty = 0; // Reset quantity to 0 as this will be updated in updateTrade
            this.put = new Contract(putInfo.contract, putInfo.price, putInfo.qty, putInfo.token);
            this.isPutActive = true
        }
    }

    openCallTrade = async () => {
        const callInfo: OrderInfo = await Prism.getInstance().buyIndex(NIFTY, this.stats.low, CALL);
        console.log('After ordering this.call: ', callInfo)
        if (callInfo) {
            callInfo.qty = 0; // Reset quantity to 0 as this will be updated in updateTrade
            this.call = new Contract(callInfo.contract, callInfo.price, callInfo.qty, callInfo.token);
            this.isCallActive = true
        }
    }

    async processNiftyQuote(quote: NiftyQuote) {

        // if (this.stats != null) {
        //     console.log(this.getClassName(), ' eventName: ', this.stats.results.eventName )
        //     console.log(this.getClassName(), ' ordered: ', this.ordered, ' putOpened: ', this.putOpened, ' callOpened: ', this.callOpened )
        // }
        if (this.isTimeInRange() && this.stats != null &&
            this.stats.results.eventName == 'priceUpdate_60' && !this.ordered) {

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


        this.call.clear()
        this.put.clear()
        this.callEscalated = false
        this.putEscalated = false;
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

        profit += this.call?.profit ? this.call.profit : 0;
        profit += this.put?.profit ? this.put.profit : 0;

        // if (token == this.call?.token) {
        //     process.stdout.write('\nBiDirectionStrategy: ltp: ' + ltp + ' call diff: ' + round(ltp - this.call.lastOrderedPrice));
        // }
        // if (token == this.put?.token) {
        //     process.stdout.write('\nBiDirectionStrategy: ltp: ' + ltp + ' put diff: ' + round(ltp - this.put.lastOrderedPrice));
        // }
        // process.stdout.write(' Profit: ' + round(profit) + ' call: '+ round(this.call.profit) + ' put: ' + round(this.put.profit) + '\n')
        return profit
    }

    isPending = () => this.call?.contract && this.put?.contract;

    updateTrade = async (trade: Trade) => {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.call.updateTrade) {
            await this.call.updateTrade(trade)
        }
        
        if (this.put.updateTrade) {
            await this.put.updateTrade(trade)
        }

        // if (this.call.qty == this.escalateTrigger) {
        //     await this.put.escalate()
        // }

        // if (this.put.qty == this.escalateTrigger) {
        //     await this.call.escalate()
        // }

    }
}