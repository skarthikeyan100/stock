import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient';
import * as niftyQuoteHistory from '../processes/strategies/niftyQuoteHistory';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';

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
    buyFailedAt = 0; // when buyContract returned null (the outcome is unknown: a timeout may still have placed the order)

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
        this.buyFailedAt = 0;
    }

    async processOptionQuote(quote: OptionQuote, strategy: RateOfChangeStrategy): Promise<boolean> {
        if (this.price === 0 || this.token !== quote.token) {
            return false;
        }

        const config = strategy.getConfig();
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

        const config = strategy.getConfig();

        // A chunked entry books one Buy per chunk: fold chunks that land shortly after the first into the average, so the timeout sell is
        // sized for the whole position, not only the first chunk.
        if (!this.buyOrderPlaced && trade.action === 'Buy' && this.quantity > 0 && Date.now() - this.entryTime < 30_000) {
            const total = this.quantity * this.price + trade.quantity * trade.price;
            this.quantity += trade.quantity;
            this.price = total / this.quantity;
            return false;
        }
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
    // Public so RateOfChangeContract reads this instance's own config block.
    getConfig() { return this.instanceConfig(); }

    constructor(userId?: string) {
        super(userId);
        this.enabled = this.instanceConfig().enabled;
    }

    receive(oldStats: any, newStats: any) {}

    getMonitorConfig() {
        const config = this.instanceConfig();
        return { targetPoints: config.targetPrice, stopLossPoints: config.stopLossPrice, trailingDistance: configService.getConfig().settings.trailingDistance };
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.contract !== null && this.contract.token === quote.token;
    }

    reset(): void {
        super.reset();
        this.contract = null;
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const config = this.instanceConfig();

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
        const config = this.instanceConfig();
        const orderClient = OrderClient.getInstance();

        const contract = await orderClient.getContractByPriceRange(this.userId, right);
        if (!contract) {
            Log.log('[RoC] No contract found in price range');
            this.contract = null;
            return;
        }

        const token = await orderClient.getToken(this.userId, contract);
        Log.log('Token for contract ', contract, ': ', token)
        if (!token) {
            Log.log('[RoC] No token for contract', contract, '- not entering');
            this.contract = null;
            return;
        }

        Log.log(`[RoC] TRIGGERED: ${right} at NIFTY=${quote.ltp} PointsChange=${round(pointsChange)}`);
        Log.log(`[RoC] Buying ${contract} qty=${config.quantity}`);

        this.contract.contract = contract;
        this.contract.token = token;
        this.contract.right = right;
        this.contract.buyOrderPlaced = true;
        this.recordTriggerTime();

        const bought = await this.buyContract(contract, config.quantity);
        if (!bought && this.contract) {
            // buyContract returns null for every failure, including a timeout after which the order may still fill. Re-arming here could
            // buy twice, so the entry sentinel stays: a late fill is still tracked, and the strategy resumes after an admin reset.
            this.contract.buyFailedAt = Date.now();
            Log.log('[RoC] ALERT: entry buy returned no confirmation - strategy paused (the order may still be live); reset the strategy once the account is checked');
        }
    }

    private calculatePointsChange(numberOfDatapoints: number): number {
        const recentQuotes = niftyQuoteHistory.getRecent(numberOfDatapoints);
        if (recentQuotes.length < numberOfDatapoints) return 0;
        return recentQuotes[0].ltp - recentQuotes[recentQuotes.length - 1].ltp;
    }

    private calculateAcceleration(N: number): number {
        const quotes = niftyQuoteHistory.getRecent(2 * N);
        if (quotes.length < 2 * N) return 0;
        const velocityCurrent  = quotes[0].ltp     - quotes[N - 1].ltp;
        const velocityPrevious = quotes[N].ltp     - quotes[2 * N - 1].ltp;
        return velocityCurrent - velocityPrevious;
    }
}
