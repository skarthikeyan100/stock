

import csv from 'csv-parser';
import fs from 'fs';
import { Parser } from 'json2csv';
import Strategy from '../trade/strategy/strategy';
import { Candle } from '../scheduler/scheduler';
var dataArray = [];
var callArray = [];
var putArray = [];
const ffields = ['OPEN', 'CLOSE', 'HIGH', 'LOW'];
const fields = ['open', 'close', 'high', 'low'];
console.log('Process CSV')
const strategy = new Strategy(null)
var i = 0;

fs.createReadStream('/home/karthikeyan/Documents/sbin_test.csv')
    .pipe(csv())
    .on('data', function (data) {
        // if (data.Type == 'Nifty') {
        //     dataArray.push(data);
        // } else if (data.Type == 'call') {
        //     callArray.push(data);
        // } else if (data.Type == 'put') {
        //     putArray.push(data);
        // 
        const candle = new Candle('SBIN')
            candle.open = data.open
            candle.close = data.close
            candle.high = data.high
            candle.low = data.low

            // candle.open = data.OPEN
            // candle.close = data.CLOSE
            // candle.high = data.HIGH
            // candle.low = data.LOW
            // console.log('Symbol ', data.SYMBOL, ' condition: ', data.SYMBOL == 'TATMOT')

            // if (data.SYMBOL == 'SBIN') {
            //     dataArray.push(candle)
            // }
                
            i++
            console.log('Pushing ', candle)
            strategy.addCandle(candle)
    })
    .on('end', function () {
        const json2csvParser = new Parser({ fields });
        // dataArray.sort((a, b) => {
        //     console.log('A ', a)
        //     return a.Time - b.Time
        // })
        // let csv = json2csvParser.parse(dataArray);
        // fs.writeFileSync('/home/karthikeyan/Documents/sbin_test.csv', csv);

        // callArray.sort((a, b) => {
        //     return a.Time - b.Time
        // })

        // csv = json2csvParser.parse(callArray);
        // fs.writeFileSync('/home/karthikeyan/Desktop/icici/dist/candle_call.csv', csv);

        // putArray.sort((a, b) => {
        //     return a.Time - b.Time
        // })

        // csv = json2csvParser.parse(putArray);
        // fs.writeFileSync('/home/karthikeyan/Desktop/icici/dist/candle_put.csv', csv);

        console.log('Completed Processing ', i)
        process.exit()
    });