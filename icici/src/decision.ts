import Log from './util/Log';
// Strategy:
// If direction is sure, go for option else go for option plus

import * as fs from 'fs';
import axios, { AxiosRequestConfig } from 'axios'
import { RestAPI, WebSocket } from '@quantiply/finvasia-nodejs-sdk';
import NorenRestApi from './prism/RestAPI'
import _, { over } from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, PeriodicStats, RealTimeTrend, Trade } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Mongo from './tools/mongo'
import Prism from './prism';
import Config from './prism/config';
import Util from './util';
import indexMap from './nse_index';
import { NIFTY, SIMULATION } from './constants'
import candleManager, { CandleType } from './candle';
import { Strategy, Outcome } from './strategy/strategy';
import { ORBPrevious } from './strategy/ORBPrevious';
import stats from 'stats-lite';
import regression from 'regression';
import { buildCandle } from './lib/candle-builder';
import { calcRSI, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic } from './lib/indicators';
import { INTERVALS, RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from './lib/indicator-config';
import EventEmitter from 'events';
import { OnTrigger } from './onTrigger';
import moment from 'moment';
import Monitor from './monitor';
import * as f from './orderList'
import strategies from './strategy/strategies';
import { Parser } from 'json2csv'
import e from 'express';

const CALL = 'call';
const PUT = 'put';
const BUY = 'Buy';
const SELL = 'Sell';

class BuyerInterestModel{
    contract
    buyQty
    sellQty
    diff
    intrinsic
    extrinsic
}

export class Candle {
    eventName
    time?
    open
    close
    high
    low
    average
    median
    stdDeviation
    mad
    S1
    R1
    S2
    R2
    method?
    trend?
    result?
}

export class PricePoint {
    time: number
    price
    constructor(time, price) {
        this.time = time
        this.price = price
    }
}

export default class Decision {
    historyLen = 5;
    profit = 3000;
    quotes = [];
    static instance: Decision;
    depth = 2;
    onTrigger: OnTrigger;
    replayMode = false;
 

    static getInstance() {
        if (!Decision.instance) {
            Decision.instance = new Decision();
            if (SIMULATION) {
                Decision.instance._readQuotesAsStream();
            }

        }
        return Decision.instance;
    }

    startTime = Date.now();
    getMinutePrice = (price) =>{
        const currentTime = Date.now();
        if ((currentTime - this.startTime) >= 10000) { 
            this.startTime = Date.now();
          return price;
        } else {
          return null;
        }
      }

    setOnTrigger = (contract, triggerPrice) => {
        Log.log("setOnTrigger is called")
        this.onTrigger = new OnTrigger();
        this.onTrigger.setTrigger(contract, triggerPrice)
    }

    decidePurchaseStockOption = async (quote: OptionQuote) => {
        if (this.onTrigger) {
            this.onTrigger.process(quote);
        }
        for (const strategy of strategies.getList()) {
            // Log.log('Process strategy ', strategy.getClassName())
            await strategy.processOptionQuote(quote);
        }
    }

    decidePurchase = async (quote: NiftyQuote) => {
        if (!SIMULATION) {
            this._addPrice(parseInt(quote.ltt), quote.ltp)

            for (const strategy of strategies.getList()) {
                strategy.processNiftyQuote(quote);
            }


            //Strategy: If diff > 5, buy CALL. If diff < 5, buy PUT with no stop loss

        }

        // this.quotes.push(niftyQuote);
        // Log.log('Pushing ', niftyQuote);
        // Log.log('this.quotes before shift ', this.quotes.length);
        // if (this.quotes.length == this.historyLen + 1) {
        //     this.quotes.shift();
        //     Log.log('After shift ', this.quotes.length);
        // }

        // this._formCandle(quote);
        // for (const strategy of this.strategies) {
        //     const outcome = strategy.process(quote, quote.token);
        //     Log.log('Outcome: ', outcome.toString())
        //     let trade: Trade;
        //     switch (outcome) {
        //         case Outcome.CALL:
        //             trade = await this._processOrder(quote, CALL, strategy.name);
        //             strategy.tradeMap.set(trade.token, trade);
        //             break;
        //         case Outcome.PUT:
        //             trade = await this._processOrder(quote, PUT, strategy.name);
        //             strategy.tradeMap.set(trade.token, trade);
        //             break;
        //         case Outcome.WAIT: break;
        //         case Outcome.PENDING_CLOSURE: 
        //             //Remove this comment
        //             if (SIMULATION) {
        //                 this.decideSell(quote);
        //             }
        //             break;
        //     }
        // }
        // this._decideInFirst5Minutes();
        // this._scalping();
        // this._utilizeVariationsBetween2And2Thirty();
        // this.decideBasedOnCurrentState(niftyQuote);
    };

    //Within 30 mins, the price breaks previous high or previous low
    _checkORBUsingPreviousPrice(niftyQuote) {
        const time = 30 * 60 // 30 mins or 1800 seconds

    }

    //Find high and low for first 30 mins. Trade if the current price crosses them
    _checkORBUsingOpeningRange() {
    }


    _decideInFirst5Minutes() {

    }

    _scalping() {

    }

    _utilizeVariationsBetween2And2Thirty() {

    }

    _formCandle(niftyQuote: NiftyQuote) {
        candleManager.addQuote(niftyQuote);
    }

    decideSell = async (optionQuote: OptionQuote) => {
        const prism = Prism.getInstance();
        for (const strategy of strategies.getList()) {
            const trade = strategy.tradeMap.get(optionQuote.token) as Trade;
            if (trade) {
                Log.log('Trade: ', trade.right, ' qty: ', trade.quantity, ' profit: ', trade.getProfit());
                if (trade.getProfit() > this.profit) {
                    Log.log('[Auto] Sell ', trade);
                    trade.action = SELL;
                    prism.squareOffOrder(trade.token, trade.quantity);
                    Mongo.getInstance().insert(trade);
                    strategy.tradeMap.delete(optionQuote.token);
                }
            }
        }
    };

    _processOrder = async (quote: NiftyQuote, right: string, strategy: string) => {

        const prism = Prism.getInstance();
        const niftyPrice = quote.ltp;
        // var expiryDate = Util.findExpiryDate();
        var expiryDate = Util.findExpiryDate();
        // Log.log('niftyPrice: ', niftyPrice, 'this.depth: ', this.depth, 'right: ', right);
        //TODO only nifty is considered for now
        const index = indexMap.get(NIFTY);
        const token = await index.findToken(NIFTY, this.depth, right, quote.ltp);

        // let quote: NiftyQuote;
        // quote = await prism.getOptionQuote(token);

        //FixMe: Quantity is hard-coded for 65, this will not work for other stocks
        const trade = await prism.sendLimitOrder(token, quote.ltp, right as string, BUY, 65, Monitor.getInstance().getUserContext(strategy));
        Mongo.getInstance().insert(trade);
        return trade;
    }

    _decideBasedOnCurrentState = (niftyQuote: NiftyQuote): String | void => {
        //TODO  time should be greater than 10
        // Log.log(niftyQuote);
        const isOpenGreaterThanPrevious = true; //niftyQuote.open > niftyQuote.prevClose;
        const isCurrentPriceGreaterThanOpenPrice = niftyQuote.ltp > niftyQuote.open;
        const isTrendHigh = niftyQuote.ltp > this.quotes[0].ltp;
        let decision;

        // Log.log('Quotes: ', this.quotes);

        Log.log('niftyQuote.prevClose: ', niftyQuote.prevClose);
        Log.log('Quotes Length: ', this.quotes.length);
        Log.log('isOpenGreaterThanPrevious: ', isOpenGreaterThanPrevious);
        Log.log('isCurrentPriceGreaterThanOpenPrice: ', isCurrentPriceGreaterThanOpenPrice);
        Log.log('isTrendHigh: ', isTrendHigh);

        // Find trend on following too
        // changeFromLow
        // changeFromHigh
        // OpenDifference
        // ChangeFromOpen

        if (isOpenGreaterThanPrevious && isCurrentPriceGreaterThanOpenPrice && isTrendHigh) {
            decision = CALL;
        }

        // const isOpenLesserThanPrevious = niftyQuote.open < niftyQuote.prevClose;
        // const isCurrentPriceLesserThanOpenPrice = niftyQuote.ltp < niftyQuote.open;
        // const isTrendLow = niftyQuote.ltp < this.quotes[0];

        // if (isOpenLesserThanPrevious && isCurrentPriceLesserThanOpenPrice && isTrendLow) {
        //     decision = PUT;
        // }

        if (decision === CALL || decision === PUT) {
            Log.log('[Auto] Buy ', decision);
            this._processOrder(niftyQuote, decision, "decideBasedOnCurrentState");
        }

    }

    _readQuotesAsStream = async () => {
        // Log.log('Hello')
        // const x = new Date(1689654092 * 1000);

        // Log.log(x.toString());
        // Log.log(x.getDate());

        const stream = Mongo.getInstance().getAll('NiftyQuote');
        stream.on('error', function (err) {
            // console.error(err)
        })
        stream.on('data', (quote) => {
            // stream.pause();
            this.decidePurchase(quote);
            // stream.resume();
        })
        stream.on('end', () => {
            candleManager.print();
        })

    }

    results = [];
    realtimePrices = [];

    _round = (num) => Math.round(num * 100) / 100;

    eventEmitter = new EventEmitter();
    intervals = [300];  // 5-min only — matches pipeline --interval 300
    startTimes = [];
    priceStorage = {};
    pricePoints = []
    candlesMap = new Map<String, Candle[]>();
    enrichedCandlesMap = new Map<String, Candle[]>();

    startCounts = [];

    _mockEmitPrice(price, time) {
        const pricePoint = new PricePoint(time, price)
        this.pricePoints.push(pricePoint)

        if (this.startCounts.length == 0) {
            var i = 0;
            this.intervals.forEach(interval => {
                this.startCounts[i++] = 0;
                const eventName = `priceUpdate_${interval}`;
                this.priceStorage[eventName] = [];
            })
            this._registerEventHandlers();
        }

        var i = 0;
        this.intervals.forEach((interval) => {
            const eventName = `priceUpdate_${interval}`;
            this.priceStorage[eventName].push(price)
            this.startCounts[i]++;
            if (this.startCounts[i] >= interval * 2) {
                this.eventEmitter.emit(eventName, pricePoint);
                this.startCounts[i] = 0;
            }
            i++;
        });
    }

    _emitPrice(price, time) {
        if (SIMULATION) {
            this._mockEmitPrice(price, time);
            return;
        }

        const pricePoint = new PricePoint(time, price)
        this.pricePoints.push(pricePoint)

        // const intervals = [10, 15, 30, 45, 60, 120, 300, 600, 900]; // 30s, 1m, 2m, 5m, 10m, 15m, 30m
        
        if (this.startTimes.length == 0) {
            var i = 0;
            this.intervals.forEach(interval => {
                // Start at first tick's actual time (matches Python CandleBuilder: start_time = ltt[0])
                this.startTimes[i++] = time;
                const eventName = `priceUpdate_${interval}`;
                this.priceStorage[eventName] = [];
            })
            this._registerEventHandlers();
        }

        var i = 0;
        this.intervals.forEach((interval) => {
            const diff = time - this.startTimes[i];
            const eventName = `priceUpdate_${interval}`;
            // Push FIRST (matches Python: bucket_prices.append(ltp[i]) before boundary check)
            this.priceStorage[eventName].push(price)
            // Require >= 2 prices (matches Python: len(bucket_prices) >= 2)
            if (diff >= interval && this.priceStorage[eventName].length >= 2) {
                this.eventEmitter.emit(eventName, pricePoint);
                // Advance to current tick (matches Python: start_time = ltt[i])
                this.startTimes[i] = time;
            }
            i++;
        });    
    }


    _registerEventHandlers = () => {

        this.eventEmitter.on('stats', async (stats) => {
            if (this.replayMode) return;
            for (const strategy of strategies.getList()) {
                await strategy.receive(stats.oldStats, stats.newStats);
            }
        });
        // const intervals = [10, 15, 30, 45, 60, 120, 300, 600, 900]; // 30s, 1m, 2m, 5m, 10m, 15m, 30m

        this.intervals.forEach((interval) => {
            const eventName = `priceUpdate_${interval}`;
            Log.log('Register eventName ', eventName)
            this.candlesMap.set(eventName, [])
            this.enrichedCandlesMap.set(eventName, [])
            this.eventEmitter.on(eventName, (pricePoint) => {
                Log.log('Handle ', eventName)
                const chunk = this.priceStorage[eventName];

                // Build candle using shared lib (matches Python CandleBuilder._build_interval)
                const candleData = buildCandle(chunk, pricePoint.time);
                const candle: Candle = {
                    eventName,
                    time: pricePoint.time,
                    open: candleData.open,
                    close: candleData.close,
                    high: candleData.high,
                    low: candleData.low,
                    average: candleData.average,
                    median: candleData.median,
                    stdDeviation: candleData.stddev,
                    mad: candleData.mad,
                    S1: candleData.S1,
                    R1: candleData.R1,
                    S2: candleData.S2,
                    R2: candleData.R2,
                };

                const candles = this.candlesMap.get(eventName);
                candles.push(candle);


                // Compute indicators and emit PeriodicStats for strategies
                this._computeAndEmitStats(eventName, chunk);

                // Build enriched candles for legacy consumers
                const indicators = this._buildIndicatorResults(eventName);
                if (indicators.length > 0) {
                    const enrichedCandle = indicators.map(indicator => ({
                        ...indicator,
                        ...candle,
                        'eventName': `${candle.eventName}_${indicator.method}`
                    }));
                    const enrichedCandles = this.enrichedCandlesMap.get(eventName);
                    enrichedCandles.push(...enrichedCandle);
                }

                this.priceStorage[eventName] = [];
            });
        });
    }

    _getDate = () => {
        const currentTime = new Date();
        const hours = String(currentTime.getHours()).padStart(2, '0');
        const minutes = String(currentTime.getMinutes()).padStart(2, '0');
        const seconds = String(currentTime.getSeconds()).padStart(2, '0');
        
        return `${hours}:${minutes}:${seconds}`;
        
    }

    _formatDate = (time) => {
        const hours = String(time.getHours()).padStart(2, '0');
        const minutes = String(time.getMinutes()).padStart(2, '0');
        const seconds = String(time.getSeconds()).padStart(2, '0');
        
        return `${hours}:${minutes}:${seconds}`;
        
    }

    _addPrice = (ltt, number) => {
        // Log.log('Add Price ', this._getDate(), ' ', number)
        //TODO **************** Nan123@12
        // emit price to calculate real time\c
        this._emitPrice(number, ltt);
        // if (number != null) {
        //     this._calculateStatistics(this.prices);
        //     this.prices = [];
        // }
        
        // if (this.prices.length > 300) {
        //     this.realtimePrices.push(number);

        //     const trend = this._determineTrend(this.prices)
        //     var shortPeriod = 24, longPeriod = 52, signalPeriod = 18;
        //     const macd = this._calculateMACDTrend(this.prices, shortPeriod, longPeriod, signalPeriod)
            
        //     var period = 14, overbought = 70, oversold = 30
        //     const rsi = this._calculateRSITrend(this.prices, period, overbought, oversold)
        //     var period = 20, numDeviations = 2
        //     const bollinger = this._calculateBollingerBandsTrend(this.prices, period, numDeviations);
        //     const realtimeTrend = new RealTimeTrend(ltt, number, trend, macd, rsi, bollinger);
        //     Log.log("Realtime Trend: ", JSON.stringify(realtimeTrend));
    
        // }

        // Mongo.getInstance().insert(realtimeTrend);
      }

      supportPrice = -1;
      resistantPrice = -1;
      previousWindowTrend = 'NEUTRAL'
      stats = null;

      
    /** Compute all indicators and emit PeriodicStats for strategies. Replaces _calculateStatistics. */
    _computeAndEmitStats = (eventName: string, chunk: number[]) => {
        const candles = this.candlesMap.get(eventName) || [];
        const prices  = candles.map(c => c.close);

        const open         = chunk[0];
        const close        = chunk[chunk.length - 1];
        const high         = Math.max(...chunk);
        const low          = Math.min(...chunk);
        const average      = this._round(stats.mean(chunk));
        const median       = this._round(stats.median(chunk));
        const stdDeviation = this._round(stats.stdev(chunk));
        const mad          = candles.length > 0 ? candles[candles.length - 1].mad : 0;
        const trend        = this._determineTrend(prices);

        const highs  = candles.map(c => c.high);
        const lows   = candles.map(c => c.low);

        const rsiResults       = RSI_PARAMS.map(p => calcRSI(prices, p.period, p.overbought, p.oversold)).filter(Boolean);
        const intervalSec = eventName.replace('priceUpdate_', '');
        const rsi_5_90_10 = rsiResults.find(r => r.header === 'RSI_5_90_10');
        if (rsi_5_90_10) {
            Log.log(`[Signal] ${intervalSec}s close=${close} RSI_5_90_10=${rsi_5_90_10.trend}`);
        }

        const macdResults      = MACD_PARAMS.map(p => calcMACD(prices, p.shortPeriod, p.longPeriod, p.signalPeriod)).filter(Boolean);
        const bollingerResults = BOLLINGER_PARAMS.map(p => calcBollinger(prices, p.period, p.numDeviations)).filter(Boolean);
        const emaResults       = EMA_PARAMS.map(p => calcEMACrossover(prices, p.shortPeriod, p.longPeriod)).filter(Boolean);
        const adxResults       = ADX_PARAMS.map(p => calcADX(highs, lows, prices, p.period)).filter(Boolean);
        const stochasticResults = STOCHASTIC_PARAMS.map(p => calcStochastic(highs, lows, prices, p.kPeriod, p.dPeriod)).filter(Boolean);

        const pivotResults = { S1: candles.length > 0 ? candles[candles.length - 1].S1 : 0,
                               R1: candles.length > 0 ? candles[candles.length - 1].R1 : 0,
                               S2: candles.length > 0 ? candles[candles.length - 1].S2 : 0,
                               R2: candles.length > 0 ? candles[candles.length - 1].R2 : 0 };

        this.supportPrice = pivotResults.S1;
        this.resistantPrice = pivotResults.R1;
        this.previousWindowTrend = close > open ? 'UP' : 'DOWN';

        const results = { eventName, macd: macdResults, rsi: rsiResults, bollinger: bollingerResults, ema: emaResults, adx: adxResults, stochastic: stochasticResults, pivot: pivotResults };
        const periodicStats = new PeriodicStats(open, high, low, close, average, median, stdDeviation, mad, trend, results);

        this.eventEmitter.emit('stats', { oldStats: this.stats, newStats: periodicStats });
        this.stats = periodicStats;
    }

    /** Build {method, trend} array for enriched candles. Replaces _useCandles. */
    _buildIndicatorResults = (eventName: string): Array<{ method: string; trend: string }> => {
        const candles = this.candlesMap.get(eventName) || [];
        const closes  = candles.map(c => c.close);
        const results: Array<{ method: string; trend: string }> = [];

        RSI_PARAMS.forEach(p => { const r = calcRSI(closes, p.period, p.overbought, p.oversold); if (r) results.push({ method: r.header, trend: r.trend }); });
        MACD_PARAMS.forEach(p => { const r = calcMACD(closes, p.shortPeriod, p.longPeriod, p.signalPeriod); if (r) results.push({ method: r.header, trend: r.trend }); });
        BOLLINGER_PARAMS.forEach(p => { const r = calcBollinger(closes, p.period, p.numDeviations); if (r) results.push({ method: r.header, trend: r.trend }); });
        EMA_PARAMS.forEach(p => { const r = calcEMACrossover(closes, p.shortPeriod, p.longPeriod); if (r) results.push({ method: r.header, trend: r.trend }); });

        return results;
    }

    /** Force-emit remaining price buckets as trailing candles (matches buildCandles line 119-121). */
    flushCandles = () => {
        if (this.pricePoints.length === 0) return;
        const lastPoint = this.pricePoints[this.pricePoints.length - 1];
        this.intervals.forEach((interval) => {
            const eventName = `priceUpdate_${interval}`;
            const remaining = this.priceStorage[eventName];
            if (remaining && remaining.length > 0) {
                this.eventEmitter.emit(eventName, lastPoint);
            }
        });
    }

    _appendJsonToFile = (filePath: string, jsonData: object): void => {
        const values = Object.values(jsonData);
        const csvLine = values.join(',') + '\n';
        fs.appendFile(filePath, csvLine, (err) => {
            if (err) console.error('Error appending to file:', err);
        });
    }

    _determineTrend(prices) {
        const data = prices.map((price, index) => [index, price]);
        const result = regression.linear(data);
        const slope = result.equation[0];
        if (slope > 0) return 'Up';
        if (slope < 0) return 'Down';
        return 'Sideways';
    }

// (async () => {
//     Log.log("Immediately invoked function - calling init ")
//     await Mongo.init();
//     Decision.getInstance();
// })();
    }