import { NonFiniteAlert, profitTotalOf, shouldTrip } from './finiteGuard';
import * as fs from 'fs';
import * as path from 'path';
import Log from '../util/Log';
import GateLogger from '../util/GateLogger';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { brokerLegOps, chunkedLegSell } from './LegBrokerOps';
import { isUnconfirmedBuyError } from './LegManager';
import { resolveUnconfirmedBuy as resolveUnconfirmedBuyShared, UnconfirmedBuyResolution } from './unconfirmedBuy';
import { fetchOpenTradesWithRetry, heldQuantity } from './openTrades';
import { registerTrade, unregisterTrade } from '../processes/strategies/tokenRouter';
import { localDayKey } from './dayKey';
import { roundToTick, NFO_TICK_SIZE } from '../util/tick';
import { clearPrice, tripSellPrice, keepTripSell, TripGuard, TRIP_FILL_WAIT_MS } from './maxProfitLock';
import { effectiveMaxProfit } from './effectiveMaxProfit';
import { expiryDayOverrideOf } from '../util/expirySkip';
import { isPastEodClose } from '../util/eodClose';
import { BrokerName, normalizeBrokerName } from '../util/brokerName';
import { NOT_PLACED_TAG, OrderCancelledNotification } from '../ipc/orderProtocol';
import { MOCK_BROKER, PCR_WINDOW_POINTS, INDEX_LOT_SIZE, NIFTY_FREEZE_QUANTITY } from '../constants';

// ScaledHedgedStrategy: derived from SimpleContinuousStrategy (a separate class, SimpleContinuousStrategy is unchanged apart from rule E). Differences:
//   A. The root buys `initialQuantity` (e.g. 65), never the whole maxInvestment (onePositionPerSide no longer sizes the root).
//   B. A hedge buys initialQuantity + (leg entry - leg price now) / priceDiff * initialQuantity, floored to whole lots (never below
//      initialQuantity): a CE that fell by priceDiff gets a PE of 2 x initialQuantity (65 + 10/10 x 65 = 130). A hedge opened by a target
//      fill (the leg is at or above its entry) buys initialQuantity.
//   C. NO double-up. Instead, when a leg falls by priceDiff the OPPOSITE option is bought again (a hedge leg that falls buys the CE again).
//   D. Only ONE CE contract and ONE PE contract are used per cycle: the root's contract and the contract of the first hedge (ATM at that time).
//      Every later buy of a right uses that same contract: if its leg is open the quantity is ADDED to it (blended entry, the resting sell is
//      re-placed at the new average + priceDiff, and the leg's hedge trigger is re-armed from the new average); if it is closed a new leg opens.
//   F. maxInvestment is honoured by EVERY buy (root, hedge, add): a buy is cut to the whole lots that still fit under the cap (cost basis of the open
//      legs + the new buy at the contract's latest price), or skipped (held back and retried) when not even one lot fits.
//   G. A same-direction re-buy (after a target fill) is skipped when that contract already has an open leg.
//   E. (also in SimpleContinuousStrategy) When the FIRST order (root) closes at a profit with no hedge ever bought, it does not buy the same
//      direction again: the contract selection (PCR direction, premium floor, ATM pick) runs again for a new root and a new CE/PE pair.
// ScaledHedgedStrategy (config keys: initialQuantity, maxInvestment, priceDiff, plus enabled/brokers):
//   1. PCR gives the direction of the ROOT entry (PCR > 1 -> PE, else CE), `initialQuantity` at market. There is ONE root per day;
//      every later order is a hedge or a double-up. With `onePositionPerSide: true` `initialQuantity` is IGNORED: the root buys as many whole
//      lots as the free part of `maxInvestment` pays for at the picked premium (capped at the NIFTY freeze quantity).
//   2. Right after the fill a resting limit sell is placed at entry + priceDiff.
//   3. EVERY leg (root or hedge) is hedged exactly once, by buying the opposite option at the strike nearest the money for the same quantity, either when its price
//      falls to entry - priceDiff (adverse) or when its resting sell fills (target met, at the then-current price). The hedge buy is a
//      leg of its own with its own resting sell at its entry + priceDiff, and it is hedged once in turn, so the chain is unlimited.
//      A leg whose sell fills at a profit is followed by the SAME right (follow the direction), root and hedge legs alike; a hedge
//      triggered by an adverse move (nothing sold) or by a sell at a loss buys the opposite right. This is fixed, not configurable.
//   4. There is no stop loss: a leg ends only through its resting sell (or the EOD close).
//   5. When a hedge leg's sell fills at a profit and the leg that caused it (its parent) is still open, the parent is doubled ONCE
//      per leg (the same contract is bought again for the parent's quantity, its resting sell is re-placed for the new total at the
//      new average + priceDiff). maxInvestment does not gate it (2026-11-11).
//   5b. `maxProfit` (REQUIRED, rupees, per broker, no default in code): when the day's realized + unrealized P&L of this broker's legs, CE and PE
//      together, reaches it, every open leg is closed and the strategy stays idle for the rest of the day (persisted in the state file). The
//      total is measured from the start of counting (first load of a state file without the fields, or reset()), not from the morning: a leg
//      that was already open then is valued from its first tick after it (`pnlRef`), so it does not carry its earlier P&L into the total.
//   6. maxInvestment (per broker) gates the root only. Hedge buys and the double-up ignore it (a hedge refused by the cap would leave a
//      leg unprotected).
//   7. Stacking limits, two modes:
//      - `onePositionPerSide: true` (config flag, off by default): at most ONE open leg per side. A CE and a PE may coexist, but while a CE is
//        open no other CE order (hedge) is placed, likewise PE. The hedge waits un-placed (leg stays un-hedged, retried every 5 s) until the
//        side is free. The double-up (5) adds to the SAME open contract, so it does not make a second leg. maxLegsPerSide is ignored.
//      - otherwise, maxLegsPerSide (optional) stops the chain stacking one side in a trend: a new leg on a side that already has that many
//        open legs waits (the leg stays un-hedged and is retried on later ticks) until Nifty has moved back toward the root, i.e. at least
//        stackRecoveryPoints (default 20) away from the most adverse Nifty level at which an open leg on that side was bought (a CE side
//        stacks as Nifty falls, so it needs Nifty to be that far ABOVE its lowest entry level; a PE side the mirror image).
//   8. A hedge buy whose outcome is unconfirmed (timeout) is resolved against the broker instead of freezing the strategy: the resting
//      buy is cancelled and the live position read. Nothing bought -> the hedge flag is cleared and the hedge is retried; bought ->
//      the position is adopted as the hedge leg; unreadable -> manual review, as before.
//   9. The one-time double-up flag is set only when the double-up actually happens. A double-up skipped (cap, cancel failure, buy
//      refused) stays due and is retried from the parent's ticks (every DOUBLE_RETRY_MS) until it happens or the parent closes.
// State (hedged / doubled / quantities) is kept per day in a JSON file and checked against the broker's open trades at reconcile.

const PCR_RECHECK_MS = 5 * 60 * 1000;
const ROOT_MIN_PREMIUM = 100; // ContinuousStrategy's default; there is deliberately no config key for it
const SELL_RETRY_MS = 10_000;
const DOUBLE_RETRY_MS = 30_000;
const WAITING_HEDGE_RETRY_MS = 5_000;
const EOD_RETRY_MS = 5_000;
const DEFAULT_STACK_RECOVERY_POINTS = 20;

type Right = 'CE' | 'PE';

