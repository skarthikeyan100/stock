import csv from 'csv-parser';
import { sma, ema, bollingerbands, sd } from 'technicalindicators'
import moment from 'moment'
import fs from 'fs';
import { Parser } from 'json2csv';
import { Candle } from './scheduler';
import { Signal } from '../tools/process_signal';
import { getDefaultService } from 'selenium-webdriver/chrome';
import Mongo from '../tools/mongo';
import { Client } from '../communication/client';
import * as constants from '../constants'
import Icici from '../trade/icici';
import { throwStatement } from '@babel/types';
import delay from 'delay';
import { VirtualTrade, Trade } from '../tools/virtual_trade';
import * as f from '../functions'
var dataArray = [];
const oldFields = ['Close'];
const highOpen = 'High-Open';
const change = 'Prev-Open';
const changePercent = 'Change%';
const openLow = 'Open-Low';
const trend = 'Trend'
const suggestedSellPrice = 'SuggestedSellPrice'
const prediction = 'Prediction'

const BUY = 'Buy'
const SELL = 'Sell'

const SMA5_SIGNAL = "sma5"
const SMA20_SIGNAL = "sma20"
const BB1SD_SIGNAL = "bb1sd"
const BB2SD_SIGNAL = "bb2sd"
const BB3SD_SIGNAL = "bb3sd"
const STOCHASTIC_SIGNAL = "stochastic"
const COMBINATION_SIGNAL = "combination"
const PERCENT_SIGNAL = "percent"
const tag1SDField = 'Tag 1 SD'
const tag2SDField = 'Tag 2 SD'
const stochasticField = 'Stochastic'
const sma5Field = 'SMA 5'
const sma20Field = 'SMA 20'
const combinationField = 'Combination'



class TradeSignal {
    strategy
    action
    price
    symbol
    strikePrice

    constructor(type, strikePrice, strategy, action, price) {
        this.strategy = strategy
        this.action = action
        this.price = price
        this.symbol = type
        this.strikePrice = strikePrice
    }
}

class QuoteData {
    type
    price
    date
    time
    sma5
    sma20
    bb1sd
    bb2sd
    stochastic
    Combination
}


export class Processor {

    period20 = 20
    period5 = 5
    quoteData

    //Bollinger Band
    stdDev1 = 1
    stdDev2 = 2
    stdDev3 = 2.5

    // Stochastic Oscillator

    signal = new Signal()

    priceArray20: number[] = []
    priceArray5: number[] = []

    symbol
    strikePrice

    //Percent calculation
    sampleCount
    changeValue
    profitPercent
    samplePriceArray = []
    tempCount // Only to find nth transaction for the lack of time
    lastPrice

    constructor({ type = constants.NIFTY, strikePrice = null }) {
        this.symbol = type
        this.strikePrice = strikePrice
        this.tempCount = 0
    }

    updateArray20 = (array, number) => {
        array.push(parseFloat(number))
        if (array.length > this.period20) {
            array.shift()
        }
    }

    updateArray5 = (array, number) => {
        array.push(parseFloat(number))
        if (array.length > this.period5) {
            array.shift()
        }
    }

    updateArray = (array, number, sampleCount) => {
        array.push(parseFloat(number))
        if (array.length > sampleCount) {
            array.shift()
        }
    }

    vt = new VirtualTrade()

    sendTradeSignal = (strategy, action, price) => {
        const signal = new TradeSignal(this.symbol, this.strikePrice, strategy, action, price)
        console.log('Signal ', signal)
        this.vt.addTrade(strategy, action, this.symbol, this.strikePrice, price)

        const client = new Client(6000)
        client.sendMessage(signal)

        switch (strategy) {
            case SMA5_SIGNAL: this.quoteData.sma5 = action; break;
            case SMA20_SIGNAL: this.quoteData.sma20 = action; break;
            case BB1SD_SIGNAL: this.quoteData.bb1sd = action; break;
            case BB2SD_SIGNAL: this.quoteData.bb2sd = action; break;
            case BB3SD_SIGNAL: this.quoteData.bb3sd = action; break;
            case STOCHASTIC_SIGNAL: this.quoteData.stochastic = action; break;
            case COMBINATION_SIGNAL: this.quoteData.combination = action; break;
        }
    }

