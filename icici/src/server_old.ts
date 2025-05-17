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


import express from 'express';
import axios from 'axios';
import { directionalTrade, balanceTrade, getOpenPositions, getNiftyQuote, execute, squareOff } from './functions'
import Option, { Decision, OptionType, OptionPosition } from './trade/option'
import path from 'path'
import delay from 'delay'
import moment from 'moment'
import 'moment-timezone';

var app = express();
import fs, { watchFile } from 'fs'
import Icici from './trade/icici';
import Queue from 'async-await-queue';

const queue = new Queue(1, 100);

console.log('Executed ---->')

// app.get('/openpositions', function (req, res) {
//     res.json(getOpenPositions())
// })

// app.get('/quote', function (req, res) {
//     res.json(getNiftyQuote())
// })


const updateStatus = async () => {
    const option = await Option.build()
    const icici = await Icici.getInstance()

    const positions: Array<OptionPosition> = await option.monitorOptionOpenPositions({ autoSquareOff: false });
    const quote = await icici.getQuote('Nifty')
    console.log('Quote ', quote)
    
    const lastUpdated = moment().tz('Asia/Kolkata').format('HH:mm')
    const response = {
        positions, quote, lastUpdated
    }

    console.log('Response ', response)

    fs.writeFile('./status.json', JSON.stringify(response), err => {
        if (err) { console.log('Error while writing a file ', err) }
    })
    await checkOpenPosition(positions)

}

app.get('/update', async function (req, res) {
    try {
        const me = Symbol();
        res.sendStatus(200)
        // await updateStatus();

    } catch (e) {
        console.log(e)
        res.sendStatus(500)
    }
})

app.get('/status', async function (req, res) {
    console.log(__dirname)
    res.sendFile(path.resolve('status.json'))
})

app.get('/squareOff', async function (req, res) {
    // const option = await Option.build()
    console.log('Square off ', req.query.contract)
    await delay(5000)
    // await option.squareOffOption(req.query.contract)
    console.log('Return 200 now')
    res.sendStatus(500);
})

let interval;
const decisionsList: Array<Decision> = []
app.get('/monitor', async function (req, res) {

    
    if (!interval) {
        console.log('Start Monitoring')
        interval = setInterval( async () => {
            const me = Symbol()
            try {
                await queue.wait(me)
                console.log('Start Monitor Job')
                await updateStatus();
    
            } finally {
                queue.end(me)
            }
            console.log('End Monitor Job')
        }, 1000 * 60)
        console.log("New Interval is ", interval)
        res.sendStatus(200)
    } else {
        console.log('Stop Monitoring')
        console.log("Existing Interval is ", interval)
        clearInterval(interval);
        interval = null;
        res.sendStatus(200)
    }
})

// const wait = async () => {
//     while (busy === true) {
//         console.log('Wait as some other process is running now')
//         await delay(1000);
//     }
//     console.log("Dont wait as server is free")
// }

const checkOpenPosition = async (openPositions: OptionPosition[]) => {
    for (const decision of decisionsList) {
        if (decision.autoSquareOff || decision.target || decision.stopLoss) {
            for (const openPosition of openPositions) {
                if (openPosition.contract.indexOf(decision.symbol) != -1) {
                    await squareOff(openPosition.contract);
                }
            }
        }
    }
}

app.get('/transact', async function (req, res) {
    // { action: OptionType.call, symbol: 'RELIND', lotSize: 250, strikePrice: 2000, expiryDate: '29-Jul-2021', executionPrice: 241}
    const decision = {} as Decision

    if (req.query.action) {
        decision.action = OptionType[req.query.action.toString()]
    } else {
        decision.action = OptionType.call
    }

    if (req.query.symbol) {
        decision.symbol = req.query.symbol.toString().toUpperCase()
    } else {
        decision.symbol = 'NIFTY'
    }

    if (req.query.lotCount) {
        decision.lotCount = Number.parseInt(req.query.lotCount.toString())
    } else {
        decision.lotCount = 4
    }

    if (req.query.depth) {
        decision.depth = Number.parseInt(req.query.depth.toString())
    } else {
        decision.depth = 2
    }

    if (req.query.strikePrice) {
        decision.strikePrice = Number.parseInt(req.query.strikePrice.toString())
    }

    if (req.query.expiryDate) {
        decision.expiryDate = req.query.expiryDate.toString().toUpperCase()
    }

    if (req.query.executionPrice) {
        decision.executionPrice = Number.parseInt(req.query.executionPrice.toString())
    }

    if (req.query.target) {
        decision.target = Number.parseInt(req.query.target.toString())
    }

    if (req.query.stopLoss) {
        decision.stopLoss = Number.parseInt(req.query.stopLoss.toString())
    }

    if (req.query.autoSquareOff) {
        decision.autoSquareOff = req.query.autoSquareOff.toString() === 'true'
    } else {
        decision.autoSquareOff = false
    }

    decisionsList.push(decision);
    console.log('Decision: ', decision)
    const me = Symbol()
    try {
        
        await queue.wait(me)
        console.log('Start Transaction')
        // const t = await execute(decision);
        console.log('End Transacion')
        res.sendStatus(200);
    } catch (error) {
        console.log("Error: ", error)
        res.sendStatus(500)
    } finally {
        queue.end(me)
    }
})

var server = app.listen(3000, function () {
    console.log('Icici server started ', server.address().toString())
})
