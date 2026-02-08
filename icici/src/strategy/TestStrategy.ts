import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import Prism from '../prism'
import { NIFTY, CALL, PUT } from '../constants'
import nse_index from "nse_index";


export default class TestStrategy extends Strategy{
    stats: any;

    constructor() {
        super()
        this.tradeMap = new Map();
        this.name = 'TestStrategy';
    }

    receive = (oldStats, newStats) =>  {
        // console.log('Received ', newStats)
        if (newStats != null) {
            // console.log('EventName: ', newStats.results.eventName)
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
        // console.log('Method: processNiftyQuote')
    }

    updateTrade = async (trade: Trade) => {
        console.log('Method: updateTrade')
    }
}