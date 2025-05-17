import Icici from '../trade/icici'
import stockPrice from './stock-strike-price'

import niftyPrice from './nifty-strike-price'

const t = async () => {
    try {
        const icici = await Icici.getInstance()
        await icici.saveStockQuotes()
        console.log('Stock Quotes are collected')
    } catch (e) {
        console.log(e)
    }
}

export const saveNiftyQuotes = async () => {
    const icici = await Icici.getInstance()
    await icici.saveNiftyQuotes(null)
}