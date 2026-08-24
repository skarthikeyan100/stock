import Log from '../util/Log';
import { NiftyQuote, OptionQuote, OrderInfo, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import * as f from '../orderList'
import OrderClient from '../processes/strategies/OrderClient'
import indexMap from '../nse_index';
import { NIFTY, CALL, PUT, BOUGHT } from '../constants'
import myEmitter from '../tools/emitter';
import { TouchSequence } from "selenium-webdriver";
import { round } from "lodash";
import moment from "moment";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


class BuyerInterestModel{
    contract
    buyQty
    sellQty
    diff
    intrinsic
    extrinsic
}

class Contract {
    contract: string
    price: number
    profit: number
    sellPrice: number

    constructor(contract, price, sellPrice) {
        this.contract = contract
        this.price = price
        this.sellPrice = sellPrice
    }
}

const orderQuantity = 300
const targetPrice = 3
const interestThreshold = 1000
const tradesCount = 10;
const differenceThreshold = 5;


export default class Minutes5Decision extends Strategy {
    contracts: Array<Contract> = []

    processNiftyQuote(quote: NiftyQuote) {
        
    }
    processOptionQuote(quote: OptionQuote) {
        
    }

    updateTrade = async (trade: Trade) : Promise<void> => {
        Log.log(`[Minutes5] Trade update: ${trade.tsym} qty=${trade.quantity} ltp=${trade.lastTradePrice} pnl=${trade.realizedPnL}`)
        if (trade.action == 'Sell') {
            this.contracts = this.contracts.filter ( c => {
                return !(c.contract == trade.tsym && trade.price == c.sellPrice)
            })
            Log.log('After sell contracts: ', this.contracts)
        }
    }

    eventName = 'priceUpdate_60'

    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'Minutes15Decision';
        this.enabled = true
    }

    _executeTrade = async (selected) => {
        Log.log('Place buy order for ', selected)
        const orderResponse = await this.buyContract(selected, orderQuantity)
        const buyPrice = parseFloat(orderResponse.price as unknown as string);
        const sellPrice = round(buyPrice + targetPrice, 1)
        await sleep(2000); // Assuming buy is executed at buyPrice
        Log.log('Place sell order for ', selected)
        await this.sellContract(selected, orderQuantity, sellPrice)
        const contract = new Contract(selected, buyPrice, sellPrice)
        this.contracts.push(contract)
        Log.log('Adding to the list ', contract)

    }

    // Buy on a recommendation and sell with 5 profit - no stop loss - monitor manually
    // Maximum open trades: 10
    // How do i know this trade is closed ?
    async receive(oldStats, newStats) {
        if (oldStats != null) {
            const now = moment().tz('Asia/Kolkata').format('HH:mm');
            if (this.eventName == oldStats.results.eventName) {
                if (this.contracts.length <= tradesCount) {
                    const selectedContract = await this.getTradersDirection();
                    if (selectedContract) {
                        const selected = selectedContract.contract

                        var recommendation = selected.substring(12, 13) == 'C' ? 'CALL' : 'PUT'
                        Log.log(now, ' Recommend to Buy ' +  recommendation)

                        this.contracts.sort()

                        this.contracts.sort((a, b) => {
                            if (a.contract < b.contract) return -1;
                            if (a.contract > b.contract) return 1;
                            return a.price - b.price;
                        })
                          

                        const availableContract = this.contracts.find (c => {
                            return c.contract == selected
                        })
                        Log.log("Available Contract: ", availableContract)
                        if (availableContract) {
                            const optionQuote = await OrderClient.getInstance().getStockOptionQuote(this.userId, availableContract.contract)
                            const differenceInPrice = round(availableContract.price - optionQuote.ltp);
                            Log.log('availableContract.price: ', availableContract.price, ' optionQuote.ltp: ', optionQuote.ltp, ' Difference: ', differenceInPrice)
                            if ( differenceInPrice >= differenceThreshold) {
                                await this._executeTrade(selected)
                            } else {
                                Log.log('No trade as the difference is ', (availableContract.price - optionQuote.ltp))
                            }
                        } else {
                            Log.log('Execute New Trade')
                            await this._executeTrade(selected)
                        }
                        
                    } else {
                        Log.log(now, ' No Trade')
                    }
                } else {
                    Log.log('Maximum active trades have reached')
                }
            }
        }
    }    

    getTradersDirection = async () => {
        Log.log('[K} Verify ', this.contracts)
        const ltp = (await OrderClient.getInstance().getNiftyQuote(this.userId)).ltp
        const nseIndex = indexMap.get('NIFTY' as string);
        const contracts = await this.getContracts(ltp);
       
        let result = [] as any;
        var selectedContract : BuyerInterestModel;


        for(var contract of contracts) {
            const optionQuote = await OrderClient.getInstance().getOptionQuote(this.userId, contract);
            var strikePrice = contract.substring(13)
            var callorput = contract.substring(12, 13)
            var premium = optionQuote.ltp
            var intrinsic = round(ltp - parseInt(strikePrice))
            if (callorput == 'P') {
                intrinsic = -intrinsic
            }
            var extrinsic = premium - intrinsic
            
            
            var buyerInterest : BuyerInterestModel = {
                contract, 
                buyQty: optionQuote.buyQty, 
                sellQty: optionQuote.sellQty, 
                diff: optionQuote.buyQty - optionQuote.sellQty,
                intrinsic,
                extrinsic
            }
            result.push(buyerInterest)

            // Potentially buy only if extrinsic is high AND buyQty > sellQty -> Most of the time trade will be undefined

            const buySellDiffference = optionQuote.buyQty - optionQuote.sellQty
            if (selectedContract == null) {
                if (buySellDiffference > interestThreshold) {
                    selectedContract = buyerInterest;
                }
                
            } else {
                if (buySellDiffference > interestThreshold) {
                    if (buySellDiffference > selectedContract.diff) {
                        selectedContract = buyerInterest;
                    }
                }
            }

        }
        console.table(result);
        return selectedContract
    }

        getContracts = async (ltp) => {
            const contracts = new Set<string>();
            
            let result = null;
            const index = 'NIFTY'
            const nseIndex = indexMap.get(index);
            const factor = 50
            const floorPrice = Math.floor(ltp/factor) * factor;
            const ceilPrice = Math.ceil(ltp/factor) * factor;
            const floorDiff = Math.abs(floorPrice - ltp)
            const ceilDiff = Math.abs(ceilPrice - ltp)
    
            const strikePriceInitial = floorDiff > ceilDiff ? ceilPrice: floorPrice
            const fn = async (right) => {
                // for(var depth = 1; depth < 2; depth++) {
                //     let strikePrice = floorDiff > ceilDiff ? ceilPrice: floorPrice        
                //     // Log.log('Strike Price: ', strikePrice, ' depth: ', depth, ' right: ', right)
                //     if (right == 'call') {
                //         strikePrice += (depth * factor)
                //     } else {
                //         strikePrice -= (depth * factor)
                //     }
                    
                //     const contract = await nseIndex.findTokenFor(index, right, strikePrice);
                //     Log.log('Adding contract ', contract)
                //     contracts.add(contract)
                // }
    
                let contract = await nseIndex.findTokenFor(index, CALL, ceilPrice);
                contracts.add(contract)
    
    
                contract = await nseIndex.findTokenFor(index, PUT, floorPrice);
                contracts.add(contract)
    
            }
    
            await fn(CALL)
            await fn(PUT)
    
            return contracts
    
        }

}