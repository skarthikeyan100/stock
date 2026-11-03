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
import { isPastTime } from '../util/marketHours';
import { BrokerName, normalizeBrokerName } from '../util/brokerName';
import { NOT_PLACED_TAG } from '../ipc/orderProtocol';
import { MOCK_BROKER, PCR_WINDOW_POINTS } from '../constants';

// SimpleContinuousStrategy (config keys: initialQuantity, maxInvestment, priceDiff, plus enabled/brokers):
//   1. PCR gives the direction of the ROOT entry (PCR > 1 -> PE, else CE), `initialQuantity` at market. There is ONE root per day;
//      every later order is a hedge or a double-up.
//   2. Right after the fill a resting limit sell is placed at entry + priceDiff.
//   3. EVERY leg (root or hedge) is hedged exactly once, by buying the opposite option at the strike nearest the money for the same quantity, either when its price
//      falls to entry - priceDiff (adverse) or when its resting sell fills (target met, at the then-current price). The hedge buy is a
//      leg of its own with its own resting sell at its entry + priceDiff, and it is hedged once in turn, so the chain is unlimited.
//   4. There is no stop loss: a leg ends only through its resting sell (or the EOD close).
//   5. When a hedge leg's sell fills at a profit and the leg that caused it (its parent) is still open, the parent is doubled ONCE
//      per leg (the same contract is bought again for the parent's quantity, its resting sell is re-placed for the new total at the
//      new average + priceDiff). It is skipped when it would exceed maxInvestment.
//   6. maxInvestment (per broker) gates the root and the double-up. Hedge buys ignore it (a hedge refused by the cap would leave a
//      leg unprotected).
// State (hedged / doubled / quantities) is kept per day in a JSON file and checked against the broker's open trades at reconcile.

const PCR_RECHECK_MS = 5 * 60 * 1000;
const ROOT_MIN_PREMIUM = 100; // ContinuousStrategy's default; there is deliberately no config key for it
const SELL_RETRY_MS = 10_000;
const EOD_RETRY_MS = 5_000;

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
    sellPrice: number;
}

interface State { day: string; legs: Record<string, SimpleLeg>; seq: number }

const opposite = (r: Right): Right => (r === 'CE' ? 'PE' : 'CE');

export default class SimpleContinuousStrategy extends Strategy {
    name = 'SimpleContinuousStrategy';
    legTokenFeed = 'ant' as const; // legs carry ANT tokens whatever broker places the orders

    private state: State = { day: '', legs: {}, seq: 0 };
    private loaded = false;
    private lastNiftyLtp = 0;
    private lastPcr: { value: number; at: number } | null = null;
    private entering = false;
    private manualReview = false; // an unconfirmed buy may be live: no new buys until a human looks and reset() clears it
    private blocked = false;      // reconcile could not read the open trades: no new entries
    private busy = new Set<string>();           // leg ids with a hedge / double-up / sell placement in flight
    private lastSellAttempt = new Map<string, number>();
    private lastEodAttempt = 0;
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

    // ---- persistence ----

