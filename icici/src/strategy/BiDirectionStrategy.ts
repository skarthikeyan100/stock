import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';
import { TouchSequence } from "selenium-webdriver";


export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"

}


// Consider volatility or standard deviation too
const averageThreshold = 10
const buyAgainDiff = 0 // After sell
const targetPrice = 5
const fixedProfit = 1000; // will be used only when average price is < 50
const expectedProfit = 1000;
const initialQuantity = 75;
const incrementQuantity = 75;
const doubleAverage = false;
const eventName = 'priceUpdate_60'

const round = (num) => Math.round(num * 100) / 100;


//Strategy: If support is breached, buy put?. If resistance is breached, buy CALL

class ContraOrder {
    right: string
    quantity: number

    constructor(right: string, quantity: number) {
        this.right = right;
        this.quantity = quantity;
    }
}

class Contract {
    contract: string;
    price: number = 0;
    qty: number = 0;
    token: string;
    lastOrderedPrice: number;
    lastOrderedQuantity: number = 0;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    buyOrderPlaced = false
    sellOrderPlaced = false
    status: OrderStatus = OrderStatus.PENDING;
    iterationCount: number = 1;
    buyAt: number = 0;
    sellAt: number = 0;

    constructor(strategy, contract) {
        this.contract = contract;
    }

    update = (token) => {
        this.token = token;
    }

    toString = () => {
        return `Contract: ${this.contract}, Price: ${this.price}, Qty: ${this.qty}, Token: ${this.token}, Last Ordered Price: ${this.lastOrderedPrice}, Profit: ${this.profit}`;
    }

    clear = () => {
        this.qty = 0;
        this.lastOrderedPrice = 0;
        this.price = 0;
        this.profit = 0;
        this.buyAt = 0;
        this.sellAt = 0;
        this.iterationCount = 1;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) : Promise<ContraOrder | null>=> {
        let contraOrder = null;
        this.ltp = quote.ltp;
        // console.log('Calculate profit ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
        this.profit = round((quote.ltp - this.price) * this.qty)
        console.log('Set profit for ', this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
        const diff = quote.ltp - this.lastOrderedPrice
        const percent = round(diff/ this.lastOrderedPrice * 100)

        //Handle negative direction
        if (this.token && this.token == quote.token
            && !this.buyOrderPlaced
            && (quote.ltp - this.lastOrderedPrice) < -averageThreshold) {
            
            console.log('Percent change: ', percent);
            this.lastOrderedPrice = quote.ltp
            this.buyOrderPlaced = true
            // if (this.qty > 1200) {
            //     console.log('Sell for loss for the contract ', this.contract )
            //     await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
            // } else {
                console.log('BiDirectionStrategy: buy contract ', this.contract, ' at ', quote.ltp)
                this.iterationCount++
                let qty = 0;
                if (doubleAverage) {
                    qty = this.qty * 2
                } else {
                    qty =  this.iterationCount * incrementQuantity;
                }
                const right = this.contract.indexOf('C') > -1 ? PUT : CALL
                contraOrder = new ContraOrder(right, qty);

                if (this.iterationCount < 10) {
                    // super.buyContract(this.strategy, this.contract, qty, quote.ltp)
                    console.log('***************  REVISIT as you have buy orders in both directions ***************')
                } else {
                    console.log('BiDirectionStrategy: Iteration count exceeded for contract ', this.contract)
                }

            // }
            return contraOrder
        }

        //Handle positive direction
        let canSell = false
        if (this.price > 50) {
            canSell = (quote.ltp - this.price) >= targetPrice
        } else {
            canSell = this.profit >= fixedProfit
        }
        // const canSell = this.profit >= fixedProfit
        console.log('canSell: ', canSell)
        console.log('contract: ', this.contract, ' ltp: ', quote.ltp, ' profit: ', this.profit, ' canSell: ', canSell)


        if (this.token && this.token == quote.token &&
            canSell == true && !this.sellOrderPlaced) {
            console.log('Attempting to sell a contract: ', this.contract)
            if (!this.sellOrderPlaced) {
                this.sellOrderPlaced = true
                this.iterationCount = 1;
                console.log('BiDirectionStrategy: sell call contract ', this.contract, ' at ', quote.ltp)
                await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
            }
        }

    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        let tradeClosed = false
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)
        console.log('condition: ', (trade.tsym == this.contract), ' trade.sym: ', trade.tsym, ' this.contract: ', this.contract)
        if (trade.tsym == this.contract) {
            console.log('Symbol matches')
            if (trade.action == this.BUY) {
                console.log('Buy action matches')
                this.status = OrderStatus.BOUGHT;
                this.buyOrderPlaced = false;
                this.lastOrderedPrice = round(trade.price)
                this.lastOrderedQuantity = trade.quantity
                console.log('Calculate totalAmount: ', this.qty, ' ', this.price, ' ', trade.quantity, ' ', trade.price)
                const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                console.log('Total Amount: ', totalAmount)
                this.qty = this.qty + trade.quantity
                console.log('Quantity after buy: ', this.qty)
                this.price = round(totalAmount / this.qty)
                this.buyAt = round(this.lastOrderedPrice - averageThreshold);
                this.sellAt = round((expectedProfit / this.qty) + this.price);

                console.log('Bidirection Strategy: After Buy Trade, contract: ', this)
                console.log('Bidirection Strategy: buy ', this.contract, ' buy at ', this.buyAt, ' sell at : ', this.sellAt)
            }

            if (trade.action == this.SELL) {
                this.sellOrderPlaced = false;
                
                this.clear();
                
                const price = round(trade.price - buyAgainDiff)
                // Fix: Trade will never be closed, hence needs to monitor
                await Prism.getInstance().buyContract(this.contract, initialQuantity, price )
                

                console.log('After Sell Trade, contract: ', this)
                
            }
        }
        return tradeClosed;
    }
}

