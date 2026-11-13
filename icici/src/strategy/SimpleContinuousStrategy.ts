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
import { fetchOpenTradesWithRetry } from './openTrades';
import { registerTrade, unregisterTrade } from '../processes/strategies/tokenRouter';
import { localDayKey } from './dayKey';
import { roundToTick } from '../util/tick';
import { expiryDayOverrideOf } from '../util/expirySkip';
import { isPastEodClose } from '../util/eodClose';
import { BrokerName, normalizeBrokerName } from '../util/brokerName';
import { NOT_PLACED_TAG, OrderCancelledNotification } from '../ipc/orderProtocol';
import { MOCK_BROKER, PCR_WINDOW_POINTS, INDEX_LOT_SIZE, NIFTY_FREEZE_QUANTITY } from '../constants';

// SimpleContinuousStrategy (config keys: initialQuantity, maxInvestment, priceDiff, plus enabled/brokers):
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
//   10. First order (2026-11-13): a root whose sell fills at a profit with no hedge ever bought does not re-buy the same direction; it is marked
//      `restarted`, the one-root gate opens and the contract selection runs again for a new root.
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
    lastLtp?: number;       // last option tick (in memory use only; refreshed by ticks)
}

interface State { day: string; legs: Record<string, SimpleLeg>; seq: number; pnlStarted?: boolean; realizedPnl: number; profitTripped: boolean }

const opposite = (r: Right): Right => (r === 'CE' ? 'PE' : 'CE');

export default class SimpleContinuousStrategy extends Strategy {
    name = 'SimpleContinuousStrategy';
    legTokenFeed = 'ant' as const; // legs carry ANT tokens whatever broker places the orders

    private state: State = { day: '', legs: {}, seq: 0, pnlStarted: true, realizedPnl: 0, profitTripped: false };
    private loaded = false;
    private lastNiftyLtp = 0;
    private lastPcr: { value: number; at: number } | null = null;
    private entering = false;
    private manualReview = false; // an unconfirmed buy may be live: no new buys until a human looks and reset() clears it
    private blocked = false;      // reconcile could not read the open trades: no new entries
    private pendingSides = new Set<Right>();    // sides with a hedge buy in flight (not yet an open leg), so two hedges cannot both pass the one-per-side check
    private busy = new Set<string>();           // leg ids with a hedge / double-up / sell placement in flight
    private lastSellAttempt = new Map<string, number>();
    private lastEodAttempt = 0;
    private lastWaitingHedgeRetry = 0;
    private lastDoubleAttempt = new Map<string, number>();
    private gateLog = new GateLogger('[SimpleContinuousStrategy] gate:', PCR_RECHECK_MS);

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

    // maxProfit is a REQUIRED config key (rupees): no default here. Missing / not a positive number blocks every new entry (see the gate in
    // processNiftyQuote) and configValidation rejects such a config.
    private maxProfit(): number {
        return Number(this.cfg()?.maxProfit);
    }

    // The maxProfit total of this broker's legs, CE and PE together: realized fills since counting started plus each open leg valued from its
    // pnlRef (entry when absent). A leg with no tick yet, or still waiting for its reference tick, counts as 0.
    private profitTotal(): number {
        let total = this.state.realizedPnl;
        for (const leg of this.openLegs()) {
            if (leg.pnlRefPending || !(Number(leg.lastLtp) > 0)) continue;
            total += this.remaining(leg) * (Number(leg.lastLtp) - (leg.pnlRef ?? leg.entry));
        }
        return total;
    }

    private async checkMaxProfit(): Promise<void> {
        const cap = this.maxProfit();
        if (this.state.profitTripped || !(cap > 0)) return;
        const total = this.profitTotal();
        if (total < cap) return;
        this.state.profitTripped = true; // synchronous, before any await: only one caller runs the close
        this.save();
        Log.log(`[SimpleContinuousStrategy] MAX PROFIT TRIPPED - total=${Math.round(total)} threshold=${cap} (realized=${Math.round(this.state.realizedPnl)}) - closing every open leg of ${this.userId}, no new orders for the rest of the day`);
        await this.closeAllLegs('MAX PROFIT');
    }