export interface SimpleLeg {
    id: string;
    tsym: string;
    token: string;
    exchange: 'NFO' | 'BFO';
    strike: number;
    right: Right;
    role: 'root' | 'hedge';
    parentId?: string;
    entry: number;       // weighted average entry price
    qty: number;         // total bought (open or sold)
    soldQty: number;     // sold so far (fill events)
    soldValue: number;
    hedged: boolean;     // a hedge has been bought for this leg (or this leg is one)
    doubled: boolean;    // the one-time double-up has been done (original legs only)
    status: 'open' | 'closed';
    sellQty: number;     // quantity currently resting as a limit sell
    sellShortfall?: number; // quantity of the leg with NO resting sell although others rest (a placement the broker clamped, or a restart that found fewer resting sells than the leg holds): placed from the leg's ticks
    sellPrice: number;
    niftyAt?: number;    // Nifty LTP when this leg was bought (the stacking guard's reference; absent on adopted / older legs)
    hedgeSame?: boolean; // the held-back hedge follows the leg's direction (it closed at a profit) instead of going opposite
    hedgeWaiting?: boolean; // the hedge for this leg is held back by the stacking guard (retried from Nifty ticks once the leg is closed)
    doubleDue?: boolean; // a profitable hedge sell asked for this (parent) leg to be doubled and it has not happened yet
    pnlRef?: number;        // price the maxProfit total values this leg from (blended on a double-up); absent = its entry
    pnlRefPending?: boolean; // the maxProfit counting started while the leg was open: pnlRef is set from its next tick
    restarted?: boolean;    // the FIRST order (root) closed at a profit with no hedge bought: no same-direction re-buy, the contract selection runs again for a new root
    added?: boolean;        // a later buy of the same contract was added to this leg (blended entry); the leg is no longer a never-hedged first order
    lastLtp?: number;       // last option tick (in memory use only; refreshed by ticks)
}

interface PairContract { tradingSymbol: string; token: string; exchange: 'NFO' | 'BFO'; strike: number; premium: number }
interface State { day: string; legs: Record<string, SimpleLeg>; pair?: { CE?: PairContract; PE?: PairContract }; seq: number; pnlStarted?: boolean; realizedPnl: number; profitTripped: boolean }

const opposite = (r: Right): Right => (r === 'CE' ? 'PE' : 'CE');

export default class ScaledHedgedStrategy extends Strategy {
    name = 'ScaledHedgedStrategy';
    legTokenFeed = 'ant' as const; // legs carry ANT tokens whatever broker places the orders

