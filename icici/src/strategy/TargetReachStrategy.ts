import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { watchToken, unwatchToken } from '../processes/strategies/tokenRouter';
import { CALL, PUT } from '../constants';

const round = (num: number) => Math.round(num * 100) / 100;

// Watches a single option contract specified in config (symbol+strike+expiry+
// optionType) and buys it once its own LTP reaches a configured target price -
// unlike other strategies, which react to NIFTY moves and pick a contract
// afterwards, this one is told exactly which contract to watch up front.
// Resolves the contract to an ANT token at construction time (via
// AntContractMaster, synchronous/local) and registers as a Monitor "watcher"
// for that token (see Monitor.watchToken) so it receives live ticks before it
// holds any position - normal quote routing only fires for tokens with an
// open trade. Reuses GoodMorningStrategy's Zerodha entry+GTT exit; fires at
// most once per arming, until reset() re-arms the watch (see GET /strategies/:type/reset).
export default class TargetReachStrategy extends Strategy {
    private fired = false;
    private symbol: string;
    private strike: number;
    private expiry: string;
    private optionType: 'CE' | 'PE';

    constructor(userId?: string) {
        super(userId);
        const config = configService.getStrategyConfig('TargetReachStrategy');
        this.enabled = config.enabled;
        this.symbol = config.symbol || 'NIFTY';
        this.strike = config.strike;
        this.expiry = config.expiry;
        this.optionType = config.optionType;

        if (this.enabled && this.strike && this.expiry && this.optionType) {
            try {
                const contract = AntContractMaster.getInstance().findOption({
                    symbol: this.symbol,
                    exch: 'NFO',
                    strike: String(this.strike),
                    optionType: this.optionType,
                    expiryEpochMs: new Date(this.expiry).getTime(),
                });
                this.token = contract.token;
                watchToken(this.token, this);
                Log.log(`[TargetReach] Watching ${this.symbol} ${this.strike} ${this.optionType} exp ${this.expiry} token=${this.token}`);
            } catch (e) {
                Log.log('[TargetReach] Failed to resolve contract - disabling:', e);
                this.enabled = false;
            }
        }
    }

    receive(oldStats: any, newStats: any) {}
    async processNiftyQuote(quote: NiftyQuote) {}
    updateTrade = async (trade: Trade): Promise<void> => {};

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return !this.fired && quote.token === this.token;
    }

    reset(): void {
        super.reset();
        if (this.fired && this.token) {
            watchToken(this.token, this); // re-arm the watch that fired() unregistered
        }
        this.fired = false;
    }

    async processOptionQuote(quote: OptionQuote) {
        if (!this.enabled || this.fired || !quote?.ltp) return;

        const config = configService.getStrategyConfig('TargetReachStrategy');
        if (quote.ltp >= config.targetPrice) {
            this.fired = true;
            unwatchToken(this.token, this);
            Log.log(`[TargetReach] Target reached: ${quote.ltp} >= ${config.targetPrice} - buying`);
            await this.executeTrade(config);
        }
    }

    private async executeTrade(config: any) {
        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                niftyLtp: 0, // unused when strike/expiry are set (exact-contract path)
                right: this.optionType === 'CE' ? CALL : PUT,
                quantity: config.quantity,
                targetPoints: config.targetPoints,
                stopLossPoints: config.stopLossPoints,
                strike: this.strike,
                expiry: this.expiry,
            });
            if (config.logEnabled) {
                Log.log(`[TargetReach] Bought ${trade.tsym} qty=${config.quantity} at ${trade.price} (GTT placed by order process)`);
            }
        } catch (e) {
            Log.log('[TargetReach] executeTrade failed:', e);
        }
    }
}