    // ---- persistence ----

    private stateFile(): string {
        return path.join(__dirname, `../../.SimpleContinuousStrategy.${this.userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
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
                    if (leg.status === 'open') Log.log(`[SimpleContinuousStrategy] ALERT: ${leg.tsym} from ${raw.day} was still open when the day rolled over - check the broker position by hand`);
                }
            }
        } catch { /* no file yet */ }
        this.state = fresh;
        for (const leg of this.openLegs()) this.watch(leg);
    }

    private save(): void {
        try {
            fs.writeFileSync(this.stateFile(), JSON.stringify(this.state));
        } catch (e: any) {
            Log.log(`[SimpleContinuousStrategy] ALERT: could not persist state: ${e?.message ?? e}`);
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

    private unwatch(leg: SimpleLeg): void {
        unregisterTrade(leg.token, this, undefined, leg.exchange);
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
            Log.log(`[SimpleContinuousStrategy] ALERT: ${what} may be live at the broker - no new buys until it is reviewed and the strategy is reset: ${msg}`);
        }
        return false;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        this.ensureLoaded();
        return this.openLegs().some((l) => l.token === String(quote.token));
    };

    // ---- reconcile ----

    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        this.ensureLoaded();
        const openTrades = await fetchOpenTradesWithRetry(this.userId, 'SimpleContinuousStrategy', maxAttempts, retryDelayMs);
        if (!openTrades) {
            Log.log('[SimpleContinuousStrategy] reconcile: order query exhausted retries, blocking new entries until next restart');
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
                Log.log(`[SimpleContinuousStrategy] reconcile: ${leg.tsym} is no longer held by the broker - marking closed`);
                leg.status = 'closed';
                this.unwatch(leg);
                continue;
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
            Log.log(`[SimpleContinuousStrategy] reconcile: adopted unknown broker position ${leg.tsym} qty=${leg.qty} entry=${leg.entry}`);
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
                if (leg.sellShortfall > 0) Log.log(`[SimpleContinuousStrategy] ALERT: reconcile: ${leg.tsym} holds ${this.remaining(leg)} but only ${leg.sellQty} rests as a sell - placing the other ${leg.sellShortfall} from ticks`);
            } catch (e) {
                Log.log(`[SimpleContinuousStrategy] reconcile: could not read pending sells for ${leg.tsym}; assuming none rest:`, e);
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
                Log.log('[SimpleContinuousStrategy] PCR check failed, blocking entry (fail-closed):', e);
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
        if ((!(qty > 0) && !this.onePerSide()) || !(maxInvestment > 0) || !(this.priceDiff() > 0) || !(this.maxProfit() > 0)) { this.gateLog.log('initialQuantity / maxInvestment / priceDiff / maxProfit not set'); return; }
        // One root per day: after it, every order is a hedge (or a double-up). Adopted legs count (reconcile gives them role 'root').
        // A root whose profit ended the first-order cycle (`restarted`) does not count: the selection starts over.
        if (Object.values(this.state.legs).some((l) => l.role === 'root' && !l.restarted)) { this.gateLog.log('root already opened today'); return; }

        this.entering = true; // synchronous, before any await
        try {
            const right = await this.direction(quote);
            if (right == null) return;
            await this.openRoot(right, quote.ltp, qty, maxInvestment);
        } catch (e) {
            Log.log('[SimpleContinuousStrategy] root entry failed:', e);
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
        if (this.onePerSide()) {
            // onePositionPerSide: size by the investment, not initialQuantity. Whole lots only, never above one exchange order (freeze quantity).
            const lot = INDEX_LOT_SIZE.NIFTY;
            const lots = contract.premium > 0 ? Math.floor((maxInvestment - this.invested()) / contract.premium / lot) : 0;
            qty = Math.min(lots * lot, Math.floor(NIFTY_FREEZE_QUANTITY / lot) * lot);
            if (!(qty > 0)) {
                this.gateLog.log(`root ${contract.tradingSymbol} @${contract.premium}: maxInvestment ${maxInvestment} does not pay for one lot (${lot})`);
                return;
            }
        } else if (this.invested() + contract.premium * qty > maxInvestment) {
            this.gateLog.log(`root ${contract.tradingSymbol} @${contract.premium} x${qty} would exceed maxInvestment`);
            return;
        }
        if (!this.enabled || this.manualReview) return; // changed while the contract was being picked
        let trade: Trade;
        try {
            trade = await ops.buy(this.userId, contract.tradingSymbol, contract.token, qty, contract.exchange, contract.premium);
        } catch (e) {
            this.noteBuyError(e, `root buy ${contract.tradingSymbol}`);
            Log.log('[SimpleContinuousStrategy] root buy failed:', e);
            return;
        }
        const leg = this.addLeg(trade, contract, right, 'root', false);
        Log.log(`[SimpleContinuousStrategy] root ${right} ${leg.tsym} qty=${leg.qty} @${leg.entry}`);
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
            Log.log(`[SimpleContinuousStrategy] ALERT: resting sell for ${leg.tsym} failed (retried every ${SELL_RETRY_MS / 1000}s):`, e);
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
        Log.log(`[SimpleContinuousStrategy] resting sell ${leg.tsym} qty=${got} @${price}`);
        if (got < requested) Log.log(`[SimpleContinuousStrategy] ALERT: only ${got}/${requested} of ${leg.tsym} placed as a resting sell (clamped by the broker's guard) - placing the other ${requested - got} from ticks`);
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
            Log.log(`[SimpleContinuousStrategy] resting sell (rest of the leg) ${leg.tsym} qty=${got} @${price}${leg.sellShortfall > 0 ? `, ${leg.sellShortfall} still unplaced` : ''}`);
        } catch (e) {
            if (String((e as any)?.message ?? e).includes('nothing sellable')) {
                // Kite's never-short guard: nothing is left to sell, so the whole position already rests (the platform's pending list had missed an order,
                // live 2026-11-11 14:15: two resting sells of 325 on a 650 leg). Not a gap: stop retrying.
                leg.sellShortfall = 0;
                this.save();
                Log.log(`[SimpleContinuousStrategy] ${leg.tsym}: the broker has nothing left to sell, so the rest of the leg already rests - no further sell placed`);
            } else {
                Log.log(`[SimpleContinuousStrategy] ALERT: resting sell for the rest of ${leg.tsym} (${quantity}) failed (retried every ${SELL_RETRY_MS / 1000}s):`, e);
            }
        } finally {
            this.busy.delete(leg.id);
        }
    }

    // ---- ticks ----

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
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
        // A double-up that was due but did not happen (cap, cancel failure, refused buy) is retried here while the parent is open.
        if (leg.doubleDue && !leg.doubled && leg.status === 'open' && !this.busy.has(leg.id) && Date.now() - (this.lastDoubleAttempt.get(leg.id) ?? 0) > DOUBLE_RETRY_MS) {
            await this.doubleUp(leg);
        }
    };

