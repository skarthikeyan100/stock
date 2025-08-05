// Strategy:
// If direction is sure, go for option else go for option plus

import axios, { AxiosRequestConfig } from 'axios'
import { RestAPI, WebSocket } from '@quantiply/finvasia-nodejs-sdk';
import NorenRestApi from './prism/RestAPI'
import _ from 'lodash'
import crypto from 'crypto'
import delay from 'delay';
import { NiftyQuote, OptionQuote, Trade, Order, Message } from './model/model';
import util from 'util';
const spawn = require('child_process').spawn;
import myEmitter from './tools/emitter';
import Browser from './trade/browser';
import Mongo from './tools/mongo'
import Prism from './prism';
import Config, { Strategies } from './prism/config';
import Util from './util';
import indexMap from './nse_index';
import { NIFTY, BANKNIFTY, FINNIFTY, SIMULATION, PUT, CALL } from './constants'
import candleManager, { CandleType } from './candle';
import { Strategy, Outcome } from './strategy/strategy';
import { ORBPrevious } from './strategy/ORBPrevious';
import config from './prism/config';
import { SystemZone } from 'luxon';
import moment from 'moment';
import strategies from './strategy/strategies';


enum State {
    TRADED,
    COVERED,
    CLOSED
}

export default class Monitor {
    targetPriceDiff = 20;
    buyAgainPriceDiff = 10;
    stopLossPriceDiff = 30;

    //Following should be part of
    isBuyAgainActive=false
    isSellActive=false
    isBuyPending = false
    state: State


    // stockCode
    // expiryDate
    // strikePrice
    // buyPrice
    // right
    // token
    // qty

    static instance: Monitor = null

    static getInstance() {
        if (!Monitor.instance) {
            Monitor.instance = new Monitor();
        }
        return Monitor.instance;
    }

    trades: Trade[] = [];
    interimTradeMap: Map<String, Trade> = new Map<String, Trade>()
    processedOrders: String[] = []

    // constructor(stockCode, expiryDate, strikePrice, buyPrice, right, token, qty) {
    //     this.stockCode = stockCode
    //     this.expiryDate = expiryDate
    //     this.strikePrice = strikePrice
    //     this.buyPrice = buyPrice
    //     this.right = right
    //     this.token = token
    //     this.qty = qty
    // }

    _getStrategy = (sym: string) => {
        let strategy = Strategies.BUY_AND_HOLD
        if (sym.startsWith(NIFTY)) {
            strategy = config['NIFTY_STRATEGY']
        } else if (sym.startsWith(BANKNIFTY)) {
            strategy = config['BANKNIFTY_STRATEGY']
        } else if (sym.startsWith(NIFTY)) {
            strategy = config['FINNIFTY_STRATEGY']
        }
        return strategy;
    }

    refreshTrades(trades: Trade[]) {
        this.trades = trades
        const prism = Prism.getInstance();
        this.trades.forEach(async trade => {
            trade.lastTradePrice = trade.price
            console.log('In refresh trades, subscribe to ', trade.tsym, ' token: ', trade.token)
            await prism.subscribeOption(trade.token);    
        });
    }

    refreshPendingOrders(orders: Order[]) {
        const prism = Prism.getInstance();
        orders.forEach(async order => {
            await prism.subscribeOption(order.token);    
        });
    }

    subscribeTrades = (trades: Trade[]) => {
        const prism = Prism.getInstance();
        this.trades.forEach(trade => {
            prism.subscribeOption(trade.token);    
        });
    }

    round = (num) => Math.round(num * 10) / 10;
    percent = (price, num) => (price * num/100) 

