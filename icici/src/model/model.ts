import Log from '../util/Log';
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
    buyQty
    sellQty
    changePercent

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
        quote.ltp = parseFloat(response.lp)
        quote.ltt = response.lut
        quote.open = parseFloat(response.o)
        quote.high = parseFloat(response.h)
        quote.low = parseFloat(response.l)
        quote.prevClose = parseFloat(response.c)
        quote.volume = parseInt(response.v)
        quote.token = response.tsym
        quote.buyQty = parseInt(response.bq1) + parseInt(response.bq2) + parseInt(response.bq3) + parseInt(response.bq4) + parseInt(response.bq5)
        quote.sellQty = parseInt(response.sq1) + parseInt(response.sq2) + parseInt(response.sq3) + parseInt(response.sq4) + parseInt(response.sq5)
        quote.changePercent = quote.prevClose ? (quote.ltp - quote.prevClose) / quote.prevClose * 100 : 0;
        return quote;
    }

    // ANT's touchline ticks are often partial updates (no OHLC/volume/depth,
    // just lp/pc/ft/tk) - only map what's actually present, no fabricated values.
    static fromAnt(response): NiftyQuote {
        const quote = new NiftyQuote();
        quote.ltp = parseFloat(response.lp)
        quote.ltt = response.ft
        quote.token = response.tk
        quote.changePercent = response.pc !== undefined ? parseFloat(response.pc) : undefined
        // ANT sends the previous close as a percent change (pc), not an
        // absolute price - derive it algebraically rather than leaving
        // prevClose unset, since GapStrategy needs an absolute point gap.
        quote.prevClose = quote.changePercent !== undefined ? quote.ltp / (1 + quote.changePercent / 100) : undefined
        return quote;
    }
}

// SENSEX touchline ticks from ANT - Prism never carries SENSEX, so this only
// needs the fromAnt() partial-update shape (see NiftyQuote.fromAnt).
export class SensexQuote {
    token
    ltp
    ltt
    changePercent

    static fromAnt(response): SensexQuote {
        const quote = new SensexQuote();
        quote.ltp = parseFloat(response.lp)
        quote.ltt = response.ft
        quote.token = response.tk
        quote.changePercent = response.pc !== undefined ? parseFloat(response.pc) : undefined
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
    targetPoints: number       // raw target gap (for trailing recalc)
    trailingDistance: number   // gap kept between HWM and SL during trailing
    highWaterMark: number      // highest LTP seen since trailing started
    trailingActive: boolean    // false until first target is hit
    user: string = 'Default'
    open: boolean = true
    realizedPnL: number
    gttTriggerId: number // Zerodha GTT trigger id, if a bracket was placed at entry (setTargetStopLoss modifies it later)
    antOrderNo?: string // AliceBlue BO order number, if a bracket was placed at entry
    entryTime?: Date // set once, at the first fill that opens the position
    exitTime?: Date // set when the position is closed


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
            Log.log("Trade:(fromResponse) ", trade)
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
    PENDING = 'PENDING',
    BOUGHT = 'BOUGHT',
}

export class OrderInfo {
    token: string;
    contract: string;
    qty: number;
    price: number
    lastOrderedPrice: number
    status: OrderStatus
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
        Log.log('Constructing order from prism: ', response);
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

    static fromAnt(response): OptionQuote {
        const quote = new OptionQuote();
        quote.ltp = parseFloat(response.lp)
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

const round = (num) => Math.round(num * 100) / 100;

export class PeriodicStats {


    constructor(open, high, low, close, average, median, stdDeviation, mad, trend, 
        results) {

        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.average = average;
        this.median = median;
        this.stdDeviation = stdDeviation;
        this.mad = round(mad);
        this.rateOfChange = round( (this.close - this.open)/ this.open * 100)
        this.trend = trend;
        this.results = results;
        this.time = Date.now();
        this.diff = round(close - open);
        this.range = round(high - low);
        if (this.range == 0) {
            this.diffFromHigh = 0;
        } else {
            this.diffFromHigh = ((this.high - this.close) / this.range) * 100;
            this.diffFromHigh = round(this.diffFromHigh);
        }
    }
    open
    high
    low
    close
    average
    median
    stdDeviation
    mad
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
    adx: any[] = []
    stochastic: any[] = []
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
        Log.log(this.period, ',', this.numDeviations, ',', r)
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
