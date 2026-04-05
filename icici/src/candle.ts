import Log from './util/Log';
// Strategy:
// If direction is sure, go for option else go for option plus

import axios, { AxiosRequestConfig } from 'axios'
import { RestAPI, WebSocket } from '@quantiply/finvasia-nodejs-sdk';
import NorenRestApi from './prism/RestAPI'
import _ from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, Trade } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Mongo from './tools/mongo'
import Prism from './prism';
import Util from './util';
import indexMap from './nse_index';
import { NIFTY } from './constants'




const CALL = 'call';
const PUT = 'put';
const BUY = 'Buy';
const SELL = 'Sell';

export enum CandleType {
    FIVE, FIFTEEN, THIRTY
}

export class Candle {
    open: Number
    close: Number
    high: Number
    low: Number
    volume: Number
    seqNumber: Number
    startTime
    endTime
    diff
    index
    start
    end
    diffTime
    diffInMinutes

    inProgress: Candle

    constructor(index, diffInMinutes) {
        this.index = index;
        this.diffInMinutes = diffInMinutes;
        this.diff = diffInMinutes * 60; // in seconds ??
    }

    update(quote: NiftyQuote) {

        const diffTime = (quote.ltt - this.startTime);
        // Log.log('diffTime: ', diffTime, ' diff: ', this.diff)
        if (this.startTime == null) {
            this.startTime = quote.ltt;
            this.start = new Date(quote.ltt * 1000).toString()
        } else if (diffTime >= this.diff) {
            this.endTime = quote.ltt;
            this.end = new Date(quote.ltt * 1000).toString()
            // Log.log('Returning false; diff: ', this.diff, ' Actual: ', diffTime, " condition: ", (diffTime >= this.diff))
            return false;
        }
        if (this.open == null) {
            this.open = quote.ltp;
        }

        if (this.high == null) {
            this.high = quote.ltp;
        } else if (quote.ltp > this.high) {
            this.high = quote.ltp;
        }

        if (this.low == null) {
            this.low = quote.ltp;
        } else if (quote.ltp < this.low) {
            this.low = quote.ltp;
        }

        this.close = quote.ltp
    }
}

class CandleKey {
    index
    minutes

    constructor(index, minutes) {
        this.index = index;
        this.minutes = minutes;
    }
}

class CandleHolder {
    candle: Candle
    candles: Array<Candle>

    constructor(candle) {
        this.candle = candle;
        // Log.log('Constructing holder ', this.candle.index, ' - ', this.candle.diff)
        this.candles = [];
    }

    update(quote: NiftyQuote) {
        if (quote.token == 'NIFTY') {
            if (quote.ltt) {
                // Log.log('Update: ', quote);
                // Log.log('diff: ', this.candle.diff);
                const updated = this.candle.update(quote);
                if (updated == false) {
                    this.candle.seqNumber = this.candles.length + 1;
                    this.candles.push(this.candle);
                    this.candle = new Candle(this.candle.index, this.candle.diffInMinutes)
                }
            }
        }
    }
}

export class CandleManager {
    candles: Array<CandleHolder> = [];


    constructor() {
        this.candles.push(new CandleHolder(new Candle('NIFTY', 5)));
        this.candles.push(new CandleHolder(new Candle('NIFTY', 15)));
        this.candles.push(new CandleHolder(new Candle('NIFTY', 30)));
        this.candles.push(new CandleHolder(new Candle('BANKNIFTY', 5)));
        this.candles.push(new CandleHolder(new Candle('BANKNIFTY', 15)));
        this.candles.push(new CandleHolder(new Candle('BANKNIFTY', 30)));
        this.candles.push(new CandleHolder(new Candle('FINNIFTY', 5)));
        this.candles.push(new CandleHolder(new Candle('FINNIFTY', 15)));
        this.candles.push(new CandleHolder(new Candle('FINNIFTY', 30)));

    }

    addQuote(quote: NiftyQuote) {

        const x = new Date(quote.ltt * 1000);
        if (x.getDate() != 21) {
            return;
        }
        if ((x.getHours() == 9 && x.getMinutes() < 15)) {
            return;
        }
        for (const candleHolder of this.candles) {
            candleHolder.update(quote);
        }
    }


    print() {
        Log.log('Printing now')
        for (const candleHolder of this.candles) {
            Log.log(candleHolder.candle.index, ' : ', candleHolder.candle.diff, ' - ', candleHolder.candles.length);
            for (const candle of candleHolder.candles) {
                // Log.log(candle)
            }
        }
    }

    getCandleData(index, min) {
        let candles: Array<Candle> = []
        for (const candleHolder of this.candles) {
            if (candleHolder.candle.index == index && min == candleHolder.candle.diffInMinutes) {
                candles = candleHolder.candles;
                break;
            }
        }
        const response = candles
            .map((row) => {
                return {
                    timestamp: row.endTime,
                    open: row.open,
                    high: row.high,
                    low: row.low,
                    close: row.close,
                    volume: 10
                };
            });
        Log.log(response);
        return response;
    }

}

export default new CandleManager();

