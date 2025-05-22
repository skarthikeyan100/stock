import { EventEmitter } from 'events';

export class NiftyQuote {
    token
    ltp
    ltt
    open
    high
    low
    close
    prevClose
    volume

    constructor(response?) {
        if (response != null && response != undefined) {
            this.token = response.token;
            this.ltp = response.ltp
            this.ltt = response.ltt
            this.open = response.open
            this.high = response.high
            this.low = response.low
            this.close = response.close
            this.prevClose = response.previous_close

        }
    }

    static fromPrism(response): NiftyQuote {
        const quote = new NiftyQuote();
        quote.ltp = response.lp
        quote.ltt = response.lut
        quote.open = response.o
        quote.high = response.h
        quote.low = response.l
        quote.prevClose = response.c
        quote.volume = response.v
        quote.token = response.symname
        return quote;
    }
}

export class Trade {
    tsym: string;
    token: string;
    stockCode: any;
    expiryDate: any;
    strikePrice: any;
    right: any;
    action: any;
    quantity: number;
    flqty: number;
    price: number;
    ltp: any;
    strategy: string;
    isPendingOrder: boolean;
    isBuyPending: boolean;
    isSellPending: boolean;
    lastTradePrice: number
    status: string
    targetPrice: number
    stopLossPrice: number
    


    static getTradeFromResponse(response) {
        const trade = new Trade();
        trade.stockCode = response.stock_code
        trade.action = response.action,
            trade.quantity = response.quantity
        trade.price = response.average_cost
        trade.expiryDate = response.expiry_date,
            trade.right = response.right,
            trade.strikePrice = response.strike_price,
            trade.ltp = response.ltp
            console.log("Trade:(fromResponse) ", trade)
        return trade;
    }

    static fromPrism(response) {
        const dname: string = response.dname;
        const names = dname.split(' ');

        const netqty = response.netqty
        const price = response.lp

        const stockcode = names[0];
        const expiryDate = names[1];
        const strikePrice = names[2];
        const right = names[3] == 'PE' ? 'put' : 'call';
        const token = response.token;
        const quantity = netqty
        const tsym = response.tsym;

        const trade = new Trade();
        trade.tsym = tsym;
        trade.token = token;
        trade.stockCode = stockcode
        trade.action = 'Buy',
            trade.price = price, //TODO add brokerage cost?
            trade.quantity = parseInt(quantity);
        trade.expiryDate = expiryDate,
            trade.right = right,
            trade.strikePrice = strikePrice,
            trade.ltp = response.lp

        return trade;
    }

    getProfit = () => {
        return (this.ltp - this.price) * this.quantity;
    }
}

export enum OrderStatus {
    ORDERED = 'ORDERED',
    BOUGHT = 'BOUGHT',
}

export class OrderInfo {
    contract: string;
    qty: number;
    price: number
    status?: OrderStatus
    profit?: number
    
}

export class Order {
    orderno: string;
    tsym: string;
    trantype: string;
    quantity: number;
    price: number;
    token: string;

    static fromPrism(response) {
        console.log('Constructing order from prism: ', response);
        const orderno = response.norenordno
        const tsym = response.tsym
        const trantype = response.trantype;
        const quantity = response.qty;
        const price = response.prc;

        const order = new Order();
        order.tsym = tsym;
        order.trantype = trantype;
        order.orderno = orderno
        order.quantity = quantity
        order.price = price
        
        return order;
    }
}

export class OptionQuote {
    ltp: number
    ltt
    token


    // static fromBreeze(response) : OptionQuote {
    //     const quote = new OptionQuote();

    //     quote.ltp = response.ltp
    //     quote.ltt = response.ltt
    //     quote.open = response.open
    //     quote.high = response.high
    //     quote.low = response.low
    //     quote.prevClose = response.prevClose
    //     return quote;

    // }

    static fromPrism(response): OptionQuote {
        const quote = new OptionQuote();
        if (response.lp) {
            quote.ltp =  parseFloat(response.lp)
        } else {
            quote.ltp =  parseFloat(response.bpl)
        }
        
        quote.ltt = response.ft
        quote.token = response.tk
        return quote;
    }

}

export class Message {
    tsym
    traded
    ltp
    buyAt
    sellAt
    stopAt
}

export class RealTimeTrend {
    constructor(ltt, ltp, trend, macd, rsi, bollinger) {
        this.ltt = ltt;
        this.ltp = ltp;
        this.trend = trend;
        this.macd = macd;
        this.rsi = rsi;
        this.bollinger = bollinger;
    }
    ltt
    ltp
    trend
    macd
    rsi
    bollinger
}
export class PeriodicStats {

    _round = (num) => Math.round(num * 100) / 100;

    constructor(open, high, low, close, average, median, stdDeviation, trend, 
        results) {

        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.average = average;
        this.median = median;
        this.stdDeviation = stdDeviation;
        this.rateOfChange = this._round( (this.close - this.open)/ this.open * 100)
        this.trend = trend;
        this.results = results;
        this.time = Date.now();
        this.diff = this._round(this.close - this.open);
        this.range = this._round(this.high - this.low);
        if (this.range == 0) {
            this.diffFromHigh = 0;
        } else {
            this.diffFromHigh = ((this.high - this.close) / this.range) * 100;
            this.diffFromHigh = this._round(this.diffFromHigh);
        }
    }
    open
    high
    low
    close
    average
    median
    stdDeviation
    rateOfChange
    diff
    range
    diffFromHigh
    trend
    results: Result
    time
}


export class Filtered {
    open
    high
    low
    close
    average
    median
    stdDeviation
    rateOfChange
    diff
    range
    diffFromHigh
    trend
    time
    results: Result
}

export class Result {
    eventName: string
    macd: MACD[] = []
    rsi: RSI[]
    bollinger: Bollinger[]
    ema: EMACrossOver[]
    pivot: Pivot
} 

export class MACD {
    shortPeriod
    longPeriod
    signalPeriod
    latestShortEMA
    latestLongEMA
    latestMACD
    latestSignal
    trend
}

export class RSI {
    period
    overbought
    oversold
    latestRSI
    trend
}

export class Bollinger {
    period: number = 0;
    numDeviations: number = 0;
    stdDev: number = 0;
    upperBand: number = 0;
    middleBand: number = 0;
    lowerBand: number = 0;
    trend: string = '';

    getFeature(): string {
        const r = `${this.period}_${this.numDeviations}_${this.trend}`
        console.log(this.period, ',', this.numDeviations, ',', r)
        return r;
    };
}

export class EMACrossOver {
    shortPeriod
    longPeriod
    trend
}

export class Pivot {
    S1
    R1
    S2
    R2
}
