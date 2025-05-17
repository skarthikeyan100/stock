// Strategy:
// If direction is sure, go for option else go for option plus

import Browser from '../trade/browser.js';
import { Builder, By, until, Key, WebElement } from 'selenium-webdriver';
import delay from 'delay'
import _ from 'lodash'
import { Parser } from 'json2csv';
import fs from 'fs'

class Data {
    country
    year
    value
    qty

    constructor(country, year, qty, value) {
        this.country = country;
        this.year = year
        this.qty = qty
        this.value = value
    }
}

const browser = new Browser(false)

const loop = async () => {
    // await browser.visit('https://commerce-app.gov.in/eidb/Icomcntq.asp')
    await browser.visit('https://commerce-app.gov.in/eidb/ecomcntq.asp')
    const count = 23
    const data: Data[] = []
    for (let i = 0; i < count; i++) {
        await getDataForaYear(i, data)
    }
    console.log(data)

    const json2csvParser = new Parser({ fields: ['country', 'year', 'qty', 'value' ]});
    const csv = json2csvParser.parse(data);
    fs.writeFileSync('/home/karthikeyan/Documents/bovine_import.csv', csv);
}

const getDataForaYear = async (index, data) => {

    await delay(2000)

    //TODO make it as an array of object
    const seleniumTasks: string[][] = [
        ['selectOption', 'Select Year', 'select2', index],
        ['typebyxpath', 'Enter Commodity', '/html/body/form/table[1]/tbody/tr[2]/td[2]/p/input', '051110'],
        ['clickById', 'Click Submit', 'button1'],
        ['wait', 'Wait ', '2'],
        ['tbody', 'Get Data', '/html/body/table[2]/tbody'],
        ['clickById', 'Click Submit', 'IMG1'],
    ];

    for (let i = 0; i < seleniumTasks.length; i++) {
        const task = seleniumTasks[i]
        const type = task[0];
        // console.log(task[1])
        switch (type) {
            case 'clickbyxpath':
                await browser.clickByXpath(task[2]);
                break;
            case 'clickById':
                await browser.clickById(task[2]);
                break;
            case 'clickbyselector':
                await browser.clickBySelector(task[2]);
                break;
            case 'wait':
                await delay(2000)
                break;
            case 'selectOption':
                await browser.selectOpton(task[2], task[3] + 1)
                break;
            case 'typebyxpath':
                await browser.writeByXpath(task[2], task[3])
                break

        case 'tbody':
                await delay(2000)
                try {
                    const orders = await browser.findByXpath(task[2]);
                    const rows = await browser.wait(orders, 2)
    
                    for (let i = 1; i < rows.length-3; i++) {
                        const row = await rows[i]
                        const html = await row.getAttribute("innerHTML")
                        const cells = await row.findElements(By.css('td'))
    
                        const yearx = '/html/body/table[2]/tbody/tr[1]/th[4]/font'
                        const yeare = await browser.findByXpath(yearx)
                        const year = await getText(yeare)
    
                        // if (cells.length > 5) {
                            const country = await getText(cells[1])
                            const value = await getText(cells[3])
                            const qty = await getText(cells[6])
                            const thisData = new Data(country, year, qty, value)
                            data.push(thisData)
                            // console.log('Data ', thisData)
                            console.log(country, ',', year, ',' ,value, ',' ,qty)
                        // }
                    }
                }
                catch (e) {
                    console.log(e.message)
                    console.log('Data not available')
                }
                break;
        }
    }
    return data
}

const getText = async (webElement) => {
    const cells = await webElement.findElements(By.css('font'))
    if (cells.length == 0) {
        let innerHTML = await webElement.getAttribute('innerHTML')
        return innerHTML.trim()
    }
    let innerHTML = await cells[0].getAttribute('innerHTML')
    return innerHTML.trim()

}

loop()