    async updateTrade(data): Promise<Trade|void>{
        // console.log('Trade data: ', data)
        
        const prism = Prism.getInstance();
        if (data.flqty != undefined) {
            const tradeEvent = new Trade();
            tradeEvent.tsym = data.tsym as string;
            tradeEvent.quantity = parseInt(data.qty)
            tradeEvent.price = parseFloat(data.flprc)
            tradeEvent.token = await prism.getToken(tradeEvent.tsym);
            tradeEvent.action = data.trantype == 'S' ? 'Sell' : 'Buy'
            tradeEvent.status = data.status
            tradeEvent.right = tradeEvent.tsym.indexOf('P') !== -1 ? PUT : CALL;

            if (tradeEvent.action == 'Buy') {
                tradeEvent.lastTradePrice = tradeEvent.price
            }
            // console.log('Notified ', tradeEvent.tsym, ' qty: ', data.qty, ' flqty: ', data.flqty, ' fillshares: ', data.fillshares, ' status: ', data.status, ' orderno: ', data.norenordno)
            let isCompleted = data.fillshares == data.qty && data.status == 'COMPLETE';
            
            if (isCompleted) {
            //     if (this.processedOrders.indexOf(data.norenordno) != -1) {
            //         console.log('Already processed ', data.norenordno)
            //         return
            //     }
            //     this.processedOrders.push(data.norenordno)
                if (tradeEvent.action == 'Sell') {
                    tradeEvent.isSellPending = false
                    this.state = State.CLOSED;
                } else {
                    this.isBuyPending = false
                    this.state = State.TRADED;
                }                
    
                // console.log('Update Trade ', data)
                this._processTradeEvent(tradeEvent)
                return tradeEvent

            //     ////// LEGACY CODE START
            //     const strategy = this._getStrategy(tradeEvent.tsym)
            //     console.log('Traded ', tradeEvent.tsym , 'action: ', tradeEvent.action, ' strategy: ', strategy)
    
            //     if (tradeEvent.action == 'Sell') {
            //         const strategy = this._getStrategy(tradeEvent.tsym)
            //         console.log('Sell order is going through')
            //         const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym);
                    
            //         if (index != -1) {
            //             const monitoredTrade = this.trades[index];
            //             console.log('Total trade quantity: ', monitoredTrade.quantity, ' Sell Quantity: ', tradeEvent.quantity)
            //             monitoredTrade.quantity = monitoredTrade.quantity - tradeEvent.quantity
            //             if(monitoredTrade.quantity == 0) {
            //                 this.trades.splice(index, 1)
            //                 console.log('Remove from trades list as entire quantity is sold')
            //             } else {
            //                 console.log('Parial sell for ', tradeEvent.tsym, ' available qty: ', monitoredTrade.quantity)
            //             }
            //             console.log('Trade is removed, now length is ', this.trades.length)
            //         } else {
            //             console.log('Sell order is completed, but no order in the trade list. Probably sell order is issued manually')
            //         }
            //         if (Config.auto) {
            //             const date = new Date();
            //             const hour = date.getHours();
            //             const min = date.getMinutes();
            //             if (config.endHour > hour || config.endMin >= min) {
            //                 console.log('Start trading again')
            //                 const buyPriceDiff = this.round((tradeEvent.price * (config.buyAgainPriceDiff / 100)));
            //                 prism.buy(tradeEvent.tsym, this.round(tradeEvent.price - buyPriceDiff))
            //             } else {
            //                 console.log('End of trading as time has reached, so dont buy anything new')
            //             }
            //         }
                    
            //         return;
            //     }

            //     // A Buy order is completed
            //     console.log('Buy order for ', tradeEvent.tsym, ' ', tradeEvent.quantity, ' at ', tradeEvent.price, ' is complete')
            //     const index = this.trades.findIndex ( (t) => t.tsym == tradeEvent.tsym );
            //     let t = tradeEvent
            //     t.isBuyPending = false
            //     t.lastTradePrice = tradeEvent.price
            //     if (index == -1) {
            //         console.log('Add as new trade ', t.tsym, ' ', t.quantity, ' at ', t.price, ' isBuyPending: ', t.isBuyPending)
            //         this.trades.push(t);
            //     } else {
            //         const t = this.trades[index];
            //         t.isBuyPending = false
            //         t.lastTradePrice = tradeEvent.price
            //         const totalPrice = (t.price * t.quantity) + (tradeEvent.price * tradeEvent.quantity);
            //         const totalQuantity = t.quantity + tradeEvent.quantity
                    
            //         const avgPrice = totalPrice/totalQuantity
            //         t.price = avgPrice
            //         t.quantity = totalQuantity;
            //         console.log('Updated Trade ', t.tsym, ' ', t.quantity, ' at ', t.price)
            //     }


            //     if (strategy == Strategies.BUY_AND_HOLD) {
            //         console.log('Do nothing for ', t.tsym)
            //         return
            //     }
            //     if (strategy == Strategies.BUY_AND_SELL) {
            //         console.log('Place a sell order for ', t.tsym, ' and forget')
            //         console.log('Does it happen more than once ??')
            //         const sellPriceDiff = this.round((t.price * (config.targetPriceDiff / 100)));
            //         const sellOrderNo = await prism.sell(tradeEvent.tsym, tradeEvent.quantity, this.round(tradeEvent.price + sellPriceDiff))
            //         return
            //     }
            //     if (strategy == Strategies.BUY_AND_RESELL) {
            //         if (index == -1) {
            //             if (!t.isSellPending) {
            //                 // This is a new trade
            //                 const sellPriceDiff = this.round((tradeEvent.price * (config.targetPriceDiff / 100)));
            //                 const sellOrderno = await prism.sell(t.tsym, t.quantity, this.round(t.lastTradePrice + sellPriceDiff))
            //                 console.log('Place a sell order for ', t.tsym, ' and monitor')
            //                 t.sellOrderNo = sellOrderno
            //                 t.isSellPending = true
            //             }
            //             // trade.isPendingOrder = true
    
            //         } else {
            //             // This is executed only if trade is buy and resell
            //             const totalPrice = (t.price * t.quantity) + (tradeEvent.price * tradeEvent.quantity);
            //             const totalQuantity = t.quantity + tradeEvent.quantity
                        
            //             const avgPrice = totalPrice/totalQuantity
            //             t.price = avgPrice
            //             t.quantity = totalQuantity;
            //             // t.isPendingOrder = false;
            //             t.lastTradePrice = tradeEvent.price
            //             console.log("Add to existing trade, new trade is ", t.tsym, " token: " , t.token, ", qty: " + t.quantity + " price: ", t.price.toFixed(2))
                        
            //             // Initiate Cancel existing sell order
            //             // Initiate Sell order since buy is done
    
            //             console.log('Cancel trade: ', t.sellOrderNo)
    
            //             if (!t.isSellPending && t.sellOrderNo) {
            //                 await prism.cancel(t.sellOrderNo)
            //                 console.log("Canceled existing sell order ", t.sellOrderNo)
            //                 const sellPriceDiff = this.round((t.lastTradePrice * (config.targetPriceDiff / 100)));
            //                 const sellOrderno = await prism.sell(t.tsym, t.quantity, sellPriceDiff)
            //                 console.log("New sell order is placed ", sellOrderno)
            //                 t.sellOrderNo = sellOrderno
            //                 t.isSellPending = false
    
            //             }
            //         }
    
            //     }

                // const index = this.trades.findIndex ( (t) => t.tsym == trade.tsym );
            }
            myEmitter.emit('position', this.trades);
        }
        
    }