    private state: State = { day: '', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    private loaded = false;
    private lastNiftyLtp = 0;
    private capHeld = new Set<string>(); // legs whose hedge is waiting for maxInvestment room (no log spam on each retry)
    private pairPx = new Map<string, number>(); // latest tick price of each contract of the pair (open or not), for the maxInvestment check
    private lastPcr: { value: number; at: number } | null = null;
    private entering = false;
    private manualReview = false; // an unconfirmed buy may be live: no new buys until a human looks and reset() clears it
    private blocked = false;      // reconcile could not read the open trades: no new entries
    private pendingSides = new Set<Right>();    // sides with a hedge buy in flight (not yet an open leg), so two hedges cannot both pass the one-per-side check
    private tripGuard = new TripGuard(); // retry backoff / fill-event wait of the maxProfit trip sells (in memory throttle only)
    private busy = new Set<string>();           // leg ids with a hedge / double-up / sell placement in flight
    private lastSellAttempt = new Map<string, number>();
    private lastEodAttempt = 0;
    private lastWaitingHedgeRetry = 0;
    private lastDoubleAttempt = new Map<string, number>();
    private gateLog = new GateLogger('[ScaledHedgedStrategy] gate:', PCR_RECHECK_MS);

    constructor(userId?: string) {
        super(userId);
    }

    receive(_oldStats: unknown, _newStats: unknown) {}

    private cfg(): any {
        return this.instanceConfig();
    }

    private broker(): BrokerName | undefined {
        return (normalizeBrokerName(this.cfg()?.broker) || undefined) as BrokerName | undefined;
    }

    private brokerOrKite(): BrokerName {
        return this.broker() ?? ('kite' as BrokerName);
    }

    private priceDiff(): number {
        return Number(this.cfg()?.priceDiff);
    }

    // maxProfit (rupees) is required in the block or as settings.maxProfit: no default here. Missing / not a positive number blocks every new entry (see the gate in
    // processNiftyQuote) and configValidation rejects such a config.
    private maxProfit(): number {
        const own = this.cfg()?.maxProfit;
        // The block's own maxProfit (rupees) wins; without one, settings.maxProfit applies.
        return effectiveMaxProfit(own === undefined || own === null ? undefined : Number(own));
    }

    private nonFiniteAlert = new NonFiniteAlert();

    // The maxProfit total of this broker's legs, CE and PE together: realized fills since counting started plus each open leg valued from its
    // pnlRef (entry when absent). A leg with no tick yet, still waiting for its reference tick, or with a non-numeric lastLtp / entry / pnlRef / quantity counts as 0
    // (the last kind is alerted, once per 10 min); a non-finite total never trips (finiteGuard.ts).
    private profitTotal(): number {
        return profitTotalOf(this.userId, this.state.realizedPnl, this.openLegs().map((leg) => ({
            id: leg.id, remaining: this.remaining(leg), lastLtp: leg.lastLtp, ref: leg.pnlRef ?? leg.entry, pending: leg.pnlRefPending,
        })), this.nonFiniteAlert);
    }

    private async checkMaxProfit(): Promise<void> {
        const cap = this.maxProfit();
        if (this.state.profitTripped || !(cap > 0)) return;
        const total = this.profitTotal();
        if (!shouldTrip(this.userId, total, cap, this.nonFiniteAlert)) return; // total >= cap, and only for a finite total (NaN must not trip)
        this.state.profitTripped = true; // synchronous, before any await: only one caller runs the close
        this.save();
        Log.log(`[ScaledHedgedStrategy] MAX PROFIT TRIPPED - total=${Math.round(total)} threshold=${cap} (realized=${Math.round(this.state.realizedPnl)}) - closing every open leg of ${this.userId}, no new orders for the rest of the day`);
        await this.closeAllLegs('MAX PROFIT');
    }

    // ---- persistence ----

    private stateFile(): string {
        return path.join(__dirname, `../../.ScaledHedgedStrategy.${this.userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }

    private ensureLoaded(): void {
        const today = localDayKey();
        if (this.loaded && this.state.day === today) return;
        this.loaded = true;
        let fresh: State = { day: today, legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
        try {
            const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as State;
            if (raw?.day === today) {
                fresh = raw;
                if (fresh.pnlStarted !== true) {
                    // State written before maxProfit existed: start counting now, from zero, valuing the legs open now from their next tick.
                    fresh.pnlStarted = true;
                    fresh.realizedPnl = 0;
                    fresh.profitTripped = false;
                    for (const leg of Object.values(fresh.legs)) if (leg.status === 'open') { leg.pnlRef = undefined; leg.pnlRefPending = true; }
                }
            }
            else if (raw?.legs) {
                for (const leg of Object.values(raw.legs)) {
                    if (leg.status === 'open') Log.log(`[ScaledHedgedStrategy] ALERT: ${leg.tsym} from ${raw.day} was still open when the day rolled over - check the broker position by hand`);
                }
            }
        } catch { /* no file yet */ }
        this.state = fresh;
        for (const leg of this.openLegs()) this.watch(leg);
        for (const c of [this.state.pair?.CE, this.state.pair?.PE]) if (c) registerTrade(c.token, this, undefined, c.exchange);
    }

    private save(): void {
        try {
            fs.writeFileSync(this.stateFile(), JSON.stringify(this.state));
        } catch (e: any) {
            Log.log(`[ScaledHedgedStrategy] ALERT: could not persist state: ${e?.message ?? e}`);
        }
    }

    // ---- helpers ----

    private openLegs(): SimpleLeg[] {
        return Object.values(this.state.legs).filter((l) => l.status === 'open');
    }

    private legByToken(token: string, tsym?: string): SimpleLeg | undefined {
        const open = this.openLegs();
        return open.find((l) => l.token === String(token)) ?? (tsym ? open.find((l) => l.tsym === tsym) : undefined);
    }

    private remaining(leg: SimpleLeg): number {
        return leg.qty - leg.soldQty;
    }

    private invested(): number {
        return this.openLegs().reduce((sum, l) => sum + l.entry * this.remaining(l), 0);
    }

    private watch(leg: SimpleLeg): void {
        registerTrade(leg.token, this, undefined, leg.exchange);
    }

    private isPairToken(token: string): boolean {
        return token === this.state.pair?.CE?.token || token === this.state.pair?.PE?.token;
    }

    // The two contracts of the cycle stay subscribed while they have no open leg, so the maxInvestment check prices a re-buy from a live tick.
    private unwatch(leg: SimpleLeg): void {
        if (this.isPairToken(leg.token)) return;
        unregisterTrade(leg.token, this, undefined, leg.exchange);
    }

    private setPair(pair: { CE?: PairContract; PE?: PairContract }): void {
        const old = this.state.pair;
        this.state.pair = pair;
        for (const c of [pair.CE, pair.PE]) if (c) registerTrade(c.token, this, undefined, c.exchange);
        for (const c of [old?.CE, old?.PE]) {
            if (c && !this.isPairToken(c.token) && !this.openLegs().some((l) => l.token === c.token)) unregisterTrade(c.token, this, undefined, c.exchange);
        }
    }

    private newLegId(): string {
        this.state.seq += 1;
        return `L${this.state.seq}`;
    }

    private isEod(): boolean {
        if (MOCK_BROKER) return false;
        return isPastEodClose();
    }

    // End of day or the maxProfit trip: no new order of any kind, every open leg is closed (retried from Nifty ticks).
    private isStopped(): boolean {
        return this.isEod() || this.state.profitTripped === true;
    }

    // The order process refuses a buy with a tagged error: "definitely not placed" is safe to retry, anything else may be live.
    // Returns true for "definitely not placed". `latch` (default true) sets manual review for the may-be-live case; the hedge passes false
    // because it first tries to resolve the outcome against the broker (resolveUnconfirmedBuy) and latches only if that fails.
    private noteBuyError(e: any, what: string, latch = true): boolean {
        const msg = String(e?.message ?? e);
        if (msg.includes(NOT_PLACED_TAG) && !isUnconfirmedBuyError(e)) return true; // definitely not placed
        // Anything else (unconfirmed fill, timeout, transport error) leaves the outcome unknown: it may be live.
        if (latch) {
            this.manualReview = true;
            Log.log(`[ScaledHedgedStrategy] ALERT: ${what} may be live at the broker - no new buys until it is reviewed and the strategy is reset: ${msg}`);
        }
        return false;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        this.ensureLoaded();
        const t = String(quote.token);
        return this.openLegs().some((l) => l.token === t) || t === this.state.pair?.CE?.token || t === this.state.pair?.PE?.token;
    };

    // ---- reconcile ----

    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        this.ensureLoaded();
        const openTrades = await fetchOpenTradesWithRetry(this.userId, 'ScaledHedgedStrategy', maxAttempts, retryDelayMs);
        if (!openTrades) {
            Log.log('[ScaledHedgedStrategy] reconcile: order query exhausted retries, blocking new entries until next restart');
            this.blocked = true;
            return;
        }
        this.blocked = false;
        const byKey = new Map<string, Trade>();
        for (const t of openTrades) byKey.set(String(t.token), t);
        // Persisted open legs: the broker's quantity is the truth; a leg the broker no longer holds was sold meanwhile.
        for (const leg of this.openLegs()) {
            const t = byKey.get(leg.token) ?? openTrades.find((x) => x.tsym === leg.tsym);
            if (!t || !(Number(t.quantity) > 0)) {
                this.closeOutside(leg, 'reconcile');
                continue;
            }
            if (Number(t.quantity) < this.remaining(leg)) {
                // Partly sold outside the platform (a sell in the broker's app, booked by the sync): the leg continues with what is held.
                Log.log(`[ScaledHedgedStrategy] ALERT: reconcile: ${leg.tsym} holds ${Number(t.quantity)} of the ${this.remaining(leg)} recorded - ${this.remaining(leg) - Number(t.quantity)} was sold outside the platform, continuing with the held quantity (its P&L is not in this strategy's realizedPnl)`);
            }
            leg.qty = Number(t.quantity);
            leg.soldQty = 0;
            leg.soldValue = 0;
            this.watch(leg);
        }
        // Broker positions this strategy has no record of (state file lost): adopt them. hedged is inferred from the book -
        // a CE and a PE both open means the pair is already hedged; doubled is set so an adopted leg is never doubled.
        const known = new Set(this.openLegs().map((l) => l.token));
        const orphans = openTrades.filter((t) => Number(t.quantity) > 0 && !known.has(String(t.token)) && !this.openLegs().some((l) => l.tsym === t.tsym));
        const rights = new Set<Right>();
        for (const l of this.openLegs()) rights.add(l.right);
        const adopted: SimpleLeg[] = [];
        for (const t of orphans) {
            const contract = AntContractMaster.getInstance().findByToken(String(t.token));
            const right: Right = contract?.optionType === 'PE' ? 'PE' : 'CE';
            rights.add(right);
            const leg: SimpleLeg = {
                id: this.newLegId(), tsym: t.tsym, token: String(t.token), exchange: contract?.exch === 'BFO' ? 'BFO' : 'NFO',
                strike: contract?.strike ?? 0, right, role: 'root', entry: Number(t.originalEntryPrice ?? t.price), qty: Number(t.quantity),
                soldQty: 0, soldValue: 0, hedged: false, doubled: true, status: 'open', sellQty: 0, sellPrice: 0,
            };
            this.state.legs[leg.id] = leg;
            adopted.push(leg);
            this.watch(leg);
            Log.log(`[ScaledHedgedStrategy] reconcile: adopted unknown broker position ${leg.tsym} qty=${leg.qty} entry=${leg.entry}`);
        }
        if (rights.size > 1) for (const l of adopted) l.hedged = true;
        // Which legs already have a resting sell (so ticks do not place a second one).
        for (const leg of this.openLegs()) {
            try {
                const pending = await OrderClient.getInstance().getPendingSells(this.userId, this.brokerOrKite(), leg.tsym);
                leg.sellQty = pending.reduce((s, p) => s + Number(p.quantity || 0), 0);
                if (leg.sellQty > 0 && !leg.sellPrice) leg.sellPrice = roundToTick(leg.entry + this.priceDiff());
                // Some of the leg rests but not all of it (2026-11-11: a clamped placement after a double-up left 325 of 650 resting): the rest is placed from ticks.
                leg.sellShortfall = leg.sellQty > 0 && leg.sellQty < this.remaining(leg) ? this.remaining(leg) - leg.sellQty : 0;
                if (leg.sellShortfall > 0) Log.log(`[ScaledHedgedStrategy] ALERT: reconcile: ${leg.tsym} holds ${this.remaining(leg)} but only ${leg.sellQty} rests as a sell - placing the other ${leg.sellShortfall} from ticks`);
            } catch (e) {
                Log.log(`[ScaledHedgedStrategy] reconcile: could not read pending sells for ${leg.tsym}; assuming none rest:`, e);
                leg.sellQty = 0;
            }
        }
        this.save();
    }

    // ---- entry ----

    private async direction(quote: NiftyQuote): Promise<Right | null> {
        const now = this.toMillis(quote.ltt) ?? Date.now();
        if (!this.lastPcr || now - this.lastPcr.at >= PCR_RECHECK_MS) {
            try {
                const value = await OrderClient.getInstance().getPCR(this.userId, 'NIFTY', quote.ltp, PCR_WINDOW_POINTS);
                if (value == null) return null;
                this.lastPcr = { value, at: now };
            } catch (e) {
                Log.log('[ScaledHedgedStrategy] PCR check failed, blocking entry (fail-closed):', e);
                this.lastPcr = null;
                return null;
            }
        }
        return this.lastPcr.value > 1 ? 'PE' : 'CE';
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        this.ensureLoaded();
        this.lastNiftyLtp = quote.ltp;
        if (!this.enabled) { this.gateLog.log('disabled'); return; }
        if (this.isStopped()) {
            if (Date.now() - this.lastEodAttempt > EOD_RETRY_MS) {
                this.lastEodAttempt = Date.now();
                await this.closeAllLegs(this.isEod() ? 'EOD' : 'MAX PROFIT');
            }
            return;
        }
        if (!this.isTimeInRange()) { this.gateLog.log('outside time window'); return; }
        if (this.manualReview) { this.gateLog.log('manual review pending (unconfirmed buy)'); return; }
        if (this.blocked || !this.stateLoaded) { this.gateLog.log('state not loaded / open trades unreadable'); return; }
        await this.retryWaitingHedges();
        if (this.entering) return;
        const cfg = this.cfg();
        const qty = Number(cfg.initialQuantity);
        const maxInvestment = Number(cfg.maxInvestment);
        if (!(qty > 0) || !(maxInvestment > 0) || !(this.priceDiff() > 0) || !(this.maxProfit() > 0)) { this.gateLog.log('initialQuantity / maxInvestment / priceDiff / maxProfit not set'); return; }
        // One root per day: after it, every order is a hedge (or a double-up). Adopted legs count (reconcile gives them role 'root').
        // A root whose profit ended the first-order cycle (`restarted`) does not count: the selection starts over.
        if (Object.values(this.state.legs).some((l) => l.role === 'root' && !l.restarted)) { this.gateLog.log('root already opened today'); return; }

        this.entering = true; // synchronous, before any await
        try {
            const right = await this.direction(quote);
            if (right == null) return;
            await this.openRoot(right, quote.ltp, qty, maxInvestment);
        } catch (e) {
            Log.log('[ScaledHedgedStrategy] root entry failed:', e);
        } finally {
            this.entering = false;
        }
    }

    private excludeStrikes(right: Right): number[] {
        return this.openLegs().filter((l) => l.right === right && l.strike > 0).map((l) => l.strike);
    }

    private async openRoot(right: Right, ltp: number, qty: number, maxInvestment: number): Promise<void> {
        const ops = brokerLegOps(() => this.cfg()?.broker);
        const contract = await ops.pickContract(this.userId, ltp, right, ROOT_MIN_PREMIUM, [], expiryDayOverrideOf(this.cfg()));
        // Scaled (A): the root is initialQuantity, whatever onePositionPerSide says. Whole lots, never above one exchange order.
        const lot = INDEX_LOT_SIZE.NIFTY;
        qty = Math.min(Math.floor(qty / lot) * lot, Math.floor(NIFTY_FREEZE_QUANTITY / lot) * lot);
        if (!(qty > 0)) {
            this.gateLog.log(`root ${contract.tradingSymbol}: initialQuantity is below one lot (${lot})`);
            return;
        }
        if (this.invested() + contract.premium * qty > maxInvestment) {
            this.gateLog.log(`root ${contract.tradingSymbol} @${contract.premium} x${qty} would exceed maxInvestment`);
            return;
        }
        if (!this.enabled || this.manualReview) return; // changed while the contract was being picked
        let trade: Trade;
        try {
            trade = await ops.buy(this.userId, contract.tradingSymbol, contract.token, qty, contract.exchange, contract.premium);
        } catch (e) {
            Log.log('[ScaledHedgedStrategy] root buy failed:', e);
            if (this.noteBuyError(e, `root buy ${contract.tradingSymbol}`, false)) return; // definitely not placed: the next tick may try again
            // Outcome unknown (IPC timeout / unconfirmed fill): settle it against the order side and the broker instead of parking the strategy.
            const res = await this.resolveUnconfirmedBuy(contract);
            if (res.kind === 'none') {
                Log.log(`[ScaledHedgedStrategy] root buy of ${contract.tradingSymbol} was cancelled with 0 filled - no position, a new root may be tried`);
                return;
            }
            if (res.kind === 'unknown') {
                this.manualReview = true;
                Log.log(`[ScaledHedgedStrategy] ALERT: root buy ${contract.tradingSymbol} may be live at the broker (${res.why}) - no new buys until it is reviewed and the strategy is reset`);
                return;
            }
            trade = Object.assign(new Trade(), { quantity: res.qty, price: res.price });
            Log.log(`[ScaledHedgedStrategy] root buy of ${contract.tradingSymbol} had filled after all: adopting qty=${res.qty} @${res.price}`);
        }
        const leg = this.addLeg(trade, contract, right, 'root', false);
        this.setPair({ [right]: { tradingSymbol: contract.tradingSymbol, token: contract.token, exchange: contract.exchange, strike: contract.strike, premium: contract.premium } });
        this.save();
        Log.log(`[ScaledHedgedStrategy] root ${right} ${leg.tsym} qty=${leg.qty} @${leg.entry}`);
        await this.placeSell(leg);
    }

    private addLeg(trade: Trade, contract: { tradingSymbol: string; token: string; exchange: 'NFO' | 'BFO'; strike: number; premium: number }, right: Right, role: 'root' | 'hedge', hedged: boolean, parentId?: string): SimpleLeg {
        const filled = Number(trade.quantity) > 0 ? Number(trade.quantity) : 0;
        const price = Number(trade.price) > 0 ? Number(trade.price) : contract.premium;
        const leg: SimpleLeg = {
            id: this.newLegId(), tsym: contract.tradingSymbol, token: contract.token, exchange: contract.exchange, strike: contract.strike, right, role,
            parentId, entry: price, qty: filled, soldQty: 0, soldValue: 0, hedged, doubled: false, status: 'open', sellQty: 0, sellPrice: 0,
            ...(this.lastNiftyLtp > 0 ? { niftyAt: this.lastNiftyLtp } : {}),
        };
        this.state.legs[leg.id] = leg;
        this.watch(leg);
        this.save();
        return leg;
    }

    // ---- resting sell ----

    // A leg the order side no longer holds was sold outside the platform (the broker's app, an expiry, a square-off) and booked by the sync or
    // the order process's own reconcile. Marked closed so no tick, hedge, double-up or sell retry touches a position that is not there.
    // P&L accounting: NEUTRAL. The real exit was not seen here, so nothing is added to realizedPnl / the maxProfit total (the closedTrades rows
    // the sync booked carry the real P&L; booking it again here would double count it) and the leg's open value leaves the total with it.
    private closeOutside(leg: SimpleLeg, why: string): void {
        Log.log(`[ScaledHedgedStrategy] ALERT: ${why}: ${leg.tsym} (${this.remaining(leg)} left to sell) is no longer held by the broker - closed outside the platform, marking the leg closed (neutral P&L, not added to realizedPnl)`);
        leg.status = 'closed';
        leg.sellQty = 0;
        leg.sellShortfall = 0;
        leg.doubleDue = false;
        leg.hedgeWaiting = false;
        this.unwatch(leg);
        this.save();
    }

    // A sell refused as "nothing sellable" (the broker's never-short guard): the position is gone if the order side holds nothing for the leg.
    // Returns true when the leg was closed for that reason, so the caller stops retrying.
    private async closeIfNotHeld(leg: SimpleLeg, e: unknown): Promise<boolean> {
        if (!/nothing sellable/.test(String((e as any)?.message ?? e))) return false;
        if (leg.status !== 'open') return true;
        if ((await heldQuantity(this.userId, leg.token, leg.tsym)) !== 0) return false;
        if (leg.status === 'open') this.closeOutside(leg, 'sell refused');
        return true;
    }

    private async placeSell(leg: SimpleLeg): Promise<void> {
        if (leg.status !== 'open' || this.busy.has(leg.id)) return;
        const quantity = this.remaining(leg);
        if (quantity <= 0) return;
        this.busy.add(leg.id);
        this.lastSellAttempt.set(leg.id, Date.now());
        const price = roundToTick(leg.entry + this.priceDiff());
        try {
            const res = await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            this.bookPlacedSell(leg, quantity, price, res);
        } catch (e) {
            if (await this.closeIfNotHeld(leg, e)) return;
            Log.log(`[ScaledHedgedStrategy] ALERT: resting sell for ${leg.tsym} failed (retried every ${SELL_RETRY_MS / 1000}s):`, e);
        } finally {
            this.busy.delete(leg.id);
        }
    }

    // Books a resting-sell placement by the quantity the order process says it PLACED, not the requested one: Kite's never-short guard can clamp a
    // sell (live 2026-11-11 14:13: the buy of a double-up had just filled, the position read lagged, 325 of 650 were placed while the leg was
    // booked as fully covered). The unplaced rest becomes `sellShortfall`, placed from the leg's ticks.
    private bookPlacedSell(leg: SimpleLeg, requested: number, price: number, res: any): void {
        const placed = Number(res?.placedQuantity);
        const got = Number.isFinite(placed) && placed >= 0 ? Math.min(placed, requested) : requested; // an executor that reports nothing placed-wise is taken as fully placed
        leg.sellQty = got;
        leg.sellShortfall = requested - got;
        leg.sellPrice = price;
        this.save();
        Log.log(`[ScaledHedgedStrategy] resting sell ${leg.tsym} qty=${got} @${price}`);
        if (got < requested) Log.log(`[ScaledHedgedStrategy] ALERT: only ${got}/${requested} of ${leg.tsym} placed as a resting sell (clamped by the broker's guard) - placing the other ${requested - got} from ticks`);
    }

    // Places the quantity of a leg that has no resting sell while others rest (sellShortfall). Capped at what the leg still holds.
    private async placeShortfall(leg: SimpleLeg): Promise<void> {
        if (leg.status !== 'open' || this.busy.has(leg.id)) return;
        const quantity = Math.min(leg.sellShortfall ?? 0, this.remaining(leg));
        if (quantity <= 0) { leg.sellShortfall = 0; return; }
        this.busy.add(leg.id);
        this.lastSellAttempt.set(leg.id, Date.now());
        const price = roundToTick(leg.entry + this.priceDiff());
        try {
            const res: any = await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            const placed = Number(res?.placedQuantity);
            const got = Number.isFinite(placed) && placed >= 0 ? Math.min(placed, quantity) : quantity;
            leg.sellQty += got;
            leg.sellShortfall = quantity - got;
            this.save();
            Log.log(`[ScaledHedgedStrategy] resting sell (rest of the leg) ${leg.tsym} qty=${got} @${price}${leg.sellShortfall > 0 ? `, ${leg.sellShortfall} still unplaced` : ''}`);
        } catch (e) {
            if (String((e as any)?.message ?? e).includes('nothing sellable')) {
                // Kite's never-short guard: nothing is left to sell, so the whole position already rests (the platform's pending list had missed an order,
                // live 2026-11-11 14:15: two resting sells of 325 on a 650 leg). Not a gap: stop retrying.
                leg.sellShortfall = 0;
                this.save();
                Log.log(`[ScaledHedgedStrategy] ${leg.tsym}: the broker has nothing left to sell, so the rest of the leg already rests - no further sell placed`);
            } else {
                Log.log(`[ScaledHedgedStrategy] ALERT: resting sell for the rest of ${leg.tsym} (${quantity}) failed (retried every ${SELL_RETRY_MS / 1000}s):`, e);
            }
        } finally {
            this.busy.delete(leg.id);
        }
    }

    // ---- ticks ----

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        if (quote.ltp > 0) this.pairPx.set(String(quote.token), quote.ltp);
        const leg = this.legByToken(String(quote.token));
        if (!leg || !(quote.ltp > 0)) return;
        leg.lastLtp = quote.ltp;
        if (leg.pnlRefPending) { leg.pnlRef = quote.ltp; leg.pnlRefPending = false; this.save(); }
        if (this.isStopped()) return;
        await this.checkMaxProfit();
        if (this.isStopped()) return;
        // A leg whose sell never got placed (placement failed, or a restart found none resting) is retried.
        if (leg.sellQty === 0 && !this.busy.has(leg.id) && Date.now() - (this.lastSellAttempt.get(leg.id) ?? 0) > SELL_RETRY_MS) {
            await this.placeSell(leg);
        } else if ((leg.sellShortfall ?? 0) > 0 && leg.sellQty > 0 && !this.busy.has(leg.id) && Date.now() - (this.lastSellAttempt.get(leg.id) ?? 0) > SELL_RETRY_MS) {
            await this.placeShortfall(leg);
        }
        if (!leg.hedged && quote.ltp <= leg.entry - this.priceDiff()) {
            await this.hedge(leg, 'adverse move');
        }
    };

