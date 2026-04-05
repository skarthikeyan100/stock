import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'
import nse_index from "nse_index";


export default class TestStrategy extends Strategy{
    stats: any;

    constructor(userId?: string) {
        super(userId)
        this.tradeMap = new Map();
        this.name = 'TestStrategy';
    }

    receive = (oldStats, newStats) =>  {
        // Log.log('Received ', newStats)
        if (newStats != null) {
            // Log.log('EventName: ', newStats.results.eventName)
        }
        this.stats = newStats;
    }


    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        Log.log('Method: canHandleOptionQuote')
        return false;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        Log.log('Method: processOptionQuote')
    }

    processNiftyQuote = async (quote) => {
        // Log.log('Method: processNiftyQuote')
    }

    updateTrade = async (trade: Trade) => {
        Log.log('Method: updateTrade')
    }
}