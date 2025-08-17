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
        const enabled = configService.getConfig().intermittentStrategy.enabled;
        const targetPrice = configService.getConfig().intermittentStrategy.targetPrice;
        const threshold = configService.getConfig().intermittentStrategy.threshold;
        const logEnabled = configService.getConfig().intermittentStrategy.logEnabled
        if (enabled && this.token == quote.token) {
            const profit = round((quote.ltp - this.price) * this.quantity);
    
            // console.log(this.strategyId, this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' profit: ', profit, ' sellOrderPlaced: ', this.sellOrderPlaced)
            const canBuy = (this.price - quote.ltp) >= threshold
            const canSell = (quote.ltp - this.price) >= targetPrice

            if (logEnabled) {
                console.log(this.strategyId, 'ltp: ', quote.ltp, ' price: ', this.price, ' targetPrice: ',round(this.price + targetPrice), ' canSell: ', canSell, ' triggerAt: ', round(this.price - threshold), ' canBuy: ', canBuy)
            }
            

            //Handle negative direction
            if (this.price > 0) {
                if (this.token && this.token == quote.token &&
                    canBuy == true && !this.triggeredAgain) {
                    this.triggeredAgain = true
                    const right = this.contract.indexOf('C') !== -1 ? PUT : CALL
                    console.log(this.strategyId, 'Trigger again')
                    const intermittentStrategy = new IntermittentStrategy();
                    intermittentStrategy.buyIndex(quote.ltp, right)
                    strategies.addToList(intermittentStrategy)
                    console.log('Strategies length: ', strategies.getList().length)

                }
            }

            //Handle positive direction
            if (this.price > 0) {
                if (this.token && this.token == quote.token &&
                    canSell == true && !this.sellOrderPlaced) {
                    this.sellOrderPlaced = true
                    console.log(this.strategyId, 'handling positive direction sell contract ', this.contract, ' at ', quote.ltp)
                    this.strategy.sellContract(this.contract, this.quantity, quote.ltp)
                }
            }
        }
    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        console.log('Intermittent Strategy: Update Trade: ', trade.action, ' ', trade.quantity, ' ', trade.tsym, ' ', trade.token)
        
        const enabled = configService.getConfig().intermittentStrategy.enabled;
        const quantity = configService.getConfig().intermittentStrategy.quantity;
        const loopCount = configService.getConfig().intermittentStrategy.loopCount;
        const targetPrice = configService.getConfig().intermittentStrategy.loopCount;
        let tradeClosed = false
        console.log('Enabled: ', enabled, ' Contract: ', this.contract, 'trade.tsym: ', trade.tsym, ' buyOrderPlaced: ', this.buyOrderPlaced, ' action: ', trade.action, ' quantity: ', this.quantity);
        if (enabled && trade.tsym == this.contract) {
            if (this.buyOrderPlaced && trade.action == BUY ) {
                this.buyOrderPlaced = false;
                if (this.quantity == 0) {
                    this.quantity = trade.quantity
                    this.price = trade.price
                    console.log(this.strategyId, ' sell price to ', trade.price, ' for the first time')
                } else {
                    const totalAmount = (this.quantity * this.price) + (trade.quantity * trade.price)
                    this.quantity = this.quantity + trade.quantity
                    this.price = round(totalAmount / this.quantity)
                }
                console.log(this.strategyId, this.contract, ' bought at ', this.price, ' qty: ', this.quantity, ' sellAt: ', round(this.price + targetPrice))
            }

            // Just hoping that qty will be unique per strategy, but can consider other strategy and a potential bug
            if (this.sellOrderPlaced && trade.action == SELL) { 
                this.clear();
                this.iterationCount += 1;
                console.log(this.strategyId, 'iterationCount: ', this.iterationCount)
                if (this.iterationCount <= loopCount) {
                    console.log(this.strategyId, 'Re-buy contract ', this.contract, ' at ', round(trade.price - 2), ' iteration: ', this.iterationCount)
                    this.buyOrderPlaced = true;
                    setTimeout(async () => {
                        console.log(this.strategyId, 'Place Re-buy contract order now')
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
        // console.log('Does not decide on buying a contract on own')
    }
    receive(oldStats: any, newStats: any) {
        // console.log('Stats not required')
    }
    contract: Contract = {} as Contract
    name: string;
    ordered = false


    constructor() {
        super();
        objectCount++;
        this.name = 'IntermittentStrategy ', ' - ', objectCount;
        this.id = 'IntermittentStrategy - ' + objectCount + ': ';

    }

    buyIndex = async (ltp, right) => {
        console.log(this.id, 'buyIndex called with right: ', right, ' and ltp is ', ltp);
        const quantity = configService.getConfig().intermittentStrategy.quantity;

        const contract = await Prism.getInstance().getContractByPriceRange(right)
        this.contract = new Contract(this, contract);
        const response = await super.buyContract(contract, quantity)
        console.log('IntermittentStrategy: buyContract response: ', response)
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
        console.log('IntermittentStrategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (this.contract?.updateTrade) {
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                console.log(this.id, 'Need to remove from strategies: ', this.getClassName(), ' for the contract ', this.contract.contract);
            }
        }
    }
}