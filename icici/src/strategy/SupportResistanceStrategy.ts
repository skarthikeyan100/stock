import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';

// Trades NIFTY options on Zerodha when the index crosses a configured support
// or resistance level: crossing support buys a PUT, crossing resistance buys
// a CALL. Either side can fire any number of times over the day - CE and PE
// positions run independently and may be open in parallel - but only one
// position of a given option type (CE or PE) may be open at a time, checked
// by the order process against live Zerodha positions (not an in-memory latch)
// so it's correct across restarts and regardless of which strike a prior entry
// used. Order execution + GTT placement happen in the order process - no
// direct Zerodha dependency here.
export default class SupportResistanceStrategy extends Strategy {
    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('SupportResistanceStrategy').enabled;
    }

    receive(oldStats: any, newStats: any) {}
    async processOptionQuote(quote: OptionQuote) {}
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    updateTrade = async (trade: Trade): Promise<void> => {};

    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled || !quote?.ltp) return;

        const ltp = quote.ltp;
        const config = configService.getStrategyConfig('SupportResistanceStrategy');

        if (ltp < config.supportPrice) {
            Log.log(`[SupportResistance] Support crossed: NIFTY=${ltp} support=${config.supportPrice} - buying PUT`);
            await this.executeTrade(PUT, ltp, config);
        }

        if (ltp > config.resistancePrice) {
            Log.log(`[SupportResistance] Resistance crossed: NIFTY=${ltp} resistance=${config.resistancePrice} - buying CALL`);
            await this.executeTrade(CALL, ltp, config);
        }
    }

    private async executeTrade(direction: string, niftyLtp: number, config: any) {
        const optionType = direction === CALL ? 'CE' : 'PE';
        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                niftyLtp,
                right: direction,
                quantity: config.quantity,
                targetPoints: config.targetPoints,
                stopLossPoints: config.stopLossPoints,
                skipIfOpenPositionType: optionType,
            });
            if (config.logEnabled) {
                Log.log(`[SupportResistance] Bought ${trade.tsym} qty=${config.quantity} at ${trade.price} (GTT placed by order process)`);
            }
        } catch (e) {
            Log.log('[SupportResistance] executeTrade failed:', e);
        }
    }
}
