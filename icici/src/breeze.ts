// Strategy:
// If direction is sure, go for option else go for option plus

import Browser from './trade/browser.js';
import { Builder, By, until, Key, WebElement } from 'selenium-webdriver';
// import EventEmitter from 'events';
import delay from 'delay'
import https from 'https'
// import cheerio from 'cheerio'
import axios, { AxiosRequestConfig } from 'axios'
import _ from 'lodash'
import icicinse from './trade/icicinse'
import symbols from './symbols'
import Mongo from './tools/mongo'
import moment from 'moment'
import crypto from 'crypto'
import { application, response } from 'express';
import request from 'request';
import { Trade, OptionQuote, NiftyQuote } from './model/model';
const spawn = require('child_process').spawn;

// import { BreezeConnect } from 'breezeconnect';



export default class Breeze {
    headless = false
    username = 'SESHA100'
    password = 'nava1000'
    dob = '22091943'

    appKey = "01@oF100100H4eV8=109q287N9J8%52L";
    appSecret = "#=f055136JU8R000wE91B094F5J192`5";
    apiSession: '2047386';
    sessionToken: String = 'V0sxMzM4NDM6MzczNjU5NjQ=';

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


    getChecksum(timestamp, data): String {
        var rawChecksum = timestamp + data + this.appSecret;
        rawChecksum = Buffer.from(rawChecksum, 'utf8').toString()
        return crypto.createHash('sha256').update(rawChecksum).digest('hex');
    }

    static instance: Breeze = null

    static getInstance() {
        if (!Breeze.instance) {
            Breeze.instance = new Breeze();
        }
        return Breeze.instance;
    }

    constructor() {
        if (!Breeze.instance) {
            Breeze.instance = this;
        }
    }

    start = () => {
        // const appKey ="your_api_key";
        // const appSecret = "your_secret_key";
        // const breeze = new BreezeConnect({"appKey":appKey});
        // console.log("https://api.icicidirect.com/apiuser/login?api_key=" + encodeURI(appKey))

        // breeze.generateSession(appSecret,"your_api_session").then(function(resp){
        //     apiCalls();
        // }).catch(function(err){
        //     console.log(err)
        // });

    }

    login = async () => {
        const browser = new Browser(this.headless)
        await browser.visit(this.loginUrl)
        await browser.writeById(this.txtuid, this.username)
        await browser.writeById(this.txtPass, this.password)
        await browser.clickById(this.chkssTnc);
        await browser.clickById('btnSubmit')
        await delay(1000)
        const otp = await browser.getOtp();
        console.log('OTP: ', otp);
        const inputs: WebElement[] = await browser.getElementsBySelector('input[type="text"');
        console.log('Inputs length: ', inputs.length);
        for (var i = 1; i <= 6; i++) {
            inputs[i].sendKeys(otp.charAt(i - 1));
        }
        await browser.clickById('Button1')
        setTimeout(() => browser.quit(), 10000)
    }

    init = async() => {
        await this.connect();
        await this.getNiftyQuote();
    }

    _getOtp = async () => {
        const browser = new Browser(this.headless)



        await browser.visit(this.loginUrl)
        await browser.writeById(this.txtuid, this.username)
        await browser.writeById(this.txtPass, this.password)
        await browser.writeById(this.txtdob, this.dob)
        await browser.clickById(this.chkssTnc);
        await browser.clickById('btnSubmit')
        await delay(1000)

        setTimeout(() => browser.quit(), 10000)
    }

    

    getCustomerDetails = async (apiSession) => {
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        let data = `{\r\n    "SessionToken": "${apiSession}",\r\n    "AppKey": "${this.appKey}"\r\n}`;
        console.log("Data: ", data);
        console.log("JSON Data: ", JSON.stringify(data));
        var config: AxiosRequestConfig = {
            method: 'get',
            url: 'https://api.icicidirect.com/breezeapi/api/v1/customerdetails',
            headers: {
                'content-type': 'application/json'
            },
            data: data
        };
        const instance = axios.create({
            httpsAgent: new https.Agent({  
              rejectUnauthorized: false
            })
          });

        try {
            const response = await instance(config);
            
            this.apiSession = apiSession;
            this.sessionToken = response.data.Success.session_token
            console.log('Session Token: ', this.sessionToken)
            return response.data;
        } catch (error) {
            console.log('ERROR ')
            console.log(error);
        }
    };


