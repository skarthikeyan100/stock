import Log from '../util/Log';
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import IntermittentStrategy from "./IntermittentStrategy";
import * as f from '../orderList'
import OrderClient from '../processes/strategies/OrderClient'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';
import { TouchSequence } from "selenium-webdriver";
import configService from '../prism/ConfigService'
import  strategies from './strategies';


let buyOrderPlaced = false
let sellOrderPlaced = false


// Consider volatility or standard deviation too
// let averageThreshold = 5
// let targetPrice = 5
// const initialQuantity = 65;
const stopEnabled = false;

const updatePrice = (price) => {
    const round = (num) => Math.round(num * 10) / 10;
    const percent = (price, num) => (price * num/100) 
    const updated = round(percent(price, 10))
    Log.log('Updated Threshold or Target to ', updated);
    return updated
}

const round = (num) => Math.round(num * 100) / 100;

class ContraOrder {
    action: 'buy' | 'sell'
    contract: string
    quantity: number
    price: number

    constructor(action: 'buy' | 'sell', contract: string, quantity: number, price: number) {
        this.action = action;
        this.contract = contract;
        this.quantity = quantity;
        this.price = price
    }
}


//Strategy: If support is breached, buy put?. If resistance is breached, buy CALL


class Contract {
    contract: string;
    price: number = 0;
    qty: number = 0;
    token: string;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    status: OrderStatus = OrderStatus.PENDING;
    iterationCount: number = 0;
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
        this.iterationCount = 0;
        buyOrderPlaced = false;
        sellOrderPlaced = false;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) : Promise<ContraOrder | null>=> {
        if (this.price == 0) {
            return // Order is not processed yet, but the option is subscribed
        }
        const averageThreshold = configService.getStrategyConfig('BuySellStrategy').averageThreshold;
        const targetPrice = configService.getStrategyConfig('BuySellStrategy').targetPrice;
        const initialQuantity = configService.getStrategyConfig('BuySellStrategy').initialQuantity;
        const activateIntermittentCount = configService.getStrategyConfig('BuySellStrategy').activateIntermittentCount;
        const maxIterationCount = configService.getStrategyConfig('BuySellStrategy').maxIterationCount;
        const logEnabled = configService.getStrategyConfig('BuySellStrategy').logEnabled
        
        let nextOrder;
        if (this.token == quote.token) {
            this.ltp = quote.ltp;
            // Log.log('Calculate profit ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
            this.profit = round((quote.ltp - this.price) * this.qty)
            const buyAt = round(this.lastOrderedPrice - averageThreshold)
            const sellAt = round(this.lastOrderedPrice + targetPrice)
            if (logEnabled) {
                Log.log('BuySellStrategy: ', this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', this.profit, ' buyAt: ', buyAt, ' sellAt: ', sellAt)
                Log.log('BuySellStrategy: lastOrderedPrice: ', this.lastOrderedPrice, ' buyOrderPlaced: ', buyOrderPlaced, ' sellOrderPlaced: ', sellOrderPlaced)
    
            }
            
    
            //Handle negative direction
            
                if (this.token && this.token == quote.token
                    && this.lastOrderedPrice > 0
                    && (quote.ltp - this.lastOrderedPrice) < -averageThreshold) {
                        if (!sellOrderPlaced && stopEnabled) {
                            sellOrderPlaced = true;
                            nextOrder = new ContraOrder('sell', this.contract, this.qty, quote.ltp)
                        } else {
                            if (!buyOrderPlaced) {
                                this.iterationCount++
                                Log.log('this.iterationCount: ', this.iterationCount, ' maxIterationCount: ', maxIterationCount)
                                if (this.iterationCount <= maxIterationCount) {
                                    const incrementFactor = configService.getStrategyConfig('BuySellStrategy').incrementFactor;
                                    const incrementQuantity = configService.getStrategyConfig('BuySellStrategy').incrementQuantity;
                                    let quantity = incrementQuantity
                                    if ("double" == incrementFactor) {
                                        quantity = this.lastOrderedQuantity * 2;
                                    } else if ("iteration" == incrementFactor) {
                                        let quantity = this.iterationCount * incrementQuantity
                                    }
                                    
                                    buyOrderPlaced = true;
                                    Log.log('BuySellStrategy: buy contract ', this.contract, ' at ', quote.ltp, ' quantity: ', quantity)
                                    await this.strategy.buyContract(this.contract, quantity, quote.ltp)
    
        
                                    if (this.iterationCount >= activateIntermittentCount ) {
                                        const right = this.contract.indexOf('C') !== -1 ? PUT : CALL
                                        Log.log('BuySellStrategy: Start Intermittent Strategy buy ', ' for the iteration count ', this.iterationCount, ' contract: ', this.contract, ' index: ', this.contract.indexOf('C'))
                                        const intermittentStrategy = new IntermittentStrategy();
                                        await intermittentStrategy.buyIndex(quote.ltp, right)
                                        strategies.addToList(intermittentStrategy)
                                        Log.log('Strategies length: ', strategies.getList().length)
                                    }
                                }
                            }
                        }
                }
            
        }
        return nextOrder

    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        Log.log('BuySellStrategy: Update Trade called: ', trade.action, ' ', trade.quantity, ' ', this.contract)
        let tradeClosed = false
        if (trade.tsym == this.contract) {
            Log.log('BuySellStrategy: buyOrderPlaced: ', buyOrderPlaced, ' trade action: ', trade.action)
            if (buyOrderPlaced && trade.action == this.BUY) {
                buyOrderPlaced = false;
                this.lastOrderedPrice = trade.price
                this.lastOrderedQuantity = trade.quantity
                if (this.qty == 0) {
                    Log.log('BuySellStrategy: Set qty and price for the first time, qty: ', trade.quantity, ' price: ', trade.price)
                    this.qty = trade.quantity
                    this.price = trade.price
                } else {
                    const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                    this.qty = this.qty + trade.quantity
                    this.price = round(totalAmount / this.qty)
                    Log.log('BuySellStrategy: Quantity and price are updated, qty: ', this.qty, ' price: ', this.price)
                }

                const averageThreshold = configService.getStrategyConfig('BuySellStrategy').averageThreshold;
                const targetPrice = configService.getStrategyConfig('BuySellStrategy').targetPrice;
        
                Log.log('BuySellStrategy: ', this.contract, ' buyAt: ', round(this.lastOrderedPrice - averageThreshold), 'sellAt: ', round(this.price + targetPrice))
                // averageThreshold = updatePrice(this.price)
                // targetPrice = updatePrice(this.price)
            }

            if (sellOrderPlaced && trade.action == this.SELL) {
                this.clear();
                tradeClosed = true;
                Log.log('After Sell Trade, contract: ', this)
            }
            Log.log('this contract: ', this.contract)
        }
        return tradeClosed;
    }
}

