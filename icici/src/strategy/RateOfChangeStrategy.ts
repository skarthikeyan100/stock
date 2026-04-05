import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import Prism from '../prism';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';
import Monitor from '../monitor';

const round = (num: number) => Math.round(num * 100) / 100;

class RateOfChangeContract {
    contract: string = '';
    token: string = '';
    price: number = 0;
    quantity: number = 0;
    right: string = '';
    entryTime: number = 0;
    buyOrderPlaced: boolean = false;
    sellOrderPlaced: boolean = false;
    ltp: number = 0;

    clear() {
        this.contract = '';
        this.token = '';
        this.price = 0;
        this.quantity = 0;
        this.right = '';
        this.entryTime = 0;
        this.buyOrderPlaced = false;
        this.sellOrderPlaced = false;
        this.ltp = 0;
    }

    async processOptionQuote(quote: OptionQuote, strategy: RateOfChangeStrategy): Promise<boolean> {
        if (this.price === 0 || this.token !== quote.token) {
            return false;
        }

        const config = configService.getStrategyConfig('RateOfChangeStrategy');
        this.ltp = quote.ltp;

        const pointsGain = quote.ltp - this.price;
        const profit = pointsGain * this.quantity;
        const timeElapsed = Date.now() - this.entryTime;

        if (config.logEnabled) {
            Log.log(`[RoC] ${this.contract} points=${round(pointsGain)} P&L=${round(profit)}`);
        }

        // Monitor handles target/SL exits; strategy only handles timeout
        const timeout = config.maxHoldTimeMinutes > 0 && timeElapsed >= config.maxHoldTimeMinutes * 60 * 1000;

        if (timeout && !this.sellOrderPlaced) {
            Log.log(`[RoC] Selling ${this.contract}: TIMEOUT P&L=${round(profit)}`);
            this.sellOrderPlaced = true;
            strategy.recordOutcome('timeout', profit);
            await strategy.sellContract(this.contract, this.quantity, quote.ltp);
        }

        return false;
    }

    async updateTrade(trade: Trade, strategy: RateOfChangeStrategy): Promise<boolean> {
        if (trade.tsym !== this.contract) {
            return false;
        }

        const config = configService.getStrategyConfig('RateOfChangeStrategy');

        if (this.buyOrderPlaced && trade.action === 'Buy') {
            this.buyOrderPlaced = false;
            this.price = trade.price;
            this.quantity = trade.quantity;
            this.entryTime = Date.now();
            if (config.logEnabled) {
                Log.log(`[RoC] Buy confirmed: ${this.contract} qty=${this.quantity} price=${this.price}`);
            }
            return false;
        }

        if (trade.action === 'Sell') {
            if (this.sellOrderPlaced) {
                // Strategy-triggered sell (timeout): recordOutcome already called in processOptionQuote
                this.sellOrderPlaced = false;
                if (config.logEnabled) {
                    Log.log(`[RoC] Sell confirmed (timeout): ${this.contract}`);
                }
            } else {
                // Monitor-triggered sell (target/SL): record outcome now
                const profit = (trade.price - this.price) * this.quantity;
                strategy.recordOutcome(profit >= 0 ? 'win' : 'loss', profit);
                if (config.logEnabled) {
                    Log.log(`[RoC] Sell confirmed (monitor): ${this.contract} P&L=${round(profit)}`);
                }
            }
            return true;
        }

        return false;
    }
}

