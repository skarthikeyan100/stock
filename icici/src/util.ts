import Log from './util/Log';
import StackUtils = require("stack-utils");

class Util {
    expiryWeekDiff = 2
    lotSize = 50

    _nextThursday = (date: Date) => {
        return new Date(
            date.setDate(
                date.getDate() + ((7 - date.getDay() + 4) % 7 || 7),
            ),
        );
    }

    _nextTuesday = (date: Date) => {
        return new Date(
            date.setDate(
                date.getDate() + ((7 - date.getDay() + 2) % 7 || 7),
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

    findExpiryDate = () => {
        var now = new Date();
        var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());


        for (var i = 0; i < this.expiryWeekDiff; i++) {
            date = this._nextThursday(date);
        }
        return this._toShortFormat(date);
    }

    findNiftyToken = (niftyPrice, depth: number, right) => {
        const expiryDate = this._findPrismExpiryDate();
        const strikePrice = this.findStrikePrice(niftyPrice, depth, right);

        const callput = "call" === right ? 'C' : 'P'
        const token = `NIFTY${expiryDate}${callput}${strikePrice}`
        return token;
    }

    findBankNiftyToken = (niftyPrice, depth: number, right) => {
        const expiryDate = this._findPrismExpiryDate();
        const strikePrice = this.findStrikePrice(niftyPrice, depth, right);

        const callput = "call" === right ? 'C' : 'P'
        const token = `BANKNIFTY${expiryDate}${callput}${strikePrice}`
        return token;
    }

    findFinNiftyToken = (niftyPrice, depth: number, right) => {
        const expiryDate = this._findPrismFinniftyExpiryDate();
        const strikePrice = this.findStrikePrice(niftyPrice, depth, right);

        const callput = "call" === right ? 'C' : 'P'
        const token = `FINNIFTY${expiryDate}${callput}${strikePrice}`
        return token;
    }


    _findPrismExpiryDate = () => {
        var now = new Date();
        var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());


        for (var i = 0; i < this.expiryWeekDiff; i++) {
            date = this._nextThursday(date);
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

    _findPrismFinniftyExpiryDate = () => {
        var now = new Date();
        var date = new Date(now.getFullYear(), now.getMonth(), now.getDate());


        for (var i = 0; i < this.expiryWeekDiff; i++) {
            date = this._nextTuesday(date);
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


    findStrikePrice = (niftyPrice, depth: number, right) => {
        Log.log(niftyPrice)
        if (typeof niftyPrice === "string") {
            niftyPrice = niftyPrice.replace(/\,/g, '');
        }

        const strikePriceDiff = (depth * 50);
        if (right == 'call') {
            var quotient = Math.ceil(niftyPrice / this.lotSize);
            return (quotient * this.lotSize) + strikePriceDiff
        }
        var quotient = Math.floor(niftyPrice / this.lotSize);
        return (quotient * this.lotSize) - strikePriceDiff;
    }

    getNumberAsString(number) {
        return number.toLocaleString('en-IN', {
            maximumFractionDigits: 2,
            minimumFractionDigits: 2
        })

    }

}

export default new Util();

