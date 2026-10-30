import * as fs from 'fs';
import * as path from 'path';
import Log from '../util/Log';
import { Strategy } from './strategy';
import { localDayKey } from './dayKey';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import { OrderCancelledNotification, NOT_PLACED_TAG } from '../ipc/orderProtocol';
import OrderClient from '../processes/strategies/OrderClient';
import configService from '../prism/ConfigService';
import { StrategyInstanceConfig } from '../prism/AppConfig';
import { roundToTick } from '../util/tick';
import { NIFTY_FREEZE_QUANTITY, SENSEX_FREEZE_QUANTITY, INDEX_LOT_SIZE } from '../constants';
import { configuredBrokersOf } from '../util/brokerName';
import { isPastTime } from '../util/marketHours';
import { watchTokenOnSource, unwatchTokenOnSource } from '../processes/strategies/tokenRouter';

// Shared engine of RecommendationStrategy and NiftyChangeStrategy: one LIMIT buy per configured broker, sized from a rupee budget,
// then an exit the subclass chooses once the entry has filled. Owns everything that is the same for both: per-broker legs, state
// persisted to disk (a restart must never place the same entry twice), fill and cancel accounting, the entry timeout, the
// end-of-day cancel/close and the retry of a failed exit placement.
//
// Only ever one cycle (one set of legs) is live at a time: a new cycle is refused while any leg is still resting or holding a
// position, because fills are attributed to a leg by (broker, tradingSymbol) and two cycles on one contract would be ambiguous.

const LOT_SIZE: Record<string, number> = INDEX_LOT_SIZE;
const FREEZE_QTY: Record<string, number> = { NIFTY: NIFTY_FREEZE_QUANTITY, SENSEX: SENSEX_FREEZE_QUANTITY };
const HOUSEKEEPING_INTERVAL_MS = 1000;
const RETRY_BACKOFF_MS = 30_000;
const MAX_EXIT_ATTEMPTS = 10;

export type LegStatus = 'placing' | 'resting' | 'filled' | 'closed' | 'cancelled' | 'failed';
export type ExitKind = 'gtt' | 'exitMonitor' | 'resting' | 'self' | 'none';

export interface Leg {
    broker: string;
    tsym: string;
    token: string;
    exchange: 'NFO' | 'BFO';
    qty: number; // quantity ordered; shrunk to what actually filled once the entry order is cancelled
    price: number; // limit price of the entry order
    orderId?: string;
    status: LegStatus;
    placedAt: number;
    filledQty: number;
    boughtValue: number;
    soldQty: number;
    soldValue: number;
    entryCancelled?: boolean; // the entry order was cancelled; no fills beyond `qty` are expected
    exit?: ExitKind;
    exitAttempts?: number;
    exitRetryAt?: number;
    exitQty?: number; // quantity the exit currently covers; below filledQty while later partial fills still need protecting
    stop?: number; // tick-driven stop: market out when the option's LTP falls to this (set only for a self-managed exit)
    closing?: boolean; // an EOD/stop close is in flight or done - never started twice
    outcomeRecorded?: boolean;
}

export interface State {
    day: string;
    keys: string[]; // cycle keys already started today (a restart must not repeat one)
    legs: Record<string, Leg>;
    // NiftyChangeStrategy only: Nifty's LTP at the last slot evaluated today, kept here so a restart still has the reference.
    slotPrice?: number | null;
}

export interface ResolvedEntry {
    index: 'NIFTY' | 'SENSEX';
    strike: number;
    right: 'CE' | 'PE';
}

export abstract class LimitEntryStrategy extends Strategy {
    protected state: State = { day: localDayKey(), keys: [], legs: {} };
    private loaded = false;
    private busy = false;
    private lastHousekeeping = 0;
    private placing = false;

