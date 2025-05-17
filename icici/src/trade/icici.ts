// Strategy:
// If direction is sure, go for option else go for option plus

import Browser from './browser.js';
import { Builder, By, until, Key, WebElement } from 'selenium-webdriver';
// import EventEmitter from 'events';
import delay from 'delay'
// import cheerio from 'cheerio'
import axios from 'axios'
import _ from 'lodash'
import icicinse from './icicinse'
import symbols from '../symbols'
import Mongo from '../tools/mongo'
import moment from 'moment'

export enum OptionType {
    call = 'CALL',
    put = 'PUT'
}

export class Decision {
    action: OptionType
    percent? // TODO, default should be 10, if market order should be 0

}
class StockQuote {
    symbol
    lastTradePrice
    dayOpen
    dayClose
    dayHigh
    dayLow
    dayPrevClose
    change
    changePercent
    dayVolume
    date
    time

}
class OptionQuote {
    lastTradePrice
    dayOpen
    dayHigh
    dayLow
    dayClose // Only for SpotPrice
    prevDayClose
    change // Only for SpotPrice
    changePercent
    qtyTraded
    type
    symbol
    strikePrice
    date
    time
}

class NiftyQuote {
    lastTradePrice
    // dayOpen
    // dayHigh
    // dayLow
    // dayClose // Only for SpotPrice
    // prevDayClose
    // change // Only for SpotPrice
    // changePercent
    // qtyTraded
    type
    price
    date
    time
}


class OptionPosition {
    contract
    position
    qty
    avgPrice
    ltp
}

class Quote {

    async extractQuote(symbol, rows, date, time) {
        const quote = new StockQuote()
        quote.symbol = symbol
        quote.lastTradePrice = await this.extract(rows, 0, 1)
        quote.dayOpen = await this.extract(rows, 1, 1)
        quote.dayClose = await this.extract(rows, 2, 1)
        quote.dayHigh = await this.extract(rows, 3, 1)
        quote.dayLow = await this.extract(rows, 4, 1)
        quote.dayPrevClose = await this.extract(rows, 5, 1)
        quote.change = await this.extract(rows, 6, 1)
        quote.changePercent = await this.extract(rows, 7, 1)
        quote.dayVolume = await this.extract(rows, 10, 1)
        quote.date = date
        quote.time = time
        return quote
    }


    async saveQuote(symbol, rows, date, time) {
        const quote = this.extractQuote(symbol, rows, date, time)
        await Mongo.getInstance().insert(quote)
        return quote

    }

    extract = async (rows, row, col) => {
        const cells = await rows[row].findElements(By.tagName("td"))
        return cells[col].getText()
    }

    close = async () => {
        Mongo.getInstance().close()
    }

}

class OptionOrder {
    action
    price
    status


    constructor(action, price, status) {
        this.action = action.trim()
        this.status = status.trim()
        this.price = price
    }
}

export default class Icici {
    browser: Browser
    //Karthik
    username = 'WK133843'
    password = 'nivi1000'
    dob = '31081975'

    //Raja
    // username = 'SESHA100'
    // password = 'nava1000'
    // dob = '22091943'
    myEmitter

    expiryDate = '30-Jul-2020'

    static instance: Icici = null

    static async getInstance() {

        if (!Icici.instance) {
            Icici.instance = new Icici(true);
            await Icici.instance.login();
        }
        return Icici.instance;
    }

    static async getUserInstance(user, password, dob) {
        Icici.instance = new Icici(false);
        Icici.instance.username = user
        Icici.instance.password = password
        Icici.instance.dob = dob
        await Icici.instance.login();
        return Icici.instance
    }

    static async restart() {
        console.log('Restart now')
        const icici = await Icici.getInstance();
        await icici.quit();
        delay(2000)
        console.log('Delay is over, create a new instance')
        Icici.instance = null;
        const newInstance = await Icici.getInstance()
    }

    constructor(headless?) {
        if (!Icici.instance) {
            this.expiryDate = moment().format('DD-MMM-yyyy').toString()
            console.log('Expiry Date ', this.expiryDate)
            console.log('Create a browser')
            this.browser = new Browser(headless)
            Icici.instance = this;
        }

        // this.myEmitter = new EventEmitter();
        // this.myEmitter.on('ordered', () => {

        //     // Only if there are open positions, monitor every minute, cancel once a profit order is placed
        //     setInterval(this.monitorMarginPlusOpenPositions, 15 * 1000)

        // })
    }

    login = async () => {
        // await this.browser.writeById('txtUserId', this.username)
        // await this.browser.writeById('txtPass', this.password)
        // await this.browser.writeById('txtDOB', this.dob)
        // await this.browser.clickById('Button1')


        await this.browser.visit('https://secure.icicidirect.com/trading/equity/cashbuy')
        const loginButtonAvailable = await this.browser.isElementPresent('btnlogin')
        console.log('loginButtonAvailable ', loginButtonAvailable)

        if (loginButtonAvailable) {
            console.log('Login Now as session not available')
            await this.browser.writeById('txtuid', this.username)
            await this.browser.writeById('txtPass', this.password)
            await this.browser.writeById('txtDOB', this.dob)
            await this.browser.clickById('btnlogin')
            console.log('Login button clicked')
        }

        await delay(1000)
    }

    print = async () => {
        await this.browser.takeScreenshot()
        await this.browser.html()
    }

    home = async () => {
        const home = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[1]/a'
        await this.browser.clickByXpath(home)
    }

    getNetWorth = async () => {
        const networth = '//*[@id="pnlQpnl"]/ul/li[6]/a'
        const amount = '//*[@id="MainSection"]/div/div[3]/table/tbody/tr/td/table/tbody/tr[3]/td[2]'
        await this.browser.clickByXpath(networth)
        const webElement = await this.browser.findByXpath(amount)
        return await this.getNumber(webElement)
    }

    iciciToNse = (symbol) => {

    }

    asyncForEach = async (array, callback) => {
        for (let index = 0; index < array.length; index++) {
            await callback(array[index], index, array);
        }
    }

    quit = async () => {
        console.log('Quit now')
        await this.browser.quit()
        Icici.instance = null;
    }

    getOptionQuote = async (type, expiryDate, strikePrice) => {

        const extract = async (rows, row, col) => {
            const cells = await rows[row].findElements(By.tagName("td"))
            return cells[col].getText()
        }

        const optionUrl = `https://secure.icicidirect.com/Trading/FNO/GetQuote/?FFO_XCHNG_CD=NFO&FFO_PRDCT_TYP=O&FFO_UNDRLYNG=NIFTY&FFO_EXPRY_DT=${expiryDate}&FFO_MIN_LOT_QTY=75&FFO_OPT_TYP=${type}&FFO_EXER_TYP=E&FFO_STRK_PRC=${strikePrice}00`
        await this.browser.openTab(optionUrl);
        await this.browser.switchTab()

        const pricePath = '//*[@id="dvdisplayGQ"]/div/div[1]/table/tbody/tr[1]/td[2]'

        const lastTradePrice = this.getNumber(await this.browser.findByXpath(pricePath))
        await this.browser.closeTab()
        return lastTradePrice
    }

