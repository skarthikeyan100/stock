import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import Zerodha from '../zerodha/Zerodha';
import ZerodhaContractMaster from '../zerodha/ZerodhaContractMaster';
import AntContractMaster from '../ant/AntContractMaster';
import Monitor from '../monitor';

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
// most once (the server restarts daily, so no reset logic is needed).
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
                Monitor.getInstance().watchToken(this.token, this);
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

    async processOptionQuote(quote: OptionQuote) {
        if (!this.enabled || this.fired || !quote?.ltp) return;

        const config = configService.getStrategyConfig('TargetReachStrategy');
        if (quote.ltp >= config.targetPrice) {
            this.fired = true;
            Monitor.getInstance().unwatchToken(this.token, this);
            Log.log(`[TargetReach] Target reached: ${quote.ltp} >= ${config.targetPrice} - buying`);
            await this.executeTrade(config);
        }
    }

    private async executeTrade(config: any) {
        const zerodha = Zerodha.getInstance();

        if (!(await zerodha.hasValidSession())) {
            Log.log('[TargetReach] Zerodha session not active - complete /kite/login first. Skipping trade.');
            return;
        }

        try {
            const contract = await ZerodhaContractMaster.getInstance().findExactOption(this.strike, this.expiry, this.optionType);

            Log.log(`[TargetReach] Buying ${contract.tradingSymbol} qty=${config.quantity}`);
            const { orderId } = await zerodha.buyOption(contract.tradingSymbol, config.quantity);

            const entryPrice = await zerodha.getFillPrice(orderId);
            Log.log(`[TargetReach] Filled ${contract.tradingSymbol} at ${entryPrice}`);

            const triggerId = await zerodha.placeTargetStopLossGTT(
                contract.tradingSymbol,
                'NFO',
                config.quantity,
                entryPrice,
                config.targetPoints,
                config.stopLossPoints,
                entryPrice
            );

            if (config.logEnabled) {
                Log.log(
                    `[TargetReach] GTT placed (id=${triggerId}) target=${round(entryPrice + config.targetPoints)} stopLoss=${round(
                        entryPrice - config.stopLossPoints
                    )}`
                );
            }
        } catch (e) {
            Log.log('[TargetReach] executeTrade failed:', e);
        }
    }
}
