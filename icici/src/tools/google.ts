import Browser from '../trade/browser.js';
import {Builder, By, until, Key} from 'selenium-webdriver';
// import EventEmitter from 'events';
import delay from 'delay'
// import cheerio from 'cheerio'
import axios from 'axios'
import _ from 'lodash'
import icicinse from '../trade/icicinse'
import symbols from '../symbols'
import Mongo from './mongo'
import moment from 'moment'

class StockIndexDB {
    
    async saveIndex(stockIndex) {
        await Mongo.getInstance().insert(stockIndex)
    }    

    close = async() => {
        Mongo.getInstance().close()
    }
}

class StockIndex {
    date
    name
    value
    change
    percent

    constructor(name, value, change, percent: string) {
        this.date = moment(Date.now()).format('DD-MMM-YYYY') 
        this.name = name.trim()
        this.value = value.trim()
        this.change = change.trim()
        this.percent = percent.trim().substr(1, percent.trim().length-1)
    }
}

export default class Google {
    browser: Browser
    search = '//*[@id="tsf"]/div[2]/div[1]/div[3]/center/input[1]'
    xpvalue = '//*[@id="knowledge-finance-wholepage__entity-summary"]/div/g-card-section/div/g-card-section/span[1]/span/span';
    xppercent = '//*[@id="knowledge-finance-wholepage__entity-summary"]/div/g-card-section/div/g-card-section/span[2]/span[2]/span[1]';
    xpchange = '//*[@id="knowledge-finance-wholepage__entity-summary"]/div/g-card-section/div/g-card-section/span[2]/span[1]'
    database

    constructor(headless?) {
        this.browser = new Browser(headless)
        this.browser.visit('https://www.google.com')
        this.database = new StockIndexDB()
        this.database.init()
    }

    fetchIndex = async(name) => {
        await this.browser.clearAndWrite('q', name);
        
        const value = await this.getTextByXpath(this.xpvalue)
        const percent = await this.getTextByXpath(this.xppercent);
        const change = await this.getTextByXpath(this.xpchange)

        const index = new StockIndex(name, value, change, percent)
   
        console.log('Index is ', index)
        this.database.saveIndex(index)
        return index;
    }

    asyncForEach = async (array, callback) => {
        for (let index = 0; index < array.length; index++) {
          await callback(array[index], index, array);
        }
    }

    quit = async() => {
        console.log('Quit now')
        await this.browser.quit()
        await this.database.close()
    }

    getTextByXpath = async (xpath) => {
        let webElement = await this.browser.findByXpath(xpath);
        let innerHTML = await webElement.getAttribute('innerHTML')
        return innerHTML.trim()
    }
}; 

