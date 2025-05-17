

import csv from 'csv-parser';
import fs from 'fs';
import { Parser } from 'json2csv';
var dataArray = [];
const oldFields = ['SYMBOL', 'OPEN', 'HIGH', 'LOW', 'CLOSE', 'LAST', 'PREVCLOSE', 'TOTTRDQTY', 'TOTTRDVAL', 'TOTALTRADES', 'TIMESTAMP'];
const highOpen = 'High-Open';
const change = 'Prev-Open';
const changePercent = 'Change%';
const openLow = 'Open-Low';
const trend = 'Trend'
const suggestedSellPrice = 'SuggestedSellPrice'
const prediction = 'Prediction'

const newFields = [ highOpen, change, openLow, trend, suggestedSellPrice, prediction, changePercent ];
const fields = [...oldFields, ...newFields];

console.log('Process CSV')

const diff = (n1, n2) => {
    const d = n1 - n2
    return Math.round((d + Number.EPSILON) * 100) / 100
}

const percent = (original, change) => {
    const d = change/original * 100
    return Math.round((d + Number.EPSILON) * 100) / 100
}

console.log(diff(249.8, 0.1))

fs.createReadStream('/home/karthikeyan/Documents/bhavcopy.csv')
    .pipe(csv())
    .on('data', function (data) {
        // console.log('Data ', data)
        data[highOpen] = diff(data.HIGH, data.OPEN);
        data[change] = diff(data.PREVCLOSE, data.OPEN);
        data[changePercent] = percent(data.PREVCLOSE, data[change]);
        data[openLow] = diff(data.OPEN,data.LOW);
        data[trend] = (data[change] > 0) ? 'Down' : 'Up'

        if (data[trend] == 'Down') {
            data[suggestedSellPrice] = diff(data.OPEN, data[change])
            if (data[suggestedSellPrice] > data.LOW) {
                data[prediction] = 'TRUE'
            } else {
                data[prediction] = 'FALSE'
            }

        } else {
            data[suggestedSellPrice] = data.OPEN + data[change]
            if (data[suggestedSellPrice] < data.HIGH) {
                data[prediction] = 'TRUE'
            } else {
                data[prediction] = 'FALSE'
            }
        }

        if (data.TOTTRDVAL > 150000000)
            dataArray.push(data);
    })
    .on('end', function () {
        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(dataArray);
        fs.writeFileSync('/home/karthikeyan/Documents/stockdata_bhavcopy.csv', csv);
    });