    // ---- hedge ----

    // ALWAYS true here (the config key onePositionPerSide is ignored): one CE and one PE contract per cycle means at most one open leg per right,
    // and the pendingSides guard is what keeps two concurrent buys (a re-buy and an opposite-leg hedge) from creating two legs on one contract.
    private onePerSide(): boolean {
        return true;
    }

    // True when a new leg on `right` must wait.
    //  - onePositionPerSide: a leg on that side is open (or a hedge buy on it is in flight); a CE and a PE may coexist, two CEs or two PEs may
    //    not. The held-back hedge is retried until the side is free (retryWaitingHedges, every 5 s).
    //  - otherwise the stacking guard (maxLegsPerSide): waits while that side already has maxLegsPerSide open legs, until Nifty has moved back
    //    toward the root by stackRecoveryPoints from the most adverse level an open leg on the side was bought at (CE: the lowest Nifty, PE:
    //    the highest). With no usable reference (adopted legs, no tick yet) it does not block.
    private sideBlocked(right: Right): boolean {
        if (this.onePerSide()) return this.pendingSides.has(right) || this.openLegs().some((l) => l.right === right);
        const cfg = this.cfg();
        const max = Number(cfg?.maxLegsPerSide);
        if (!(max > 0)) return false;
        const open = this.openLegs().filter((l) => l.right === right);
        if (open.length < max) return false;
        const refs = open.map((l) => Number(l.niftyAt)).filter((v) => v > 0);
        const nifty = this.lastNiftyLtp;
        if (!refs.length || !(nifty > 0)) return false;
        const recoveryCfg = Number(cfg?.stackRecoveryPoints);
        const recovery = Number.isFinite(recoveryCfg) && recoveryCfg >= 0 ? recoveryCfg : DEFAULT_STACK_RECOVERY_POINTS;
        const moved = right === 'CE' ? nifty - Math.min(...refs) : Math.max(...refs) - nifty;
        return moved < recovery;
    }

