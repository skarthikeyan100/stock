import { NIFTY } from "../constants";
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import moment from "moment";
import Prism from "../prism";
import config from "../prism/config";
import * as f from '../orderList'
import PivotStrategy from "./PivotStrategy";
import DiffStrategy from "./DiffStrategy";
export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}




export abstract class Strategy {
    tradeMap : Map<String, Trade> = new Map()
    orderMap : Map<String, OrderInfo> = new Map()
    name: string
    BUY = 'Buy'
    SELL = 'Sell'
    ordered = false
    enabled = false
    token: string
    multipleTradesAllowed: true
    static currentStrategy: Strategy = null;
    // process(quote: NiftyQuote, token: String) : Outcome 
    // addTrade(trade: Trade);
    abstract receive(oldStats, newStats);
    abstract processNiftyQuote(quote: NiftyQuote);
    abstract processOptionQuote(quote: OptionQuote);
    
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }
   
    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(10).minute(0);
        const endTime = moment().hour(15).minute(0);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    async addOrder(price, right, quantity?: number) {
        const order = await Prism.getInstance().buyIndex(NIFTY, price, right, quantity);
        console.log(this.getClassName + ' In add order ', order)
        this.orderMap.set(order.contract, order);
        this.ordered = true;
        return {
            contract: order.contract,
            price: order.price,
            qty: order.qty,
            token: order.token
        }
    }

    getClassName(): string {
        return this.constructor.name;
    }

      
    async buyContract(contract: string, quantity: number, price?: number ): Promise<OrderInfo> {
        console.log('Buy Contract by ', this.getClassName(), ' for contract: ', contract)
        while (Strategy.currentStrategy != null) {
            console.log('Waiting for current strategy to complete to buy a contract: ', Strategy.currentStrategy.getClassName(), ' moment: ', moment().format('HH:mm:ss'))
            await sleep(1000)
        }

        Strategy.currentStrategy = this;
        const response = await Prism.getInstance().buyContract(contract, quantity, price)
        return response;
    }

    async sellContract(contract: string, quantity: number, price?: number ) {
        console.log('Sell Contract by ', this.getClassName(), ' for contract: ', contract + " for the price " + price)
        
        while (Strategy.currentStrategy != null) {
            console.log('Waiting for current strategy to complete to sell a contract: ', Strategy.currentStrategy.getClassName(), ' moment: ', moment().format('HH:mm:ss'))
            await sleep(1000)
        }
        const response = await Prism.getInstance().sellContract(contract, quantity, price)

        return response;

    }

    static tradesCount = 0;

    static updateTradeWrapper = async (trade: Trade) : Promise<void> => {
        if (trade.action == 'Buy') { 
            this.tradesCount++;
        } else if (trade.action == 'Sell') {
            this.tradesCount --;
        }
        console.log('Active trades count: ', this.tradesCount)

        if (Strategy.currentStrategy) {
            await Strategy.currentStrategy.updateTrade(trade)
            console.log('Order by ', Strategy.currentStrategy.getClassName(), ' is closed for contract: ', trade.tsym)
            // Strategy.currentStrategy = null; // Fix this as few strategies need multiple orders like Minutes5Decision
        } else {
            console.log('********************  There is no current strategy which is incorrect ********************')
        }

    }

    tradesCount = 0;
    updateTrade = async (trade: Trade) : Promise<void> => {
        console.log('*******  SHOULD BE OVERRIDDEN ******* ', trade)
    }
}