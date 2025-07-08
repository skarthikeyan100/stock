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


export abstract class Strategy {
    tradeMap : Map<String, Trade> = new Map()
    orderMap : Map<String, OrderInfo> = new Map()
    name: string
    BUY = 'Buy'
    SELL = 'Sell'
    ordered = false
    enabled = false
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

    updateTrade(trade: Trade) {
        const hasOrder= this.orderMap.has(trade.tsym)
        console.log(this.getClassName(), ': updateTrade: ', trade.tsym, ' hasOrder: ', hasOrder)

        if (hasOrder && trade.action == this.BUY) {
            const orderInfo = this.orderMap.get(trade.tsym)
            orderInfo.status = OrderStatus.BOUGHT
        } else if (hasOrder && trade.action == this.SELL) {
            this.ordered = false;
            this.orderMap.delete(trade.tsym);
        }
    }
}