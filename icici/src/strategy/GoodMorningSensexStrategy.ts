import Log from '../util/Log';
import moment from 'moment';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, SensexQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';

const round = (num: number) => Math.round(num * 100) / 100;
const roundPrice = (num: number) => Math.round(num);

// Snapshot/confirm are in-memory, per-day state - a process (re)start after either
// time has already passed would otherwise see the first tick satisfy both
// isSameOrAfter checks at once, using the current (stale) price as if it were the
// 9:15/9:20 price and firing a trade instantly. Only act within this grace window
// of the configured time; a later (re)start skips the trade for the rest of the day.
const LATE_WINDOW_MINUTES = 2;

// If the trend hasn't held by confirm time, push both snapshot and confirm
// times out by this much and try again, instead of giving up for the day.
const RETRY_MINUTES = 30;

// Retries stop once the (possibly already-retried) confirm time would pass
// this cap - no new entries this late in the day.
const MAX_CONFIRM_HOUR = 14;
const MAX_CONFIRM_MINUTE = 45;

// SENSEX sibling of GoodMorningStrategy - same opening-move-still-intact logic,
// but driven off SensexQuote ticks (Strategy.processSensexQuote) instead of
// NiftyQuote, and trading SENSEX options on Zerodha's BFO segment instead of
// NFO. Kept as an independent config block/instance (not an index toggle on
// GoodMorningStrategy) because ConfigService.getStrategyConfig(type) and the
// admin UI's configToFlat()/flatToConfig() both key on a single config block
// per strategy `type` - two concurrently-active configs need two distinct
// types. Also lets SENSEX have its own quantity (20-share lot vs NIFTY's 65)
// and target/stopLoss/minMovement scale (SENSEX trades ~3x NIFTY's level).
// Position tracking/target/SL bypasses Monitor, same as GoodMorningStrategy -
// the target+stop-loss here is a two-leg GTT placed directly with Zerodha
// right after entry fills.
export default class GoodMorningSensexStrategy extends Strategy {
    private tradingDay: string | null = null;
    private prevClose: number | null = null;
    private snapshotDirection: string | null = null; // CALL | PUT
    private snapshotLtp: number | null = null;
    private snapshotTaken = false;
    private traded = false;

    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('GoodMorningSensexStrategy').enabled;
    }

    receive(oldStats: any, newStats: any) {}
    async processNiftyQuote(quote: NiftyQuote) {}
    async processOptionQuote(quote: OptionQuote) {}
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false;
    }

    updateTrade = async (trade: Trade): Promise<void> => {};

    reset(): void {
        super.reset();
        this.prevClose = null;
        this.snapshotDirection = null;
        this.snapshotLtp = null;
        this.snapshotTaken = false;
        this.traded = false;
    }

    private resetIfNewDay(now: moment.Moment) {
        const today = now.format('YYYY-MM-DD');
        if (this.tradingDay !== today) {
            this.tradingDay = today;
            this.prevClose = null;
            this.snapshotDirection = null;
            this.snapshotLtp = null;
            this.snapshotTaken = false;
            this.traded = false;
        }
    }

    // Pushes snapshot/confirm times out by RETRY_MINUTES so the trend can be
    // re-checked later in the morning, unless doing so would push confirm
    // time past the MAX_CONFIRM_HOUR:MAX_CONFIRM_MINUTE cap, in which case
    // the day is given up on instead. Persisted to config.yml (rather than
    // kept as in-memory state) so it survives a process restart and is
    // visible in the admin config screen. The failed confirm-time price
    // becomes the new previousClose baseline - it's now the snapshot time
    // for the next attempt (30 minutes earlier than the new snapshot time).
    private retryOrGiveUp(config: any, snapshotTime: moment.Moment, confirmTime: moment.Moment, confirmLtp: number) {
        const nextConfirmTime = confirmTime.clone().add(RETRY_MINUTES, 'minutes');
        const maxConfirmTime = moment().hour(MAX_CONFIRM_HOUR).minute(MAX_CONFIRM_MINUTE).second(0);

        if (nextConfirmTime.isAfter(maxConfirmTime)) {
            this.traded = true; // don't keep retrying for the rest of the day
            Log.log(
                `[GoodMorningSensex] Next confirm time ${nextConfirmTime.format('HH:mm')} would be past cap ${maxConfirmTime.format(
                    'HH:mm'
                )} - skipping for the rest of the day`
            );
            return;
        }

        const nextSnapshotTime = snapshotTime.clone().add(RETRY_MINUTES, 'minutes');
        config.snapshotTime = nextSnapshotTime.format('HH:mm');
        config.confirmTime = nextConfirmTime.format('HH:mm');
        config.previousClose = round(confirmLtp);
        configService.writeConfig(configService.getConfig());

        this.snapshotTaken = false; // retake the snapshot at the new time
        this.snapshotDirection = null;
        this.snapshotLtp = null;
        Log.log(
            `[GoodMorningSensex] No trade - retrying with snapshot=${config.snapshotTime} confirm=${config.confirmTime} previousClose=${config.previousClose}`
        );
    }

    private computeDirection(ltp: number, base: number, minMovement: number): string | null {
        const diff = ltp - base;
        if (Math.abs(diff) < minMovement) return null;
        return diff > 0 ? CALL : PUT;
    }

    async processSensexQuote(quote: SensexQuote) {
        if (!this.enabled || !quote?.ltp) return;

        const now = moment();
        this.resetIfNewDay(now);

        if (this.traded) return;

        const ltp = quote.ltp;
        const config = configService.getStrategyConfig('GoodMorningSensexStrategy');
        const [snapH, snapM] = (config.snapshotTime || '09:15').split(':').map(Number);
        const [confH, confM] = (config.confirmTime || '09:20').split(':').map(Number);
        const snapshotTime = moment().hour(snapH).minute(snapM).second(0);
        const confirmTime = moment().hour(confH).minute(confM).second(0);

        if (!this.snapshotTaken && now.isSameOrAfter(snapshotTime)) {
            if (now.diff(snapshotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[GoodMorningSensex] Missed ${config.snapshotTime || '9:15'} snapshot window (now ${now.format('HH:mm:ss')}) - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            this.prevClose = config.previousClose ?? null;
            if (this.prevClose == null) {
                Log.log('[GoodMorningSensex] config.previousClose not set - skipping today');
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            const minMovement = config.minMovementPoints ?? 30;
            const direction = this.computeDirection(ltp, this.prevClose, minMovement);
            if (direction == null) {
                Log.log(`[GoodMorningSensex] ${config.snapshotTime || '9:15'} SENSEX=${roundPrice(ltp)} prevClose=${roundPrice(this.prevClose)} diff=${round(ltp - this.prevClose)} below ${minMovement}pt threshold - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            this.snapshotDirection = direction;
            this.snapshotLtp = ltp;
            this.snapshotTaken = true;
            Log.log(`[GoodMorningSensex] ${config.snapshotTime || '9:15'} snapshot: SENSEX=${roundPrice(ltp)} prevClose=${roundPrice(this.prevClose)} direction=${this.snapshotDirection}`);
            return;
        }

        if (this.snapshotTaken && now.isSameOrAfter(confirmTime)) {
            if (now.diff(confirmTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[GoodMorningSensex] Missed ${config.confirmTime || '9:20'} confirm window (now ${now.format('HH:mm:ss')}) - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            const minMovement = config.minMovementPoints ?? 30;
            const currentDirection = this.computeDirection(ltp, this.snapshotLtp!, minMovement);
            if (currentDirection == null || currentDirection !== this.snapshotDirection) {
                Log.log(`[GoodMorningSensex] ${config.confirmTime || '9:20'} snapshotPrice=${roundPrice(this.snapshotLtp!)} confirmPrice=${roundPrice(ltp)} diff=${round(ltp - this.snapshotLtp!)} insufficient or reversed (was ${this.snapshotDirection}, now ${currentDirection})`);
                this.retryOrGiveUp(config, snapshotTime, confirmTime, ltp);
                return;
            }

            this.traded = true; // fires at most once per day either way
            Log.log(`[GoodMorningSensex] ${config.confirmTime || '9:20'} snapshotPrice=${roundPrice(this.snapshotLtp!)} confirmPrice=${roundPrice(ltp)} diff=${round(ltp - this.snapshotLtp!)} trend confirmed: ${this.snapshotDirection} - executing trade`);
            await this.executeTrade(this.snapshotDirection!, ltp, config);
        }
    }

    private async executeTrade(direction: string, sensexLtp: number, config: any) {
        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                index: 'SENSEX',
                niftyLtp: sensexLtp,
                right: direction,
                quantity: config.quantity,
                targetPoints: config.targetPoints,
                stopLossPoints: config.stopLossPoints,
            });
            if (config.logEnabled) {
                Log.log(`[GoodMorningSensex] Bought ${trade.tsym} qty=${config.quantity} at ${trade.price} (GTT placed by order process)`);
            }
        } catch (e) {
            Log.log('[GoodMorningSensex] executeTrade failed:', e);
        }
    }
}
