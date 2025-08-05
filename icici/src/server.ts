// import http from 'http'
// import url from 'url'
// import { directionalTrade, balanceTrade, getOpenPositions, getNiftyQuote, squareOff } from './functions'
// import Icici from './trade/icici';


// Icici.getInstance() //to start a browser
// http.createServer(function (req, res) {
//     try {
//         var q = url.parse(req.url, true).query;
//         res.setHeader('Content-Type', 'application/json');
//         console.log('Command ', q.command)
//         switch (q.command) {
//             case 'strategy':
//                 const strategy = q.strategy
//                 if (strategy == 'balance') {
//                     balanceTrade().then((result) => {
//                         res.end(JSON.stringify({ executed: 'balanceStrategy' }));
//                     }).catch((e) => {
//                         res.statusCode = 500;
//                         console.log('Error caught in the server ', e)
//                         res.end(JSON.stringify({ error: e.message }));
//                     });
//                 } else if (strategy == 'directional') {
//                     directionalTrade().then((result) => {
//                         res.end(JSON.stringify({ executed: 'directionalStrategy' }));
//                     }).catch((e) => {
//                         res.statusCode = 500;
//                         console.log('Error caught in the server ', e)
//                         res.end(JSON.stringify({ error: e.message }));
//                     });
//                 }
//                 break;
//             case 'open':
//                 getOpenPositions().then((result) => {
//                     res.end(JSON.stringify(result));
//                 });
//                 break;
//             case 'quote':
//                 getNiftyQuote().then((result) => {
//                     res.end(JSON.stringify(result));
//                 });
//                 break;
//             case 'squareoff':
//                 const contract = q.contract
//                 const market = q.market

//                 squareOff(contract, market).then((result) => {
//                     res.end(JSON.stringify(result));
//                 }).catch((e) => {
//                     console.log('Error caught in the server')
//                     res.end(e);
//                 })
//                 break;

//             default:
//                 res.statusCode = 500;
//                 res.end(JSON.stringify({ 'error': 'not allowed' }))
//         }

//     } catch (e) {
//         res.statusCode = 500;
//         res.end(e)
//     }

// }).listen(8080);
// console.log('Server is listening at 8080')
console.log('Hello')

const mockOpenPositions = [
    {
        "stockCode": "NIFTY",
        "expiryDate": "06-Oct-2022",
        "strikePrice": "17250",
        "right": "Call",
        "action": "NA",
        "quantity": "100",
        "cost": 50,
        "ltp": 25
    }];

const mockRuntimeQuote = {
    ltp: 17480.6,
    // ltt: '23-Sep-2022 10:00:27',
    ltt: 'Thu Sep 29 08:33:20 2022',
    open: 17593.85,
    high: 17642.15,
    low: 17435.55,
    close: undefined,
    prevClose: 17629.8
}

const mockEvent = { 'symbol': '4.1!NIFTY 50', 'open': 16993.6, 'last': 16801.8, 'high': 17026.05, 'low': 16788.6, 'change': -0.34, 'bPrice': 'None', 'bQty': 'None', 'sPrice': 'None', 'sQty': 'None', 'ltq': 'None', 'avgPrice': 'None', 'quotes': 'Quotes Data', 'ttq': 'None', 'totalBuyQt': 'None', 'totalSellQ': 'None', 'ttv': '', 'trend': '-', 'lowerCktLm': 'None', 'upperCktLm': 'None', 'ltt': 'Thu Sep 29 08:33:20 2022', 'close': 16858.6, 'exchange': 'NSE Equity', 'stock_name': 'NIFTY 50' };

let prevClose: 0;

import express from 'express';
import bodyParser from 'body-parser';
import Util from './util';
import axios from 'axios';
import path from 'path'
import delay from 'delay'
import moment from 'moment'
import 'moment-timezone';
import myEmitter from './tools/emitter';
import indexMap from './nse_index';
import candleManager from './candle';
import Monitor from './monitor';
import { CronJob } from 'cron';
import { Trade, Message } from './model/model';
import executeGap from './executeGap'
import configService  from "./prism/ConfigService";



// class MyEmitter extends EventEmitter { }

// const myEmitter = new MyEmitter();

var app = express();
// var expressWs = require('express-ws')(app);