    // Hedges held back by the side check are retried from Nifty ticks. Closed legs always (they get no option ticks); with onePositionPerSide
    // open legs too (one may have bounced back above its adverse trigger by the time the side frees), otherwise open legs retry on their own ticks.
    private async retryWaitingHedges(): Promise<void> {
        if (Date.now() - this.lastWaitingHedgeRetry < WAITING_HEDGE_RETRY_MS) return;
        this.lastWaitingHedgeRetry = Date.now();
        for (const leg of Object.values(this.state.legs)) {
            if (leg.hedgeWaiting && !leg.hedged && (leg.status === 'closed' || this.onePerSide())) await this.hedge(leg, this.onePerSide() ? 'side free' : 'stacking guard lifted', !!leg.hedgeSame);
        }
    }

    // An unconfirmed buy (timeout, unknown fill) is resolved against the broker: cancel what still rests, then read the live position.
    //   'none'    - nothing bought: safe to retry
    //   'filled'  - `qty` is held (at `price`): book it
    //   'unknown' - the broker could not be read or a cancel failed: a human must look
    private async resolveUnconfirmedBuy(contract: { tradingSymbol: string; premium: number }, heldBefore = 0): Promise<UnconfirmedBuyResolution> {
        return resolveUnconfirmedBuyShared(this.userId, this.brokerOrKite(), contract, heldBefore);
    }

    // Scaled (F): the quantity of a buy of `contract` that fits under maxInvestment (whole lots), at most `qty`; 0 = not even one lot.
    private capQuantity(qty: number, contract: { token: string; premium: number }): number {
        const lot = INDEX_LOT_SIZE.NIFTY;
        const price = this.pairPx.get(String(contract.token)) ?? contract.premium;
        const room = Number(this.cfg()?.maxInvestment) - this.invested();
        if (!(price > 0)) return qty;
        const lots = Math.floor(room / (price * lot));
        return Math.max(0, Math.min(qty, lots * lot));
    }

