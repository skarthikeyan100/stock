import Log from '../util/Log';
import moment from 'moment';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
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

// Trades NIFTY options on Zerodha based on whether the opening move (9:15 vs
// previous day's close) is still intact at 9:20. Fed ticks via the standard
// Strategy.processNiftyQuote hook (piped in from the `data` process). Order
// execution goes through OrderClient -> the `order` process, which places the
// entry buy and a two-leg target/stop-loss GTT together (see
// src/processes/order/zerodhaExecutor.ts) - no direct Zerodha dependency here.
export default class GoodMorningStrategy extends Strategy {
    private tradingDay: string | null = null;
    private prevClose: number | null = null;
    private snapshotDirection: string | null = null; // CALL | PUT
    private snapshotLtp: number | null = null;
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

    // Fires when a GTT-based entry closes (target/SL hit, detected by
    // zerodhaExecutor's pollGttFills since GTT itself is fire-and-forget) -
    // opens a fresh same-day window instead of waiting for tomorrow's
    // calendar-date reset (resetIfNewDay).
    updateTrade = async (trade: Trade): Promise<void> => {
        if (!this.traded || trade.action !== 'Sell') return;
        const config = configService.getStrategyConfig('GoodMorningStrategy');
        this.rearmAfterClose(config, trade.price);
    };

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
                `[GoodMorning] Next confirm time ${nextConfirmTime.format('HH:mm')} would be past cap ${maxConfirmTime.format(
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
            `[GoodMorning] No trade - retrying with snapshot=${config.snapshotTime} confirm=${config.confirmTime} previousClose=${config.previousClose}`
        );
    }

    // Same "push the window forward, same day" mechanism as retryOrGiveUp,
    // triggered by a closed trade instead of a failed confirm: previousClose
    // becomes the exit price, and a fresh snapshot/confirm window opens
    // RETRY_MINUTES from now (capped at MAX_CONFIRM_HOUR:MAX_CONFIRM_MINUTE).
    private rearmAfterClose(config: any, exitLtp: number) {
        const now = moment();
        const maxConfirmTime = moment().hour(MAX_CONFIRM_HOUR).minute(MAX_CONFIRM_MINUTE).second(0);
        const nextSnapshotTime = now.clone().add(RETRY_MINUTES, 'minutes');
        const nextConfirmTime = nextSnapshotTime.clone().add(5, 'minutes');

        if (nextConfirmTime.isAfter(maxConfirmTime)) {
            Log.log('[GoodMorning] Trade closed too late in the day to open a new window - done for today');
            return;
        }

        config.snapshotTime = nextSnapshotTime.format('HH:mm');
        config.confirmTime = nextConfirmTime.format('HH:mm');
        config.previousClose = round(exitLtp);
        configService.writeConfig(configService.getConfig());

        this.snapshotTaken = false;
        this.snapshotDirection = null;
        this.snapshotLtp = null;
        this.traded = false;
        Log.log(`[GoodMorning] Trade closed at ${round(exitLtp)} - opening a new window: snapshot=${config.snapshotTime} confirm=${config.confirmTime}`);
    }

    private computeDirection(ltp: number, base: number, minMovement: number): string | null {
        const diff = ltp - base;
        if (Math.abs(diff) < minMovement) return null;
        return diff > 0 ? CALL : PUT;
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
            if (now.diff(snapshotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[GoodMorning] Missed ${config.snapshotTime || '9:15'} snapshot window (now ${now.format('HH:mm:ss')}) - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            this.prevClose = config.previousClose ?? null;
            if (this.prevClose == null) {
                Log.log('[GoodMorning] config.previousClose not set - skipping today');
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            const minMovement = config.minMovementPoints ?? 10;
            const direction = this.computeDirection(ltp, this.prevClose, minMovement);
            if (direction == null) {
                Log.log(`[GoodMorning] ${config.snapshotTime || '9:15'} NIFTY=${roundPrice(ltp)} prevClose=${roundPrice(this.prevClose)} diff=${round(ltp - this.prevClose)} below ${minMovement}pt threshold - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            this.snapshotDirection = direction;
            this.snapshotLtp = ltp;
            this.snapshotTaken = true;
            Log.log(`[GoodMorning] ${config.snapshotTime || '9:15'} snapshot: NIFTY=${roundPrice(ltp)} prevClose=${roundPrice(this.prevClose)} direction=${this.snapshotDirection}`);
            return;
        }

        if (this.snapshotTaken && now.isSameOrAfter(confirmTime)) {
            if (now.diff(confirmTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[GoodMorning] Missed ${config.confirmTime || '9:20'} confirm window (now ${now.format('HH:mm:ss')}) - skipping today`);
                this.traded = true; // don't keep retrying for the rest of the day
                return;
            }

            const minMovement = config.minMovementPoints ?? 10;
            const currentDirection = this.computeDirection(ltp, this.snapshotLtp!, minMovement);
            if (currentDirection == null || currentDirection !== this.snapshotDirection) {
                Log.log(`[GoodMorning] ${config.confirmTime || '9:20'} snapshotPrice=${roundPrice(this.snapshotLtp!)} confirmPrice=${roundPrice(ltp)} diff=${round(ltp - this.snapshotLtp!)} insufficient or reversed (was ${this.snapshotDirection}, now ${currentDirection})`);
                this.retryOrGiveUp(config, snapshotTime, confirmTime, ltp);
                return;
            }

            this.traded = true; // fires at most once per day either way
            Log.log(`[GoodMorning] ${config.confirmTime || '9:20'} snapshotPrice=${roundPrice(this.snapshotLtp!)} confirmPrice=${roundPrice(ltp)} diff=${round(ltp - this.snapshotLtp!)} trend confirmed: ${this.snapshotDirection} - executing trade`);
            await this.executeTrade(this.snapshotDirection!, ltp, config);
        }
    }

    private async executeTrade(direction: string, niftyLtp: number, config: any) {
        try {
            const trade = await OrderClient.getInstance().buyIndex(this.userId, {
                niftyLtp,
                right: direction,
                quantity: config.quantity,
                targetPoints: config.targetPoints,
                stopLossPoints: config.stopLossPoints,
            });

            if (config.logEnabled) {
                Log.log(`[GoodMorning] Bought ${trade.tsym} qty=${config.quantity} at ${trade.price} (GTT placed by order process)`);
            }
        } catch (e) {
            Log.log('[GoodMorning] executeTrade failed:', e);
        }
    }
}