app.use(express.static('public'))
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser());
app.disable('etag');
// expressWs.ws('/echo', function(ws, req) {
//     ws.on('message', function(msg) {
//       ws.send(msg);
//     });
//   });
import fs, { watchFile } from 'fs'
import Queue from 'async-await-queue';
import Breeze from './breeze';
import Browser from './trade/browser.js';
import Prism from './prism';
import Config from './prism/config';
import { NiftyQuote, OptionQuote } from './model/model';
import Mongo from './tools/mongo';
import { NIFTY, BANKNIFTY } from './constants';
import strategies from './strategy/strategies';
import DiffStrategy from 'strategy/DiffStrategy';

let apiSession = '1644073';
let sessionToken = 'U0VTSEExMDA6ODAyMDc4';

let demoLogger = (req, res, next) => {

    18601231122
    console.log("Request: ", req.method, req.url);
    res.on("finish", () => {
        console.log("Response: ", res.statusCode);
    });
    next();
};

// app.use(demoLogger);
const sleep = async (milliseconds) => {
    await new Promise(resolve => {
        return setTimeout(resolve, milliseconds)
    });
};

const _start = async () => {
    const prism = Prism.getInstance();
    await prism.connect();
    sleep(3000);
    // await prism.buyIndex('NIFTY')
    // await prism.buyIndex('BANKNIFTY')

}


