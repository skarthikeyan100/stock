export class OptionQuote  {
    ltp: number
    ltt
    open
    high
    low
    prevClose

    constructor(response) {
        this.ltp = response.ltp
        this.ltt = response.ltt,
        this.open = response.open,
        this.high =response.high,
        this.low = response.low,
        this.prevClose = response.prevClose,
        this.ltp = 225
    }
}