    // Scaled (B): hedge quantity = initialQuantity + (entry - price now) / priceDiff * initialQuantity, in whole lots, at least initialQuantity.
    private hedgeQuantity(leg: SimpleLeg): number {
        const base = Number(this.cfg()?.initialQuantity);
        const lot = INDEX_LOT_SIZE.NIFTY;
        const drop = Math.max(0, leg.entry - (Number(leg.lastLtp) > 0 ? Number(leg.lastLtp) : leg.entry));
        const raw = base + (drop / this.priceDiff()) * base;
        const q = Math.floor(raw / lot + 1e-9) * lot;
        return Math.min(Math.max(q, base), Math.floor(NIFTY_FREEZE_QUANTITY / lot) * lot);
    }

    // `same`: follow the leg's direction (buy the same right) instead of the opposite one - used when the leg closed at a profit.
    private async hedge(leg: SimpleLeg, reason: string, same = false): Promise<void> {
        if (leg.hedged || this.busy.has(leg.id) || !this.enabled || this.manualReview || this.isStopped()) return;
        const right = same ? leg.right : opposite(leg.right);
        const fixed = this.state.pair?.[right];
        const openSame = fixed ? this.openLegs().find((l) => l.token === fixed.token) : undefined; // the fixed contract's leg is open: the buy is ADDED to it
        if (same && openSame) {
            // Scaled (G): the same contract already has an open leg: no re-buy.
            leg.hedged = true;
            this.save();
            Log.log(`[ScaledHedgedStrategy] no re-buy of ${openSame.tsym} after ${leg.tsym} (${reason}): that contract already has an open leg`);
            return;
        }
        if (!openSame && this.sideBlocked(right)) {
            // Stacking guard / side occupied: leave the leg un-hedged. An open leg is retried by its own ticks, a closed one from Nifty ticks.
            if (!leg.hedgeWaiting) {
                leg.hedgeWaiting = true;
                leg.hedgeSame = same;
                this.save();
                Log.log(`[ScaledHedgedStrategy] hedge of ${leg.tsym} (${reason}) held back: ${this.onePerSide() ? `a ${right} leg is already open (onePositionPerSide)` : `${this.openLegs().filter((l) => l.right === right).length} ${right} legs already open (maxLegsPerSide ${this.cfg()?.maxLegsPerSide}) and Nifty ${this.lastNiftyLtp} has not moved back toward the root`}`);
            }
            return;
        }
        if (leg.hedgeWaiting) { leg.hedgeWaiting = false; if (!this.capHeld.has(leg.id)) Log.log(`[ScaledHedgedStrategy] hedge of ${leg.tsym} released (${reason})`); }
        leg.hedged = true; // synchronous, before any await: a second tick must not buy a second hedge
        if (!openSame && this.onePerSide()) this.pendingSides.add(right); // same synchronous section as the sideBlocked check above
        this.busy.add(leg.id);
        this.save();
        try {
            const ops = brokerLegOps(() => this.cfg()?.broker);
            // The hedge is the opposite option at the strike nearest the money (pickContract walks ATM first, then out of / in the money). The
            // premium floor of 1 only skips a strike with no price. A strike already held on that side is skipped (one position per contract).
            const contract: PairContract = fixed ?? await ops.pickContract(this.userId, this.lastNiftyLtp, right, 1, this.excludeStrikes(right), expiryDayOverrideOf(this.cfg()));
            if (!fixed) {
                this.setPair({ ...(this.state.pair ?? {}), [right]: { tradingSymbol: contract.tradingSymbol, token: contract.token, exchange: contract.exchange, strike: contract.strike, premium: contract.premium } });
                this.save();
            }
            const wanted = this.hedgeQuantity(leg);
            const hedgeQty = this.capQuantity(wanted, contract);
            if (hedgeQty <= 0) {
                // Scaled (F): not even one lot fits under maxInvestment: held back, retried (own ticks / Nifty ticks) when room appears.
                leg.hedged = false;
                leg.hedgeWaiting = true; leg.hedgeSame = same;
                if (!this.capHeld.has(leg.id)) { this.capHeld.add(leg.id); Log.log(`[ScaledHedgedStrategy] hedge of ${leg.tsym} (${reason}) held back: maxInvestment ${this.cfg()?.maxInvestment} leaves no room for one lot of ${contract.tradingSymbol} (open cost ${Math.round(this.invested())})`); }
                this.save();
                return;
            }
            this.capHeld.delete(leg.id);
            if (hedgeQty < wanted) Log.log(`[ScaledHedgedStrategy] hedge quantity of ${contract.tradingSymbol} cut ${wanted} -> ${hedgeQty} by maxInvestment`);
            if (openSame) {
                const ok = await this.addToLeg(openSame, hedgeQty, leg, reason);
                if (!ok) { leg.hedged = false; this.save(); } // nothing bought: the next tick retries
                return;
            }
            let trade: Trade;
            try {
                trade = await OrderClient.getInstance().buyContractBare(this.userId, contract.tradingSymbol, contract.token, hedgeQty, contract.exchange, contract.premium, this.broker());
            } catch (e) {
                if (this.noteBuyError(e, `hedge buy ${contract.tradingSymbol}`, false)) {
                    leg.hedged = false; // nothing was placed: the next tick may try again
                    Log.log('[ScaledHedgedStrategy] hedge buy failed (not placed, will retry):', e);
                    this.save();
                    return;
                }
                // Outcome unknown (timeout / unconfirmed fill): ask the broker instead of freezing the chain.
                Log.log(`[ScaledHedgedStrategy] hedge buy of ${contract.tradingSymbol} unconfirmed (${(e as any)?.message ?? e}) - checking the broker`);
                const res = await this.resolveUnconfirmedBuy(contract);
                if (res.kind === 'none') {
                    leg.hedged = false; // cancelled with 0 filled: the hedge is retried
                    Log.log(`[ScaledHedgedStrategy] hedge buy of ${contract.tradingSymbol} was cancelled with 0 filled - hedge flag of ${leg.tsym} cleared, will retry`);
                    this.save();
                    return;
                }
                if (res.kind === 'unknown') {
                    this.manualReview = true;
                    Log.log(`[ScaledHedgedStrategy] ALERT: hedge buy ${contract.tradingSymbol} may be live at the broker (${res.why}) - no new buys until it is reviewed and the strategy is reset`);
                    this.save();
                    return;
                }
                const adopted = new Trade();
                adopted.quantity = res.qty;
                adopted.price = res.price;
                const hedgeLeg = this.addLeg(adopted, contract, right, 'hedge', false, leg.id);
                Log.log(`[ScaledHedgedStrategy] hedge buy of ${contract.tradingSymbol} had filled after all: adopted qty=${hedgeLeg.qty} @${hedgeLeg.entry} as the hedge of ${leg.tsym}`);
                await this.placeSell(hedgeLeg);
                return;
            }
            const hedgeLeg = this.addLeg(trade, contract, right, 'hedge', false, leg.id);
            Log.log(`[ScaledHedgedStrategy] hedged ${leg.tsym} (${reason}) with ${hedgeLeg.tsym} qty=${hedgeLeg.qty} @${hedgeLeg.entry}`);
            await this.placeSell(hedgeLeg);
        } catch (e) {
            // pickContract failed before any order: allow a retry.
            leg.hedged = false;
            this.save();
            Log.log('[ScaledHedgedStrategy] hedge contract lookup failed, will retry:', e);
        } finally {
            this.pendingSides.delete(right);
            this.busy.delete(leg.id);
        }
    }

    // ---- fills ----

