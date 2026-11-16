import moment from 'moment';
import Log from '../util/Log';
import { NiftyQuote, OptionQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { CandleEntryStrategy } from './CandleEntryStrategy';
import { isPastTime } from '../util/marketHours';
import { isPastEodClose } from '../util/eodClose';
import { normalizeBrokerName } from '../util/brokerName';
import { isGlobalMaxProfitLatched } from './globalMaxProfitLatch';
import { watchTokenOnSource, unwatchTokenOnSource } from '../processes/strategies/tokenRouter';
import { MwState, MwWatch, Right, WatchEvent, MAX_ENTRY_RETRIES, PENDING_MAX_AGE_MS, classifyExit, opposite, patternName, stepWatch } from './mandwCycle';

// M and W pattern strategy on NIFTY options, traded on the OPTION price (pure rules: mandwCycle.ts).
//
//   1. At `startTime` buy the ATM option of `startSide` (CE or PE) at P, target P + T, stop P - S (option points; target / stopLoss as for the other
//      strategies: block or settings, points or "N%").
//   2. Stop hit: reverse at once - buy the ATM option of the OTHER side (new cycle, same rules).
//   3. Target hit: the position is sold at P + T and the SAME contract is watched with no position. When its price comes back to P or below (the
//      valley) and then rises to P + T again, the shape is complete - an "M" on a CE, a "W" on a PE: logged "M PATTERN IDENTIFIED" - and the OTHER side
//      is bought. If the watched price falls to the stop level P - S first, the shape failed: reverse at once, like a stop. If neither happens within
//      `patternTimeoutMinutes` (the whole watch) the watch is abandoned and the SAME side is bought again.
//   4. It goes on until the profit cap trips (`settings.maxProfit`, the global rupee cap: the global monitor locks it and the order process then refuses
//      every new buy of this strategy on that broker), `lastEntryTime`, or the end-of-day close.
//
// Several brokers: each broker has its own leg of every cycle (`quantity` per broker). The decision at the end of a cycle (target / stop) is taken
// from the FIRST broker with a fill (the order of `brokers:`); the watched contract is that broker's.
//
// Restart: the watch (and a reversal not yet placed) is kept in the state file and resumed; a reversal older than two minutes is dropped, never
// placed late. The first entry fires only in [startTime, startTime + 5 min) and never for a start time before this process started (no catch-up).
// A cycle that ends with nothing filled is tried again up to MAX_ENTRY_RETRIES times in a row, then the strategy stays idle for the day (ALERT).
//
// Config (config.yml):
//   quantity: 65, index: NIFTY, brokers: [kite]
//   startSide: CE            - CE | PE, the first entry of the day
//   startTime: '09:20'
//   target / stopLoss        - option-price exits (block or settings); both are required (not 'none')
//   trailDistance: 4         - optional (option points): sell floor(lots/2) lots at the target, trail the rest (floor = the target, no stop); needs 2+ lots, else off
//   patternTimeoutMinutes: 30 - ends the watch of a sold position (default 30)
//   lastEntryTime: '15:00'   - no entry or reversal at or after this time (default 15:00)
//   settings.maxProfit       - required (the global cap; a block-level maxProfit is NOT read for this strategy)
const LATE_WINDOW_MINUTES = 5;
const DEFAULT_TIMEOUT_MINUTES = 30;

export default class MandWStrategy extends CandleEntryStrategy {
    // When this process came up (a static so a test can move it): a start time before it is never fired.
    static processStartedAt = moment();
    protected readonly logTag = `MandW:${this.userId}`;
    protected readonly strategyType = 'MandWStrategy';
    private niftyLtp = 0;
    private placingNext = false;
    private missedLogged = false;

    constructor(userId?: string) {
        super(userId);
        this.warnLegacyExitKeys();
    }

    reset(): void {
        super.reset(); // a fresh state: no watch, no pending reversal
        this.missedLogged = false;
    }

    private mwState(): MwState {
        if (!this.state.mw) this.state.mw = {};
        return this.state.mw;
    }

    // Half-at-target + trail (halfTrail.ts): `trailDistance` points below the peak. Absent / 0 = off; with fewer than 2 lots it is not engaged.
    protected trailDistance(): number {
        const n = Number((this.cfg() as any).trailDistance);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    private startSide(): Right | null {
        const s = String((this.cfg() as any).startSide ?? '').toUpperCase();
        return s === 'CE' || s === 'PE' ? s : null;
    }

    private timeoutMs(): number {
        const m = Number((this.cfg() as any).patternTimeoutMinutes);
        return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TIMEOUT_MINUTES) * 60_000;
    }

    private pastEntryWindow(): boolean {
        return isPastEodClose() || isPastTime(String((this.cfg() as any).lastEntryTime ?? '15:00'), '15:00');
    }

    private slotMoment(timeStr: string): moment.Moment | null {
        const [h, m] = String(timeStr).split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return moment().hour(h).minute(m).second(0).millisecond(0);
    }

    // ---- the watch: ticks of a contract nothing is held on ----

    // Keeps the tick feed of the watched contract on (idempotent), and off for a contract no longer watched.
    private armed: { token: string; exchange: 'NFO' | 'BFO' } | null = null;
    private syncWatch(): void {
        const w = this.mwState().watch;
        if (this.armed && (!w || this.armed.token !== w.token)) {
            unwatchTokenOnSource('ant', this.armed.token, this, this.armed.exchange);
            this.armed = null;
        }
        if (w) {
            watchTokenOnSource('ant', w.token, this, w.exchange);
            this.armed = { token: w.token, exchange: w.exchange };
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        const w = this.state.mw?.watch;
        return (!!w && w.token === String(quote.token)) || super.canHandleOptionQuote(quote);
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (!this.enabled) return;
        const w = this.state.mw?.watch;
        if (w && w.token === String(quote.token)) {
            const ltp = Number(quote.ltp);
            const r = stepWatch(w, ltp, Date.now(), this.timeoutMs());
            this.applyWatchEvent(w, r.event, r.phase, ltp);
        }
        await super.processOptionQuote(quote);
    }

    // Synchronous on purpose (no await): concurrent ticks cannot apply one event twice, and the watch is cleared before anything else runs.
    private applyWatchEvent(w: MwWatch, event: WatchEvent, phase: MwWatch['phase'], ltp: number): void {
        const mw = this.mwState();
        if (mw.watch !== w || event === 'none') return;
        const shape = patternName(w.right);
        const head = `${w.right} ${w.tsym} (P ${w.entry.toFixed(2)}, target ${w.target}, stop ${w.stop})`;
        if (event === 'valley') {
            w.phase = phase;
            this.save();
            Log.log(`[${this.logTag}] ${shape} valley on ${head}: price ${ltp} is back at or below P - waiting for ${w.target} again`);
            return;
        }
        mw.watch = undefined;
        if (event === 'pattern') {
            mw.pending = { right: opposite(w.right), reason: `${shape} pattern`, at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} PATTERN IDENTIFIED on ${head}: peak at ${w.target}, valley at or below ${w.entry.toFixed(2)}, second peak at ${ltp} -> reverse: BUY ${mw.pending.right}`);
        } else if (event === 'failed') {
            mw.pending = { right: opposite(w.right), reason: `${shape} failed`, at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} FAILED on ${head}: price ${ltp} fell to the stop level ${w.stop} before the second peak -> reverse at once: BUY ${mw.pending.right}`);
        } else {
            mw.pending = { right: w.right, reason: 'pattern timeout', at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} watch on ${head} timed out after ${Math.round(this.timeoutMs() / 60000)} min without the pattern or the stop (phase ${w.phase}) -> abandoned, BUY ${mw.pending.right} again`);
        }
        this.save();
    }

    // ---- cycle end: what happened to the position decides the next step ----

    protected async onCycleEnded(): Promise<void> {
        const mw = this.mwState();
        const key = this.state.keys[this.state.keys.length - 1];
        if (!key || mw.decidedKey === key) return;
        mw.decidedKey = key;
        const right = mw.cycleRight ?? this.startSide();
        const filled = this.legs().filter((l) => l.filledQty > 0);
        if (filled.length === 0) {
            const tries = mw.retries ?? 0;
            if (right && tries < MAX_ENTRY_RETRIES && !this.pastEntryWindow()) {
                mw.retries = tries + 1;
                mw.pending = { right, reason: 'entry not filled', at: Date.now() };
                Log.log(`[${this.logTag}] cycle ${key} ended with nothing filled (entry refused, cancelled or unaffordable) - trying ${right} again (${mw.retries}/${MAX_ENTRY_RETRIES})`);
            } else {
                Log.log(`[${this.logTag}] ALERT: cycle ${key} ended with nothing filled${tries >= MAX_ENTRY_RETRIES ? ` ${tries} times in a row` : ''} - no further entry today`);
            }
            this.save();
            return;
        }
        mw.retries = 0;
        const leg = filled[0];
        const entry = this.avgPrice(leg);
        if (leg.soldQty <= 0 || !right) { this.save(); return; }
        if (this.pastEntryWindow()) {
            Log.log(`[${this.logTag}] cycle ${key} ended at or after lastEntryTime / the end-of-day close - no further entry`);
            this.save();
            return;
        }
        let ex: { target: number | null; stop: number | undefined };
        try { ex = this.exitFor(entry); } catch (e: any) { Log.log(`[${this.logTag}] ALERT: cycle ${key}: ${e?.message ?? e} - no further entry`); this.save(); return; }
        if (ex.target === null || ex.stop === undefined) {
            Log.log(`[${this.logTag}] ALERT: cycle ${key}: target and stopLoss must both be set for this strategy - no further entry`);
            this.save();
            return;
        }
        const exitPx = leg.soldValue / leg.soldQty;
        const kind = classifyExit(entry, exitPx, ex.target, ex.stop);
        if (kind === 'stop') {
            mw.pending = { right: opposite(right), reason: 'stop hit', at: Date.now() };
            Log.log(`[${this.logTag}] STOP-FLIP: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} (stop ${ex.stop}) -> reverse at once: BUY ${mw.pending.right}`);
        } else if (kind === 'target') {
            mw.watch = { right, tsym: leg.tsym, token: leg.token, exchange: leg.exchange, entry, target: ex.target, stop: ex.stop, phase: 'peak', startedAt: Date.now() };
            Log.log(`[${this.logTag}] TARGET hit: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} (target ${ex.target}) - watching it for the ${patternName(right)}: valley at or below ${entry.toFixed(2)}, then ${ex.target} again; failed below ${ex.stop}`);
        } else {
            Log.log(`[${this.logTag}] cycle ${key}: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} - neither the target (${ex.target}) nor the stop (${ex.stop}) (end-of-day or manual close) - no further entry`);
        }
        this.save();
    }

    // ---- per NIFTY tick ----

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const ltp = Number(quote.ltp);
        if (!(ltp > 0)) return;
        this.niftyLtp = ltp;
        const mw = this.mwState();
        this.syncWatch();
        if (mw.watch) { // the watch also ends on time alone, with no option tick
            const w = mw.watch;
            const r = stepWatch(w, NaN, Date.now(), this.timeoutMs());
            this.applyWatchEvent(w, r.event, r.phase, NaN);
            this.syncWatch();
        }
        this.maybeFirstEntry(mw);
        await this.runPending(mw);
    }

    // The first entry of the day becomes a pending entry (same gates and placement as every reversal).
    private maybeFirstEntry(mw: MwState): void {
        if (this.state.keys.length > 0 || mw.pending || mw.watch) return;
        const cfg = this.cfg() as any;
        const slot = this.slotMoment(String(cfg.startTime ?? ''));
        const side = this.startSide();
        if (!slot || !side) {
            if (!this.missedLogged) { this.missedLogged = true; Log.log(`[${this.logTag}] ALERT: startTime (${cfg.startTime}) must be HH:mm and startSide (${cfg.startSide}) CE or PE - not trading`); }
            return;
        }
        const now = moment();
        if (now.isBefore(slot)) return;
        if (slot.isBefore(MandWStrategy.processStartedAt) || now.diff(slot, 'minutes', true) >= LATE_WINDOW_MINUTES) {
            if (!this.missedLogged) { this.missedLogged = true; Log.log(`[${this.logTag}] start time ${cfg.startTime} is before this process started or more than ${LATE_WINDOW_MINUTES} min ago - no first entry today`); }
            return;
        }
        mw.pending = { right: side, reason: 'first entry', at: Date.now() };
        this.save();
    }

    // Places the pending entry once nothing is held. Every drop is logged; nothing here is retried blind (the key and legs are persisted by startCycle).
    private async runPending(mw: MwState): Promise<void> {
        const p = mw.pending;
        if (!p || this.placingNext) return;
        const drop = (why: string, alert = false) => { mw.pending = undefined; this.save(); Log.log(`[${this.logTag}] ${alert ? 'ALERT: ' : ''}${p.reason}: BUY ${p.right} not placed - ${why}`); };
        if (Date.now() - p.at > PENDING_MAX_AGE_MS) return drop('it is more than 2 minutes old', true);
        if (this.isRunning()) return; // a leg is still placing / resting / held: wait until flat
        if (!(this.niftyLtp > 0)) return;
        if (this.pastEntryWindow()) return drop('past lastEntryTime / the end-of-day close');
        if (this.configuredQuantity() === null) return drop(`quantity (${(this.cfg() as any).quantity}) is not a positive multiple of the lot size`, true);
        try {
            const rules = this.exitRules();
            if (!rules.target || !rules.stop) return drop('target and stopLoss must both be set (not none)', true);
        } catch (e: any) { return drop(String(e?.message ?? e), true); }
        const brokers = this.brokers();
        const latched = await Promise.all(brokers.map((b) => isGlobalMaxProfitLatched(this.userId, normalizeBrokerName(b))));
        if (brokers.length > 0 && latched.every(Boolean)) return drop('the global max profit is hit on every broker today');
        if (mw.pending !== p || this.isRunning()) return; // changed while awaiting
        this.placingNext = true;
        try {
            const key = `${localDayKey()} MW${this.state.keys.length + 1}`;
            const strike = this.atmStrike(this.niftyLtp);
            mw.pending = undefined;
            mw.cycleRight = p.right;
            this.save();
            Log.log(`[${this.logTag}] ${p.reason}: BUY ${p.right} ${strike} (nearest expiry), quantity ${this.configuredQuantity()} per broker [${key}]`);
            await this.startCycle(key, { index: 'NIFTY', strike, right: p.right }, () => 1, async (c) => {
                const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
                return roundToTick(optionLtp);
            });
        } finally {
            this.placingNext = false;
        }
    }
}
