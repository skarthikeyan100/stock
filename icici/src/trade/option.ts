// Strategy:
// If direction is sure, go for option else go for option plus

import Browser from './browser.js';
import fs from 'fs'
import Icici from './icici'
import _ from 'lodash'
import { Builder, By, until, Key, WebElement } from 'selenium-webdriver';
// import EventEmitter from 'events';
import delay from 'delay'
// import cheerio from 'cheerio'
import axios from 'axios'
import icicinse from './icicinse'
import symbols from '../symbols'
import Mongo from '../tools/mongo'
import moment from 'moment'

export enum OptionType {
    call = 'CALL',
    put = 'PUT'
}

export class Decision {
    action?: OptionType = OptionType.call
    depth?: number
    lotCount?: number
    strikePrice?: number
    expiryDate?: string
    symbol?: string = 'NIFTY'
    executionPrice?: number
    stopLoss?: number
    target?: number
    autoSquareOff?: boolean
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


export class OptionPosition {
    contract : string
    position
    qty
    avgPrice
    ltp
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

export default class Option {
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

    constructor(browser: Browser) {
        this.browser = browser;
    }

    static async build() {
        const icici = await Icici.getInstance()
        return Promise.resolve(new Option(icici.browser))
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

        await this.browser.writeById(limitPrice, ltp) //TODO buying at ltp??
        // await this.browser.writeById(stopLossPrice, lessPercent - 3) //TODO always less than by 2 as it will be converted to less than 10
        await delay(1000)
        await this.browser.clickById(submitButton)
        await delay(1000)
        await this.browser.clickById(proceedButton)
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


    getNiftyQuotes = async () => {
        const quotes: NiftyQuote[] = []
        console.info('Get Nifty Quotes')
        const now = new Date();
        const date = moment(now).format('DD-MMM-YYYY')
        const time = moment(now).format('HH:mm')

        const mongo = Mongo.init()

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
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[4]/a'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[4]/a'
        const option = '//*[@id="pnlctlLeft1"]/div/div/div[1]/ul[1]/li[4]/a'
        // const optionTable = '//*[@id="divOpenPosition"]/div[1]/table/tbody'
        const optionTable = '//*[@id="dvList"]/table/tbody';

        await this.browser.clickByXpath(fnoMenu)
        await this.browser.clickByXpath(openPositions)
        await this.browser.clickByXpath(option)
        await delay(2000)

        const element = await this.browser.findByXpath(optionTable)

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

    squareOffOption = async (contract, market?) => {
        //TODO check login
        try {
            const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
            const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[5]/a'
            const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[4]/a'
            const option = '//*[@id="pnlctlLeft1"]/div[1]/div/ul/li[4]/a'

            const optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table'
            const submitButton = 'Submit1'
            const proceedButton = 'btneqprocess'

            const profitLimitPrice = 'FFO_LMT_RT'
            const limitQty = 'FFO_SQROFF'

            console.log('Click FnO')
            await this.browser.clickByXpath(fnoMenu)
            console.log('Click openPositions')

            await this.browser.clickByXpath(openPositions)
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

                //*[@id="contList"]/tbody/tr[1]/td[4]
                const qty = await this.getNumber(cells[3]);
                const element = await cells[0].findElement(By.id(contract))
                const thisContract = await this.getText(cells[0]);
                console.log('thisContract: ', thisContract, ' C: ', contract)
                if (element) {
                    const anchors = await cells[11].findElements(By.tagName('a'))
                    console.log("Len: ", anchors.length)
                    if (anchors.length > 1) {
                        console.log('Execute market order')

                        await anchors[0].click()
                        await this.browser.writeById('FFO_SQROFF', qty)
                        const element = await this.browser.findById('GQStkPrice')
                        const ltp = await this.getNumber(element)
                        console.log('LTP: ', ltp)
                        const limitPrice = 'FFO_LMT_RT'
                        await this.browser.writeById(limitPrice, ltp) //buying at ltp

                        const sqoffBButton = 'Submit1'
                        console.log('Square off')
                        await this.browser.clickById(sqoffBButton)
                        console.log('Proceed')
                        await delay(2000)
                        await this.browser.clickById("btneqprocess")
                        break;
                    }
                }

            }
        } catch (e) {
            console.log('Error ', e)
        }
    }

    execute = async (decision: Decision) => {
        await this.buyOption(decision);
        if (decision.target || decision.stopLoss || decision.autoSquareOff) {
            setInterval(() => this.monitorOptionOpenPositions(decision), 1000 * 60)
        }
    }

    monitorOptionOpenPositions = async (options: Decision) => {

        console.log("Start Monitoring ", new Date());
        const positions = [] as Array<OptionPosition>
        const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[4]/a'
        const openPositions = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[5]/a'
        const portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span'
        const option = '//*[@id="pnlctlLeft1"]/div[1]/div/ul/li[4]/a'


        const optionPlusTable = '//*[@id="contList"]'

        const submitButton = 'Submit1'
        const proceedButton = 'btneqprocess'

        const profitLimitPrice = 'FFO_LMT_RT'
        const limitQty = 'FFO_SQROFF'

        console.log("FNO");
        await this.browser.clickByXpath(fnoMenu)
        delay(1000)
        console.log("Open Positions");
        await this.browser.clickByXpath(openPositions)
        delay(1000)
        console.log("OPtion");
        await this.browser.clickByXpath(option)
        delay(1000)
        console.log("Table");


        const element = await this.browser.findByXpath(optionPlusTable)
        console.log("Rows");
        delay(1000)

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
            const a = await cells[0].findElements(By.tagName('a'))
            console.log(a)
            openPosition.contract = await this.getText(a[0]);
            console.log('Contract is ', openPosition.contract)
            const regex = /(.*)\n/
            openPosition.contract = regex.exec(openPosition.contract)[0]
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

            console.log('Open Position ', openPosition)
            const plprice = (ltp - avgPrice)
            console.log('Profit Price ', plprice)

            //autoSquareOff for a profit or loss

            if (options.autoSquareOff) {
                if ((plprice > 2) || (plprice < -2)) { //TODO hard-coded to 2 for 1 lot
                    const anchors = await cells[11].findElements(By.tagName('a'))
                    console.log("Anchors ", anchors);
                    if (anchors.length > 1) {

                        console.log('Execute market order')
                        console.log("0: ", await this.getText(anchors[0]))
                        console.log("1: ", await this.getText(anchors[1]))
                        //*[@id="contList"]/tbody/tr[1]/td[12]/div/ul/li[1]/a[1]

                        //*[@id="FFO_SQROFF"]
                        await anchors[0].click()

                        await this.browser.writeById('FFO_SQROFF', openPosition.qty)
                        const element = await this.browser.findById('GQStkPrice')
                        const ltp = await this.getNumber(element)
                        console.log('LTP: ', ltp)
                        const limitPrice = 'FFO_LMT_RT'
                        await this.browser.writeById(limitPrice, ltp) //buying at ltp

                        // const market = '//*[@id="pnltabtrans"]/div[2]/div[5]/div/span/label'
                        // console.log('Click Market')



                        const sqoffBButton = 'Submit1'
                        console.log('Square off')
                        await this.browser.clickById(sqoffBButton)
                        console.log('Proceed')
                        await this.browser.clickById("btneqprocess")
                    }
                }
            } else if (options.stopLoss || options.target) {
                if ((ltp > options.target) || (ltp < options.stopLoss)) {
                    const anchors = await cells[11].findElements(By.tagName('a'))
                    if (anchors.length > 1) {
                        console.log('Execute market order')
                        await anchors[0].click()
                        await this.browser.clickById(proceedButton)
                    }
                }
            }

            //     if ((plprice > 2) || (plprice < -2)) { //TODO hard-coded to 2 for 1 lot
            //         //TODO Execute market order
            //         const anchors = await cells[11].findElements(By.tagName('a'))
            //         if (anchors.length > 1) {
            //             if (options.autoExecute) {
            //                 console.log('Execute market order')
            //                 await anchors[1].click()
            //                 await this.browser.clickById(proceedButton)
            //             }
            //         }
            //     } else {
            //         console.log('Execute Square off now ')
            //         const anchors = await cells[11].findElements(By.tagName('a'))

            //         console.log('Anchors length ', anchors.length)
            //         if (anchors.length > 1) {

            //             let proposedPrice = (avgPrice + 1)
            //             console.log("Proposed price ", proposedPrice)
            //             if (proposedPrice < plprice) {
            //                 proposedPrice = plprice
            //             }
            //             console.log("Adjusted Proposed price ", proposedPrice)
            //             //TODO execute
            //             if (options.autoExecute) {
            //                 await anchors[0].click()
            //                 await this.browser.writeById(profitLimitPrice, proposedPrice)
            //                 await this.browser.writeById(limitQty, 300) // TODO Hardcoded to 300
            //                 await this.browser.clickById(submitButton)
            //                 await this.browser.clickById(proceedButton)
            //             }
            //         }
            //     }
        }
        // fs.writeFile('./open.json', JSON.stringify(positions), err => {
        //     if (err) { console.log('Error while writing a file ', err) }
        // })
        return positions;
    }

