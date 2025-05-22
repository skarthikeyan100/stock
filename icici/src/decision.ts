// Strategy:
// If direction is sure, go for option else go for option plus

import * as fs from 'fs';
import axios, { AxiosRequestConfig } from 'axios'
import { RestAPI, WebSocket } from '@quantiply/finvasia-nodejs-sdk';
import NorenRestApi from './prism/RestAPI'
import _ from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, PeriodicStats, RealTimeTrend, Trade } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Mongo from './tools/mongo'
import Prism from './prism';
import Util from './util';
import indexMap from './nse_index';
import { NIFTY, SIMULATION } from './constants'
import candleManager, { CandleType } from './candle';
import { Strategy, Outcome } from './strategy/strategy';
import { ORBPrevious } from './strategy/ORBPrevious';
import stats from 'stats-lite';
import regression from 'regression';
import { EMA, RSI } from 'technicalindicators'; 
import EventEmitter from 'events';
import executeGap from './executeGap'
import { OnTrigger } from './onTrigger';
import moment from 'moment';
import Monitor from 'monitor';
import * as f from './orderList'
import PivotStrategy from './strategy/PivotStrategy';
import BiDirectionStrategy from './strategy/BiDirectionStrategy';
import DiffStrategy from './strategy/DiffStrategy';

const CALL = 'call';
const PUT = 'put';
const BUY = 'Buy';
const SELL = 'Sell';