    // WARNING: If price reaches target, but sell is not made, then there is possibility of more loss
    updateQuote = async (optionQuote: OptionQuote) => {
        this._processQuote(optionQuote)
        if (this.trades.length > 0) {
            myEmitter.emit("position", this.trades)
        }
        // const prism = Prism.getInstance();
        // console.log("Quote: ", optionQuote)
        // this.trades.forEach(async trade => {
        //     if (trade.token == optionQuote.token) {
        //         const strategy = this._getStrategy(trade.tsym)
        //         const buyPriceDiff = this.round((trade.price * (config.buyAgainPriceDiff / 100)));
        //         const sellPriceDiff = this.round((trade.price * (config.targetPriceDiff / 100)));
        //         const stopLossPriceDiff = (this.round(trade.price * (config.stopLossPriceDiff / 100)));
        //         const totalInvestment = trade.price * trade.quantity
        //         const ltp = optionQuote.ltp
        //         const profit = this.round((ltp - trade.price) * trade.quantity)
                
        //         // Buy if dipped, don't sell for profit or stoploss - This is a problem. Stoploss is used only for buy_and_resell
        //         // isPendingOrder - needs more clarity
        //         // console.log(trade.tsym, ' Avg Price: ', trade.price, 'Last Trade Price: ', trade.lastTradePrice, 'ltp: ', optionQuote.ltp, ' buyPriceDiff: ', buyPriceDiff, ' sellPriceDiff: ', sellPriceDiff, ' stopLossPriceDiff: ', stopLossPriceDiff, ' totalInvestment: ', totalInvestment, ' profit: ', profit)
        //         const buyPrice = trade.lastTradePrice - buyPriceDiff
        //         console.log(trade.tsym, ' Avg: ', this.round(trade.price), 'Last Traded: ', trade.lastTradePrice, 'ltp: ', optionQuote.ltp, ' buyAt: ', buyPrice, ' Investment: ', totalInvestment, ' profit: ', profit)

        //         // Actual investment can be more than maxInvestment as the last trade is not considered
        //         // if ( (totalInvestment <= Config.maxInvestment) && (trade.lastTradePrice - ltp) >= buyPriceDiff) {
        //             if ( (trade.lastTradePrice - ltp) >= buyPriceDiff) {
        //             console.log('Initiate buy again as price has dipped, isBuyPending: ', trade.isBuyPending)
        //             if (!trade.isBuyPending) {
        //                 trade.isBuyPending = true;
        //                 prism.buy(trade.tsym,  buyPrice);
                        
        //             }
        //             // trade.isPendingOrder = true
        //         }

        //         // if (!trade.isPendingOrder) {
        //         //     if (ltp > trade.price && ( (ltp - trade.price >= sellPriceDiff))) {
        //         //         const sellPrice = trade.price + sellPriceDiff
        //         //         console.log('Initiate Sell for profit')
        //         //         const orderno = await prism.sell(trade.tsym, trade.quantity, sellPrice);
        //         //         trade.sellOrderNo = orderno
        //         //         trade.isPendingOrder = true
        //         //     } else if (ltp < trade.price) {
        //         //         if ( (totalInvestment >= Config.maxInvestment) && (trade.price - ltp) >= stopLossPriceDiff) {
        //         //             console.log('Sell for loss as stop loss is hit')
        //         //             prism.sell(trade.tsym, trade.quantity, ltp);
        //         //             trade.isPendingOrder = true
        //         //         } else if ( (totalInvestment <= Config.maxInvestment) && (trade.lastTradePrice - ltp) >= buyPriceDiff) {
        //         //             const buyPrice = trade.lastTradePrice - buyPriceDiff
        //         //             console.log('Initiate buy again as price has dipped')
        //         //             // Actual investment can be more than maxInvestment as the last trade is not considered
        //         //             prism.buy(trade.tsym,  buyPrice);
        //         //             trade.isPendingOrder = true
        //         //         }
        //         //     }
        //         // }
        //     }
        // });

    };

