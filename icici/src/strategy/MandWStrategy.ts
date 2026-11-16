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
import { MwBroker, MwState, MwWatch, Right, WatchEvent, MAX_ENTRY_RETRIES, PENDING_MAX_AGE_MS, classifyExit, opposite, patternName, stepWatch } from './mandwCycle';

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
// Several brokers (`brokers: [kite, ant, ...]`, one strategy): EVERY BROKER ACTS ON ITS OWN. Each broker has its own cycle, leg, watch, reversal, retry count and
// profit-cap latch (state.mw.brokers[<broker>]); one broker's stop, target, pattern, refusal or latch never decides, delays or blocks another's (a latch on kite does
// not touch prism). The brokers share only the code, the config block and the NIFTY price they pick the strike from.
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
        super.reset(); // a fresh state: no watch, no pending reversal on any broker
        this.missedLogged = false;
    }

    private mwState(): MwState {
        if (!this.state.mw || !this.state.mw.brokers) this.state.mw = { brokers: {} };
        return this.state.mw;
    }

    // The state of one broker (created on first use). Nothing in it is shared with another broker.
    private bs(broker: string): MwBroker {
        const mw = this.mwState();
        if (!mw.brokers[broker]) mw.brokers[broker] = {};
        return mw.brokers[broker];
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

    // This broker's leg is placing, resting, held, or its entry is still open: its cycle is not over.
    private legBusy(broker: string): boolean {
        const leg = this.state.legs[broker];
        return !!leg && (this.isActive(leg) || this.entryOpen(leg));
    }

    private cycleKey(broker: string, seq: number): string {
        return `${localDayKey()} MW-${broker}-${seq}`;
    }

    // ---- the watch: ticks of a contract nothing is held on (one watch per broker) ----

    // Keeps the tick feed of every watched contract on (idempotent), and off for a contract no broker watches any more.
    private armed = new Map<string, 'NFO' | 'BFO'>(); // token -> exchange
    private syncWatch(): void {
        const wanted = new Map<string, 'NFO' | 'BFO'>();
        for (const b of Object.values(this.mwState().brokers)) if (b.watch) wanted.set(b.watch.token, b.watch.exchange);
        for (const [token, exchange] of [...this.armed]) {
            if (!wanted.has(token)) { unwatchTokenOnSource('ant', token, this, exchange); this.armed.delete(token); }
        }
        for (const [token, exchange] of wanted) {
            watchTokenOnSource('ant', token, this, exchange);
            this.armed.set(token, exchange);
        }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        const brokers = this.state.mw?.brokers;
        return (!!brokers && Object.values(brokers).some((b) => b.watch?.token === String(quote.token))) || super.canHandleOptionQuote(quote);
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (!this.enabled) return;
        const ltp = Number(quote.ltp);
        for (const [broker, b] of Object.entries(this.mwState().brokers)) {
            const w = b.watch;
            if (!w || w.token !== String(quote.token)) continue;
            const r = stepWatch(w, ltp, Date.now(), this.timeoutMs());
            this.applyWatchEvent(broker, w, r.event, r.phase, ltp);
        }
        await super.processOptionQuote(quote); // the tick stop / target of every broker's leg on this token, each on its own leg
    }

    // Synchronous on purpose (no await): concurrent ticks cannot apply one event twice, and the watch is cleared before anything else runs.
    private applyWatchEvent(broker: string, w: MwWatch, event: WatchEvent, phase: MwWatch['phase'], ltp: number): void {
        const b = this.bs(broker);
        if (b.watch !== w || event === 'none') return;
        const shape = patternName(w.right);
        const head = `${broker} ${w.right} ${w.tsym} (P ${w.entry.toFixed(2)}, target ${w.target}, stop ${w.stop})`;
        if (event === 'valley') {
            w.phase = phase;
            this.save();
            Log.log(`[${this.logTag}] ${shape} valley on ${head}: price ${ltp} is back at or below P - waiting for ${w.target} again`);
            return;
        }
        b.watch = undefined;
        if (event === 'pattern') {
            b.pending = { right: opposite(w.right), reason: `${shape} pattern`, at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} PATTERN IDENTIFIED on ${head}: peak at ${w.target}, valley at or below ${w.entry.toFixed(2)}, second peak at ${ltp} -> reverse: BUY ${b.pending.right}`);
        } else if (event === 'failed') {
            b.pending = { right: opposite(w.right), reason: `${shape} failed`, at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} FAILED on ${head}: price ${ltp} fell to the stop level ${w.stop} before the second peak -> reverse at once: BUY ${b.pending.right}`);
        } else {
            b.pending = { right: w.right, reason: 'pattern timeout', at: Date.now() };
            Log.log(`[${this.logTag}] ${shape} watch on ${head} timed out after ${Math.round(this.timeoutMs() / 60000)} min without the pattern or the stop (phase ${w.phase}) -> abandoned, BUY ${b.pending.right} again`);
        }
        this.save();
    }

    // ---- cycle end: what happened to THIS broker's position decides ITS next step ----

    private decideCycleEnd(broker: string): void {
        const b = this.bs(broker);
        if (!b.seq) return; // no cycle started on this broker yet
        const key = this.cycleKey(broker, b.seq);
        if (b.decidedKey === key || this.legBusy(broker)) return;
        b.decidedKey = key;
        const right = b.cycleRight ?? this.startSide();
        const leg = this.state.legs[broker];
        const tag = `${broker} cycle ${key}`;
        if (!leg || leg.filledQty <= 0) {
            const tries = b.retries ?? 0;
            if (right && tries < MAX_ENTRY_RETRIES && !this.pastEntryWindow()) {
                b.retries = tries + 1;
                b.pending = { right, reason: 'entry not filled', at: Date.now() };
                Log.log(`[${this.logTag}] ${tag} ended with nothing filled (entry refused, cancelled or unaffordable) - trying ${right} again (${b.retries}/${MAX_ENTRY_RETRIES})`);
            } else {
                Log.log(`[${this.logTag}] ALERT: ${tag} ended with nothing filled${tries >= MAX_ENTRY_RETRIES ? ` ${tries} times in a row` : ''} - no further entry today on ${broker}`);
            }
            this.save();
            return;
        }
        b.retries = 0;
        const entry = this.avgPrice(leg);
        if (leg.soldQty <= 0 || !right) { this.save(); return; }
        if (this.pastEntryWindow()) {
            Log.log(`[${this.logTag}] ${tag} ended at or after lastEntryTime / the end-of-day close - no further entry on ${broker}`);
            this.save();
            return;
        }
        let ex: { target: number | null; stop: number | undefined };
        try { ex = this.exitFor(entry); } catch (e: any) { Log.log(`[${this.logTag}] ALERT: ${tag}: ${e?.message ?? e} - no further entry on ${broker}`); this.save(); return; }
        if (ex.target === null || ex.stop === undefined) {
            Log.log(`[${this.logTag}] ALERT: ${tag}: target and stopLoss must both be set for this strategy - no further entry on ${broker}`);
            this.save();
            return;
        }
        const exitPx = leg.soldValue / leg.soldQty;
        const kind = classifyExit(entry, exitPx, ex.target, ex.stop);
        if (kind === 'stop') {
            b.pending = { right: opposite(right), reason: 'stop hit', at: Date.now() };
            Log.log(`[${this.logTag}] STOP-FLIP on ${broker}: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} (stop ${ex.stop}) -> reverse at once: BUY ${b.pending.right}`);
        } else if (kind === 'target') {
            b.watch = { right, tsym: leg.tsym, token: leg.token, exchange: leg.exchange, entry, target: ex.target, stop: ex.stop, phase: 'peak', startedAt: Date.now() };
            Log.log(`[${this.logTag}] TARGET hit on ${broker}: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} (target ${ex.target}) - watching it for the ${patternName(right)}: valley at or below ${entry.toFixed(2)}, then ${ex.target} again; failed below ${ex.stop}`);
        } else {
            Log.log(`[${this.logTag}] ${tag}: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} - neither the target (${ex.target}) nor the stop (${ex.stop}) (end-of-day or manual close) - no further entry on ${broker}`);
        }
        this.save();
    }

    // ---- per NIFTY tick ----

    protected async onNiftyTick(quote: NiftyQuote): Promise<void> {
        const ltp = Number(quote.ltp);
        if (!(ltp > 0)) return;
        this.niftyLtp = ltp;
        this.mwState();
        const brokers = this.brokers();
        for (const broker of brokers) {
            if (!this.placingNext) this.decideCycleEnd(broker); // not while an entry is being placed: its leg is not recorded yet
            const w = this.bs(broker).watch;
            if (w) { // the watch also ends on time alone, with no option tick
                const r = stepWatch(w, NaN, Date.now(), this.timeoutMs());
                this.applyWatchEvent(broker, w, r.event, r.phase, NaN);
            }
        }
        this.syncWatch();
        for (const broker of brokers) this.maybeFirstEntry(broker);
        for (const broker of brokers) await this.runPending(broker);
    }

    // The first entry of the day on one broker becomes a pending entry (same gates and placement as every reversal).
    private maybeFirstEntry(broker: string): void {
        const b = this.bs(broker);
        if (b.seq || b.pending || b.watch) return;
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
        b.pending = { right: side, reason: 'first entry', at: Date.now() };
        this.save();
    }

    // Places one broker's pending entry once that broker is flat. Every drop is logged; nothing here is retried blind (the key and leg are persisted
    // by startCycle). Only this broker's gates apply: its own profit-cap latch, its own open leg.
    private async runPending(broker: string): Promise<void> {
        const b = this.bs(broker);
        const p = b.pending;
        if (!p || this.placingNext) return;
        const drop = (why: string, alert = false) => { b.pending = undefined; this.save(); Log.log(`[${this.logTag}] ${alert ? 'ALERT: ' : ''}${broker} ${p.reason}: BUY ${p.right} not placed - ${why}`); };
        if (Date.now() - p.at > PENDING_MAX_AGE_MS) return drop('it is more than 2 minutes old', true);
        if (this.legBusy(broker)) return; // this broker's leg is still placing / resting / held: wait until it is flat
        if (!(this.niftyLtp > 0)) return;
        if (this.pastEntryWindow()) return drop('past lastEntryTime / the end-of-day close');
        if (this.configuredQuantity() === null) return drop(`quantity (${(this.cfg() as any).quantity}) is not a positive multiple of the lot size`, true);
        try {
            const rules = this.exitRules();
            if (!rules.target || !rules.stop) return drop('target and stopLoss must both be set (not none)', true);
        } catch (e: any) { return drop(String(e?.message ?? e), true); }
        if (await isGlobalMaxProfitLatched(this.userId, normalizeBrokerName(broker))) return drop(`the global max profit is hit today on ${broker}`);
        if (b.pending !== p || this.legBusy(broker) || this.placingNext) return; // changed while awaiting
        this.placingNext = true;
        try {
            b.seq = (b.seq ?? 0) + 1;
            const key = this.cycleKey(broker, b.seq);
            const strike = this.atmStrike(this.niftyLtp);
            b.pending = undefined;
            b.cycleRight = p.right;
            this.save();
            Log.log(`[${this.logTag}] ${broker} ${p.reason}: BUY ${p.right} ${strike} (nearest expiry), quantity ${this.configuredQuantity()} [${key}]`);
            await this.startCycle(key, { index: 'NIFTY', strike, right: p.right }, () => 1, async (c) => {
                const optionLtp = await OrderClient.getInstance().getOptionLtp(this.userId, { tradingSymbol: c.tsym, token: c.token, exchange: c.exchange });
                return roundToTick(optionLtp);
            }, [broker]);
        } finally {
            this.placingNext = false;
        }
    }
}
