import fs from 'fs'
import Icici from './trade/icici'
import cron from 'cron'
import Strategy from './trade/strategy/strategy'

import delay = require('delay')
import Signaler from 'scheduler/signaler'
import Option, { Decision } from './trade/option'



export const balanceTrade = async () => {
    const icici = await Icici.getInstance()
    try {
        console.log('Start Balance Trade strategy')
        const strategy = new Strategy(icici);
        await strategy.doBalanceTrade()

    } catch (e) {
        console.log(e)
        throw e;
    }
}

export const getNiftyQuote = async () => {
    console.log('Get Nifty Quote')
    let quote
    try {
        const icici = await Icici.getInstance();
        quote = await icici.getQuote('NIFTY');

    } catch (e) {
        console.log(e)
        throw e
    }
    return quote;
}

export const directionalTrade = async () => {
    console.log('Start Directional Trade strategy')
    try {
        const icici = await Icici.getInstance()
        const strategy = new Strategy(icici);
        await strategy.doDirectionalTrade()
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const getOpenPositions = async () => {
    console.log('Get Open Positions')
    const icici = await Icici.getInstance()
    console.log('Logged In')

    const openPositions = await icici.monitorOptionOpenPositions({ 'autoExecute': false });
    return openPositions;
}


export const execute = async (decision: Decision) => {
    const option = await Option.build()
    const status = await option.execute(decision)
    return { "status" : status };
}

export const squareOffOptionPlus = async () => {
    console.log('Square Off ')
    try {
        const icici = await Icici.getInstance()
        await icici.squareOffOptionPlusOpenPositions();
        console.log('Squared off')
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const getOptionPlusOpenPositions = async () => {
    console.log('Get Open Positions')

    try {
        const icici = await Icici.getInstance()
        const openPositions = await icici.getOptionPlusOpenPositions();
        console.log(openPositions)
        return openPositions
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const getNiftyQuotes = async () => {
    console.log('Get Nifty Quotes')
    try {
        const icici = await Icici.getInstance();
        const quotes = await icici.getNiftyQuotes();
        console.log(quotes)
        return quotes
        
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const squareOff = async (contract) => {
    console.log('Start Square Off')
    try {
        const icici = await Icici.getInstance()
        icici.squareOffOption(contract)
    } catch (e) {
        console.log(e)
        throw e
    }
}

export const virtual = () => {
}

export const writeObjects = async (objects, filename) => {
    try {
        if (fs.existsSync(filename)) {
            fs.unlinkSync(filename)
        }

        const writeStream = fs.createWriteStream(filename, { flags: 'a' });
        writeStream.write('sampleCount, change, profit, count, value, avg\n')

        objects.map(object => {
            writeStream.write(arrayToCSV(object) + '\n')
        })

    } catch (e) {
        console.log(e)
    }

}

function arrayToCSV(obj) {
    return `${Object.values(obj).map(value => `"${value}"`).join(",")}`;
}