    sma5(price) {
        if (this.priceArray5.length >= this.period5) {
            const sma5 = this.signal.sma(price, this.period5, this.priceArray5)
            if (sma5) {
                if (sma5 == BUY) {
                    this.sendTradeSignal(SMA5_SIGNAL, BUY, price)
                } else {
                    this.quoteData.sma5 = SELL
                    this.sendTradeSignal(SMA5_SIGNAL, SELL, price)
                }
            }
        }
    }

    tag1sd(price) {
        const tag1SD = this.signal.bollingerbands(price, this.period20, this.stdDev1, this.priceArray20)
        if (tag1SD) {
            if (tag1SD == 'tagUpper') {
                this.sendTradeSignal(BB1SD_SIGNAL, SELL, price)
            } else if (tag1SD == 'tagLower') {
                this.sendTradeSignal(BB1SD_SIGNAL, BUY, price)
            }
        }
        return tag1SD
    }

    tag2sd(price) {
        const tag2SD = this.signal.bollingerbands(price, this.period20, this.stdDev2, this.priceArray20)
        if (tag2SD) {
            if (tag2SD == 'tagUpper') {
                this.sendTradeSignal(BB2SD_SIGNAL, SELL, price)
            } else if (tag2SD == 'tagLower') {
                this.sendTradeSignal(BB2SD_SIGNAL, BUY, price)
            }
        }
    }

    tag3sd(price) {
        const tag3SD = this.signal.bollingerbands(price, this.period20, this.stdDev3, this.priceArray20)
        if (tag3SD) {
            if (tag3SD == 'tagUpper') {
                this.sendTradeSignal(BB3SD_SIGNAL, SELL, price)
            } else if (tag3SD == 'tagLower') {
                this.sendTradeSignal(BB3SD_SIGNAL, BUY, price)
            }
        }
    }

    stochastic(price) {
        const stochastic = this.signal.stochastic(price)
        if (stochastic) {
            if (stochastic == BUY) {
                this.sendTradeSignal(STOCHASTIC_SIGNAL, BUY, price)
            } else {
                this.sendTradeSignal(STOCHASTIC_SIGNAL, SELL, price)
            }
        }
        return stochastic
    }

    sma20(price) {
        const sma20 = this.signal.sma(price, this.period20, this.priceArray20)
        if (sma20) {
            if (sma20 == BUY) {
                this.sendTradeSignal(SMA20_SIGNAL, BUY, price)
            } else {
                this.sendTradeSignal(SMA20_SIGNAL, SELL, price)
            }
        }
    }

    percent(price) {

        this.updateArray(this.samplePriceArray, price, this.sampleCount)
        const first = this.samplePriceArray[0]
        const last = this.samplePriceArray[this.sampleCount - 1]

        if (this.samplePriceArray.length == this.sampleCount) {
            // let change = ((last - first) / first) * 100

            let change = last - first
            change = Number(change.toFixed(2))

            let openTrade = this.vt.isOpen(PERCENT_SIGNAL)
            if (openTrade != null && openTrade != undefined) {
                // console.log('In Open Trade Action ', openTrade.action, 'Traded price ', openTrade.price)

                //Square off
                if (openTrade.action == BUY) {
                    if (price - openTrade.price > this.profitPercent) {
                        this.sendTradeSignal(PERCENT_SIGNAL, SELL, price)
                    }
                }

                if (openTrade.action == SELL) {
                    if (openTrade.price - price > this.profitPercent) {
                        this.sendTradeSignal(PERCENT_SIGNAL, BUY, price)
                    }
                }

                if (openTrade.action == BUY) {
                    if (openTrade.price - price > this.profitPercent) {
                        this.sendTradeSignal(PERCENT_SIGNAL, SELL, price)
                    }
                }

                if (openTrade.action == SELL) {
                    if (price - openTrade.price > this.profitPercent) {
                        this.sendTradeSignal(PERCENT_SIGNAL, BUY, price)
                    }
                }

            } else {
                // console.log('Change ', change)
                if (change >= this.changeValue) {
                    this.sendTradeSignal(PERCENT_SIGNAL, BUY, price)
                }
                // } else if (-change >= this.samplePercent) {
                //     console.log('openTrade ', openTrade)
                //     this.sendTradeSignal(PERCENT_SIGNAL, SELL, price)
                // }
            }


        }
    }

