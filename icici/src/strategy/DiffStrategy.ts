import { NiftyQuote, OptionQuote, Trade } from "model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'
import moment from "moment";
import configService from '../prism/ConfigService'

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

const round = (num) => Math.round(num * 100) / 100;

//Strategy: If support is breached, buy PUT. If resistance is breached, buy CALL
const eventName = 'priceUpdate_60'

export default class DiffStrategy extends Strategy {

    tradeMap: Map<String, Trade>;
    name: string;
    previousWindowTrend = 'NEUTRAL'
    stats: any
    ordered = false
    diff: number
    expectedDiff = 10
    contract: string
    token: string
    price: number
    qty: number
    orderPlaced: boolean = false;

    constructor() {
        super();
        this.tradeMap = new Map();
        this.name = 'DiffStrategy';
        this.diff = null;
    }

    receive(oldStats, newStats) {
        console.log('Received stats: ?', newStats ? newStats.results.eventName : 'new stats null')
        this.stats = newStats;
        this.diff = newStats.close - newStats.open
    }

    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(10).minute(0);
        const endTime = moment().hour(15).minute(0);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
    }
    
    buyIndex = async (right) => {
        console.log('IntermittentStrategy: buyIndex called with right: ', right);
        const quantity = configService.getConfig().intermittentStrategy.quantity;
        const response = await Prism.getInstance().buyIndex(NIFTY, null, right, quantity);
        if (response) {
            this.contract = response.contract;
            this.token = response.token;
        }
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.token != null && this.token == quote.token;
    }

    processOptionQuote = async (quote: OptionQuote) : Promise<void> => {
        const enabled = configService.getConfig().intermittentStrategy.enabled;
        const targetPrice = configService.getConfig().intermittentStrategy.targetPrice;
        if (enabled && this.token == quote.token) {
            const profit = round((quote.ltp - this.price) * this.qty);
            console.log('DiffStrategy: ', this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', profit)
    
           
            //Handle positive direction
            const canSell = (quote.ltp - this.price) >= targetPrice
    
            if (this.token && this.token == quote.token &&
                canSell == true && !this.orderPlaced) {
                this.orderPlaced = true
                console.log('DiffStrategy: sell contract ', this.contract, ' at ', quote.ltp)
                await Prism.getInstance().sellContract(this.contract, this.qty, quote.ltp)
            }
    
        }
    }

    clear = () => {
        this.qty = 0;
        this.price = 0;
        this.orderPlaced =false;
    }


    updateTrade = async (trade: Trade) : Promise<void> => {
        let tradeClosed = false
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                this.orderPlaced = false;
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
    }


    async processNiftyQuote(quote) {
        if (this.stats != null && this.stats.results.eventName == eventName) {
            if (this.isTimeInRange() && this.diff != null && this.ordered == false) {
                console.log('DiffStrategy: Diff between close and open: ', this.diff, ' expected diff: ', this.expectedDiff)
                if (this.diff > this.expectedDiff ) {
                    console.log('DiffStrategy: Buy CALL as diff is ', this.diff)
                    await this.buyIndex(CALL)
                } else if (this.diff < -this.expectedDiff) {
                    console.log('DiffStrategy: Buy PUT as diff is ', this.diff)                
                    await this.buyIndex(PUT)
                }
            }
        }
    }


}