import { NOT_PLACED_TAG } from '../ipc/orderProtocol';
import Log from '../util/Log';
import { NiftyQuote, OptionQuote, OrderStatus, Trade } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient'
import moment from "moment";
import configService from '../prism/ConfigService'



// Consider volatility or standard deviation too
// let averageThreshold = 5
// let targetPrice = 2
// const orderQuantity = 300;
// const sentiment = 'any'

const round = (num) => Math.round(num * 100) / 100;



class Contract {
    contract: string;
    price: number = 0;
    qty: number = 0;
    token: string;
    profit: number = 0;
    ltp: number = 0;
    BUY = 'Buy'
    SELL = 'Sell'
    orderPlaced = false
    status: OrderStatus = OrderStatus.PENDING;
    buyAt: number = 0;
    sellAt: number = 0;
    lastOrderedPrice: number = 0;
    lastOrderedQuantity: number = 0;
    strategy: Strategy = {} as Strategy;
    averageCount = 0; // average-in buys placed so far (capped by maxAverages)

    constructor(strategy, contract) {
        this.contract = contract;
        this.strategy = strategy;
    }

    update = (token) => {
        this.token = token;
    }

    toString = () => {
        return `Contract: ${this.contract}, Price: ${this.price}, Qty: ${this.qty}, Token: ${this.token}, Profit: ${this.profit}`;
    }

    clear = () => {
        this.contract = '';
        this.token = '';
        this.qty = 0;
        this.price = 0;
        this.lastOrderedPrice = 0;
        this.lastOrderedQuantity = 0;
        this.profit = 0;
        this.buyAt = 0;
        this.sellAt = 0;
        this.orderPlaced =false;
        this.averageCount = 0;
    }

    canHandleOptionQuote = (token) => {
        return this.token != null && this.token == token;
    }


    processOptionQuote = async (quote: OptionQuote) => {
        const averageThreshold = (this.strategy as SentimentStrategy).getConfig().averageThreshold;
        const orderQuantity = (this.strategy as SentimentStrategy).getConfig().orderQuantity;
        const targetPrice = (this.strategy as SentimentStrategy).getConfig().targetPrice;

        // Log.log('this.token: ', this.token, ' quote.token: ', quote.token, ' contract: ', )
        if (this.token == quote.token) {
            this.ltp = quote.ltp;
            // Log.log('Calculate profit ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty)
            this.profit = round((quote.ltp - this.price) * this.qty)
            // Log.log(this.contract, ' ltp: ', quote.ltp, ' price: ', this.price, ' qty: ', this.qty, ' profit: ', this.profit,  ' threshold: ', round(this.lastOrderedPrice - averageThreshold), ' targetPrice: ', round(this.price + targetPrice))
    
            //Handle negative direction
            
                // Averaging buys the configured order quantity (was a hard-coded 600) and is capped: with no cap a falling contract
                // was bought again every `averageThreshold` points without limit.
                const maxAverages = (this.strategy as SentimentStrategy).getConfig().maxAverages ?? 3;
                if (this.token && this.token == quote.token
                    && !this.orderPlaced
                    && this.lastOrderedPrice > 0
                    && this.averageCount < maxAverages
                    && (quote.ltp - this.lastOrderedPrice) < -averageThreshold) {
                        this.orderPlaced = true
                        this.averageCount++
                        this.strategy.buyContract(this.contract, orderQuantity, quote.ltp)
                }
            
            //Handle positive direction
            // Only against a real position: a sell sized from qty 0 / price 0 (no Buy fill recorded yet) must never fire.
            const canSell = this.qty > 0 && this.price > 0 && (quote.ltp - this.price) >= targetPrice
    
            if (this.token && this.token == quote.token &&
                canSell == true && !this.orderPlaced) {
                this.orderPlaced = true
                Log.log('SentimentStrategy: sell contract ', this.contract, ' at ', quote.ltp)
                await this.strategy.sellContract(this.contract, this.qty, quote.ltp)
            }
    
        }
    }

