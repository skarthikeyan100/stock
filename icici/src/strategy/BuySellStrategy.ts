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
const averageThreshold = 5
const targetPrice = 2
const initialQuantity = 300;
const incrementQuantity = 75;
const stopEnabled = false;

const round = (num) => Math.round(num * 100) / 100;


//Strategy: If support is breached, buy put?. If resistance is breached, buy CALL

class ContraOrder {
    right: string
    quantity: number
    quote: number

    constructor(right: string, quantity: number, quote: number) {
        this.right = right;
        this.quantity = quantity;
        this.quote = quote
    }
}

class Contract {
    contract: string;
    price: number = 0;
    qty: number = 0;
    token: string;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    orderPlaced = false
    status: OrderStatus = OrderStatus.PENDING;
    iterationCount: number = 1;
    buyAt: number = 0;
    sellAt: number = 0;
    lastOrderedPrice: number = 0;

    constructor(contract) {
        this.contract = contract;
        console.log('Contract created: ', this.contract)
    }

    update = (token) => {
        this.token = token;
        console.log('Contract token updated: ', this.token)
    }

    toString = () => {
        return `Contract: ${this.contract}, Price: ${this.price}, Qty: ${this.qty}, Token: ${this.token}, Profit: ${this.profit}`;
    }

    clear = () => {
        this.contract = '';
        this.token = '';
        this.qty = 0;
        this.price = 0;
        this.lastOrderedPrice = 0;
        this.profit = 0;
        this.buyAt = 0;
        this.sellAt = 0;
        this.orderPlaced =false;
        this.iterationCount = 1;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) : Promise<ContraOrder | null>=> {
        let nextOrder;
        if (this.token == quote.token) {
            this.ltp = quote.ltp;
            // console.log('Calculate profit ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
            this.profit = round((quote.ltp - this.price) * this.qty)
            console.log(this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', this.profit)
    
            //Handle negative direction
            
                if (this.token && this.token == quote.token
                    && !this.orderPlaced
                    && this.lastOrderedPrice > 0
                    && (quote.ltp - this.lastOrderedPrice) < -averageThreshold) {
                        this.orderPlaced = true
                        if (stopEnabled) {
                            await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
                            const right = this.contract.indexOf('CE') > -1 ? PUT : CALL
                            nextOrder = new ContraOrder(right, initialQuantity, quote.ltp);
                        } else {
                            this.iterationCount++
                            await Prism.getInstance().buyContract(this.contract, this.iterationCount * incrementQuantity, quote.ltp)
                        }
                }
            
            //Handle positive direction
            const canSell = (quote.ltp - this.price) >= targetPrice
    
            if (this.token && this.token == quote.token &&
                canSell == true && !this.orderPlaced) {
                this.orderPlaced = true
                console.log('BuySellStrategy: sell contract ', this.contract, ' at ', quote.ltp)
                await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)

                //Following code is commented as any sell is considered as tradeclosed and a new order will be created
                // const right = this.contract.indexOf('CE') > -1 ? CALL : PUT
                // nextOrder = new ContraOrder(right, initialQuantity, quote.ltp);
            }
    
        }
        return nextOrder

    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        let tradeClosed = false
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                this.orderPlaced = false;
                this.lastOrderedPrice = trade.price
                if (this.qty == 0) {
                    this.qty = trade.quantity
                    this.price = trade.price
                } else {
                    const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                    this.qty = this.qty + trade.quantity
                    this.price = round(totalAmount / this.qty)
                }
            }

            if (trade.action == this.SELL) {
                this.clear();
                tradeClosed = true;
                console.log('After Sell Trade, contract: ', this)
            }
        }
        return tradeClosed;
    }
}

export default class BuySellStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false


    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'BuySellStrategy';
        this.enabled = true
    }

    receive(oldStats, newStats) {
    }    

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        let handled = false;
        const token = quote.token
        if (this.contract?.canHandleOptionQuote) {
            handled = this.contract.canHandleOptionQuote(token)
        }
        return handled;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        
        if (this.ordered == true) {
            if (this.contract && this.contract?.token == quote.token) {
                const nextOrder = await this.contract.processOptionQuote(quote);
                
                if (nextOrder) {
                    console.log('Buy next order ', nextOrder)
                    await this.openTrade(nextOrder)
                }
            }

        }
    }

    openTrade = async (contraOrder : ContraOrder) => {
        if (contraOrder) {
            const response = await Prism.getInstance().buyIndex(NIFTY, null, contraOrder.right, contraOrder.quantity);
            if (response) {
                this.contract = new Contract(response.contract);
                this.contract.update(response.token);
            }
        }
    }

    async processNiftyQuote(quote: NiftyQuote) {

        if (this.isTimeInRange() && !this.ordered) {
            this.ordered = true;
            console.log('Initiate buy index for NIFTY at ', quote.ltp, ' with initial quantity: ', initialQuantity)
            const response = await Prism.getInstance().buyIndex(NIFTY, quote.ltp, "any", initialQuantity);
            if (response) {
                this.contract = new Contract(response.contract);
                this.contract.update(response.token);
            }
        }
    }


    closeStrategy = async () => {
        console.log('BuySellStrategy: closeStrategy called')
        if (this.contract && this.contract.contract) {
            await Prism.getInstance().sell(this.contract.contract, this.contract.qty, this.contract.price)
        }


        this.contract.clear()
        this.ordered = false;
    }

    findProfit = (token, ltp) => {
        if (this.contract && this.contract.token == token) {
            this.contract.profit = (ltp - this.contract.price) * this.contract.qty
        }

        return this.contract.profit
    }


    updateTrade = async (trade: Trade) => {
        console.log('Bidirection Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.contract?.updateTrade) {
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                this.ordered = false;
                // await Prism.getInstance().buyIndex(NIFTY, trade.ltp, "any", initialQuantity);
            }
        }
    }
}