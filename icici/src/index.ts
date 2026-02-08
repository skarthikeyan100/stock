// import Icici, { OptionType } from './trade/icici'
import Google from './tools/google'
import Prism from './prism'
import Decision, { Candle, PricePoint } from './decision'

import moment from 'moment'
import 'moment-timezone'
import price from './scheduler/strike-price'
import stockPrice from './scheduler/stock-strike-price'
import _ from 'underscore'
import async from 'async'
import { callbackify } from 'util'
import Strategy from './trade/strategy/strategy'
import { directionalTrade, balanceTrade, getOpenPositions, getNiftyQuote, squareOff } from './functions'
import { PDFExtract, PDFExtractOptions } from 'pdf.js-extract';
import * as path from 'path';

import https from 'https'; // or 'https' for https:// URLs
import fs from 'fs';
import { PeriodicStats } from 'model/model'
import { parse } from 'fast-csv';
import { EMA, RSI as rsi, SD } from 'technicalindicators';
import workerpool from 'workerpool';

export class Filtered {

    open
    high
    low
    close
    average
    median
    stdDeviation
    rateOfChange
    diff
    range
    diffFromHigh
    trend
    time
    eventName
    results: Result
}

export class Result {
    eventName: string
    macd: MACD[] = []
    rsi: RSI[] = []
    bollinger: Bollinger[] = []
    ema: EMACrossOver[] = []
    pivot: Pivot
}

export class MACD {
    shortPeriod: number = 0
    longPeriod: number = 0
    signalPeriod: number = 0
    latestShortEMA: number = 0
    latestLongEMA: number = 0
    latestMACD: number = 0
    latestSignal: number = 0
    trend: string = ''

    getFeature(): string {
        return `MACD_${this.shortPeriod}_${this.longPeriod}_${this.signalPeriod}`
    };
}

export class RSI {
    period: number = 0
    overbought: number = 0
    oversold: number = 0
    latestRSI: number = 0
    trend: string = ''

    getFeature(): string {
        return `RSI_${this.period}_${this.overbought}_${this.oversold}`
    };
}

export class Bollinger {
    period: number = 0;
    numDeviations: number = 0;
    stdDev: number = 0;
    upperBand: number = 0;
    middleBand: number = 0;
    lowerBand: number = 0;
    trend: string = '';

    getFeature(): string {
        return `Bollinger_${this.period}_${this.numDeviations}`
    };

}

export class EMACrossOver {
    shortPeriod: number = 0;
    longPeriod: number = 0;
    trend: string = '';

    getFeature(): string {
        return `EMA_${this.shortPeriod}_${this.longPeriod}`
    };
}


export class Pivot {
    S1
    R1
    S2
    R2
}


// export class Filtered {
//     open
//     high
//     low
//     close
//     average
//     median
//     stdDeviation
//     rateOfChange
//     diff
//     range
//     diffFromHigh
//     trend
//     time
// }

console.log('Is this ?')

const copyValues = (dest: any, src: any): void => {
    Object.keys(dest).forEach((key) => {
        if (src.hasOwnProperty(key)) {
            dest[key] = src[key];
        }
    });
};

const round = (num) => Math.round(num * 100) / 100;

