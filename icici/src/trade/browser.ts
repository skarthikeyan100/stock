import { Builder, By, until, Key, WebElement, ThenableWebDriver, Actions } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome';
import delay from 'delay';

export default class Browser {
    driver: ThenableWebDriver

    timeout: 5000
    constructor(headless?) {
        let o = new chrome.Options();
        // o.addArguments('start-fullscreen');
        o.addArguments('disable-infobars');
        if (headless) {
            o.addArguments('headless'); // running test on visual chrome browser
        }
        o.setUserPreferences({ credential_enable_service: false });

        this.driver = new Builder()
            .setChromeOptions(o)
            .forBrowser('chrome')
            .build();

        this.driver.manage().setTimeouts({ implicit: 3000 })
    }

    getOtp = async () => {
        await delay(5000);
        await this.openTab('https://mail.google.com/a/nivedhatech.com');
        await this.switchTab();

        console.log('Opened gmail');
        
        await this.driver.findElement(By.id("identifierId")).sendKeys("karthikeyan");
        await this.driver.findElement(By.css("#identifierNext > div > button > span")).click();
        await delay(2000);
        await this.driver.findElement(By.css("#password > div.aCsJod.oJeWuf > div > div.Xb9hP > input")).sendKeys("Nandhitha1000");
        await delay(1000);
        await this.driver.findElement(By.css("#passwordNext > div > button > span")).click();
        console.log("Wait for 15 seconds")
        await delay(15000);
        console.log("Wait is over")
        const elements: WebElement[] = await this.driver.findElements(By.className("zE"));
        // const elements : any[] = await this.driver.findElements(By.xpath('//*[@id=":22"]/tbody'));

        console.log("Total No. of Unread Mails: " + elements.length);

        const tdElements: WebElement[] = await elements[0].findElements(By.tagName('td'));
        for (var j = 0; j < tdElements.length; j++) {
            var text: String = await elements[j].getText();
            if ((text.indexOf('service') != -1) && (text.indexOf('OTP') != -1)) {
                const index = text.indexOf(' - OTP');
                const otp = text.substr(index-6, 6);
                await this.closeTab();
                return otp;
            }
        }
    }

    getPrismOtp = async () => {
        await delay(5000);
        await this.openTab('https://mail.google.com/a/nivedhatech.com');
        await this.switchTab();

        console.log('Opened gmail for Prism');
        
        await this.driver.findElement(By.id("identifierId")).sendKeys("karthikeyan");
        await this.driver.findElement(By.css("#identifierNext > div > button > span")).click();
        await delay(2000);
        await this.driver.findElement(By.css("#password > div.aCsJod.oJeWuf > div > div.Xb9hP > input")).sendKeys("Nandhitha1000");
        await delay(1000);
        await this.driver.findElement(By.css("#passwordNext > div > button > span")).click();
        console.log("Wait for 15 seconds")
        await delay(15000);
        console.log("Wait is over")
        // const elements: WebElement[] = await this.driver.findElements(By.className("zE"));
        // const elements : any[] = await this.driver.findElements(By.xpath('//*[@id=":22"]/tbody'));

        const elements: WebElement[] = await this.driver.findElements(By.css("tbody > tr.zA"));

        console.log("Total No. of Unread Mails: " + elements.length);

        // const tdElements: WebElement[] = await elements[0].findElements(By.tagName('td'));
        for (var j = 0; j < elements.length; j++) {
            var text: String = await elements[j].getAttribute('innerText');
            console.log('Text: ', text)

            var text: String = await elements[j].getText();
            console.log('Text1: ', text)

            // if ((text.indexOf('service') != -1) && (text.indexOf('OTP') != -1)) {
            //     const index = text.indexOf(' - OTP');
            //     const otp = text.substr(index-6, 6);
            //     await this.closeTab();
            //     return otp;
            // }
            return 'Work In Progress';
        }
    }


    // visit a webpage
    visit = async function (theUrl) {
        return await this.driver.get(theUrl);
    };

    // quit current session
    quit = async function () {
        return await this.driver.quit();
    };

    // wait and find a specific element with it's id
    findById = async function (id) {
        await this.driver.wait(until.elementLocated(By.id(id)), 25000, 'Looking for element');
        return await this.driver.findElement(By.id(id));
    };

    // wait and find a specific element with it's name
    findByName = async function (name) {
        await this.driver.wait(until.elementLocated(By.name(name)), 25000, 'Looking for element');
        return await this.driver.findElement(By.name(name));
    }

    // wait and find a specific element with it's name
    findByXpath = async function (xpath) {
        await this.driver.wait(until.elementLocated(By.xpath(xpath)), 25000, `Looking for element ${xpath}`);
        return await this.driver.findElement(By.xpath(xpath));
    }

