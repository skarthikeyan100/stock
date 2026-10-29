import moment from 'moment';
import Log from '../util/Log';
import { NiftyQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';

// At each configured HH:mm slot, buys the option in the direction of Nifty's change on the day (Nifty LTP minus the previous close,
// from the live tick): up -> CE, down -> PE, flat -> nothing. The order is a LIMIT buy at (the option's LTP - limitOffset) on every
// configured broker, sized from maxInvestment (split evenly across the brokers). When it fills, a resting limit sell goes in at
// (fill price + targetPoints). No stop loss: an unfilled entry is cancelled after entryTimeoutMinutes, and a position still held at
// eodCloseTime is closed at market.
//
// Slot rules are BulkPcrAutoStartStrategy's: each slot fires at most once a day (persisted), a slot earlier than this process's start
// is never fired (a restart must not buy "the slot a minute ago"), and a slot more than 5 minutes old is missed. A slot is also
// skipped while the previous slot's position is still open - one trade at a time.
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

    reset(): void {
        super.reset();
        this.seenToday.clear();
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        const today = localDayKey();
        if (this.tradingDay !== today) { this.tradingDay = today; this.seenToday.clear(); }
        const now = moment();
        const times: string[] = Array.isArray(cfg.times) ? cfg.times : [];
        for (const timeStr of times) {
            if (this.seenToday.has(timeStr)) continue;
            const [h, m] = String(timeStr).split(':').map(Number);
            if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
            const slotTime = moment().hour(h).minute(m).second(0);
            if (now.isBefore(slotTime)) continue;
            this.seenToday.add(timeStr); // each slot is evaluated once, whether it trades, skips or is too late
            const key = `${today} ${timeStr}`;
            if (this.cycleStarted(key)) { Log.log(`[${this.logTag}] ${timeStr} slot already handled earlier today - skipping (a restart does not redo it)`); continue; }
            this.markCycle(key);
            if (slotTime.isBefore(NiftyChangeStrategy.processStartedAt)) { Log.log(`[${this.logTag}] ${timeStr} slot skipped - process started at ${NiftyChangeStrategy.processStartedAt.format('HH:mm:ss')}, after it`); continue; }
            if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) { Log.log(`[${this.logTag}] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`); continue; }
            await this.fireSlot(timeStr, key, quote);
        }
    }

    private async fireSlot(timeStr: string, key: string, quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        const ltp = Number(quote.ltp);
        const prevClose = Number(quote.prevClose);
        if (!(ltp > 0) || !(prevClose > 0)) { Log.log(`[${this.logTag}] ${timeStr}: Nifty ltp/prevClose unusable (${quote.ltp}/${quote.prevClose}) - skipping`); return; }
        const change = ltp - prevClose;
        if (change === 0) { Log.log(`[${this.logTag}] ${timeStr}: Nifty is flat - skipping`); return; }
        const budget = Number(cfg.maxInvestment);
        const offset = cfg.limitOffset == null ? 3 : Number(cfg.limitOffset);
        const targetPoints = Number(cfg.targetPoints);
        if (!(budget > 0) || !Number.isFinite(offset) || offset < 0 || !(targetPoints > 0)) {
            Log.log(`[${this.logTag}] ALERT: ${timeStr}: maxInvestment (${cfg.maxInvestment}), limitOffset (${cfg.limitOffset}) or targetPoints (${cfg.targetPoints}) invalid - not trading`);
            return;
        }
        if (this.hasActiveLeg()) { Log.log(`[${this.logTag}] ${timeStr}: previous slot's position is still open - skipping`); return; }
        const right: 'CE' | 'PE' = change > 0 ? 'CE' : 'PE';
        const strike = AntContractMaster.getInstance().entryStrike(ltp, right, 'NIFTY');
        Log.log(`[${this.logTag}] ${timeStr}: Nifty ${ltp} vs prev close ${prevClose} (${change > 0 ? '+' : ''}${change.toFixed(2)}) -> ${right} ${strike}`);
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
