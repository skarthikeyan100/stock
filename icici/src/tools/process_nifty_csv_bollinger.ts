// import csv from 'csv-parser';
// import { sma, ema, bollingerbands, sd } from 'technicalindicators'
// import fs from 'fs';
// import { Parser } from 'json2csv';
// import { Candle } from '../scheduler/scheduler';
// import { Signal } from './process_signal';
// import { getDefaultService } from 'selenium-webdriver/chrome';
// import { VirtualTrade } from './virtual_trade';
// var dataArray = [];
// const oldFields = ['Close'];
// const highOpen = 'High-Open';
// const change = 'Prev-Open';
// const changePercent = 'Change%';
// const openLow = 'Open-Low';
// const trend = 'Trend'
// const suggestedSellPrice = 'SuggestedSellPrice'
// const prediction = 'Prediction'

// const smaField20 = "SMA-20"
// const emaField20 = "EMA-20"
// const smaField5 = "SMA-5"
// const emaField5 = "EMA-5"
// const lower1 = "Lower-1SD"
// const lower2 = "Lower-2SD"
// const middle = "middle"
// const upper1 = "Upper-1SD"
// const upper2 = "Upper-2SD"
// const tag1SDField = 'Tag 1 SD'
// const tag2SDField = 'Tag 2 SD'
// const stochasticField = 'Stochastic'
// const sma5Field = 'SMA 5'
// const sma20Field = 'SMA 20'
// const combinationField = 'Combination'


// const kField = 'K'
// const dField = 'D'
// const period20 = 20
// const period5 = 5
// const consistentPeriodForBB = 5

// //Bollinger Band
// const stdDev1 = 1
// const stdDev2 = 2

// // Stochastic Oscillator

// const newFields = [tag1SDField, tag2SDField, stochasticField, combinationField, sma5Field, sma20Field];
// const fields = [...oldFields, ...newFields];

// console.log('Process CSV')

// const diff = (n1, n2) => {
//     const d = n1 - n2
//     return Math.round((d + Number.EPSILON) * 100) / 100
// }

// const percent = (original, change) => {
//     const d = change / original * 100
//     return Math.round((d + Number.EPSILON) * 100) / 100
// }

// console.log(diff(249.8, 0.1))

// const updateArray20 = (array, number) => {
//     array.push(parseFloat(number))
//     if (array.length > period20) {
//         array.shift()
//     }
// }

// const updateArray5 = (array, number) => {
//     array.push(parseFloat(number))
//     if (array.length > period5) {
//         array.shift()
//     }
// }


// const priceArray20: number[] = []
// const priceArray5: number[] = []
// const candleArray: Candle[] = []
// let candle: Candle;

// const signal = new Signal()

// const vt = new VirtualTrade()
// // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_call_test.csv')
// fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_spot_test.csv')
// // fs.createReadStream('/home/karthikeyan/Desktop/github/work/icici/data/nifty_price.csv')
//     .pipe(csv())
//     .on('data', function (data) {
//         const price = Number(data['Close'])
//         updateArray20(priceArray20, data['Close'])
//         updateArray5(priceArray5, data['Close'])



//         if (priceArray5.length >= period5) {
//             const sma5 = signal.sma(price, period5, priceArray5)
//             if (sma5) {
//                 data[sma5Field] = sma5
//                 if (sma5 == 'Buy') {
//                     vt.addTrade('SMA5', 'Buy', price)
//                 } else {
//                     vt.addTrade('SMA5', 'Sell', price)
//                 }

//             }

//         }
//         if (priceArray20.length >= period20) {

//             const tag1SD = signal.bollingerbands(price, period20, stdDev1, priceArray20)
//             if (tag1SD) {
//                 data[tag1SDField] = tag1SD

//                 if (tag1SD == 'tagUpper') {
//                     vt.addTrade('BB1SD', 'Buy', price)
//                 } else if (tag1SD == 'tagLower') {
//                     vt.addTrade('BB1SD', 'Sell', price)
//                 }
//             }

//             const tag2SD = signal.bollingerbands(price, period20, stdDev2, priceArray20)
//             if (tag2SD) {
//                 data[tag2SDField] = tag2SD
//                 if (tag2SD == 'tagUpper') {
//                     vt.addTrade('BB2SD', 'Buy', price)
//                 } else if (tag2SD == 'tagLower') {
//                     vt.addTrade('BB2SD', 'Sell', price)
//                 }
//             }

//             const stochastic = signal.stochastic(price)
//             if (stochastic) {
//                 data[stochasticField] = stochastic

//                 if (stochastic == 'Buy') {
//                     vt.addTrade('Stochastic', 'Buy', price)
//                 } else {
//                     vt.addTrade('Stochastic', 'Sell', price)
//                 }
//             }

//             if (tag1SD && stochastic == 'Buy') {
//                 data[combinationField] = 'Buy'
//                 vt.addTrade('Combination', 'Buy', price)
//             } else if (tag1SD && stochastic == 'Sell') {
//                 data[combinationField] = 'Sell'
//                 vt.addTrade('Combination', 'Sell', price)
//             }

//             const sma20 = signal.sma(price, period20, priceArray20)
//             if (sma20) {
//                 data[sma20Field] = sma20
//                 if (sma20 == 'Buy') {
//                     vt.addTrade('SMA20', 'Buy', price)
//                 } else {
//                     vt.addTrade('SMA20', 'Sell', price)
//                 }
//             }
//         }

//         console.log('Data ', data)
//         dataArray.push(data)
//     })
//     .on('end', function () {
//         const json2csvParser = new Parser({ fields });
//         const csv = json2csvParser.parse(dataArray);
//         fs.writeFileSync('/home/karthikeyan/Desktop/github/work/icici/data/nifty_price_calculated.csv', csv);

//         const vfields = ['strategy', 'type', 'price'];
//         const vjson2csvParser = new Parser({ fields : vfields});
//         // console.log('Trades ', vt.trades)
//         const vcsv = vjson2csvParser.parse(vt.trades);
//         fs.writeFileSync('/home/karthikeyan/Desktop/github/work/icici/data/virtual_trades.csv', vcsv);

//         console.log(vt.pl())

//     });