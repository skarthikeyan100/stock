import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import Zerodha from '../zerodha/Zerodha';
import ZerodhaContractMaster from '../zerodha/ZerodhaContractMaster';
import { CALL, PUT } from '../constants';

const round = (num: number) => Math.round(num * 100) / 100;

// Trades NIFTY options on Zerodha when the index crosses a configured support
// or resistance level: crossing support buys a PUT, crossing resistance buys
// a CALL. Either side can fire any number of times over the day - CE and PE
// positions run independently and may be open in parallel - but only one
// position of a given option type (CE or PE) may be open at a time, checked
// against live Zerodha positions (not an in-memory latch) so it's correct
// across restarts and regardless of which strike a prior entry used. Reuses
// GoodMorningStrategy's entry+exit mechanism: a Zerodha ATM option buy
// followed by a two-leg GTT (target/stop-loss) placed directly with the
// broker - position tracking bypasses Monitor.
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
        const zerodha = Zerodha.getInstance();

        if (!(await zerodha.hasValidSession())) {
            Log.log('[SupportResistance] Zerodha session not active - complete /kite/login first. Skipping trade.');
            return;
        }

        const optionType = direction === CALL ? 'CE' : 'PE';
        const positions = await zerodha.getPositions();
        const hasOpenPosition = (positions?.net || []).some(
            (p: any) => p.quantity !== 0 && p.exchange === 'NFO' && p.tradingsymbol?.endsWith(optionType)
        );
        if (hasOpenPosition) {
            Log.log(`[SupportResistance] Skipping ${direction} - a ${optionType} position is already open`);
            return;
        }

        try {
            const contract = await ZerodhaContractMaster.getInstance().findATMOption(niftyLtp, optionType);

            Log.log(`[SupportResistance] Buying ${contract.tradingSymbol} qty=${config.quantity}`);
            const { orderId } = await zerodha.buyOption(contract.tradingSymbol, config.quantity);

            const entryPrice = await zerodha.getFillPrice(orderId);
            Log.log(`[SupportResistance] Filled ${contract.tradingSymbol} at ${entryPrice}`);

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
                    `[SupportResistance] GTT placed (id=${triggerId}) target=${round(entryPrice + config.targetPoints)} stopLoss=${round(
                        entryPrice - config.stopLossPoints
                    )}`
                );
            }
        } catch (e) {
            Log.log('[SupportResistance] executeTrade failed:', e);
        }
    }
}
