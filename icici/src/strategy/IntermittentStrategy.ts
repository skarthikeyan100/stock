import Log from '../util/Log';
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';
import { TouchSequence } from "selenium-webdriver";
import configService from '../prism/ConfigService'
import strategies from "./strategies";


const round = (num) => Math.round(num * 100) / 100;

const BUY = 'Buy'
const SELL = 'Sell'
let objectCount = 0

// const loopCount = 3;
// const quantity = 900;
// const targetPrice = 2


// Does not handle negative directions

class Contract {
    strategyId: string;
    buyOrderPlaced = false
    sellOrderPlaced = false
    triggeredAgain = false

    contract: string;
    price: number = 0;
    quantity: number = 0;
    token: string;
    iterationCount: number = 1;
    strategy: Strategy = {} as Strategy;

    constructor(strategy, contract) {
        this.contract = contract;
        this.strategy = strategy;
        this.buyOrderPlaced = true
    }

    update = (token) => {
        this.token = token;
        
    }

    setStrategyId = (id) => {
        this.strategyId = id
    }

    clear = () => {
        this.price = 0;
        this.buyOrderPlaced = false;
        this.sellOrderPlaced = false;
        this.iterationCount = 1;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) : Promise<void> => {
        const enabled = configService.getStrategyConfig('IntermittentStrategy').enabled;
        const threshold = configService.getStrategyConfig('IntermittentStrategy').threshold;
        const logEnabled = configService.getStrategyConfig('IntermittentStrategy').logEnabled
        if (enabled && this.token == quote.token) {
            const profit = round((quote.ltp - this.price) * this.quantity);

            // Log.log(this.strategyId, this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' profit: ', profit, ' sellOrderPlaced: ', this.sellOrderPlaced)
            const canBuy = (this.price - quote.ltp) >= threshold

            if (logEnabled) {
                Log.log(this.strategyId, 'ltp: ', quote.ltp, ' price: ', this.price, ' triggerAt: ', round(this.price - threshold), ' canBuy: ', canBuy)
            }
            

            //Handle negative direction
            if (this.price > 0) {
                if (this.token && this.token == quote.token &&
                    canBuy == true && !this.triggeredAgain) {
                    this.triggeredAgain = true
                    const right = this.contract.indexOf('C') !== -1 ? PUT : CALL
                    Log.log(this.strategyId, 'Trigger again')
                    const intermittentStrategy = new IntermittentStrategy();
                    intermittentStrategy.buyIndex(quote.ltp, right)
                    strategies.addToList(intermittentStrategy)
                    Log.log('Strategies length: ', strategies.getList().length)

                }
            }

        }
    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        Log.log('Intermittent Strategy: Update Trade: ', trade.action, ' ', trade.quantity, ' ', trade.tsym, ' ', trade.token)
        
        const enabled = configService.getStrategyConfig('IntermittentStrategy').enabled;
        const quantity = configService.getStrategyConfig('IntermittentStrategy').quantity;
        const loopCount = configService.getStrategyConfig('IntermittentStrategy').loopCount;
        const targetPrice = configService.getStrategyConfig('IntermittentStrategy').loopCount;
        let tradeClosed = false
        Log.log('Enabled: ', enabled, ' Contract: ', this.contract, 'trade.tsym: ', trade.tsym, ' buyOrderPlaced: ', this.buyOrderPlaced, ' action: ', trade.action, ' quantity: ', this.quantity);
        if (enabled && trade.tsym == this.contract) {
            if (this.buyOrderPlaced && trade.action == BUY ) {
                this.buyOrderPlaced = false;
                if (this.quantity == 0) {
                    this.quantity = trade.quantity
                    this.price = trade.price
                    Log.log(this.strategyId, ' sell price to ', trade.price, ' for the first time')
                } else {
                    const totalAmount = (this.quantity * this.price) + (trade.quantity * trade.price)
                    this.quantity = this.quantity + trade.quantity
                    this.price = round(totalAmount / this.quantity)
                }
                Log.log(this.strategyId, this.contract, ' bought at ', this.price, ' qty: ', this.quantity, ' sellAt: ', round(this.price + targetPrice))
            }

            // Just hoping that qty will be unique per strategy, but can consider other strategy and a potential bug
            if (this.sellOrderPlaced && trade.action == SELL) { 
                this.clear();
                this.iterationCount += 1;
                Log.log(this.strategyId, 'iterationCount: ', this.iterationCount)
                if (this.iterationCount <= loopCount) {
                    Log.log(this.strategyId, 'Re-buy contract ', this.contract, ' at ', round(trade.price - 2), ' iteration: ', this.iterationCount)
                    this.buyOrderPlaced = true;
                    setTimeout(async () => {
                        Log.log(this.strategyId, 'Place Re-buy contract order now')
                        this.strategy.buyContract(this.contract, this.quantity, round(trade.price - 2));
                      }, 1000);
                    
                } else {
                    tradeClosed = true;
                    this.clear();
                    this.contract = '';
                    this.token = '';
                }
            }
        }
        return tradeClosed;
    }
}

export default class IntermittentStrategy extends Strategy {
    id: string
    processNiftyQuote(quote: NiftyQuote) {
        // Log.log('Does not decide on buying a contract on own')
    }
    receive(oldStats: any, newStats: any) {
        // Log.log('Stats not required')
    }
    contract: Contract = {} as Contract
    name: string;
    ordered = false


    constructor(userId?: string) {
        super(userId || ('IntermittentStrategy-' + (objectCount + 1)));
        objectCount++;
        this.name = 'IntermittentStrategy - ' + objectCount;
        this.id = 'IntermittentStrategy - ' + objectCount + ': ';

    }

    buyIndex = async (ltp, right) => {
        Log.log(this.id, 'buyIndex called with right: ', right, ' and ltp is ', ltp);
        const quantity = configService.getStrategyConfig('IntermittentStrategy').quantity;

        const contract = await Prism.getInstance().getContractByPriceRange(right)
        this.contract = new Contract(this, contract);
        const response = await super.buyContract(contract, quantity)
        Log.log('IntermittentStrategy: buyContract response: ', response)
        if (response) {
            this.contract.update(response.token);
            this.contract.setStrategyId(this.id)
            this.ordered = true
        }
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

    updateTrade = async (trade: Trade) => {
        Log.log('IntermittentStrategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.contract?.updateTrade) {
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                Log.log(this.id, 'Removing from strategies: ', this.userId, ' for the contract ', this.contract.contract);
                strategies.removeFromList(this.userId);
            }
        }
    }
}