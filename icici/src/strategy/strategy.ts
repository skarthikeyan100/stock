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
        const startTime = moment().hour(9).minute(30);
        const endTime = moment().hour(15).minute(30);
    
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
            console.log('Waiting for current strategy to complete: ', Strategy.currentStrategy.getClassName(), ' moment: ', moment().format('HH:mm:ss'))
            sleep(1000)
        }

        Strategy.currentStrategy = this;
        return await Prism.getInstance().buyContract(contract, quantity, price)
    }

    async sellContract(contract: string, quantity: number, price?: number ) {
        console.log('Buy Contract by ', this.getClassName(), ' for contract: ', contract)
        Strategy.currentStrategy = this;
        await Prism.getInstance().sellContract(contract, quantity, price)
    }

    static updateTradeWrapper = async (trade: Trade) : Promise<void> => {
        if (Strategy.currentStrategy) {
            await Strategy.currentStrategy.updateTrade(trade)
            console.log('Order by ', Strategy.currentStrategy.getClassName(), ' is closed for contract: ', trade.tsym)
            Strategy.currentStrategy = null;
        } else {
            console.log('********************  There is no current strategy which is incorrect ********************')
        }

    }

    updateTrade = async (trade: Trade) : Promise<void> => {
        console.log('*******  SHOULD BE OVERRIDDEN *******')
    }
}