const t = async () => {
    try {
        console.log('Executing t')
        console.log(moment().tz('Asia/Kolkata').format('HH:mm'))
        const myArray = readFileToArray();
        const filtered: Filtered[] = myArray.map(s => {
            const obj = new Filtered();
            obj.open = s.open;
            obj.average = s.average;
            obj.close = s.close;
            obj.diff = s.diff
            obj.diffFromHigh = s.diffFromHigh
            obj.high = s.high
            obj.low = s.low
            obj.median = s.median
            obj.range = s.range
            obj.rateOfChange = s.rateOfChange
            obj.stdDeviation = s.stdDeviation
            obj.time = s.time
            obj.trend = s.trend
            obj.eventName = s.results.eventName;
            const res = new Result();

            s.results.bollinger?.forEach(r => {
                const temp = new Bollinger();
                copyValues(temp, r)
                res.bollinger.push(temp);
                obj[temp.getFeature()] = temp.trend
            })

            s.results.rsi?.forEach(r => {
                const temp = new RSI();
                copyValues(temp, r)
                res.rsi.push(temp);
                obj[temp.getFeature()] = temp.trend
            })

            s.results.macd?.forEach(r => {
                const temp = new MACD();
                copyValues(temp, r)
                res.macd.push(temp);
                obj[temp.getFeature()] = temp.trend
            })

            s.results.ema?.forEach(r => {
                const temp = new EMACrossOver();
                temp.longPeriod = r.longPeriod;
                temp.shortPeriod = r.shortPeriod;
                temp.trend = r.trend.trend;
                res.ema.push(temp);
                obj[temp.getFeature()] = temp.trend
            })

            obj['S1'] = s.results.pivot.S1
            obj['S2'] = s.results.pivot.S2
            obj['R1'] = s.results.pivot.R1
            obj['R2'] = s.results.pivot.R2

            return obj;
        })
        console.log('Length: ', myArray.length);
        console.log('Length: ', filtered.length);
        console.log('Length: ', filtered[filtered.length - 1]);
        console.log()
        writeArrayToCsv("/home/karthikeyan/filtered.csv", filtered);
        var close = 22572.8
        var open = 22572.8
        var rateOfChange = round((close - open) / close * 100)

        console.log("Rate: " + rateOfChange)

    } catch (e) {
        console.log('Eror occurred ', e)
    }
    setInterval(() => { }, 1 << 30);
}

const index = async () => {
    console.log('Fetch Indices')

    const google = new Google(true)

    await google.fetchIndex('Dow Jones')
    await google.fetchIndex('S&P 500')
    await google.fetchIndex('Nasdaq Index')
    await google.fetchIndex('Nikkei 225')
    await google.fetchIndex('Topix index')
    await google.quit()


    // await google.fetchDowJones()
    setInterval(() => { }, 1 << 30);;

}

const saveFile = async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = "0"
    // const name = "cause_29022024.pdf";
    const name = "cause_temp.pdf";
    // getPDF(name);
    processPDF(name);
}

const processPDF = (name: string) => {
    var pdf2table = require('pdf2table');

    const jsonFile = fs.createWriteStream('cause1.json');

    fs.readFile('./' + name, function (err, buffer) {
        if (err) return console.log(err);
        pdf2table.parse(buffer, function (err, rows, rowsdebug) {
            if (err) return console.log(err);
            console.log(rows);
            const myJSON = JSON.stringify(rows);
            jsonFile.write(myJSON);

        });
    });
}

const extractPDF = (name: string) => {
    const pdfExtract = new PDFExtract();
    const options: PDFExtractOptions = {}; /* see below */
    pdfExtract.extract(name, options)
        .then(data => {
            const myJSON = JSON.stringify(data);
            console.log(myJSON)
            const jsonFile = fs.createWriteStream('cause.json');
            jsonFile.write(myJSON);
        })
        .catch(err => console.log(err));

}

const parsePDF = () => {
    const { PdfDocument } = require('@pomgui/pdf-tables-parser'),
        fs = require('fs');

    const pdf = new PdfDocument();
    pdf.load(name)
        .then(() => fs.writeFileSync('report.json', JSON.stringify(pdf, null, 2), 'utf8'))
        .catch(err => console.error(err));

}

const getPDF = (name: string) => {
    const file = fs.createWriteStream(name);
    const url = "https://mhc.tn.gov.in/judis/clists/clists-madurai/causelists/pdf/" + name;
    const request = https.get(url, function (response) {
        response.pipe(file);
        // after download completed close filestream
        file.on("finish", () => {
            file.close();
            console.log("Download Completed");

        });
    });

}

// index()

const readFileToArray = (): PeriodicStats[] => {
    const filePath = '/home/karthikeyan/stats_feb25.json';
    const data = fs.readFileSync(filePath, 'utf-8');
    const jsonArray: PeriodicStats[] = JSON.parse(data);
    return jsonArray;
};

