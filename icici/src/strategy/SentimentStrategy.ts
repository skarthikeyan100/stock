import Log from '../util/Log';
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';
import { TouchSequence } from "selenium-webdriver";
import moment from "moment";
import configService from '../prism/ConfigService'


export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"

}


// Consider volatility or standard deviation too
// let averageThreshold = 5
// let targetPrice = 2
// const orderQuantity = 300;
// const sentiment = 'any'

const updatePrice = (price) => {
    const round = (num) => Math.round(num * 10) / 10;
    const percent = (price, num) => (price * num/100) 
    const updated = round(percent(price, 10))
    Log.log('Updated Threshold or Target to ', updated);
    return updated
}


const round = (num) => Math.round(num * 100) / 100;



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
    buyAt: number = 0;
    sellAt: number = 0;
    lastOrderedPrice: number = 0;
    lastOrderedQuantity: number = 0;
    strategy: Strategy = {} as Strategy;

    constructor(strategy, contract) {
        this.contract = contract;
        this.strategy = strategy;
    }

    update = (token) => {
        this.token = token;
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
        this.lastOrderedQuantity = 0;
        this.profit = 0;
        this.buyAt = 0;
        this.sellAt = 0;
        this.orderPlaced =false;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) => {
        const averageThreshold = configService.getStrategyConfig('SentimentStrategy').averageThreshold;
        const orderQuantity = configService.getStrategyConfig('SentimentStrategy').orderQuantity;
        const targetPrice = configService.getStrategyConfig('SentimentStrategy').targetPrice;

        // Log.log('this.token: ', this.token, ' quote.token: ', quote.token, ' contract: ', )
        if (this.token == quote.token) {
            this.ltp = quote.ltp;
            // Log.log('Calculate profit ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
            this.profit = round((quote.ltp - this.price) * this.qty)
            // Log.log(this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', this.profit,  ' threshold: ', round(this.lastOrderedPrice - averageThreshold), ' targetPrice: ', round(this.price + targetPrice))
    
            //Handle negative direction
            
                if (this.token && this.token == quote.token
                    && !this.orderPlaced
                    && this.lastOrderedPrice > 0
                    && (quote.ltp - this.lastOrderedPrice) < -averageThreshold) {
                        this.orderPlaced = true
                        this.strategy.buyContract(this.contract, 600, quote.ltp)
                }
            
            //Handle positive direction
            const canSell = (quote.ltp - this.price) >= targetPrice
    
            if (this.token && this.token == quote.token &&
                canSell == true && !this.orderPlaced) {
                this.orderPlaced = true
                Log.log('SentimentStrategy: sell contract ', this.contract, ' at ', quote.ltp)
                await this.strategy.sellContract(this.contract, this.qty, quote.ltp)
            }
    
        }
    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        const averageThreshold = configService.getStrategyConfig('SentimentStrategy').averageThreshold;
        const targetPrice = configService.getStrategyConfig('SentimentStrategy').targetPrice;

        let tradeClosed = false
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                this.orderPlaced = false;
                this.lastOrderedPrice = trade.price
                this.lastOrderedQuantity = trade.quantity
                if (this.qty == 0) {
                    this.qty = trade.quantity
                    this.price = trade.price
                } else {
                    const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                    this.qty = this.qty + trade.quantity
                    this.price = round(totalAmount / this.qty)
                }
                // averageThreshold = updatePrice(this.price)
                // targetPrice = updatePrice(this.price)
                Log.log(this.contract, ' price: ', this.price, ' qty: ', this.qty,  ' buyAt: ', round(this.lastOrderedPrice - averageThreshold), ' sellAt: ', round(this.price + targetPrice))
            }

            if (trade.action == this.SELL) {
                this.clear();
                tradeClosed = true;
                Log.log('After Sell Trade, contract: ', this)
            }
        }
        return tradeClosed;
    }
}

export default class SentimentStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false
    iterationCount = 0;


    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'SentimentStrategy';
        this.enabled = true
    }

       
    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(9).minute(30);
        const endTime = moment().hour(15).minute(30);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
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
                await this.contract.processOptionQuote(quote);
            }

        }
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const orderQuantity = configService.getStrategyConfig('SentimentStrategy').orderQuantity;
        const sentiment = configService.getStrategyConfig('SentimentStrategy').sentiment;
        const enabled = configService.getStrategyConfig('SentimentStrategy').enabled;
        const loopCount = configService.getStrategyConfig('SentimentStrategy').loopCount;
        if (enabled) {
            if (this.iterationCount <= loopCount && this.isTimeInRange() && !this.ordered && this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) {
                this.ordered = true;
                Log.log('Initiate buy index for NIFTY at ', quote.ltp, ' with initial quantity: ', orderQuantity, ' iterationCount: ', this.iterationCount);
                const response = await Prism.getInstance().buyIndex({ userContext: this.getUserContext(), index: NIFTY, ltp: quote.ltp-2, right: sentiment, qty: orderQuantity });
                this.iterationCount++;
                this.recordTriggerTime();
                if (response) {
                    Log.log('Response: ', response)
                    this.contract = new Contract(this, response.contract);
                    this.contract.update(response.token);
                }
            }
        }
    }


    updateTrade = async (trade: Trade) => {
        // Log.log('Sentiment Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.contract?.updateTrade) {
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                this.ordered = false;
                // await Prism.getInstance().buyIndex({ user: this.userId, index: NIFTY, ltp: trade.ltp, right: "any", qty: initialQuantity });
            }
        }
    }
}