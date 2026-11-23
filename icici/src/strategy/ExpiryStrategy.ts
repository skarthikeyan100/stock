import Log from '../util/Log';
import { NiftyQuote, OptionQuote } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import { roundToTick } from '../util/tick';
import { localDayKey } from './dayKey';
import { isPastEodClose } from '../util/eodClose';
import { investmentForBroker } from '../prism/configVocabulary';
import { configuredBrokersOf, normalizeBrokerName } from '../util/brokerName';
import { expiryDayOverrideOf } from '../util/expirySkip';
import { isGlobalMaxProfitLatched } from './globalMaxProfitLatch';
import { unwatchTokenOnSource } from '../processes/strategies/tokenRouter';
import { LimitEntryStrategy, Leg } from './LimitEntryStrategy';
import { exitDistance, exitRulesFrom, ExitRules } from './exitRules';
import { ExBroker, ExPending, ExState, MAX_ENTRY_RETRIES, PENDING_MAX_AGE_MS, Right, atmStrike, classifyExit, drifted, nextAfterExit, opposite } from './expiryCycle';

// Buys one NIFTY option side from the moment the block is enabled (no time slots) and keeps cycling it. Pure rules: expiryCycle.ts.
//
// Per broker (independent: each broker has its own cycle, leg, pending entry and retry count; `startCycle(..., [broker])`):
//   1. First entry as soon as the strategy is enabled: the ATM option of `right` (nearest expiry, also on its own expiry day), ONE limit buy at the
//      option's LTP, quantity from maxInvestment (per broker; maxInvestmentByBroker overrides one broker). Target and stop in option points from the fill.
//   2. Target hit: the position is sold at the target, and the SAME contract is bought again with a limit at the ORIGINAL bought price.
//   3. Stop hit: the position is sold at the stop, and the OPPOSITE right is bought at once (fresh ATM, limit at its LTP).
//   4. Drift: while ANY buy (the first entry or a re-buy) is unfilled and the option's LTP is more than `driftPoints` above its limit price, the order is
//      cancelled and the OPPOSITE right is bought (fresh ATM). A buy that has partly filled is not flipped: what filled is protected normally.
//   5. A close that is neither target nor stop (end of day, a manual sell) ends it on that broker. Nothing is bought after the end-of-day close.
// Every new buy first checks the global max-profit latch of (this strategy, that broker); the order process also refuses a latched buy.
//
// Config: right (CE|PE), maxInvestment, target, stopLoss (points or "N%"; both required, not none; block or settings), driftPoints (option points),
// brokers, index (NIFTY). entryTimeoutMinutes (block or settings) cancels an unfilled buy; the cycle then retries the same buy up to twice.
export default class ExpiryStrategy extends LimitEntryStrategy {
    protected readonly logTag = `Expiry:${this.userId}`;
    protected readonly strategyType = 'ExpiryStrategy';
    private niftyLtp = 0;
    private placingNext = false;
    private drifting = new Set<string>(); // brokers whose drift cancel is in flight (decideCycleEnd must not see the half-way state)
    private driftWarned = false;
    private rightWarned = false;

    reset(): void {
        super.reset();
        this.driftWarned = false;
        this.rightWarned = false;
    }

    protected index(): 'NIFTY' {
        return 'NIFTY';
    }

    // The expiring contract is traded on its own expiry day (the global skipNearestExpiryOnExpiryDay would move it to next week).
    protected skipNearestExpiryDay(): boolean | undefined {
        return expiryDayOverrideOf(this.cfg()) ?? false;
    }

    private exState(): ExState {
        if (!this.state.ex || !this.state.ex.brokers) this.state.ex = { brokers: {} };
        return this.state.ex;
    }

    private bs(broker: string): ExBroker {
        const ex = this.exState();
        if (!ex.brokers[broker]) ex.brokers[broker] = {};
        return ex.brokers[broker];
    }

    private configuredRight(): Right | null {
        const r = String((this.cfg() as any).right ?? '').toUpperCase();
        return r === 'CE' || r === 'PE' ? r : null;
    }