const writeArrayToCsv = (filePath: string, data: any[]): void => {
    if (data.length === 0) return;

    // Collect all unique keys from the objects
    const keys = new Set<string>();
    data.forEach(obj => {
        Object.keys(obj).forEach(key => keys.add(key));
    });

    const header = Array.from(keys).join(',') + '\n';
    const rows = data.map(obj => {
        return Array.from(keys).map(key => obj[key] !== undefined ? obj[key] : '').join(',');
    }).join('\n');
    const csvContent = header + rows;

    fs.writeFileSync(filePath, csvContent, 'utf-8');
    console.log(`CSV file has been saved to ${filePath}`);
};



import csv from 'csv-parser';
import { writeToPath } from 'fast-csv';

// Define the CSV headers
type Row = {
    Date: string;
    Open: number;
    High: number;
    Low: number;
    Close: number;
    FullGapUp?: boolean;
    FullGapDown?: boolean;
    Diff?: number;
    DiffGap?: number | null;
    Ratio?: number | null;
};

// Read the CSV, process data, and write to a new CSV
const processCSV = (inputFile: string, outputFile: string) => {
    const rows: Row[] = [];

    fs.createReadStream(inputFile)
        .pipe(csv())
        .on('data', (data) => {
            const row: Row = {
                Date: data.Date,
                Open: parseFloat(data.Open),
                High: parseFloat(data.High),
                Low: parseFloat(data.Low),
                Close: parseFloat(data.Close),
            };
            rows.push(row);
        })
        .on('end', () => {
            console.log('Rows length: ', rows.length)
            const processedRows: Row[] = [];

            for (let i = 1; i < rows.length; i++) {
                const prevRow = rows[i - 1];
                const currRow = rows[i];

                currRow.Diff = Math.abs(round(currRow.Open - prevRow.Close));
                currRow.FullGapUp = currRow.Open > prevRow.High;
                currRow.FullGapDown = currRow.Open < prevRow.Low;

                if (currRow.FullGapUp) {
                    currRow.DiffGap = round(currRow.High - currRow.Open);
                } else if (currRow.FullGapDown) {
                    currRow.DiffGap = round(currRow.Open - currRow.Low);
                } else {
                    currRow.DiffGap = null;
                }

                currRow.Ratio = currRow.DiffGap !== null ? Math.abs(round(currRow.DiffGap / currRow.Diff)) : null;

                if ((currRow.FullGapUp || currRow.FullGapDown) && Math.abs(currRow.Diff) > 10) {
                    processedRows.push(currRow);
                }
            }

            console.log('Processed Rows length: ', processedRows.length)
            writeToPath(outputFile, processedRows, { headers: true })
                .on('finish', () => console.log('CSV processing completed.'));
        });
};



import { stringify } from 'csv-stringify/sync'

interface PriceData {
    open: number;
    close: number;
    high: number;
    low: number;
    s1: number;
    r1: number;
    s2: number;
    r2: number;
    prediction_s1?: string;
    prediction_s2?: string;
    prediction_r1?: string;
    prediction_r2?: string;
}