    processPrice = async (price: number) => {

        if (this.lastPrice) {
            this.vt.close(this.lastPrice)
            return
        }

        this.quoteData = new QuoteData()

        //TODO move to util
        const now = new Date();
        const date = moment(now).format('DD-MMM-YYYY')
        const time = moment(now).format('HH:mm')

        this.quoteData.date = date
        this.quoteData.time = time
        this.quoteData.price = price
        this.quoteData.type = this.symbol
        if (this.strikePrice) {
            this.quoteData.strikePrice = this.strikePrice
        }

        this.updateArray20(this.priceArray20, price)
        this.updateArray5(this.priceArray5, price)

        // this.sma5(price)

        // if (this.priceArray20.length >= this.period20) {
        //     const tag1SD = this.tag1sd(price)
        //     this.tag2sd(price)
        //     this.tag3sd(price)
        //     const stochastic = this.stochastic(price)

        //     if (tag1SD == 'tagLower' && stochastic == SELL) {
        //         this.sendTradeSignal( COMBINATION_SIGNAL, SELL, price)
        //     } else if (tag1SD == 'tagUpper' && stochastic == BUY) {
        //         this.sendTradeSignal( COMBINATION_SIGNAL, BUY, price)
        //     }

        //     this.sma20(price)
        // }

        this.percent(price)

    }
    // const mongo = new Mongo()
    // Mongo.getInstance().init(['QuoteData'])
    // Mongo.getInstance().insert(this.quoteData)
    // Mongo.getInstance().close()
}

const test = async () => {

    console.log('Start ', new Date())
    let array = []
    fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/quoteData.csv')
        // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_spot_test.csv')
        // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_price.csv')
        .pipe(csv())
        .on('data', async (data) => {
            array.push(data)
            // const type = data['type']
            // const price = Number(data['price'])
            // switch (type) {
            // case 'NIFTY': await niftyProcessor.processPrice(price); break;
            // case 'CALL': await callProcessor.processPrice(price); break;
            // case 'PUT': await putProcessor.processPrice(price); break;
            // }
        })
        .on('end', function () {

            let results = []
            let filteredArray = array.filter((row => row.type == 'PUT'))

            for (let sampleCount = 10; sampleCount <= 30; sampleCount++) {
                for (let changeValue = 5; changeValue <= 40; changeValue += 5) {
                    for (let profitValue = 10; profitValue <= 40; profitValue++) {


                        const niftyProcessor = new Processor({ type: constants.NIFTY })
                        const callProcessor = new Processor({ type: constants.CALL, strikePrice: 10400 })
                        const putProcessor = new Processor({ type: constants.PUT, strikePrice: 10500 })

                        const thisProcessor = putProcessor
                        thisProcessor.sampleCount = sampleCount
                        thisProcessor.changeValue = changeValue
                        thisProcessor.profitPercent = profitValue

                        for (let i = 0; i < filteredArray.length; i++) {
                            const price = Number(filteredArray[i]['price'])
                            if (i == filteredArray.length - 1) {
                                thisProcessor.lastPrice = Number((filteredArray[i]['price']))
                            }
                            thisProcessor.processPrice(price);
                        }

                        let pl = thisProcessor.vt.pl()
                        let percent_pl = pl.get('PUT-percent')
                        var obj = {  sampleCount: sampleCount, change: changeValue, profit: profitValue, ...percent_pl, }
                        if (pl.size > 0) {
                            console.log('Result ', obj)
                            results.push(obj)
                        }
                    }
                }
            }
            f.writeObjects(results, '/home/karthikeyan/Desktop/github/work/icici/data/results.csv')
        });
}

process.on('beforeExit', async function () {
    console.log('Exit now ', new Date())
    const client = new Client(6000)
    client.sendMessage({ report: true })

    process.exit(0)
});