    // ---- hedge ----

    private onePerSide(): boolean {
        return this.cfg()?.onePositionPerSide === true;
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
    private async resolveUnconfirmedBuy(contract: { tradingSymbol: string; premium: number }): Promise<{ kind: 'none' } | { kind: 'filled'; qty: number; price: number } | { kind: 'unknown'; why: string }> {
        const client = OrderClient.getInstance();
        const broker = this.brokerOrKite();
        try {
            const cancel = await client.cancelRestingLimitBuys(this.userId, { tradingSymbol: contract.tradingSymbol, broker });
            if (cancel.cancelFailed) return { kind: 'unknown', why: 'the resting buy could not be cancelled' };
            const live = await client.getLiveQuantity(this.userId, broker, contract.tradingSymbol);
            const qty = Math.max(Number(live) || 0, 0);
            if (qty <= 0 && !(cancel.filledQty > 0)) return { kind: 'none' };
            let price = contract.premium;
            try {
                const trades = await client.getOpenTrades(this.userId);
                const held = trades.find((t: any) => t.tsym === contract.tradingSymbol && Number(t.quantity) > 0);
                const p = Number(held?.originalEntryPrice ?? held?.price);
                if (p > 0) price = p;
            } catch { /* the premium hint is the fallback entry price */ }
            return { kind: 'filled', qty: qty > 0 ? qty : cancel.filledQty, price };
        } catch (e: any) {
            return { kind: 'unknown', why: String(e?.message ?? e) };
        }
    }

    // `same`: follow the leg's direction (buy the same right) instead of the opposite one - used when the leg closed at a profit.
    private async hedge(leg: SimpleLeg, reason: string, same = false): Promise<void> {
        if (leg.hedged || this.busy.has(leg.id) || !this.enabled || this.manualReview || this.isStopped()) return;
        const right = same ? leg.right : opposite(leg.right);
        if (this.sideBlocked(right)) {
            // Stacking guard / side occupied: leave the leg un-hedged. An open leg is retried by its own ticks, a closed one from Nifty ticks.
            if (!leg.hedgeWaiting) {
                leg.hedgeWaiting = true;
                leg.hedgeSame = same;
                this.save();
                Log.log(`[SimpleContinuousStrategy] hedge of ${leg.tsym} (${reason}) held back: ${this.onePerSide() ? `a ${right} leg is already open (onePositionPerSide)` : `${this.openLegs().filter((l) => l.right === right).length} ${right} legs already open (maxLegsPerSide ${this.cfg()?.maxLegsPerSide}) and Nifty ${this.lastNiftyLtp} has not moved back toward the root`}`);
            }
            return;
        }
        if (leg.hedgeWaiting) { leg.hedgeWaiting = false; Log.log(`[SimpleContinuousStrategy] hedge of ${leg.tsym} released (${reason})`); }
        leg.hedged = true; // synchronous, before any await: a second tick must not buy a second hedge
        if (this.onePerSide()) this.pendingSides.add(right); // same synchronous section as the sideBlocked check above
        this.busy.add(leg.id);
        this.save();
        try {
            const ops = brokerLegOps(() => this.cfg()?.broker);
            // The hedge is the opposite option at the strike nearest the money (pickContract walks ATM first, then out of / in the money). The
            // premium floor of 1 only skips a strike with no price. A strike already held on that side is skipped (one position per contract).
            const contract = await ops.pickContract(this.userId, this.lastNiftyLtp, right, 1, this.excludeStrikes(right), expiryDayOverrideOf(this.cfg()));
            let trade: Trade;
            try {
                trade = await OrderClient.getInstance().buyContractBare(this.userId, contract.tradingSymbol, contract.token, leg.qty, contract.exchange, contract.premium, this.broker(), { hedgeRebuy: true });
            } catch (e) {
                if (this.noteBuyError(e, `hedge buy ${contract.tradingSymbol}`, false)) {
                    leg.hedged = false; // nothing was placed: the next tick may try again
                    Log.log('[SimpleContinuousStrategy] hedge buy failed (not placed, will retry):', e);
                    this.save();
                    return;
                }
                // Outcome unknown (timeout / unconfirmed fill): ask the broker instead of freezing the chain.
                Log.log(`[SimpleContinuousStrategy] hedge buy of ${contract.tradingSymbol} unconfirmed (${(e as any)?.message ?? e}) - checking the broker`);
                const res = await this.resolveUnconfirmedBuy(contract);
                if (res.kind === 'none') {
                    leg.hedged = false; // cancelled with 0 filled: the hedge is retried
                    Log.log(`[SimpleContinuousStrategy] hedge buy of ${contract.tradingSymbol} was cancelled with 0 filled - hedge flag of ${leg.tsym} cleared, will retry`);
                    this.save();
                    return;
                }
                if (res.kind === 'unknown') {
                    this.manualReview = true;
                    Log.log(`[SimpleContinuousStrategy] ALERT: hedge buy ${contract.tradingSymbol} may be live at the broker (${res.why}) - no new buys until it is reviewed and the strategy is reset`);
                    this.save();
                    return;
                }
                const adopted = new Trade();
                adopted.quantity = res.qty;
                adopted.price = res.price;
                const hedgeLeg = this.addLeg(adopted, contract, right, 'hedge', false, leg.id);
                Log.log(`[SimpleContinuousStrategy] hedge buy of ${contract.tradingSymbol} had filled after all: adopted qty=${hedgeLeg.qty} @${hedgeLeg.entry} as the hedge of ${leg.tsym}`);
                await this.placeSell(hedgeLeg);
                return;
            }
            const hedgeLeg = this.addLeg(trade, contract, right, 'hedge', false, leg.id);
            Log.log(`[SimpleContinuousStrategy] hedged ${leg.tsym} (${reason}) with ${hedgeLeg.tsym} qty=${hedgeLeg.qty} @${hedgeLeg.entry}`);
            await this.placeSell(hedgeLeg);
        } catch (e) {
            // pickContract failed before any order: allow a retry.
            leg.hedged = false;
            this.save();
            Log.log('[SimpleContinuousStrategy] hedge contract lookup failed, will retry:', e);
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
        Log.log(`[SimpleContinuousStrategy] ${leg.tsym} closed qty=${leg.qty} entry=${leg.entry.toFixed(2)} sell=${avgSell.toFixed(2)} pnl=${Math.round(pnl)}`);
        this.save();
        await this.checkMaxProfit();
        if (this.isStopped()) return;
        // Closed at a profit: follow the direction (buy the same right again); closed at a loss: buy the opposite right. An adverse-move
        // hedge (the leg still open, the "stop" case) is always the opposite right. Fixed behaviour, deliberately not configurable.
        const same = avgSell > leg.entry;
        if (!leg.hedged && !leg.hedgeWaiting && leg.role === 'root' && same) {
            // The very first order made its target before any hedge was needed: do NOT buy the same direction again. It is marked hedged (nothing
            // follows it) and `restarted`, so the root gate opens and the next Nifty tick runs the contract selection (PCR direction, premium floor,
            // ATM pick) again for a fresh root.
            leg.hedged = true;
            leg.restarted = true;
            this.save();
            Log.log(`[SimpleContinuousStrategy] first order ${leg.tsym} closed at a profit with no hedge: no same-direction re-buy, the contract selection runs again for a new root`);
        } else if (!leg.hedged) await this.hedge(leg, 'target met', same);
        if (leg.role === 'hedge' && avgSell > leg.entry && leg.parentId) {
            const parent = this.state.legs[leg.parentId];
            if (parent && parent.status === 'open' && !parent.doubled) {
                parent.doubleDue = true; // stays due until the double-up really happens (see doubleUp / the tick retry)
                this.save();
                await this.doubleUp(parent);
            }
        }
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

    // ---- double-up ----

    private async doubleUp(parent: SimpleLeg): Promise<void> {
        if (parent.doubled || this.busy.has(parent.id) || !this.enabled || this.manualReview || this.isStopped()) return;
        // `doubled` is set only when the double-up actually happens (below), so a skip (cap, cancel failure, refused buy) can be retried by the
        // parent's ticks. busy keeps two attempts from running at once; lastDoubleAttempt spaces the retries.
        this.lastDoubleAttempt.set(parent.id, Date.now());
        this.busy.add(parent.id);
        const broker = this.brokerOrKite();
        try {
            const addQty = parent.qty;
            const ref = parent.entry;
            // maxInvestment does not gate the double-up (user's decision 2026-11-11): with onePositionPerSide the root already costs about the whole
            // budget, so a cap check could never pass. It is still at most once per leg (`doubled`), and maxProfit is the only brake.
            // Free the position from its resting sell first (a limit sell plus a larger buy would leave the sell covering only part).
            let cancelledFilled = 0;
            if (parent.sellQty > 0) {
                const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: parent.tsym, broker });
                if (res.cancelFailed) {
                    Log.log(`[SimpleContinuousStrategy] double-up of ${parent.tsym} aborted: its resting sell could not be cancelled`);
                    return;
                }
                cancelledFilled = res.filledQty;
                parent.sellQty = 0;
                parent.sellShortfall = 0;
            }
            if (cancelledFilled > 0) {
                // Part of the target sell filled while we were cancelling: its fill events will arrive; do not grow the position.
                Log.log(`[SimpleContinuousStrategy] double-up of ${parent.tsym} aborted: ${cancelledFilled} sold while cancelling`);
                const left = parent.qty - parent.soldQty - cancelledFilled;
                if (left > 0) await this.placeSellQty(parent, left);
                return;
            }
            let trade: Trade;
            try {
                // hedgeRebuy skips the order process's own investment-cap gate (the strategy-side check was removed 2026-11-11, but that gate refused it too: 14:11 live, kite 164264/100000).
                trade = await OrderClient.getInstance().buyContractBare(this.userId, parent.tsym, parent.token, addQty, parent.exchange, ref, this.broker(), { hedgeRebuy: true });
            } catch (e) {
                const notPlaced = this.noteBuyError(e, `double-up buy ${parent.tsym}`);
                Log.log('[SimpleContinuousStrategy] double-up buy failed:', e);
                if (notPlaced) await this.placeSellQty(parent, this.remaining(parent)); // refused: nothing bought, due again at the next retry
                else { parent.doubled = true; parent.doubleDue = false; this.save(); } // may be live: never retried blind (a retry could double twice)
                return;
            }
            const got = Number(trade.quantity) > 0 ? Number(trade.quantity) : 0;
            const price = Number(trade.price) > 0 ? Number(trade.price) : ref;
            if (got > 0) { parent.doubled = true; parent.doubleDue = false; } // the double-up happened
            if (got > 0) {
                // The reference blends like the entry; a leg still waiting for its reference tick values the old quantity from this buy.
                if (parent.pnlRefPending) { parent.pnlRef = price; parent.pnlRefPending = false; }
                else if (parent.pnlRef != null) parent.pnlRef = (parent.pnlRef * parent.qty + price * got) / (parent.qty + got);
            }
            parent.entry = (parent.entry * parent.qty + price * got) / (parent.qty + got);
            parent.qty += got;
            this.save();
            Log.log(`[SimpleContinuousStrategy] doubled ${parent.tsym}: +${got} @${price}, now qty=${parent.qty} avg=${parent.entry.toFixed(2)}`);
            await this.placeSellQty(parent, this.remaining(parent));
        } catch (e) {
            Log.log('[SimpleContinuousStrategy] double-up failed:', e);
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
            Log.log(`[SimpleContinuousStrategy] ALERT: resting sell for ${leg.tsym} failed (tick retry follows):`, e);
        }
    }

    // ---- EOD ----

    private async closeAllLegs(label: 'EOD' | 'MAX PROFIT'): Promise<void> {
        for (const leg of this.openLegs()) {
            if (this.busy.has(leg.id)) continue;
            this.busy.add(leg.id);
            try {
                let filled = 0;
                if (leg.sellQty > 0) {
                    const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: leg.tsym, broker: this.brokerOrKite() });
                    if (res.cancelFailed) { Log.log(`[SimpleContinuousStrategy] ${label}: could not cancel the resting sell of ${leg.tsym}, retrying`); continue; }
                    filled = res.filledQty;
                    leg.sellQty = 0;
                    leg.sellShortfall = 0;
                }
                const left = leg.qty - leg.soldQty - filled;
                if (left > 0) await chunkedLegSell(this.userId, leg.tsym, left, this.broker());
                leg.status = 'closed';
                this.unwatch(leg);
                this.save();
                Log.log(`[SimpleContinuousStrategy] ${label}: closed ${leg.tsym}`);
            } catch (e) {
                Log.log(`[SimpleContinuousStrategy] ${label} close of ${leg.tsym} failed, retrying:`, e);
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
