import StackUtils = require("stack-utils");
import { NIFTY, FINNIFTY, BANKNIFTY } from "./constants";
import Prism from "./prism";
let config = require("./prism/config").default;


export class Index {
    niftyToken = '26000'
    finNiftyToken = '26037'
    bankNiftyToken = '26009'
    index: string
    factor;
    maxQuantity: number

    token: string
    lotSize: number
    increment: number
    expiryWeekDiff = 1

    constructor(token, lotSize, increment) {
        this.token = token;
        switch(token) {
            case this.niftyToken: 
                this.index = NIFTY; 
                this.factor = 50; 
                this.maxQuantity = 1800;
                break;
            case this.finNiftyToken: 
                this.index = FINNIFTY;
                this.factor = 100; 
                this.maxQuantity = 900; 
                break;
            case this.bankNiftyToken: 
                this.index = BANKNIFTY; 
                this.factor = 100;
                this.maxQuantity = 900;
                break;
        }
        this.lotSize = lotSize;
        this.increment = increment;
    }

    _nextTuesday = (date: Date) => {
        if (date.getDay() == 2) {
            return date;
        }
        return new Date(
            date.setDate(
                date.getDate() + ((7 - date.getDay() + 2) % 7 || 7),
            ),
        );
    }

    _nextWednesday = (date: Date) => {
        if (date.getDay() == 3) {
            return date;
        }

        return new Date(
            date.setDate(
                date.getDate() + ((7 - date.getDay() + 3) % 7 || 7),
            ),
        );
    }

    _nextMonday = (date: Date) => {
        if (date.getDay() == 4) {
            return date;
        }

        return new Date(
            date.setDate(
                date.getDate() + ((7 - date.getDay() + 4) % 7 || 7),
            ),
        );
    }


    _toShortFormat = function (date: Date) {

        let monthNames = ["Jan", "Feb", "Mar", "Apr",
            "May", "Jun", "Jul", "Aug",
            "Sep", "Oct", "Nov", "Dec"];

        let day = date.getDate();
        let monthIndex = date.getMonth();
        let monthName = monthNames[monthIndex];
        let year = date.getFullYear();
        return `${day}-${monthName}-${year}`;
    }

    getQuantity(pricePerquantity: number) {
        const lotCount = config.lotCount
        const investmentAmount = config.investmentAmount
        if (lotCount != -1) {
            return lotCount * this.lotSize;
        }
        let amountPerLot = pricePerquantity * this.lotSize;
        let calculatedLotCount = Math.floor(investmentAmount / amountPerLot)
        return calculatedLotCount * this.lotSize;
    }

    findExpiryDate = () => {
        var now = new Date();
        var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        for (var i = 0; i <= this.expiryWeekDiff; i++) {
            if (this.token === this.finNiftyToken) {
                date = this._nextTuesday(date);
            } else if(this.token === this.bankNiftyToken){
                date = this._nextWednesday(date);
            } else {
                date = this._nextMonday(date);
            }
        }
        return this._toShortFormat(date);
    }

    findTokenFor = async (index:string, right: string, strikePrice: number) => {
        let token = '';
        const prism = Prism.getInstance()
        
        const expiryDate = this._findPrismExpiryDate();

        const callput = "call" === right ? 'C' : 'P'
        if (this.token === this.niftyToken) {
            token = `NIFTY${expiryDate}${callput}${strikePrice}`;
        }
        if (this.token === this.finNiftyToken) {
            token = `FINNIFTY${expiryDate}${callput}${strikePrice}`;
        }
        if (this.token === this.bankNiftyToken) {
            token = `BANKNIFTY${expiryDate}${callput}${strikePrice}`;
        }
        token = await prism.search(token, index, expiryDate, strikePrice, right);
        return token;

    }

    findToken = async (index:string, depth: number, right: string, ltp?: number) => {
        let token = '';
        const prism = Prism.getInstance()
        
        const expiryDate = this._findPrismExpiryDate();
        if (!ltp) {
            const niftyQuote = await prism.getQuote(index as string);
            ltp = niftyQuote.ltp
        }
        
        const strikePrice = this.findStrikePrice(ltp, depth, right);

        const callput = "call" === right ? 'C' : 'P'
        if (this.token === this.niftyToken) {
            token = `NIFTY${expiryDate}${callput}${strikePrice}`;
        }
        if (this.token === this.finNiftyToken) {
            token = `FINNIFTY${expiryDate}${callput}${strikePrice}`;
        }
        if (this.token === this.bankNiftyToken) {
            token = `BANKNIFTY${expiryDate}${callput}${strikePrice}`;
        }
        token = await prism.search(token, index, expiryDate, strikePrice, right);
        return token;
    }


    _findPrismExpiryDate = () => {
        var now = new Date();

        var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        // console.log("Tuesday date: " + this._nextTuesday(date));

        // var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        // console.log("Webnesday date: " + this._nextWednesday(date));

        // var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        // console.log("Thursday date: " + this._nextThursday(date));


        for (var i = 0; i <= this.expiryWeekDiff; i++) {
            if (this.token === this.finNiftyToken) {
                date = this._nextTuesday(date);
            } else if(this.token === this.bankNiftyToken){
                console.log("Going here")
                date = this._nextWednesday(date);
            } else {
                date = this._nextMonday(date);
            }
        }
        let monthNames = ["JAN", "FEB", "MAR", "APR",
            "MAY", "JUN", "JUL", "AUG",
            "SEP", "OCT", "NOV", "DEC"];

        let day = date.getDate();
        let prefix = day < 10 ? 0 : '';
        let monthIndex = date.getMonth();
        let monthName = monthNames[monthIndex];
        let year = date.getFullYear().toString().substr(2);
        return `${prefix}${day}${monthName}${year}`;
    }

    findStrikePrice = (indexPrice, depth: number, right) => {
        if (typeof indexPrice === "string") {
            indexPrice = indexPrice.replace(/\,/g, '');
        }

        const strikePriceDiff = (depth * this.increment);
        if (right == 'call') {
            var quotient = Math.ceil(indexPrice / this.increment);
            return (quotient * this.increment) + strikePriceDiff
        }
        var quotient = Math.floor(indexPrice / this.increment);
        return (quotient * this.increment) - strikePriceDiff;
    }

    getNumberAsString(number) {
        return number.toLocaleString('en-IN', {
            maximumFractionDigits: 2,
            minimumFractionDigits: 2
        })

    }
}


export default new Map<string, Index>([
    [NIFTY, new Index("26000", 75, 50)],
    [FINNIFTY, new Index("26037", 25, 50)],
    [BANKNIFTY, new Index("26009", 15, 100)] 
]);
