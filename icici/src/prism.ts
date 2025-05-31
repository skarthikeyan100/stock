// Strategy:
// If direction is sure, go for option else go for option plus

import axios, { AxiosRequestConfig } from 'axios'
import NorenRestApi from './prism/RestAPI'

import _ from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, Trade, Order, OrderInfo } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Decision from './decision';
import Monitor from './monitor';

import { VIRTUAL, NIFTY, FINNIFTY, BANKNIFTY, SIMULATION } from './constants'
import Mongo from './tools/mongo'
import indexMap, {Index} from './nse_index';
import { parse } from 'csv-parse';
import readLine from 'readline';
import Config from './prism/config';
// let config = require("./prism/config").default;
import fs from 'fs';
import moment from 'moment'
import ObjectsToCsv from 'objects-to-csv';
import * as f from './orderList'
import { Strategy } from 'strategy/strategy';
import { strategies } from './strategy/strategies';


class StockPrice {
    Stock: string
    Price: number

    constructor(Stock, Price) {
        this.Stock = Stock;
        this.Price = Price;
    }
}


class StrikePrice {
    right: string
    depth: number
    indexPrice: number
    strikePrice: number
    optionPrice: number
    extrinsicPrice: number

    constructor(right, depth, indexPrice, strikePrice, optionPrice, extrinsicPrice) {
        this.right = right;
        this.strikePrice = strikePrice;
        this.depth = depth;
        this.extrinsicPrice = extrinsicPrice;
        this.optionPrice = optionPrice;
        this.indexPrice = indexPrice;
    }       
}

class PriceSeries {
    ltt: number
    lp: number

    constructor(ltt: number, lp: number) {
        this.ltt = ltt;
        this.lp = lp;
    }
}

class TimeWindow {
    plusCount: number
    minusCount: number
    startPrice: number = 0
    currentPrice: number = 0
    change: number

    constructor() {
        this.plusCount = 0;
        this.minusCount = 0;
    }

    addPrice = (price: number) => {
        if (this.startPrice == 0) {
            this.startPrice = price
        }
        if (this.currentPrice !=0) {
            if (price > this.currentPrice) {
                this.plusCount++;
            } else if (price < this.currentPrice) {
                this.minusCount++;
            }
        }

        this.currentPrice = price
        this.change = this.currentPrice - this.startPrice;
        this.change = Math.round(this.change * 10) / 10
    }

    end = () => {
        const timeWindow = new TimeWindow();
        timeWindow.plusCount = this.plusCount;
        timeWindow.minusCount = this.minusCount;
        timeWindow.startPrice = this.startPrice;
        timeWindow.currentPrice = this.currentPrice;

        this.plusCount = 0;
        this.minusCount = 0;
        this.startPrice = 0;
        this.currentPrice= 0;
        this.change = 0;

        return timeWindow;
    }

    public toString = () : string => {
        return `TimeWindow (plusCount: ${this.plusCount}, minusCount: ${this.minusCount}), change: ${this.change}`;
    }
}

class OpenInterestSeries {
    ltt: number
    oi: number

    constructor(ltt: number, oi: number) {
        this.ltt = ltt;
        this.oi = oi;
    }
}

let priceSeries: PriceSeries[] = [];
let openInterestSeries: OpenInterestSeries[] = [];


export default class Prism {
    setOnTrigger = (contract: string, triggerPrice) => {
        Decision.getInstance().setOnTrigger(contract, triggerPrice);
    }
    headless = false
    username = 'SESHA100'
    password = 'nava1000'
    dob = '22091943'

    secretKey = '95O8`0r061i03v2eWx137M739^9235`7';
    appKey = 't8W086&730M11UG47649g22Cv26q41J3'
    apiSession: '2047386';
    sessionToken: String = 'U0VTSEExMDA6NTc3NTc4MDI=';

    app_name = 'options';
    loginUrl = 'https://api.icicidirect.com/apiuser/login?api_key=t8W086%26730M11UG47649g22Cv26q41J3'
    redirectUrl = 'http://localhost:3000/redirect';

    txtuid = 'txtuid'
    txtPass = 'txtPass'
    txtdob = 'txtdob'
    chkssTnc = 'chkssTnc'
    API_Session = 'API_Session'
    orders = [];