    private stateFile(): string {
        return path.join(__dirname, `../../.SimpleContinuousStrategy.${this.userId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }

    private ensureLoaded(): void {
        const today = localDayKey();
        if (this.loaded && this.state.day === today) return;
        this.loaded = true;
        let fresh: State = { day: today, legs: {}, seq: 0 };
        try {
            const raw = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as State;
            if (raw?.day === today) fresh = raw;
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
        return isPastTime(this.setting<string>('eodCloseTime'));
    }

    // The order process refuses a buy with a tagged error: "definitely not placed" is safe to retry, anything else may be live.
    private noteBuyError(e: any, what: string): boolean {
        const msg = String(e?.message ?? e);
        if (msg.includes(NOT_PLACED_TAG) && !isUnconfirmedBuyError(e)) return true; // definitely not placed
        // Anything else (unconfirmed fill, timeout, transport error) leaves the outcome unknown: it may be live.
        this.manualReview = true;
        Log.log(`[SimpleContinuousStrategy] ALERT: ${what} may be live at the broker - no new buys until it is reviewed and the strategy is reset: ${msg}`);
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
        if (this.isEod()) {
            if (Date.now() - this.lastEodAttempt > EOD_RETRY_MS) {
                this.lastEodAttempt = Date.now();
                await this.closeAllForEod();
            }
            return;
        }
        if (!this.isTimeInRange()) { this.gateLog.log('outside time window'); return; }
        if (this.manualReview) { this.gateLog.log('manual review pending (unconfirmed buy)'); return; }
        if (this.blocked || !this.stateLoaded) { this.gateLog.log('state not loaded / open trades unreadable'); return; }
        if (this.entering) return;
        const cfg = this.cfg();
        const qty = Number(cfg.initialQuantity);
        const maxInvestment = Number(cfg.maxInvestment);
        if (!(qty > 0) || !(maxInvestment > 0) || !(this.priceDiff() > 0)) { this.gateLog.log('initialQuantity / maxInvestment / priceDiff not set'); return; }
        // One root per day: after it, every order is a hedge (or a double-up). Adopted legs count (reconcile gives them role 'root').
        if (Object.values(this.state.legs).some((l) => l.role === 'root')) { this.gateLog.log('root already opened today'); return; }

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
        const contract = await ops.pickContract(this.userId, ltp, right, ROOT_MIN_PREMIUM, []);
        if (this.invested() + contract.premium * qty > maxInvestment) {
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
            await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            leg.sellQty = quantity;
            leg.sellPrice = price;
            this.save();
            Log.log(`[SimpleContinuousStrategy] resting sell ${leg.tsym} qty=${quantity} @${price}`);
        } catch (e) {
            Log.log(`[SimpleContinuousStrategy] ALERT: resting sell for ${leg.tsym} failed (retried every ${SELL_RETRY_MS / 1000}s):`, e);
        } finally {
            this.busy.delete(leg.id);
        }
    }

    // ---- ticks ----

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        const leg = this.legByToken(String(quote.token));
        if (!leg || !(quote.ltp > 0) || this.isEod()) return;
        // A leg whose sell never got placed (placement failed, or a restart found none resting) is retried.
        if (leg.sellQty === 0 && !this.busy.has(leg.id) && Date.now() - (this.lastSellAttempt.get(leg.id) ?? 0) > SELL_RETRY_MS) {
            await this.placeSell(leg);
        }
        if (!leg.hedged && quote.ltp <= leg.entry - this.priceDiff()) {
            await this.hedge(leg, 'adverse move');
        }
    };

    // ---- hedge ----

    private async hedge(leg: SimpleLeg, reason: string): Promise<void> {
        if (leg.hedged || this.busy.has(leg.id) || !this.enabled || this.manualReview || this.isEod()) return;
        leg.hedged = true; // synchronous, before any await: a second tick must not buy a second hedge
        this.busy.add(leg.id);
        this.save();
        try {
            const right = opposite(leg.right);
            const ops = brokerLegOps(() => this.cfg()?.broker);
            // The hedge is the opposite option at the strike nearest the money (pickContract walks ATM first, then out of / in the money). The
            // premium floor of 1 only skips a strike with no price. A strike already held on that side is skipped (one position per contract).
            const contract = await ops.pickContract(this.userId, this.lastNiftyLtp, right, 1, this.excludeStrikes(right));
            let trade: Trade;
            try {
                trade = await OrderClient.getInstance().buyContractBare(this.userId, contract.tradingSymbol, contract.token, leg.qty, contract.exchange, contract.premium, this.broker(), { hedgeRebuy: true });
            } catch (e) {
                const notPlaced = this.noteBuyError(e, `hedge buy ${contract.tradingSymbol}`);
                if (notPlaced) leg.hedged = false; // nothing was placed: the next tick may try again
                Log.log(`[SimpleContinuousStrategy] hedge buy failed (${notPlaced ? 'not placed, will retry' : 'may be live'}):`, e);
                this.save();
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
        leg.soldQty += qty;
        leg.soldValue += qty * Number(trade.price);
        if (leg.soldQty < leg.qty) { this.save(); return; } // chunked sell: the rest is still resting
        leg.status = 'closed';
        leg.sellQty = 0;
        this.unwatch(leg);
        const avgSell = leg.soldValue / leg.soldQty;
        const pnl = (avgSell - leg.entry) * leg.qty;
        this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
        Log.log(`[SimpleContinuousStrategy] ${leg.tsym} closed qty=${leg.qty} entry=${leg.entry.toFixed(2)} sell=${avgSell.toFixed(2)} pnl=${Math.round(pnl)}`);
        this.save();
        if (this.isEod()) return;
        if (!leg.hedged) await this.hedge(leg, 'target met');
        if (leg.role === 'hedge' && avgSell > leg.entry && leg.parentId) {
            const parent = this.state.legs[leg.parentId];
            if (parent && parent.status === 'open' && !parent.doubled) await this.doubleUp(parent);
        }
    };

    onOrderCancelled = async (): Promise<void> => {
        // A resting sell that was cancelled outside this strategy is re-placed by the tick retry (sellQty is reset here).
        for (const leg of this.openLegs()) if (leg.sellQty > 0 && !this.busy.has(leg.id)) leg.sellQty = 0;
    };

    // ---- double-up ----

    private async doubleUp(parent: SimpleLeg): Promise<void> {
        if (parent.doubled || this.busy.has(parent.id) || !this.enabled || this.manualReview || this.isEod()) return;
        parent.doubled = true; // once, whatever the outcome
        this.busy.add(parent.id);
        this.save();
        const broker = this.brokerOrKite();
        try {
            const addQty = parent.qty;
            const ref = parent.entry;
            if (this.invested() + ref * addQty > Number(this.cfg().maxInvestment)) {
                Log.log(`[SimpleContinuousStrategy] double-up of ${parent.tsym} skipped: would exceed maxInvestment`);
                return;
            }
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
                trade = await OrderClient.getInstance().buyContractBare(this.userId, parent.tsym, parent.token, addQty, parent.exchange, ref, this.broker());
            } catch (e) {
                const notPlaced = this.noteBuyError(e, `double-up buy ${parent.tsym}`);
                Log.log('[SimpleContinuousStrategy] double-up buy failed:', e);
                if (notPlaced) await this.placeSellQty(parent, this.remaining(parent));
                return;
            }
            const got = Number(trade.quantity) > 0 ? Number(trade.quantity) : 0;
            const price = Number(trade.price) > 0 ? Number(trade.price) : ref;
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
            await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tradingSymbol: leg.tsym, instrumentId: leg.token, quantity, price, broker: this.brokerOrKite(),
            });
            leg.sellQty = quantity;
            leg.sellPrice = price;
            this.save();
            Log.log(`[SimpleContinuousStrategy] resting sell ${leg.tsym} qty=${quantity} @${price}`);
        } catch (e) {
            Log.log(`[SimpleContinuousStrategy] ALERT: resting sell for ${leg.tsym} failed (tick retry follows):`, e);
        }
    }

    // ---- EOD ----

    private async closeAllForEod(): Promise<void> {
        for (const leg of this.openLegs()) {
            if (this.busy.has(leg.id)) continue;
            this.busy.add(leg.id);
            try {
                let filled = 0;
                if (leg.sellQty > 0) {
                    const res = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tradingSymbol: leg.tsym, broker: this.brokerOrKite() });
                    if (res.cancelFailed) { Log.log(`[SimpleContinuousStrategy] EOD: could not cancel the resting sell of ${leg.tsym}, retrying`); continue; }
                    filled = res.filledQty;
                    leg.sellQty = 0;
                }
                const left = leg.qty - leg.soldQty - filled;
                if (left > 0) await chunkedLegSell(this.userId, leg.tsym, left, this.broker());
                leg.status = 'closed';
                this.unwatch(leg);
                this.save();
                Log.log(`[SimpleContinuousStrategy] EOD: closed ${leg.tsym}`);
            } catch (e) {
                Log.log(`[SimpleContinuousStrategy] EOD close of ${leg.tsym} failed, retrying:`, e);
            } finally {
                this.busy.delete(leg.id);
            }
        }
    }

    reset(): void {
        super.reset();
        this.manualReview = false;
        this.entering = false;
        this.busy.clear();
    }
}