    updateTrade = async (trade: Trade) : Promise<boolean> => {
        const averageThreshold = (this.strategy as SentimentStrategy).getConfig().averageThreshold;
        const targetPrice = (this.strategy as SentimentStrategy).getConfig().targetPrice;

        let tradeClosed = false
        if (trade.tsym == this.contract) {
            if (trade.action == this.BUY) {
                this.orderPlaced = false;
                this.lastOrderedPrice = trade.price
                this.lastOrderedQuantity = trade.quantity
                if (this.qty == 0) {
                    this.qty = trade.quantity
                    this.price = trade.price
                } else {
                    const totalAmount = (this.qty * this.price) + (trade.quantity * trade.price)
                    this.qty = this.qty + trade.quantity
                    this.price = round(totalAmount / this.qty)
                }
                // averageThreshold = updatePrice(this.price)
                // targetPrice = updatePrice(this.price)
                Log.log(this.contract, ' price: ', this.price, ' qty: ', this.qty,  ' buyAt: ', round(this.lastOrderedPrice - averageThreshold), ' sellAt: ', round(this.price + targetPrice))
            }

            if (trade.action == this.SELL) {
                this.clear();
                tradeClosed = true;
                Log.log('After Sell Trade, contract: ', this)
            }
        }
        return tradeClosed;
    }
}

export default class SentimentStrategy extends Strategy {
    contract: Contract = {} as Contract
    name: string;
    ordered = false
    iterationCount = 0;
    // Buy fills that arrived before buyIndex's response created the Contract (the fill can beat the response); replayed once it exists.
    private earlyFills: Trade[] = [];


    // Public so Contract reads this instance's own config block.
    getConfig() { return this.instanceConfig(); }

    constructor(userId?: string) {
        super(userId);
        this.tradeMap = new Map();
        this.name = 'SentimentStrategy';
        this.enabled = true
    }

       
    isTimeInRange(): boolean {
        const now = moment();
        const startTime = moment().hour(9).minute(30);
        const endTime = moment().hour(15).minute(30);
    
        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    receive(oldStats, newStats) {
    }

    reset(): void {
        super.reset();
        this.contract?.clear?.();
        this.ordered = false;
        this.iterationCount = 0;
        this.earlyFills = [];
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        let handled = false;
        const token = quote.token
        
        if (this.contract?.canHandleOptionQuote) {
            handled = this.contract.canHandleOptionQuote(token)
        }
        return handled;
    }

    processOptionQuote = async (quote: OptionQuote) => {
        
        if (this.ordered == true) {
            if (this.contract && this.contract?.token == quote.token) {
                await this.contract.processOptionQuote(quote);
            }

        }
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const orderQuantity = this.instanceConfig().orderQuantity;
        const sentiment = this.instanceConfig().sentiment;
        const enabled = this.instanceConfig().enabled;
        const loopCount = this.instanceConfig().loopCount;
        if (enabled) {
            if (this.iterationCount < loopCount && this.isTimeInRange() && !this.ordered && this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) {
                this.ordered = true;
                Log.log('Initiate buy index for NIFTY at ', quote.ltp, ' with initial quantity: ', orderQuantity, ' iterationCount: ', this.iterationCount);
                let response;
                try {
                    response = await OrderClient.getInstance().buyIndex(this.userId, { niftyLtp: quote.ltp - 2, right: sentiment, quantity: orderQuantity });
                } catch (e) {
                    Log.log('[SentimentStrategy] buyIndex failed:', e);
                    // Re-arm only on a definite rejection. After a timeout/IPC failure the order may still be live: re-arming would buy
                    // again, so the strategy stays paused (ordered=true) until an admin reset.
                    if (String((e as any)?.message ?? e).includes(NOT_PLACED_TAG)) {
                        this.ordered = false;
                    } else {
                        Log.log('[SentimentStrategy] ALERT: entry outcome unknown - strategy paused (the order may be live); reset it once the account is checked');
                    }
                    return;
                }
                this.iterationCount++;
                this.recordTriggerTime();
                if (response) {
                    Log.log('Response: ', response)
                    this.contract = new Contract(this, response.tsym);
                    this.contract.update(response.token);
                    const early = this.earlyFills;
                    this.earlyFills = [];
                    for (const t of early) await this.updateTrade(t);
                }
            }
        }
    }


    updateTrade = async (trade: Trade) => {
        // Log.log('Sentiment Strategy: Update Trade action: ', trade.action, ' ', trade.right, ' ', trade.tsym, ' ', trade.token)

        if (!this.contract?.updateTrade) {
            // No Contract yet: the entry's fill beat buyIndex's response. Keep it (bounded) and replay it once the Contract exists.
            if (trade.action === 'Buy' && this.ordered && this.earlyFills.length < 50) this.earlyFills.push(trade);
            return;
        }
        {
            const tradeClosed = await this.contract.updateTrade(trade)
            if (tradeClosed) {
                this.ordered = false;
                // await Prism.getInstance().buyIndex({ user: this.userId, index: NIFTY, ltp: trade.ltp, right: "any", qty: initialQuantity });
            }
        }
    }
}