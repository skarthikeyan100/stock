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
var selenium_webdriver_1 = require("selenium-webdriver");
var chrome_1 = require("selenium-webdriver/chrome");
var delay_1 = require("delay");
var Browser = /** @class */ (function () {
    function Browser() {
        var _this = this;
        // visit a webpage
        this.visit = function (theUrl) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.get(theUrl)];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        // quit current session
        this.quit = function () {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.quit()];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        // wait and find a specific element with it's id
        this.findById = function (id) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.wait(selenium_webdriver_1.until.elementLocated(selenium_webdriver_1.By.id(id)), 15000, 'Looking for element')];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, this.driver.findElement(selenium_webdriver_1.By.id(id))];
                        case 2: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        // wait and find a specific element with it's name
        this.findByName = function (name) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.wait(selenium_webdriver_1.until.elementLocated(selenium_webdriver_1.By.name(name)), 15000, 'Looking for element')];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, this.driver.findElement(selenium_webdriver_1.By.name(name))];
                        case 2: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        // wait and find a specific element with it's name
        this.findByXpath = function (xpath) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.wait(selenium_webdriver_1.until.elementLocated(selenium_webdriver_1.By.xpath(xpath)), 15000, "Looking for element " + xpath)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, this.driver.findElement(selenium_webdriver_1.By.xpath(xpath))];
                        case 2: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        // wait and find a specific element with it's name
        this.findElements = function (xpath) {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, this.driver.findElements(selenium_webdriver_1.By.xpath(xpath))];
                        case 1: return [2 /*return*/, _a.sent()];
                    }
                });
            });
        };
        this.openTab = function (url) { return __awaiter(_this, void 0, void 0, function () {
            var e, source, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        e = "window.open(\"" + url + "\")";
                        return [4 /*yield*/, this.driver.executeScript(e)];
                    case 1:
                        source = _b.sent();
                        delay_1["default"](2000);
                        _a = this;
                        return [4 /*yield*/, this.driver.getAllWindowHandles()];
                    case 2:
                        _a.tabs = _b.sent();
                        return [4 /*yield*/, this.driver.switchTo().window(this.tabs[1])];
                    case 3:
                        _b.sent(); //switches to new tab
                        this.driver.get(url);
                        return [2 /*return*/];
                }
            });
        }); };
        this.closeTab = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this.driver.switchTo().window(this.tabs[1]);
                this.driver.close();
                this.driver.switchTo().window(this.tabs[0]);
                return [2 /*return*/];
            });
        }); };
        // fill input web elements
        this.writeById = function (id, txt) { return __awaiter(_this, void 0, void 0, function () {
            var el, e_1, el2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 5, , 9]);
                        return [4 /*yield*/, delay_1["default"](1000)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, this.findById(id)];
                    case 2:
                        el = _a.sent();
                        return [4 /*yield*/, el.sendKeys(txt)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, el.sendKeys(selenium_webdriver_1.Key.TAB)];
                    case 4:
                        _a.sent();
                        return [3 /*break*/, 9];
                    case 5:
                        e_1 = _a.sent();
                        console.log('Error ', e_1.message);
                        console.log('Attempt writeById after a second');
                        delay_1["default"](1000);
                        return [4 /*yield*/, this.findById(id)];
                    case 6:
                        el2 = _a.sent();
                        return [4 /*yield*/, el2.sendKeys(txt)];
                    case 7:
                        _a.sent();
                        return [4 /*yield*/, el2.sendKeys(selenium_webdriver_1.Key.TAB)];
                    case 8:
                        _a.sent();
                        return [3 /*break*/, 9];
                    case 9: return [2 /*return*/];
                }
            });
        }); };
        this.writeByXpath = function (xpath, txt) { return __awaiter(_this, void 0, void 0, function () {
            var el, e_2, el;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 4, , 8]);
                        return [4 /*yield*/, this.findByXpath(xpath)];
                    case 1:
                        el = _a.sent();
                        return [4 /*yield*/, el.sendKeys(txt)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, el.sendKeys(selenium_webdriver_1.Key.TAB)];
                    case 3:
                        _a.sent();
                        return [3 /*break*/, 8];
                    case 4:
                        e_2 = _a.sent();
                        console.log('Error ', e_2.message);
                        console.log('Attempt writeByXPath after a second');
                        delay_1["default"](1000);
                        return [4 /*yield*/, this.findByXpath(xpath)];
                    case 5:
                        el = _a.sent();
                        return [4 /*yield*/, el.sendKeys(txt)];
                    case 6:
                        _a.sent();
                        return [4 /*yield*/, el.sendKeys(selenium_webdriver_1.Key.TAB)];
                    case 7:
                        _a.sent();
                        return [3 /*break*/, 8];
                    case 8: return [2 /*return*/];
                }
            });
        }); };
        this.writeByName = function (name, txt) { return __awaiter(_this, void 0, void 0, function () {
            var el;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.findByName(name)];
                    case 1:
                        el = _a.sent();
                        return [4 /*yield*/, el.sendKeys(txt)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, el.sendKeys(selenium_webdriver_1.Key.TAB)];
                    case 3:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        this.clickById = function (id) { return __awaiter(_this, void 0, void 0, function () {
            var el;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.findById(id)];
                    case 1:
                        el = _a.sent();
                        return [4 /*yield*/, el.click()];
                    case 2: return [2 /*return*/, _a.sent()];
                }
            });
        }); };
        this.clickByXpath = function (xpath) { return __awaiter(_this, void 0, void 0, function () {
            var el, e_3, el2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.findByXpath(xpath)];
                    case 1:
                        el = _a.sent();
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 7]);
                        return [4 /*yield*/, el.click()];
                    case 3: return [2 /*return*/, _a.sent()];
                    case 4:
                        e_3 = _a.sent();
                        console.log('Error ', e_3.message);
                        console.log('Attempt clickByXpath after a second');
                        delay_1["default"](1000);
                        return [4 /*yield*/, this.findByXpath(xpath)];
                    case 5:
                        el2 = _a.sent();
                        return [4 /*yield*/, el2.click()];
                    case 6: return [2 /*return*/, _a.sent()];
                    case 7: return [2 /*return*/];
                }
            });
        }); };
        this.takeScreenshot = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this.driver.takeScreenshot().then(function (image, err) {
                    require('fs').writeFile('out.png', image, 'base64', function (err) {
                    });
                });
                return [2 /*return*/];
            });
        }); };
        this.html = function () { return __awaiter(_this, void 0, void 0, function () {
            var source;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.driver.executeScript("return document.getElementsByTagName('html')[0].innerHTML")];
                    case 1:
                        source = _a.sent();
                        return [4 /*yield*/, require("fs").writeFileSync('source.html', source)];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); };
        var o = new chrome_1["default"].Options();
        // o.addArguments('start-fullscreen');
        o.addArguments('disable-infobars');
        // o.addArguments('headless'); // running test on visual chrome browser
        o.setUserPreferences({ credential_enable_service: false });
        this.driver = new selenium_webdriver_1.Builder()
            .setChromeOptions(o)
            .forBrowser('chrome')
            .build();
        this.driver.manage().setTimeouts({ implicit: 3000 });
    }
    return Browser;
}());
exports["default"] = Browser;
;
