import Icici, { Decision, OptionType } from '../icici'
import { balanceTrade } from 'functions';

class Position {
    trend: 'Up' | 'Down' | 'None'
    hammer: 'Hit' | 'Not Hit' | 'Confirmed'
    inverseHammer: 'Hit' | 'Not Hit' | 'Confirmed'
    bullishEngulfing: 'Hit' | 'Not Hit' | 'Confirmed'
    piercingLine: 'Hit' | 'Not Hit' | 'Confirmed'
    morningStar
    threeSoldiers: 'Hit' | 'Not Hit' | 'Confirmed'
    gapUp
    gapDown

}
export default class Strategy {

    icici: Icici
    constructor(icici) {
        this.icici = icici;
    }

    doBalanceTrade = async () => {
        try {
            const percent = 5; //TODO, how is this defined??
            let decision = new Decision();
            decision.action = OptionType.call
            decision.percent = percent
            await this.icici.buyOption(decision)
            console.log('Executed ', decision)

            decision = new Decision();
            decision.action = OptionType.put
            decision.percent = percent
            await this.icici.buyOption(decision)
            console.log('Executed ', decision)

        } catch (e) {
            console.log('Exception in Strategy ', e)
            throw e;
        }
    }

    doDirectionalTrade = async () => {
        const nifty = await this.icici.getQuote('NIFTY')
        console.log('ChangePercent ', nifty.changePercent)

        try {
            let decision = new Decision();

            if (nifty.changePercent > 0) {
                decision.action = OptionType.call
            } else {
                decision.action = OptionType.put
            }
            decision.percent = 1
            console.log('Decision ', decision)
            await this.icici.buyOption(decision)
        } catch (e) {
        }
    }

    twoCandles = []
    threeCandles = []
    fourCandles = []
    fiveCandles = []
    sixCandles = []
    position = {} as Position

    //TODO addCandle should be called after fetching quote from scheduler
    addCandle = (candle) => {
        this.processTwoCandles(candle)
        this.processThreeCandles(candle)
        this.processFiveCandles(candle)
        this.processSixCandles(candle)
        console.log(this.position)

        //Verify following Conclusions: 
        // 1. Small Gapup and next higher opening price is a buy signal
        // 2. Big Gapup and next lower opening price is a sell signal
        // 3. Small Gapdown and next lower opening price is a sell signal
        // 4. Big Gapdown and next higher opening price is a buy signal

        //Morning Star seems to be more proper
    }

    processTwoCandles = (candle) => {
        this.twoCandles.push(candle)
        if (this.twoCandles.length > 2) {
            this.twoCandles.shift()
            this.position.gapUp = this.testGapUp()
            this.position.gapDown = this.testGapDown()
        }
    }

    processThreeCandles = (candle) => {
        this.threeCandles.push(candle)
        if (this.threeCandles.length > 3) {
            this.threeCandles.shift()
            this.position.trend = this.testTrend()
        }
    }

    processFiveCandles = (candle) => {
        this.fiveCandles.push(candle)
        if (this.fiveCandles.length > 5) {
            this.fiveCandles.shift()
            const trend = this.getTrend(this.fiveCandles[0], this.fiveCandles[1], this.fiveCandles[2])
            console.log('Start Processing Now with trend ', trend)
            this.position.hammer = this.testHammer(trend)
            this.position.inverseHammer = this.testInverseHammer(trend)
            this.position.bullishEngulfing = this.testBullishEngulfing(trend)
            this.position.piercingLine = this.testPiercingLine(trend)
            this.position.morningStar = this.testMorningStar(trend)
        }
    }

    processSixCandles = (candle) => {
        this.sixCandles.push(candle)
        if (this.sixCandles.length > 6) {
            this.sixCandles.shift()
            const trend = this.getTrend(this.sixCandles[0], this.sixCandles[1], this.sixCandles[2])
            this.position.threeSoldiers = this.test3WhiteSoldiers(trend)
        }
    }

    testTrend = () => {
        return this.getTrend(this.threeCandles[0], this.threeCandles[1], this.threeCandles[2])
    }
    
    getTrend = (candle1, candle2, candle3) => {
        //find if 3 consecutive candles have higher highs or lower lows
        // or from slope of a trend line        

        //Check for up trend

        //All candles should be positive
        let c1 = candle1.close > candle1.open
        let c2 = candle2.close > candle2.open
        let c3 = candle3.close > candle3.open


        //high should be progressively higher
        let c4 = candle2.high > candle1.high
        let c5 = candle3.high > candle2.high

        //low should be progressively higher
        let c6 = candle2.low > candle1.low
        let c7 = candle3.low > candle2.low

        if (c1 && c2 && c3 && c4 && c5 && c6 && c7) {
            console.log("UP")
            return 'Up';
        }

        //Check for Down Trend
        //All candles should be negative
        c1 = candle1.close < candle1.open
        c2 = candle2.close < candle2.open
        c3 = candle3.close < candle3.open

        //high should be progressively lower
        c4 = candle2.high < candle1.high
        c5 = candle3.high < candle2.high

        //low should be progressively lower
        c6 = candle2.low < candle1.low
        c7 = candle3.low < candle2.low

        if (c1 && c2 && c3 && c4 && c5 && c6 && c7) {
            return 'Down';
        }
        return 'None'
    }

    getValue = (hammer) => {
        if (hammer) {
            const confirmed = this.fiveCandles[4].high > this.fiveCandles[4].high
            if (confirmed) {
                return 'Confirmed'
            } else {
                return 'Hit'
            }
        } else {
            return 'Not Hit'
        }
    }

