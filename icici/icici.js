"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
var browser_js_1 = require("./browser.js");
var selenium_webdriver_1 = require("selenium-webdriver");
// import EventEmitter from 'events';
var delay_1 = require("delay");
// import cheerio from 'cheerio'
var axios_1 = require("axios");
var lodash_1 = require("lodash");
var icicinse_1 = require("./icicinse");
var Quote = /** @class */ (function () {
    function Quote() {
    }
    return Quote;
}());
var Order = /** @class */ (function () {
    function Order(action, symbol, price, status, cancelAnchor, ltp) {
        this.action = action.trim();
        this.symbol = symbol.trim();
        this.price = price;
        this.status = status;
        this.cancelAnchor = cancelAnchor;
        this.ltp = ltp;
    }
    return Order;
}());
var instance = axios_1["default"].create();
instance.defaults.headers.common["User-Agent"] = "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.70 Safari/537.36";
var Icici = /** @class */ (function () {
    function Icici() {
        var _this = this;
        // username = 'WK133843'
        // password = 'nivi5000'
        // dob = '31081975'
        this.username = 'SSUKK001';
        this.password = 'nand1000';
        this.dob = '24011976';
        this.login = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.browser.writeById('txtUserId', this.username)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById('txtPass', this.password)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById('txtDOB', this.dob)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById('Button1')];
                    case 4:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.print = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.browser.takeScreenshot()];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.html()];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.home = function () { return __awaiter(_this, void 0, void 0, function () {
            var home;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        home = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[1]/a';
                        return [4 /*yield*/, this.browser.clickByXpath(home)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.getNetWorth = function () { return __awaiter(_this, void 0, void 0, function () {
            var networth, amount, webElement, _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        networth = '//*[@id="pnlQpnl"]/ul/li[6]/a';
                        amount = '//*[@id="MainSection"]/div/div[3]/table/tbody/tr/td/table/tbody/tr[3]/td[2]';
                        return [4 /*yield*/, this.browser.clickByXpath(networth)];
                    case 1:
                        _d.sent();
                        return [4 /*yield*/, this.browser.findByXpath(amount)];
                    case 2:
                        webElement = _d.sent();
                        _b = (_a = console).log;
                        _c = ['AMount '];
                        return [4 /*yield*/, webElement.getAttribute('innerHTML')];
                    case 3:
                        _b.apply(_a, _c.concat([_d.sent()]));
                        return [4 /*yield*/, this.getNumber(webElement)];
                    case 4: return [2 /*return*/, _d.sent()];
                }
            });
        }); };
        this.iciciToNse = function (symbol) {
        };
        this.getQuote = function (symbol) { return __awaiter(_this, void 0, void 0, function () {
            var extract, found, quoteTable, table, html, rows, quote, _a, _b;
            var _this = this;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        extract = function (row, col) { return __awaiter(_this, void 0, void 0, function () {
                            var cells;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, rows[row].findElements(selenium_webdriver_1.By.tagName("td"))];
                                    case 1:
                                        cells = _a.sent();
                                        return [2 /*return*/, cells[col].getText()];
                                }
                            });
                        }); };
                        found = lodash_1["default"].find(icicinse_1["default"], { Icici: symbol });
                        // const html = await axios.get(`https://www.nseindia.com/live_market/dynaContent/live_watch/get_quote/GetQuote.jsp?symbol=${found.Nse}`)
                        // require('fs').writeFile("./quote.html", html.data, function(err) {
                        //     if(err) {
                        //         return 
                        //     }
                        //     
                        // });
                        // const $ = cheerio.load(html.data)
                        // 
                        // 
                        // const lp = $('#lastPrice').get(0)
                        // 
                        // 
                        // for (let nm in lp.attribs) {
                        //     const v = lp.attribs[nm];
                        //     
                        // }
                        // const quote = new Quote()
                        // quote.lastTradePrice = Number($('#lastPrice').text().replace(',', ''))
                        // quote.change = Number($('#change').text().replace(',', ''))
                        // return quote
                        return [4 /*yield*/, this.browser.visit("https://getquote.icicidirect.com/trading_stock_quote.aspx?Symbol=" + symbol)];
                    case 1:
                        // const html = await axios.get(`https://www.nseindia.com/live_market/dynaContent/live_watch/get_quote/GetQuote.jsp?symbol=${found.Nse}`)
                        // require('fs').writeFile("./quote.html", html.data, function(err) {
                        //     if(err) {
                        //         return 
                        //     }
                        //     
                        // });
                        // const $ = cheerio.load(html.data)
                        // 
                        // 
                        // const lp = $('#lastPrice').get(0)
                        // 
                        // 
                        // for (let nm in lp.attribs) {
                        //     const v = lp.attribs[nm];
                        //     
                        // }
                        // const quote = new Quote()
                        // quote.lastTradePrice = Number($('#lastPrice').text().replace(',', ''))
                        // quote.change = Number($('#change').text().replace(',', ''))
                        // return quote
                        _c.sent();
                        quoteTable = '//*[@id="NewHide"]/table';
                        return [4 /*yield*/, this.browser.findById('NewHide')];
                    case 2:
                        table = _c.sent();
                        return [4 /*yield*/, table.getAttribute("innerHTML")
                            // Now get all the TR elements from the table 
                        ];
                    case 3:
                        html = _c.sent();
                        return [4 /*yield*/, table.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 4:
                        rows = _c.sent();
                        quote = new Quote();
                        _a = quote;
                        return [4 /*yield*/, extract(1, 1)];
                    case 5:
                        _a.lastTradePrice = _c.sent();
                        _b = quote;
                        return [4 /*yield*/, extract(7, 1)
                            // await this.browser.closeTab()
                        ];
                    case 6:
                        _b.change = _c.sent();
                        // await this.browser.closeTab()
                        return [2 /*return*/, quote];
                }
            });
        }); };
        this.marginPlusBracketOrder = function (symbol, percent) { return __awaiter(_this, void 0, void 0, function () {
            var home;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        home = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[1]/a';
                        return [4 /*yield*/, this.buyMarginPlus('buy', symbol, percent)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(home)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, this.buyMarginPlus('sell', symbol, percent)];
                    case 4:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 5:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.cancelMarginOrders = function (forced) { return __awaiter(_this, void 0, void 0, function () {
            var portfolioDropDown, orderBook, orderTable, confirm, tableElement, rows, cancelSymbols, orderList, i, row, cells, symbolLabels, symbol, statusHtml, status_1, action, i, row, cells, symbolLabels, symbol, actionAnchors, cancelAnchor, _i, actionAnchors_1, innerHTML;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        console.log('Forced ', forced); //TODO what if there are open positions
                        portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span';
                        orderBook = '//*[@id="pnlportmnusub"]/ul/li[5]/a';
                        orderTable = '//*[@id="TABLE_1"]';
                        confirm = 'Submit1';
                        return [4 /*yield*/, this.browser.clickByXpath(portfolioDropDown)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(orderBook)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findElements(orderTable)];
                    case 3:
                        tableElement = _a.sent();
                        return [4 /*yield*/, tableElement[1].findElements(selenium_webdriver_1.By.css("tr"))];
                    case 4:
                        rows = _a.sent();
                        cancelSymbols = new Set();
                        if (!!forced) return [3 /*break*/, 13];
                        orderList = [];
                        i = 0;
                        _a.label = 5;
                    case 5:
                        if (!(i < rows.length)) return [3 /*break*/, 13];
                        return [4 /*yield*/, rows[i]];
                    case 6:
                        row = _a.sent();
                        return [4 /*yield*/, row.findElements(selenium_webdriver_1.By.css('td'))];
                    case 7:
                        cells = _a.sent();
                        if (cells.length < 5) {
                            return [3 /*break*/, 12];
                        }
                        return [4 /*yield*/, cells[0].findElements(selenium_webdriver_1.By.css('label'))];
                    case 8:
                        symbolLabels = _a.sent();
                        return [4 /*yield*/, symbolLabels[0].getAttribute('innerHTML')];
                    case 9:
                        symbol = _a.sent();
                        return [4 /*yield*/, cells[11].getAttribute('innerHTML')];
                    case 10:
                        statusHtml = _a.sent();
                        statusHtml = statusHtml.trim();
                        if (statusHtml === 'Cancelled&nbsp;') {
                            cancelSymbols.add(symbol.trim());
                        }
                        status_1 = statusHtml === 'Ordered&nbsp' ? 'Ordered' : 'Executed';
                        return [4 /*yield*/, cells[3].getAttribute('innerHTML')
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
                        ];
                    case 11:
                        action = _a.sent();
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
                        console.log(symbol.trim(), ' ', statusHtml);
                        _a.label = 12;
                    case 12:
                        i++;
                        return [3 /*break*/, 5];
                    case 13:
                        console.log("Iteration 1 ", new Date());
                        console.log('Cancellable symbols ', cancelSymbols);
                        i = 0;
                        _a.label = 14;
                    case 14:
                        if (!(i < rows.length)) return [3 /*break*/, 29];
                        return [4 /*yield*/, rows[i]];
                    case 15:
                        row = _a.sent();
                        return [4 /*yield*/, row.findElements(selenium_webdriver_1.By.css('td'))];
                    case 16:
                        cells = _a.sent();
                        if (cells.length < 5) {
                            return [3 /*break*/, 28];
                        }
                        return [4 /*yield*/, cells[0].findElements(selenium_webdriver_1.By.css('label'))];
                    case 17:
                        symbolLabels = _a.sent();
                        return [4 /*yield*/, symbolLabels[0].getAttribute('innerHTML')];
                    case 18:
                        symbol = _a.sent();
                        symbol = symbol.trim();
                        console.log('Symbol: ', symbol);
                        if (!(forced || cancelSymbols.has(symbol))) return [3 /*break*/, 28];
                        return [4 /*yield*/, cells[12].findElements(selenium_webdriver_1.By.tagName('a'))];
                    case 19:
                        actionAnchors = _a.sent();
                        cancelAnchor = void 0;
                        if (!(actionAnchors.length > 1)) return [3 /*break*/, 28];
                        if (!(actionAnchors.length > 2)) return [3 /*break*/, 28];
                        _i = 0, actionAnchors_1 = actionAnchors;
                        _a.label = 20;
                    case 20:
                        if (!(_i < actionAnchors_1.length)) return [3 /*break*/, 28];
                        cancelAnchor = actionAnchors_1[_i];
                        return [4 /*yield*/, cancelAnchor.getAttribute('innerHTML')
                            // console.log('Cancel ', innerHTML)
                        ];
                    case 21:
                        innerHTML = _a.sent();
                        if (!(innerHTML === 'Cancel')) return [3 /*break*/, 27];
                        return [4 /*yield*/, cancelAnchor.click()];
                    case 22:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(confirm)];
                    case 23:
                        _a.sent();
                        return [4 /*yield*/, this.home()];
                    case 24:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](500)];
                    case 25:
                        _a.sent();
                        return [4 /*yield*/, this.cancelMarginOrders()]; //TODO, not working to cancel in next iteration
                    case 26:
                        _a.sent(); //TODO, not working to cancel in next iteration
                        _a.label = 27;
                    case 27:
                        _i++;
                        return [3 /*break*/, 20];
                    case 28:
                        i++;
                        return [3 /*break*/, 14];
                    case 29: return [2 /*return*/];
                }
            });
        }); };
        this.buyMarginPlus = function (action, symbol, percent) { return __awaiter(_this, void 0, void 0, function () {
            var stopLossPercent, marginPlusMenu, stock, buy, sell, market, limit, limitPrice, qty, stopLossPrice, submitButton, proceedButton, nsePrice, priceTag, priceHtml, price;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        stopLossPercent = 2;
                        marginPlusMenu = '//*[@id="pnltrnmnu"]/ul/li[7]/a';
                        stock = 'stcode';
                        buy = '//*[@id="pnltabtrans"]/div/div[4]/div/label';
                        sell = '//*[@id="pnltabtrans"]/div/div[4]/div/span/label';
                        market = '//*[@id="pnltabtrans"]/div/div[5]/div/label';
                        limit = '//*[@id="pnltabtrans"]/div/div[5]/div/span/label';
                        limitPrice = 'mMarginPlusLmtRate';
                        qty = 'FML_QTY';
                        stopLossPrice = 'FML_ORD_STP_LSS';
                        submitButton = '//*[@id="pnltabtrans"]/div/div[14]/input';
                        proceedButton = 'btneqprocess';
                        return [4 /*yield*/, this.browser.clickByXpath(marginPlusMenu)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById(stock, symbol)];
                    case 2:
                        _a.sent();
                        nsePrice = '//*[@id="dvStockVal"]/div[2]/div[1]/span[2]';
                        return [4 /*yield*/, this.browser.findByXpath(nsePrice)];
                    case 3:
                        priceTag = _a.sent();
                        return [4 /*yield*/, priceTag.getAttribute("innerHTML")];
                    case 4:
                        priceHtml = _a.sent();
                        price = Number(priceHtml.replace(',', ''));
                        console.log('Price ', price);
                        if (!(action === 'buy')) return [3 /*break*/, 6];
                        console.log('Reducing ', percent, '%');
                        price = this.reducePercent(price, percent);
                        console.log('Reduced Price ', price);
                        return [4 /*yield*/, this.browser.clickByXpath(buy)];
                    case 5:
                        _a.sent();
                        return [3 /*break*/, 8];
                    case 6:
                        console.log('Adding ', percent, '%');
                        price = this.addPercent(price, percent);
                        console.log('Added Price ', price);
                        return [4 /*yield*/, this.browser.clickByXpath(sell)];
                    case 7:
                        _a.sent();
                        _a.label = 8;
                    case 8:
                        if (!price) return [3 /*break*/, 11];
                        return [4 /*yield*/, this.browser.clickByXpath(limit)];
                    case 9:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById(limitPrice, price)];
                    case 10:
                        _a.sent();
                        return [3 /*break*/, 13];
                    case 11: return [4 /*yield*/, this.browser.clickByXpath(market)];
                    case 12:
                        _a.sent();
                        _a.label = 13;
                    case 13: return [4 /*yield*/, this.browser.writeById(qty, 1000)]; // TODO Hardcoded to 1000 qty always
                    case 14:
                        _a.sent(); // TODO Hardcoded to 1000 qty always
                        console.log('Transaction Price', price);
                        if (action === 'buy') {
                            price = this.reducePercent(price, stopLossPercent);
                            console.log('Reduced StopLoss Price ', price);
                        }
                        else {
                            price = this.addPercent(price, stopLossPercent);
                            console.log('Added StopLoss Price ', price);
                        }
                        console.log('Price for STP ', price);
                        return [4 /*yield*/, this.browser.writeById(stopLossPrice, price)];
                    case 15:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 16:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(submitButton)];
                    case 17:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 18:
                        _a.sent();
                        this.browser.clickById(proceedButton);
                        return [2 /*return*/];
                }
            });
        }); };
        this.monitorMarginPlusOpenPositions = function () { return __awaiter(_this, void 0, void 0, function () {
            var portfolioDropDown, openPositions, marginPlusOpenPositions, profitLimitPrice, submitButton, proceedButton, orderNow, element, rows, i, row, cells, j, cell, innerHtml, executedPrice, executedAction, pl, anchors, anchors, newPrice;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span';
                        openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a';
                        marginPlusOpenPositions = '//*[@id="pnlctlLeft1"]/div/div/div[1]/ul/li[2]/a';
                        profitLimitPrice = 'FML_ORD_LMT_RT';
                        submitButton = 'Submit1';
                        proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input';
                        orderNow = 'Submit';
                        this.browser.clickByXpath(portfolioDropDown);
                        this.browser.clickByXpath(openPositions);
                        this.browser.clickByXpath(marginPlusOpenPositions);
                        return [4 /*yield*/, delay_1["default"](3000)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findByXpath('//*[@id="pnlmargin_plus"]/div/table')];
                    case 2:
                        element = _a.sent();
                        return [4 /*yield*/, element.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 3:
                        rows = _a.sent();
                        i = 0;
                        _a.label = 4;
                    case 4:
                        if (!(i < rows.length)) return [3 /*break*/, 27];
                        return [4 /*yield*/, rows[i]];
                    case 5:
                        row = _a.sent();
                        return [4 /*yield*/, row.findElements(selenium_webdriver_1.By.tagName('td'))];
                    case 6:
                        cells = _a.sent();
                        if (cells.length < 5) {
                            return [3 /*break*/, 26];
                        }
                        for (j = 0; j < cells.length; j++) {
                            cell = cells[j];
                            // console.log('Cell ', j , ' ', await cell.getAttribute('innerHTML'))              
                        }
                        return [4 /*yield*/, cells[3].getAttribute('innerHTML')];
                    case 7:
                        innerHtml = _a.sent();
                        executedPrice = Number(innerHtml.replace(',', ''));
                        console.log('Executed Price ', executedPrice);
                        return [4 /*yield*/, cells[1].getAttribute('innerHTML')];
                    case 8:
                        innerHtml = _a.sent();
                        executedAction = innerHtml.trim();
                        console.log('Executed Action ', executedAction);
                        return [4 /*yield*/, cells[10].getAttribute('innerHTML')];
                    case 9:
                        innerHtml = _a.sent();
                        pl = Number(innerHtml.replace(',', ''));
                        console.log('PL ', pl);
                        if (!(pl > 1500)) return [3 /*break*/, 18];
                        console.log('Do a Market Square Off ');
                        return [4 /*yield*/, cells[14].findElements(selenium_webdriver_1.By.css('a'))];
                    case 10:
                        anchors = _a.sent();
                        return [4 /*yield*/, anchors[0].click()];
                    case 11:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 12:
                        _a.sent();
                        console.log('Click Order Now');
                        return [4 /*yield*/, this.browser.clickById(orderNow)];
                    case 13:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 14:
                        _a.sent();
                        console.log('Click Proceed Button');
                        return [4 /*yield*/, this.browser.clickByXpath(proceedButton)];
                    case 15:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 16:
                        _a.sent();
                        return [4 /*yield*/, this.monitorMarginPlusOpenPositions()
                            //TODO did not execute 2nd market order
                        ];
                    case 17:
                        _a.sent();
                        return [3 /*break*/, 26];
                    case 18:
                        console.log('Place Profit Order');
                        return [4 /*yield*/, cells[8].findElements(selenium_webdriver_1.By.css('a'))];
                    case 19:
                        anchors = _a.sent();
                        console.log("Anchors ", anchors);
                        if (!(anchors.length === 1)) return [3 /*break*/, 26];
                        //TODO state is changed 
                        return [4 /*yield*/, anchors[0].click()];
                    case 20:
                        //TODO state is changed 
                        _a.sent();
                        newPrice = executedAction === 'Buy' ? this.addPercent(executedPrice, 0.5) : this.reducePercent(executedPrice, 0.5) // TODO Hard coded to 0.5%, so less
                        ;
                        console.log('New Price ', newPrice);
                        return [4 /*yield*/, this.browser.writeById(profitLimitPrice, newPrice)];
                    case 21:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(submitButton)];
                    case 22:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(proceedButton)];
                    case 23:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](500)];
                    case 24:
                        _a.sent();
                        return [4 /*yield*/, this.monitorMarginPlusOpenPositions()
                            //SLTP-Profit order limit price difference is less than the defined value.: It should differ by atleast 0.35 percentage
                        ]; //TODO
                    case 25:
                        _a.sent(); //TODO
                        _a.label = 26;
                    case 26:
                        i++;
                        return [3 /*break*/, 4];
                    case 27: return [2 /*return*/];
                }
            });
        }); };
        this.addPercent = function (value, percent) {
            return Math.round((value + ((percent / 100) * value)) * 10) / 10;
        };
        this.reducePercent = function (value, percent) {
            return Math.round((value - ((percent / 100) * value)) * 10) / 10;
        };
        this.monitorMarginOpenPositions = function () { return __awaiter(_this, void 0, void 0, function () {
            var portfolioDropDown, openPositions, openMarginTable, profitLimitPrice, sqoffQty, submitButton, proceedButton, element, rows, i, row, cells, innerHTML, plPrice, avgPrice, anchors;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span';
                        openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a';
                        openMarginTable = '//*[@id="dvorddtl"]/div/table[2]';
                        profitLimitPrice = 'FML_ORD_LMT_RT';
                        sqoffQty = 'FML_SQROFF';
                        submitButton = 'Submit1';
                        proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input';
                        this.browser.clickByXpath(portfolioDropDown);
                        this.browser.clickByXpath(openPositions);
                        return [4 /*yield*/, delay_1["default"](3000)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findByXpath(openMarginTable)];
                    case 2:
                        element = _a.sent();
                        return [4 /*yield*/, element.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 3:
                        rows = _a.sent();
                        i = 0;
                        _a.label = 4;
                    case 4:
                        if (!(i < rows.length)) return [3 /*break*/, 18];
                        return [4 /*yield*/, rows[i]];
                    case 5:
                        row = _a.sent();
                        return [4 /*yield*/, row.findElements(selenium_webdriver_1.By.tagName('td'))];
                    case 6:
                        cells = _a.sent();
                        if (cells.length < 5) {
                            return [3 /*break*/, 17];
                        }
                        return [4 /*yield*/, cells[10].getAttribute('innerHTML')];
                    case 7:
                        innerHTML = _a.sent();
                        plPrice = Number(innerHTML.replace(',', ''));
                        return [4 /*yield*/, cells[6].getAttribute('innerHTML')];
                    case 8:
                        innerHTML = _a.sent();
                        avgPrice = Number(innerHTML.replace(',', ''));
                        return [4 /*yield*/, cells[13].findElements(selenium_webdriver_1.By.tagName('a'))];
                    case 9:
                        anchors = _a.sent();
                        if (!(anchors.length > 2)) return [3 /*break*/, 17];
                        return [4 /*yield*/, anchors[1].click()];
                    case 10:
                        _a.sent(); // square off 
                        return [4 /*yield*/, delay_1["default"](2000)];
                    case 11:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById(sqoffQty, 1000)]; //TODO Hardcoded to 1000
                    case 12:
                        _a.sent(); //TODO Hardcoded to 1000
                        return [4 /*yield*/, this.browser.writeById(profitLimitPrice, (avgPrice + 1))]; //TODO Hardcoded to 1 rupee fro TATMOT
                    case 13:
                        _a.sent(); //TODO Hardcoded to 1 rupee fro TATMOT
                        return [4 /*yield*/, this.browser.clickById(submitButton)];
                    case 14:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(proceedButton)];
                    case 15:
                        _a.sent();
                        return [4 /*yield*/, this.monitorMarginOpenPositions()];
                    case 16:
                        _a.sent();
                        _a.label = 17;
                    case 17:
                        i++;
                        return [3 /*break*/, 4];
                    case 18: return [2 /*return*/];
                }
            });
        }); };
        this.monitorOptionPlusOpenPositions = function () { return __awaiter(_this, void 0, void 0, function () {
            var portfolioDropDown, openPositions, fnoMenu, optionPlus, optionPlusTable, submitButton, proceedButton, element, rows, i, row, cells, j, innerHtml, plprice, anchors;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span';
                        openPositions = '//*[@id="pnlportmnusub"]/ul/li[2]/a';
                        fnoMenu = '//*[@id="pnlMainRow"]/span/div/div[1]/ul/li[2]/a';
                        optionPlus = '//*[@id="pnlctlLeft1"]/span/div/div/ul/li[5]/a';
                        optionPlusTable = '//*[@id="divOpenPosition"]/div[1]/table';
                        submitButton = 'Submit1';
                        proceedButton = '//*[@id="dvverify"]/div/div/div/div[3]/ul/li[2]/input';
                        return [4 /*yield*/, this.browser.clickByXpath(portfolioDropDown)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(openPositions)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](2000)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(fnoMenu)];
                    case 4:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](2000)];
                    case 5:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(optionPlus)];
                    case 6:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](3000)];
                    case 7:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findByXpath(optionPlusTable)];
                    case 8:
                        element = _a.sent();
                        return [4 /*yield*/, element.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 9:
                        rows = _a.sent();
                        i = 0;
                        _a.label = 10;
                    case 10:
                        if (!(i < rows.length)) return [3 /*break*/, 16];
                        return [4 /*yield*/, rows[i]
                            // 
                        ];
                    case 11:
                        row = _a.sent();
                        return [4 /*yield*/, row.findElements(selenium_webdriver_1.By.tagName('td'))];
                    case 12:
                        cells = _a.sent();
                        if (cells.length < 7) {
                            return [3 /*break*/, 15];
                        }
                        for (j = 0; j < cells.length; j++) {
                        }
                        return [4 /*yield*/, cells[10].getAttribute('innerHTML')];
                    case 13:
                        innerHtml = _a.sent();
                        plprice = Number(innerHtml.replace(',', ''));
                        if (!(plprice > 500)) return [3 /*break*/, 15];
                        return [4 /*yield*/, cells[7].findElements(selenium_webdriver_1.By.tagName('a'))];
                    case 14:
                        anchors = _a.sent();
                        if (anchors.length > 1) {
                            // anchors[1].click() // Click Square off at Market
                        }
                        _a.label = 15;
                    case 15:
                        i++;
                        return [3 /*break*/, 10];
                    case 16: return [2 /*return*/];
                }
            });
        }); };
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
        this.isThereActiveOptionPlusOrder = function () { return __awaiter(_this, void 0, void 0, function () {
            var portfolioDropDown, orderBook, fno, productDropDown, optionPlus, viewButton, orderTable, orders, rows, i, cells, status_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        portfolioDropDown = '//*[@id="pnlMnuLogin"]/div/div[1]/ul/li[3]/a/span';
                        orderBook = '//*[@id="pnlportmnusub"]/ul/li[5]/a';
                        fno = '//*[@id="order_book"]/div/ul/li[2]/a';
                        productDropDown = '//*[@id="FFO_PRDCT_TYP-button"]/span[1]';
                        optionPlus = 'ui-id-9';
                        viewButton = 'Go';
                        orderTable = '//*[@id="gridSource"]/tbody';
                        return [4 /*yield*/, this.browser.clickByXpath(portfolioDropDown)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(orderBook)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(fno)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(productDropDown)];
                    case 4:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(optionPlus)];
                    case 5:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(viewButton)];
                    case 6:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](2000)];
                    case 7:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findByXpath(orderTable)];
                    case 8:
                        orders = _a.sent();
                        return [4 /*yield*/, orders.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 9:
                        rows = _a.sent();
                        i = 0;
                        _a.label = 10;
                    case 10:
                        if (!(i < rows.length)) return [3 /*break*/, 14];
                        return [4 /*yield*/, rows[i].findElements(selenium_webdriver_1.By.tagName('td'))];
                    case 11:
                        cells = _a.sent();
                        if (cells.length < 7) {
                            return [3 /*break*/, 13];
                        }
                        return [4 /*yield*/, cells[4].getAttribute('innerHTML')];
                    case 12:
                        status_2 = _a.sent();
                        if (status_2.trim() === 'Ordered') {
                            return [2 /*return*/, true];
                        }
                        _a.label = 13;
                    case 13:
                        i++;
                        return [3 /*break*/, 10];
                    case 14: return [2 /*return*/, false];
                }
            });
        }); };
        this.buyOptionPlus = function () { return __awaiter(_this, void 0, void 0, function () {
            var fnoMenu, optionPlusMenu, selectContract, spotPrice, contractsList, call, put, stock, buy, sell, qty, market, limit, limitPrice, stopLossPrice, submitButton, proceedButton, element, innerHtml, currentPrice, contracts, rows, anchors, ltp, i, row, cells, j, thisContractPrice, less10percent;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        fnoMenu = '//*[@id="pnlTradeLanding"]/div[1]/div[1]/ul/li[3]/a';
                        optionPlusMenu = '//*[@id="pnlOrdMnu"]/ul/li[5]/a';
                        selectContract = '//*[@id="SelContract"]/li[1]/a';
                        spotPrice = '//*[@id="pnlConList"]/div[1]/h3/a';
                        contractsList = 'contList';
                        call = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[1]';
                        put = '//*[@id="pnltabtrans"]/div[1]/div[3]/div/label[2]';
                        stock = 'FFO_UNDRLYNG';
                        buy = '//*[@id="pnltabtrans"]/div[1]/div[5]/div/label[1]';
                        sell = '//*[@id="pnltabtrans"]/div[1]/div[5]/div/label[2]';
                        qty = 'FFO_QTY';
                        market = '//*[@id="pnltabtrans"]/div[1]/div[8]/div/label';
                        limit = '//*[@id="pnltabtrans"]/div[1]/div[8]/div/span/label';
                        limitPrice = 'FreshFFO_LMT_RT';
                        stopLossPrice = 'FFO_STP_LSS_TGR';
                        submitButton = 'Submit';
                        proceedButton = 'smt';
                        return [4 /*yield*/, this.browser.clickByXpath(fnoMenu)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(optionPlusMenu)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(call)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, this.browser.writeById(stock, 'NIFTY')];
                    case 4:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickByXpath(selectContract)];
                    case 5:
                        _a.sent();
                        return [4 /*yield*/, this.browser.findByXpath(spotPrice)];
                    case 6:
                        element = _a.sent();
                        return [4 /*yield*/, element.getAttribute('innerHTML')];
                    case 7:
                        innerHtml = _a.sent();
                        currentPrice = Number(innerHtml.replace(',', ''));
                        return [4 /*yield*/, this.browser.findById(contractsList)];
                    case 8:
                        contracts = _a.sent();
                        return [4 /*yield*/, contracts.findElements(selenium_webdriver_1.By.tagName("tr"))];
                    case 9:
                        rows = _a.sent();
                        i = 0;
                        _a.label = 10;
                    case 10:
                        if (!(i < rows.length)) return [3 /*break*/, 17];
                        return [4 /*yield*/, rows[i].getAttribute('innerHTML')];
                    case 11:
                        row = _a.sent();
                        return [4 /*yield*/, rows[i].findElements(selenium_webdriver_1.By.tagName('td'))];
                    case 12:
                        cells = _a.sent();
                        if (cells.length < 7) {
                            return [3 /*break*/, 16];
                        }
                        for (j = 0; j < cells.length; j++) {
                            // 
                        }
                        return [4 /*yield*/, cells[2].getAttribute('innerHTML')];
                    case 13:
                        innerHtml = _a.sent();
                        thisContractPrice = Number(innerHtml.replace(',', ''));
                        if (!(thisContractPrice > currentPrice)) return [3 /*break*/, 16];
                        return [4 /*yield*/, cells[7].findElements(selenium_webdriver_1.By.tagName('a'))];
                    case 14:
                        anchors = _a.sent();
                        return [4 /*yield*/, cells[4].getAttribute('innerHTML')];
                    case 15:
                        ltp = _a.sent();
                        ltp = Number(ltp.replace(',', ''));
                        return [3 /*break*/, 17];
                    case 16:
                        i++;
                        return [3 /*break*/, 10];
                    case 17: return [4 /*yield*/, anchors[0].click()]; //TODO Decide between buy and sell
                    case 18:
                        _a.sent(); //TODO Decide between buy and sell
                        return [4 /*yield*/, this.browser.writeById(qty, 750)]; //TODO always 10 lot
                    case 19:
                        _a.sent(); //TODO always 10 lot
                        return [4 /*yield*/, this.browser.clickByXpath(limit)]; //TODO always limit ?
                    case 20:
                        _a.sent(); //TODO always limit ?
                        less10percent = this.reducePercent(ltp, 10);
                        return [4 /*yield*/, this.browser.writeById(limitPrice, less10percent)]; //TODO what should be the price ??
                    case 21:
                        _a.sent(); //TODO what should be the price ??
                        return [4 /*yield*/, this.browser.writeById(stopLossPrice, less10percent - 3)]; //TODO always less than by 2 as it will be converted to less than 10
                    case 22:
                        _a.sent(); //TODO always less than by 2 as it will be converted to less than 10
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 23:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(submitButton)];
                    case 24:
                        _a.sent();
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 25:
                        _a.sent();
                        return [4 /*yield*/, this.browser.clickById(proceedButton)];
                    case 26:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.getNumber = function (webElement) { return __awaiter(_this, void 0, void 0, function () {
            var innerHTML;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, webElement.getAttribute('innerHTML')];
                    case 1:
                        innerHTML = _a.sent();
                        return [2 /*return*/, Number(innerHTML.replace(',', ''))];
                }
            });
        }); };
        this.browser = new browser_js_1["default"]();
        this.browser.visit('https://secure.icicidirect.com/IDirectTrading/customer/login.aspx');
        // this.myEmitter = new EventEmitter();
        // this.myEmitter.on('ordered', () => {
        //     // Only if there are open positions, monitor every minute, cancel once a profit order is placed
        //     setInterval(this.monitorMarginPlusOpenPositions, 15 * 1000)
        // })
    }
    return Icici;
}());
exports["default"] = Icici;
;