function analyzePriceDataForSupportAndResistance(filePath: string, outputFile: string): void {
    const rows: PriceData[] = [];

    // Read CSV file and store all data in an array
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
            rows.push({
                open: parseFloat(data.open),
                close: parseFloat(data.close),
                high: parseFloat(data.high),
                low: parseFloat(data.low),
                s1: parseFloat(data.S1),
                r1: parseFloat(data.R1),
                s2: parseFloat(data.S2),
                r2: parseFloat(data.R2),
            });
        })
        .on('end', () => {
            // Process each row with respect to subsequent price movements
            const diff = 10
            rows.forEach((row, index) => {
                console.log('First Loop')
                let exitLoop = false;
                const remainingRows = rows.slice(index + 1);
                remainingRows.forEach((nextRow, nextIndex) => {
                    console.log('Second Loop')
                    if (exitLoop) return;
                    else {
                        console.log('ExitLoop is false')
                    } // Exit if condition is met
                    if (nextRow.low < row.s1) {
                        console.log("Sell at ", row.s1)
                        const monitorRows = remainingRows.slice(nextIndex + 1);
                        row.prediction_s1 = 'bad'
                        try {
                            monitorRows.forEach((monitorRow, monitorIndex) => {
                                console.log('Third Loop')
                                console.log("Monitor", monitorRow.low, "condition: ", monitorRow.low < row.s1, "Actual diff: ", (row.s1 - monitorRow.low), "diff: ", diff)
                                if (monitorRow.low < row.s1 && (row.s1 - monitorRow.low) >= diff) {
                                    row.prediction_s1 = 'good';
                                    throw new Error('Exit Third Loop'); // Break out of the loop
                                }
                            });

                        } catch (e) {
                            exitLoop = true;
                            console.log('Returning from 3rd loop')
                        }

                    }
                });


                // remainingRows.forEach((nextRow, nextIndex) => {
                //     if (nextRow.high < row.r1) {
                //         console.log("Buy at ", row.r1)
                //         const monitorRows = remainingRows.slice(nextIndex + 1);
                //         row.prediction_r1 = 'bad'
                //         monitorRows.forEach((monitorRow, monitorIndex) => {
                //             if (monitorRow.high > row.r1 && (row.high - row.r1) >= diff) {
                //                 row.prediction_r1 = 'good';
                //                 return;
                //             }
                //         });

                //     }
                // }); 

                console.log(`close: ${row.close} open: ${row.open} downwardtrend: ${row.close < row.open}`)
                // if (row.close < row.open) {

                // remainingRows.forEach((nextRow, index) => { 
                //     if (nextRow.high > row.s1 && (nextRow.high - row.s1) >= diff) {
                //         row.prediction_s1 = 'bad';
                //         return;
                //     } else if (nextRow.low < row.s1 && (row.s1 - nextRow.low) >= diff) {
                //         row.prediction_s1 = 'good';
                //         return;
                //     } else {
                //         row.prediction_s1 = 'neutral';
                //     }
                // });
                // row.prediction_s1 = remainingRows.some(subsequentRow => subsequentRow.low < row.s1) ? 'good' : 'bad';
                // row.prediction_s2 = remainingRows.some(subsequentRow => subsequentRow.low < row.s2) ? 'good' : 'bad';
                // row.prediction_r1 = "NA"
                // row.prediction_r2 = "NA"
                // console.log("row: ", row);
                // } else {
                // remainingRows.forEach((nextRow, index) => { 
                //     if (nextRow.high > row.s1 && (nextRow.high - row.s1) >= diff) {
                //         row.prediction_s1 = 'good';
                //         return;
                //     } else if (nextRow.low < row.s1 && (row.s1 - nextRow.low) >= diff) {
                //         row.prediction_s1 = 'bad';
                //         return;
                //     } else {
                //         row.prediction_s1 = 'neutral';
                //     }
                // });

                // row.prediction_s1 = "NA"
                // row.prediction_s2 = "NA"
                // row.prediction_r1 = remainingRows.some(subsequentRow => subsequentRow.high > row.r1) ? 'good' : 'bad';
                // row.prediction_r2 = remainingRows.some(subsequentRow => subsequentRow.high > row.r2) ? 'good' : 'bad';

            }
            );

            // Convert updated data back to CSV format and write to output file
            const csvOutput = stringify(rows, { header: true });
            fs.writeFileSync(outputFile, csvOutput);
            console.log('Predictions added successfully!');
        });
}


// Run the script
// processCSV('/home/karthikeyan/nifty_1year.csv', '/home/karthikeyan/output.csv');



// Example usage
// analyzePriceDataForSupportAndResistance('ohlc_1min.csv', 'output.csv');

import strategies from './strategy/strategies';
import Minutes5Decision from './strategy/Minutes5Decision'
import Mongo from './tools/mongo'


