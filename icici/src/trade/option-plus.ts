// Strategy:
// If direction is sure, go for option else go for option plus

import Browser from './browser.js';
import Icici from './icici'
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
    percent // TODO, default should be 10, if market order should be 0

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

export default class OptionPlus {
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

    squareOffOption = async (contract, market?) => {
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
                    if (market) {
                        const anchors = await cells[11].findElements(By.tagName('a'))
                        if (anchors.length > 1) {
                            console.log('Execute market order')
                            await anchors[1].click()
                            console.log('Click Proceed Button')
                            await this.browser.clickById(proceedButton)
                            console.log('Executed Square off')
                        }
                    } else {
                        console.log('Execute Square off now ')
                        const anchors = await cells[11].findElements(By.tagName('a'))

                        if (anchors.length > 1) {
                            const avgPrice = await this.getNumber(cells[4]);
                            let proposedPrice = (avgPrice + 1)
                            await anchors[0].click()
                            await this.browser.writeById(profitLimitPrice, proposedPrice)
                            await this.browser.writeById(limitQty, 300) // TODO Hardcoded to 300
                            await this.browser.clickById(submitButton)
                            await this.browser.clickById(proceedButton)
                        }
                    }
                }

            }
        } catch (e) {
            console.log('Error ', e)
        }
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

            console.log('Write Limit Price')
            await this.browser.writeById(limitPrice, ltp) //buying at ltp
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
            console.log('Error ', e)
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

        Mongo.init()

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

