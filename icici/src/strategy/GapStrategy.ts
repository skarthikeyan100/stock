import Log from '../util/Log';
import { NiftyQuote, OptionQuote, Trade } from "../model/model";
import { Strategy } from "./strategy";
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';
import configService from '../prism/ConfigService';
import moment from 'moment';

const round = (num: number) => Math.round(num * 100) / 100;

class GapContract {
    contract: string = '';
    token: string = '';
    price: number = 0;
    quantity: number = 0;
    right: string = '';
    entryTime: number = 0;
    sellOrderPlaced: boolean = false;
    ltp: number = 0;

    clear() {
        this.contract = '';
        this.token = '';
        this.price = 0;
        this.quantity = 0;
        this.right = '';
        this.entryTime = 0;
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

        // Broker (GTT/exitMonitor) handles target/SL exits; strategy only handles timeout
        const timeout = config.maxHoldTimeMinutes > 0 && timeElapsed >= config.maxHoldTimeMinutes * 60 * 1000;

        if (timeout && !this.sellOrderPlaced) {
            Log.log(`[Gap] Selling ${this.contract}: TIMEOUT P&L=${round(profit)}`);
            this.sellOrderPlaced = true;
            strategy.recordOutcome('timeout', profit);
            await OrderClient.getInstance().squareOff(strategy.userId, { tsym: this.contract, quantity: this.quantity, exchange: 'NFO' });
        }

        return false;
    }

    async updateTrade(trade: Trade, strategy: GapStrategy): Promise<boolean> {
        if (trade.tsym !== this.contract) {
            return false;
        }

        const config = configService.getStrategyConfig('GapStrategy');

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

    // Only active during the opening gap window (9:10-9:25) - the window is a
    // grace period around the 9:15 open in case the first tick is delayed, not
    // an invitation to trade at 9:20/9:24 under different conditions; the
    // contract !== null gate below already limits this to one trade per day.
    isTimeInRange(): boolean {
        const now = moment();
        return now.isAfter(moment().hour(9).minute(10)) && now.isBefore(moment().hour(9).minute(25));
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.contract !== null && this.contract.token === quote.token;
    }

    reset(): void {
        super.reset();
        this.contract = null;
    }

    async processNiftyQuote(quote: NiftyQuote) {
        const config = configService.getStrategyConfig('GapStrategy');

        if (!this.enabled || !this.isTimeInRange()) return;

        if (this.contract !== null) return;

        if (!this.isCooldownElapsed(configService.getConfig().settings.cooldownSeconds)) return;

        // Single-point read against the broker's own live prevClose - no
        // rolling window. This is the strategy's one decision for the day:
        // deregister (this.enabled = false) once made, whatever the outcome.
        const gapPoints = quote.ltp - quote.prevClose;

        if (config.logEnabled) {
            Log.log(`[Gap] NIFTY=${quote.ltp} prevClose=${quote.prevClose} Gap=${round(gapPoints)} Threshold=±${config.pointsThreshold}`);
        }

        let direction: string | null = null;

        if (config.gapReversalMode) {
            // Fade small gaps, follow large gaps
            const absGap = Math.abs(gapPoints);
            if (absGap >= config.pointsThreshold) {
                direction = gapPoints > 0
                    ? (absGap > config.gapReversalThreshold ? CALL : PUT)
                    : (absGap > config.gapReversalThreshold ? PUT : CALL);
            }
        } else {
            if (gapPoints >= config.pointsThreshold) direction = CALL;
            else if (gapPoints <= -config.pointsThreshold) direction = PUT;
        }

        this.enabled = false; // deregister - one decision per day, trade or not

        if (direction) {
            if (!this.isSentimentAligned(quote, direction)) {
                Log.log('[Gap] Sentiment not aligned for', direction, '— skipping');
                return;
            }
            this.contract = new GapContract();
            await this.executeTrade(quote, direction, gapPoints);
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

    private async executeTrade(quote: NiftyQuote, right: string, gapPoints: number) {
        const config = configService.getStrategyConfig('GapStrategy');

        Log.log(`[Gap] TRIGGERED: ${right} at NIFTY=${quote.ltp} Gap=${round(gapPoints)}`);
        this.recordTriggerTime();

        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                niftyLtp: quote.ltp,
                right,
                quantity: config.quantity,
                targetPoints: config.targetPrice,
                stopLossPoints: config.stopLossPrice,
            });
            this.contract!.contract = trade.tsym;
            this.contract!.token = trade.token;
            this.contract!.right = right;
            this.contract!.price = trade.price;
            this.contract!.quantity = trade.quantity;
            this.contract!.entryTime = Date.now();
            if (config.logEnabled) {
                Log.log(`[Gap] Bought ${trade.tsym} qty=${trade.quantity} at ${trade.price}`);
            }
        } catch (e) {
            Log.log('[Gap] executeTrade failed:', e);
            this.contract = null;
        }
    }
}