    pythonHost = 'http://localhost:5000'
    subscribedList = new Set();
    prevClose = 0;
    started: boolean = false;
    niftyQuote: NiftyQuote = {} as NiftyQuote
    bankNiftyQuote: NiftyQuote = {} as NiftyQuote
    finNiftyQuote: NiftyQuote = {} as NiftyQuote
    trades: Trade[] = [];
    subscribedOptions = [];
    

    sleep = async (milliseconds) => {
        await new Promise(resolve => {
            return setTimeout(resolve, milliseconds)
        });
    };

    socket_open = (data) => {
        console.log('[Prism] onOpen: ', data)
        this.started = true;
    };

    socket_close = (data) => {
        console.log('[Prism] onClose: ', data)
    };

    socket_error = (data) => {
        console.log('[Prism] onError: ', data)
    };

    quote = async (data) => {
        // if (data.tk != 26000 && data.tk != 26009 && data.tk != 26037 ) {
        //     console.log('[Prism] onQuote: ', data.e, '|', data.tk, ' price: ', data.lp | data.updateTradebp1)
            // console.log(data);
        // }
        
        if ('NFO' === data.e) {
            
            const lp = data.lp | data.bpl;
            if (lp != 0) {
                const optionQuote = OptionQuote.fromPrism(data)
                Monitor.getInstance().updateQuote(optionQuote);
                Decision.getInstance().decidePurchaseStockOption(optionQuote);
                // Decision.getInstance().decideSell(optionQuote);
            }
        } else {
            
            // TODO Required only if monitoring index prices
            // console.log('NSE Data: ', data);
            if (!this.niftyQuote.ltp) {
                console.log('************* Get Nifty Quote as it is null during subscribe')
                this.niftyQuote = await this.getNiftyQuote();
            }

            // if (!this.bankNiftyQuote.ltp) {
            //     console.log('************* Get Bank Nifty Quote as it is null during subscribe')
            //     this.bankNiftyQuote = await this.getBankNiftyQuote();
            // }

            // if (!this.finNiftyQuote.ltp) {
            //     console.log('************* Get Fin Nifty Quote as it is null during subscribe')
            //     this.finNiftyQuote = await this.getFinNiftyQuote();
            // }
            // // console.log("Token: ", data.tk, " NiftyQuote: ", this.niftyQuote, " BankNiftyQuote: ", this.bankNiftyQuote, ' FinNifty Quote: ', this.finNiftyQuote);

            if (data.tk == '26000' && !data.toi) {
                // this.findRate(NIFTY, data);
                this._updateQuote(data, this.niftyQuote);
                // console.log('Quote: ' + JSON.stringify(this.niftyQuote))
                Decision.getInstance().decidePurchase(this.niftyQuote);

            } else if (data.tk == '26009') {
                // this.findRate(BANKNIFTY, data);
                // this._updateQuote(data, this.bankNiftyQuote);
                // Decision.getInstance().decidePurchase(this.bankNiftyQuote);

            } else if (data.tk == '26037') {
                // this.findRate(FINNIFTY, data);
                // this._updateQuote(data, this.finNiftyQuote);
                // Decision.getInstance().decidePurchase(this.finNiftyQuote);
            }
            var quotes = {
                'nifty': this.niftyQuote,
                'bankNifty': this.bankNiftyQuote,
                'finNifty': this.finNiftyQuote,
            }
            myEmitter.emit('nifty', quotes);

            // this._emitEvent('/niftydata', this.niftyQuote)
        }
    };

    _updateQuote = (data, niftyQuote) => {
        if (data.lp) {
            niftyQuote.ltp = +data.lp
        } else {
            // console.log('[Prism] find why ltp is zero or null: ', data)
            // TODO Monitor Open Interest
            // { t: 'tf', e: 'NSE', tk: '26000', toi: '134754000' }

        }
        niftyQuote.ltt = data.ft
        if (niftyQuote.ltp > niftyQuote.high) {
            niftyQuote.high = +niftyQuote.ltp
        }
        if (niftyQuote.ltp < niftyQuote.low) {
            niftyQuote.low = +niftyQuote.ltp
        }
        // niftyQuote.token = data.tk == '26000' ? 'NIFTY' : data.tk == '26009' ? 'BANKNIFTY' : 'FINNIFTY';

    }

    
    order = async (data) => {
        Monitor.getInstance().updateTrade(data);
        //TODO add to trades
    };

