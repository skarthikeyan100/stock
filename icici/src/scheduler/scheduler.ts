import Icici from '../trade/icici'
import cron from 'cron'
import delay = require('delay')
import { directionalTrade, balanceTrade } from '../functions'
import { exec } from 'child_process'
import { saveNiftyQuotes } from './stock-quote-collector'
import Signaler from './signaler'
import moment from 'moment'
import winston from 'winston'

const logFormat = winston.format.printf(function (info) {
    const date = moment().format('DD-MMM-YYYY HH:mm:ss')
    return `${date} : ${JSON.stringify(info.message)}\n`;
});

var logger = winston.createLogger({
    level: 'debug', // process.env.NODE_ENV === 'production' ? 'debug' : 'info',
    format: winston.format.combine(winston.format.prettyPrint(), logFormat),
    transports: [
        new (winston.transports.Console)(),
        new (winston.transports.File)({ filename: 'test.log' })
    ]
});

console.log = function(){
    return logger.debug.apply(logger, arguments)
  }
  console.error = function(){
    return logger.error.apply(logger, arguments)
  }
  console.info = function(){
    return logger.info.apply(logger, arguments)
  }

export class Candle {
    type: String
    open: Number
    close: Number
    high: Number
    low: Number
    volume: Number
    time

    constructor(type?) {
        this.type = type;
    }

}
const findDecisionUsingCandle = async () => {
    console.log('findDecisionUsingCandle')
    // const server = new Server();

    const client = exec('node communication/client', function (error, stdout, stderr) {
        if (error) {
            console.log(error.stack);
            console.log('Error code: ' + error.code);
            console.log('Signal received: ' + error.signal);
        }
        console.log('Child Process STDOUT: ' + stdout);
        console.log('Child Process STDERR: ' + stderr);
    });

    client.on('exit', function (code) {
        console.log('Child process exited with exit code ' + code);
    });

    await delay(1000);

    try {
        const expiryDate = '26-Mar-2020' //TODO update every Friday morning
        const getHighPrice = (price, newPrice) => {
            return price == null ? newPrice :
                newPrice > price ? newPrice : price;
        }

        const getLowPrice = (price, newPrice) => {
            return price == null ? newPrice :
                newPrice < price ? newPrice : price;
        }

        console.log('Collect Quotes')
        const icici = await Icici.getInstance();
        const price = await icici.getStrikePrice()

        const callStrikePrice = price[0]
        const putStrikePrice = price[1]

        //Get 4 candles
        console.log('Get in a loop')
        for (let j = 0; j < 360; j++) { //TODO make it as 360
            //Get 4 samples in a minute
            const candle = new Candle('Nifty');
            const callCandle = new Candle('call');
            const putCandle = new Candle('put');

            const quotesList = []
            const callQuotesList = []
            const putQuotesList = []

            console.log('Get 4 times')
            for (let i = 0; i < 4; i++) { // Get 4 quotes in a minute
                const quote = await icici.getQuote('Nifty')
                const tradePrice = quote.lastTradePrice;

                const callTradePrice = await icici.getOptionQuote('C', expiryDate, callStrikePrice)
                const putTradePrice = await icici.getOptionQuote('P', expiryDate, putStrikePrice)

                quotesList.push(quote);
                callQuotesList.push(callTradePrice);
                putQuotesList.push(putTradePrice);

                candle.high = getHighPrice(candle.high, tradePrice)
                candle.low = getLowPrice(candle.low, tradePrice)

                callCandle.high = getHighPrice(callCandle.high, callTradePrice)
                callCandle.low = getLowPrice(callCandle.low, callTradePrice)

                putCandle.high = getHighPrice(putCandle.high, putTradePrice)
                putCandle.low = getLowPrice(putCandle.low, putTradePrice)

                await delay(15 * 1000) // wait for 15 seconds
            }

            candle.open = quotesList[0].lastTradePrice
            candle.close = quotesList[3].lastTradePrice

            callCandle.open = callQuotesList[0]
            callCandle.close = callQuotesList[3]

            putCandle.open = putQuotesList[0]
            putCandle.close = putQuotesList[3]

            const time = Date.now()
            candle.time = time
            callCandle.time = time
            putCandle.time = time

            // console.log('Candle ', candle)
            // console.log('PutCandle ', putCandle)
            // console.log('CallCandle ', callCandle)
            // server.send(candle);
            // server.send(callCandle);
            // server.send(putCandle);
        }
    } catch (e) {
        console.log(e)
    }
}

// findDecisionUsingCandle()
// directionalTrade()

const t = async () => {
    console.log('Exiting()')
    process.exit(0)
    const signaler = new Signaler()
    await signaler.init()

    new cron.CronJob('0 */1 * * * 1-5', function () {
        // saveNiftyQuotes();
        console.log('Start Job ', new Date())
        // signaler.process()
    }).start();
}

// # Save Quotes every  minute between 10am to 3pm
new cron.CronJob('0 */1 10-15 * * 1-5', function() {
    console.info(moment())
    saveNiftyQuotes()
}).start();

var toLocalTime = function (time) {
    var d = new Date(time);
    var offset = (new Date().getTimezoneOffset() / 60) * -1;
    var n = new Date(d.getTime() + offset);
    return n;
};


//###########  Option Strategies
// At 9:16
new cron.CronJob('1 16 9 * * 1-5', function () {
    console.log('Start Directional Trade')
    // directionalTrade()
    // findDecisionUsingCandle()
}).start();

// At 11:30
new cron.CronJob('1 30 11 * * 1-5', function () {
    // balanceTrade()
}).start();
//###########  Option Strategies



// // At 9:30
// new cron.CronJob('1 30 9 * * 1-5', function() {
//     saveQuotes()
// }).start();

// // At 10:00
// new cron.CronJob('1 0 10 * * 1-5', function() {
//     saveQuotes()
// }).start();

// // At 02:00
// new cron.CronJob('1 0 14 * * 1-5', function() {
//     saveQuotes()
// }).start();

// // At 06:00
// new cron.CronJob('1 0 18 * * 1-5', function() {
//     saveQuotes()
// }).start();
