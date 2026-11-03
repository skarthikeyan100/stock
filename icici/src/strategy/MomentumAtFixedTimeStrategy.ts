import moment from 'moment';
import Log from '../util/Log';
import { NiftyQuote, OptionQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { exposureForBroker, resolveMaxExposure } from '../prism/configVocabulary';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';
import MomentumSignal from './MomentumSignal';

// Revived from the deleted Minutes5Decision prototype (commit 9765032), rebuilt on LimitEntryStrategy. At each configured HH:mm slot:
//   1. Order-book surplus: read tbq - tsq (AntDepth) for the CE at ceil(spot/50)*50 and the PE at floor(spot/50)*50. The contract with
//      the larger surplus must be positive; its side gives the direction (CE = up, PE = down).
//   2. Price check: Nifty now minus Nifty at the previous slot today must match that direction (CE needs a rise, PE a fall). Otherwise
//      no trade. The first slot of the day has no previous slot and never trades.
//   3. Entry: one LIMIT buy per broker at the option's prevailing LTP, sized from maxInvestment (per broker) at runtime.
//   4. Exit: no sell is placed on fill. The leg is watched on ticks; the first tick at or above fill + targetPrice places ONE limit sell
//      at that tick's price. There is no stop loss: a position is closed only by that target sell or by the EOD close (eodCloseTime).
//
// Only one position at a time (a slot is skipped while the previous slot's position is still open; that slot is consumed).
// Slot rules: each slot fires at most once a day (persisted); a slot earlier than this process's start is never fired (no catch-up);
// a slot more than 5 minutes old is missed. Every slot seen updates the previous-slot price, whether or not it trades.
//
// Logging only: the Nifty up/down tick counts since the previous slot are logged at every slot (delivered ticks, which are coalesced, so
// they undercount exchange ticks). They are kept in memory and are not used for any decision.
//
// Config (config.yml):
//   times: ['10:40', '11:40', '12:30', '13:40', '14:30']
//   maxInvestment: 100000   - per broker; the lot count is computed at runtime (no quantity key)
//   targetPrice: 3          - limit sell at fill average + targetPrice, placed on the tick that reaches it
//   entryTimeoutMinutes: 5  - cancel an unfilled entry after this long
//   eodCloseTime: '15:10'
//   index: NIFTY
//   brokers: [kite]
const LATE_WINDOW_MINUTES = 5;
const STRIKE_STEP = 50;
const DEPTH_TIMEOUT_MS = 3000;

export default class MomentumAtFixedTimeStrategy extends LimitEntryStrategy {
    // When this process came up (a static so a test can move it): slots before it are never fired.
    static processStartedAt = moment();
    protected readonly logTag = `MomentumAtFixedTime:${this.userId}`;
    protected readonly strategyType = 'MomentumAtFixedTimeStrategy';
    private tradingDay: string | null = null;
    private seenToday = new Set<string>();
    private momentum = new MomentumSignal();
    private lastLtp: number | null = null;
    private ups = 0;
    private downs = 0;

    protected index(): 'NIFTY' {
        return 'NIFTY';
    }

    // True while any leg is placing, resting an entry, or still holding unsold quantity: the next slot must not start.
    isRunning(): boolean {
        return this.hasActiveLeg();
    }

    reset(): void {
        super.reset();
        this.seenToday.clear();
        this.setSlotPrice(null);
        this.lastLtp = null;
        this.ups = 0;
        this.downs = 0;
    }

    private slotMoment(timeStr: string): moment.Moment | null {
        const [h, m] = String(timeStr).split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return moment().hour(h).minute(m).second(0);
    }

    // Counts Nifty's delivered ticks: up when LTP rose since the previous tick, down when it fell. Logging only.
    private countTick(ltp: number): void {
        if (this.lastLtp !== null) {
            if (ltp > this.lastLtp) this.ups++;
            else if (ltp < this.lastLtp) this.downs++;
        }
        this.lastLtp = ltp;
    }

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const cfg = this.cfg() as any;
        const today = localDayKey();
        if (this.tradingDay !== today) {
            // The first tick after a (re)start keeps the persisted slot price (the state file is per-day). Only a real rollover in a running
            // process clears it.
            const rolledOver = this.tradingDay !== null;
            this.tradingDay = today;
            this.seenToday.clear();
            this.lastLtp = null;
            this.ups = 0;
            this.downs = 0;
            if (rolledOver) this.setSlotPrice(null);
        }
        const ltp = Number(quote.ltp);
        const now = moment();
        const times: string[] = Array.isArray(cfg.times) ? cfg.times : [];
        for (const timeStr of times) {
            if (this.seenToday.has(timeStr)) continue;
            const slotTime = this.slotMoment(timeStr);
            if (!slotTime) continue;
            if (now.isBefore(slotTime)) continue;
            this.seenToday.add(timeStr); // each slot is evaluated once, whether it trades, skips or is too late
            const key = `${today} ${timeStr}`;
            const counts = `ups ${this.ups} / downs ${this.downs} since the previous slot`;
            this.ups = 0;
            this.downs = 0;
            if (this.cycleStarted(key)) { Log.log(`[${this.logTag}] ${timeStr} slot already handled earlier today - skipping (a restart does not redo it)`); continue; }
            this.markCycle(key);
            if (slotTime.isBefore(MomentumAtFixedTimeStrategy.processStartedAt)) {
                Log.log(`[${this.logTag}] ${timeStr} slot skipped - process started at ${MomentumAtFixedTimeStrategy.processStartedAt.format('HH:mm:ss')}, after it`);
                this.setSlotPrice(ltp > 0 ? ltp : null);
                continue;
            }
            if (now.diff(slotTime, 'minutes') > LATE_WINDOW_MINUTES) {
                Log.log(`[${this.logTag}] Missed ${timeStr} slot (now ${now.format('HH:mm:ss')}) - skipping`);
                this.setSlotPrice(null);
                continue;
            }
            // Reference: the price at the previous slot today. The first slot of the day has none and does not trade.
            const earlierSlotToday = times.some((t) => this.slotMoment(t)?.isBefore(slotTime) === true);
            const reference = earlierSlotToday ? this.getSlotPrice() : null;
            this.setSlotPrice(ltp > 0 ? ltp : null); // this slot's price is the reference for the next slot
            Log.log(`[${this.logTag}] ${timeStr} slot: Nifty ${ltp}, previous slot ${reference ?? 'none'}, ${counts}`);
            if (!earlierSlotToday) { Log.log(`[${this.logTag}] ${timeStr}: first slot of the day - no previous slot to compare, not trading`); continue; }
            if (reference == null) { Log.log(`[${this.logTag}] ALERT: ${timeStr}: no price recorded for the previous slot today (process started after it, it was missed, or no tick) - not trading`); continue; }
            if (this.isRunning()) { Log.log(`[${this.logTag}] ${timeStr} slot: previous slot's position already running - skipping`); continue; }
            await this.fireSlot(timeStr, key, ltp, reference);
        }
        this.countTick(ltp);
    }

    private async fireSlot(timeStr: string, key: string, ltp: number, reference: number): Promise<void> {
        const cfg = this.cfg() as any;
        if (!(ltp > 0) || !(reference > 0)) { Log.log(`[${this.logTag}] ${timeStr}: Nifty ltp/reference unusable (${ltp}/${reference}) - skipping`); return; }
        const targetPoints = Number(cfg.targetPrice);
        if (!(resolveMaxExposure(cfg) > 0) || !(targetPoints > 0)) {
            Log.log(`[${this.logTag}] ALERT: ${timeStr}: maxInvestment (${cfg.maxInvestment}) or targetPrice (${cfg.targetPrice}) invalid - not trading`);
            return;
        }

        // 1. Order-book surplus on the two candidate contracts (ANT tokens, depth feed).
        const ceStrike = Math.ceil(ltp / STRIKE_STEP) * STRIKE_STEP;
        const peStrike = Math.floor(ltp / STRIKE_STEP) * STRIKE_STEP;
        const lookup = (strike: number, right: 'CE' | 'PE') => OrderClient.getInstance().resolveOptionContract(this.userId, { broker: 'ant', index: 'NIFTY', strike, right });
        const [ce, pe] = await Promise.all([lookup(ceStrike, 'CE'), lookup(peStrike, 'PE')]).catch((e: any) => {
            Log.log(`[${this.logTag}] ${timeStr}: contract lookup failed (${e?.message ?? e}) - not trading`);
            return null;
        }) ?? [];
        if (!ce || !pe) return;
        const depth = await this.momentum.readDepth(this, [ce.token, pe.token], 'NFO', DEPTH_TIMEOUT_MS);
        if (!depth) { Log.log(`[${this.logTag}] ${timeStr}: no order-book depth for CE ${ceStrike} / PE ${peStrike} - not trading`); return; }
        const ceD = depth.get(ce.token)!;
        const peD = depth.get(pe.token)!;
        const ceSurplus = ceD.tbq - ceD.tsq;
        const peSurplus = peD.tbq - peD.tsq;
        const chosen = ceSurplus === peSurplus ? null : ceSurplus > peSurplus ? { right: 'CE' as const, strike: ceStrike, surplus: ceSurplus } : { right: 'PE' as const, strike: peStrike, surplus: peSurplus };
        const surplusText = `CE ${ceStrike} surplus ${ceSurplus} | PE ${peStrike} surplus ${peSurplus}`;
        if (!chosen || !(chosen.surplus > 0)) {
            Log.log(`[${this.logTag}] ${timeStr}: no positive surplus winner (${surplusText}) - not trading`);
            return;
        }
        const direction = chosen.right === 'CE' ? 'up' : 'down';

        // 2. The price move since the previous slot must match the direction.
        const move = ltp - reference;
        const priceMatches = chosen.right === 'CE' ? move > 0 : move < 0;
        Log.log(`[${this.logTag}] ${timeStr}: ${surplusText} -> ${chosen.right} (${direction}); Nifty move ${move > 0 ? '+' : ''}${move.toFixed(2)} since previous slot -> ${priceMatches ? 'matches' : 'does NOT match'}`);
        if (!priceMatches) { Log.log(`[${this.logTag}] ${timeStr}: price move does not match ${direction} - no trade`); return; }

        // 3. Entry: one limit buy per broker at the prevailing option price, sized from maxInvestment.
        await this.startCycle(key, { index: 'NIFTY', strike: chosen.strike, right: chosen.right }, (b) => exposureForBroker(cfg, b), async (c) => {
            const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
            return roundToTick(optionLtp);
        });
    }

    // Option ticks: depth ticks for the order-book read go to MomentumSignal; leg ticks go to the target logic in LimitEntryStrategy.
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.momentum.isTracking(String(quote.token)) || super.canHandleOptionQuote(quote);
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (this.momentum.isTracking(String(quote.token))) {
            this.momentum.onTick(quote);
            return;
        }
        await super.processOptionQuote(quote);
    }

    // The target sell goes in once the option's LTP reaches the trigger: its own trigger uses the average fill, so a later fill moves it.
    protected async placeExit(leg: Leg): Promise<void> {
        const targetPoints = Number((this.cfg() as any).targetPrice);
        if (!(targetPoints > 0)) throw new Error(`targetPrice (${(this.cfg() as any).targetPrice}) invalid`);
        this.deferTargetExit(leg, roundToTick(this.avgPrice(leg) + targetPoints));
    }

    protected async topUpExit(leg: Leg, _delta: number): Promise<void> {
        const targetPoints = Number((this.cfg() as any).targetPrice);
        if (!(targetPoints > 0)) throw new Error(`targetPrice (${(this.cfg() as any).targetPrice}) invalid`);
        await this.topUpTargetSell(leg, targetPoints);
    }
}