    count = 0;
    totalHigh = 0
    totalLow = 0

    testHammer = (trend) => {

        // conditions:
        // 1. close > open
        // 2. high is near to close(almost 0)
        // 3. low is far from open

        if (trend == 'Down') {
            const candle = this.fiveCandles[4];
            const near = 1.3 // TODO fine tune
            const far = 2.3  // TODO fine tune

            const c1 = candle.close > candle.open

            // if (c1) {
            //     const highDiff = candle.high - candle.close
            //     const lowDiff = candle.open - candle.low
            //     console.log('High-Close : ', highDiff)
            //     console.log('Open-Low : ', lowDiff)
            //     this.count++
            //     this.totalHigh += highDiff
            //     this.totalLow += lowDiff

            //     console.log('AvgHigh ', this.totalHigh / this.count)
            //     console.log('AvgHigh ', this.totalLow / this.count)
            // }
            const c2 = (candle.high - candle.close) < near
            const c3 = (candle.open - candle.low) > far

            const hammer = c1 && c2 && c3;
            return this.getValue(hammer)
        }
    }

    testInverseHammer = (trend) => {

        // variables: near, far
        // conditions:
        // 1. close > open
        // 2. low is near to open(almost 0)
        // 3. high is far from close

        if (trend == 'Down') {
            const candle = this.fiveCandles[4];
            const near = 1 // TODO fine tune
            const far = 2  // TODO fine tune

            const c1 = candle.close > candle.open
            const c2 = (candle.open - candle.low) <= near
            const c3 = (candle.high - candle.close) >= far

            const invertedHammer = c1 && c2 && c3;
            return this.getValue(invertedHammer)
        }
    }

    testBullishEngulfing = (trend) => {
        // conditions:
        // open < prevLow
        // close > open
        // close > prevOpen

        if (trend == 'Down') {
            const prevCandle = this.fiveCandles[3];
            const candle = this.fiveCandles[4];
            const near = 0.1 // TODO fine tune
            const far = 1  // TODO fine tune

            const c1 = candle.close > candle.open
            const c2 = candle.open < prevCandle.close
            const c3 = candle.close > prevCandle.open

            const bullishEngulfing = c1 && c2 && c3;
            return this.getValue(bullishEngulfing)
        }

    }

    testPiercingLine = (trend) => {
        // conditions:
        // close > open
        // open < prevLow
        // close > 2 / 3 of(prevOpen - prevClose)

        // looks like a smaller signal than engulfing

        if (trend == 'Down') {
            const prevCandle = this.fiveCandles[3];
            const candle = this.fiveCandles[4];

            const c1 = candle.close > candle.open
            const c2 = candle.open < prevCandle.close

            const diff = (2 / 3) * (prevCandle.open - prevCandle.close)
            const c3 = (candle.close - prevCandle.close) >= diff

            const piercingLine = c1 && c2 && c3;
            return this.getValue(piercingLine)
        }

    }

    testMorningStar = (trend) => {
        // Needs 3 candles
        // 1. close > open
        // 2. close < prevLow
        // 3. close < nextLow
        // 4. nextClose > nextOpen
        if (trend == 'Down') {
            const prevCandle = this.fiveCandles[2];
            const candle = this.fiveCandles[3];
            const nextCandle = this.fiveCandles[4]

            const c1 = candle.close > candle.open
            const c2 = candle.close < prevCandle.close
            const c3 = nextCandle.close > nextCandle.open
            const c4 = nextCandle.open > prevCandle.close

            const morningStar = c1 && c2 && c3 && c4;
            if (morningStar) {
                return 'Hit'
            } else {
                return 'Not Hit'
            }
        }
    }

    test3WhiteSoldiers = (trend) => {
        // 1. open > prevOpen
        // 2. close near high
        // 3. close > open for all three candles
        // 4. close - open should not be too much


        if (trend == 'Down') {
            const nearHigh = 1 //TODO fine tune
            const diff = 1 //TODO fine tune

            const candle1 = this.sixCandles[3]
            const candle2 = this.sixCandles[4]
            const candle3 = this.sixCandles[5]

            const c1 = candle1.close > candle1.open
            const c2 = candle2.close > candle2.open
            const c3 = candle3.close > candle3.open

            const c4 = candle2.open > candle1.open
            const c5 = candle3.open > candle2.open

            const c6 = (candle1.high - candle1.close) <= nearHigh
            const c7 = (candle2.high - candle2.close) <= nearHigh
            const c8 = (candle3.high - candle3.close) <= nearHigh

            const c9 = (candle1.close - candle1.open) <= diff
            const c10 = (candle2.close - candle2.open) <= diff
            const c11 = (candle3.close - candle3.open) <= diff

            const result = (c1 && c2 && c3) &&
                (c4 && c5) &&
                (c6 && c7 && c8) &&
                c9 && c10 && c11;

            if (result) {
                return 'Confirmed'
            } else {
                return 'Not Hit'
            }
        }
    }

    testGapUp = () => {

        // 1. open > prevHigh
        if (this.twoCandles[1].open > this.twoCandles[0].high) {
            return this.twoCandles[1].open - this.twoCandles[0].high
        }
    }

    testGapDown = () => {
        // 1. open < prevLow

        if (this.twoCandles[1].open < this.twoCandles[0].low) {
            return this.twoCandles[0].low - this.twoCandles[1].open
        }

    }


}