    getChecksum(timestamp, data): String {
        var rawChecksum = timestamp + data + this.secretKey;
        rawChecksum = Buffer.from(rawChecksum, 'utf8').toString()
        return crypto.createHash('sha256').update(rawChecksum).digest('hex');
    }

    static instance: Prism = null

    static getInstance() {
        if (!Prism.instance) {
            Prism.instance = new Prism();
        }
        return Prism.instance;
    }

    constructor() {
    }

    connect = async () => {
        var ltp = 72

        await this._startWebsocket();

        // TODO Required only if monitoring index prices
        await this.subscribeNifty();
        // await this.refreshTradeList();
    }

    startTime = 0;
    endTime = 0;
    transient: TimeWindow = {} as TimeWindow
    rates: TimeWindow[] = [];

    findRate = (index: string, data: any) => {
        // console.log("Index: " + index, " Data: ", data);
        var time = parseInt(data.ft);
        if (this.startTime == 0) {
            this.startTime = time;
            this.transient = new TimeWindow();
            
        }
        if (data.lp) {
            priceSeries.push(new PriceSeries(time, data.lp));
            this.transient.addPrice(data.lp)
            myEmitter.emit('data', this.transient);
            console.log('Emitted data')
            // console.log('Transient ', this.transient);
        }

        const diff = time - this.startTime;
        console.log('Diff: ' + diff)
        if (diff > 60) {
            this.startTime = 0;
            const timeWindow = this.transient.end()
            this.rates.push(timeWindow);
            myEmitter.emit('timewindow', timeWindow);
            this.transient = new TimeWindow();
            console.log(this.rates)
        }
        

        // var d = moment.unix(num).format("HH:mm:ss")

        // var d = new Date(num * 1000);
        // console.log(d);
        
    }

    requestOtp = async () => {
        const response = await NorenRestApi.request_otp();
        console.log(response);
    }

    logout = async () => {
        await NorenRestApi.logout();
    }

    login = async (otp: string) => {
        await NorenRestApi.login(otp);
        this.niftyQuote = await this.getQuote(NIFTY);
        // this.bankNiftyQuote = await this.getQuote(BANKNIFTY);
        // this.finNiftyQuote = await this.getQuote(FINNIFTY);
        console.log('Logged in')
        this.connect();
    }

    getOtp = async () => {
        const browser = new Browser(false);
        const otp = await browser.getPrismOtp();
        return otp;
    }

