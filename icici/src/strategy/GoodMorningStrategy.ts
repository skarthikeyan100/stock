import Log from '../util/Log';
import moment from 'moment';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import Mongo from '../tools/mongo';
import Zerodha from '../zerodha/Zerodha';
import ZerodhaContractMaster from '../zerodha/ZerodhaContractMaster';
import { CALL, PUT } from '../constants';

const INDEX_TOKEN = '26000'; // NIFTY index, same token AntStream/AntContractMaster use
const round = (num: number) => Math.round(num * 100) / 100;

// Trades NIFTY options on Zerodha based on whether the opening move (9:15 vs
// previous day's close) is still intact at 9:20. Broker-agnostic: fed via the
// standard Strategy.processNiftyQuote hook like every other strategy, broadcast
// by Monitor.onNiftyQuote/Decision.decidePurchase (currently sourced from ANT's
// live feed - see AntStream.broadcastQuote). Position tracking/target/SL still
// bypasses Monitor (that machinery drives Prism square-offs, not Zerodha) - the
// target+stop-loss here is a two-leg GTT placed directly with Zerodha right
// after entry fills.
export default class GoodMorningStrategy extends Strategy {
    private tradingDay: string | null = null;
    private prevClose: number | null = null;
    private snapshotDirection: string | null = null; // CALL | PUT
    private snapshotTaken = false;
    private traded = false;

    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('GoodMorningStrategy').enabled;
    }

    receive(oldStats: any, newStats: any) {}
    async processOptionQuote(quote: OptionQuote) {}
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    updateTrade = async (trade: Trade): Promise<void> => {};

    private resetIfNewDay(now: moment.Moment) {
        const today = now.format('YYYY-MM-DD');
        if (this.tradingDay !== today) {
            this.tradingDay = today;
            this.prevClose = null;
            this.snapshotDirection = null;
            this.snapshotTaken = false;
            this.traded = false;
        }
    }

    async processNiftyQuote(quote: NiftyQuote) {
        if (!this.enabled || !quote?.ltp) return;

        const now = moment();
        this.resetIfNewDay(now);

        if (this.traded) return;

        const ltp = quote.ltp;
        const config = configService.getStrategyConfig('GoodMorningStrategy');
        const [snapH, snapM] = (config.snapshotTime || '09:15').split(':').map(Number);
        const [confH, confM] = (config.confirmTime || '09:20').split(':').map(Number);
        const snapshotTime = moment().hour(snapH).minute(snapM).second(0);
        const confirmTime = moment().hour(confH).minute(confM).second(0);

        if (!this.snapshotTaken && now.isSameOrAfter(snapshotTime)) {
            this.prevClose = config.previousClose ?? await this.getPreviousClose(snapshotTime.unix());
            if (this.prevClose == null) {
                Log.log('[GoodMorning] No previous-day close found in Mongo yet - skipping today');
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }
            this.snapshotDirection = ltp > this.prevClose ? CALL : PUT;
            this.snapshotTaken = true;
            Log.log(`[GoodMorning] ${config.snapshotTime || '9:15'} snapshot: NIFTY=${ltp} prevClose=${this.prevClose} direction=${this.snapshotDirection}`);
            return;
        }

        if (this.snapshotTaken && now.isSameOrAfter(confirmTime)) {
            this.traded = true; // fires at most once per day either way

            const currentDirection = ltp > this.prevClose! ? CALL : PUT;
            if (currentDirection !== this.snapshotDirection) {
                Log.log(`[GoodMorning] ${config.confirmTime || '9:20'} trend did not continue (was ${this.snapshotDirection}, now ${currentDirection}) - skipping`);
                return;
            }

            Log.log(`[GoodMorning] ${config.confirmTime || '9:20'} trend confirmed: ${this.snapshotDirection} - executing trade`);
            await this.executeTrade(this.snapshotDirection!, ltp, config);
        }
    }

    // Last persisted NIFTY index tick from before today's 9:15 session start -
    // ANT ticks never populate NiftyQuote.prevClose (see model.ts fromAnt), so this
    // is derived from AntStream's own Mongo persistence instead of a broker field.
    private async getPreviousClose(sessionStartEpochSeconds: number): Promise<number | null> {
        const db = Mongo.getInstance()?.db;
        if (!db) return null;

        const docs = await db
            .collection('NiftyQuote')
            .find({ token: INDEX_TOKEN })
            .sort({ ltt: -1 })
            .limit(5000)
            .toArray();

        let best: { ltp: number; ltt: number } | null = null;
        for (const d of docs) {
            const ltt = Number(d.ltt);
            const ltp = parseFloat(d.ltp);
            if (isNaN(ltt) || isNaN(ltp) || ltt >= sessionStartEpochSeconds) continue;
            if (!best || ltt > best.ltt) best = { ltp, ltt };
        }
        return best ? best.ltp : null;
    }

    private async executeTrade(direction: string, niftyLtp: number, config: any) {
        const zerodha = Zerodha.getInstance();

        if (!(await zerodha.hasValidSession())) {
            Log.log('[GoodMorning] Zerodha session not active - complete /kite/login first. Skipping trade.');
            return;
        }

        try {
            const optionType = direction === CALL ? 'CE' : 'PE';
            const contract = await ZerodhaContractMaster.getInstance().findATMOption(niftyLtp, optionType);

            Log.log(`[GoodMorning] Buying ${contract.tradingSymbol} qty=${config.quantity}`);
            const { orderId } = await zerodha.buyOption(contract.tradingSymbol, config.quantity);

            const entryPrice = await zerodha.getFillPrice(orderId);
            Log.log(`[GoodMorning] Filled ${contract.tradingSymbol} at ${entryPrice}`);

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
                    `[GoodMorning] GTT placed (id=${triggerId}) target=${round(entryPrice + config.targetPoints)} stopLoss=${round(
                        entryPrice - config.stopLossPoints
                    )}`
                );
            }
        } catch (e) {
            Log.log('[GoodMorning] executeTrade failed:', e);
        }
    }
}