    updateTrade = async (trade: Trade): Promise<void> => {
        if (trade.action !== 'Sell') return; // our own buys are handled synchronously where they are placed
        this.ensureLoaded();
        const leg = this.legByToken(String(trade.token), trade.tsym);
        if (!leg) return;
        const qty = Number(trade.quantity);
        if (!(qty > 0)) return;
        // The maxProfit total: this fill's P&L from the leg's reference (a leg that was open when counting started and has had no tick yet: 0).
        const fillPrice = Number(trade.price);
        const ref = leg.pnlRefPending ? fillPrice : (leg.pnlRef ?? leg.entry);
        this.state.realizedPnl += qty * (fillPrice - ref);
        leg.soldQty += qty;
        leg.soldValue += qty * Number(trade.price);
        if (leg.soldQty < leg.qty) { this.save(); return; } // chunked sell: the rest is still resting
        leg.status = 'closed';
        leg.sellQty = 0;
        leg.sellShortfall = 0;
        this.unwatch(leg);
        const avgSell = leg.soldValue / leg.soldQty;
        const pnl = (avgSell - leg.entry) * leg.qty;
        this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
        Log.log(`[ScaledHedgedStrategy] ${leg.tsym} closed qty=${leg.qty} entry=${leg.entry.toFixed(2)} sell=${avgSell.toFixed(2)} pnl=${Math.round(pnl)}`);
        this.save();
        await this.checkMaxProfit();
        if (this.isStopped()) return;
        // Closed at a profit: follow the direction (buy the same right again); closed at a loss: buy the opposite right. An adverse-move
        // hedge (the leg still open, the "stop" case) is always the opposite right. Fixed behaviour, deliberately not configurable.
        const same = avgSell > leg.entry;
        if (!leg.hedged && !leg.hedgeWaiting && !leg.added && leg.role === 'root' && same) { // `added`: a root that had quantity added is no longer a never-hedged first order
            // The very first order made its target before any hedge was needed: do NOT buy the same direction again. It is marked hedged (nothing
            // follows it) and `restarted`, so the root gate opens and the next Nifty tick runs the contract selection (PCR direction, premium floor,
            // ATM pick) again for a fresh root.
            leg.hedged = true;
            leg.restarted = true;
            this.save();
            Log.log(`[ScaledHedgedStrategy] first order ${leg.tsym} closed at a profit with no hedge: no same-direction re-buy, the contract selection runs again for a new root`);
        } else if (!leg.hedged) await this.hedge(leg, 'target met', same);
    };

    onOrderCancelled = async (n: OrderCancelledNotification): Promise<void> => {
        // A resting sell that was cancelled outside this strategy is re-placed by the tick retry (sellQty is reset here).
        // Only a cancelled SELL on that leg's own contract counts: a cancelled/unfilled hedge or double-up BUY (or a sell on
        // another contract) leaves every other leg's resting sell live, and resetting them made the tick retry try to
        // place a duplicate sell every 10 s (refused by the never-short guard, but an ALERT each time).
        if (n.action !== 'Sell') return;
        for (const leg of this.openLegs()) {
            if (leg.tsym !== n.tradingSymbol || leg.sellQty <= 0 || this.busy.has(leg.id)) continue;
            leg.sellQty = 0;
            leg.sellShortfall = 0; // the tick retry places the whole remainder
        }
    };

    // ---- add to an open leg (Scaled C/D: replaces the double-up) ----

