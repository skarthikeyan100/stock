import moment from 'moment';
import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';

// At each configured HH:mm slot, buys the option in the direction of Nifty's move since the previous slot (Nifty LTP at this slot minus
// its LTP at the previous slot today, from the live tick; the first slot of the day compares with the previous day's close): up -> CE,
// down -> PE, flat -> nothing. The LTP seen at each slot is kept in memory as the reference for the next one. The order is a LIMIT buy at (the option's LTP - limitOffset) on every
// configured broker, sized from maxInvestment (split evenly across the brokers). When it fills, a resting limit sell goes in at
// (fill price + targetPoints). No stop loss: an unfilled entry is cancelled after entryTimeoutMinutes, and a position still held at
// eodCloseTime is closed at market.
//
// Slot rules are BulkPcrAutoStartStrategy's: each slot fires at most once a day (persisted), a slot earlier than this process's start
// is never fired (a restart must not buy "the slot a minute ago"), and a slot more than 5 minutes old is missed. A slot is also
// skipped while the previous slot's position is still open (isRunning(), like BulkPcrAutoStartStrategy's check of BulkPcrStrategy) -
// one trade at a time; that slot is consumed, not retried later.
//
// The previous-slot price is in memory only. If it is missing for a slot that has an earlier slot today (the process started after
// that slot, the earlier slot was missed, or no tick came), that slot is skipped with an ALERT instead of falling back to the previous
// close - the previous close is only the reference for the day's first slot.
//
// Config (config.yml):
//   times: ['10:40', '11:40', '12:30', '13:40', '14:30']
//   maxInvestment: 100000
//   limitOffset: 3          - entry limit = option LTP - limitOffset
//   targetPoints: 5
//   entryTimeoutMinutes: 5  - cancel an unfilled entry after this long
//   eodCloseTime: '15:10'
//   brokers: [kite]
const LATE_WINDOW_MINUTES = 5;

export default class NiftyChangeStrategy extends LimitEntryStrategy {
    // When this process came up (a static so a test can move it); see the header comment for why slots before it are never fired.
    static processStartedAt = moment();
    protected readonly logTag = `NiftyChange:${this.userId}`;
    protected readonly strategyType = 'NiftyChangeStrategy';
    private tradingDay: string | null = null;
    private seenToday = new Set<string>();


    protected index(): 'NIFTY' {
        return 'NIFTY'; // the signal is Nifty's change
    }

    // True while any leg is placing, resting an entry, or still holding unsold quantity: the next slot must not start.
    isRunning(): boolean {
        return this.hasActiveLeg();
    }

    reset(): void {
        super.reset();
        this.seenToday.clear();
        this.setSlotPrice(null);
    }

