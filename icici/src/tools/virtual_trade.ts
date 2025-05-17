import moment = require("moment")

export class Trade {
    constructor(strategy, action, symbol, strikePrice, price) {
        this.strategy = strategy
        this.symbol = symbol
        this.strikePrice = strikePrice
        this.action = action
        this.price = price
    }
    strategy
    symbol
    strikePrice
    action
    price: number
    date
    time
}


export class VirtualTrade {
    close(price: any) {
        this.openTrade.forEach((value, key) => {
            if (value) {

                let openTrade = this.isOpen(key)
                if (openTrade != null && openTrade != undefined) {
                    // console.log('In Open Trade Action ', openTrade.action, 'Traded price ', openTrade.price)

                    //Square off
                    if (openTrade.action == 'Buy') {
                        console.log('Closing buy at ', price)
                        this.addTrade(key, 'Sell', openTrade.symbol, openTrade.strikePrice, price)
                    }

                    if (openTrade.action == 'Sell') {
                        console.log('Closing buy at ', price)
                        this.addTrade(key, 'Buy', openTrade.symbol, openTrade.strikePrice, price)
                    }
                }
            }
        })
    }

    trades: Trade[] = []
    openTrade: Map<String, Boolean> = new Map()
    lastTrade: Map<String, Trade> = new Map()
    addTrade = (strategy, action, symbol, strikePrice, price) => {
        const trade = new Trade(strategy, action, symbol, strikePrice, price)
        const quickAddTrade = () => {

            const now = new Date();
            trade.date = moment(now).format('DD-MMM-YYYY')
            trade.time = moment(now).format('HH:mm')
            this.trades.push(trade)
        }
        if (action == 'Buy') {
            if (this.openTrade.get(strategy) == undefined || this.openTrade.get(strategy) == false) {
                this.openTrade.set(strategy, true)
                quickAddTrade()
                this.lastTrade.set(strategy, trade)
                return true
            }
        } else {
            if (this.openTrade.get(strategy) == true) {
                quickAddTrade()
                this.lastTrade.set(strategy, undefined)
                this.openTrade.set(strategy, false)
                return true
            }
        }
        return false
    }

    isOpen = (strategy): Trade => {
        return this.lastTrade.get(strategy)
    }

    pl = () => {

        let pl: Map<String, { count: number, value: number, avg: number }> = new Map();
        this.trades.forEach(trade => {
            const key = trade.symbol + '-' + trade.strategy
            let v = pl.get(key)
            if (v == null) {
                v = { count: 0, value: 0, avg: 0 }
            }
            if (trade.action == 'Buy') {
                v.value = v.value - trade.price
            } else {
                v.value = v.value + trade.price
            }
            v.count++
            pl.set(key, v)
        })

        var newArr = pl.forEach((value, key) => {
            const amount = Math.floor(value.value)
            const count = value.count
            const average = Math.floor(amount / count)
            pl.set(key, { count: count, value: amount, avg: average })
        })
        return pl
    }
}