async function test() {
    console.log('Run test function')
    console.time('program')

    await Mongo.init();
    console.log('Initialized')
    const mongo = Mongo.getInstance();
    const stream = mongo.getAll('NiftyQuote');
    const days = new Set();
    let count = 0;
    const prism = Prism.getInstance()
    const decision = Decision.getInstance()
    console.time('stream')
    stream.on('error', function (err) {
        // console.error(err)
    })
    stream.on('data', async (quote) => {
        count++;
        stream.pause();
        days.add(quote.day)
        // await prism.quote(quote)
        await decision.decidePurchase(quote);
        stream.resume();

    })
    stream.on('end', async () => {
        console.timeEnd('stream')
        console.log('Streaming data is complete')
        console.log('Days: ', days)
        console.log('Data Count: ', count)
        const decision = Decision.getInstance()
        const pricePoints = decision.pricePoints;

        // / Allocate SharedArrayBuffer: 2 numbers per PricePoint
        const sharedBuffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * pricePoints.length * 2);
        const sharedArray = new Float64Array(sharedBuffer);

        // Fill buffer with PricePoint data
        pricePoints.forEach((pp, i) => {
            sharedArray[i * 2] = pp.time;
            sharedArray[i * 2 + 1] = pp.price;
        });

        console.log("SharedArray length in main", sharedArray.length)



        const candleMap: Map<String, Candle[]> = decision.candlesMap;
        const enrichedCandlesMap: Map<String, Candle[]> = decision.enrichedCandlesMap;

        console.log(enrichedCandlesMap.keys())
        // for (const [eventName, candles] of candleMap) {
        //     console.log(eventName, ':', candles.length)
        //     // const labeledCandle = labelGoodBad(candles, decision.pricePoints)
        //     // const percent = percentageGoodOverBad(labeledCandle)
        //     // console.log(percent)

        // }

        console.time('convertToArray')
        const values = Array.from(enrichedCandlesMap.values()).flat();
        console.timeEnd('convertToArray')
        console.time('groupByName')
        const updatedMap = groupByName(values)
        console.timeEnd('groupByName')

        console.log('Values Length: ', values.length)
        console.log('Updated keys: ', updatedMap.keys())

        // transformMaps(decision.enrichedCandlesMap)
        await runWorkers(updatedMap, sharedBuffer)


        for (const [eventName, candles] of updatedMap) {


            // console.time('labelGoodBad')
            // const labeledCandle = labelGoodBad(candles, decision.pricePoints)
            // console.timeEnd('labelGoodBad')
            // console.time('percentageGoodOverBad')
            // const percent = percentageGoodOverBad(labeledCandle)
            // console.timeEnd('percentageGoodOverBad')
            // console.log(eventName, ':', percent)

        }
        console.timeEnd('program')

        // labelGoodBad();
        // console.log(JSON.stringify(decision.analysisData, null, 2))
    })

}

const updatePrice = (price) => {
    const round = (num) => Math.round(num * 10) / 10;
    const percent = (price, num) => (price * num / 100)
    const updated = round(percent(price, 10))
    console.log('Updated Threshold or Target to ', updated);
    return updated
}


function groupByName(candles: Candle[]): Map<string, Candle[]> {
    const result = new Map<string, Candle[]>();

    for (const candle of candles) {
        const key = candle.eventName;

        if (!result.has(key)) {
            result.set(key, []);
        }

        result.get(key)!.push(candle);
    }
    return result;
}

async function runWorkers(updatedMap, sharedBuffer) {

    console.log('runWorkers called')
    const pool = workerpool.pool(__dirname + '/worker.js', {
        minWorkers: 2,
        maxWorkers: 8,
        workerType: 'thread'
    });
    const tasks = Array.from(updatedMap.entries()).map(([eventName, candles]) =>
        pool.exec('processData', [eventName, sharedBuffer, candles])
    );

    console.log('Tasks length: ', tasks.length)
    const results = await Promise.all(tasks);
    results.map(r => {
        const worker = r.worker
        const rate = r.successRate
        return {
            worker: rate
        }
    })
    console.log('All workers completed:', results);

    const analysisResults = results.map (r => {
        return {
            'type': r.worker,
            'successRate': r.successRate
        } 
    })

    console.log('AnalysisResults: ', analysisResults)
    writeArrayToCsv("/home/karthikeyan/analysis.csv", analysisResults);

    pool.terminate();
}

function temp() {
    function consolidateFromMap<T>(map: Map<string, T[]>): T[] {
        return Array.from(map.values()).flat();
    }

    // Example
    const myMap2 = new Map<string, { id: number; value: string }[]>([
        ["group1", [{ id: 1, value: "A" }, { id: 2, value: "B" }]],
        ["group2", [{ id: 3, value: "C" }, { id: 4, value: "D" }]],
    ]);

    const consolidated2 = consolidateFromMap(myMap2);

    console.log(consolidated2);
}

console.log("Start now")
test();
// temp();