    getQuote = async (symbol) => {

        try {
            
            const selector = 'txtsearch'
            const search = '//*[@id="pnlHeadLogin"]/div/div[2]/div[2]/ul/li[2]/div/span'

            await this.browser.clearAndWriteById(selector, symbol)
            await this.browser.clickByXpath(search)

            const symbolTextField = 'stcode'
            const refresh = 'hlnkref'
            const quoteTable = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody'
            const tradedDate = '//*[@id="pnlMain"]/div[1]/div[2]/table/tbody/tr[1]/td[2]'
            const tradedTime = '//*[@id="pnlMain"]/div[1]/div[2]/table/tbody/tr[2]/td[2]'
            const price = 'hprice'
            const change = '//*[@id="hprice"]/span[1]'

            // await delay(2000) - TODO why is this needed
            await this.browser.switchTab()

            //TODO commented clicking symbol again, may be required to get quote in a loop
            // console.log('Write symbol')
            // await this.browser.writeById(symbolTextField, symbol)
            // console.log('Click Refresh')
            // await this.browser.clickById(refresh)

            // const test = await this.browser.findById('pnlMain')
            console.log('Price')
            let element = await this.browser.findById(price)
            // const table = await this.browser.findByXpath(quoteTable)
            const quote = new StockQuote()
            quote.lastTradePrice = await this.getText(element);
            const x = /^(.+?)\n/
            quote.lastTradePrice = x.exec(quote.lastTradePrice)[0].trim()


            console.log('Change')
            element = await this.browser.findByXpath(change)
            quote.change = await this.getText(element);

            // const html = await table.getAttribute("innerHTML")
            // Now get all the TR elements from the table 

            // const rows = await table.findElements(By.tagName("tr"));
            // const now = new Date();
            // const date = moment(now).format('DD-MMM-YYYY')
            // const time = moment(now).format('HH:mm')
            // const quote = await new Quote().extractQuote(symbol, rows, date, time)
            // console.log('NIFTY ', quote.lastTradePrice)
            // if (quote.lastTradePrice == 'NA') {
            //     await Icici.restart()
            //     const icici = await Icici.getInstance()
            //     return await icici.getQuote(symbol)
            // }

            // quote.change = Number(quote.change.replace(',', ''));
            // quote.changePercent = Number(quote.changePercent.replace(',', ''));
            // quote.dayClose = Number(quote.dayClose.replace(',', ''));
            // quote.dayHigh = Number(quote.dayHigh.replace(',', ''));
            // quote.dayLow = Number(quote.dayLow.replace(',', ''));
            // quote.dayOpen = Number(quote.dayOpen.replace(',', ''));
            // quote.dayPrevClose = Number(quote.dayPrevClose.replace(',', ''));
            // quote.dayVolume = Number(quote.dayVolume.replace(',', ''));
            // quote.lastTradePrice = Number(quote.lastTradePrice.replace(',', ''));

            await this.browser.closeTab()
            return quote;

        } catch (e) {
            const canLoginAgain = await this.relogin(e)
            if (canLoginAgain) {
                const icici = await Icici.getInstance()
                return await icici.getQuote(symbol)
            }
        }
    }

    saveStockQuotes = async () => {

        const quoteDb = new Quote()
        let symbol = symbols[0]
        console.log('Symbol is ', symbol)

        //Read file
        //First element is symbol
        const selector = 'txtsearch'
        const search = '//*[@id="pnlMnuLogin"]/div/div[2]/ul/li[1]/div/span'

        await this.browser.writeById(selector, symbol)
        await this.browser.clickByXpath(search)
        const symbolTextField = 'stcode'
        const refresh = 'hlnkref'
        const quoteTable = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody'
        const tradedDate = '//*[@id="pnlMain"]/div[1]/div[2]/table/tbody/tr[1]/td[2]'
        const tradedTime = '//*[@id="pnlMain"]/div[1]/div[2]/table/tbody/tr[2]/td[2]'

        await delay(2000)
        await this.browser.switchTab()

        // Do Loop
        await this.asyncForEach(symbols, async (element) => {
            await this.browser.writeById(symbolTextField, element)
            await this.browser.clickById(refresh)

            const test = await this.browser.findById('pnlMain')
            const table = await this.browser.findByXpath(quoteTable)

            const html = await table.getAttribute("innerHTML")
            // Now get all the TR elements from the table 

            const rows = await table.findElements(By.tagName("tr"));
            const now = new Date();
            const date = moment(now).format('DD-MMM-YYYY')
            const time = moment(now).format('HH:mm')
            await quoteDb.saveQuote(element, rows, date, time)

        });
        await this.browser.closeTab()
        await quoteDb.close()
    }

    marginPlusBracketOrder = async (symbol, percent) => {
        const home = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[1]/a'
        await this.buyMarginPlus('buy', symbol, percent)
        await delay(1000)
        await this.browser.clickByXpath(home)
        await this.buyMarginPlus('sell', symbol, percent)
        await delay(1000)
    }