export default class BuySellStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false


    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'BuySellStrategy';
        this.enabled = true
    }

    getMonitorConfig() {
        const config = configService.getStrategyConfig('BuySellStrategy');
        return { targetPoints: config.targetPrice, stopLossPoints: 0, trailingDistance: configService.getConfig().settings.trailingDistance };
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
                    if (nextOrder.action == 'buy') {
                        Log.log('Buy next order ', nextOrder)
                        await super.buyContract(nextOrder.contract, nextOrder.quantity, nextOrder.price)
                    } else if (nextOrder.action == 'sell') {
                        Log.log('Sell next order ', nextOrder)
                        await super.sellContract(nextOrder.contract, nextOrder.quantity, nextOrder.price)
                    }
                }
            }

        }
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const enabled = configService.getStrategyConfig('BuySellStrategy').enabled;
        let right = configService.getStrategyConfig('BuySellStrategy').right;
        const targetPrice = configService.getStrategyConfig('BuySellStrategy').targetPrice;
        const averageThreshold = configService.getStrategyConfig('BuySellStrategy').averageThreshold;
        const initialQuantity = configService.getStrategyConfig('BuySellStrategy').initialQuantity;

        if (enabled && this.isTimeInRange() && !this.ordered && this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) {
            this.ordered = true;
            Log.log('Initiate buy index for NIFTY at ', quote.ltp, ' with initial quantity: ', initialQuantity)
            buyOrderPlaced = true
            if ("none" == right) {
                right = await OrderClient.getInstance().calculateRight(this.userId, quote.ltp)
            }

            if (!this.isSentimentAligned(quote, right)) {
                Log.log('[BuySell] Sentiment not aligned for', right, '— skipping');
                this.ordered = false;
                return;
            }

            const contract = await OrderClient.getInstance().getContractByPriceRange(this.userId, right)
            this.contract = new Contract(this, contract);
            Log.log('BuySellStrategy: buy contract for the first time', this.contract.contract, ' at ', quote.ltp, ' quantity: ', initialQuantity)
            const response = await super.buyContract(contract, initialQuantity)
            // const response = await Prism.getInstance().buyIndex({ user: this.userId, index: NIFTY, ltp: quote.ltp-2, right: "any", qty: initialQuantity });
            if (response) {
                this.contract.update(response.token);
            }
            this.recordTriggerTime();
        }
    }


    reset(): void {
        super.reset();
        this.contract.clear();
        this.ordered = false;
    }

    closeStrategy = async () => {
        Log.log('BuySellStrategy: closeStrategy called')
        if (this.contract && this.contract.contract) {
            super.sellContract(this.contract.contract, this.contract.qty, this.contract.price)
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
        Log.log('Update Trade is called at buySellStrategy: ', trade.tsym, ' action: ', trade.action, ' price: ', trade.price, ' quantity: ', trade.quantity)
        if (this.contract?.updateTrade) {
            Log.log('Updating the trade in contract: ', this.contract.contract)
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                this.ordered = false;
                // await Prism.getInstance().buyIndex({ user: this.userId, index: NIFTY, ltp: trade.ltp, right: "any", qty: initialQuantity });
            }
        }
    }
}