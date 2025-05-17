import moment from 'moment'
import { Signal } from '../tools/process_signal';
import Mongo from '../tools/mongo';
import { Client } from '../communication/client';
import Icici from '../trade/icici';
import { Processor } from './processor';
import * as constants from '../constants'

const BUY = 'Buy'
const SELL = 'Sell'

const SMA5_SIGNAL = "sma5"
const SMA20_SIGNAL = "sma20"
const BB1SD_SIGNAL = "bb1sd"
const BB2SD_SIGNAL = "bb2sd"
const STOCHASTIC_SIGNAL = "stochastic"
const COMBINATION_SIGNAL = "combination"

const period20 = 20
const period5 = 5
const consistentPeriodForBB = 5
let quoteData

//Bollinger Band
const stdDev1 = 1
const stdDev2 = 2

// Stochastic Oscillator

const updateArray20 = (array, number) => {
    array.push(parseFloat(number))
    if (array.length > period20) {
        array.shift()
    }
}

const updateArray5 = (array, number) => {
    array.push(parseFloat(number))
    if (array.length > period5) {
        array.shift()
    }
}


const priceArray20: number[] = []
const priceArray5: number[] = []

const signal = new Signal()

// fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_call_test.csv')
// // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_spot_test.csv')
//     // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_price.csv')
//     .pipe(csv())
//     .on('data', function (data) {
//         processPrice(Number(data['Close']))
//     })
//     .on('end', function () {
//         console.log('Processed')
//     });

class TradeSignal {
    strategy
    action
    price
    symbol
    strikePrice

    constructor(strategy, action, price) {
        this.strategy = strategy
        this.action = action
        this.price = price
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

function sendTradeSignal(strategy, action, price) {
    const signal = new TradeSignal(strategy, action, price)
    const client = new Client(6000)
    client.sendMessage(signal)

    switch (strategy) {
        case SMA5_SIGNAL: quoteData.sma5 = action; break;
        case SMA20_SIGNAL: quoteData.sma20 = action; break;
        case BB1SD_SIGNAL: quoteData.bb1sd = action; break;
        case BB2SD_SIGNAL: quoteData.bb2sd = action; break;
        case STOCHASTIC_SIGNAL: quoteData.stochastic = action; break;
        case COMBINATION_SIGNAL: quoteData.combination = action; break;
    }
}

// class S {
//     processPrice = (price: number, type) => {
//         quoteData = new QuoteData()
//         const now = new Date();
//         const date = moment(now).format('DD-MMM-YYYY')
//         const time = moment(now).format('HH:mm')
    
//         quoteData.date = date
//         quoteData.time = time
//         quoteData.price = price
//         updateArray20(priceArray20, price)
//         updateArray5(priceArray5, price)
    
//         if (priceArray5.length >= period5) {
//             const sma5 = signal.sma(price, period5, priceArray5)
//             if (sma5) {
//                 if (sma5 == BUY) {
//                     sendTradeSignal(SMA5_SIGNAL, BUY, price)
//                 } else {
//                     quoteData.sma5 = SELL
//                     sendTradeSignal(SMA5_SIGNAL, SELL, price)
//                 }
//             }
//         }
    
//         if (priceArray20.length >= period20) {
//             const tag1SD = signal.bollingerbands(price, period20, stdDev1, priceArray20)
//             if (tag1SD) {
//                 if (tag1SD == 'tagUpper') {
//                     sendTradeSignal(BB1SD_SIGNAL, BUY, price)
//                 } else if (tag1SD == 'tagLower') {
//                     sendTradeSignal(BB1SD_SIGNAL, SELL, price)
//                 }
//             }
    
//             const tag2SD = signal.bollingerbands(price, period20, stdDev2, priceArray20)
//             if (tag2SD) {
//                 if (tag2SD == 'tagUpper') {
//                     sendTradeSignal(BB2SD_SIGNAL, BUY, price)
//                 } else if (tag2SD == 'tagLower') {
//                     sendTradeSignal(BB2SD_SIGNAL, SELL, price)
//                 }
//             }
    
//             const stochastic = signal.stochastic(price)
//             if (stochastic) {
//                 if (stochastic == BUY) {
//                     sendTradeSignal(STOCHASTIC_SIGNAL, BUY, price)
//                 } else {
//                     sendTradeSignal(STOCHASTIC_SIGNAL, SELL, price)
//                 }
//             }
    
//             if (tag1SD && stochastic == BUY) {
//                 sendTradeSignal(COMBINATION_SIGNAL, BUY, price)
//             } else if (tag1SD && stochastic == SELL) {
//                 sendTradeSignal(COMBINATION_SIGNAL, SELL, price)
//             }
    
//             const sma20 = signal.sma(price, period20, priceArray20)
//             if (sma20) {
//                 if (sma20 == BUY) {
//                     sendTradeSignal(SMA20_SIGNAL, BUY, price)
//                 } else {
//                     sendTradeSignal(SMA20_SIGNAL, SELL, price)
//                 }
//             }
//         }
    
//         const mongo = new Mongo()
//         mongo.init(['QuoteData'])
//         Mongo.getInstance().insert(quoteData)
//         mongo.close()
//     }
// }

export default class Signaler {

    niftyProcessor : Processor
    callProcessor : Processor
    putProcessor : Processor
    callStrikePrice
    putStrikePrice

    expiryDate = '26-Jun-2020' //TODO update every Friday morning

    init = async () => {
        console.log('Init Start ', new Date())
        const icici = await Icici.getInstance()
        const price = await icici.getStrikePrices()
    
        this.callStrikePrice = price[0]
        this.putStrikePrice = price[1]
    
    
        console.log(' Call Strike ', this.callStrikePrice, 'Put Strike ', this.putStrikePrice)
    
        this.niftyProcessor = new Processor({ type: constants.NIFTY })
        this.callProcessor = new Processor({ type: constants.CALL, strikePrice: this.callStrikePrice})
        this.putProcessor = new Processor({ type: constants.PUT, strikePrice: this.putStrikePrice})
        console.log('Init End ', new Date())
    }

    process = async () => {

        const icici = await Icici.getInstance()

        const quote = await icici.getQuote('Nifty')
        const niftyPrice = quote.lastTradePrice;
        const callTradePrice = await icici.getOptionQuote('C', this.expiryDate, this.callStrikePrice)
        const putTradePrice = await icici.getOptionQuote('P', this.expiryDate, this.putStrikePrice)

        this.niftyProcessor.processPrice(niftyPrice)
        this.callProcessor.processPrice(callTradePrice)
        this.putProcessor.processPrice(putTradePrice)
    
    }
}