    cancelMarginOrders = async (forced?) => {
        console.log('Forced ', forced) //TODO what if there are open positions
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const orderBook = '//*[@id="pnlportmnusub"]/ul/li[5]/a'
        const orderTable = '//*[@id="TABLE_1"]'
        const confirm = 'Submit1'
        await this.browser.clickByXpath(portfolioDropDown)
        await this.browser.clickByXpath(orderBook)
        const tableElement = await this.browser.findElements(orderTable)
        const rows = await tableElement[1].findElements(By.css("tr"))
        const cancelSymbols = new Set()

        if (!forced) {
            const orderList = []

            //Find cancellable symbols
            for (let i = 0; i < rows.length; i++) {
                const row = await rows[i]
                const cells = await row.findElements(By.css('td'))
                if (cells.length < 5) {
                    continue
                }

                const symbolLabels = await cells[0].findElements(By.css('label'))
                const symbol = await symbolLabels[0].getAttribute('innerHTML')

                let statusHtml = await cells[11].getAttribute('innerHTML')
                statusHtml = statusHtml.trim()

                if (statusHtml === 'Cancelled&nbsp;') {
                    cancelSymbols.add(symbol.trim())
                }

                const status = statusHtml === 'Ordered&nbsp' ? 'Ordered' : 'Executed';

                const action = await cells[3].getAttribute('innerHTML')
                // const priceAnchor = await cells[4].findElements(By.css('a'))
                // const priceFont = await priceAnchor[0].findElements(By.css('font'))
                // let innerHTML = await priceFont[0].getAttribute('innerHTML')
                // let price = Number(innerHTML.replace(',', ''))

                // if (status === 'Executed') {
                //     await priceAnchor.click()
                //     const ltpXpath = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[1]/td[2]'
                //     const ltpValue = await this.browser.findByXpath(ltpXpath)
                //     console.log('LTP: ',  ltpValue.getAttribute('innerHTML'))
                // }


                // console.log(action.trim() , ' ' , symbol.trim(), ' Price ', price , 'Status ', status)
                console.log(symbol.trim(), ' ', statusHtml)
                // const actionAnchors = await cells[12].findElements(By.tagName('a'))
                // let cancelAnchor;
                // if (actionAnchors.length > 1) {
                //     console.log('Action Anchors length ', actionAnchors.length)
                //     if (actionAnchors.length > 2 ) { // Status is Ordered and can be cancelled
                //         cancelAnchor = actionAnchors[1]
                //     }
                // }
            }

        }

        console.log('Cancellable symbols ', cancelSymbols)
        //TODO What if already cancelled
        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            const cells = await row.findElements(By.css('td'))
            if (cells.length < 5) {
                continue
            }

            const symbolLabels = await cells[0].findElements(By.css('label'))
            let symbol = await symbolLabels[0].getAttribute('innerHTML')
            symbol = symbol.trim()

            console.log('Symbol: ', symbol)
            if (forced || cancelSymbols.has(symbol)) {

                const actionAnchors = await cells[12].findElements(By.tagName('a'))
                let cancelAnchor;
                if (actionAnchors.length > 1) {
                    if (actionAnchors.length > 2) { // Status is Ordered and can be cancelled = 0; 
                        for (cancelAnchor of actionAnchors) {
                            const innerHTML = await cancelAnchor.getAttribute('innerHTML')
                            // console.log('Cancel ', innerHTML)
                            if (innerHTML === 'Cancel') {
                                await cancelAnchor.click()
                                await this.browser.clickById(confirm)
                                await this.home()
                                await delay(500)
                                await this.cancelMarginOrders() //TODO, not working to cancel in next iteration
                            }
                        }
                    }
                }
            }
        }
    }

    buyMarginPlus = async (action, symbol, percent) => {
        const stopLossPercent = 2
        const marginPlusMenu = '//*[@id="pnltrnmnu"]/ul/li[7]/a'
        const stock = 'stcode'
        const buy = '//*[@id="pnltabtrans"]/div/div[4]/div/label'
        const sell = '//*[@id="pnltabtrans"]/div/div[4]/div/span/label'
        const market = '//*[@id="pnltabtrans"]/div/div[5]/div/label'
        const limit = '//*[@id="pnltabtrans"]/div/div[5]/div/span/label'
        const limitPrice = 'mMarginPlusLmtRate'

        const qty = 'FML_QTY'
        const stopLossPrice = 'FML_ORD_STP_LSS'
        const submitButton = '//*[@id="pnltabtrans"]/div/div[14]/input'
        const proceedButton = 'btneqprocess'

        await this.browser.clickByXpath(marginPlusMenu)

        await this.browser.writeById(stock, symbol)

        const nsePrice = '//*[@id="dvStockVal"]/div[2]/div[1]/span[2]'
        const priceTag = await this.browser.findByXpath(nsePrice)

        const priceHtml = await priceTag.getAttribute("innerHTML")

        let price = Number(priceHtml.replace(',', ''))

        if (action === 'buy') {
            price = this.reducePercent(price, percent)
            await this.browser.clickByXpath(buy)

        } else {
            price = this.addPercent(price, percent)
            await this.browser.clickByXpath(sell)
        }

        if (price) {
            await this.browser.clickByXpath(limit)
            await this.browser.writeById(limitPrice, price)
        } else {
            await this.browser.clickByXpath(market)
        }

        await this.browser.writeById(qty, 1000) // TODO Hardcoded to 1000 qty always


        if (action === 'buy') {
            price = this.reducePercent(price, stopLossPercent)
        } else {
            price = this.addPercent(price, stopLossPercent)
        }

        await this.browser.writeById(stopLossPrice, price)
        await delay(1000)
        await this.browser.clickByXpath(submitButton)
        await delay(1000)
        this.browser.clickById(proceedButton)
    }

    monitorMarginPlusOpenPositions = async () => {
        //TODO if one side of transaction is closed, cancel other ones 

        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a'
        const marginPlusOpenPositions = '//*[@id="pnlctlLeft1"]/div/div/div[1]/ul/li[2]/a'
        const profitLimitPrice = 'FML_ORD_LMT_RT'
        const submitButton = 'Submit1'
        const proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input'
        const orderNow = 'Submit'

        this.browser.clickByXpath(portfolioDropDown)
        this.browser.clickByXpath(openPositions)
        this.browser.clickByXpath(marginPlusOpenPositions)

        await delay(3000)

        const element = await this.browser.findByXpath('//*[@id="pnlmargin_plus"]/div/table')

        const rows = await element.findElements(By.tagName("tr"))

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            const cells = await row.findElements(By.tagName('td'))
            if (cells.length < 5) {
                continue
            }

            let innerHtml = await cells[3].getAttribute('innerHTML')
            const executedPrice = Number(innerHtml.replace(',', ''))

            innerHtml = await cells[1].getAttribute('innerHTML')
            const executedAction = innerHtml.trim()

            innerHtml = await cells[10].getAttribute('innerHTML')
            const pl = Number(innerHtml.replace(',', ''))

            //Execute Market Order
            if (pl > 1500) { // TODO Hard-coded potentially can miss higher profit
                console.log('Do a Market Square Off ')

                const anchors = await cells[14].findElements(By.css('a'))
                await anchors[0].click()
                await delay(1000)
                await this.browser.clickById(orderNow)
                await delay(1000)
                await this.browser.clickByXpath(proceedButton)
                await delay(1000)
                await this.monitorMarginPlusOpenPositions()
                //TODO did not execute 2nd market order
            } else {
                console.log('Place Profit Order')

                // Place Profit Order
                const anchors = await cells[8].findElements(By.css('a'))
                if (anchors.length === 1) {
                    //TODO state is changed 

                    await anchors[0].click()
                    const newPrice = executedAction === 'Buy' ? this.addPercent(executedPrice, 0.5) : this.reducePercent(executedPrice, 0.5)// TODO Hard coded to 0.5%, so less
                    await this.browser.writeById(profitLimitPrice, newPrice)
                    await this.browser.clickById(submitButton)
                    await this.browser.clickByXpath(proceedButton)
                    await delay(500)
                    await this.monitorMarginPlusOpenPositions() //TODO
                    //SLTP-Profit order limit price difference is less than the defined value.: It should differ by atleast 0.35 percentage
                }
            }
        }
    }

    addPercent = (value, percent) => {
        return Math.round((value + ((percent / 100) * value)) * 10) / 10
    }

    reducePercent = (value, percent) => {
        return Math.round((value - ((percent / 100) * value)) * 10) / 10
    }

    monitorMarginOpenPositions = async () => {
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a'
        const openMarginTable = '//*[@id="dvorddtl"]/div/table[2]'
        const profitLimitPrice = 'FML_ORD_LMT_RT'
        const sqoffQty = 'FML_SQROFF'
        const submitButton = 'Submit1'
        const proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input'

        this.browser.clickByXpath(portfolioDropDown)
        this.browser.clickByXpath(openPositions)
        await delay(3000)
        const element = await this.browser.findByXpath(openMarginTable)

        const rows = await element.findElements(By.tagName("tr"))

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            const cells = await row.findElements(By.tagName('td'))

            if (cells.length < 5) {
                continue
            }

            let innerHTML = await cells[10].getAttribute('innerHTML')
            const plPrice = Number(innerHTML.replace(',', ''))
            innerHTML = await cells[6].getAttribute('innerHTML')
            const avgPrice = Number(innerHTML.replace(',', ''))

            const anchors = await cells[13].findElements(By.tagName('a'))

            if (anchors.length > 2) {
                await anchors[1].click(); // square off 
                await delay(2000)
                await this.browser.writeById(sqoffQty, 1000) //TODO Hardcoded to 1000
                await this.browser.writeById(profitLimitPrice, (avgPrice + 1)) //TODO Hardcoded to 1 rupee fro TATMOT
                await this.browser.clickById(submitButton)
                await this.browser.clickByXpath(proceedButton)
                await this.monitorMarginOpenPositions()
            }

            //TODO Cannot cancel stoploss order, have to execute profitOrder.
            //TODO Have to do placeProfitOrder considering both legs


        }
    }



    monitorOptionPlusOpenPositions = async () => {

        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a'
        const fnoMenu = '//*[@id="pnlMainRow"]/span/div/div[1]/ul/li[2]/a'
        const optionPlus = '//*[@id="pnlctlLeft1"]/span/div/div/ul/li[5]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table'
        const submitButton = 'Submit1'
        const proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input'

        await this.browser.clickByXpath(portfolioDropDown)
        await this.browser.clickByXpath(openPositions)
        await delay(2000)
        await this.browser.clickByXpath(fnoMenu)
        await delay(2000)
        await this.browser.clickByXpath(optionPlus)

        await delay(3000)

        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
            }

            const innerHtml = await cells[10].getAttribute('innerHTML')
            const plprice = Number(innerHtml.replace(',', ''))
            console.log('plPrice ', plprice)

            if (plprice > 500) { //TODO hard-coded to 500 for 1 lot
                const anchors = await cells[7].findElements(By.tagName('a'))

                if (anchors.length > 1) {
                    // anchors[1].click() // TODO Click Square off at Market
                }
            }

            // const anchors = await cells[8].findElements(By.tagName('a'))
            //     let innerHtml = await cells[3].getAttribute('innerHTML')
            //     const currentPrice = Number(innerHtml.replace(',', ''))
            // 
            //     

            //     if (anchors.length === 1) {
            //         //TODO state is changed 
            //         
            //         await anchors[0].click()

            //         
            //         await this.browser.writeById(profitLimitPrice, (currentPrice + 2))

            //         
            //         await this.browser.clickById(submitButton)

            //         
            //         await this.browser.clickByXpath(proceedButton)

            //         

            //         
            //         await this.monitorMarginPlusOpenPositions()

            //     }
        }
    }


    getNiftyQuotes = async () => {
        const quotes: NiftyQuote[] = []
        console.info('Get Nifty Quotes')
        const now = new Date();
        const date = moment(now).format('DD-MMM-YYYY')
        const time = moment(now).format('HH:mm')

        Mongo.init()

        const processContracts = async (optionType) => {
            await this.browser.selectOpton('optmonth', 2)
            delay(1000)

            const ootmPath = '//*[@id="FilteringOption"]/ul/li[2]/a'
            await this.browser.clickByXpath(ootmPath)
            const contracts = await this.browser.findById(contractsList)

            // const rows = await contracts.findElements(By.tagName("tr"))
            // const rows = await contracts.findElements(By.css("tr[style=background-color: rgb(255, 255, 255);]"))
            const rows = await contracts.findElements(By.xpath("//tr[not(contains(@style, 'display: none'))]"))
            // const rows = contracts.findElements(By.css('//tr[not(contains(@style,"display:none"))]'))


            for (let i = 0; i < rows.length; i++) {
                // const row = await rows[i].getAttribute('innerHTML')
                const row = await rows[i];
                const cells = await rows[i].findElements(By.tagName('td'))

                if (cells.length < 7) {
                    continue;
                }

                const dateString = await this.getText(cells[1])

                if (dateString == this.expiryDate) {
                    const strikePrice = await this.getNumber(cells[2])
                    const anchorElements = await cells[4].findElements(By.css('a'))
                    const ltp = await this.getNumber(anchorElements[0])
                    // if (ltp > 5) {
                    const quote = new NiftyQuote()
                    quote.type = `${optionType}_${strikePrice}`;
                    quote.price = ltp
                    quote.date = date
                    quote.time = time
                    quotes.push(quote)

                    // }
                }
            }
        }

        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const placeOrder = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[2]/a'
        const optionMenu = '//*[@id="pnlOrdMnu"]/ul/li[5]/a'
        const selectContract = '//*[@id="SelContract"]/li[1]/a'
        const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
        const contractsList = 'contList'

        const call = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[1]'
        const put = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[2]'
        const stock = 'FFO_UNDRLYNG'

        console.log('Click fnoMenu')
        await this.browser.clickByXpath(fnoMenu)

        console.log('Click placeOrder')
        await this.browser.clickByXpath(placeOrder)

        console.log('Click optionMenu')
        await this.browser.clickByXpath(optionMenu)

        await delay(2000)
        console.log('Click call')
        await this.browser.clickByXpath(call)

        await this.browser.writeById(stock, 'NIFTY')
        try {
            await this.browser.clickByXpath(selectContract)
        } catch (e) {
            console.log('What is the message ???? ', e.message)
            //TODO make it as a function and call in a loop
            if (e.message.includes('Please select Option Type.')) {
                console.log('Trying again as option is not selected')
                await this.browser.clickByXpath(call)
                await this.browser.clickByXpath(selectContract)
            }
        }


        const spotPriceAnchor = await this.browser.findByXpath(spotPrice)
        const ltp = await this.getNumber(spotPriceAnchor);
        const quote = new NiftyQuote()
        quote.type = `Spot`;
        quote.price = ltp
        quote.date = date
        quote.time = time
        quotes.push(quote)


        await processContracts('Call')
        console.log('Call is Processed')

        //Put Contracts
        console.log('Click Put')
        await delay(2000)
        await this.browser.clickByXpath(put)

        console.log('Select Contract')
        await this.browser.clickByXpath(selectContract)
        await delay(1000)

        console.log('Start Processing Put Contracts')
        await processContracts('Put')
        Mongo.getInstance().close()

        console.log('Option Quotes are extracted')
        return quotes
    }


    getOptionOpenPositions = async () => {

        //*[@id="pnlmnuprod"]/div/ul/li[3]/a

        const positions = [] as Array<OptionPosition>
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[4]/a'
        const optionPlus = '//*[@id="pnlctlLeft1"]/div/div/ul/li[5]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table/tbody'

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(openPositions)
        await this.browser.clickByXpath(optionPlus)
        await delay(2000)

        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells: WebElement[] = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
                console.log('Column ', j, await cells[j].getAttribute('innerHTML'));
            }
            console.log('Contract ', await this.getText(cells[0]))
            console.log('Qty ', await this.getText(cells[2]))
            console.log('Price ', await this.getText(cells[3]))
            const ltps = await cells[9].findElements(By.css('a'))
            console.log('CMP ', await this.getText(ltps[0]))
            console.log('PL ', await this.getText(cells[10]))

            const openPosition = new OptionPosition;
            positions.push(openPosition)
            openPosition.contract = await this.getText(cells[0]);
            openPosition.qty = await this.getText(cells[2])
            openPosition.avgPrice = await this.getText(cells[3])
            openPosition.ltp = await this.getText(ltps[0])
            console.log('Open Positions ', positions);

        }
        return positions;
    }

    getOptionPlusOpenPositions = async () => {

        //*[@id="pnlmnuprod"]/div/ul/li[3]/a

        const positions = [] as Array<OptionPosition>
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[4]/a'
        const optionPlus = '//*[@id="pnlctlLeft1"]/div/div/ul/li[5]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table/tbody'

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(openPositions)
        await this.browser.clickByXpath(optionPlus)
        await delay(2000)

        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells: WebElement[] = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
                console.log('Column ', j, await cells[j].getAttribute('innerHTML'));
            }
            console.log('Contract ', await this.getText(cells[0]))
            console.log('Qty ', await this.getText(cells[2]))
            console.log('Price ', await this.getText(cells[3]))
            const ltps = await cells[9].findElements(By.css('a'))
            console.log('CMP ', await this.getText(ltps[0]))
            console.log('PL ', await this.getText(cells[10]))

            const openPosition = new OptionPosition;
            positions.push(openPosition)
            openPosition.contract = await this.getText(cells[0]);
            openPosition.qty = await this.getText(cells[2])
            openPosition.avgPrice = await this.getText(cells[3])
            openPosition.ltp = await this.getText(ltps[0])
            console.log('Open Positions ', positions);

        }
        return positions;
    }


    squareOffOptionPlusOpenPositions = async () => {

        //*[@id="pnlmnuprod"]/div/ul/li[3]/a

        const positions = [] as Array<OptionPosition>
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[4]/a'
        const optionPlus = '//*[@id="pnlctlLeft1"]/div/div/ul/li[5]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table/tbody'
        const proceedButton = 'Submit'

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(openPositions)
        await this.browser.clickByXpath(optionPlus)
        await delay(2000)

        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells: WebElement[] = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
                console.log('Column ', j, await cells[j].getAttribute('innerHTML'));
            }
            console.log('Contract ', await this.getText(cells[0]))
            console.log('Qty ', await this.getText(cells[2]))
            console.log('Price ', await this.getText(cells[3]))
            const ltps = await cells[9].findElements(By.css('a'))
            console.log('CMP ', await this.getText(ltps[0]))
            console.log('PL ', await this.getText(cells[10]))
            const actions = await cells[7].findElements(By.css('li:nth-child(2) a'))
            console.log('Actions ', actions)

            await actions[0].click()
            await delay(2000)
            await this.browser.clickById(proceedButton)
            return
        }
    }

    monitorOptionOpenPositions = async (options: any) => {

        const positions = [] as Array<OptionPosition>
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a'
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[4]/a'
        const option = '//*[@id="pnlctlLeft1"]/span/div/div/ul/li[4]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table'
        const submitButton = 'Submit1'
        const proceedButton = 'btneqprocess'

        const profitLimitPrice = 'FFO_LMT_RT'
        const limitQty = 'FFO_SQROFF'

        //*[@id="pnlmnuprod"]/div/ul/li[4]/a

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(openPositions)
        await delay(2000)
        await this.browser.clickByXpath(fnoMenu)
        await delay(2000)
        await this.browser.clickByXpath(option)

        await delay(3000)

        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells: WebElement[] = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
                // console.log('Column ', j, await cells[j].getAttribute('innerHTML'));
            }

            const openPosition = new OptionPosition;
            positions.push(openPosition)
            openPosition.contract = await this.getText(cells[0]);
            openPosition.qty = await this.getNumber(cells[3]);
            const position = await this.getText(cells[2]);
            openPosition.position = position;
            console.log('Position ', position);

            const avgPrice = await this.getNumber(cells[4]);
            openPosition.avgPrice = avgPrice
            console.log('Avg Price ', avgPrice);

            const anchors = await cells[10].findElements(By.tagName('a'))
            const ltp = await this.getNumber(anchors[0])
            openPosition.ltp = ltp
            const plprice = (ltp - avgPrice)
            console.log('Profit Price ', plprice)

            if ((plprice > 2) || (plprice < -2)) { //TODO hard-coded to 2 for 1 lot
                //TODO Execute market order
                const anchors = await cells[11].findElements(By.tagName('a'))
                if (anchors.length > 1) {
                    if (options.autoExecute) {
                        console.log('Execute market order')
                        await anchors[1].click()
                        await this.browser.clickById(proceedButton)
                    }
                }
            } else {
                console.log('Execute Square off now ')
                const anchors = await cells[11].findElements(By.tagName('a'))

                console.log('Anchors length ', anchors.length)
                if (anchors.length > 1) {

                    let proposedPrice = (avgPrice + 1)
                    console.log("Proposed price ", proposedPrice)
                    if (proposedPrice < plprice) {
                        proposedPrice = plprice
                    }
                    console.log("Adjusted Proposed price ", proposedPrice)
                    //TODO execute
                    if (options.autoExecute) {
                        await anchors[0].click()
                        await this.browser.writeById(profitLimitPrice, proposedPrice)
                        await this.browser.writeById(limitQty, 300) // TODO Hardcoded to 300
                        await this.browser.clickById(submitButton)
                        await this.browser.clickById(proceedButton)
                    }
                }
            }
        }
        return positions;
    }

    getOptionOpenPositionsOld = async () => {

        const positions = [] as Array<OptionPosition>
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[4]/a'
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const option = '//*[@id="pnlctlLeft1"]/div/div/ul/li[4]/a'
        const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table'
        const submitButton = 'Submit1'
        const proceedButton = 'btneqprocess'

        const profitLimitPrice = 'FFO_LMT_RT'
        const limitQty = 'FFO_SQROFF'

        console.log('Click fnoMenu')
        await this.browser.clickByXpath(fnoMenu)
        console.log('Click Open Positions')
        await this.browser.clickByXpath(openPositions)
        console.log('Click Option Menu')
        await this.browser.clickByXpath(option)
        await delay(2000)


        const element = await this.browser.findByXpath(optionPlusTable)

        const rows = await element.findElements(By.tagName("tr"))
        console.log('Open Positions Rows length ', rows.length)

        for (let i = 0; i < rows.length; i++) {
            const row = await rows[i]
            // 
            const cells: WebElement[] = await row.findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue
            }

            for (let j = 0; j < cells.length; j++) {
                // console.log('Column ', j, await cells[j].getAttribute('innerHTML'));
            }

            const openPosition = new OptionPosition;
            positions.push(openPosition)
            openPosition.contract = await this.getText(cells[0]);
            openPosition.qty = await this.getNumber(cells[3]);
            const position = await this.getText(cells[2]);
            openPosition.position = position;
            console.log('Position ', position);

            const avgPrice = await this.getNumber(cells[4]);
            openPosition.avgPrice = avgPrice
            console.log('Avg Price ', avgPrice);

            const anchors = await cells[10].findElements(By.tagName('a'))
            const ltp = await this.getNumber(anchors[0])
            openPosition.ltp = ltp
            const plprice = (ltp - avgPrice)
            console.log('Profit Price ', plprice)
        }
        return positions;
    }

    squareOffOption = async (contract) => {
        //TODO check login
        try {
            const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
            const openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a'
            const fnoMenu = '//*[@id="pnlMainRow"]/span/div/div[1]/ul/li[2]/a'
            const option = '//*[@id="pnlctlLeft1"]/span/div/div/ul/li[4]/a'
            const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table'
            const submitButton = 'Submit1'
            const proceedButton = 'btneqprocess'

            const profitLimitPrice = 'FFO_LMT_RT'
            const limitQty = 'FFO_SQROFF'

            await this.browser.clickByXpath(portfolioDropDown)
            await this.browser.clickByXpath(openPositions)
            await delay(2000)
            await this.browser.clickByXpath(fnoMenu)
            await delay(2000)
            await this.browser.clickByXpath(option)

            await delay(3000)

            const element = await this.browser.findByXpath(optionPlusTable)

            const rows = await element.findElements(By.tagName("tr"))
            console.log('Open Positions Rows length ', rows.length)

            for (let i = 0; i < rows.length; i++) {
                const row = await rows[i]
                const cells: WebElement[] = await row.findElements(By.tagName('td'))

                if (cells.length < 7) {
                    continue
                }

                const thisContract = await this.getText(cells[0]);
                if (contract == thisContract) {
                    const anchors = await cells[11].findElements(By.tagName('a'))
                    if (anchors.length > 1) {
                        console.log('Execute market order')
                        await anchors[1].click()
                        console.log('Click Proceed Button')
                        await this.browser.clickById(proceedButton)
                        console.log('Executed Square off')
                    }
                }

            }
        } catch (e) {
            const canLoginAgain = await this.relogin(e)
            if (canLoginAgain) {
                const icici = await Icici.getInstance()
                return await icici.squareOffOption(contract)
            }
        }
    }

    // buyMarginBroker = async(symbol) => {
    //     const marginBuyMenu = '//*[@id="pnltrnmnu"]/ul/li[5]/a'
    //     const marginSellMenu = '//*[@id="pnltrnmnu"]/ul/li[6]/a'
    //     const nse = '//*[@id="pnltabtrans"]/div/div[1]/div[1]/label'
    //     const broker = '//*[@id="pnlSqmode"]/div/label'
    //     const stockCode = 'stcode'
    //     const limit = '//*[@id="pnltabtrans"]/div/div[4]/div/span/label'
    //     const limitPrice = 'FML_ORD_LMT_RT'
    //     const market = '//*[@id="pnltabtrans"]/div/div[4]/div/label'
    //     const amount = 'txtamount'
    //     const buyButton = '//*[@id="pnltabtrans"]/div/div[9]/input'
    //     const proceedButton = 'btneqprocess'

    //     await this.browser.clickByXpath(marginBuyMenu)
    //     await this.browser.clickByXpath(nse)
    //     delay(2000)
    //     await this.browser.clickByXpath(broker)
    //     await this.browser.writeById(stockCode, symbol)
    //     await this.browser.clickByXpath(limit)
    //     const quote = await this.getQuoteIncorrect(symbol)
    //     const price = quote.lastTradePrice - 2 //TODO should be 2%
    //     await this.browser.writeById(limitPrice, price)
    //     await this.browser.writeById(amount, 10000) // TODO Hardcoded to 10000
    //     delay(2000)
    //     await this.browser.clickByXpath(buyButton)
    //     await this.browser.clickById(proceedButton)

    // }

    isThereActiveOptionPlusOrder = async () => {
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const orderBook = '//*[@id="pnlportmnusub"]/ul/li[5]/a'
        const fno = '//*[@id="order_book"]/div/ul/li[2]/a'

        const productDropDown = '//*[@id="FFO_PRDCT_TYP-button"]/span[1]'
        const optionPlus = 'ui-id-9'
        const viewButton = 'Go'
        const orderTable = '//*[@id="gridSource"]/tbody'

        await this.browser.clickByXpath(portfolioDropDown)
        await this.browser.clickByXpath(orderBook)
        await this.browser.clickByXpath(fno)
        await this.browser.clickByXpath(productDropDown)
        await this.browser.clickById(optionPlus)
        await this.browser.clickById(viewButton)
        await delay(2000)
        const orders = await this.browser.findByXpath(orderTable)

        const rows = await orders.findElements(By.tagName("tr"))
        for (let i = 0; i < rows.length; i++) {
            const cells = await rows[i].findElements(By.tagName('td'))


            if (cells.length < 7) {
                continue;
            }
            const status = await cells[4].getAttribute('innerHTML')

            if (status.trim() === 'Ordered') {

                return true
            }
        }
        return false;
    }

    buyOptionPlus = async (decision: Decision) => {
        const cashBuy = '//*[@id="qldata"]/ul/li[1]/a'
        const fnoMenu = '//*[@id="ulprodmnu"]/li[3]/a'

        const optionPlusMenu = '//*[@id="pnlOrdMnu"]/ul/li[5]/a'
        const selectContract = '//*[@id="SelContract"]/li[1]/a'
        const outOfTheMoney = '//*[@id="FilteringOption"]/ul/li[2]/a'
        const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
        const contractsList = 'contList'
        const call = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[1]'
        const put = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[2]'
        const stock = 'FFO_UNDRLYNG'
        const buy = '//*[@id="pnltabtrans"]/div[1]/div[5]/div/label[1]'
        const sell = '//*[@id="pnltabtrans"]/div[1]/div[5]/div/label[2]'
        const qty = 'FFO_QTY'
        const market = '//*[@id="pnltabtrans"]/div[1]/div[8]/div/label'
        const limit = '//*[@id="pnltabtrans"]/div[1]/div[8]/div/span/label'
        const limitPrice = 'FreshFFO_LMT_RT'
        const stopLossPrice = 'FFO_STP_LSS_TGR'
        const submitButton = 'Submit'
        const proceedButton = 'smt'


        console.log('Click Cash Buy')
        await this.browser.clickByXpath(cashBuy)

        console.log('Click FNOMenu')
        await this.browser.clickByXpath(fnoMenu)

        console.log('Click OptionPlusMenu')
        await this.browser.clickByXpath(optionPlusMenu)
        delay(1000)
        if (decision.action == OptionType.call) {
            console.log('Click Call ')
            await this.browser.clickByXpath(call)
        } else {
            console.log('Click Put ')
            await this.browser.clickByXpath(put)
        }
        delay(1000)

        console.log('Enter Nifty')
        await this.browser.writeById(stock, 'NIFTY')

        console.log('Click Select Contract')
        await this.browser.clickByXpath(selectContract)
        await this.browser.clickByXpath(outOfTheMoney)

        const contracts = await this.browser.findById(contractsList)
        const rows = await contracts.findElements(By.xpath("//tr[not(contains(@style, 'display: none'))]"))

        let anchors;
        let ltp;
        let innerHtml
        for (let i = 0; i < rows.length; i++) {
            // const row = await rows[i].getAttribute('innerHTML')
            const cells = await rows[i].findElements(By.tagName('td'))

            if (cells.length < 7) {
                continue;
            }

            innerHtml = await cells[2].getAttribute('innerHTML')

            const thisContractPrice = Number(innerHtml.replace(',', ''))

            break;
        }

        await anchors[0].click() //TODO Decide between buy and sell - always buy for now
        await this.browser.writeById(qty, 300) //TODO always 4 lot
        await this.browser.clickByXpath(limit) //TODO always limit

        let element = await this.browser.findById('GQStkPrice')
        ltp = await this.getNumber(element)

        const lessPercent = this.reducePercent(ltp, decision.percent)
        await this.browser.writeById(limitPrice, lessPercent) //TODO what should be the price ??
        await this.browser.writeById(stopLossPrice, lessPercent - 3) //TODO always less than by 2 as it will be converted to less than 10
        await delay(1000)
        await this.browser.clickById(submitButton)
        await delay(1000)
        await this.browser.clickById(proceedButton)
    }

    buyOption = async (decision: Decision) => {
        try {
            console.log('Decision ', decision)
            const clickOptionType = async () => {
                if (decision.action == OptionType.call) {
                    await this.browser.clickByXpath(call)
                } else {
                    await this.browser.clickByXpath(put)
                }

            }

            const selectContract = async () => {
                console.log('Click Select Contract')
                await this.browser.clickByXpath('//*[@id="SelContract"]/li[1]/a')

                let flag = true

                while (flag) {
                    try {
                        flag = false
                        console.log('Select Contract is clicked')
                    } catch (e) {
                        if (e.message.includes('Please select Option Type.')) {
                            console.log('Have to select an option type')
                            clickOptionType()
                        } else {
                            flag = false
                            console.log('Problem ', e)
                        }
                    }
                }
            }

            const cashBuy = '//*[@id="qldata"]/ul/li[1]/a'
            const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'

            const placeOrder = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[2]/a'
            const optionsMenu = '//*[@id="pnlOrdMnu"]/ul/li[4]/a'
            const outOfTheMoney = '//*[@id="FilteringOption"]/ul/li[2]/a'
            const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
            const contractsList = 'contList'
            const call = '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'
            const put = '//*[@id="divFastBuySell"]/div/div[2]/div/label[2]'
            const stock = 'FFO_UNDRLYNG'
            const buy = '//*[@id="divFastBuySell"]/div/div[4]/div/label[1]'
            const sell = '//*[@id="divFastBuySell"]/div/div[4]/div/label[2]'
            const qty = 'FFO_QTY'
            const market = '//*[@id="divFastBuySell"]/div/div[7]/div/label'
            const limit = '//*[@id="divFastBuySell"]/div/div[7]/div/span/label'

            const limitPrice = 'FFO_LMT_RT'
            const stopLossPrice = 'FFO_STP_LSS_TGR'
            const submitButton = 'Submit1'
            const proceedButton = 'Submit'

            console.log('Click FNOMenu')
            await this.browser.clickByXpath(fnoMenu)

            console.log('Click Place Order ')
            await this.browser.clickByXpath(placeOrder)
            await this.browser.clickByXpath(optionsMenu)
            await this.browser.writeById(stock, 'NIFTY')
            await clickOptionType()
            await selectContract()
            await this.browser.clickByXpath(outOfTheMoney)

            //If an alert error is thrown select an option type and click select contract again
            console.log('Find SpotPrice')
            let element = null
            try {
                element = await this.browser.findByXpath(spotPrice)
            } catch (e) {
                if (e.message.includes('Please select Option Type.')) {
                    console.log('Have to select an option type')
                    await clickOptionType()
                    await selectContract()
                }
            }

            element = await this.browser.findByXpath(spotPrice)
            let innerHtml = await element.getAttribute('innerHTML')
            const currentPrice = Number(innerHtml.replace(',', ''))

            const contracts = await this.browser.findById(contractsList)
            const rows = await contracts.findElements(By.xpath("//tr[not(contains(@style, 'display: none'))]"))

            let anchors;
            let ltp;
            console.log('Rows length ', rows.length)
            for (let i = 0; i < rows.length; i++) {
                // const row = await rows[i].getAttribute('innerHTML')
                let cells = await rows[i].findElements(By.tagName('td'))
                if (cells.length < 7) {
                    continue;
                }

                for (let j = 0; j < cells.length; j++) {
                    console.log('Col ', j, ' value ', await cells[j].getAttribute('innerHTML'))
                }

                anchors = await cells[8].findElements(By.css('a'))
                await anchors[0].click()
                break;
                let innerHtml = await cells[3].getAttribute('innerHTML')
                const thisContractPrice = Number(innerHtml.replace(',', ''))
            }

            element = await this.browser.findById('GQStkPrice')
            ltp = await this.getNumber(element)

            console.log('Write Quantity')
            await this.browser.writeById(qty, 75) //TODO always 4 lot

            console.log('Click Limit')
            await this.browser.clickByXpath(limit) //TODO always limit
            console.log('LTP ', ltp, ' Percent ', decision.percent)
            const lessPercent = this.reducePercent(ltp, decision.percent)
            console.log('LessPercent ', lessPercent)

            console.log('Write Limit Price')
            await this.browser.writeById(limitPrice, lessPercent) //TODO what should be the price ??
            await delay(1000)
            console.log('Click Submit Button')
            await this.browser.clickById(submitButton)
            await delay(1000)
            console.log('Click Proceed Button')
            // await this.browser.clickById(proceedButton)
            //TODO need to check if proceed is successful

            // const notSubmitted = await this.browser.isElementPresent('smereduce')
            // if (notSubmitted) {
            //     //TODO have custom error classes
            //     await this.browser.esc();
            //     throw new Error('Money is not available')
            // }
            // console.log(decision, ' is executed at ', lessPercent)
        } catch (e) {
            const canLoginAgain = await this.relogin(e)
            if (canLoginAgain) {
                const icici = await Icici.getInstance()
                return await icici.buyOption(decision)
            } else {
                throw e
            }
        }
    }


    getOptionOrders = async () => {

        //TODO make it as an array of object
        const seleniumTasks: string[][] = [
            ['clickbyxpath', 'Click FNO Menu', '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'],
            ['clickbyxpath', 'Click Order Book', '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[5]/a'],
            ['clickbyxpath', 'Click Future Product', '//*[@id="FFO_PRDCT_TYP-button"]/span[2]'],
            ['clickbyselector', 'Select Option', '#FFO_PRDCT_TYP-menu li:nth-child(4)'],
            ['clickById', 'Click View', 'Go'],
            ['wait', 'Wait ', '2'],
            ['tbody', 'Get Rows', '//*[@id="gridSource"]/tbody']

        ];

        const optionOrders: OptionOrder[] = []

        for (let i = 0; i < seleniumTasks.length; i++) {
            const task = seleniumTasks[i]
            const type = task[0];
            console.log(task[1])
            switch (type) {
                case 'clickbyxpath':
                    await this.browser.clickByXpath(task[2]);
                    break;
                case 'clickById':
                    await this.browser.clickById(task[2]);
                    break;
                case 'clickbyselector':
                    await this.browser.clickBySelector(task[2]);
                    break;
                case 'wait':
                    await delay(2000)
                    break;

                case 'tbody':
                    const orders = await this.browser.findByXpath(task[2]);
                    const rows = await this.browser.wait(orders, 2)


                    for (let i = 0; i < rows.length; i++) {
                        const row = await rows[i]
                        const cells = await row.findElements(By.css('td'))

                        if (cells.length > 5) {
                            const action = await this.getText(cells[2])
                            const status = await cells[4].getText()
                            const priceAnchor = await cells[5].getText()
                            const price = Number(priceAnchor.replace(',', ''))
                            optionOrders.push(new OptionOrder(action, price, status))
                        }
                    }
                    break;
            }
        }
        return optionOrders
    }

    getStrikePrices = async () => {

        //TODO make it as an array of object
        const seleniumTasks: string[][] = [
            ['clickbyxpath', 'Click FNO Menu', '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'],
            ['clickbyxpath', 'Click Place Order', '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[2]/a'],
            ['clickbyxpath', 'Click Options', '//*[@id="pnlOrdMnu"]/ul/li[4]/a'],
            ['clickbyxpath', 'Click Call', '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'],
            ['writebyid', 'Enter NIFTY', 'FFO_UNDRLYNG', 'NIFTY'],
            ['clickbyxpath', 'Select Contract', '//*[@id="SelContract"]/li[1]/a'],
            ['wait', 'Wait ', '2'],
            ['tbody', 'Get Rows', '//*[@id="contList"]/tbody']

        ];

        const optionOrders: OptionOrder[] = []

        for (let i = 0; i < seleniumTasks.length; i++) {
            const task = seleniumTasks[i]
            const type = task[0];
            console.log(task[1])
            switch (type) {
                case 'clickbyxpath':
                    await this.browser.clickByXpath(task[2]);
                    break;
                case 'clickById':
                    await this.browser.clickById(task[2]);
                    break;
                case 'clickbyselector':
                    await this.browser.clickBySelector(task[2]);
                    break;
                case 'writebyid':
                    await this.browser.writeById(task[2], task[3])
                    break;

                case 'wait':
                    await delay(2000)
                    break;

                case 'tbody':
                    const contracts = await this.browser.findByXpath(task[2]);
                    const rows = await this.browser.wait(contracts, 2)


                    const xspotPriceAnchor = '//*[@id="pnlConList"]/div[1]/h3/a'
                    const wspotPriceAnchor = await this.browser.findByXpath(xspotPriceAnchor);
                    const spotPriceAnchorText = await wspotPriceAnchor.getText()
                    const spotPrice = Number(spotPriceAnchorText.replace(',', ''))

                    for (let i = 0; i < rows.length; i++) {
                        const row = await rows[i]
                        let cells = await row.findElements(By.css('td'))

                        if (cells.length > 5) {
                            const strikePrice = await this.getNumber(cells[3])
                            if (spotPrice < strikePrice) {
                                const callContractPrice = strikePrice

                                cells = await rows[i - 1].findElements(By.tagName('td'))
                                const putContractPrice = await this.getNumber(cells[3])

                                return [callContractPrice, putContractPrice]
                            }
                        }
                    }
                    break;
            }
        }
    }


    getStrikePrice = async () => {
        try {
            const clickOptionType = async () => {
                await this.browser.clickByXpath(call)
            }

            const selectContract = async () => {
                await this.browser.clickByXpath('//*[@id="SelContract"]/li[1]/a')

                let flag = true
                while (flag) {
                    try {
                        flag = false
                        console.log('Select Contract is clicked')
                    } catch (e) {
                        if (e.message.includes('Please select Option Type.')) {
                            console.log('Have to select an option type')
                            clickOptionType()
                        } else {
                            flag = false
                        }
                    }
                }
            }

            const cashBuy = '//*[@id="qldata"]/ul/li[1]/a'
            const fnoMenu = '//*[@id="ulprodmnu"]/li[3]/a'

            const optionMenu = '//*[@id="pnlOrdMnu"]/ul/li[4]/a'

            const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
            const contractsList = 'contList'
            const call = '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'
            const stock = 'FFO_UNDRLYNG'

            // await this.browser.clickByXpath(cashBuy)
            await this.browser.clickByXpath(fnoMenu)
            await this.browser.clickByXpath(optionMenu)
            await this.browser.writeById(stock, 'NIFTY')
            await clickOptionType()
            await selectContract()

            let element = null
            try {
                element = await this.browser.findByXpath(spotPrice)
            } catch (e) {
                if (e.message.includes('Please select Option Type.')) {
                    console.log('Have to select an option type')
                    await clickOptionType()
                    await selectContract()
                }
            }

            element = await this.browser.findByXpath(spotPrice)
            let innerHtml = await element.getAttribute('innerHTML')
            const currentPrice = Number(innerHtml.replace(',', ''))

            const contracts = await this.browser.findById(contractsList)
            const rows = await contracts.findElements(By.tagName("tr"))

            for (let i = 0; i < rows.length; i++) {
                let cells = await rows[i].findElements(By.tagName('td'))
                if (cells.length < 7) {
                    continue;
                }

                let innerHtml = await cells[3].getAttribute('innerHTML')
                const callContractPrice = Number(innerHtml.replace(',', ''))

                if (callContractPrice > currentPrice) {
                    cells = await rows[i - 1].findElements(By.tagName('td'))
                    let innerHtml = await cells[3].getAttribute('innerHTML')
                    const putContractPrice = Number(innerHtml.replace(',', ''))
                    return [callContractPrice, putContractPrice]
                }
            }
        } catch (e) {
            console.log(e)
        }
    }


    relogin = async (e) => {
        console.log('Error Message in Icici ', e)
        if (e.message.includes('Looking for element')) {
            console.log('Probably not logged in, so attempt again with login')

            const elements = await this.browser.getElementsBySelector('div.errmsg')
            console.log('Error Message length ', elements.length, ' condition ', ((elements.length > 0)))

            if (elements.length > 0) {
                console.log('User has been logged out, so attempt to login again');
                await this.browser.clickById('btnOK')
                await this.login()
                return true
            }
        }
        return false
    }


    //TODO Too much are common between saveNiftyQuotes and saveOptionQuotes
    saveNiftyQuotes = async (prices) => {

        console.info('Save Nifty Quotes')
        const now = new Date();
        const date = moment(now).format('DD-MMM-YYYY')
        const time = moment(now).format('HH:mm')

        const mongo = Mongo.init()

        const processContracts = async (optionType) => {
            await this.browser.selectOpton('optmonth', 2)
            delay(1000)

            const contracts = await this.browser.findById(contractsList)

            // const rows = await contracts.findElements(By.tagName("tr"))
            // const rows = await contracts.findElements(By.css("tr[style=background-color: rgb(255, 255, 255);]"))
            const rows = await contracts.findElements(By.xpath("//tr[not(contains(@style, 'display: none'))]"))
            // const rows = contracts.findElements(By.css('//tr[not(contains(@style,"display:none"))]'))

            for (let i = 0; i < rows.length; i++) {
                // const row = await rows[i].getAttribute('innerHTML')
                const row = await rows[i];
                const cells = await rows[i].findElements(By.tagName('td'))

                if (cells.length < 7) {
                    continue;
                }

                const dateString = await this.getText(cells[1])

                if (dateString == this.expiryDate) {
                    const strikePrice = await this.getNumber(cells[3])
                    const anchorElements = await cells[4].findElements(By.css('a'))
                    const ltp = await this.getNumber(anchorElements[0])
                    const quote = new NiftyQuote()
                    quote.type = `${optionType}_${strikePrice}`;
                    quote.price = ltp
                    quote.date = date
                    quote.time = time
                    Mongo.getInstance().insert(quote)

                    //*[@id="contList"]/tbody/tr[1]/td[5]
                }

                //*[@id="optmonth"]


                //Don't have to get quote, high, low, etc, just get LTP

                // if (prices.includes(contractValue)) {
                //     const anchor = cells[8]
                //     if (await anchor.isDisplayed()) {
                //         await anchor.click()
                //         await this.browser.switchTab()
                //         const lastTradePrice = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[1]/td[2]'
                //         const dayOpen = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[2]/td[2]'
                //         const dayHigh = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[3]/td[2]'
                //         const dayLow = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[4]/td[2]'
                //         const prevDayClose = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[5]/td[2]'
                //         const changePercent = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[6]/td[2]'
                //         const qtyTraded = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[7]/td[2]'
                //         const quote = new NiftyQuote()
                //         quote.lastTradePrice = await this.getText(await this.browser.findByXpath(lastTradePrice))
                //         quote.dayOpen = await this.getText(await this.browser.findByXpath(dayOpen))
                //         quote.dayHigh = await this.getText(await this.browser.findByXpath(dayHigh))
                //         quote.dayLow = await this.getText(await this.browser.findByXpath(dayLow))
                //         quote.prevDayClose = await this.getText(await this.browser.findByXpath(prevDayClose))
                //         quote.changePercent = await this.getText(await this.browser.findByXpath(changePercent))
                //         quote.qtyTraded = await this.getText(await this.browser.findByXpath(qtyTraded))
                //         quote.type = type
                //         quote.strikePrice = contractValue

                //         const now = new Date();
                //         quote.date = moment(now).format('DD-MMM-YYYY')

                //         Mongo.getInstance().insert(quote)
                //         await this.browser.closeTab()
                //     }
                // }
            }
        }

        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[3]/a'
        const placeOrder = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[2]/a'
        const optionMenu = '//*[@id="pnlOrdMnu"]/ul/li[4]/a'
        const selectContract = '//*[@id="SelContract"]/li[1]/a'
        const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
        const contractsList = 'contList'
        const call = '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'
        const put = '//*[@id="divFastBuySell"]/div/div[2]/div/label[2]'
        const stock = 'FFO_UNDRLYNG'

        console.log('Click fnoMenu')
        await this.browser.clickByXpath(fnoMenu)

        console.log('Click placeOrder')
        await this.browser.clickByXpath(placeOrder)

        console.log('Click optionMenu')
        await this.browser.clickByXpath(optionMenu)

        await delay(2000)
        console.log('Click call')
        await this.browser.clickByXpath(call)

        await this.browser.writeById(stock, 'NIFTY')
        try {
            await this.browser.clickByXpath(selectContract)
        } catch (e) {
            console.log('What is the message ???? ', e.message)
            //TODO make it as a function and call in a loop
            if (e.message.includes('Please select Option Type.')) {
                console.log('Trying again as option is not selected')
                await this.browser.clickByXpath(call)
                await this.browser.clickByXpath(selectContract)
            }
        }


        const spotPriceAnchor = await this.browser.findByXpath(spotPrice)
        const ltp = await this.getNumber(spotPriceAnchor);
        const quote = new NiftyQuote()
        quote.type = `Spot`;
        quote.price = ltp
        quote.date = date
        quote.time = time
        Mongo.getInstance().insert(quote)

        // await spotPriceAnchor.click()
        // await this.browser.switchTab()

        // const lastTradePrice = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[1]/td[2]'
        // const dayOpen = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[2]/td[2]'
        // const dayClose = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[3]/td[2]'
        // const dayHigh = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[4]/td[2]'
        // const dayLow = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[5]/td[2]'
        // const prevDayClose = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[6]/td[2]'
        // const change = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[7]/td[2]'
        // const changePercent = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[8]/td[2]'
        // const qtyTraded = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[11]/td[2]'
        // const quote = new NiftyQuote()

        // quote.lastTradePrice = await this.getText(await this.browser.findByXpath(lastTradePrice))
        // quote.dayOpen = await this.getText(await this.browser.findByXpath(dayOpen))
        // quote.dayHigh = await this.getText(await this.browser.findByXpath(dayHigh))
        // quote.dayLow = await this.getText(await this.browser.findByXpath(dayLow))
        // quote.dayClose = await this.getText(await this.browser.findByXpath(dayClose))
        // quote.prevDayClose = await this.getText(await this.browser.findByXpath(prevDayClose))
        // quote.change = await this.getText(await this.browser.findByXpath(change))
        // quote.changePercent = await this.getText(await this.browser.findByXpath(changePercent))
        // quote.qtyTraded = await this.getText(await this.browser.findByXpath(qtyTraded))
        // quote.type = 'Spot'
        // const now = new Date();
        // quote.date = moment(now).format('DD-MMM-YYYY')
        // Mongo.getInstance().insert(quote)

        // await this.browser.closeTab()

        await processContracts('Call')
        console.log('Call is Processed')

        //Put Contracts
        console.log('Click Put')
        await delay(2000)
        await this.browser.clickByXpath(put)

        console.log('Select Contract')
        await this.browser.clickByXpath(selectContract)
        await delay(1000)

        console.log('Start Processing Put Contracts')
        await processContracts('Put')
        Mongo.getInstance().close()

        console.log('Option Quotes are extracted')
    }

    saveOptionQuotes = async (symbol, prices) => {

        const mongo = Mongo.init()

        const processContracts = async (type) => {
            const contracts = await this.browser.findById(contractsList)
            await this.browser.clickById('optmonth')
            await this.browser.clickByXpath('//*[@id="optmonth"]/option[2]')

            const rows = await contracts.findElements(By.tagName("tr"))

            for (let i = 0; i < rows.length; i++) {
                const row = await rows[i].getAttribute('innerHTML')
                const cells = await rows[i].findElements(By.tagName('td'))

                if (cells.length < 7) {
                    continue;
                }

                const contractValue = await this.getNumber(cells[3])

                // if (contractValue === v1 || contractValue === v2 || contractValue === v3 || contractValue === v4) {
                if (prices.includes(contractValue)) {
                    const anchor = cells[8]
                    if (await anchor.isDisplayed()) {
                        await anchor.click()
                        await this.browser.switchTab()
                        const lastTradePrice = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[1]/td[2]'
                        const dayOpen = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[2]/td[2]'
                        const dayHigh = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[3]/td[2]'
                        const dayLow = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[4]/td[2]'
                        const prevDayClose = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[5]/td[2]'
                        const changePercent = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[6]/td[2]'
                        const qtyTraded = '//*[@id="dvdisplayGQ"]/div[1]/div[1]/table/tbody/tr[7]/td[2]'
                        const quote = new OptionQuote()
                        quote.lastTradePrice = await this.getText(await this.browser.findByXpath(lastTradePrice))
                        quote.dayOpen = await this.getText(await this.browser.findByXpath(dayOpen))
                        quote.dayHigh = await this.getText(await this.browser.findByXpath(dayHigh))
                        quote.dayLow = await this.getText(await this.browser.findByXpath(dayLow))
                        quote.prevDayClose = await this.getText(await this.browser.findByXpath(prevDayClose))
                        quote.changePercent = await this.getText(await this.browser.findByXpath(changePercent))
                        quote.qtyTraded = await this.getText(await this.browser.findByXpath(qtyTraded))
                        quote.type = type
                        quote.strikePrice = contractValue
                        quote.symbol = symbol

                        const now = new Date();
                        quote.date = moment(now).format('DD-MMM-YYYY')
                        quote.time = moment(now).format('HH:mm')

                        Mongo.getInstance().insert(quote)
                        await this.browser.closeTab()
                    }
                }
            }
        }

        const fnoMenu = '//*[@id="pnlTradeLanding"]/div[1]/div[1]/ul/li[3]/a'
        const optionMenu = '//*[@id="pnlOrdMnu"]/ul/li[4]/a'
        const selectContract = '//*[@id="SelContract"]/li[1]/a'
        const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
        const contractsList = 'contList'
        const call = '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'
        const put = '//*[@id="divFastBuySell"]/div/div[2]/div/label[2]'
        const stock = 'FFO_UNDRLYNG'

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(optionMenu)

        await this.browser.clickByXpath(call)
        await delay(2000)
        await this.browser.writeById(stock, symbol)
        await this.browser.clickByXpath(selectContract)

        const spotPriceAnchor = await this.browser.findByXpath(spotPrice)
        await spotPriceAnchor.click()
        await this.browser.switchTab()

        const lastTradePrice = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[1]/td[2]'
        const dayOpen = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[2]/td[2]'
        const dayClose = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[3]/td[2]'
        const dayHigh = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[4]/td[2]'
        const dayLow = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[5]/td[2]'
        const prevDayClose = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[6]/td[2]'
        const change = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[7]/td[2]'
        const changePercent = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[8]/td[2]'
        const qtyTraded = '//*[@id="pnlMain"]/div[1]/div[1]/table/tbody/tr[11]/td[2]'
        const quote = new OptionQuote()

        quote.lastTradePrice = await this.getText(await this.browser.findByXpath(lastTradePrice))
        quote.dayOpen = await this.getText(await this.browser.findByXpath(dayOpen))
        quote.dayHigh = await this.getText(await this.browser.findByXpath(dayHigh))
        quote.dayLow = await this.getText(await this.browser.findByXpath(dayLow))
        quote.dayClose = await this.getText(await this.browser.findByXpath(dayClose))
        quote.prevDayClose = await this.getText(await this.browser.findByXpath(prevDayClose))
        quote.change = await this.getText(await this.browser.findByXpath(change))
        quote.changePercent = await this.getText(await this.browser.findByXpath(changePercent))
        quote.qtyTraded = await this.getText(await this.browser.findByXpath(qtyTraded))
        quote.symbol = symbol
        quote.type = 'Spot'
        const now = new Date();
        quote.date = moment(now).format('DD-MMM-YYYY')
        quote.time = moment(now).format('HH:mm')
        Mongo.getInstance().insert(quote)

        await this.browser.closeTab()

        await processContracts('Call')

        //Put Contracts
        await this.browser.clickByXpath(put)
        await delay(2000)
        await this.browser.clickByXpath(selectContract)
        await delay(1000)
        await processContracts('Put')
        Mongo.getInstance().close()
    }

    getNumber = async (webElement) => {
        let innerHTML = await webElement.getAttribute('innerHTML')
        innerHTML = innerHTML.trim()
        return Number(innerHTML.replace(',', ''))
    }

    getText = async (webElement) => {
        let innerHTML = await webElement.getAttribute('innerHTML')
        return innerHTML.trim()
    }


};