    getQuote = async (index: string) => {
        const token = indexMap.get(index).token;
        const response = await NorenRestApi.get_quotes('NSE', token);  // Nifty Quotes
        console.log(index.toString(), ' quote: ', response);
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }
        return new NiftyQuote();
    }

    getNiftyQuote = async () => this.getQuote("NIFTY");
    getBankNiftyQuote = async () => this.getQuote("BANKNIFTY");
    getFinNiftyQuote = async () => this.getQuote("FINNIFTY");
    getStockOptionQuote = async (contract) : Promise<NiftyQuote> => {
        const token = await this.getToken(contract)
        const response = await NorenRestApi.get_quotes('NFO', token);  // Nifty Quotes
        console.log(contract, ' quote: ', response);
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }
        return new NiftyQuote();
    }

    getStockQuote = async (symbol) => {
        const response = await NorenRestApi.get_quotes('NSE', symbol);  // Nifty Quotes
        // console.log(index.toString(), ' quote: ', response);
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }
        return new NiftyQuote();
    }


    _startWebsocket = async () => {
        if (this.started == false) {
            await NorenRestApi.start_websocket(this)
        }

        while (this.started == false) {
            console.log('Waiting for socket to open successfully')
            await this.sleep(2000);
        }
    }

    subscribedIndex = false
    subscribeNifty = async () => {

        await this._startWebsocket()
        if (this.subscribedIndex == false) {
            console.log('Subscribing to nifty')
            await NorenRestApi.subscribe(`NSE|${indexMap.get(NIFTY).token}`)
            // await NorenRestApi.subscribe(`NSE|${indexMap.get(BANKNIFTY).token}`)
            // await NorenRestApi.subscribe(`NSE|${indexMap.get(FINNIFTY).token}`)
            this.subscribedIndex = true
            console.log('Subscribed to nifty');
        }
    }

    subscribeIndex= async (index: string) => {
        await this._startWebsocket()
        console.log('Subscribing to the index ', index)
        await NorenRestApi.subscribe(`NSE|${indexMap.get(index).token}`)
        this.subscribedIndex = true
        console.log('Subscribed to the index ', index);
    }


    subscribeOption = async (token) => {
        const index = this.subscribedOptions.indexOf(token);
        if (index == -1) {
            await NorenRestApi.subscribe(`NFO|${token}`)
            this.subscribedOptions.push(token)
            console.log('Subscribed Option ', token);
        } else {
            console.log('Already subscribed for the option ', token)
        }
    }

    getToken = async (tsym) => {

        //If matches exact requested token, then return it
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                if (tsym === values[4]) {
                    return values[1];
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }

    }

    getContract = async (token) => {

        //If matches exact requested token, then return it
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                if (token === values[1]) {
                    return values[4];
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }

    }

    findLotSizeByContract = async (contract) => {
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        console.log('Input Token is ', contract)
        console.log('NSESymbolsPath ', Config.NFOSymbolsPath)

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                // console.log('line: ' + line);
                // console.log('Values: ' + values);
                if (contract === values[4]) {
                    return values[2];
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }

    }

    findStockToken = async (symbol) => {
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        console.log('Input Token is ', symbol)
        console.log('NSESymbolsPath ', Config.NFOSymbolsPath)

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                console.log('line: ' + line);
                console.log('Values: ' + values);
                if (symbol === values[3]) {
                    return values[1];
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }

    }
    
    updateStockPrices = async () => {

        const stockPrices: [StockPrice] = [] as any;

        //If matches exact requested token, then return it
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.stocksPath)
        });

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                const symbol = values[1];
                this.findStockToken(symbol)
                const stockQuote = await this.getQuote(symbol);
                stockPrices.push(new StockPrice(values[0], stockQuote.ltp))
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }

    }


    search = async (token, index, expiryDate, strikePrice, right) => {
        expiryDate = expiryDate.slice(0, 2) + '-' + expiryDate.slice(2, 5) + '-20' + expiryDate.slice(5);
        // console.log('In search Token: ', token, "index: ", index, "expiryDate: ", expiryDate, "strikePrice: ", strikePrice, "right: " + right);
        right = right == 'call'? 'CE' : 'PE';
        // console.log('Token: ', token, "index: ", index, "expiryDate: ", expiryDate, "strikePrice: ", strikePrice, "right: " + right);


        // const token = await NorenRestApi.searchscrip(text);
        // const index = this._getIndexFromToken(token);

        

        // fs.createReadStream("./migration_data.csv")
        // .pipe(parse({ delimiter: ",", from_line: 2 }))
        // .on("data", function (row) {
        //   console.log(row);
        // })
        // .on("end", function () {
        //   console.log("finished");
        // })
        // .on("error", function (error) {
        //   console.log(error.message);
        // });

        //If matches exact requested token, then return it
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        // NIFTY30JAN25P23000
        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                // console.log('check for ', values[4])
                if (token === values[4]) {
                    return token;
                }
            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }


        lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        let tempToken;
        let diff = 1000;
        const strikePriceAsInt = parseInt(strikePrice);
        console.log('strikePriceAsInt: ', strikePriceAsInt, 'right: ', right, 'index: ', index)

        try {
            for await (const line of lineReader) {
                
                const values = line.split(',');
                if (values[3] == 'NIFTY' && values[7] == right) {
                    // console.log('Line is ', line)
                    // console.log('index: ', index, ' value: ', values[3]);
                    // console.log('right: ', right, 'diff: ', diff, ' value: ', values[8]);
    
                }
                if (right == 'CE' && parseInt(values[8]) < strikePriceAsInt && diff <= 50) {
                    console.log('Return token for CE ', tempToken)
                    return tempToken;
                }

                if (right == 'PE' && parseInt(values[8]) > strikePriceAsInt && diff <= 50) {
                    console.log('Return token for PE ', tempToken)
                    return tempToken;
                }

                // console.log('values[7]: ', values[7], 'right: ', right, "index: ", values[3], "values[3]: ", index,"expiryDate: ", expiryDate, "strikePrice: ", strikePrice);
                if (values[7] === right && index === values[3] && expiryDate === values[5]) {
                    tempToken = values[4];
                    diff = Math.abs(parseInt(values[8]) - strikePriceAsInt);
                    // console.log('values: ', values);
                    // console.log('Parsed Int: ', parseInt(values[8]), 'parsedStrikePrice: ', strikePriceAsInt, ' Diff: ', diff);
                }

            }
        } catch (e) {
            console.log(e);
        } finally {
            lineReader.close();
        }
        return token;
    }

    unsubscribeOption = async (token) => {
        // await NorenRestApi.subscribe(`NFO|${token}`);
        // const token = await NorenRestApi.searchscrip(contract);
        // NorenRestApi.subscribe('NFO|44236')
        NorenRestApi.unsubscribe(`NFO|${token}`)
        console.log('Unsubscribed Option ', token);
        const index = this.subscribedOptions.indexOf(token);
        if (index != -1) {
            this.subscribedOptions.splice(index, 1)
        }
    }

    getOptionQuote = async (token: string) => {
        const response = await NorenRestApi.get_quotes('NFO', token);  // Nifty Quotes
        console.log('getOptionQuote for the token ', token)
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }


        // { request_time: '14:35:40 29-03-2023',
        // stat: 'Ok',
        // exch: 'NFO',
        // tsym: 'NIFTY06APR23C17150',
        // cname: 'NIFTY 06APR23 17150 CE ',
        // symname: 'NIFTY',
        // seg: 'DER',
        // exd: '06-APR-2023',
        // instname: 'OPTIDX',
        // optt: 'CE',
        // pp: '2',
        // ls: '50',
        // ti: '0.05',
        // mult: '1',
        // lut: '1680080739',
        // uc: '403.90',
        // lc: '0.05',
        // oi: '650100',
        // strprc: '17150.00',
        // prcftr_d: '(1 / 1 ) * (1 / 1)',
        // token: '44236',
        // lp: '69.05',
        // c: '75.30',
        // h: '93.45',
        // l: '55.75',
        // ap: '73.73',
        // o: '74.20',
        // v: '5639950',
        // ltq: '200',
        // ltt: '14:35:39',
        // tbq: '344350',
        // tsq: '150350',
        // bp1: '68.95',
        // sp1: '69.20',
        // bp2: '68.90',
        // sp2: '69.25',
        // bp3: '68.85',
        // sp3: '69.30',
        // bp4: '68.80',
        // sp4: '69.35',
        // bp5: '68.75',
        // sp5: '69.40',
        // bq1: '800',
        // sq1: '1400',
        // bq2: '950',
        // sq2: '1650',
        // bq3: '1450',
        // sq3: '2700',
        // bq4: '2500',
        // sq4: '1100',
        // bq5: '2200',
        // sq5: '3050',
        // bo1: '2',
        // so1: '5',
        // bo2: '3',
        // so2: '6',
        // bo3: '3',
        // so3: '6',
        // bo4: '6',
        // so4: '3',
        // bo5: '5',
        // so5: '5' }


        // Option Quote:  NiftyQuote {
        //     ltp: '69.05',
        //     ltt: '1680080840',
        //     open: '74.20',
        //     high: '93.45',
        //     low: '55.75',
        //     prevClose: '75.30',
        //     volume: '5662850' }

        return new NiftyQuote();
    }

    sellContract = async(contract, qty, price?) => {
        console.log('In Sell Contract contract: ', contract, ' price: ', price)
        if (!price) {
            const quote = await this.getStockOptionQuote(contract);
            price = quote.ltp
        }

        const transactionType = 'S'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno

        const order = {
            "trantype": transactionType,
            "prd": normal,
            "exch": nse,
            "tsym": contract,
            "qty": qty,
            "prctyp": limit,
            "prc": price
        }

        await this._placeOrderWithForce(order)
    }

    buyContract = async(contract, price?) => {
        console.log('In Buy Contract contract: ', contract, ' price: ', price)
        if (!price) {
            const quote = await this.getStockOptionQuote(contract);
            price = quote.ltp
        }
        const token = await this.getToken(contract);
        const lotSize = await this.findLotSizeByContract(contract);
        const lotSizeAsInt = parseInt(lotSize);
        const qty = 1 * lotSizeAsInt;

        const transactionType = 'B'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno

        const order = {
            "trantype": transactionType,
            "prd": normal,
            "exch": nse,
            "tsym": contract,
            "qty": lotSize,
            "prctyp": limit,
            "prc": price
        }

        await this._placeOrderWithForce(order)
    }

    buyIndex = async(index, ltp?, right?) => {
        const nseIndex = indexMap.get(index as string);
        let calculatedStrikePrice
        let calculatedRight
        let calculatedOptionPrice
        let calculatedToken
        
        let factor
        if (nseIndex.token == nseIndex.niftyToken) {
            if (!ltp) {
                const indexQuote = await this.getNiftyQuote()
                ltp = indexQuote.ltp
            }
            factor = 50
        }

        const floorPrice = Math.floor(ltp/factor) * factor;
        const ceilPrice = Math.ceil(ltp/factor) * factor;
        const floorDiff = Math.abs(floorPrice - ltp)
        const ceilDiff = Math.abs(ceilPrice - ltp)
        const strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice
        // console.log('LTP: ', ltp, ' FloorPrice: ', floorPrice, ' CeilPrice: ', ceilPrice)
        // console.log('floorDiff: ', floorDiff, ' ceilDiff: ', ceilDiff, ' strikePrice: ', strikePrice)

        let callStrikePrice = strikePrice;
        const direction = (Config.optionDirection) == "OTM" ? 1 : -1
        callStrikePrice += direction * (Config.depth * factor)
        const callToken = await nseIndex.findTokenFor(index as string, 'call', callStrikePrice);
        
        const callDiff = ltp - callStrikePrice
        
    
        let putStrikePrice = strikePrice
        putStrikePrice += (-direction) * (Config.depth * factor)
        const putToken = await nseIndex.findTokenFor(index as string, 'put', putStrikePrice);
        
        const putDiff = putStrikePrice - ltp
        
        if (Config.bidirection) {
            const callQuote = await this.getOptionQuote(callToken);
            const putQuote = await this.getOptionQuote(putToken);
            console.log('Bidirection: ', Config.bidirection)
            await this.sendLimitOrder(putToken, putQuote.ltp, 'put', 'buy', null);
            return await this.sendLimitOrder(callToken, callQuote.ltp, 'call', 'buy', null);
    
        } else {
            if (right == 'call' || Config.selectedOption == 'call') {
                if (f.exists(callToken)) {
                    return
                } else {
                    const callQuote = await this.getOptionQuote(callToken);
                    return await this.sendLimitOrder(callToken, callQuote.ltp, 'call', 'buy', null);
                }
            } else if (right == 'put' || Config.selectedOption == 'put') {
                if (f.exists(putToken)) {
                    return
                } else {
                    const putQuote = await this.getOptionQuote(putToken);
                    return await this.sendLimitOrder(putToken, putQuote.ltp, 'put', 'buy', null);
                }
            } else {
                const callQuote = await this.getOptionQuote(callToken);
                const putQuote = await this.getOptionQuote(putToken);
    
                const callExtrinsicPrice = callQuote.ltp - callDiff
                const putExtrinsicPrice = putQuote.ltp - putDiff
    
                // If the value is more then people are thinking that option will move in that direction
                console.log('callExtrinsicPrice: ', callExtrinsicPrice, ' putExtrinsicPrice: ', putExtrinsicPrice)
                calculatedRight = (callExtrinsicPrice < putExtrinsicPrice) ? 'put' : 'call'
                calculatedStrikePrice = (calculatedRight == 'put') ? putStrikePrice : callStrikePrice
                calculatedOptionPrice = (calculatedRight == 'put') ? putQuote.ltp : callQuote.ltp
                calculatedToken = (calculatedRight == 'put') ? putToken : callToken
                // console.log('calculatedRight: ', calculatedRight, ' calculatedStrikePrice: ', calculatedStrikePrice)
                // console.log('calculatedOptionPrice: ', calculatedOptionPrice, ' calculatedToken: ', calculatedToken)
                return await this.sendLimitOrder(calculatedToken, calculatedOptionPrice, calculatedRight, 'buy', null);
            }
        }
    }

    findDirectionAndStrikePrice = async ( index: string) => {
        const nseIndex = indexMap.get(index as string);
        // const map = new Map<StrikePrice, number>();
        const list : StrikePrice[] = [];
        const direction = (Config.optionDirection) == "OTM" ? 1 : -1
        const factor = nseIndex.factor;
        let indexQuote : NiftyQuote;
        let ltp;
        if (nseIndex.token == nseIndex.niftyToken) {
            indexQuote = await this.getNiftyQuote()
            ltp = indexQuote.ltp
            console.log('Quote for Nifty: ', ltp)
    
        } else if (nseIndex.token == nseIndex.bankNiftyToken) {
            indexQuote = await this.getBankNiftyQuote()
            ltp = indexQuote.ltp
            console.log('Quote for BankNifty: ', ltp)
        } else {
            indexQuote = await this.getFinNiftyQuote()
            console.log('Quote for FinNifty: ', ltp)
            ltp = indexQuote.ltp
        } 

        for(let depth = 0; depth < 3; depth++) {
            let callStrikePrice = Math.floor(ltp/factor) * factor
            console.log(' Config.optionDirection: ', Config.optionDirection)
            
            callStrikePrice += direction * (depth * factor);
            const callToken = await nseIndex.findTokenFor(nseIndex.index, 'call', callStrikePrice);
            const callQuote = await this.getOptionQuote(callToken);
            const callDiff = indexQuote.ltp - callStrikePrice
            const callExtrinsicPrice = callQuote.ltp - callDiff

            let putStrikePrice = Math.ceil(ltp/factor) * factor
            putStrikePrice += (-direction) * (depth * factor)
            const putToken = await nseIndex.findTokenFor(nseIndex.index, 'put', putStrikePrice);
            const putQuote = await this.getOptionQuote(putToken);
            const putDiff = putStrikePrice - indexQuote.ltp
            const putExtrinsicPrice = putQuote.ltp - putDiff
            console.log('Option ltp: ', callQuote.ltp)

            list.push(new StrikePrice('call', depth, ltp, callStrikePrice, callQuote.ltp, callExtrinsicPrice));
            list.push(new StrikePrice('put', depth, ltp, putStrikePrice, putQuote.ltp, putExtrinsicPrice));
    
        }
        console.log(list)
    
    }


    buy = async (tsym: string, price: number): Promise<void> => {
        
        price = Math.round(price * 10) / 10
        const indexObj = tsym.startsWith('BANK') ? indexMap.get('BANKNIFTY') : tsym.startsWith('NIFTY') ? indexMap.get('NIFTY') : indexMap.get('FINNIFTY');
        const qty = indexObj.getQuantity(price);
        const transactionType = 'B'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno
        const order = {
            "trantype": transactionType,
            "prd": normal,
            "exch": nse,
            "tsym": tsym,
            "qty": qty,
            "prctyp": limit,
            "prc": price
        }

        this._placeOrder(order)

    }

    sell = async (tsym: string, quantity: number, price: number) => {
        price = Math.round(price * 10) / 10
        const transactionType = 'S'
        const limit = "LMT"
        const qty = quantity
        const nse = "NFO"
        const normal = "M" //for fno
        const order = {
            "trantype": transactionType,
            "prd": normal,
            "exch": nse,
            "tsym": tsym,
            "qty": qty,
            "prctyp": limit,
            "prc": price
        }

        console.log('Place Order in sell ', order);
        await NorenRestApi.place_order(order) as any;
        await this.unsubscribeOption(tsym);
        f.removeOrder(order.tsym)
    }

    cancel = async (orderno) => {
        await NorenRestApi.cancel_order(orderno);
    }    
    
    modifyOrder = async (order: Order, newPrice: number) => {
        let updatedOrder = {
            tsym: order.tsym,
            orderno: order.orderno,
            quantity: order.quantity,
            price: newPrice
        }
        await NorenRestApi.modify_order(updatedOrder)
    }    

    sendLimitOrder = async (tsym: string, price: number, right: string, action: string, strategy: string) : Promise<OrderInfo> => {
        const limit = "LMT"
        console.log('tsym: ' +tsym);
        const indexObj = tsym.startsWith('BANK') ? indexMap.get('BANKNIFTY') : tsym.startsWith('NIFTY') ? indexMap.get('NIFTY') : indexMap.get('FINNIFTY');
        const qty = indexObj.getQuantity(price);
        if (qty == 0) {
            console.log('Order is not placed, qty: ', qty, ' price: ', price)
        }
        const nse = "NFO"
        const callput = "call" === right ? 'C' : 'P'
        const normal = "M" //for fno
        const order = {
            "trantype": 'B',
            "prd": normal,
            "exch": nse,
            "tsym": tsym,
            "qty": qty,
            "prctyp": limit,
            "prc": price
        }

        this._placeOrder(order);
        const token = await this.getToken(order.tsym);
        return {
            "contract": tsym,
            "qty": qty,
            "price": price,
            "lastOrderedPrice": price,
            "token": token,
            "profit": 0
        }
        
    }

    _placeOrder = async (order) => {
        
        if (!f.exists(order.tsym)) {
            await this._placeOrderWithForce(order)
            f.addOrder(order.tsym)
        }

    }

    _placeOrderWithForce = async (order) => {
        console.log('Place Order ', order);
            
        await NorenRestApi.place_order(order) as any;
        const token = await this.getToken(order.tsym);
        console.log(`Subscribe to tsym ${order.tsym} using token ${token}`)
        await this.subscribeOption(token);
        await delay(2000)
    }
    _getIndexFromToken = (token: string) => token.startsWith('BANK') ? 'BANKNIFTY' : token.startsWith('NIFTY') ? 'NIFTY' : 'FINNIFTY'

    squareOffOrder = async (token, qty) => {

        const transactionType = 'S'
        const market = "MKT"
        const nse = "NFO"
        const normal = "M" //for fno
        // const callput = "call" === right ? 'C' : 'P'
        // const tsym = `NIFTY${expiryDate}${callput}${strikePrice}`
        const order = {
            "trantype": transactionType,
            "prd": normal,
            "exch": nse,
            "tsym": token,
            "qty": qty,
            "prctyp": market,
            "prc": 0
        }

        console.log('Square off Order ', order);
        f.removeOrder(token)
        const orderReply = await NorenRestApi.place_order(order);
        await this.unsubscribeOption(token);

    }

    getOrders = async () => {
        const orders : Order[] = []
        const response = await NorenRestApi.get_orderbook() as any
        // console.log('Response: ', response)
        for(let i = 0; i < response.length; i++) {
            const orderItem = response[i];
            console.log('Order Item: ', orderItem)
            if (orderItem.stat !== 'Not_Ok') { 
                if (orderItem.status != 'COMPLETE') {
                    const order = Order.fromPrism(orderItem)
                    order.token = await this.getToken(order.tsym)
                    orders.push(order)
                }                
            }
        }
        
        console.log('Orders size: ', orders)
       
        return orders
    }

    getTradeList = () => {
        return Monitor.getInstance().trades;
    }


    refreshTradeList = async () => {
        // const response = await NorenRestApi.get_tradebook() as any
        const response = await NorenRestApi.get_positions() as any
        console.log('Positions: ', response)

        const trades: Trade[] = []
        if (response.stat == 'Not_Ok') {
            return;
        }
        response.forEach(element => {
            if (parseInt(element.netqty, 10) > 0)
                console.log('Construct trade now in refresh trades')
                var trade = Trade.fromPrism(element);
                console.log('Trade sym: ', trade.tsym, ' trade.quantity: ', trade.quantity)
                if (trade.tsym.startsWith('NIFTY') && trade.quantity > 0) {
                    trades.push(trade)
                }
        });
        Monitor.getInstance().refreshTrades(trades);
        return Monitor.getInstance().trades;
    }
}