    // Buys `addQty` more of the open leg's contract and re-places its resting sell for the new total at the new average + priceDiff. The leg's
    // hedge trigger is re-armed (hedged = false) so it hedges again when it falls priceDiff below the NEW average; the leg that caused the add
    // (`trigger`) stays hedged. Returns false when nothing was bought.
    private async addToLeg(parent: SimpleLeg, addQty: number, trigger: SimpleLeg, reason: string): Promise<boolean> {
        if (parent.status !== 'open' || this.busy.has(parent.id)) return false;
        this.busy.add(parent.id);
        const broker = this.brokerOrKite();
        try {
            let cancelledFilled = 0;
            if (parent.sellQty > 0) {
                const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: parent.tsym, broker });
                if (res.cancelFailed) { Log.log(`[ScaledHedgedStrategy] add to ${parent.tsym} aborted: its resting sell could not be cancelled`); return false; }
                cancelledFilled = res.filledQty;
                parent.sellQty = 0;
                parent.sellShortfall = 0;
            }
            if (cancelledFilled > 0) {
                Log.log(`[ScaledHedgedStrategy] add to ${parent.tsym} aborted: ${cancelledFilled} sold while cancelling`);
                const left = parent.qty - parent.soldQty - cancelledFilled;
                if (left > 0) await this.placeSellQty(parent, left);
                return false;
            }
            let trade: Trade;
            try {
                trade = await OrderClient.getInstance().buyContractBare(this.userId, parent.tsym, parent.token, addQty, parent.exchange, parent.entry, this.broker());
            } catch (e) {
                const notPlaced = this.noteBuyError(e, `add buy ${parent.tsym}`, false);
                Log.log('[ScaledHedgedStrategy] add buy failed:', e);
                if (notPlaced) { await this.placeSellQty(parent, this.remaining(parent)); return false; }
                // Outcome unknown (IPC timeout / unconfirmed fill): the parent has no resting sell now, so settle it here. The live quantity
                // includes what the parent already holds, so only the excess is the add buy (a partial fill is booked as that partial).
                const res = await this.resolveUnconfirmedBuy({ tradingSymbol: parent.tsym, premium: parent.entry }, this.remaining(parent));
                if (res.kind === 'none') {
                    Log.log(`[ScaledHedgedStrategy] add buy of ${parent.tsym} was cancelled with 0 filled - the parent keeps its quantity, sell re-placed`);
                    await this.placeSellQty(parent, this.remaining(parent));
                    return false;
                }
                if (res.kind === 'unknown') {
                    this.manualReview = true;
                    Log.log(`[ScaledHedgedStrategy] ALERT: add buy ${parent.tsym} may be live at the broker (${res.why}) - no new buys until it is reviewed and the strategy is reset`);
                    this.save();
                    return false;
                }
                trade = Object.assign(new Trade(), { quantity: res.qty, price: res.price });
                Log.log(`[ScaledHedgedStrategy] add buy of ${parent.tsym} had filled after all: adopting +${res.qty} @${res.price}`);
            }
            const got = Number(trade.quantity) > 0 ? Number(trade.quantity) : 0;
            const price = Number(trade.price) > 0 ? Number(trade.price) : parent.entry;
            if (got > 0) {
                if (parent.pnlRefPending) { parent.pnlRef = price; parent.pnlRefPending = false; }
                else if (parent.pnlRef != null) parent.pnlRef = (parent.pnlRef * parent.qty + price * got) / (parent.qty + got);
            }
            parent.entry = (parent.entry * parent.qty + price * got) / (parent.qty + got);
            parent.qty += got;
            parent.added = true;
            parent.hedged = false; // re-armed from the new average
            parent.hedgeWaiting = false;
            this.save();
            Log.log(`[ScaledHedgedStrategy] added to ${parent.tsym}: +${got} @${price} (${trigger.tsym} fell ${this.priceDiff()}: ${reason}), now qty=${parent.qty} avg=${parent.entry.toFixed(2)}`);
            await this.placeSellQty(parent, this.remaining(parent));
            return got > 0;
        } catch (e) {
            Log.log('[ScaledHedgedStrategy] add to leg failed:', e);
            return false;
        } finally {
            this.busy.delete(parent.id);
        }
    }

    // placeSell for a given quantity while the caller already holds the leg's busy slot.
    private async placeSellQty(leg: SimpleLeg, quantity: number): Promise<void> {
        if (quantity <= 0 || leg.status !== 'open') return;
        const price = roundToTick(leg.entry + this.priceDiff());
        try {
            const res = await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            this.bookPlacedSell(leg, quantity, price, res);
        } catch (e) {
            Log.log(`[ScaledHedgedStrategy] ALERT: resting sell for ${leg.tsym} failed (tick retry follows):`, e);
        }
    }

    // ---- EOD ----

    // The maxProfit exit of one open leg (user's rule 2026-11-13: lock the cap, never dump at the bid; 2026-11-13 10:53 the old cancel-and-sell-at-the-bid
    // booked 4732 on a 5044 trip of a 5000 cap). The trip is judged on the last tick; the exit is a limit sell at `clearPrice`, the price at which the
    // strategy total equals the cap, but never below the marketable floor (tripSellPrice: last tick LTP less 5%, tightening after a refusal): live 14:35
    // clearPrice was 41 on a 126 leg because other legs had already realized more than the cap, and the broker refused the price as outside the exchange
    // band. A resting sell stays when it sits at clearPrice or above it but at/below the market (keepTripSell); any other (below clearPrice locks less,
    // above the market sits out of reach, user's rule 2026-11-13 12:14) or none is cancelled - confirmed at the broker - and one limit sell for the unsold
    // quantity is placed. The leg stays open until the sell fills (updateTrade closes it); there is no drop to the bid (EOD closes whatever still rests).
    // Caller holds the leg's busy slot. Idempotent: it runs again every EOD_RETRY_MS from the Nifty ticks; a refused placement backs off (TripGuard).
    // After a cancel that reported a fill (live 14:35:21: all 195 of a leg sold while cancelling) the leg's fill events may not have arrived: nothing
    // is placed until the order side's held quantity agrees with the leg (or the events arrive and close it), bounded by TRIP_FILL_WAIT_MS.
    private async lockProfitOnLeg(leg: SimpleLeg, cap: number): Promise<void> {
        if (leg.pnlRefPending) return; // valued from its next tick; the price that locks the cap is unknown until then
        if (this.remaining(leg) <= 0) return;
        if (!this.tripGuard.due(leg.id)) return; // a refused placement / cancel is retried with a growing delay, not every pass
        const clear = clearPrice(leg, this.openLegs(), this.state.realizedPnl, cap);
        if (leg.sellQty > 0) {
            if (keepTripSell(leg.sellPrice, clear, leg.lastLtp)) { // a retry pass never churns
                const missing = Math.min(leg.sellShortfall ?? 0, this.remaining(leg) - leg.sellQty);
                if (missing > 0) await this.placeTripSell(leg, missing, leg.sellPrice, true, cap); // the unplaced rest rests at the same price
                return;
            }
            const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: leg.tsym, broker: this.brokerOrKite() });
            if (res.cancelFailed) {
                const n = this.tripGuard.fail(leg.id);
                if (this.tripGuard.shouldLogFailure(n)) Log.log(`[ScaledHedgedStrategy] MAX PROFIT: could not cancel the resting sell of ${leg.tsym} (it may still fill), retrying with backoff (failure ${n})`);
                return;
            }
            leg.sellQty = 0;
            leg.sellShortfall = 0;
            this.save();
            if (res.filledQty > 0) {
                // Part (or all) of the old sell filled while it was cancelled: its fill events update soldQty (they may lag); the next pass sizes what is really left.
                this.tripGuard.markFill(leg.id);
                Log.log(`[ScaledHedgedStrategy] MAX PROFIT: ${res.filledQty} of ${leg.tsym} sold while cancelling the resting sell - the rest is re-priced on a later pass, once the fills are booked`);
                return;
            }
        }
        let quantity = this.remaining(leg);
        const since = this.tripGuard.fillWait(leg.id);
        if (since !== undefined) {
            const held = await heldQuantity(this.userId, leg.token, leg.tsym);
            if (leg.status !== 'open') { this.tripGuard.clearFill(leg.id); return; } // the fill events arrived meanwhile and closed it
            quantity = this.remaining(leg);
            const expired = Date.now() - since > TRIP_FILL_WAIT_MS;
            if (held === 0) {
                if (!expired) { Log.log(`[ScaledHedgedStrategy] MAX PROFIT: ${leg.tsym} is fully sold per the order side, waiting for its fill events (nothing placed)`); return; }
                this.tripGuard.clearFill(leg.id);
                this.closeOutside(leg, 'MAX PROFIT (fill events never arrived)');
                return;
            }
            if ((held === undefined || held < quantity) && !expired) return; // the fills are not booked on the leg yet: its remaining/realized would misprice the sell
            if (held !== undefined) quantity = Math.min(quantity, held);
            this.tripGuard.clearFill(leg.id);
        }
        if (quantity <= 0) return;
        const attempt = this.tripGuard.attempts(leg.id);
        const price = tripSellPrice(clearPrice(leg, this.openLegs(), this.state.realizedPnl, cap), leg.lastLtp, attempt);
        await this.placeTripSell(leg, quantity, price, false, cap);
    }

    // One limit sell for `quantity` of `leg` at `price` after a maxProfit trip. `add` = the leg already has a resting sell at this price and this is its unplaced rest.
    private async placeTripSell(leg: SimpleLeg, quantity: number, price: number, add: boolean, cap: number): Promise<void> {
        try {
            const res: any = await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            this.tripGuard.ok(leg.id);
            if (add) {
                const placed = Number(res?.placedQuantity);
                const got = Number.isFinite(placed) && placed >= 0 ? Math.min(placed, quantity) : quantity;
                leg.sellQty += got;
                leg.sellShortfall = quantity - got;
                this.save();
            } else this.bookPlacedSell(leg, quantity, price, res);
            Log.log(`[ScaledHedgedStrategy] MAX PROFIT: resting sell ${leg.tsym} qty=${quantity} @${price} (locks ${cap})`);
        } catch (e) {
            const nothingSellable = /nothing sellable/.test(String((e as any)?.message ?? e));
            if (add && nothingSellable) {
                leg.sellShortfall = 0; // the broker has nothing left to sell: the rest of the leg already rests
                this.save();
                return;
            }
            if (nothingSellable && leg.status === 'open') {
                // The never-short guard sees nothing to sell (live 14:35:29: the leg had just been sold, its fill event had not arrived). Held nothing: give the
                // event its grace, then close the leg; held something else: a resting sell this strategy does not know of, retried with backoff.
                if ((await heldQuantity(this.userId, leg.token, leg.tsym)) === 0) {
                    if (this.tripGuard.goneExpired(leg.id)) this.closeOutside(leg, 'MAX PROFIT sell refused');
                    else Log.log(`[ScaledHedgedStrategy] MAX PROFIT: ${leg.tsym} has nothing sellable at the broker - waiting for its fill events before closing the leg`);
                    return;
                }
            }
            const n = this.tripGuard.fail(leg.id);
            if (this.tripGuard.shouldLogFailure(n)) Log.log(`[ScaledHedgedStrategy] ALERT: MAX PROFIT resting sell for ${leg.tsym} (${quantity} @${price}) failed (failure ${n}; retried with backoff, the price moves toward the live LTP):`, e);
        }
    }

    private async closeAllLegs(label: 'EOD' | 'MAX PROFIT'): Promise<void> {
        const cap = this.maxProfit();
        for (const leg of this.openLegs()) {
            if (this.busy.has(leg.id)) continue;
            this.busy.add(leg.id);
            try {
                if (label === 'MAX PROFIT' && cap > 0) { await this.lockProfitOnLeg(leg, cap); continue; }
                let filled = 0;
                if (leg.sellQty > 0) {
                    const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: leg.tsym, broker: this.brokerOrKite() });
                    if (res.cancelFailed) { Log.log(`[ScaledHedgedStrategy] ${label}: could not cancel the resting sell of ${leg.tsym}, retrying`); continue; }
                    filled = res.filledQty;
                    leg.sellQty = 0;
                    leg.sellShortfall = 0;
                }
                const left = leg.qty - leg.soldQty - filled;
                if (left > 0) await chunkedLegSell(this.userId, leg.tsym, left, this.broker());
                leg.status = 'closed';
                this.unwatch(leg);
                this.save();
                Log.log(`[ScaledHedgedStrategy] ${label}: closed ${leg.tsym}`);
            } catch (e) {
                Log.log(`[ScaledHedgedStrategy] ${label} close of ${leg.tsym} failed, retrying:`, e);
            } finally {
                this.busy.delete(leg.id);
            }
        }
    }

    reset(): void {
        super.reset();
        // Re-arms maxProfit: counting starts again from zero (open legs are valued from their next tick).
        this.state.realizedPnl = 0;
        this.state.profitTripped = false;
        for (const leg of this.openLegs()) { leg.pnlRef = undefined; leg.pnlRefPending = true; }
        this.save();
        this.manualReview = false;
        this.entering = false;
        this.busy.clear();
    }
}
