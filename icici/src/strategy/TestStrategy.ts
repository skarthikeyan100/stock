import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}
const round = (num) => Math.round(num * 100) / 100;

const contraThreshold = 4
const targetPrice = 3
const buyQuantity: number = 300
const stopLossThreshold = 20
const buyAgainDiff = 2 // Price is reduced to this amount to create a position again

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL

class Order {
    contract: string
    token: string
    qty: number
    price: number
    active: boolean = false

    BUY = 'Buy'
    SELL = 'Sell'    


    async addOrder(price, right, quantity?: number) {
        const order = await Prism.getInstance().buyIndex(NIFTY, price, right, quantity);
        return {
            contract: order.contract,
            price: order.price,
            qty: order.qty,
            token: order.token
        }
    }

    initialize(order: any) {
        this.contract = order.contract;
        this.token = order.token;
        this.qty = order.qty;
        this.price = order.price;
        this.active = true;
    }

    clear = () => {
        this.contract = '';
        this.token = '';
        this.qty = 0;
        this.price = 0;
        this.active = false;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }

    processOptionQuote = async (quote: OptionQuote): Promise<boolean> => {
        let addContraOrder = false;
        if (this.active && quote.token == this.token) {
            console.log('HighLotStrategy: diff: ', (quote.ltp - this.price))
            const diff = quote.ltp - this.price
            if ( diff >= targetPrice) {
                console.log('ProcessOptionQuote: Sell as targetPrice is reached, diff: ', diff)
                // await Prism.getInstance().sellContract(this.strategy, this.contract, this.qty, quote.ltp) 
                console.log("************************** REVISIT **************")
                this.clear()
            } else if (diff <= -contraThreshold && diff > stopLossThreshold) {
                console.log('ProcessOptionQuote: Add Contra Order contra? ', diff <= -contraThreshold, ' stoploss? ', diff > stopLossThreshold)
                addContraOrder = true;
            } else if (diff <= -stopLossThreshold) {
                console.log('HighLotStrategy: Selling for stop loss')
                // await Prism.getInstance().sellContract(this.strategy, this.contract, this.qty, quote.ltp) 
                console.log("************************** REVISIT **************")
                this.clear()
            } else {
                console.log('NOthing happened in processOptionQuote, diff: ', diff)
            }

        }
        return addContraOrder
    }

    updateTrade = async (trade: Trade) => {
        console.log('HighLotStrategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                this.qty = this.qty + trade.quantity
                this.price = round(totalAmount / this.qty)
            }

            if (trade.action == this.SELL) {
                this.clear();
            }
        }
    }    
}

export default class TestStrategy extends Strategy{
    stats: any;

    constructor() {
        super()
        this.tradeMap = new Map();
        this.name = 'TestStrategy';
    }

    receive = (oldStats, newStats) =>  {
        if (newStats != null) {
            console.log(newStats.results.eventName)
        }
        this.stats = newStats;
    }


    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        console.log('Method: canHandleOptionQuote')
        return false;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        console.log('Method: processOptionQuote')
    }

    processNiftyQuote = async (quote) => {
        console.log('Method: processNiftyQuote')
    }

    updateTrade = async (trade: Trade) => {
        console.log('Method: updateTrade')
    }
}