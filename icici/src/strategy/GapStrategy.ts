import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import Prism from '../prism';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';
import Monitor from '../monitor';
import moment from 'moment';

const round = (num: number) => Math.round(num * 100) / 100;

class GapContract {
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

    async processOptionQuote(quote: OptionQuote, strategy: GapStrategy): Promise<boolean> {
        if (this.price === 0 || this.token !== quote.token) {
            return false;
        }

        const config = configService.getStrategyConfig('GapStrategy');
        this.ltp = quote.ltp;

        const pointsGain = quote.ltp - this.price;
        const profit = pointsGain * this.quantity;
        const timeElapsed = Date.now() - this.entryTime;

        if (config.logEnabled) {
            Log.log(`[Gap] ${this.contract} points=${round(pointsGain)} P&L=${round(profit)}`);
        }

        // Monitor handles target/SL exits; strategy only handles timeout
        const timeout = config.maxHoldTimeMinutes > 0 && timeElapsed >= config.maxHoldTimeMinutes * 60 * 1000;

        if (timeout && !this.sellOrderPlaced) {
            Log.log(`[Gap] Selling ${this.contract}: TIMEOUT P&L=${round(profit)}`);
            this.sellOrderPlaced = true;
            strategy.recordOutcome('timeout', profit);
            await strategy.sellContract(this.contract, this.quantity, quote.ltp);
        }

        return false;
    }

    async updateTrade(trade: Trade, strategy: GapStrategy): Promise<boolean> {
        if (trade.tsym !== this.contract) {
            return false;
        }

        const config = configService.getStrategyConfig('GapStrategy');

        if (this.buyOrderPlaced && trade.action === 'Buy') {
            this.buyOrderPlaced = false;
            this.price = trade.price;
            this.quantity = trade.quantity;
            this.entryTime = Date.now();
            if (config.logEnabled) {
                Log.log(`[Gap] Buy confirmed: ${this.contract} qty=${this.quantity} price=${this.price}`);
            }
            return false;
        }

        if (trade.action === 'Sell') {
            if (this.sellOrderPlaced) {
                // Strategy-triggered sell (timeout): recordOutcome already called in processOptionQuote
                this.sellOrderPlaced = false;
                if (config.logEnabled) {
                    Log.log(`[Gap] Sell confirmed (timeout): ${this.contract}`);
                }
            } else {
                // Monitor-triggered sell (target/SL): record outcome now
                const profit = (trade.price - this.price) * this.quantity;
                strategy.recordOutcome(profit >= 0 ? 'win' : 'loss', profit);
                if (config.logEnabled) {
                    Log.log(`[Gap] Sell confirmed (monitor): ${this.contract} P&L=${round(profit)}`);
                }
            }
            return true;
        }

        return false;
    }
}

export default class GapStrategy extends Strategy {
    private contract: GapContract | null = null;

    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('GapStrategy').enabled;
    }

    receive(oldStats: any, newStats: any) {}

    getMonitorConfig() {
        const config = configService.getStrategyConfig('GapStrategy');
        return { targetPoints: config.targetPrice, stopLossPoints: config.stopLossPrice, trailingDistance: configService.getConfig().settings.trailingDistance };
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.contract !== null && this.contract.token === quote.token;
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const config = configService.getStrategyConfig('GapStrategy');

        if (!this.enabled || !this.isTimeInRange()) return;

        // Only active during the opening gap window (9:10–9:25)
        if (!this.isGapWindow()) return;

        if (this.contract !== null) return;

        if (!this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) return;

        const pointsChange = this.calculatePointsChange(config.numberOfDatapointsReceived);

        if (config.logEnabled) {
            Log.log(`[Gap] NIFTY=${quote.ltp} PointsChange=${round(pointsChange)} Threshold=±${config.pointsThreshold}`);
        }

        let direction: string | null = null;

        if (config.gapReversalMode) {
            // Fade small gaps, follow large gaps
            const gapPoints = Math.abs(quote.ltp - quote.prevClose);
            const isGapUp = quote.ltp > quote.prevClose;
            const isGapDown = quote.ltp < quote.prevClose;

            if (Math.abs(pointsChange) >= config.pointsThreshold) {
                if (isGapUp) direction = gapPoints > config.gapReversalThreshold ? CALL : PUT;
                else if (isGapDown) direction = gapPoints > config.gapReversalThreshold ? PUT : CALL;
            }
        } else {
            // Standard momentum in gap window
            if (pointsChange >= config.pointsThreshold) direction = CALL;
            else if (pointsChange <= -config.pointsThreshold) direction = PUT;
        }

        if (direction) {
            if (!this.isSentimentAligned(quote, direction)) {
                Log.log('[Gap] Sentiment not aligned for', direction, '— skipping');
                return;
            }
            this.contract = new GapContract();
            await this.executeTrade(quote, direction, pointsChange);
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
        const config = configService.getStrategyConfig('GapStrategy');
        const prism = Prism.getInstance();

        const contract = await prism.getContractByPriceRange(right);
        if (!contract) {
            Log.log('[Gap] No contract found in price range');
            this.contract = null;
            return;
        }

        const token = await prism.getToken(contract);

        Log.log(`[Gap] TRIGGERED: ${right} at NIFTY=${quote.ltp} PointsChange=${round(pointsChange)}`);
        Log.log(`[Gap] Buying ${contract} qty=${config.quantity}`);

        this.contract.contract = contract;
        this.contract.token = token;
        this.contract.right = right;
        this.contract.buyOrderPlaced = true;
        this.recordTriggerTime();

        await this.buyContract(contract, config.quantity);
    }

    private calculatePointsChange(numberOfDatapoints: number): number {
        const recentQuotes = Monitor.getInstance().getRecentNiftyQuotes(numberOfDatapoints);
        if (recentQuotes.length < 2) return 0;
        return recentQuotes[0].ltp - recentQuotes[recentQuotes.length - 1].ltp;
    }

    private isGapWindow(): boolean {
        const now = moment();
        return now.isAfter(moment().hour(9).minute(10)) &&
               now.isBefore(moment().hour(9).minute(25));
    }
}