    buyOption = async (decision: Decision) => {
        try {

            const defaultDecision = {} as Decision
            defaultDecision.symbol = "NIFTY";
            defaultDecision.action = OptionType.call;
            defaultDecision.lotCount = 4;
            defaultDecision.depth = 2;

            decision = { ...defaultDecision, ...decision }
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
                await this.browser.clickByXpath('//*[@id="SelContract"]/li[2]/a')

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
            const fnoMenu = '//*[@id="pnlmnuprod"]/div/ul/li[4]/a'

            const placeOrder = '//*[@id="pnlmnudsp"]/div[1]/div/ul/li[3]/a'
            const optionsMenu = '//*[@id="pnlOrdMnu"]/ul/li[4]/a'
            const outOfTheMoney = '//*[@id="FilteringOption"]/ul/li[2]/a'
            const inTheMoney = '//*[@id="FilteringOption"]/ul/li[4]/a'
            const spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a'
            const contractsList = 'contList'
            const call = '//*[@id="divFastBuySell"]/div/div[2]/div/label[1]'
            const put = '//*[@id="divFastBuySell"]/div/div[2]/div/label[2]'
            const stock = 'FFO_UNDRLYNG'
            const buy = '//*[@id="divFastBuySell"]/div/div[4]/div/label[1]'
            const sell = '//*[@id="divFastBuySell"]/div/div[4]/div/label[2]'
            const qty = 'FFO_QTY'
            const market = '//*[@id="divFastBuySell"]/div/div[6]/div/span/label'

            const limit = '//*[@id="divFastBuySell"]/div/div[6]/div/label'

            const limitPrice = 'FFO_LMT_RT'
            const stopLossPrice = 'FFO_STP_LSS_TGR'
            const submitButton = 'Submit1'
            const proceedButton = 'Submit'

            console.log('Click FNOMenu')
            await this.browser.clickByXpath(fnoMenu)

            console.log('Click Place Order ')
            await this.browser.clickByXpath(placeOrder)
            await this.browser.clickByXpath(optionsMenu)
            await clickOptionType()
            await this.browser.writeById(stock, decision.symbol)

            await selectContract()
            if (!decision.strikePrice) {
                await this.browser.clickByXpath(outOfTheMoney)
            }


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
            let depth = decision.depth
            console.log('Depth = ', depth)
            console.log('Rows length ', rows.length)
            for (let i = 0; i < rows.length; i++) {
                // const row = await rows[i].getAttribute('innerHTML')
                let cells = await rows[i].findElements(By.tagName('td'))
                if (cells.length < 7) {
                    continue;
                }

                // for (let j = 0; j < cells.length; j++) {
                //     console.log('Col ', j, ' value ', await cells[j].getAttribute('innerHTML'))
                // }

                let innerHtml = await cells[3].getAttribute('innerHTML')
                const thisContractPrice = Number(innerHtml.replace(',', ''))

                if (decision.expiryDate) {
                    let expiryDate = await cells[1].getAttribute('innerHTML')
                    console.log('expiryDate: ', expiryDate.trim(), ' input: ', decision.expiryDate)
                    if (expiryDate.trim() !== decision.expiryDate) {
                        continue;
                    }
                }
                if (decision.strikePrice) {
                    let strikePrice = await this.getNumber(cells[2])
                    if (strikePrice !== decision.strikePrice) {
                        continue;
                    }
                }

                if (!decision.expiryDate && !decision.strikePrice) {
                    if (depth) {

                        console.log('Decremented depeth ', depth)
                        if (depth === 0) {
                            anchors = await cells[8].findElements(By.css('a'))
                            await anchors[0].click()
                            break;

                        }
                        depth--;
                    } else {
                        console.log('In Else')
                        anchors = await cells[8].findElements(By.css('a'))
                        await anchors[0].click()
                        break;
                    }
                }

            }

            if (decision.executionPrice) {
                ltp = decision.executionPrice
            } else {
                element = await this.browser.findById('GQStkPrice')
                ltp = await this.getNumber(element)
            }

            element = await this.browser.findById('lblOne_Lot_Size')
            const lotText = await this.getText(element)
            const lotSize = lotText.substring(9, lotText.indexOf('Q'))

            console.log('Write Quantity')
            await this.browser.writeById(qty, decision.lotCount * lotSize) //TODO always 4 lot

            console.log('Click Limit')
            await this.browser.clickByXpath(limit)

            console.log('Write Limit Price')
            await this.browser.writeById(limitPrice, ltp) //buying at ltp
            await delay(1000)
            console.log('Click Submit Button')
            await this.browser.clickById(submitButton)
            await delay(1000)
            console.log('Click Proceed Button')

            // await this.browser.clickById(proceedButton)
            return 200;
            // TODO need to check if proceed is successful

            // const notSubmitted = await this.browser.isElementPresent('smereduce')
            // if (notSubmitted) {
            //     //TODO have custom error classes
            //     await this.browser.esc();
            //     throw new Error('Money is not available')
            // }
            // console.log(decision, ' is executed at ', lessPercent)
        } catch (e) {
            console.log('Error ', e)
            return 500;
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