    _processTradeEvent = async (tradeEvent: Trade) => {
        strategies.getList().forEach(s => console.log('Strategy: ', s.getClassName()))
        const prism = Prism.getInstance();
        if (tradeEvent.action == 'Buy') {
            console.log('New Trade ', tradeEvent.tsym, ' ', tradeEvent.quantity)
            const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym);
            if (index == -1) {
                this.trades.push(tradeEvent)
            } else {
                const trade = this.trades[index];
                trade.quantity += tradeEvent.quantity;
                const traded = trade.quantity * trade.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                const totalTraded = traded + newTraded
                trade.price = totalTraded / trade.quantity

            }
        } else {
            const index = this.trades.findIndex(t => t.tsym == tradeEvent.tsym);
            
            if (index != -1) {
                console.log('Trade is closed ', tradeEvent.tsym, ' ', tradeEvent.quantity, ' Enabled auto trade: ', Config.auto)
                this.trades.splice(index, 1)
                if (Config.auto) {
                    const date = new Date();
                    const hour = date.getHours();
                    const min = date.getMinutes();
                    if (config.endHour > hour || config.endMin >= min) {
                        console.log('Start trading again')
                        let buyPriceDiff = config.buyAgainPriceDiff
        
                        if (config.buyAgainPriceDiff.toString().endsWith('%')) {
                            buyPriceDiff = this.round((tradeEvent.price * (config.buyAgainPriceDiff / 100)));
                        }
                        const buyPrice = tradeEvent.price - buyPriceDiff
                        await prism.buy(tradeEvent.tsym, buyPrice)
                        this.isBuyPending = true;
                    } else {
                        console.log('End of trading as time has reached, so dont buy anything new')
                    }
                }

            }

        }
    }

    timeout() {
        const now = moment();
        const endTime = moment().hour(15).minute(20);
        return now.isAfter(endTime);
    }

    async _processQuote(optionQuote: OptionQuote) {
        let canHandle = false;
        for (let index = 0; index < strategies.getList().length; index++) {
            const strategy = strategies.getList()[index];
            canHandle = strategy.canHandleOptionQuote(optionQuote);
            if (canHandle == true) {
                await strategy.processOptionQuote(optionQuote)
                const index = this.trades.findIndex(t => t.token == optionQuote.token);
                if (index != -1) {
                    this.trades.splice(index, 1)
                }
                return;
            } 
        }

        // console.log('WRONG: Code should not reach here for Bidirection Strategy, token: ', optionQuote.token, ' ltp: ', optionQuote.ltp)
        // console.log('Available strategies: ', strategies.getList().map(s => s.getClassName()))

        const prism = Prism.getInstance()
        // console.log('optionQuote: ', optionQuote)

        // Handle each trade for profit, buy again and stop loss
        const messages = []
        this.trades.forEach(async trade => {
            // console.log('trade: ', trade)
            // Only open trades come here meaning, there are no corresponding sell orders
            if (trade.token == optionQuote.token && !('COMPLETED' === trade.status)) {
                trade.ltp = optionQuote.ltp;
                let buyPriceDiff = config.buyAgainPriceDiff
                let sellPriceDiff = config.targetPriceDiff
                let stopLossPriceDiff = config.stopLossPriceDiff;

                if (config.buyAgainPriceDiff.toString().endsWith('%')) {
                    buyPriceDiff = this.round((trade.price * (config.buyAgainPriceDiff / 100)));
                    sellPriceDiff = this.round((trade.price * (config.targetPriceDiff / 100)));
                    stopLossPriceDiff = this.round((trade.price * (config.stopLossPriceDiff / 100)));
                }

                const buyPrice = trade.price - buyPriceDiff
                
                if (!trade.targetPrice) {
                    const sellPrice = this.round(parseFloat(trade.price.toString()) + parseFloat(sellPriceDiff.toString()))
                    trade.targetPrice = this.round(sellPrice);
                }

                if (!trade.stopLossPrice) {
                    const stopLossPrice = this.round(parseFloat(trade.price.toString()) - parseFloat(stopLossPriceDiff.toString()))
                    trade.stopLossPrice = this.round(stopLossPrice);
                }


                if ( optionQuote.ltp <= trade.stopLossPrice) {
                    console.log('Sell for stoploss ')
                    if (!trade.isSellPending) {
                        trade.isSellPending = true;
                        await prism.sell(trade.tsym, trade.quantity, trade.stopLossPrice);
                        trade.status = 'COMPLETED'
                        this.state = State.CLOSED;
                    }
                } else if ( optionQuote.ltp >= trade.targetPrice) {

                    // Update stop loss price to the target price and update incremental target price
                    const stopLossPrice = this.round(parseFloat((optionQuote.ltp - 2).toString()))
                    trade.stopLossPrice = stopLossPrice
                    const sellPrice = this.round(parseFloat(optionQuote.ltp.toString()) + parseFloat(sellPriceDiff.toString()))
                    trade.targetPrice = this.round(sellPrice);
                    console.log('Update target price to ', trade.targetPrice, ' stop loss price: ', trade.stopLossPrice)
    
                    // Never sell for profit if trail stop loss is true
                    if (!config.trailStop) {
                        console.log('Sell for profit')
                        if (!trade.isSellPending) {
                            trade.isSellPending = true;
                            await prism.sell(trade.tsym, trade.quantity, trade.targetPrice);
                            console.log('Sell for Profit order: ', trade.tsym)
                            trade.status = 'COMPLETED'
                            this.state = State.CLOSED;
                        }
                    }
                } else if (this.timeout()) {
                    if (!trade.isSellPending) {
                        trade.isSellPending = true;
                        await prism.sell(trade.tsym, trade.quantity, optionQuote.ltp);
                        trade.status = 'COMPLETED'
                        console.log('Sell for timeout order: ', trade.tsym)
                        this.state = State.CLOSED;
                    }
                }

                // if ( !trade.buyOrderNo && optionQuote.ltp <= buyPrice && optionQuote.ltp > stopLossPrice ) {
                //     console.log('Initiate buy again as price has dipped, isBuyPending: ', this.isBuyPending)
                //     if (!this.isBuyPending) {
                //         this.isBuyPending = true;
                //         const buyOrderNo = await prism.buy(trade.tsym,  buyPrice);
                //         trade.buyOrderNo = buyOrderNo
                //         const order = new Order();
                //         order.orderno = buyOrderNo
                //         order.price = buyPrice
                //         order.tsym = trade.tsym
                //         const tsym = trade.tsym
                //         const indexObj = tsym.startsWith('BANK') ? indexMap.get('BANKNIFTY') : tsym.startsWith('NIFTY') ? indexMap.get('NIFTY') : indexMap.get('FINNIFTY');
                //         console.log('indexObj: ' + indexObj);
                //         const qty = indexObj.getQuantity(order.price);
                //         order.quantity = qty

                //         const indexName = tsym.startsWith('BANK') ? BANKNIFTY : tsym.startsWith('NIFTY') ? NIFTY : FINNIFTY
                //         const right = tsym.indexOf('P') ? 'put' : 'call';
                //         await prism.buyIndex(indexName, right)
                //         this.pendingOrders.push(order)
                //         if (Config.takePositionInOtherDirection == true) {
                //             const indexName = trade.tsym.startsWith('BANK') ? BANKNIFTY : trade.tsym.startsWith('NIFTY') ? NIFTY : FINNIFTY
                //             const right = trade.tsym.indexOf('P') ? 'put' : 'call';
                //             await prism.buyIndex(indexName, right)
                //         }

                //     }
                // }
            }
        });

        // Handle pending orders
        // this.pendingOrders.forEach(async order => {
            
        //     if ((order.token == optionQuote.token) && (optionQuote.ltp - order.price) >= Config.buyTrail) {
                
        //         let buyPriceDiff = config.buyAgainPriceDiff
        //         if (config.buyAgainPriceDiff.toString().endsWith('%')) {
        //             buyPriceDiff = this.round((optionQuote.ltp * (config.buyAgainPriceDiff / 100)));
        //         }

        //         const buyPrice = optionQuote.ltp - buyPriceDiff
        //         console.log('Order ', order.orderno, ' became stale, so modify it to new price ', buyPrice, ' oldPrice: ', order.price, ' ltp: ', optionQuote.ltp)
        //         await prism.modifyOrder(order, buyPrice)
        //         this.isBuyPending = true
        //     }
        // })

    }


}
