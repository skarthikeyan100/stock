import Prism from './prism';
import { NiftyQuote, OptionQuote, Trade, Order } from './model/model';
import moment from 'moment'
import * as fs from 'fs';

export class ExecuteGap {
    nifty = 'NIFTY'
    processed = false;

    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(9).minute(10);
        const endTime = moment().hour(9).minute(16);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    process = async(niftyQuote: NiftyQuote) => {
        if (!this.processed && this.isTimeInRange() && niftyQuote.token === 'NIFTY') {
            const prevNiftyQuote = await this._getPreviousDayQuote();
            const prism = Prism.getInstance()
            if (niftyQuote.ltp > prevNiftyQuote.high) {
                const gapUpSize = niftyQuote.ltp - prevNiftyQuote.high;
                console.log("Gap up " + gapUpSize + " ltp: " + niftyQuote.ltp + " prev high:  " + prevNiftyQuote.high);
                if (gapUpSize > 100) {
                    // prism.buyIndex(this.nifty, 'call');
                } else {
                    // prism.buyIndex(this.nifty, 'put');
                }
            } else if (niftyQuote.ltp < prevNiftyQuote.low) {
                const gapDownSize =  prevNiftyQuote.high - niftyQuote.ltp
                console.log("Gap down " + gapDownSize + " ltp: " + niftyQuote.ltp + " prev low:  " + prevNiftyQuote.low);
                if (gapDownSize > 100) {
                    // prism.buyIndex(this.nifty, 'put');
                } else {
                    // prism.buyIndex(this.nifty, 'call');
                }

            } else {
                console.log(" No Gapup or Gapdown" + " LTP: " + niftyQuote.ltp + " Previous day high " + prevNiftyQuote.high + " Previous day low " + prevNiftyQuote.low);
            }
            this.processed = true;
        }
    }

    _getPreviousDayQuote = async() => {
        const rawData = fs.readFileSync('previousNiftyQuote.json', 'utf-8');
        const jsonData : NiftyQuote = JSON.parse(rawData);
        console.log('Previous day Nifty Quote is '+ JSON.stringify(jsonData));
        return jsonData
    }
    
    setPreviousDayQuote = async() => {
        const prism = Prism.getInstance()
        const niftyQuote = await prism.getNiftyQuote();
        const jsonString = JSON.stringify(niftyQuote, null, 2);
        fs.writeFileSync('previousNiftyQuote.json', jsonString, 'utf-8');
        console.log('Written to the file '+ jsonString);
    }

}

const executeGap = new ExecuteGap();
export default executeGap;