    getTradeList = async () => {

        const today = new Date();
        today.setDate(today.getDate() + 1);
        const todate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 6).toISOString();
        today.setDate(today.getDate() - 30);
        const fromdate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 6).toISOString();
        console.log('fromDate: ', fromdate);
        console.log('toDate: ', todate);

        let b = {
            "exchange_code": "NFO",
            "from_date": fromdate.toString(),
            "to_date": todate.toString(),
        }

        console.log('this.sessionToken: ', this.sessionToken)
        let argument = {
            'sessionToken': this.sessionToken,
            'body': b,
            'uri': '/breezeapi/api/v1/trades'
        }

        let stringifiedData = JSON.stringify(argument);
        const response: any = await this._callPython(stringifiedData);
        let trades: Trade[] = []
        //TODO send error to UI
        if (response != null) {
            for (var i = 0; i < response.length; i++) {
                var element = response[i];
                const trade = Trade.getTradeFromResponse(element);
                trades.push(trade);
            }
        }

        // Assumption: All trades are only Buy, no short trades
        const sellTrades = [] as Trade[];
        const indices = [];
        for (var i = 0; i < trades.length; i++) {
            const trade = trades[i];
            if (trade.action == 'Sell') {
                sellTrades.push(trade);
                indices.push(i);
            }
        }

        //Remove buy trades
        for (const sell of sellTrades) {
            let index = -1;
            for (const buy of trades) {
                index++;
                if (buy.action == 'Buy' && sell.right == buy.right && sell.quantity == buy.quantity && sell.expiryDate == buy.expiryDate && sell.strikePrice == buy.strikePrice) {
                    indices.push(index);
                }
            }
        }

        //Remove sell trades
        indices.sort((a, b) => b - a);
        let index = -1;
        for (const index of indices) {
            trades.splice(index, 1);
        }



        return trades;
    };

    _findExpiryDate = () => {
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const nextFriday = new Date(
            today.setDate(
                today.getDate() + ((7 - today.getDay() + 4) % 7 || 7),
            ),
        );

        return nextFriday.toISOString();
    }
    sendMarketOrder = async (expiryDate, strikePrice, right, action) => {
        return await this.sendLimitOrder('NIFTY',expiryDate, strikePrice, null, right, action)
    }

    sendLimitOrder = async (stockCode, expiryDate, strikePrice, limitPrice, right, action) => {
        // var isodate = new Date(2022, 9, 22).toISOString()
        // var quotient = Math.floor(niftyPrice/50);
        // var strikePrice = (quotient * 50) - 100;


        console.log('isodate: ', expiryDate);
        var obj = {
            "stock_code": stockCode,
            "exchange_code": "NFO",
            "product": "options",
            "action": action,
            "order_type": "market",
            "quantity": "200",
            "validity": "day",
            "expiry_date": '2023-12-07T06:00:00.000Z',
            "right": right,
            "strike_price": strikePrice,
        } as any

        if (limitPrice != null) {
            obj.order_type = "limit";
            obj.price = limitPrice;
        }

        var data = JSON.stringify(obj);
        console.log('Sending data ', data)

        var config: AxiosRequestConfig = {
            method: 'post',
            url: 'https://api.icicidirect.com/breezeapi/api/v1/order',
            headers: this._getHeaders(data),
            data: data
        };

        try {
            console.log('Sending data through axios ', config)
            const response = await axios(config);
            if (response.status == 200) {
                return 200;
            } else {
                console.log('Error received ', response)
                throw new Error('Error while sending an order')
            }
        } catch (e) {
            console.log('ERROR: ', e);
            throw new Error('Exception while sending an order')
        }
    }

    connect = async () => {
        try {
            await axios.get(`${this.pythonHost}/connect`, { params: { api_session: this.apiSession } });
            return true;
        } catch (e) {
            console.log('Flask may not be running')
            return e;
        }

    }

    _getKey = (expiryDate, strikePrice, right) => right + ' ' + expiryDate + ' ' + strikePrice;

    subscribeOption = async (expiryDate, strikePrice, right) => {
        // const key = this._getKey(expiryDate, strikePrice, right);
        // const hasValue = this.subscribedList.has(key);
        // if (!hasValue) {
        //     const res = await axios.get(`${this.pythonHost}/subscribe`, { params: { stock_code: 'NIFTY', expiry_date: expiryDate, strike_price: strikePrice, right: right } });
        //     this.subscribedList.add(key);
        // }
    }

    unsubscribeOption = async (expiryDate, strikePrice, right) => {
        // const key = this._getKey(expiryDate, strikePrice, right);
        // const hasValue = this.subscribedList.has(key);
        // if (hasValue) {
        //     const res = await axios.get(`${this.pythonHost}/unsubscribe`, { params: { stock_code: 'NIFTY', expiry_date: expiryDate, strike_price: strikePrice, right: right } });
        //     this.subscribedList.delete(this._getKey(expiryDate, strikePrice, right));
        // }
    }

    subscribeNifty = async () => {
        const key = "NIFTY"
        const hasValue = this.subscribedList.has(key);
        if (!hasValue) {
            const res = await axios.get(`${this.pythonHost}/subscribe`, { params: { stock_code: 'NIFTY' } });
            this.subscribedList.add(key);
        }
    }

    unsubscribeNifty = async () => {
        const key = "NIFTY"
        const hasValue = this.subscribedList.has(key);
        if (hasValue) {
            const res = await axios.get(`${this.pythonHost}/unsubscribe`, { params: { stock_code: 'NIFTY' } });
            this.subscribedList.delete(key);
        }
    }

    squareOff = async () => {
        var expiryDate = '29-Sep-2022'
        var strikePrice = '17850'
        var optionPrice = '251'
        var isCall = true
        // TODO could be just a sell order
        console.log('isodate: ', expiryDate);
        var obj = {
            "stock_code": "NIFTY",
            "exchange_code": "NFO",
            "action": "sell",
            "order_type": "market",
            "quantity": "200",
            "validity": "day",
            "expiry_date": expiryDate,
            "right": isCall ? "call" : "put",
            "strike_price": strikePrice,
            "product_type": "options"
        } as any

        if (optionPrice != null) {
            obj.order_type = "limit";
            obj.price = optionPrice;
        }

        var data = JSON.stringify(obj);

        var config: AxiosRequestConfig = {
            method: 'post',
            url: 'https://api.icicidirect.com/breezeapi/api/v1/squareoff',
            headers: this._getHeaders(data),
            data: data
        };

        try {
            const response = await axios(config);
            console.log('Response ', response);
            if (response.data.status == 200) {
                return 200;
            } else {
                throw new Error('Error while sending an order')
            }
        } catch (e) {
            console.log('ERROR: ', e);
            throw new Error('Exception while sending an order')
        }
    }

    //TODO @Deprecated
    getOptionQuote = async (expiryDate, strikePrice, right) => {

        // console.log('In getQuotes: ', this.sessionToken, ' expiryDate: ', expiryDate, ' strikePrice ', strikePrice)
        let b = {
            "stock_code": "NIFTY",
            "exchange_code": "NFO",
            "product_type": "options",
            "expiry_date": expiryDate,
            "strike_price": strikePrice,
            "right": right
        }

        let argument = {
            'sessionToken': this.sessionToken,
            'body': b,
            'uri': '/breezeapi/api/v1/quotes'
        }

        let stringifiedData = JSON.stringify(argument);
        const response = await this._callPython(stringifiedData);
        // return OptionQuote.fromBreeze(response[0]);
    };

    getNiftyQuote = async () => {
        let b = {
            "stock_code": "NIFTY",
            "exchange_code": "NSE",
        }

        let argument = {
            'sessionToken': this.sessionToken,
            'body': b,
            'uri': '/breezeapi/api/v1/quotes'
        }

        let stringifiedData = JSON.stringify(argument);
        const response = await this._callPython(stringifiedData);
        if (response != null) {
            const q =  new NiftyQuote(response[0])
            this.prevClose = q.prevClose;
            return q;
        }
        return new NiftyQuote();
    };

    monitor = async () => {

        let argument = {
            'sessionToken': this.sessionToken,
        }

        let stringifiedData = JSON.stringify(argument);
        const response = await this._callMonitorPython(stringifiedData);
        return response;
    };

    _callPython = (stringifiedData) => {
        return new Promise((resolve, reject) => {
            try {
                console.log('Call python with data: ', stringifiedData)
                const py = spawn('python3', ['/work/github/work/icici/icici.py', stringifiedData]);
                let resultString = '';

                // As the stdout data stream is chunked,
                // we need to concat all the chunks.
                py.stdout.on('data', function (stdData) {
                    resultString += stdData.toString();
                });
                py.stderr.on('data', function (stdData) {
                    resultString += stdData.toString();
                });


                py.stdout.on('end', function () {
                    // Parse the string as JSON when stdout
                    // data stream ends
                    let resultData = JSON.parse(resultString);

                    // console.log('Response from python: ', resultData);
                    resolve(resultData.Success);
                });
            } catch (error) {
                console.log("ERROR ", error)
                reject(error)
            }

        });
    }

    _callMonitorPython = (stringifiedData) => {
        // return new Promise((resolve, reject) => {
        try {
            console.log('Call Monitor python');
            const py = spawn('/work/github/work/icici/breeze_venv/bin/python3', ['/work/github/work/icici/breeze_venv/monitor.py', 'name']);
            console.log('Called python');
            let resultString = '';

            // As the stdout data stream is chunked,
            // we need to concat all the chunks.
            py.stdout.on('data', function (stdData) {
                resultString += stdData.toString();
                console.log("DATA: ", stdData.toString());
            });
            py.stderr.on('data', function (stdData) {
                resultString += stdData.toString();
                console.log("ERROR DATA: ", stdData.toString());

            });

            py.stdout.on('end', function () {
                // Parse the string as JSON when stdout
                // data stream ends
                console.log('Response from python: ', resultString);
                // let resultData = JSON.parse(resultString);
                // resolve(resultData.Success);
            });
        } catch (error) {
            console.log("ERROR ", error)
            // reject(error)
        }
        console.log('Resolved with Hello')
        return { 'Hello': 'World' };
        // });
    }
    _getHeaders = (data): any => {
        var now = new Date();
        now.setMilliseconds(0);
        var timestamp = now.toISOString();
        console.log('this.sessionToken: ' + this.sessionToken);

        return {
            'content-type': 'application/json',
            'X-Checksum': "token " + this.getChecksum(timestamp, data),
            'X-Timestamp': timestamp,
            'X-AppKey': this.appKey,
            'X-SessionToken': this.sessionToken
        }
    }



}




