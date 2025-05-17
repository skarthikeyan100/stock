// Strategy:
// If direction is sure, go for option else go for option plus

import axios, { AxiosRequestConfig } from 'axios'
import { RestAPI, WebSocket } from '@quantiply/finvasia-nodejs-sdk';
import NorenRestApi from './prism/RestAPI'
import _ from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, Trade } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Mongo from './tools/mongo'
import Prism from './prism';
import Config from './prism/config';
import Util from './util';
import indexMap from './nse_index';
import { NIFTY, SIMULATION } from './constants'
import candleManager, { CandleType } from './candle';
import { Strategy, Outcome } from './strategy/strategy';
import { ORBPrevious } from './strategy/ORBPrevious';


export default class Monitoro {
    targetPriceDiff = 20;
    buyAgainPriceDiff = 10;
    stopLossPriceDiff = 30;
    sliceQuantity = 50

    //Following should be part of
    isBuyAgainActive=false
    isSellActive=false


    // stockCode
    // expiryDate
    // strikePrice
    // buyPrice
    // right
    // token
    // qty

    static instance: Monitoro = null

    static getInstance() {
        if (!Monitoro.instance) {
            Monitoro.instance = new Monitoro();
        }
        return Monitoro.instance;
    }

    trades: Trade[] = [];

    // constructor(stockCode, expiryDate, strikePrice, buyPrice, right, token, qty) {
    //     this.stockCode = stockCode
    //     this.expiryDate = expiryDate
    //     this.strikePrice = strikePrice
    //     this.buyPrice = buyPrice
    //     this.right = right
    //     this.token = token
    //     this.qty = qty
    // }

    async updateTrade(data) {
        console.log('Update Trade ', data)
        const prism = Prism.getInstance();
        if (data.flqty != undefined) {
            
            const trade = new Trade();
            trade.tsym = data.tsym as string;
            trade.quantity = parseInt(data.flqty)
            trade.price = parseFloat(data.flprc)
            trade.token = await prism.getToken(trade.tsym);
            trade.action = data.trantype == 'S' ? 'Sell' : 'Buy'
            if (trade.action == 'Buy') {
                trade.lastTradePrice = trade.price
            }
            
            if (trade.action == 'Sell') {
                console.log('Sell order is going through, so remove the trade from the list')
                const index = this.trades.findIndex(t => t.tsym == trade.tsym);
                console.log("index is ", index, ', for ', trade.tsym)
                if (index != -1) {
                    this.trades.splice(index, 1)
                    console.log('Trade is removed, now length is ', this.trades.length)
                    if (Config.auto) {
                        console.log('Start NIFTY again')
                        prism.buy(trade.tsym, (trade.lastTradePrice - this.buyAgainPriceDiff))
                    }
                }
                return;
            }
            
            const index = this.trades.findIndex ( (t) => t.tsym == trade.tsym );
            if (index == -1) {
                trade.isPendingOrder = false // This could be problem for partial orders
                this.trades.push(trade);
                await prism.subscribeOption(trade.tsym);
                console.log("Add as new trade " + trade)
            } else {
                const t = this.trades[index];
                console.log('Existing qty: ' + t.quantity, ' existing price: ', t.price, ' New qty: ', trade.quantity, ' new price: ', trade.price)
                console.log( 'existing typeof(t.price): ', typeof(t.price), ' typeof(trade.price): ', typeof(trade.price))
                console.log( 'existing typeof(t.quantity): ', typeof(t.quantity), ' typeof(trade.quantity): ', typeof(trade.quantity))
                
                console.log(' Total Quantity: ', t.quantity)
                const existingCost = t.price * t.quantity
                const newCost = trade.price * trade.quantity
                console.log('existingCost: ',existingCost, ' newCost: ', newCost)
                const totalPrice = (t.price * t.quantity) + (trade.price * trade.quantity);
                const totalQuantity = t.quantity + trade.quantity
                console.log(' Total Cost: ', totalPrice)
                console.log(' Total Quantity: ', totalQuantity)
                
                const avgPrice = totalPrice/totalQuantity
                t.price = avgPrice
                t.quantity = totalQuantity;
                t.isPendingOrder = false;
                t.lastTradePrice = trade.price
                console.log("Add to existing trade, new trade is ", t.tsym, " token: " , t.token, ", qty: " + t.quantity + " price: ", t.price.toFixed(2))
            }
            myEmitter.emit('position', this.trades);
        }
    }

    round = (num) => Math.round(num * 10) / 10;

    // WARNING: If price reaches target, but sell is not made, then there is possibility of more loss
    updateQuote = async (optionQuote: OptionQuote) => {
        const prism = Prism.getInstance();
        // console.log("Quote: ", optionQuote)
        let tradeToBeDeleted = null;
        this.trades.forEach(trade => {
            if (trade.token == optionQuote.token) {
                const buyPriceDiff = this.round((trade.price * (this.buyAgainPriceDiff / 100)));
                const sellPriceDiff = this.round((trade.price * (this.targetPriceDiff / 100)));
                const stopLossPriceDiff = (this.round(trade.price * (this.stopLossPriceDiff / 100)));
                const totalInvestment = trade.price * trade.quantity
                const ltp = optionQuote.ltp
                const profit = this.round((ltp - trade.price) * trade.quantity)
                
                console.log('trade.token: ', trade.token, 'Avg Price: ', trade.price, 'Last Trade Price: ', trade.lastTradePrice, 'ltp: ', optionQuote.ltp, ' pending order: ', trade.isPendingOrder, ' buyPriceDiff: ', buyPriceDiff, ' sellPriceDiff: ', sellPriceDiff, ' stopLossPriceDiff: ', stopLossPriceDiff, ' totalInvestment: ', totalInvestment, ' profit: ', profit)
                if (!trade.isPendingOrder) {
                    if (ltp > trade.price && ( (ltp - trade.price >= sellPriceDiff))) {
                        const sellPrice = trade.price + sellPriceDiff
                        console.log('Initiate Sell for profit')
                        prism.sell(trade.tsym, trade.quantity, sellPrice);
                        trade.isPendingOrder = true
                    } else if (ltp < trade.price) {
                        if ( (totalInvestment >= Config.maxInvestment) && (trade.price - ltp) >= stopLossPriceDiff) {
                            console.log('Sell for loss as stop loss is hit')
                            prism.sell(trade.tsym, trade.quantity, ltp);
                            trade.isPendingOrder = true
                        } else if ( (totalInvestment <= Config.maxInvestment) && (trade.lastTradePrice - ltp) >= buyPriceDiff) {
                            const buyPrice = trade.lastTradePrice - buyPriceDiff
                            console.log('Initiate buy again as price has dipped')
                            // Actual investment can be more than maxInvestment as the last trade is not considered
                            prism.buy(trade.tsym,  buyPrice);
                            trade.isPendingOrder = true
                        }
                    }
                }
            }
        });
        
    };


}