    protected abstract readonly logTag: string;
    protected abstract readonly strategyType: string;
    // Called once an entry leg is fully filled (or cancelled with a partial fill): place the exit. Throw to have it retried.
    protected abstract placeExit(leg: Leg): Promise<void>;
    // More of the entry filled after the exit was placed: cover the extra `delta` (a resting-sell exit sells `delta` more at the target;
    // a GTT is re-attached for the whole quantity). Throw to have it retried.
    protected abstract topUpExit(leg: Leg, delta: number): Promise<void>;
    // The subclass's own per-tick work (slot firing / one-shot placement). Runs only while enabled.
    protected abstract onNiftyTick(quote: NiftyQuote): Promise<void>;
    // Called once the cycle is over: no leg holds or rests and no entry is still open (sold out, cancelled with nothing filled, or every
    // broker's entry refused). Nothing by default; RecommendationStrategy disables its block in config.yml here.
    protected async onCycleEnded(): Promise<void> {}

    receive(oldStats: any, newStats: any) {}

    protected cfg(): StrategyInstanceConfig {
        return configService.getInstanceConfig(this.strategyType, this.userId);
    }

    protected brokers(): string[] {
        return configuredBrokersOf(this.cfg() as any);
    }

    protected index(): 'NIFTY' | 'SENSEX' {
        return (this.cfg() as any).index === 'SENSEX' ? 'SENSEX' : 'NIFTY';
    }

    // ---- persistence ----

