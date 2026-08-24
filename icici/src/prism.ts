import Log from './util/Log';
// Strategy:
// If direction is sure, go for option else go for option plus

import axios, { AxiosRequestConfig } from 'axios'
import NorenRestApi from './prism/RestAPI'

import _, { forIn } from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, Trade, Order, OrderInfo, OrderStatus } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import Browser from './trade/browser';
import Decision from './decision';
import bookkeeping from './processes/order/bookkeeping';
import AntStream from './ant/AntStream';
import strategies from './strategy/strategies';

import { VIRTUAL, NIFTY, FINNIFTY, BANKNIFTY, SIMULATION, CALL, PUT, MOCK_BROKER } from './constants'
import Mongo from './tools/mongo'
import indexMap, {Index} from './nse_index';
import { parse } from 'csv-parse';
import readLine from 'readline';
import Config from './prism/config'
import { UserContext } from './user';;
import configService from './prism/ConfigService'
// let config = require("./prism/config").default;
import fs from 'fs';
import moment from 'moment'
import ObjectsToCsv from 'objects-to-csv';
import * as f from './orderList'
import { del } from 'request';
const round = (num) => Math.round(num * 100) / 100;

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

function splitQty(qty) {
    const max = 1800;
    const result = [];
    while (qty > 0) {
        result.push(Math.min(qty, max));
        qty -= max;
    }
    return result;
}

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


    sleep = async (milliseconds) => {
        await new Promise(resolve => {
            return setTimeout(resolve, milliseconds)
        });
    };

    socket_open = (data) => {
        Log.log('[Prism] onOpen: ', data)
        this.started = true;
    };

    socket_close = (data) => {
        Log.log('[Prism] onClose: ', data)
        this.started = false
        this.connect()
    };

    socket_error = (data) => {
        Log.log('[Prism] onError: ', data)
    };

    exhausted = () => {
        // Any trade still open when data runs out is a timeout
        for (const trade of bookkeeping.trades) {
            const strategy = strategies.getList().find(s => s.userId === trade.user);
            if (strategy) {
                const pnl = (trade.lastTradePrice - trade.price) * trade.quantity;
                strategy.recordOutcome('timeout', pnl);
            }
        }

        const allStats = strategies.getList().map(s => s.getStats());

        const cols = ['Strategy', 'Trades', 'Wins', 'Losses', 'Timeouts', 'Win%', 'P&L', 'Timeout P&L'];
        const rows = allStats.map(s => [
            s.userId,
            String(s.totalTrades),
            String(s.wins),
            String(s.losses),
            String(s.timeouts),
            s.winRate !== null ? `${s.winRate}%` : 'N/A',
            String(s.totalPnL),
            s.timeouts > 0 ? String(s.timeoutPnL) : '-',
        ]);

        // Also add a cumulative row per user
        bookkeeping.userPnL.forEach((pnl, user) => {
            if (!allStats.find(s => s.userId === user)) {
                rows.push([user, '-', '-', '-', '-', '-', String(Math.round(pnl)), '-']);
            }
        });

        const widths = cols.map((c, i) =>
            Math.max(c.length, ...rows.map(r => r[i].length))
        );
        const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
        const fmt = (r: string[]) => '|' + r.map((v, i) => ` ${v.padEnd(widths[i])} `).join('|') + '|';

        Log.log('\n=== BACKTEST STATS ===');
        Log.log(sep);
        Log.log(fmt(cols));
        Log.log(sep);
        rows.forEach(r => Log.log(fmt(r)));
        Log.log(sep);
    };

    close = async () => {
        Log.log('[Prism] Closing the socket')
        await delay(5000);
        this.connect();
    }

    // Quote streaming (touchline data + Monitor/Decision broadcast) has moved to
    // ANT (see AntStream.broadcastQuote) - Prism's WebSocket stays connected
    // solely for order-fill notifications via `order` below.
    _updateQuote = (data, niftyQuote) => {

        if (data.lp) {
            const prevLtp = niftyQuote.ltp;
            niftyQuote.ltp = +data.lp;
            if (prevLtp) {
                niftyQuote.changePercent = (niftyQuote.ltp - prevLtp) / prevLtp * 100;
            }
        } else {
            // Log.log('[Prism] find why ltp is zero or null: ', data)
            // TODO Monitor Open Interest
            // { t: 'tf', e: 'NSE', tk: '26000', toi: '134754000' }

        }
        niftyQuote.ltt = data.ft
        // Capture prevClose from WebSocket data if not already set
        if (data.c && !niftyQuote.prevClose) {
            niftyQuote.prevClose = +data.c;
        }
        if (niftyQuote.ltp > niftyQuote.high) {
            niftyQuote.high = +niftyQuote.ltp
        }
        if (niftyQuote.ltp < niftyQuote.low) {
            niftyQuote.low = +niftyQuote.ltp
        }
        // niftyQuote.token = data.tk == '26000' ? 'NIFTY' : data.tk == '26009' ? 'BANKNIFTY' : 'FINNIFTY';

    }

    
    order = async (data) => {
        await bookkeeping.updateTradeFromPrismMessage(data);
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
            Prism.instance.cacheFile();
        }
        return Prism.instance;
    }

    constructor() {
    }

    connect = async () => {
        var ltp = 72
        delay(500)

        await this._startWebsocket();
        // Socket stays open for order-fill notifications only - touchline
        // quote subscription has moved to ANT (see AntStream).
        // await this.refreshTradeList();
    }

    getOAuthURL = () => {
        return NorenRestApi.getOAuthURL();
    }

    requestOtp = async () => {
        const response = await NorenRestApi.request_otp();
        Log.log(response);
    }

    logout = async () => {
        await NorenRestApi.logout();
    }

    loginWithGenAcsTok = async (code: string) => {
        await NorenRestApi.loginWithGenAcsTok(code);
        this.niftyQuote = await this.getQuote(NIFTY);
        Log.log('Logged in with GenAcsTok')
        this.connect().catch((e) => Log.log('[Prism] connect after loginWithGenAcsTok failed:', e));
    }

    login = async (otp: string) => {
        await NorenRestApi.login(otp);
        this.niftyQuote = await this.getQuote(NIFTY);
        Log.log('Logged in')
        this.connect().catch((e) => Log.log('[Prism] connect after login failed:', e));
    }

    getOtp = async () => {
        const browser = new Browser(false);
        const otp = await browser.getPrismOtp();
        return otp;
    }

    getQuote = async (index: string) => {
        const token = indexMap.get(index).token;
        const response = await NorenRestApi.get_quotes('NSE', token);  // Nifty Quotes
        // Log.log(index.toString(), ' quote: ', response);
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
        Log.log(response)
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }
        return new NiftyQuote();
    }

    getStockQuote = async (symbol) => {
        const response = await NorenRestApi.get_quotes('NSE', symbol);  // Nifty Quotes
        // Log.log(index.toString(), ' quote: ', response);
        if (response != null) {
            return NiftyQuote.fromPrism(response)
        }
        return new NiftyQuote();
    }

    getOptionChain = async () => {
        try {
            const response = await NorenRestApi.option_chain('25355')
            if (response != null) {
                Log.log(response)
            }
    
        } catch (e) {
            Log.log('Error in getting option chain: ', e.message)
        }
    }

    _startWebsocket = async () => {
        if (this.started == false) {
            await NorenRestApi.start_websocket(this)
        }

        let i = 1;

        while (this.started == false) {
            Log.log('Waiting for socket to open successfully')
            await this.sleep(2000);
            i++;
            if ( i == 5) {
                throw new Error('Websocket is not opened successfully after 5 attempts. Please check the connection and try again.')
            }
        }
    }

    getToken = async (tsym) => {
        await this.cacheFile();
        for (const line of this.lines) {
            const values = line.split(',');
            if (tsym === values[4]) {
                return values[1];
            }
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
            Log.log(e);
        } finally {
            lineReader.close();
        }

    }

    findLotSizeByContract = async (contract) => {
        await this.cacheFile();
        for (const line of this.lines) {
            const values = line.split(',');
            if (contract === values[4]) {
                return values[2];
            }
        }

    }

    findStockToken = async (symbol) => {
        var lineReader = readLine.createInterface({
            input: fs.createReadStream(Config.NFOSymbolsPath)
        });

        Log.log('Input Token is ', symbol)
        Log.log('NSESymbolsPath ', Config.NFOSymbolsPath)

        try {
            for await (const line of lineReader) {
                const values = line.split(',');
                Log.log('line: ' + line);
                Log.log('Values: ' + values);
                if (symbol === values[3]) {
                    return values[1];
                }
            }
        } catch (e) {
            Log.log(e);
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
            Log.log(e);
        } finally {
            lineReader.close();
        }

    }

    lines = [];
    cacheFile = async () => {
        if (this.lines.length == 0) {
            var lineReader = readLine.createInterface({
                input: fs.createReadStream(Config.NFOSymbolsPath)
            });
            for await (const line of lineReader) {
                this.lines.push(line);
            }
            lineReader.close();
            Log.log('[Symbols] Loaded', this.lines.length, 'NFO symbols')
        }
    }



    search = async (token, index, expiryDate, strikePrice, right) => {
        await this.cacheFile();
        expiryDate = expiryDate.slice(0, 2) + '-' + expiryDate.slice(2, 5) + '-20' + expiryDate.slice(5);
        right = right == 'call'? 'CE' : 'PE';
        Log.log(`[Token] ${index} strike=${strikePrice} right=${right} expiry=${expiryDate} → ${token}`);


        // const token = await NorenRestApi.searchscrip(text);
        // const index = this._getIndexFromToken(token);

        

        // fs.createReadStream("./migration_data.csv")
        // .pipe(parse({ delimiter: ",", from_line: 2 }))
        // .on("data", function (row) {
        //   Log.log(row);
        // })
        // .on("end", function () {
        //   Log.log("finished");
        // })
        // .on("error", function (error) {
        //   Log.log(error.message);
        // });

        //If matches exact requested token, then return it
        // var lineReader = readLine.createInterface({
        //     input: fs.createReadStream(Config.NFOSymbolsPath)
        // });

        // NIFTY30JAN25P23000
        for (const line of this.lines) {
            const values = line.split(',');
            if (token === values[4]) {
                return values[4];
            }
        }

        let tempToken;
        let diff = 1000;
        const strikePriceAsInt = parseInt(strikePrice);

        for (const line of this.lines) {
            const values = line.split(',');
            if (right == 'CE' && parseInt(values[8]) < strikePriceAsInt && diff <= 50) {
                return tempToken;
            }
            if (right == 'PE' && parseInt(values[8]) > strikePriceAsInt && diff <= 50) {
                return tempToken;
            }
            if (values[7] === right && index === values[3] && expiryDate === values[5]) {
                tempToken = values[4];
                diff = Math.abs(parseInt(values[8]) - strikePriceAsInt);
            }
        }

        // Fallback: requested expiry not in NFO file — find nearest available expiry for this index
        if (!tempToken || diff === 1000) {
            const monthNameToIdx: Record<string, number> = {
                JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
                JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
            };
            const now = Date.now();
            let nearestExpiry: string | null = null;
            let minDiff = Infinity;
            const seen = new Set<string>();
            for (const line of this.lines) {
                const values = line.split(',');
                if (values[3] !== index || values[7] !== right) continue;
                const exp = values[5]; // e.g. "02-MAR-2026"
                if (seen.has(exp)) continue;
                seen.add(exp);
                const parts = exp.split('-');
                const expMs = new Date(parseInt(parts[2]), monthNameToIdx[parts[1].toUpperCase()], parseInt(parts[0])).getTime();
                const delta = expMs - now;
                if (delta > 0 && delta < minDiff) { minDiff = delta; nearestExpiry = exp; }
            }
            if (nearestExpiry) {
                Log.log(`[search] Requested expiry ${expiryDate} not found; using nearest: ${nearestExpiry}`);
                tempToken = undefined;
                diff = 1000;
                for (const line of this.lines) {
                    const values = line.split(',');
                    if (right === 'CE' && parseInt(values[8]) < strikePriceAsInt && diff <= 50) break;
                    if (right === 'PE' && parseInt(values[8]) > strikePriceAsInt && diff <= 50) break;
                    if (values[7] === right && index === values[3] && nearestExpiry === values[5]) {
                        const d = Math.abs(parseInt(values[8]) - strikePriceAsInt);
                        if (d < diff) { diff = d; tempToken = values[4]; }
                    }
                }
            }
        }

        if (tempToken) {
            Log.log(`[search] Found token: ${tempToken}`);
            return tempToken;
        }
        Log.log('strikePriceAsInt1: ', strikePriceAsInt, 'right: ', right, 'index: ', index, ' token: ', token)
        return token;
    }

    getOptionQuote = async (token: string) => {
        const response = await NorenRestApi.get_quotes('NFO', token);  // Nifty Quotes
        Log.log('Response: ', response)
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

    sellContract = async( contract, qty, price, user?: string) : Promise<void> => {

        Log.log('In Sell Contract contract: ', contract, ' price: ', price)
        if (!price) {
            const quote = await this.getStockOptionQuote(contract);
            price = quote.ltp
        }

        const transactionType = 'S'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno

        const parts = splitQty(qty)
        for (let i = 0; i < parts.length; i++) {
            const order = {
                "trantype": transactionType,
                "prd": normal,
                "exch": nse,
                "tsym": contract,
                "qty": parts[i],
                "prctyp": limit,
                "prc": price
            }

            await this._placeOrderWithForce(order, user)
        }
    }


    getContractByPriceRange = async( right: string): Promise<string> => {
        const ltp = this.niftyQuote?.ltp || (await this.getNiftyQuote()).ltp
        let result = null;
        const index = 'NIFTY'
        const nseIndex = indexMap.get(index);
        const factor = 50
        const floorPrice = Math.floor(ltp/factor) * factor;
        const ceilPrice = Math.ceil(ltp/factor) * factor;
        const floorDiff = Math.abs(floorPrice - ltp)
        const ceilDiff = Math.abs(ceilPrice - ltp)
        Log.log('Prism.getContractByPriceRange: ltp: ', ltp, ' floorPrice: ', floorPrice, ' ceilPrice: ', ceilPrice, ' right: ', right, ' floorDiff: ', floorDiff, ' ceilDiff: ', ceilDiff)
        
        for(var depth = 0; depth < 5; depth++) {
            let strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice
            Log.log('Strike Price: ', strikePrice, ' depth: ', depth, ' right: ', right)
            if (right == 'call') {
                strikePrice += (depth * factor)
            } else {
                strikePrice -= (depth * factor)
            }
            
            const contract = await nseIndex.findTokenFor(index, right, strikePrice);
            const quote = await this.getOptionQuote(contract);
            Log.log('Prism.getContractByPriceRange: strikePrice: ', strikePrice, ' ltp: ', quote.ltp)
            if (f.isPriceInRange(quote.ltp)) {
                result = contract;
                break;
            } else {
                Log.log('[Search] Contract price not in configured range, trying next depth')
            }
        }

        if (result == null) {
            for(var depth = 1; depth < 5; depth++) {
                let strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice
                if (right == 'call') {
                    strikePrice -= (depth * factor)
                } else {
                    strikePrice += (depth * factor)
                }
                
                const contract = await nseIndex.findTokenFor(index, right, strikePrice);
                const quote = await this.getOptionQuote(contract);
                Log.log('Prism.getContractByPriceRange: strikePrice: ', strikePrice, ' ltp: ', quote.ltp)
                if (f.isPriceInRange(quote.ltp)) {
                    result = contract;
                    break;
                } else {
                    Log.log('[Search] Contract price not in configured range, trying next depth')
                }
            }
        }

        return result

    }

    getContractByDiff = async(ltp: number, right: string): Promise<string> => {
        let result = null;
        const index = 'NIFTY'
        const nseIndex = indexMap.get(index);
        const factor = 50
        const floorPrice = Math.floor(ltp/factor) * factor;
        const ceilPrice = Math.ceil(ltp/factor) * factor;
        const floorDiff = Math.abs(floorPrice - ltp)
        const ceilDiff = Math.abs(ceilPrice - ltp)
        

        for(var depth = 0; depth < 5; depth++) {
            let strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice
            if (right == 'call') {
                strikePrice += (depth * factor)
            } else {
                strikePrice -= (depth * factor)
            }
            
            const contract = await nseIndex.findTokenFor(index, right, strikePrice);
            const quote = await this.getOptionQuote(contract);
            Log.log('strikePrice: ', strikePrice, ' ltp: ', quote.ltp)
            
            result = contract;
            break;
        }

        if (result == null) {
            for(var depth = 1; depth < 5; depth++) {
                let strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice
                if (right == 'call') {
                    strikePrice -= (depth * factor)
                } else {
                    strikePrice += (depth * factor)
                }
                
                const contract = await nseIndex.findTokenFor(index, right, strikePrice);
                const quote = await this.getOptionQuote(contract);
                Log.log('strikePrice: ', strikePrice, ' ltp: ', quote.ltp)
                
                result = contract;
                break;
            }
        }

        return result

    }


    buyContract = async(contract, qty, price?, userContext?: UserContext) => {
        if (!price) {
            const quote = await this.getStockOptionQuote(contract);
            console.log('OptionQuote: ', quote)
            price = quote.ltp
        }
        const token = await this.getToken(contract);
        const lotSize = await this.findLotSizeByContract(contract);
        const lotSizeAsInt = parseInt(lotSize);
        if (!qty) {
            if (userContext?.investmentMode === 'investmentAmount') {
                const amountPerLot = price * lotSizeAsInt;
                qty = amountPerLot > 0 ? Math.floor(userContext.availableAmount / amountPerLot) * lotSizeAsInt : 0;
            } else {
                const lotCount = userContext?.lotCount ?? Config.lotCount;
                qty = lotCount * lotSizeAsInt;
            }
        }
        const user = userContext?.email;

        const transactionType = 'B'
        const limit = "LMT"
        const nse = "NFO"
        const normal = "M" //for fno
        let response= {} as any

        const parts = splitQty(qty)
        for (let i = 0; i < parts.length; i++) {
            const partQty = parts[i];
            const order = {
                "trantype": transactionType,
                "prd": normal,
                "exch": nse,
                "tsym": contract,
                "qty": partQty,
                "prctyp": limit,
                "prc": price
            }

    
            response = await this._placeOrderWithForce(order, user)
            Log.log(`[Order] Placed ${response?.tsym} orderId=${response?.norenordno} qty=${response?.qty} price=${response?.prc}`)
        }

        response.qty = qty
        return response

    }

    buyIndex = async({ userContext, index, ltp, right, qty }: { userContext?: UserContext, index: string, ltp?: number, right?: string, qty?: number }) => {
        Log.log('Buy Index ', index, ' ltp: ', ltp, ' right: ', right, ' qty: ', qty)
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
        // Log.log('LTP: ', ltp, ' FloorPrice: ', floorPrice, ' CeilPrice: ', ceilPrice)
        // Log.log('floorDiff: ', floorDiff, ' ceilDiff: ', ceilDiff, ' strikePrice: ', strikePrice)

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
            Log.log('Bidirection: ', Config.bidirection)
            await this.sendLimitOrder(putToken, putQuote.ltp, 'put', 'buy', qty, userContext);
            return await this.sendLimitOrder(callToken, callQuote.ltp, 'call', 'buy', qty, userContext);

        } else {
            if (right == 'call' || Config.selectedOption == 'call') {
                const callQuote = await this.getOptionQuote(callToken);
                return await this.sendLimitOrder(callToken, callQuote.ltp, 'call', 'buy', qty, userContext);
            } else if (right == 'put' || Config.selectedOption == 'put') {
                const putQuote = await this.getOptionQuote(putToken);
                return await this.sendLimitOrder(putToken, putQuote.ltp, 'put', 'buy', qty, userContext);
            } else {
                const callQuote = await this.getOptionQuote(callToken);
                const putQuote = await this.getOptionQuote(putToken);

                const callExtrinsicPrice = callQuote.ltp - callDiff
                const putExtrinsicPrice = putQuote.ltp - putDiff

                // If the value is more then people are thinking that option will move in that direction
                Log.log('callExtrinsicPrice: ', callExtrinsicPrice, ' putExtrinsicPrice: ', putExtrinsicPrice)
                Log.log('Call, buyQty: ', callQuote.buyQty, ' sellQty: ', callQuote.sellQty, ' change: ', callQuote.changePercent)
                Log.log('Put, buyQty: ', putQuote.buyQty, ' sellQty: ', putQuote.sellQty, ' change: ', putQuote.changePercent)

                if ((callQuote.buyQty > callQuote.sellQty) && (putQuote.buyQty < putQuote.sellQty)) {
                    calculatedRight = 'call'
                } else if ((callQuote.buyQty < callQuote.sellQty) && (putQuote.buyQty > putQuote.sellQty)) {
                    calculatedRight = 'put'
                }

                Log.log('calculatedRight: ', calculatedRight)
                if (calculatedRight == null) {
                    if (callExtrinsicPrice > putExtrinsicPrice) {
                        calculatedRight = 'call'
                    } else {
                        calculatedRight = 'put'
                    }
                }

                calculatedStrikePrice = (calculatedRight == 'put') ? putStrikePrice : callStrikePrice
                calculatedOptionPrice = (calculatedRight == 'put') ? putQuote.ltp : callQuote.ltp
                calculatedToken = (calculatedRight == 'put') ? putToken : callToken
                // Log.log('calculatedRight: ', calculatedRight, ' calculatedStrikePrice: ', calculatedStrikePrice)
                // Log.log('calculatedOptionPrice: ', calculatedOptionPrice, ' calculatedToken: ', calculatedToken)
                return await this.sendLimitOrder(calculatedToken, calculatedOptionPrice, calculatedRight, 'buy', qty, userContext);
            }
        }
    }

    calculateRight = async(ltp) => {
        const nseIndex = indexMap.get('NIFTY');
        let calculatedRight
        
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

        let callStrikePrice = strikePrice;
        const direction = (Config.optionDirection) == "OTM" ? 1 : -1
        callStrikePrice += direction * (Config.depth * factor)
        const callToken = await nseIndex.findTokenFor('NIFTY', 'call', callStrikePrice);
        
        const callDiff = ltp - callStrikePrice
        
    
        let putStrikePrice = strikePrice
        putStrikePrice += (-direction) * (Config.depth * factor)
        const putToken = await nseIndex.findTokenFor('NIFTY', 'put', putStrikePrice);
        
        const putDiff = putStrikePrice - ltp
        
        const callQuote = await this.getOptionQuote(callToken);
        const putQuote = await this.getOptionQuote(putToken);

        const callExtrinsicPrice = callQuote.ltp - callDiff
        const putExtrinsicPrice = putQuote.ltp - putDiff

        // If the value is more then people are thinking that option will move in that direction
        Log.log('callExtrinsicPrice: ', callExtrinsicPrice, ' putExtrinsicPrice: ', putExtrinsicPrice)
        Log.log('Call, buyQty: ', callQuote.buyQty, ' sellQty: ', callQuote.sellQty, ' change: ', callQuote.changePercent)
        Log.log('Put, buyQty: ', putQuote.buyQty, ' sellQty: ', putQuote.sellQty, ' change: ', putQuote.changePercent)
        
        if ((callQuote.buyQty > callQuote.sellQty) && (putQuote.buyQty < putQuote.sellQty)) {
            calculatedRight = 'call'
        } else if ((callQuote.buyQty < callQuote.sellQty) && (putQuote.buyQty > putQuote.sellQty)) {
            calculatedRight = 'put'
        }

        Log.log('calculatedRight: ', calculatedRight)
        if (calculatedRight == null) {
            if (callExtrinsicPrice > putExtrinsicPrice) {
                calculatedRight = 'call'
            } else {
                calculatedRight = 'put'
            }
        }
        return calculatedRight
        
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
            Log.log('Quote for Nifty: ', ltp)
    
        } else if (nseIndex.token == nseIndex.bankNiftyToken) {
            indexQuote = await this.getBankNiftyQuote()
            ltp = indexQuote.ltp
            Log.log('Quote for BankNifty: ', ltp)
        } else {
            indexQuote = await this.getFinNiftyQuote()
            Log.log('Quote for FinNifty: ', ltp)
            ltp = indexQuote.ltp
        } 

        for(let depth = 0; depth < 3; depth++) {
            let callStrikePrice = Math.floor(ltp/factor) * factor
            Log.log(' Config.optionDirection: ', Config.optionDirection)
            
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
            Log.log('Option ltp: ', callQuote.ltp)

            list.push(new StrikePrice('call', depth, ltp, callStrikePrice, callQuote.ltp, callExtrinsicPrice));
            list.push(new StrikePrice('put', depth, ltp, putStrikePrice, putQuote.ltp, putExtrinsicPrice));
    
        }
        Log.log(list)
    
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

        Log.log('Place Order in sell ', order);
        await NorenRestApi.place_order(order) as any;
        await AntStream.getInstance().unsubscribeOption(tsym);
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

    sendLimitOrder = async (tsym: string, price: number, right: string, action: string, quantity: number, userContext?: UserContext) : Promise<OrderInfo> => {
        const user = userContext?.email;
        const limit = "LMT"
        Log.log('tsym: ' +tsym);
        const indexObj = tsym.startsWith('BANK') ? indexMap.get('BANKNIFTY') : tsym.startsWith('NIFTY') ? indexMap.get('NIFTY') : indexMap.get('FINNIFTY');
        let qty = quantity;
        if (!qty) {
            qty = indexObj.getQuantity(price, userContext);
        }
        
        if (qty == 0) {
            Log.log('Order is not placed, qty: ', qty, ' price: ', price)
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
            "prc": round(price)
        }

        await this._placeOrder(order, user);
        const token = await this.getToken(order.tsym);
        return {
            "contract": tsym,
            "qty": qty,
            "price": price,
            "lastOrderedPrice": price,
            "token": token,
            "profit": 0,
            "status": OrderStatus.ORDERED
        }
        
    }

    _placeOrder = async (order, user?: string) => {
        // Can have a condition not to place an order
        await this._placeOrderWithForce(order, user)
    }

    _placeOrderWithForce = async (order, user?: string) => {
        try {
            Log.log('Place Order ', order);

            if (user) {
                bookkeeping.trackPendingOrder(order.tsym, user);
            }
            const response = await NorenRestApi.place_order(order) as any;
            Log.log('User: ', user, 'Response from place_order: ', response)
            if (user && response?.norenordno) {
                bookkeeping.trackOrder(response.norenordno, user);
                bookkeeping.clearPendingOrder(order.tsym, user);
            }
            const token = await this.getToken(order.tsym);
            if (!MOCK_BROKER) {
                await delay(2000)
            }
            Log.log('Returning price ', order.prc, ' for ', order.tsym)
    
            return {
                "contract": order.tsym,
                "qty": order.qty,
                "price": order.prc,
                "lastOrderedPrice": order.prc,
                "token": token,
                "profit": 0,
                "status": OrderStatus.ORDERED
            }
    
        } catch (e) {
            Log.log('Exception caught in _placeOrderWithForce', e)
        }
    }

    _getIndexFromToken = (token: string) => token.startsWith('BANK') ? 'BANKNIFTY' : token.startsWith('NIFTY') ? 'NIFTY' : 'FINNIFTY'

    squareOffOrder = async (token, qty, user?: string, price?: number) => {
        try {
            const tsym = await this.getContract(token);
            if (!tsym) {
                Log.log(`[Prism] squareOffOrder: could not resolve tsym for token ${token}`);
                return;
            }

            const order = {
                "trantype": 'S',
                "prd": "M",
                "exch": "NFO",
                "tsym": tsym,
                "qty": qty,
                "prctyp": price ? "LMT" : "MKT",
                "prc": price ?? 0
            }

            Log.log('Square off Order ', order);
            if (user) {
                bookkeeping.trackPendingOrder(tsym, user);
            }
            const orderReply = await NorenRestApi.place_order(order) as any;
            if (user && orderReply?.data?.norenordno) {
                bookkeeping.trackOrder(orderReply.data.norenordno, user);
                bookkeeping.clearPendingOrder(tsym, user);
            }
        } catch (e) {
            Log.log(`[Prism] squareOffOrder failed for token ${token}:`, e?.message ?? e);
        }
    }

    getOrders = async () => {
        const orders : Order[] = []
        const response = await NorenRestApi.get_orderbook() as any
        // Log.log('Response: ', response)
        for(let i = 0; i < response.length; i++) {
            const orderItem = response[i];
            Log.log('Order Item: ', orderItem)
            if (orderItem.stat !== 'Not_Ok') { 
                if (orderItem.status != 'COMPLETE') {
                    const order = Order.fromPrism(orderItem)
                    order.token = await this.getToken(order.tsym)
                    orders.push(order)
                }                
            }
        }
        
        Log.log('Orders size: ', orders)
       
        return orders
    }

    getTradeList = () => {
        return bookkeeping.trades;
    }


    refreshTradeList = async () => {
        // const response = await NorenRestApi.get_tradebook() as any
        const response = await NorenRestApi.get_positions() as any
        Log.log('Positions: ', response)

        const trades: Trade[] = []
        if (response.stat == 'Not_Ok') {
            return;
        }
        response.forEach(element => {
            if (parseInt(element.netqty, 10) > 0)
                Log.log('Construct trade now in refresh trades')
                var trade = Trade.fromPrism(element);
                Log.log('Trade sym: ', trade.tsym, ' trade.quantity: ', trade.quantity)
                if (trade.tsym.startsWith('NIFTY') && trade.quantity > 0) {
                    trades.push(trade)
                }
        });
        bookkeeping.refreshTrades(trades);
        return bookkeeping.trades;
    }
}




