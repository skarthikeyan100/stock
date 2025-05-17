import Browser from '../trade/browser.js';
import { Builder, By, until, Key } from 'selenium-webdriver';
// import EventEmitter from 'events';
import delay from 'delay'
// import cheerio from 'cheerio'
import axios from 'axios'
import _ from 'lodash'
import icicinse from '../trade/icicinse'
import symbols from '../symbols'
import Mongo from './mongo'
import moment from 'moment'

import { sma, ema, bollingerbands, sd, bullish } from 'technicalindicators'

export class Signal {

    bollingerbands = (currentPrice, period, stddev, prices) => {
        let bb = bollingerbands(
            {
                period: period,
                stdDev: stddev, values: prices
            })[0]
        const middle = Math.round(bb.middle)
        const upper = Math.round(bb.upper)
        const lower = Math.round(bb.lower)

        if (currentPrice >= upper) {
            return 'tagUpper'
        }

        if (currentPrice <= lower) {
            return 'tagLower'
        }
    }

    sma = (currentPrice, period, prices) => {
        let signal = undefined
        let prevPrice = prices[period-2]
        let value = sma({ period: period, values: prices })[0]
        value = Math.round(value)
        if (value < prevPrice && value > currentPrice) {
            signal = 'Sell'
        }

        if (value > prevPrice && value < currentPrice) {
            signal = 'Buy'
        }
        return signal
    }

    kArray: number[] = []
    dArray: number[] = []

    stochastic = (price) => {

        const sampleCount = 20
        const dPeriod = 3

        const getK = (number) => {

            this.kArray.push(parseFloat(number))

            if (this.kArray.length == sampleCount) {
                let close = number
                let low = Math.min(...this.kArray)
                let high = Math.max(...this.kArray)
                let K = (close - low) / (high - low) * 100
                this.kArray.shift()

                return Math.round(K)
            }
        }

        const getD = (number) => {
            if (number !== undefined) {
                this.dArray.push(number)
                if (this.dArray.length == dPeriod) {
                    const D = Math.round(sma({ period: dPeriod, values: this.dArray })[0])
                    this.dArray.shift()
                    return D
                }
            }
        }

        let K = getK(price)
        let D = getD(K)

        if (D !== undefined) {
            if (K > 80 && D > 80) {
                return 'Buy'
            }
            if (K < 20 && D < 20) {
                return 'Sell'
            }
        }
    }

}