    private driftPoints(): number | null {
        const n = Number((this.cfg() as any).driftPoints);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    private legBusy(broker: string): boolean {
        const leg = this.state.legs[broker];
        return !!leg && (this.isActive(leg) || this.entryOpen(leg));
    }

    private cycleKey(broker: string, seq: number): string {
        return `${localDayKey()} EX-${broker}-${seq}`;
    }

    // ---- exits (target AND stop, from this block or settings; same rules as the other limit-entry strategies) ----

    protected exitRules(): ExitRules {
        return exitRulesFrom(this.setting('target'), this.setting('stopLoss'), this.logTag);
    }

    private exitFor(avg: number): { target: number; stop: number } {
        const rules = this.exitRules();
        if (!rules.target || !rules.stop) throw new Error('target and stopLoss must both be set (not none) for this strategy');
        const target = roundToTick(avg + exitDistance(rules.target, avg));
        const stopDist = exitDistance(rules.stop, avg);
        if (avg - stopDist <= 0) throw new Error(`stopLoss of ${stopDist} points is not below zero for a fill of ${avg}`);
        return { target, stop: Math.max(roundToTick(avg - stopDist), 0.05) };
    }

    protected async placeExit(leg: Leg): Promise<void> {
        const ex = this.exitFor(this.avgPrice(leg));
        await this.protectLeg(leg, ex.target, ex.stop);
    }

    protected async topUpExit(leg: Leg, delta: number): Promise<void> {
        if (leg.exit === 'exitMonitor' || leg.exit === 'none') return; // sized off the position when it triggers
        if (leg.exit === 'gtt') {
            await OrderClient.getInstance().cancelProtection(this.userId, { broker: leg.broker as any, tradingSymbol: leg.tsym });
            leg.exit = undefined;
            leg.exitQty = 0;
            await this.placeExit(leg);
            return;
        }
        const ex = this.exitFor(this.avgPrice(leg));
        await OrderClient.getInstance().brokerPlaceLimitSellBare(this.userId, {
            broker: leg.broker as any, tradingSymbol: leg.tsym, instrumentToken: leg.token, quantity: delta, price: ex.target, exchange: leg.exchange,
        });
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: extra resting sell ${delta} @ ${ex.target} for the later fill`);
    }

    // ---- option ticks: the drift of an unfilled buy, then the usual tick stop of a held leg ----

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.legs().some((l) => l.token === String(quote.token) && this.unfilledBuy(l)) || super.canHandleOptionQuote(quote);
    }

    private unfilledBuy(leg: Leg): boolean {
        return leg.status === 'resting' && leg.filledQty === 0 && !leg.entryCancelled;
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (!this.enabled) return;
        const ltp = Number(quote.ltp);
        const limit = this.driftPoints();
        if (limit !== null) {
            for (const leg of this.legs()) {
                if (leg.token !== String(quote.token) || !this.unfilledBuy(leg) || this.drifting.has(leg.broker)) continue;
                if (drifted(ltp, leg.price, limit)) await this.onDrift(leg, ltp, limit);
            }
        }
        await super.processOptionQuote(quote);
    }

    // The buy is cancelled and the opposite right becomes the broker's pending entry. Only when the cancel really left nothing filled: a partial fill
    // (or a failed cancel, retried on a later tick) never flips.
    private async onDrift(leg: Leg, ltp: number, limit: number): Promise<void> {
        const broker = leg.broker;
        const b = this.bs(broker);
        const right = b.cycleRight;
        if (!right || !b.seq) return;
        this.drifting.add(broker);
        try {
            Log.log(`[${this.logTag}] DRIFT on ${broker} ${leg.tsym}: ltp ${ltp} is more than ${limit} above the unfilled buy @ ${leg.price} - cancelling it`);
            await this.cancelEntry(leg, 'price drifted away');
            if (leg.status !== 'cancelled' || leg.filledQty > 0) return;
            unwatchTokenOnSource('ant', leg.token, this, leg.exchange);
            b.decidedKey = this.cycleKey(broker, b.seq); // this cycle's end is decided here (not the nothing-filled retry)
            b.retries = 0;
            b.pending = { right: opposite(right), reason: 'drift: buy the opposite right', at: Date.now() };
            this.save();
            Log.log(`[${this.logTag}] ${broker}: ${right} buy cancelled after the drift -> BUY ${b.pending.right} next`);
        } finally {
            this.drifting.delete(broker);
        }
    }

    // ---- cycle end: what happened to THIS broker's position decides ITS next step ----

    private pastEntryWindow(): boolean {
        return isPastEodClose();
    }

    private decideCycleEnd(broker: string): void {
        const b = this.bs(broker);
        if (!b.seq || this.drifting.has(broker)) return;
        const key = this.cycleKey(broker, b.seq);
        if (b.decidedKey === key || this.legBusy(broker)) return;
        b.decidedKey = key;
        const right = b.cycleRight ?? this.configuredRight();
        const leg = this.state.legs[broker];
        const tag = `${broker} cycle ${key}`;
        if (!leg || leg.filledQty <= 0) {
            const tries = b.retries ?? 0;
            if (right && tries < MAX_ENTRY_RETRIES && !this.pastEntryWindow()) {
                b.retries = tries + 1;
                b.pending = { right, price: b.cyclePrice, strike: b.cyclePrice !== undefined ? b.cycleStrike : undefined, reason: 'entry not filled', at: Date.now() };
                Log.log(`[${this.logTag}] ${tag} ended with nothing filled (entry refused, cancelled or unaffordable) - trying ${right} again (${b.retries}/${MAX_ENTRY_RETRIES})`);
            } else {
                Log.log(`[${this.logTag}] ALERT: ${tag} ended with nothing filled${tries >= MAX_ENTRY_RETRIES ? ` ${tries} times in a row` : ''} - no further entry today on ${broker}`);
            }
            this.save();
            return;
        }
        b.retries = 0;
        if (leg.soldQty <= 0 || !right) { this.save(); return; }
        if (this.pastEntryWindow()) {
            Log.log(`[${this.logTag}] ${tag} ended at or after the end-of-day close - no further entry on ${broker}`);
            this.save();
            return;
        }
        const entry = this.avgPrice(leg);
        let ex: { target: number; stop: number };
        try { ex = this.exitFor(entry); } catch (e: any) { Log.log(`[${this.logTag}] ALERT: ${tag}: ${e?.message ?? e} - no further entry on ${broker}`); this.save(); return; }
        const exitPx = leg.soldValue / leg.soldQty;
        const kind = classifyExit(entry, exitPx, ex.target, ex.stop);
        const next = nextAfterExit(kind, right, b.cycleStrike, entry);
        if (next) {
            b.pending = next;
            Log.log(`[${this.logTag}] ${kind === 'target' ? 'TARGET' : 'STOP'} on ${broker}: ${right} ${leg.tsym} bought @ ${entry.toFixed(2)}, sold @ ${exitPx.toFixed(2)} (target ${ex.target}, stop ${ex.stop}) -> ${next.reason}${next.price !== undefined ? ` @ ${next.price.toFixed(2)}` : ''}: BUY ${next.right}`);
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
        this.exState();
        const brokers = configuredBrokersOf(this.cfg() as any);
        for (const broker of brokers) {
            if (!this.placingNext) this.decideCycleEnd(broker); // not while an entry is being placed: its leg is not recorded yet
            const leg = this.state.legs[broker];
            if (leg && this.unfilledBuy(leg) && this.driftPoints() !== null) this.armSelfStop(leg); // the drift needs the option's ticks (idempotent; also after a restart)
        }
        if (this.driftPoints() === null && !this.driftWarned) { this.driftWarned = true; Log.log(`[${this.logTag}] ALERT: driftPoints (${(this.cfg() as any).driftPoints}) must be a positive number - the drift flip is OFF`); }
        for (const broker of brokers) this.maybeFirstEntry(broker);
        for (const broker of brokers) await this.runPending(broker);
    }

    // The first entry on one broker becomes a pending entry the moment the strategy is enabled (same gates and placement as every later entry).
    private maybeFirstEntry(broker: string): void {
        const b = this.bs(broker);
        if (b.seq || b.pending) return;
        const side = this.configuredRight();
        if (!side) {
            if (!this.rightWarned) Log.log(`[${this.logTag}] ALERT: right (${(this.cfg() as any).right}) must be CE or PE - not trading`);
            this.rightWarned = true;
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
        if (this.legBusy(broker) || this.drifting.has(broker)) return; // this broker's leg is still placing / resting / held: wait until it is flat
        if (!(this.niftyLtp > 0)) return;
        if (this.pastEntryWindow()) return drop('the end-of-day close has passed');
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
            const strike = p.price !== undefined && p.strike ? p.strike : atmStrike(this.niftyLtp);
            b.pending = undefined;
            b.cycleRight = p.right;
            b.cycleStrike = strike;
            b.cyclePrice = p.price;
            this.save();
            Log.log(`[${this.logTag}] ${broker} ${p.reason}: BUY ${p.right} ${strike} (nearest expiry)${p.price !== undefined ? ` limit ${p.price.toFixed(2)}` : ' limit at the best bid'} [${key}]`);
            await this.startCycle(key, { index: 'NIFTY', strike, right: p.right }, (br) => investmentForBroker(this.cfg() as any, br),
                // A fixed price (buy again at the original price) stays as given; otherwise undefined = the central order price (the best bid).
                p.price !== undefined ? async () => roundToTick(p.price as number) : undefined, [broker]);
            const leg = this.state.legs[broker];
            if (leg && this.unfilledBuy(leg) && this.driftPoints() !== null) this.armSelfStop(leg);
        } finally {
            this.placingNext = false;
        }
    }
}