export default class BiDirectionStrategy extends Strategy {
    call: Contract = {} as Contract
    put: Contract = {} as Contract
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    maxLoss = 10000
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
        this.enabled = true
    }

    receive(oldStats, newStats) {
        if (oldStats != null) {
            this.previousWindowTrend = oldStats.close > oldStats.open ? 'UP' : 'DOWN';
            this.stats = newStats;
            console.log('Received stats : ', ' Resistance: ', this.stats.results.pivot.R1, ' Support: ', this.stats.results.pivot.S1)
        }
    }    

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        let handled = false;
        const token = quote.token
        if (this.call.canHandleOptionQuote) {
            handled = this.call.canHandleOptionQuote(token)
        }
        if (!handled && this.put.canHandleOptionQuote) {
            handled = this.put.canHandleOptionQuote(token)
        } else {
            console.log('Shouldnot come here for the token ', token)
            handled = false;
        }
        return handled;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        
        if (this.ordered == true) {
            // const profit = this.findProfit(quote.token, quote.ltp)

            const msg = {} as any
            if (this.call && this.call.contract) {
                msg.call = {
                    price: this.call.price,
                    qty: this.call.qty,
                    buyAt: this.call.buyAt,
                    sellAt: this.call.sellAt,
                    ltp: this.call.ltp,
                    profit: round(this.call.profit),
                }
            }

            if (this.put && this.put.contract) {
                msg.put = {
                    price: this.put.price,
                    qty: this.put.qty, 
                    buyAt: this.put.buyAt,
                    sellAt: this.put.sellAt,
                    ltp: this.put.ltp,
                    profit: round(this.put.profit),
                }
            }

            myEmitter.emit('status', msg);

            // if (profit > this.expectedProfit) {
            //     await this.closeStrategy()
            // }

            // if (profit < -this.maxLoss) {
            //     await this.closeStrategy()
            // }

            if (this.call && this.isCallActive) {
                const contraOrder = await this.call.processOptionQuote(quote);
                if (contraOrder && contraOrder.right == PUT) {
                    console.log('BiDirectionStrategy: Buying PUT as CALL price has reduced')
                    await this.openPutTrade(contraOrder.quantity)
                }
            }

            if (this.put && this.isPutActive) {
                const contraOrder = await this.put.processOptionQuote(quote)
                if (contraOrder && contraOrder.right == CALL) {
                    console.log('BiDirectionStrategy: Buying CALL as PUT price has reduced')
                    await this.openCallTrade(contraOrder.quantity)
                }
            }
        }
    }

    openPutTrade = async (additionalQuantity?: number) => {
        if (additionalQuantity) {
            console.log('This is a contra order for PUT with additional quantity: ', additionalQuantity)
        }
        if (!this.isPutActive) {
            const contract = await Prism.getInstance().getContractByPriceRange(PUT)
            this.put = new Contract(this, contract)
            const putInfo: OrderInfo = await super.buyContract(contract, initialQuantity)
            console.log('After ordering this.put: ', putInfo)
            if (putInfo) {
                this.put.update(putInfo.token);
                this.isPutActive = true
            }
        } else {
            await Prism.getInstance().buyContract(this.put.contract, additionalQuantity)
            
        }
    }

    openCallTrade = async (additionalQuantity?: number) => {
        if (additionalQuantity) {
            console.log('This is a contra order for CALL with additional quantity: ', additionalQuantity)
        }
        if (!this.isCallActive) {
            const contract = await Prism.getInstance().getContractByPriceRange(CALL)
            this.call = new Contract(this, contract)
            const callInfo: OrderInfo = await super.buyContract(contract, initialQuantity)
            console.log('After ordering this.call: ', callInfo)
            if (callInfo) {
                this.call.update(callInfo.token);
                this.isCallActive = true
            }
        } else {
            await super.buyContract(this.call.contract, additionalQuantity)
            
        }
    }

    async processNiftyQuote(quote: NiftyQuote) {

        console.log('BiDirectionStrategy: processNiftyQuote called with quote: ', quote.ltp)

        if (this.stats != null) {
            console.log('BiDirectionStrategy: isTimeInRange: ', this.isTimeInRange(), ' ordered: ', this.ordered, ' stats: ', this.stats.results.eventName, ' previousWindowTrend: ', this.previousWindowTrend)
        }
        
        if (this.isTimeInRange() && this.stats != null &&
            this.stats.results.eventName == eventName && !this.ordered) {

                // console.log('BiDirectionStrategy: processNiftyQuote called with quote: ', quote)

                if (quote.token === 'NIFTY' && this.stats.results.pivot.S1 != -1 && this.stats.results.pivot.R1 != -1) {
                    // console.log('BiDirectionStrategy: Inside if loop"')
                    if ( quote.ltp < this.stats.results.pivot.S1  && this.previousWindowTrend === 'DOWN') {
                        this.ordered = true;
                        console.log('BiDirectionStrategy: Buy PUT as support is breached')
                        await this.openPutTrade()
                        
                    } else if ( quote.ltp > this.stats.results.pivot.R1  && this.previousWindowTrend === 'UP' ) {
                        this.ordered = true;
                        console.log('BiDirectionStrategy: Buy CALL as resistance is breached')
                        await this.openCallTrade()
                    } else {
                        console.log('BiDirectionStrategy: Waiting S1: ', this.stats.results.pivot.S1, ' ltp: ', quote.ltp, ' R1: ',  this.stats.results.pivot.R1)
                    }
                }
        }
    }


    closeStrategy = async () => {
        console.log('BiDirectionStrategy: closeStrategy called')
        if (this.call && this.call.contract) {
            await Prism.getInstance().sell(this.call.contract, this.call.qty, this.call.price)
        }

        if (this.put && this.put.contract) {
            await Prism.getInstance().sell(this.put.contract, this.put.qty, this.put.price)
        }


        this.call.clear()
        this.put.clear()
        this.ordered = false;
        this.isCallActive = false;
        this.isPutActive = false;
        this.orderMap.clear();

    }

    findProfit = (token, ltp) => {
        let profit = 0
        if (this.call && this.call.token == token && this.isCallActive) {
            this.call.profit = (ltp - this.call.price) * this.call.qty
        }

        if (this.put && this.put?.token == token && this.isPutActive) {
            this.put.profit = (ltp - this.put.price) * this.put.qty
        }

        profit = this.call.profit + this.put.profit
        console.log('findProfit: call: ', this.call.profit, ' put: ', this.put.profit, ' profit: ', profit)
        return profit
    }

    isPending = () => this.call?.contract && this.put?.contract;

    updateTrade = async (trade: Trade) => {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.call.updateTrade) {
            const tradeClosed = await this.call.updateTrade(trade)
            if (tradeClosed) {
                this.isCallActive = false;
                await this.openCallTrade();
            }
        }
        
        if (this.put.updateTrade) {
            const tradeClosed = await this.put.updateTrade(trade)
            if (tradeClosed) {
                this.isPutActive = false;
                await this.openPutTrade();
            }

        }

    }
}