export default class RateOfChangeStrategy extends Strategy {
    private contract: RateOfChangeContract | null = null;

    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('RateOfChangeStrategy').enabled;
    }

    receive(oldStats: any, newStats: any) {}

    getMonitorConfig() {
        const config = configService.getStrategyConfig('RateOfChangeStrategy');
        return { targetPoints: config.targetPrice, stopLossPoints: config.stopLossPrice, trailingDistance: configService.getConfig().settings.trailingDistance };
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.contract !== null && this.contract.token === quote.token;
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const config = configService.getStrategyConfig('RateOfChangeStrategy');

        if (!this.enabled || !this.isTimeInRange()) return;

        if (this.contract !== null) return;

        if (!this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) return;

        const velocity = this.calculatePointsChange(config.numberOfDatapointsReceived);
        const acceleration = this.calculateAcceleration(config.numberOfDatapointsReceived);

        if (config.logEnabled) {
            Log.log(`[RoC] NIFTY=${quote.ltp} Velocity=${round(velocity)} Acceleration=${round(acceleration)} AccDominates=${Math.abs(acceleration) > Math.abs(velocity)} VelThreshold=±${config.pointsThreshold} AccThreshold=±${config.accelerationThreshold} (window=${config.numberOfDatapointsReceived} datapoints)`);
        }

        const velUp   = velocity     >=  config.pointsThreshold;
        const velDown = velocity     <= -config.pointsThreshold;
        const accUp   = acceleration >=  config.accelerationThreshold;
        const accDown = acceleration <= -config.accelerationThreshold;
        const accDominates = Math.abs(acceleration) > Math.abs(velocity);

        let direction: string | null = null;
        if (accDominates) {
            if      (velUp   && accUp)   direction = CALL;  // accelerating up
            else if (velDown && accDown) direction = PUT;   // accelerating down
            else if (velUp   && accDown) direction = PUT;   // decelerating up → reversal
            else if (velDown && accUp)   direction = CALL;  // decelerating down → reversal
        }

        // Set sentinel before any await to prevent concurrent executeTrade calls
        if (direction) {
            if (!this.isSentimentAligned(quote, direction)) {
                Log.log('[RoC] Sentiment not aligned for', direction, '— skipping');
                return;
            }
            this.contract = new RateOfChangeContract();
            Log.log('Execute Trade for ', this.contract)
            await this.executeTrade(quote, direction, velocity);
        }
    }

    async processOptionQuote(quote: OptionQuote) {
        if (this.contract) {
            const closed = await this.contract.processOptionQuote(quote, this);
            if (closed) {
                this.contract.clear();
                this.contract = null;
            }
        }
    }

    updateTrade = async (trade: Trade): Promise<void> => {
        if (this.contract) {
            const closed = await this.contract.updateTrade(trade, this);
            if (closed) {
                this.contract.clear();
                this.contract = null;
            }
        }
    }

    private async executeTrade(quote: NiftyQuote, right: string, pointsChange: number) {
        const config = configService.getStrategyConfig('RateOfChangeStrategy');
        const prism = Prism.getInstance();

        const contract = await prism.getContractByPriceRange(right);
        if (!contract) {
            Log.log('[RoC] No contract found in price range');
            this.contract = null;
            return;
        }

        const token = await prism.getToken(contract);
        Log.log('Token for contract ', contract, ': ', token)

        Log.log(`[RoC] TRIGGERED: ${right} at NIFTY=${quote.ltp} PointsChange=${round(pointsChange)}`);
        Log.log(`[RoC] Buying ${contract} qty=${config.quantity}`);

        this.contract.contract = contract;
        this.contract.token = token;
        this.contract.right = right;
        this.contract.buyOrderPlaced = true;
        this.recordTriggerTime();

        await this.buyContract(contract, config.quantity);
    }

    private calculatePointsChange(numberOfDatapoints: number): number {
        const recentQuotes = Monitor.getInstance().getRecentNiftyQuotes(numberOfDatapoints);
        if (recentQuotes.length < numberOfDatapoints) return 0;
        return recentQuotes[0].ltp - recentQuotes[recentQuotes.length - 1].ltp;
    }

    private calculateAcceleration(N: number): number {
        const quotes = Monitor.getInstance().getRecentNiftyQuotes(2 * N);
        if (quotes.length < 2 * N) return 0;
        const velocityCurrent  = quotes[0].ltp     - quotes[N - 1].ltp;
        const velocityPrevious = quotes[N].ltp     - quotes[2 * N - 1].ltp;
        return velocityCurrent - velocityPrevious;
    }
}