    private stateFile(): string {
        return path.join(__dirname, `../../.${this.strategyType}.${this.userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }

    private ensureLoaded(): void {
        const today = localDayKey();
        if (this.loaded && this.state.day === today) return;
        this.loaded = true;
        let fresh: State = { day: today, keys: [], legs: {} };
        try {
            const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as State;
            if (raw?.day === today) fresh = raw;
            else if (raw?.legs) {
                // A previous day's leg that never closed is not managed any more (strategies hold no state across days): say so.
                for (const leg of Object.values(raw.legs)) {
                    if (leg.status === 'filled' || leg.status === 'resting' || leg.status === 'placing') {
                        Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym} from ${raw.day} was still ${leg.status} (filled ${leg.filledQty}, sold ${leg.soldQty}) when the day rolled over - check the broker position by hand`);
                    }
                }
            }
        } catch { /* no file yet */ }
        this.state = fresh;
        for (const leg of Object.values(this.state.legs)) this.rewatch(leg);
    }

    // Returns false when the state could not be written. Callers that are about to place an order must then not place it.
    protected save(): boolean {
        try {
            fs.writeFileSync(this.stateFile(), JSON.stringify(this.state));
            return true;
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: could not persist state: ${e?.message ?? e}`);
            return false;
        }
    }

    // ---- helpers for subclasses ----

    protected legs(): Leg[] {
        return Object.values(this.state.legs);
    }

    protected isActive(leg: Leg): boolean {
        return leg.status === 'placing' || leg.status === 'resting' || (leg.status === 'filled' && leg.soldQty < leg.filledQty);
    }

    protected hasActiveLeg(): boolean {
        return this.legs().some((l) => this.isActive(l));
    }

    // An entry order still open at the broker: not cancelled, not refused, and not every share filled. Its leg can already be
    // 'closed' (the part that filled was sold) while the rest of the entry can still fill, so it keeps the cycle alive.
    private entryOpen(leg: Leg): boolean {
        return !leg.entryCancelled && leg.status !== 'failed' && leg.status !== 'cancelled' && leg.filledQty < leg.qty;
    }

    // Fires onCycleEnded once nothing is live. Called from the paths where a cycle can end, and from housekeeping so a restart that finds
    // the last leg already closed still ends the cycle. Guarded by a started cycle: a block that has not traded yet is never "ended".
    private async endIfIdle(): Promise<void> {
        if (this.state.keys.length === 0) return;
        if (this.legs().some((l) => this.isActive(l) || this.entryOpen(l))) return;
        await this.onCycleEnded();
    }

    // Durable per-day value used by NiftyChangeStrategy as the previous slot's Nifty price (null = none recorded today).
    protected getSlotPrice(): number | null {
        this.ensureLoaded();
        return this.state.slotPrice ?? null;
    }

    protected setSlotPrice(price: number | null): void {
        this.ensureLoaded();
        if ((this.state.slotPrice ?? null) === price) return;
        this.state.slotPrice = price;
        this.save();
    }

    protected cycleStarted(key: string): boolean {
        this.ensureLoaded();
        return this.state.keys.includes(key);
    }

    // Records a cycle key as used without placing anything (a skipped or refused slot), so a restart cannot revive it.
    protected markCycle(key: string): void {
        this.ensureLoaded();
        if (!this.state.keys.includes(key)) { this.state.keys.push(key); this.save(); }
    }

    protected avgPrice(leg: Leg): number {
        return leg.filledQty > 0 ? leg.boughtValue / leg.filledQty : leg.price;
    }

    // Quantity for one order: whole lots that fit the rupee budget at `price`, capped at one freeze-quantity order.
    protected sizeOrder(budget: number, price: number, index: 'NIFTY' | 'SENSEX'): number {
        const lot = LOT_SIZE[index];
        if (!(price > 0) || !(budget > 0)) return 0;
        const lots = Math.floor(budget / (price * lot));
        const cap = Math.floor(FREEZE_QTY[index] / lot);
        if (lots > cap) Log.log(`[${this.logTag}] budget ${budget} would buy ${lots} lots at ${price}; capped at one freeze-size order (${cap} lots)`);
        return Math.min(lots, cap) * lot;
    }

    private rewatch(leg: Leg): void {
        if (leg.stop && leg.status === 'filled' && leg.soldQty < leg.filledQty) this.armSelfStop(leg);
    }

    // Starts the tick feed a tick-driven stop (leg.stop) needs. Ticks for every broker's contract come from the ANT feed.
    protected armSelfStop(leg: Leg): void {
        watchTokenOnSource('ant', leg.token, this, leg.exchange);
    }

    private unwatch(leg: Leg): void {
        unwatchTokenOnSource('ant', leg.token, this, leg.exchange);
    }

    // Starts a cycle: one limit buy per configured broker. `priceFor` is asked once per broker for that broker's limit price.
    // The cycle key and every leg are persisted BEFORE the order goes out, so a crash or restart mid-way can never place it twice;
    // an order whose outcome is unknown is left as a leg and never retried blind.
    protected async startCycle(key: string, entry: ResolvedEntry, budget: number, priceFor: (c: { tsym: string; token: string; exchange: 'NFO' | 'BFO' }) => Promise<number>): Promise<void> {
        this.ensureLoaded();
        if (this.placing) return; // callers check cycleStarted(key) first and may have marked the key already
        if (this.hasActiveLeg()) {
            Log.log(`[${this.logTag}] ${key}: a previous cycle is still live - not starting another`);
            this.state.keys.push(key);
            this.save();
            return;
        }
        this.placing = true;
        try {
            if (!this.state.keys.includes(key)) this.state.keys.push(key);
            this.state.legs = {};
            if (!this.save()) { return; }
            const brokers = this.brokers();
            const perBroker = budget / Math.max(1, brokers.length);
            for (const broker of brokers) {
                try {
                    const contract = await OrderClient.getInstance().resolveOptionContract(this.userId, { broker: broker as any, index: entry.index, strike: entry.strike, right: entry.right });
                    const price = roundToTick(await priceFor(contract));
                    const qty = this.sizeOrder(perBroker, price, entry.index);
                    if (!(price > 0) || qty <= 0) {
                        Log.log(`[${this.logTag}] ${key} ${broker} ${contract.tsym}: nothing to buy (price=${price}, budget=${perBroker}) - skipped`);
                        continue;
                    }
                    const leg: Leg = { broker, tsym: contract.tsym, token: contract.token, exchange: contract.exchange, qty, price, status: 'placing', placedAt: Date.now(), filledQty: 0, boughtValue: 0, soldQty: 0, soldValue: 0 };
                    this.state.legs[broker] = leg;
                    if (!this.save()) { delete this.state.legs[broker]; continue; }
                    try {
                        const { orderId } = await OrderClient.getInstance().placeLimitBuyBare(this.userId, contract.tsym, contract.token, qty, price, contract.exchange, broker as any);
                        leg.orderId = orderId;
                        leg.status = 'resting';
                        Log.log(`[${this.logTag}] ${key} ${broker}: limit BUY ${contract.tsym} qty=${qty} @ ${price} placed (order ${orderId})`);
                    } catch (e: any) {
                        const msg = String(e?.message ?? e);
                        leg.status = 'failed';
                        Log.log(msg.includes(NOT_PLACED_TAG)
                            ? `[${this.logTag}] ${key} ${broker}: entry refused (${msg}) - nothing placed`
                            : `[${this.logTag}] ALERT: ${key} ${broker} ${contract.tsym}: entry order outcome UNKNOWN (${msg}) - it may be live at the broker; NOT retried, check by hand`);
                    }
                    this.save();
                } catch (e: any) {
                    Log.log(`[${this.logTag}] ${key} ${broker}: could not start entry: ${e?.message ?? e}`);
                }
            }
            // Nothing live after the pass (every broker skipped or refused): the cycle is already over.
            await this.endIfIdle();
        } finally {
            this.placing = false;
        }
    }

    // ---- Strategy hooks ----

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled) return;
        this.ensureLoaded();
        try { await this.onNiftyTick(quote); } catch (e) { Log.log(`[${this.logTag}] tick handler failed:`, e); }
        const now = Date.now();
        if (this.busy || now - this.lastHousekeeping < HOUSEKEEPING_INTERVAL_MS) return;
        this.busy = true;
        this.lastHousekeeping = now;
        try { await this.housekeeping(); } catch (e) { Log.log(`[${this.logTag}] housekeeping failed:`, e); } finally { this.busy = false; }
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.legs().some((l) => l.token === String(quote.token) && !!l.stop && l.status === 'filled');
    }

    // Tick-driven stop for a 'self' exit (used when a broker has no post-fill protection, or attaching it failed).
    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (!this.enabled) return;
        for (const leg of this.legs()) {
            if (leg.token !== String(quote.token) || !leg.stop || leg.status !== 'filled' || leg.closing) continue;
            if (quote.ltp > 0 && quote.ltp <= leg.stop) {
                Log.log(`[${this.logTag}] STOP hit on ${leg.broker} ${leg.tsym}: ltp ${quote.ltp} <= ${leg.stop}`);
                await this.closeLeg(leg, 'stop loss');
            }
        }
    }

    updateTrade = async (trade: Trade): Promise<void> => {
        if (!this.enabled) return;
        this.ensureLoaded();
        const leg = this.legFor(trade.tsym, trade.broker);
        if (!leg) return;
        const qty = Number(trade.quantity) || 0;
        const price = Number(trade.price) || 0;
        if (trade.action === 'Buy') {
            if (this.foreignEntryOrder(leg, trade.brokerOrderId)) {
                Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym}: Buy fill of ${qty} from order ${trade.brokerOrderId} is not this leg's entry order ${leg.orderId} - ignored (POST /reconcile adopts it if it really is ours)`);
                return;
            }
            leg.filledQty += qty;
            leg.boughtValue += qty * price;
            if (leg.status === 'resting' || leg.status === 'placing') leg.status = 'filled';
            if (leg.exit && leg.filledQty > leg.qty) Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym}: a late entry fill took the position to ${leg.filledQty} (ordered ${leg.qty}) - extending the exit over the extra`);
            this.save();
            await this.protectFilled(leg);
        } else if (trade.action === 'Sell') {
            leg.soldQty += qty;
            leg.soldValue += qty * price;
            if (leg.soldQty >= leg.filledQty) {
                leg.status = 'closed';
                this.unwatch(leg);
                this.recordOutcomeOnce(leg);
            }
            this.save();
            await this.endIfIdle();
        }
    };

    onOrderCancelled = async (n: OrderCancelledNotification): Promise<void> => {
        if (!this.enabled || n.action !== 'Buy') return;
        const leg = this.legFor(n.tradingSymbol, n.broker);
        if (!leg || leg.entryCancelled) return;
        if (this.foreignEntryOrder(leg, n.orderId)) {
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: ${n.reason} of order ${n.orderId} is not this leg's entry order ${leg.orderId} - ignored`);
            return;
        }
        leg.entryCancelled = true;
        Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: entry order ${n.reason}${n.rejectReason ? ' (' + n.rejectReason + ')' : ''} - filled ${leg.filledQty} of ${leg.qty}`);
        await this.afterEntryClosed(leg);
    };

    // Adopts positions the order process knows about (POST /reconcile): a fill missed while this process was down.
    async reconcile(): Promise<void> {
        this.ensureLoaded();
        let open: any[] = [];
        try { open = await OrderClient.getInstance().getOpenTrades(this.userId); } catch (e) { Log.log(`[${this.logTag}] reconcile: could not read open trades:`, e); return; }
        for (const leg of this.legs()) {
            if (leg.status !== 'resting' && leg.status !== 'filled') continue;
            const held = open.filter((t) => t.tsym === leg.tsym && (t.broker ?? 'kite') === leg.broker).reduce((s, t) => s + Math.max(0, Number(t.quantity) || 0), 0);
            const row = open.find((t) => t.tsym === leg.tsym && (t.broker ?? 'kite') === leg.broker);
            if (held > leg.filledQty - leg.soldQty && row) {
                const missed = held - (leg.filledQty - leg.soldQty);
                Log.log(`[${this.logTag}] reconcile: ${leg.broker} ${leg.tsym} holds ${held}, ${missed} more than tracked - adopting`);
                leg.filledQty += missed;
                leg.boughtValue += missed * (Number(row.price) || leg.price);
                leg.status = 'filled';
                this.save();
                await this.protectFilled(leg);
            }
        }
    }

    reset(): void {
        super.reset();
        this.state = { day: localDayKey(), keys: [], legs: {} };
        this.loaded = true;
        this.save();
    }

    // ---- internals ----

    private legFor(tsym: string, broker?: string): Leg | undefined {
        const b = broker ? String(broker).toLowerCase() : undefined;
        return this.legs().find((l) => l.tsym === tsym && (!b || l.broker === b) && l.status !== 'closed' && l.status !== 'failed' && l.status !== 'cancelled')
            ?? this.legs().find((l) => l.tsym === tsym && (!b || l.broker === b));
    }

    // A Buy fill or Buy cancellation belongs to a leg only if it comes from the leg's own entry order. A leg is found by (broker, tsym),
    // which alone cannot tell the entry order from another buy on the same contract. Not decidable (so accepted) when either id is
    // missing: the leg is still 'placing' (a fill can land before placeLimitBuyBare returns its id) or the event carries no order id.
    // Sell fills are not checked: the exits (GTT trigger, exitMonitor, chunked square-off) place sells whose ids this strategy never sees.
    private foreignEntryOrder(leg: Leg, orderId?: string): boolean {
        return !!leg.orderId && !!orderId && String(orderId) !== String(leg.orderId);
    }

    private recordOutcomeOnce(leg: Leg): void {
        if (leg.outcomeRecorded || leg.filledQty <= 0) return;
        leg.outcomeRecorded = true;
        const pnl = leg.soldValue - leg.boughtValue * (leg.soldQty / leg.filledQty);
        this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
    }

    // Whatever has filled so far is protected straight away - a partial fill must not sit bare until the rest arrives (or the entry is
    // cancelled at end of day). The first fill places the exit; later fills top it up.
    private async protectFilled(leg: Leg): Promise<void> {
        if (leg.closing || leg.filledQty <= 0) return;
        if (!leg.exit) {
            await this.entryComplete(leg);
        } else if ((leg.exitQty ?? 0) < leg.filledQty) {
            await this.topUp(leg);
        }
    }

    private toppingUp = new Set<Leg>();
    private async topUp(leg: Leg): Promise<void> {
        if (this.toppingUp.has(leg) || leg.closing) return;
        this.toppingUp.add(leg);
        try {
            let covered = leg.exitQty ?? 0;
            while (covered < leg.filledQty && !leg.closing) {
                const target = leg.filledQty; // a fill that lands while this runs is picked up by the next pass of the loop
                try {
                    await this.topUpExit(leg, target - covered);
                } catch (e: any) {
                    Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym}: could not extend the exit over ${target - covered} more filled (covered ${covered}/${leg.filledQty}) - that part is UNPROTECTED until the next housekeeping retry: ${e?.message ?? e}`);
                    break;
                }
                covered = target;
                leg.exitQty = covered;
            }
        } finally {
            this.toppingUp.delete(leg);
        }
        this.save();
    }

    private async entryComplete(leg: Leg): Promise<void> {
        if (leg.exit || leg.closing || leg.exitRetryAt === -1) return;
        leg.exitRetryAt = -1; // placement in flight: housekeeping must not start a second one
        await this.tryPlaceExit(leg);
    }

    private async tryPlaceExit(leg: Leg): Promise<void> {
        leg.exitAttempts = (leg.exitAttempts ?? 0) + 1;
        const covered = leg.filledQty; // placeExit sizes off filledQty as it is now; a fill that lands during placement is topped up below
        try {
            await this.placeExit(leg);
            leg.exitRetryAt = undefined;
            if (leg.exit && leg.exit !== 'none') leg.exitQty = covered;
            if (leg.exit && leg.filledQty > covered) await this.topUp(leg);
        } catch (e: any) {
            leg.exitRetryAt = leg.exitAttempts >= MAX_EXIT_ATTEMPTS ? Number.MAX_SAFE_INTEGER : Date.now() + RETRY_BACKOFF_MS;
            Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym} qty=${leg.filledQty} FILLED but exit placement failed (attempt ${leg.exitAttempts}/${MAX_EXIT_ATTEMPTS}) - position is UNPROTECTED${leg.exitAttempts >= MAX_EXIT_ATTEMPTS ? ' and will NOT be retried' : ', retrying'}: ${e?.message ?? e}`);
        }
        this.save();
    }

    private async afterEntryClosed(leg: Leg): Promise<void> {
        if (leg.filledQty <= 0) {
            leg.status = 'cancelled';
            this.save();
            await this.endIfIdle();
            return;
        }
        leg.qty = leg.filledQty; // nothing more will fill
        leg.status = 'filled';
        this.save();
        await this.entryComplete(leg);
    }

    // Cancels a resting entry. The cancel reports quantity that filled in its window; those fills are still delivered through
    // updateTrade, so the leg is only finished once they have all arrived.
    protected async cancelEntry(leg: Leg, why: string): Promise<void> {
        if ((leg.status !== 'resting' && leg.status !== 'filled') || leg.entryCancelled) return;
        try {
            const res = await OrderClient.getInstance().cancelRestingLimitBuys(this.userId, { tradingSymbol: leg.tsym, broker: leg.broker as any });
            if (res.cancelFailed) {
                Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym}: cancel of the entry (${why}) failed - the order may still be live; retrying`);
                return;
            }
            leg.entryCancelled = true;
            leg.qty = leg.filledQty + (res.filledQty || 0);
            Log.log(`[${this.logTag}] ${leg.broker} ${leg.tsym}: entry cancelled (${why}); filled ${leg.filledQty}${res.filledQty ? ' + ' + res.filledQty + ' in the cancel window' : ''}`);
            if (leg.qty <= 0) { leg.status = 'cancelled'; this.save(); await this.endIfIdle(); return; }
            this.save();
            if (leg.filledQty >= leg.qty) { leg.status = 'filled'; await this.entryComplete(leg); }
        } catch (e: any) {
            Log.log(`[${this.logTag}] ALERT: ${leg.broker} ${leg.tsym}: cancel of the entry (${why}) errored, retrying: ${e?.message ?? e}`);
        }
    }

    // Takes a held leg off the book at market: removes the protection first (a surviving GTT could sell a flat account later), then
    // the resting target sell, then sells what is still held.
    protected async closeLeg(leg: Leg, why: string): Promise<void> {
        if (leg.closing || leg.status !== 'filled') return;
        leg.closing = true;
        try {
            if (leg.exit === 'gtt' || leg.exit === 'exitMonitor') {
                await OrderClient.getInstance().cancelProtection(this.userId, { broker: leg.broker as any, tradingSymbol: leg.tsym });
            }
            let alreadySold = 0;
            const c = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: leg.tsym, broker: leg.broker as any });
            if (c.cancelFailed) throw new Error('could not cancel the resting target sell - selling now could oversell');
            alreadySold = c.filledQty || 0;
            const remaining = leg.filledQty - leg.soldQty - alreadySold;
            if (remaining > 0) {
                Log.log(`[${this.logTag}] closing ${leg.broker} ${leg.tsym} qty=${remaining} (${why})`);
                await OrderClient.getInstance().chunkedSquareOff(this.userId, { tradingSymbol: leg.tsym, quantity: remaining, broker: leg.broker as any });
            }
        } catch (e: any) {
            leg.closing = false; // retried on the next housekeeping pass
            Log.log(`[${this.logTag}] ALERT: closing ${leg.broker} ${leg.tsym} (${why}) failed, will retry: ${e?.message ?? e}`);
        }
        this.save();
    }

    private async housekeeping(): Promise<void> {
        const cfg = this.cfg() as any;
        const eod = isPastTime(cfg.eodCloseTime, '15:10');
        const timeoutMs = Number(cfg.entryTimeoutMinutes) > 0 ? Number(cfg.entryTimeoutMinutes) * 60_000 : 0;
        const now = Date.now();
        await this.endIfIdle();
        for (const leg of this.legs()) {
            // The entry order is still open (possibly part-filled, in which case status is already 'filled').
            const entryOpen = (leg.status === 'resting' || leg.status === 'filled') && !leg.entryCancelled && leg.filledQty < leg.qty;
            if (entryOpen && (eod || (timeoutMs > 0 && now - leg.placedAt >= timeoutMs))) {
                await this.cancelEntry(leg, eod ? 'end of day' : `unfilled after ${cfg.entryTimeoutMinutes} min`);
            }
            // Only once every share of the entry has arrived is the leg's size final: exit placement and the EOD close use it.
            // Exit placement and its top-up need only SOME fill (every filled share is protected as it arrives); the EOD close waits for the
            // final size so it never sells while the entry could still fill.
            if (leg.status === 'filled' && leg.filledQty > 0 && !leg.closing) {
                if (!leg.exit && leg.exitRetryAt !== -1 && (leg.exitRetryAt ?? 0) <= now) await this.tryPlaceExit(leg);
                else if (leg.exit && (leg.exitQty ?? 0) < leg.filledQty) await this.topUp(leg);
            }
            if (leg.status === 'filled' && leg.filledQty >= leg.qty && eod && !leg.closing) await this.closeLeg(leg, 'end of day');
        }
    }
}