    // wait and find a specific element with it's name
    findElements = async function (xpath) {
        return await this.driver.findElements(By.xpath(xpath));
    }

    // wait and find a specific element with it's name
    //TODO change function name
    isElementPresent = async function (id) {
        const elements = await this.driver.findElements(By.id(id));
        return elements.length > 0

    }

    getElementsBySelector = async function (selector) {
        return await this.driver.findElements(By.css(selector));
    }

    getElementsByTag = async function (tag) {
        return await this.driver.findElements(By.tagName(tag));
    }

    clickBySelector = async function (selector) {
        const element = await this.driver.findElement(By.css(selector));
        await element.click()
    }

    selectOpton = async function (id, index) {
        await this.driver.findElement(By.css(`#${id} > option:nth-child(${index})`))
            .click();
    }

    closeTab = async () => {
        const tabs = await this.driver.getAllWindowHandles();
        if (tabs.length > 1) {
            await this.driver.switchTo().window(tabs[1]);
            await this.driver.close();
            await this.driver.switchTo().window(tabs[0]);
        }
    }

    switchTab = async () => {
        const tabs = await this.driver.getAllWindowHandles();
        if (tabs.length > 1) {
            await this.driver.switchTo().window(tabs[1]);
        }
    }

    // fill input web elements
    writeById = async (id, txt) => {
        try {
            await delay(1000)
            const el = await this.findById(id)
            await el.sendKeys(txt);
            await el.sendKeys(Key.TAB)
        } catch (e) {
            console.log('Error ', e.message)
            console.log('Attempt writeById after a second')
            delay(1000)

            const el2 = await this.findById(id)
            await el2.sendKeys(txt);
            await el2.sendKeys(Key.TAB)
        }
    }

    writeByXpath = async (xpath, txt) => {
        try {
            const el = await this.findByXpath(xpath)
            await el.sendKeys(txt);
            await el.sendKeys(Key.TAB)
        } catch (e) {
            console.log('Error ', e.message)
            console.log('Attempt writeByXPath after a second')
            delay(1000)

            const el = await this.findByXpath(xpath)
            await el.sendKeys(txt)
            await el.sendKeys(Key.TAB)
        }
    }

    wait = async (tbody, rowCount) => {
        let rows: any;
        await this.driver.wait(async () => {

            do {
                rows = await tbody.findElements(By.tagName("tr"))
            } while (rows.length < rowCount)
            return true
        })
        return rows
    }

    writeByName = async (name, txt) => {
        const el = await this.findByName(name)
        await el.sendKeys(txt);
        await el.sendKeys(Key.TAB)
    }

    clearAndWrite = async (name, txt) => {
        const el = await this.findByName(name)
        await this.driver.executeScript(element => element.select(), el);
        await el.sendKeys(Key.BACK_SPACE);
        await el.sendKeys(txt);
        await el.sendKeys(Key.ENTER) //TODO why Enter is added here ?
    }

    esc = async () => {
        this.driver.actions().sendKeys(Key.ESCAPE).perform()
    }

    clearAndWriteById = async (id, txt) => {
        const el = await this.findById(id)
        await this.driver.executeScript(element => element.select(), el);
        await el.sendKeys(Key.BACK_SPACE);
        await el.sendKeys(txt);
    }

    isChecked = async (id) => {
        const el: WebElement = await this.driver.findElement(By.id(id));
        let innerHTML = await el.getAttribute('innerHTML')

        console.log('is Displayed ', await el.isDisplayed(), ' Enabled ', await el.isEnabled()), 'Content ', innerHTML.trim()
        return await el.isSelected()
    }


    clickById = async (id) => {
        const el = await this.findById(id)
        return await el.click()
    }

    clickByXpath = async (xpath) => {
        const el = await this.findByXpath(xpath)
        try {
            await this.driver.wait(async function () {
                return await el.isEnabled()
            }, this.timeout);
            return await el.click()

        } catch (e) {
            console.log('Error ', e.message)
            console.log('Attempt clickByXpath after a second')
            delay(1000)
            const el2 = await this.findByXpath(xpath)
            return await el2.click()
        }

    }

    takeScreenshot = async () => {
        const image = await this.driver.takeScreenshot();
        require('fs').writeFile('out.png', image, 'base64', function (err) {
        });
    }
    html = async () => {
        const source = await this.driver.executeScript("return document.getElementsByTagName('html')[0].innerHTML")
        await require("fs").writeFileSync('source.html', source);
    }

    openTab = async (url) => {
        const link = `window.open("${url}","_blank");`;
        await this.driver.executeScript(link);
    }

}

