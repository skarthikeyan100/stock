import Log from '../util/Log';
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

    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'DiffStrategy';
        this.diff = null;
    }

    receive(oldStats, newStats) {
        Log.log('Received stats: ?', newStats ? newStats.results.eventName : 'new stats null')
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
        Log.log('IntermittentStrategy: buyIndex called with right: ', right);
        const quantity = configService.getStrategyConfig('IntermittentStrategy').quantity;
        const response = await Prism.getInstance().buyIndex({ userContext: this.getUserContext(), index: NIFTY, right, qty: quantity });
        if (response) {
            this.contract = response.contract;
            this.token = response.token;
        }
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.token != null && this.token == quote.token;
    }

    processOptionQuote = async (quote: OptionQuote) : Promise<void> => {
        const enabled = configService.getStrategyConfig('IntermittentStrategy').enabled;
        if (enabled && this.token == quote.token) {
            const profit = round((quote.ltp - this.price) * this.qty);
            Log.log('DiffStrategy: ', this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', profit)
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
                Log.log('After Sell Trade, contract: ', this)
            }
        }
    }


    async processNiftyQuote(quote) {
        if (this.stats != null && this.stats.results.eventName == eventName) {
            if (this.isTimeInRange() && this.diff != null && this.ordered == false) {
                Log.log('DiffStrategy: Diff between close and open: ', this.diff, ' expected diff: ', this.expectedDiff)
                if (this.diff > this.expectedDiff ) {
                    Log.log('DiffStrategy: Buy CALL as diff is ', this.diff)
                    await this.buyIndex(CALL)
                } else if (this.diff < -this.expectedDiff) {
                    Log.log('DiffStrategy: Buy PUT as diff is ', this.diff)                
                    await this.buyIndex(PUT)
                }
            }
        }
    }


}