    private slotMoment(timeStr: string): moment.Moment | null {
        const [h, m] = String(timeStr).split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return moment().hour(h).minute(m).second(0);
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        const today = localDayKey();
        if (this.tradingDay !== today) { this.tradingDay = today; this.seenToday.clear(); this.setSlotPrice(null); }
        const now = moment();
        const times: string[] = Array.isArray(cfg.times) ? cfg.times : [];
        // Restart catch-up (config `catchUpMissedSlot: true`): of the slots due before this process started, only the LATEST one may still
        // fire, and only within LATE_WINDOW_MINUTES. The "already handled" key, the running-position check and the previous-slot reference
        // below still apply, so it fires only if it is a valid slot and no earlier position is still open. Older missed slots are skipped.
        const catchUpSlot = cfg.catchUpMissedSlot === true
            ? times.filter((t) => { const m = this.slotMoment(t); return m != null && !this.seenToday.has(t) && !now.isBefore(m); })
                .sort((a, b) => this.slotMoment(b)!.valueOf() - this.slotMoment(a)!.valueOf())[0]
            : undefined;
        for (const timeStr of times) {
            if (this.seenToday.has(timeStr)) continue;
            const slotTime = this.slotMoment(timeStr);
            if (!slotTime) continue;
            if (now.isBefore(slotTime)) continue;
            this.seenToday.add(timeStr); // each slot is evaluated once, whether it trades, skips or is too late
            const key = `${today} ${timeStr}`;
            if (this.cycleStarted(key)) { Log.log(`[${this.logTag}] ${timeStr} slot already handled earlier today - skipping (a restart does not redo it)`); continue; }
            this.markCycle(key);
            if (slotTime.isBefore(NiftyChangeStrategy.processStartedAt)) {
                if (timeStr === catchUpSlot && now.diff(slotTime, 'minutes') <= LATE_WINDOW_MINUTES) {
                    Log.log(`[${this.logTag}] CATCH-UP: ${timeStr} slot came due at ${slotTime.format('HH:mm:ss')}, before this process started at ${NiftyChangeStrategy.processStartedAt.format('HH:mm:ss')} (now ${now.format('HH:mm:ss')}) - firing it if no earlier position is still open`);
                } else {
                    Log.log(`[${this.logTag}] ${timeStr} slot skipped - process started at ${NiftyChangeStrategy.processStartedAt.format('HH:mm:ss')}, after it${timeStr === catchUpSlot ? ` and more than ${LATE_WINDOW_MINUTES} min ago, too late to catch up` : ''}`);
                    continue;
                }
            } else if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) { Log.log(`[${this.logTag}] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`); this.setSlotPrice(null); continue; }
            // Reference for this slot: the price at the previous slot today, or the previous close for the day's first slot.
            const earlierSlotToday = times.some((t) => this.slotMoment(t)?.isBefore(slotTime) === true);
            const reference: number | null = earlierSlotToday ? this.getSlotPrice() : Number(quote.prevClose);
            const ltp = Number(quote.ltp);
            this.setSlotPrice(ltp > 0 ? ltp : null); // this slot's price is the reference for the next slot
            if (reference == null) { Log.log(`[${this.logTag}] ALERT: ${timeStr}: no price recorded for the previous slot today (process started after it, it was missed, or no tick) - not trading`); continue; }
            if (this.isRunning()) { Log.log(`[${this.logTag}] ${timeStr} slot: previous slot's position already running - skipping`); continue; }
            await this.fireSlot(timeStr, key, ltp, reference, earlierSlotToday ? 'previous slot' : 'previous close');
        }
    }

    private async fireSlot(timeStr: string, key: string, ltp: number, reference: number, referenceLabel: string): Promise<void> {
        const cfg = this.cfg() as any;
        if (!(ltp > 0) || !(reference > 0)) { Log.log(`[${this.logTag}] ${timeStr}: Nifty ltp/reference unusable (${ltp}/${reference}) - skipping`); return; }
        const change = ltp - reference;
        if (change === 0) { Log.log(`[${this.logTag}] ${timeStr}: Nifty is flat vs ${referenceLabel} - skipping`); return; }
        const budget = Number(cfg.maxInvestment);
        const offset = cfg.limitOffset == null ? 3 : Number(cfg.limitOffset);
        const targetPoints = Number(cfg.targetPoints);
        if (!(budget > 0) || !Number.isFinite(offset) || offset < 0 || !(targetPoints > 0)) {
            Log.log(`[${this.logTag}] ALERT: ${timeStr}: maxInvestment (${cfg.maxInvestment}), limitOffset (${cfg.limitOffset}) or targetPoints (${cfg.targetPoints}) invalid - not trading`);
            return;
        }
        const right: 'CE' | 'PE' = change > 0 ? 'CE' : 'PE';
        const strike = AntContractMaster.getInstance().entryStrike(ltp, right, 'NIFTY');
        Log.log(`[${this.logTag}] ${timeStr}: Nifty ${ltp} vs ${referenceLabel} ${reference}: difference ${change > 0 ? '+' : ''}${change.toFixed(2)} points -> direction ${change > 0 ? 'up' : 'down'} -> ${right} ${strike}`);
        await this.startCycle(key, { index: 'NIFTY', strike, right }, budget, async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp - offset);
        });
    }

    protected async topUpExit(leg: Leg, delta: number): Promise<void> {
        const targetPoints = Number((this.cfg() as any).targetPoints);
        if (!(targetPoints > 0)) throw new Error(`targetPoints (${(this.cfg() as any).targetPoints}) invalid`);
        const target = roundToTick(this.avgPrice(leg) + targetPoints);
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: delta, price: target, exchange: leg.exchange,
        });
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: extra resting sell ${delta} @ ${target} for the later fill`);
    }

    protected async placeExit(leg: Leg): Promise<void> {
        const targetPoints = Number((this.cfg() as any).targetPoints);
        if (!(targetPoints > 0)) throw new Error(`targetPoints (${(this.cfg() as any).targetPoints}) invalid`);
        const target = roundToTick(this.avgPrice(leg) + targetPoints);
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: leg.filledQty, price: target, exchange: leg.exchange,
        });
        leg.exit = 'resting';
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: bought ${leg.filledQty} @ avg ${this.avgPrice(leg).toFixed(2)} - resting sell @ ${target}`);
    }
}