app.get('/login', async function (req, res) {
    console.log("Logging in ");
    try {
        const { otp } = req.query;
        const prism = Prism.getInstance();
        await prism.login(req.query.otp as string);
        res.sendStatus(200)

        // const breeze = await Breeze.getInstance();
        // await breeze.login();

        // await updateStatus();

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.post('/redirect', async function (req, res) {
    try {
        console.log('Redirected')
        console.log(req.body);
        apiSession = req.body.API_Session;
        const breeze = await Breeze.getInstance();
        const response = await breeze.getCustomerDetails(apiSession);
        await breeze.init();
        res.send(response);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/monitor', async function (req: express.Request, res) {
    const breeze = await Breeze.getInstance();
    const resp = await breeze.monitor();
    res.send(resp);

});

// http://localhost:4000/iciciorder?stockCode=NIFTY&expiryDate=2023-12-06&strikePrice=44900&right=put&action=buy&limitPrice=290

app.get('/iciciorder', async function (req: express.Request, res) {
    try {
        const { stockCode, expiryDate, strikePrice, limitPrice, right, action} = req.query;
        const breeze = Breeze.getInstance();
        breeze.sendLimitOrder(stockCode, expiryDate, strikePrice, limitPrice, right, action);
        res.sendStatus(200);
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})

app.get('/orderbook', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        const orders = await prism.getOrders();
        console.log('Orders: ' + orders)
        res.send(orders);
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})

app.get('/start', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        await prism.buyIndex('NIFTY')
        await prism.buyIndex('BANKNIFTY')
        res.sendStatus(200);
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})

app.get('/strategies', async function (req: express.Request, res) {
    try {
        const { strategy, enable} = req.query;
        strategies.getList().forEach((s) => {
            if (s.getClassName() == strategy) {
                s.enabled = enable == 'true';
            }
        })
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})

app.get('/addTrade', async function (req: express.Request, res) {
    try {
        const trantype = 'B'
        const { tsym, flqty, flprc} = req.query;
        const data = {tsym, flqty, flprc, trantype}
        Monitor.getInstance().updateTrade(data)
        res.sendStatus(200);
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})

app.get('/openTrades', async function (req: express.Request, res) {
    try {
        const trades = Monitor.getInstance().trades
        res.send(trades)
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }

})


// http://localhost:3000/order?depth=2&right=call&action=buy
http://localhost:3000/order?index=NIFTY&right=call&action=buy&strikePrice=20500&price=42.5
app.get('/order', async function (req: express.Request, res) {
    try {
        const { right, action, index, strikePrice, price, contract, triggerPrice } = req.query;
        const prism = Prism.getInstance();

        // let niftyQuote;
        // niftyQuote = await prism.getQuote(index as string);

        // const niftyPrice = niftyQuote.ltp;
        // var expiryDate = Util.findExpiryDate();
        // var expiryDate = Util.findExpiryDate();
        // var strikePrice = Util.findStrikePrice(niftyPrice, parseInt(depth as string), right);


        // const breeze = await Breeze.getInstance();
        // const quote: OptionQuote = await breeze.getOptionQuote(expiryDate, strikePrice, right);


        // await breeze.sendLimitOrder(expiryDate, strikePrice, quote.ltp, right, action);
        // await breeze.subscribeOption(expiryDate, strikePrice, right);

        const nseIndex = indexMap.get(index as string);
        
        console.log('strikePrice: ', strikePrice, ' right: ', right)
        if (contract) {
            // if (triggerPrice) {
            //     Prism.getInstance().setOnTrigger(contract as string, triggerPrice as string)
            // } else {
            //     console.log('Buy a contract at the current price')
            //     prism.buyContract(contract as string);
            // }
            
        } else {
            if (right && !strikePrice) {
                prism.buyIndex(index, right)
            } else if (!strikePrice && !right) {
                prism.buyIndex(index)
            } else {
                const token = await nseIndex.findTokenFor(index as string, right as string, parseInt(strikePrice as string));
    
                let optionPrice = parseInt(price as string);
                if (optionPrice == null || optionPrice == undefined) {
                    const quote: NiftyQuote = await prism.getOptionQuote(token);
                    optionPrice = quote.ltp;
            
                }
        
                await prism.sendLimitOrder(token, optionPrice, right as string, action as string, null);
        
            }
    
        }

        res.sendStatus(200);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/connect', async function (req: express.Request, res) {
    const prism = Prism.getInstance();
    try {
        await prism.connect();
        res.sendStatus(200);
    } catch (e) {
        console.log("Error while connecting to prism ", e)
        res.sendStatus(500);
    }
})


app.get('/subscribe', async function (req: express.Request, res) {
    // const breeze = Breeze.getInstance();
    const prism = Prism.getInstance();
    try {
        // await breeze.subscribeNifty();
        prism.subscribeNifty();
        res.sendStatus(200);
    } catch (e) {
        console.log("Error while subscribing nifty");
        res.sendStatus(500);
    }
})

app.get('/unsubscribe', async function (req: express.Request, res) {
    const breeze = Breeze.getInstance();
    try {
        await breeze.unsubscribeNifty();
        res.sendStatus(200);
    } catch (e) {
        console.log("Error while unsubscribing nifty");
        res.sendStatus(500);
    }
})

app.get('/subscribeOption', async function (req: express.Request, res) {
    const { expiryDate, strikePrice, right } = req.query;
    const breeze = Breeze.getInstance();
    try {
        await breeze.subscribeOption(expiryDate, strikePrice, right);
        res.sendStatus(200);
    } catch (e) {
        console.log("Error while subscribing option");
        res.sendStatus(500);
    }
})

app.get('/unsubscribeOption', async function (req: express.Request, res) {
    const { expiryDate, strikePrice, right } = req.query;
    const breeze = Breeze.getInstance();
    try {
        await breeze.unsubscribeOption(expiryDate, strikePrice, right);
        res.sendStatus(200);
    } catch (e) {
        console.log("Error while unsubscribing option");
        res.sendStatus(500);
    }
})


const mockTrades = [{ "token": "54033", "orderno": "23041000314509", "stockCode": "NIFTY", "action": "Buy", "cost": "67.25", "quantity": 200, "expiryDate": "20APR23", "right": "call", "strikePrice": "17800" }];
app.get('/trades', async function (req: express.Request, res) {
    try {
        // const breeze = Breeze.getInstance();
        // res.send(await breeze.getTradeList());

        const prism = Prism.getInstance();
        res.send(await prism.getTradeList());

        // res.send(mockTrades);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/refreshtrades', async function (req: express.Request, res) {
    try {
        // const breeze = Breeze.getInstance();
        // res.send(await breeze.getTradeList());

        const prism = Prism.getInstance();
        const openTrades : Trade[] = await prism.refreshTradeList()
        const orders = await prism.getOrders();
        res.send(openTrades);
        Monitor.getInstance().refreshTrades(openTrades)
        Monitor.getInstance().refreshPendingOrders(orders)

        // res.send(mockTrades);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/subscribetrades', async function (req: express.Request, res) {
    try {
        const prism = Prism.getInstance();
        const openTrades : Trade[] = await prism.refreshTradeList()
        Monitor.getInstance().subscribeTrades(openTrades)
        res.send(200);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})


// http://localhost:3000/squareoff?expiryDate=27-Oct-2022&right=call&strikePrice=17600

app.get('/squareoff', async function (req: express.Request, res) {
    try {

        const { token, expiryDate, strikePrice, right, qty } = req.query;

        // const breeze = await Breeze.getInstance();
        // await breeze.sendMarketOrder(expiryDate, strikePrice, right, 'sell');
        // await breeze.unsubscribeOption(expiryDate, strikePrice, right);

        const prism = await Prism.getInstance();

        prism.squareOffOrder(token, qty)
        res.sendStatus(200);

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/niftystream', async function (req, res) {

    const callback = (t) => {
        res.write(`data: ${JSON.stringify(t)}\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove nifty listener')
        myEmitter.removeListener('nifty', callback);
    });
    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');

    //Subscribe for FirstEvent
    const listenerCount = myEmitter.listenerCount('nifty');
    console.log("Nifty Listener count ", listenerCount);
    console.log(`Host: ${req.host}`);
    myEmitter.on('nifty', callback);
})

app.get('/optionstream', async function (req, res) {

    const callback = (t) => {
        res.write(`data: ${JSON.stringify(t)}\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove nifty listener')
        myEmitter.removeListener('option', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');
    let count = 0;

    //Subscribe for FirstEvent
    const listenerCount = myEmitter.listenerCount('option');
    console.log("Option Listener count ", listenerCount);
    myEmitter.on('option', callback);
})

app.get('/positionstream', async function (req, res) {

    const callback = (t) => {
        res.write(`data: ${JSON.stringify(t)}\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove position listener')
        myEmitter.removeListener('option', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Tell the client to retry every 10 seconds if connectivity is lost
    res.write('retry: 10000\n\n');
    let count = 0;

    //Subscribe for FirstEvent
    const listenerCount = myEmitter.listenerCount('position');
    console.log("Position Listener count ", listenerCount);
    myEmitter.on('position', callback);
})

app.get('/statusstream', async function (req, res) {

    const callback = (t) => {
        const m = JSON.stringify(t)
        res.write(`data: ${m}\n\n`);
        // res.write(`data: Hello\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove status listener')
        myEmitter.removeListener('status', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    //Subscribe for FirstEvent
    myEmitter.on('status', callback);
    const listenerCount = myEmitter.listenerCount('status');
    console.log("Status Listener count ", listenerCount);
})

app.get('/timestream', async function (req, res) {

    const callback = (t) => {
        const m = JSON.stringify(t)
        res.write(`data: ${m}\n\n`);
        // res.write(`data: Hello\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove time stream listener')
        myEmitter.removeListener('status', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    //Subscribe for FirstEvent
    myEmitter.on('timewindow', callback);
    const listenerCount = myEmitter.listenerCount('status');
    console.log("Time window Listener count ", listenerCount);
})

app.get('/datastream', async function (req, res) {

    console.log('/Datastream is invoked')
    const callback = (t) => {
        console.log('In callback ', t)
        const m = JSON.stringify(t)
        console.log('In Message ', m)
        res.write(`data: ${m}\n\n`);
        // res.write(`data: Hello\n\n`);
    };

    req.connection.addListener('close', function () {
        console.log('Connection is closed, remove time stream listener')
        myEmitter.removeListener('status', callback);
    });

    res.set({
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    //Subscribe for FirstEvent
    myEmitter.on('data', callback);
    const listenerCount = myEmitter.listenerCount('status');
    console.log("Time window Listener count ", listenerCount);
})


app.get('/test', async function (req, res) {
    const { index } = req.query;
    const prism = Prism.getInstance();
    // prism.findDirectionAndStrikePrice(index as string);
    await prism.getOptionChain()
    res.send('Done')
})


app.get('/quotes', async function (req, res) {

    // res.send(mockRuntimeQuote);
    try {
        const prism = Prism.getInstance();
        let result = {} as any
        result.nifty = await prism.getNiftyQuote();  // Nifty Quotes
        result.bankNifty = await prism.getBankNiftyQuote();  // Nifty Quotes
        result.finNifty = await prism.getFinNiftyQuote();  // Nifty Quotes

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // console.log('Response in server ', response)
        res.send(result)

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/niftyquote', async function (req, res) {

    // res.send(mockRuntimeQuote);
    try {
        const response = await Prism.getInstance().getNiftyQuote();  // Nifty Quotes
        console.log('Quotes: ', response);

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // console.log('Response in server ', response)
        res.send(response)

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/quote', async function (req, res) {

    const { symbol } = req.query;
    // res.send(mockRuntimeQuote);
    try {
        const response = await Prism.getInstance().getStockQuote(symbol as string);  // Nifty Quotes
        console.log('Quotes: ', response);

        // const breeze = Breeze.getInstance();
        // const response = await breeze.getNiftyQuote();
        // prevClose = response.prevClose;
        // console.log('Response in server ', response)
        res.send(response)

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/requestOtp', async function (req, res) {
    try {
        console.log('Requesting OTP');
        await Prism.getInstance().requestOtp();
        res.send("Requested OTP");
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/search', async function (req, res) {
    console.log('Len: ', req.query);
    const { depth, right, index } = req.query;
    const nseIndex = indexMap.get(index as string);
    const token = await nseIndex.findToken(index as string, parseInt(depth as string), right as string);
    res.send("{ token: " + token + "}");

});

app.get('/logout', async function (req, res) {
    await Prism.getInstance().logout();
});

app.get('/candles', async function (req, res) {

    try {
        const candles = candleManager.getCandleData('NIFTY', 15);
        res.send(candles)
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})


app.get('/executeGap', async function (req, res) {

    try {
        await executeGap.setPreviousDayQuote();
        
    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

// app.get('/config', async function (req, res) {
//     console.log('In Config ' + JSON.stringify(req.query));
//     const targetPrice = parseInt(req.query.targetPrice as string);
//     if (targetPrice) {
//         if (targetPrice == 0 ) {
//             Config.targetPriceDiff = 100;
//         } else {
//             Config.targetPriceDiff = targetPrice;
//         }
//     }

//     const depth = parseInt(req.query.depth as string);
//     if (depth) {
//         Config.depth = depth;
//     }

//     const lotSize = parseInt(req.query.lotSize as string);
//     if (lotSize) {
//         Config.lotCount = lotSize;
//     }

//     console.log(Config.targetPriceDiff)
// });

app.get('/config', (req, res) => {
    res.json(configService.getConfig());
  });
  
app.post('/config', (req, res) => {
    const newConfig = req.body;
    configService.writeConfig(newConfig);
    res.send('Config updated!');
  });

var route, routes = [];

app._router.stack.forEach(function (middleware) {
    if (middleware.route) { // routes registered directly on the app
        routes.push(middleware.route.path);
    } else if (middleware.name === 'router') { // router middleware 
        middleware.handle.stack.forEach(function (handler) {
            route = handler.route;
            route && routes.push(route.path);
        });
    }
});


var BreezeConnect = require('breezeconnect').BreezeConnect;
console.log(routes)

// const { RSI } = require('technicalindicators');

// // Example: RSI calculation for a given period and price array
// const prices = [44, 47, 49, 52, 48, 47, 45, 46, 47, 46, 45, 44];
// const period = 5;

// const rsiInput = {
//   values: prices,
//   period: period
// };

// const rsiValues = RSI.calculate(rsiInput);
// console.log(rsiValues)


var server = app.listen(3000, async function () {
    console.log('Icici server started ')
    Mongo.init();
    // console.log('What Happens now? ', executeGap)
    

    console.log('********************  Threshold: ', configService.getConfig().buySellStrategy.averageThreshold);

    // new CronJob(`0 ${config.startMin} ${config.startHour} * * *`, async function() {
    //     console.log('Buy Nifty Index')
    //     await _start()
    //     console.info(moment())
    // }, null, true);
    // https://api.icicidirect.com/apiuser/login?api_key=01@oF100100H4eV8=109q287N9J8%2552L
    // http://localhost:3000/?apisession=27529479
    // const icici_apiKey = "01@oF100100H4eV8=109q287N9J8%52L";
    // console.log("https://api.icicidirect.com/apiuser/login?api_key=" + encodeURI(icici_apiKey));

    // const appKey = "01@oF100100H4eV8=109q287N9J8%52L";
    // const appSecret = "#=f055136JU8R000wE91B094F5J192`5";
    // const apiSession = '27557733';

    // console.log("Connecting to Breeze")
    // var breeze = new BreezeConnect({"appKey":appKey});
    // console.log("Generate Session")
    // await breeze.generateSession(appSecret,apiSession)
    // console.log("Get funds")
    // const fundResponse = breeze.getFunds();
    // console.log("Funds response: ", fundResponse);

    // breeze.login();
    // console.log('sessionToken: ', breeze.sessionToken);
    // if (breeze.sessionToken == null || breeze.sessionToken.length == 0) {
    //     breeze.login();
    // }

    // const breeze = Breeze.getInstance();
    // const response = await breeze.getCustomerDetails(apiSession);

    // const localtunnel = require('localtunnel');
    // (async function () {

    //     try {
    //         const tunnel = await localtunnel({
    //             port: 3000, // port or network address, defaults to 80
    //             subdomain: 'skarthikeyan100'
    //         });
    //         console.log('URL: ', tunnel.url)
    //         tunnel.on('close', () => {
    //             console.log('tunnels are closed');
    //         });
    //     } catch (e) {
    //         console.log(e)
    //     }
    // })();
}



)