export default class Decision {
    historyLen = 5;
    profit = 3000;
    quotes = [];
    static instance: Decision;
    depth = 2;
    onTrigger: OnTrigger;
    strategies: Array<Strategy> = [
        new PivotStrategy(),
        new DiffStrategy(),
        new BiDirectionStrategy()
    ];

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
        console.log("setOnTrigger is called")
        this.onTrigger = new OnTrigger();
        this.onTrigger.setTrigger(contract, triggerPrice)
    }

    decidePurchaseStockOption = async (quote: OptionQuote) => {
        if (this.onTrigger) {
            this.onTrigger.process(quote);
        }
    }

    decidePurchase = async (quote: NiftyQuote) => {
        executeGap.process(quote);
        
        
        if (!SIMULATION) {
            this._storeHistory(quote);
            this._addPrice(quote.ltt, quote.ltp)

            for (const strategy of this.strategies) {
                strategy.process(quote);
            }


            //Strategy: If diff > 5, buy CALL. If diff < 5, buy PUT with no stop loss

        }

        // this.quotes.push(niftyQuote);
        // console.log('Pushing ', niftyQuote);
        // console.log('this.quotes before shift ', this.quotes.length);
        // if (this.quotes.length == this.historyLen + 1) {
        //     this.quotes.shift();
        //     console.log('After shift ', this.quotes.length);
        // }

        // this._formCandle(quote);
        // for (const strategy of this.strategies) {
        //     const outcome = strategy.process(quote, quote.token);
        //     console.log('Outcome: ', outcome.toString())
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
        for (const strategy of this.strategies) {
            const trade = strategy.tradeMap.get(optionQuote.token) as Trade;
            if (trade) {
                console.log('Trade: ', trade.right, ' qty: ', trade.quantity, ' profit: ', trade.getProfit());
                if (trade.getProfit() > this.profit) {
                    console.log('[Auto] Sell ', trade);
                    trade.action = SELL;
                    prism.squareOffOrder(trade.token, trade.quantity);
                    Mongo.getInstance().insert(trade);
                    strategy.tradeMap.delete(optionQuote.token);
                }
            }
        }
    };

    _storeHistory = async (quoteParam: NiftyQuote) => {
        const quote = new NiftyQuote(quoteParam);
        Mongo.getInstance().insert(quote);
    }

    _processOrder = async (quote: NiftyQuote, right: string, strategy: string) => {

        const prism = Prism.getInstance();
        const niftyPrice = quote.ltp;
        // var expiryDate = Util.findExpiryDate();
        var expiryDate = Util.findExpiryDate();
        // console.log('niftyPrice: ', niftyPrice, 'this.depth: ', this.depth, 'right: ', right);
        //TODO only nifty is considered for now
        const index = indexMap.get(NIFTY);
        const token = await index.findToken(NIFTY, this.depth, right, quote.ltp);

        // let quote: NiftyQuote;
        // quote = await prism.getOptionQuote(token);

        const trade = await prism.sendLimitOrder(token, quote.ltp, right as string, BUY, strategy);
        Mongo.getInstance().insert(trade);
        return trade;
    }

    _decideBasedOnCurrentState = (niftyQuote: NiftyQuote): String | void => {
        //TODO  time should be greater than 10
        // console.log(niftyQuote);
        const isOpenGreaterThanPrevious = true; //niftyQuote.open > niftyQuote.prevClose;
        const isCurrentPriceGreaterThanOpenPrice = niftyQuote.ltp > niftyQuote.open;
        const isTrendHigh = niftyQuote.ltp > this.quotes[0].ltp;
        let decision;

        // console.log('Quotes: ', this.quotes);

        console.log('niftyQuote.prevClose: ', niftyQuote.prevClose);
        console.log('Quotes Length: ', this.quotes.length);
        console.log('isOpenGreaterThanPrevious: ', isOpenGreaterThanPrevious);
        console.log('isCurrentPriceGreaterThanOpenPrice: ', isCurrentPriceGreaterThanOpenPrice);
        console.log('isTrendHigh: ', isTrendHigh);

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
            console.log('[Auto] Buy ', decision);
            this._processOrder(niftyQuote, decision, "decideBasedOnCurrentState");
        }

    }

    _readQuotesAsStream = async () => {
        // console.log('Hello')
        // const x = new Date(1689654092 * 1000);

        // console.log(x.toString());
        // console.log(x.getDate());

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
    startTimes = [];
    _emitPrice(price) {
        // console.log("Price: " + price + " Time: " + Date.now());

        const intervals = [10, 15, 30, 45, 60, 120, 300, 600, 900]; // 30s, 1m, 2m, 5m, 10m, 15m, 30m
        if (this.startTimes.length == 0) {
            const time = Date.now();
            var i = 0;
            intervals.forEach(interval => {
                this.startTimes[i++] = time;
                const eventName = `priceUpdate_${interval}`;
                this.priceStorage[eventName] = [];
            })
            this._registerEventHandlers();
        }
        
        var i = 0;
        intervals.forEach((interval) => {
            const diff = Date.now() - this.startTimes[i];
            const eventName = `priceUpdate_${interval}`;
            this.priceStorage[eventName].push(price)
            if ((diff / 1000) >= interval) {
                this.eventEmitter.emit(eventName, price);
                this.startTimes[i] = Date.now();
            }
            i++;
        });    
    }

    priceStorage = {};

    _registerEventHandlers = () => {

        this.eventEmitter.on('stats', (stats) => {
            console.log('Received stats ', stats)
            for (const strategy of this.strategies) {
                strategy.receive(stats.oldStats, stats.newStats);
            }
        });
        // const intervals = [10, 15, 30, 45, 60, 120, 300, 600, 900]; // 30s, 1m, 2m, 5m, 10m, 15m, 30m
        const intervals = [60, 300]; // 10s

        intervals.forEach((interval) => {
            const eventName = `priceUpdate_${interval}`;
            console.log('Register eventName ', eventName)
            this.eventEmitter.on(eventName, (price) => {
                // console.log(`Process event ${eventName} with price ${price} at ${moment().format("HH:mm:ss")}`);
                // console.log(`Stored: ${this.priceStorage[eventName]}`);
                console.log(`Process ${eventName}`)
                this._calculateStatistics(eventName, this.priceStorage[eventName]);
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
    _addPrice = (ltt, number) => {
        const time = new Date().setTime(ltt).toLocaleString();
        // console.log('Add Price ', this._getDate(), ' ', number)
        this._emitPrice(number);
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
        //     console.log("Realtime Trend: ", JSON.stringify(realtimeTrend));
    
        // }

        // Mongo.getInstance().insert(realtimeTrend);
      }

      supportPrice = -1;
      resistantPrice = -1;
      previousWindowTrend = 'NEUTRAL'
      stats = null;

    _calculateStatistics = (eventName, chunk) => {
        const prices = this.priceStorage[eventName];

            const open = chunk[0];
            const close = chunk[chunk.length - 1];
            const high = Math.max(...chunk);
            const low = Math.min(...chunk);
            const average = this._round(stats.mean(chunk));
            const median = this._round(stats.median(chunk));
            const stdDeviation = this._round(stats.stdev(chunk));
            const trend = this._determineTrend(prices)

            const macdPeriods = [
                { shortPeriod: 4, longPeriod: 8, signalPeriod: 3 },
                { shortPeriod: 8, longPeriod: 16, signalPeriod: 6 },
                { shortPeriod: 12, longPeriod: 24, signalPeriod: 9 },
                { shortPeriod: 16, longPeriod: 32, signalPeriod: 12 },
                { shortPeriod: 20, longPeriod: 40, signalPeriod: 15 },
                { shortPeriod: 24, longPeriod: 48, signalPeriod: 18 }
            ]

            const macdResults = [];
            macdPeriods.forEach (macd => {
                var result = this._calculateMACDTrend(prices, macd.shortPeriod, macd.longPeriod, macd.signalPeriod)
                if (result != null) {
                    macdResults.push(result);
                }
                
            })

            const rsiVariables = [
                { period: 5, overbought: 70, oversold: 30 },
                { period: 5, overbought: 80, oversold: 20 },
                { period: 5, overbought: 90, oversold: 10 },
                { period: 10, overbought: 70, oversold: 30 },
                { period: 10, overbought: 80, oversold: 20 },
                { period: 10, overbought: 90, oversold: 10 },
                { period: 15, overbought: 70, oversold: 30 },
                { period: 15, overbought: 80, oversold: 20 },
                { period: 15, overbought: 90, oversold: 10 },
                { period: 20, overbought: 70, oversold: 30 },
                { period: 20, overbought: 80, oversold: 20 },
                { period: 20, overbought: 90, oversold: 10 },
                { period: 25, overbought: 70, oversold: 30 },
                { period: 25, overbought: 80, oversold: 20 },
                { period: 25, overbought: 90, oversold: 10 },
                { period: 30, overbought: 70, oversold: 30 },
                { period: 30, overbought: 80, oversold: 20 },
                { period: 30, overbought: 90, oversold: 10 },

            ]

            const rsiResults = [];
            rsiVariables.forEach (rsi => {
                var result = this._calculateRSITrend(prices, rsi.period, rsi.overbought, rsi.oversold)
                if (result != null) {
                    rsiResults.push(result);
                }
            })
            
            const bollingerVariables = [
                { period: 5, numDeviations: 2},
                { period: 5, numDeviations: 1.5},
                { period: 5, numDeviations: 1},
                { period: 10, numDeviations: 2},
                { period: 10, numDeviations: 1.5},
                { period: 10, numDeviations: 1},
                { period: 15, numDeviations: 2},
                { period: 15, numDeviations: 1.5},
                { period: 15, numDeviations: 1},
                { period: 20, numDeviations: 2},
                { period: 20, numDeviations: 1.5},
                { period: 20, numDeviations: 1},
                { period: 25, numDeviations: 2},
                { period: 25, numDeviations: 1.5},
                { period: 25, numDeviations: 1},
                { period: 30, numDeviations: 2},
                { period: 30, numDeviations: 1.5},
                { period: 30, numDeviations: 1},

            ]

            const bollingerResults = [];
            bollingerVariables.forEach (bollinger => {
                var result = this._calculateBollingerBandsTrend(prices, bollinger.period, bollinger.numDeviations)
                if (result != null) {
                    bollingerResults.push(result);
                }
            })

            const emaCrossoverVariables = [
                { shortPeriod: 9, longPeriod: 21},
                { shortPeriod: 12, longPeriod: 28},
                { shortPeriod: 15, longPeriod: 35},
                { shortPeriod: 18, longPeriod: 42},
                { shortPeriod: 21, longPeriod: 49},
                { shortPeriod: 24, longPeriod: 56},
                { shortPeriod: 27, longPeriod: 63},
                { shortPeriod: 30, longPeriod: 70},

            ]

            const emaCrossoverResults = [];
            emaCrossoverVariables.forEach (ema => {
                var trend = this._detectEMATrend(prices, ema.shortPeriod, ema.longPeriod) 
                if (trend != null) {
                    var result = { 
                        shortPeriod: ema.shortPeriod, 
                        longPeriod: ema.longPeriod,
                        trend 
                    } 
                    emaCrossoverResults.push(result);
                }
            })

            const pivotResults = this._calculateSupportResistance({open, close, high, low});
            var t = {eventName, open, close, high, low, ...pivotResults, stdDeviation}

            this.supportPrice = t.S1
            this.resistantPrice = t.R1
            this.previousWindowTrend = close > open ? 'UP' : 'DOWN'

            var results = {
                eventName,
                macd: macdResults,
                rsi: rsiResults,
                bollinger: bollingerResults,
                ema: emaCrossoverResults,
                pivot: pivotResults
            }

            console.log('Support Price: ', this.supportPrice, ' Resistance Price: ', this.resistantPrice);

            // this.results.push({ open, high, low, close, average, median, stdDeviation, trend, macd, rsi, bollinger });
            const periodicStats = new PeriodicStats(open, high, low, close, average, median, stdDeviation, trend, 
                results);
            

            this.eventEmitter.emit('stats', { oldStats: this.stats, newStats: periodicStats});
            this.stats = periodicStats;
            
            Mongo.getInstance().insert(periodicStats);
            this._appendJsonToFile('temp.json', t);

    }

    _appendJsonToFile = (filePath: string, jsonData: object): void => {
        const values = Object.values(jsonData);
        const csvLine = values.join(',') + '\n';
    
        fs.appendFile(filePath, csvLine, (err) => {
            if (err) {
                console.error('Error appending to file:', err);
            } else {
                // console.log('Data appended successfully!');
            }
        });
    }

    
    _determineTrend(prices) {
      
        const data = prices.map((price, index) => [index, price]);
        const result = regression.linear(data);
        const slope = result.equation[0];
      
        if (slope > 0) {
          return 'Up';
        } else if (slope < 0) {
          return 'Down';
        } else {
          return 'Sideways';
        }
      }

    _detectEMATrend(prices1: number[], shortPeriod: number, longPeriod: number) {
        if (prices1.length < longPeriod) {
            return;
        }
        const prices = prices1.slice(-longPeriod);

        const shortEMA = EMA.calculate({ period: shortPeriod, values: prices });
        const longEMA = EMA.calculate({ period: longPeriod, values: prices });
    
        let trend = "NEUTRAL";
    
        for (let i = 1; i < prices.length; i++) {
            if (shortEMA[i - 1] <= longEMA[i - 1] && shortEMA[i] > longEMA[i]) {
                trend = "UP";
                break;
            } else if (shortEMA[i - 1] >= longEMA[i - 1] && shortEMA[i] < longEMA[i]) {
                trend = "DOWN";
                break;
            }
        }
    
        return {
            shortPeriod,
            longPeriod,
            trend
        }
    }

      _calculateMACDTrend = (prices1, shortPeriod, longPeriod, signalPeriod) => {
        var totalLength = signalPeriod + longPeriod;
        if (prices1.length < totalLength) {
            return;
        }
        try {
            const prices = prices1.slice(-totalLength);
      
            const shortEMA = EMA.calculate({ period: shortPeriod, values: prices });
    
            const longEMA = EMA.calculate({ period: longPeriod, values: prices });
          
            const macdLine = shortEMA.slice(longPeriod - shortPeriod).map((value, index) => value - longEMA[index]);
            const signalLine = EMA.calculate({ period: signalPeriod, values: macdLine });
          
            const latestShortEMA = this._round(shortEMA[shortEMA.length-1]);
            const latestLongEMA = this._round(shortEMA[longEMA.length-1]);
            const latestMACD = this._round(macdLine[macdLine.length - 1]);
            const latestSignal = this._round(signalLine[signalLine.length - 1]);
            const trend = latestMACD > latestSignal ? 'UP' : 'DOWN'
          
            return {
                shortPeriod,
                longPeriod,
                signalPeriod,
                latestShortEMA,
                latestLongEMA,
                latestMACD,
                latestSignal,
                trend
            }
    
        } catch (e) {
            console.log("ERROR: ", e)
        }
      }

      _calculateRSITrend = (prices1, period, overbought, oversold) => {
        if (prices1.length < period) {
            return;
        }
        const prices = prices1.slice(-prices1);
        
        const rsiValues = RSI.calculate({ period, values: prices });
        const latestRSI = rsiValues[rsiValues.length - 1];
        
        var trend = 'NEUTRAL';
        if (latestRSI > overbought) {
            trend = 'DOWN'; // Overbought
        } else if (latestRSI < oversold) {
            trend = 'UP'; // Oversold
        }
        return {
            period,
            overbought,
            oversold,
            latestRSI,
            trend
        }
      }

      _calculateBollingerBandsTrend(prices1, period, numDeviations) {
    
        if (prices1.length < period) {
            return;
        }
        
        const prices = prices1.slice(-period);

        // Calculate Simple Moving Average (SMA)
        const sma = prices.reduce((sum, price) => sum + price, 0) / period;
    
        // Calculate Standard Deviation
        const variance = prices.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
        const stdDev = this._round(Math.sqrt(variance));
    
        // Calculate Bollinger Bands
        const middleBand = this._round(sma);
        const upperBand = this._round(sma + (stdDev * numDeviations));
        const lowerBand = this._round(sma - (stdDev * numDeviations));
    
        // Calculate trend
        const trend = prices[prices.length - 1] > upperBand ? 'UP' : (prices[prices.length - 1] < lowerBand ? 'DOWN' : 'NEUTRAL');
    
        return {
            period,
            numDeviations,
            stdDev,
            upperBand,
            middleBand,
            lowerBand,
            trend
        }
    }

    _calculateSupportResistance = (ohlc) => {
        const { open, high, low, close } = ohlc;
    
        // Pivot Point (P)
        const P = (high + low + close) / 3;
    
        // Support and Resistance Levels
        const S1 = (2 * P) - high;
        const R1 = (2 * P) - low;
        const S2 = P - (high - low);
        const R2 = P + (high - low);
    
        return {
            S1: parseFloat(S1.toFixed(2)),
            R1: parseFloat(R1.toFixed(2)),
            S2: parseFloat(S2.toFixed(2)),
            R2: parseFloat(R2.toFixed(2))
        };
    }

// (async () => {
//     console.log("Immediately invoked function - calling init ")
//     await Mongo.init();
//     Decision.getInstance();
// })();
    }