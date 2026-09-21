import crypto from 'crypto';
import Log from '../util/Log';
import { CALL, PUT, DEFAULT_MAX_INVESTMENT } from '../constants';
import { Trade } from '../model/model';
import OrderClient from '../processes/strategies/OrderClient';
import AntContractMaster from '../ant/AntContractMaster';
import { watchToken, unwatchToken, registerTrade } from '../processes/strategies/tokenRouter';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';

// Extracted from ContinuousStrategy.ts (2026-09-11) so the same loss-driven
// hedge-spawn/averaging/refill/maxProfit leg lifecycle can be reused by
// SupportResistanceStrategy. Each owning strategy instance constructs its
// own private LegManager instance (NOT a singleton) - see LegManagerDeps.

// Persisted separately from the raw `Trade` fill collection - a small
// append-only record of "this legRef was created, with this parent/level/
// isRoot" written at the moment each leg (root open, hedge spawn, or refill
// fill) first exists. `legRef` is a stable id that survives a process
// restart, unlike Leg.legId (an in-memory counter reset to 0 on every
// restart) - this is what lets restoreFromOpenTrades below rebuild the true
// spawn-tree shape instead of guessing every restored leg is an independent
// root. `ownerType` discriminates between strategy types sharing this same
// Mongo collection (e.g. ContinuousStrategy vs SupportResistanceStrategy) so
// their legs can never cross-match each other's lineage docs.
interface LegLineageDoc {
    legRef: string;
    token: string;
    tsym: string;
    parentLegRef: string | null;
    parentLevel: number | null;
    isRoot: boolean;
    ownerType?: string;
    createdAt: Date;
}

// Sentinel used to reserve a level slot synchronously (before the spawn's
// contract-lookup/buy await resolves) so a burst of unawaited ticks for the
// same token can't double-spawn the same level. Replaced with the real legId
// on success, or removed again on failure/capital-block so the slot can retry.
const PENDING = '__pending__';

// Gate-log throttle for LegManager's own gated log lines (e.g. "no
// underlying price yet") - matches ContinuousStrategy's original
// GATE_LOG_THROTTLE_MS value (5 min) so behavior is unchanged post-extraction.
const GATE_LOG_THROTTLE_MS = 5 * 60 * 1000;

export interface Leg {
    legId: string;
    token: string;
    tsym: string;
    strike: number;
    exchange: 'NFO' | 'BFO';
    right: string; // CALL | PUT
    entryPrice: number; // E - original entry price, fixed forever; still what adverse-level/square-off
    // triggers are measured against, unaffected by averaging.
    quantity: number; // original entry quantity, fixed forever - used for level/threshold
    // math (via entryPrice) and target-hit refill re-entry sizing. Hedge-spawn sizing
    // (trySpawnLevel) reads totalQuantity instead - see its own comment.
    isRoot: boolean; // true only for the root entry and any later refill/restart of it
    parentLegId: string | null; // null for root legs
    parentLevel: number | null; // 1-N (N = cfg.maxLevels): which slot on the parent this leg occupies; null for root
    childByLevel: Map<number, string>; // level (1-N) -> currently-open child legId (or PENDING while spawning)
    status: 'OPEN' | 'CLOSING';
    avgPrice: number; // running average cost basis; == entryPrice until the first average-add
    totalQuantity: number; // actual held size including average-adds; == quantity until the first average-add
    averagedLevels: Set<number>; // which of levels 1-N already triggered an average-add on this leg
    legRef: string; // stable id persisted in legLineage - see persistLegLineage/restoreFromOpenTrades
    parentLegRef: string | null; // mirrors parentLegId but stable across a restart; null for root
    lastLtp?: number; // latest known LTP for this leg's token, cached on every onOptionTick
    // call (even ticks that don't otherwise act) - feeds computeCumulativeProfit's unrealized
    // sum. Undefined until this leg's first post-open quote - callers fall back to avgPrice
    // (0 unrealized) until then.
}

export interface PendingReEntry {
    token: string;
    tsym: string;
    exchange: 'NFO' | 'BFO';
    strike: number;
    right: string;
    quantity: number;
    limitPrice: number; // = the original entry price E being re-entered at
    orderId: string; // Zerodha order id, for cancelling on drift (see checkRefillDrift)
    isRoot: boolean; // mirrors Leg.isRoot - which identity to reconstruct once this fills (see handleFillOrExternalSell)
    parentLegId: string | null; // mirrors Leg.parentLegId - null for a root refill
    parentLevel: number | null; // mirrors Leg.parentLevel - which slot to reoccupy on fill
    parentLegRef: string | null; // mirrors Leg.parentLegRef - null for a root refill
}

export interface LegManagerConfig {
    slDistance: number;
    squareOffDistance?: number; // default 50
    maxLevels?: number; // default 4
    hedgeStartLevel?: number; // default 1 (today's behavior - hedge from level 1). Levels below this only average, never spawn a hedge.
    spawnQuantityMode?: string | number;
    averageQuantityMode?: 'same' | 'multiplied';
    postAverageTargetDistance?: number; // default 1
    marketSentiment?: string;
    refillCancelDistance?: number; // default 50
    minPremium?: number; // default 100
    maxInvestment?: number; // falls back to DEFAULT_MAX_INVESTMENT
    maxProfit?: number | null; // null/undefined disables the feature
    // Used only by restoreFromOpenTrades's wasAveraged heuristic - optional
    // since not every owning strategy has an "initial entry size" config key
    // (e.g. SupportResistanceStrategy has none; restored legs there simply
    // default to wasAveraged=false, a harmless default for a brand-new
    // strategy with no restore history to preserve).
    initialQuantity?: number;
}

export interface LegManagerDeps {
    userId: string;
    ownerType: string; // log-prefix + legLineage discriminator
    strategyRef: Strategy; // passed to watchToken/unwatchToken/registerTrade (tokenRouter keys off the Strategy instance)
    getConfig: () => LegManagerConfig;
    getLastUnderlyingLtp: () => number;
    recordOutcome: (outcome: 'win' | 'loss' | 'timeout', pnl: number) => void;
}

export class LegManager {
    private legsByToken: Map<string, Leg> = new Map();
    private pendingReEntries: Map<string, PendingReEntry> = new Map(); // keyed by token
    private deferredRootRefill: PendingReEntry | null = null;
    private legIdCounter = 0;
    private lastGateLog = new Map<string, number>();
    // True forever (until reset()) from the moment any capitalCheck() call
    // first observes total exposure that would exceed maxInvestment. One-way
    // latch, not a per-tick re-check: once breached, no NEW order is ever
    // placed again this session, even after an exit frees up capital.
    // Already-open legs keep exiting normally - target-hit and square-off
    // paths never call capitalCheck and are untouched by this.
    private capitalGateTripped = false;
    // One-way latch mirroring capitalGateTripped, but keyed off cumulative P&L
    // (realized + unrealized across all open legs) instead of exposure - see
    // checkAndMaybeTripMaxProfit. Configured via cfg.maxProfit (% of
    // maxInvestment); unset disables the feature entirely.
    private maxProfitTripped = false;
    // totalPnL snapshot taken at the last reset() call. computeCumulativeProfit uses
    // (recordedPnL - maxProfitBaseline) instead of raw totalPnL so that a reset() actually
    // re-arms max-profit tracking for a fresh session.
    private maxProfitBaseline = 0;
    private realizedPnL = 0; // mirrors the owning strategy's totalPnL, tracked independently so computeCumulativeProfit doesn't need a getter callback
    // Serializes every contract-selection+buy decision (root entry, spawns,
    // root refill) on this instance. Without this, concurrent ticks (e.g. two
    // different open legs both crossing a spawn threshold within the same
    // event-loop turn) can each compute openStrikesFor()/capitalCheck()
    // against the same "before" snapshot of legsByToken, independently pass,
    // and both buy - landing on the same strike/token.
    private opLock: Promise<any> = Promise.resolve();

    constructor(private deps: LegManagerDeps) {}

    private withOpLock<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.opLock.then(fn, fn);
        this.opLock = result.catch(() => {}); // don't let one failure poison the chain for later callers
        return result;
    }

    private logGateOnce(reason: string): void {
        const now = Date.now();
        const last = this.lastGateLog.get(reason) ?? 0;
        if (now - last < GATE_LOG_THROTTLE_MS) return;
        this.lastGateLog.set(reason, now);
        Log.log(`[${this.deps.ownerType}] ${reason}`);
    }

    // Fire-and-forget, same convention as bookkeeping.ts's notifications/
    // payoutDecisionLog inserts - never let a Mongo hiccup block live
    // trading. Written once, right when a leg is first created - never
    // updated again, so a later restoreFromOpenTrades always sees the leg's
    // original identity/lineage.
    private persistLegLineage(leg: Leg): void {
        Mongo.getInstance()?.db.collection('legLineage').insertOne({
            userId: this.deps.userId, ownerType: this.deps.ownerType, legRef: leg.legRef, token: leg.token, tsym: leg.tsym,
            parentLegRef: leg.parentLegRef, parentLevel: leg.parentLevel, isRoot: leg.isRoot,
            createdAt: new Date(),
        }).catch((e) => Log.log(`[${this.deps.ownerType}] legLineage insert failed (continuing without persistence):`, e));
    }

    // A token can in principle have more than one legLineage doc over time
    // (opened, closed, later reopened) - only the most recent one (by
    // createdAt) describes the currently-open leg, so later docs in the
    // ascending-sorted result simply overwrite earlier ones in the map.
    // Tolerant of missing ownerType (pre-existing docs written before this
    // field existed) so a restart right after this field is added still
    // restores correctly.
    private async loadLatestLegLineage(tokens: string[]): Promise<Map<string, LegLineageDoc>> {
        const result = new Map<string, LegLineageDoc>();
        const db = Mongo.getInstance()?.db;
        if (!db || tokens.length === 0) return result;
        try {
            const docs = await db.collection('legLineage')
                .find({
                    userId: this.deps.userId,
                    token: { $in: tokens },
                    $or: [{ ownerType: this.deps.ownerType }, { ownerType: { $exists: false } }],
                })
                .sort({ createdAt: 1 })
                .toArray();
            for (const d of docs) result.set(d.token, d as unknown as LegLineageDoc);
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] legLineage query failed - restored legs will default to isRoot:true with no lineage:`, e);
        }
        return result;
    }

    private nextLegId(): string {
        return `${this.deps.userId}-leg-${++this.legIdCounter}`;
    }

    private openStrikesFor(right: string): Set<number> {
        const strikes = new Set<number>();
        for (const leg of this.legsByToken.values()) {
            if (leg.right === right) strikes.add(leg.strike);
        }
        return strikes;
    }

    private hasOpenNestedLegs(): boolean {
        for (const leg of this.legsByToken.values()) {
            if (!leg.isRoot) return true;
        }
        return false;
    }

    hasOpenLegOfRight(right: string): boolean {
        for (const leg of this.legsByToken.values()) {
            if (leg.right === right) return true;
        }
        return false;
    }

    // sum(qty * entryPrice) over open legs + pending re-entries, plus the new
    // order's own projected cost, must stay under maxInvestment. A skip IS
    // sticky: the first time this returns false for ANY caller,
    // capitalGateTripped latches permanently and every subsequent call - for
    // the rest of this process's life - short-circuits to false without even
    // recomputing `total`, regardless of whether capital later frees up.
    // `logCtx` identifies the triggering call site/contract in the one-time
    // trip log line.
    async capitalCheck(newQty: number, estimatedPremium: number, logCtx: string): Promise<boolean> {
        if (this.capitalGateTripped) return false; // latched permanently - see field comment
        const cfg = this.deps.getConfig();
        const maxInvestment = cfg.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
        let total = 0;
        for (const leg of this.legsByToken.values()) total += leg.totalQuantity * leg.avgPrice;
        for (const pending of this.pendingReEntries.values()) total += pending.quantity * pending.limitPrice;
        total += newQty * estimatedPremium;
        if (total <= maxInvestment) return true;
        this.capitalGateTripped = true;
        Log.log(`[${this.deps.ownerType}] CAPITAL GATE TRIPPED (${logCtx}) - total=${Math.round(total)} maxInvestment=${maxInvestment} newQty=${newQty} estimatedPremium=${estimatedPremium} - permanently blocking all new orders for the rest of this session`);
        return false;
    }

    // Realized (this-session, since the last reset()) + unrealized P&L across every
    // currently open leg.
    private computeCumulativeProfit(): number {
        let unrealized = 0;
        for (const leg of this.legsByToken.values()) {
            const ltp = leg.lastLtp ?? leg.avgPrice; // no quote seen yet -> contributes 0
            unrealized += (ltp - leg.avgPrice) * leg.totalQuantity;
        }
        return (this.realizedPnL - this.maxProfitBaseline) + unrealized;
    }

    // One-way latch, mirrors capitalGateTripped but keyed off cumulative P&L
    // instead of exposure. maxProfit is a % of maxInvestment (the CONFIGURED
    // cap, not live deployed capital). Unset/null maxProfit disables the
    // feature entirely (no-op).
    private checkAndMaybeTripMaxProfit(cfg: LegManagerConfig): void {
        if (this.maxProfitTripped) return; // latched permanently - see field comment
        if (cfg.maxProfit == null) return; // feature not configured
        const maxInvestment = cfg.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
        const threshold = (cfg.maxProfit / 100) * maxInvestment;
        const cumulative = this.computeCumulativeProfit();
        if (cumulative < threshold) return;
        this.maxProfitTripped = true;
        Log.log(`[${this.deps.ownerType}] MAX PROFIT TRIPPED - cumulative=${Math.round(cumulative)} threshold=${Math.round(threshold)} (maxProfit=${cfg.maxProfit}% of maxInvestment=${maxInvestment}) - closing all legs, cancelling all pending re-entries, and permanently blocking new entries for the rest of this session`);
    }

    // Invoked once maxProfitTripped latches - idempotent/safe to call
    // repeatedly: only acts on legs still 'OPEN' and re-entries still
    // present, so a partial failure (some legs closed, some still resting)
    // simply retries the remainder on the next tick.
    private async closeAllLegsAndCancelReEntries(): Promise<void> {
        for (const leg of Array.from(this.legsByToken.values())) {
            if (leg.status !== 'OPEN') continue; // already closing (this call, or a previous tick's)
            leg.status = 'CLOSING'; // synchronous, before any await
            const ltp = leg.lastLtp ?? leg.avgPrice;
            try {
                await OrderClient.getInstance().sellContractBare(this.deps.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            } catch (e) {
                leg.status = 'OPEN'; // still live at broker - retry next tick
                Log.log(`[${this.deps.ownerType}] Max-profit mass close sell failed, leg remains open for retry:`, e);
                continue;
            }
            this.legsByToken.delete(leg.token);
            const pnl = (ltp - leg.avgPrice) * leg.totalQuantity;
            // Per-leg sign, independent of the aggregate trigger - a hedge leg individually
            // at a loss is still correctly tagged 'loss' even during an aggregate-profit close.
            this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
            Log.log(`[${this.deps.ownerType}] Max-profit close (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);
        }

        for (const [token, intent] of Array.from(this.pendingReEntries.entries())) {
            this.pendingReEntries.delete(token); // synchronous, before any await
            unwatchToken(token, this.deps.strategyRef);
            try {
                await OrderClient.getInstance().cancelOrderBare(this.deps.userId, intent.orderId);
                Log.log(`[${this.deps.ownerType}] Max-profit: pending re-entry cancelled: ${intent.tsym}`);
            } catch (e) {
                Log.log(`[${this.deps.ownerType}] Max-profit: pending re-entry cancel failed:`, e);
            }
        }

        this.deferredRootRefill = null; // never placed at the broker - just drop the intent
    }

    private recordOutcome(outcome: 'win' | 'loss' | 'timeout', pnl: number): void {
        this.realizedPnL += pnl;
        this.deps.recordOutcome(outcome, pnl);
    }

    canHandle(token: string): boolean {
        return this.legsByToken.has(token) || this.pendingReEntries.has(token);
    }

    isIdle(): boolean {
        return this.legsByToken.size === 0 && this.pendingReEntries.size === 0 && !this.deferredRootRefill;
    }

    isCapitalGateTripped(): boolean {
        return this.capitalGateTripped;
    }

    isMaxProfitTripped(): boolean {
        return this.maxProfitTripped;
    }

    getLegsByToken(): Map<string, Leg> {
        return this.legsByToken;
    }

    getPendingReEntries(): Map<string, PendingReEntry> {
        return this.pendingReEntries;
    }

    getDeferredRootRefill(): PendingReEntry | null {
        return this.deferredRootRefill;
    }

    // Target distance from avgPrice - full slDistance for a never-averaged
    // leg. Once the leg has absorbed at least one average-add, it normally
    // collapses to a much tighter postAverageTargetDistance (defaults to 1)
    // UNLESS marketSentiment favors this leg's own direction (up + CALL, or
    // down + PUT), in which case it holds out for the full slDistance
    // instead of bailing early. marketSentiment is off (falls back to
    // postAverageTargetDistance) when unset, empty, or the literal 'none'.
    private targetFor(leg: Leg, cfg: LegManagerConfig, D: number): number {
        if (leg.averagedLevels.size === 0) return leg.avgPrice + D;
        const sentiment = (cfg.marketSentiment && cfg.marketSentiment !== 'none') ? cfg.marketSentiment : undefined;
        const sentimentAligned = (sentiment === 'up' && leg.right === CALL) || (sentiment === 'down' && leg.right === PUT);
        const postAverageTarget = sentimentAligned ? D : (cfg.postAverageTargetDistance ?? 1);
        return leg.avgPrice + postAverageTarget;
    }

    // Opens a brand-new root leg: resolves a contract via
    // getContractByPriceRangeBare, capital-checks, buys, and commits to
    // legsByToken. Returns the created Leg, or null if the capital gate
    // blocked it or a duplicate leg already exists for the resolved token
    // (both non-exceptional outcomes - the caller resets its own `ordered`
    // gate in that case). Throws on a genuine order-placement failure -
    // caller is responsible for catching and resetting its `ordered` gate.
    async openRootLeg(params: {
        right: string;
        underlyingLtp: number;
        minPremium: number;
        quantity: number;
        entryLabel: string; // e.g. 'T1 entry' - used both as the capitalCheck logCtx and the success log line, so callers can preserve their own exact log wording
    }): Promise<Leg | null> {
        return this.withOpLock(async () => {
            const optionType = params.right === CALL ? 'CE' : 'PE';
            const excludeStrikes = Array.from(this.openStrikesFor(params.right));
            const contract = await OrderClient.getInstance().getContractByPriceRangeBare(
                this.deps.userId, params.underlyingLtp, optionType, params.minPremium, 'NIFTY', excludeStrikes
            );
            if (!(await this.capitalCheck(params.quantity, contract.premium, params.entryLabel))) {
                return null;
            }
            // ANT token, not Zerodha's instrumentToken - live option ticks are keyed by
            // ANT's own token (OptionQuote.fromAnt), so this leg's tick subscription and
            // canHandle matching (both keyed off this token) must use it too.
            const trade: Trade = await OrderClient.getInstance().buyContractBare(
                this.deps.userId, contract.tradingSymbol, String(contract.antToken), params.quantity, contract.exchange, contract.premium
            );
            // Defense-in-depth: the buy already executed on the broker by this
            // point, so this can't prevent a duplicate order - only stop it from
            // silently erasing tracking of a pre-existing leg on the same token.
            const existing = this.legsByToken.get(trade.token);
            if (existing) {
                Log.log(`[${this.deps.ownerType}] REFUSING entry - token ${trade.token} already has an open leg in memory: ${JSON.stringify(existing)}. New untracked fill: ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
                return null;
            }
            const leg: Leg = {
                legId: this.nextLegId(), token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                right: params.right, entryPrice: trade.price, quantity: trade.quantity, isRoot: true,
                parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN',
                avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
                legRef: crypto.randomUUID(), parentLegRef: null,
            };
            this.legsByToken.set(trade.token, leg);
            this.persistLegLineage(leg);
            Log.log(`[${this.deps.ownerType}] ${params.entryLabel}: ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
            this.logLegStatus(leg);
            return leg;
        });
    }

    // Handles every option tick for a token this instance is tracking (an
    // open leg, or a pending refill). Mirrors ContinuousStrategy's original
    // processOptionQuote body exactly, generalized off `this.cfg()`/
    // `this.lastNiftyLtp` into deps.getConfig()/deps.getLastUnderlyingLtp().
    async onOptionTick(token: string, ltp: number): Promise<void> {
        const leg = this.legsByToken.get(token);
        // Cache before any early return - see Leg.lastLtp comment. Guard against NaN (a
        // known gap in ~12.5% of historical backtest CSV rows, and cheap insurance against
        // any similarly malformed live tick) - target/adverse-level comparisons against a
        // raw NaN ltp are already naturally false and harmless, but computeCumulativeProfit
        // does ARITHMETIC with lastLtp, not a comparison: a single NaN tick would otherwise
        // permanently poison this leg's contribution to every future maxProfit check for as
        // long as it stays open, since NaN propagates through the sum regardless of every
        // other leg's valid values, and `if (cumulative < threshold) return;` fails open on
        // NaN (any comparison with NaN is false in JS) - a spurious trip, not a real one.
        if (leg && !Number.isNaN(ltp)) leg.lastLtp = ltp;

        if (!this.maxProfitTripped) this.checkAndMaybeTripMaxProfit(this.deps.getConfig());
        if (this.maxProfitTripped) { await this.closeAllLegsAndCancelReEntries(); return; }

        if (!leg) {
            await this.checkRefillDrift(token, ltp);
            return;
        }
        if (leg.status !== 'OPEN') return; // a close attempt for this leg is already in flight

        const cfg = this.deps.getConfig();
        const D = cfg.slDistance;

        // Target hit - avgPrice/totalQuantity equal entryPrice/quantity until this leg
        // has been averaged at least once, so this is unchanged for a never-averaged leg.
        const target = this.targetFor(leg, cfg, D);
        if (ltp >= target) {
            leg.status = 'CLOSING'; // synchronous, before any await - blocks re-entry into this branch for concurrent ticks
            try {
                await OrderClient.getInstance().sellContractBare(this.deps.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            } catch (e) {
                leg.status = 'OPEN'; // sell never reached the broker - leg is still live there, keep tracking it for retry
                Log.log(`[${this.deps.ownerType}] Target-hit sell failed, leg remains open for retry:`, e);
                return;
            }
            this.legsByToken.delete(leg.token);
            const pnl = (ltp - leg.avgPrice) * leg.totalQuantity;
            this.recordOutcome('win', pnl);
            Log.log(`[${this.deps.ownerType}] Target hit (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

            if (!leg.isRoot) {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }

            const eligible = leg.isRoot || this.isParentAlive(leg.parentLegId);
            if (eligible) {
                const intent: PendingReEntry = {
                    token: leg.token, tsym: leg.tsym, exchange: leg.exchange, strike: leg.strike,
                    right: leg.right, quantity: leg.quantity, limitPrice: leg.entryPrice,
                    orderId: '', // set once placeRefill's order placement returns
                    isRoot: leg.isRoot, parentLegId: leg.parentLegId, parentLevel: leg.parentLevel,
                    parentLegRef: leg.parentLegRef,
                };
                let placed: boolean;
                if (leg.isRoot && this.hasOpenNestedLegs()) {
                    this.deferredRootRefill = intent;
                    Log.log(`[${this.deps.ownerType}] Root refill deferred (nested legs still open): ${leg.tsym}`);
                    placed = true;
                } else {
                    placed = await this.placeRefill(intent);
                }
                if (!placed) await this.cancelChildRefills(leg);
            } else {
                Log.log(`[${this.deps.ownerType}] No refill - parent closed: ${leg.tsym}`);
                await this.cancelChildRefills(leg);
            }
            return;
        }

        // Adverse levels (1x-N), measured from this leg's own ORIGINAL entry price -
        // unaffected by averaging. The hard square-off below is a separate, directly
        // configured point distance (squareOffDistance) - checked first and
        // independently, not as "level N+1".
        const adverseMove = leg.entryPrice - ltp;
        if (adverseMove <= 0) return;

        const squareOffDistance = cfg.squareOffDistance ?? 50; // default preserves the old 5*slDistance(10)=50 behavior
        if (adverseMove >= squareOffDistance) {
            leg.status = 'CLOSING'; // synchronous, before any await - blocks re-entry into this branch for concurrent ticks
            try {
                await OrderClient.getInstance().sellContractBare(this.deps.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            } catch (e) {
                leg.status = 'OPEN'; // sell never reached the broker - leg is still live there, keep tracking it for retry
                Log.log(`[${this.deps.ownerType}] Square-off sell failed, leg remains open for retry:`, e);
                return;
            }
            this.legsByToken.delete(leg.token);
            const pnl = (ltp - leg.avgPrice) * leg.totalQuantity;
            this.recordOutcome('loss', pnl);
            Log.log(`[${this.deps.ownerType}] Square-off (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

            if (!leg.isRoot) {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }
            await this.cancelChildRefills(leg); // leg is gone for good either way (root or nested)
            return;
        }

        const maxLevels = cfg.maxLevels ?? 4;
        const level = Math.min(maxLevels, Math.floor(adverseMove / D));
        if (level >= 1 && level <= maxLevels) {
            const hedgeStartLevel = cfg.hedgeStartLevel ?? 1;
            if (level >= hedgeStartLevel && !leg.childByLevel.has(level)) {
                await this.trySpawnLevel(leg, level);
            }
            if (!leg.averagedLevels.has(level)) {
                await this.tryAverageLevel(leg, level, ltp);
            }
        }
    }

    private async trySpawnLevel(leg: Leg, level: number): Promise<void> {
        if (this.capitalGateTripped) return; // silent - see capitalGateTripped's comment
        // getLastUnderlyingLtp() is 0 right after any restart until the first
        // underlying tick arrives. A spawn triggered off an option leg's own
        // tick before then would look up a contract against underlyingLtp=0
        // and always fail. Skip and retry on the next qualifying tick once a
        // real price is available, instead of reserving the level slot and
        // logging a guaranteed failure.
        const underlyingLtp = this.deps.getLastUnderlyingLtp();
        if (underlyingLtp <= 0) { this.logGateOnce(`Level ${level} spawn (${leg.tsym}): no underlying price yet - waiting for first tick`); return; }
        const cfg = this.deps.getConfig();
        // Flat multiplier applied identically at every adverse level 1-N (e.g. 2 =
        // double the causing leg's CURRENT held size, whether it's a level-1 or
        // level-N spawn) - NOT scaled further by `level`. Sized off
        // leg.totalQuantity (grows via averaging), not leg.quantity (fixed
        // original entry size). Falls back to 1 when the configured value is
        // missing, non-numeric, zero, or negative. averageQuantityMode
        // (tryAverageLevel, below) is a separate, unrelated toggle - untouched.
        const rawMultiplier = Number(cfg.spawnQuantityMode);
        const multiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1;
        const spawnQty = Math.round(leg.totalQuantity * multiplier);
        const oppositeRight = leg.right === CALL ? PUT : CALL;
        const optionType = oppositeRight === CALL ? 'CE' : 'PE';

        // Reserve the slot synchronously before any await - see PENDING's comment.
        leg.childByLevel.set(level, PENDING);

        try {
            // Locked: same reasoning as root-entry - strike selection and the
            // legsByToken commit must be atomic across every concurrent
            // spawn/entry attempt on this instance, or two different parent
            // legs can independently pick the same strike before either has
            // committed, and the second commit silently overwrites the first
            // leg's tracking.
            await this.withOpLock(async () => {
                // A deeper (or retraced/re-triggered) level under this same leg
                // supersedes any of its shallower slots' still-resting refills -
                // cancel them first so capitalCheck below sees the freed capital.
                await this.cancelChildRefills(leg, level);
                const excludeStrikes = Array.from(this.openStrikesFor(oppositeRight));
                const contract = await OrderClient.getInstance().getContractByPriceRangeBare(
                    this.deps.userId, underlyingLtp, optionType, cfg.minPremium ?? 100, 'NIFTY', excludeStrikes
                );
                if (!(await this.capitalCheck(spawnQty, contract.premium, `Level ${level} spawn (${leg.tsym})`))) {
                    leg.childByLevel.delete(level); // free the slot regardless - harmless even though the capital gate (now tripped) means it won't actually be retried
                    return;
                }
                // ANT token, not Zerodha's instrumentToken - see openRootLeg's comment.
                const trade: Trade = await OrderClient.getInstance().buyContractBare(
                    this.deps.userId, contract.tradingSymbol, String(contract.antToken), spawnQty, contract.exchange, contract.premium
                );
                const childLegId = this.nextLegId();
                const childLeg: Leg = {
                    legId: childLegId, token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                    right: oppositeRight, entryPrice: trade.price, quantity: trade.quantity, isRoot: false,
                    parentLegId: leg.legId, parentLevel: level, childByLevel: new Map(), status: 'OPEN',
                    avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
                    legRef: crypto.randomUUID(), parentLegRef: leg.legRef,
                };
                this.legsByToken.set(trade.token, childLeg);
                leg.childByLevel.set(level, childLegId);
                this.persistLegLineage(childLeg);
                Log.log(`[${this.deps.ownerType}] Level ${level} spawn: ${trade.tsym} qty=${trade.quantity} entry=${trade.price} (parent ${leg.tsym})`);
                this.logLegStatus(childLeg);
            });
        } catch (e) {
            leg.childByLevel.delete(level); // spawn failed - free the slot so it can retry
            Log.log(`[${this.deps.ownerType}] Level ${level} spawn failed:`, e);
        }
    }

    // Averages into the SAME losing leg, in addition to (not instead of) the opposite-
    // leg hedge spawned by trySpawnLevel above at the same adverse-level trigger. Lowers
    // leg.avgPrice/raises leg.totalQuantity so the leg's own target becomes avg+1 instead
    // of avg+D once at least one average-add has happened - a faster exit than waiting
    // for the full D-point recovery. Deliberately does not touch leg.quantity/
    // leg.entryPrice - those stay exactly as the adverse-level/square-off triggers and
    // refill sizing already read them. trySpawnLevel's own sizing reads
    // leg.totalQuantity instead, which THIS method raises.
    private async tryAverageLevel(leg: Leg, level: number, ltp: number): Promise<void> {
        if (this.capitalGateTripped) return; // silent - see capitalGateTripped's comment
        const cfg = this.deps.getConfig();
        const mode = cfg.averageQuantityMode || 'same';
        const addQty = mode === 'same' ? leg.quantity : leg.quantity * level;

        // Reserve the slot synchronously before any await, same reasoning as
        // childByLevel's PENDING sentinel above.
        leg.averagedLevels.add(level);

        try {
            await this.withOpLock(async () => {
                // The leg may have hit its own target/square-off (and been deleted from
                // legsByToken) on a later tick while this was queued on opLock.
                if (!this.legsByToken.has(leg.token)) {
                    leg.averagedLevels.delete(level); // leg closed before this could run
                    return;
                }
                if (!(await this.capitalCheck(addQty, ltp, `Level ${level} average (${leg.tsym})`))) {
                    leg.averagedLevels.delete(level); // free the slot regardless - harmless even though the capital gate (now tripped) means it won't actually be retried
                    return;
                }
                const trade: Trade = await OrderClient.getInstance().buyContractBare(
                    this.deps.userId, leg.tsym, leg.token, addQty, leg.exchange, ltp
                );
                leg.avgPrice = (leg.avgPrice * leg.totalQuantity + trade.price * trade.quantity) / (leg.totalQuantity + trade.quantity);
                leg.totalQuantity += trade.quantity;
                Log.log(`[${this.deps.ownerType}] Level ${level} average: ${leg.tsym} +qty=${trade.quantity} @ ${trade.price} -> totalQty=${leg.totalQuantity} avg=${leg.avgPrice.toFixed(2)} (${leg.tsym})`);
                this.logLegStatus(leg);
            });
        } catch (e) {
            leg.averagedLevels.delete(level); // average-add failed - free the slot so it can retry
            Log.log(`[${this.deps.ownerType}] Level ${level} average failed:`, e);
        }
    }

    // Visibility into a leg's live thresholds after any event that changes
    // its size/basis (open, spawn, root refill, average-add) - answers "when
    // will this close, or move to the next level" without having to compute
    // it by hand from logs.
    private logLegStatus(leg: Leg): void {
        const cfg = this.deps.getConfig();
        const D = cfg.slDistance;
        const target = this.targetFor(leg, cfg, D);
        const maxLevels = cfg.maxLevels ?? 4;
        let nextLevel = 1;
        while (nextLevel <= maxLevels && leg.childByLevel.has(nextLevel)) nextLevel++;
        const nextLevelPrice = leg.entryPrice - nextLevel * D;
        const squareOffDistance = cfg.squareOffDistance ?? 50;
        const squareOff = leg.entryPrice - squareOffDistance;
        Log.log(`[${this.deps.ownerType}] ${leg.tsym} status: qty=${leg.totalQuantity} avg=${leg.avgPrice.toFixed(2)} target=${target.toFixed(2)} nextLevel(${nextLevel})@${nextLevelPrice.toFixed(2)} squareOff@${squareOff.toFixed(2)}`);
    }

    private freeParentSlot(leg: Leg): void {
        if (leg.parentLegId == null || leg.parentLevel == null) return;
        for (const parent of this.legsByToken.values()) {
            if (parent.legId === leg.parentLegId) {
                parent.childByLevel.delete(leg.parentLevel);
                return;
            }
        }
    }

    // A nested leg only refills if its own parent is currently a LIVE leg (not
    // merely "will be alive again shortly" - e.g. mid-refill itself counts as
    // not alive here). Root has no parent, so it's always eligible.
    private isParentAlive(parentLegId: string | null): boolean {
        if (parentLegId == null) return true;
        for (const l of this.legsByToken.values()) {
            if (l.legId === parentLegId) return true;
        }
        return false;
    }

    // Cancels this leg's OWN children's still-resting pending refills - either all
    // of them (leg is closing for good: square-off, parent-not-alive, or capital-blocked
    // nested refill), or only those at level <= atOrBelowLevel (a new, deeper hedge
    // is about to spawn under this same leg, so shallower stale refills are cleared
    // first - see trySpawnLevel). Same cancel/unwatch/log pattern as checkRefillDrift.
    private async cancelChildRefills(leg: Leg, atOrBelowLevel?: number): Promise<void> {
        const stale = Array.from(this.pendingReEntries.entries()).filter(([, intent]) =>
            intent.parentLegId === leg.legId && (atOrBelowLevel == null || (intent.parentLevel != null && intent.parentLevel <= atOrBelowLevel))
        );
        for (const [token, intent] of stale) {
            this.pendingReEntries.delete(token);
            unwatchToken(token, this.deps.strategyRef);
            try {
                await OrderClient.getInstance().cancelOrderBare(this.deps.userId, intent.orderId);
                Log.log(`[${this.deps.ownerType}] Pending refill at level ${intent.parentLevel} cancelled (parent ${leg.tsym}): ${intent.tsym}`);
            } catch (e) {
                Log.log(`[${this.deps.ownerType}] Child refill cancel failed:`, e);
            }
        }
    }

    // Returns true if the refill was placed, false if it's gone for good (capital
    // gate tripped - root and nested alike, no retry; or a genuine placement
    // failure) - callers use this to decide whether to cascade-cancel this leg's
    // OWN children's pending refills (see cancelChildRefills).
    private async placeRefill(intent: PendingReEntry): Promise<boolean> {
        try {
            // Locked so this capitalCheck reads a consistent snapshot against
            // any concurrent root entry/spawn decision.
            return await this.withOpLock(async () => {
                const context = intent.isRoot ? 'Root refill' : `Nested refill (${intent.tsym})`;
                if (!(await this.capitalCheck(intent.quantity, intent.limitPrice, context))) {
                    return false; // capital gate tripped - gone for good, root and nested alike, no retry
                }
                const { orderId } = await OrderClient.getInstance().placeLimitBuyBare(
                    this.deps.userId, intent.tsym, intent.token, intent.quantity, intent.limitPrice, intent.exchange
                );
                intent.orderId = orderId;
                this.pendingReEntries.set(intent.token, intent);
                watchToken(intent.token, this.deps.strategyRef); // keep ticks flowing so checkRefillDrift can see this contract's LTP
                Log.log(`[${this.deps.ownerType}] Refill placed (${intent.isRoot ? 'root' : 'nested'}): ${intent.tsym} qty=${intent.quantity} price=${intent.limitPrice}`);
                return true;
            });
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] Refill placement failed:`, e);
            return false;
        }
    }

    private async maybePromoteDeferredRootRefill(): Promise<void> {
        if (!this.deferredRootRefill) return;
        if (this.hasOpenNestedLegs()) return;
        const intent = this.deferredRootRefill;
        this.deferredRootRefill = null;
        Log.log(`[${this.deps.ownerType}] Promoting deferred root refill: ${intent.tsym}`);
        await this.placeRefill(intent);
    }

    // A refill's limit buy sits below the price at the moment it's placed (the leg
    // just hit target and sold above its entry price) - once LTP runs more than
    // refillCancelDistance points above that resting price, the order is unlikely to
    // fill soon, so give up on this contract entirely: cancel and drop the pending
    // re-entry outright (no re-place at a new price). Applies to any leg's refill
    // (root or nested) - root re-enters fresh via its normal entry gates the next
    // time they clear; a nested leg's slot just stays free until its own parent's
    // adverse level re-triggers it.
    // ltp - limitPrice (not Math.abs) is deliberate - only upward drift away from a
    // fillable price is the failure mode being guarded against.
    private async checkRefillDrift(token: string, ltp: number): Promise<void> {
        const intent = this.pendingReEntries.get(token);
        if (!intent) return;
        const cancelDistance = this.deps.getConfig().refillCancelDistance ?? 50;
        if (ltp - intent.limitPrice <= cancelDistance) return;
        this.pendingReEntries.delete(token); // synchronous, before any await - same pattern as leg-close paths
        unwatchToken(token, this.deps.strategyRef);
        try {
            await OrderClient.getInstance().cancelOrderBare(this.deps.userId, intent.orderId);
            Log.log(`[${this.deps.ownerType}] Root refill cancelled - LTP drifted ${(ltp - intent.limitPrice).toFixed(2)} above limit ${intent.limitPrice}: ${intent.tsym}`);
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] Root refill cancel failed:`, e);
        }
    }

    // Buy fills: only meaningful for root-refill limit fills - every other Buy
    // fill (root/spawn) is already handled synchronously by the code path that
    // placed it, since those all return the fill directly.
    //
    // Sell fills: this instance's own sells (target-hit/square-off, in
    // onOptionTick) always delete the leg from legsByToken synchronously
    // BEFORE the fill notification could reach this handler - so if a Sell
    // fill arrives here for a token that STILL has a leg in legsByToken, it
    // cannot be an echo of this instance's own sell. It's an externally-sourced
    // sell (e.g. the user manually sold from the Kite app) - clean up the leg
    // the same way a square-off would, just without placing a broker order.
    async handleFillOrExternalSell(trade: Trade): Promise<void> {
        if (trade.action === 'Sell') {
            const leg = this.legsByToken.get(trade.token);
            if (!leg) return; // echo of a sell this instance already handled synchronously
            this.legsByToken.delete(trade.token);
            const pnl = (trade.price - leg.avgPrice) * leg.totalQuantity;
            this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
            Log.log(`[${this.deps.ownerType}] External/manual sell detected: ${leg.tsym} pnl=${Math.round(pnl)}`);
            if (!leg.isRoot) {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }
            await this.cancelChildRefills(leg);
            return;
        }
        if (trade.action !== 'Buy') return;
        const intent = this.pendingReEntries.get(trade.token);
        if (!intent) return; // redundant echo of a market buy already handled synchronously
        this.pendingReEntries.delete(trade.token);
        unwatchToken(trade.token, this.deps.strategyRef);
        const legId = this.nextLegId();
        const leg: Leg = {
            legId, token: trade.token, tsym: intent.tsym, strike: intent.strike, exchange: intent.exchange,
            right: intent.right, entryPrice: trade.price, quantity: trade.quantity, isRoot: intent.isRoot,
            parentLegId: intent.parentLegId, parentLevel: intent.parentLevel, childByLevel: new Map(), status: 'OPEN',
            avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
            legRef: crypto.randomUUID(), parentLegRef: intent.parentLegRef,
        };
        this.legsByToken.set(trade.token, leg);
        if (!intent.isRoot && intent.parentLegId != null && intent.parentLevel != null) {
            for (const parent of this.legsByToken.values()) {
                if (parent.legId === intent.parentLegId) {
                    parent.childByLevel.set(intent.parentLevel, legId); // reoccupy the slot
                    break;
                }
            }
        }
        this.persistLegLineage(leg);
        Log.log(`[${this.deps.ownerType}] Refill filled (${intent.isRoot ? 'root' : 'nested'}): ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
        this.logLegStatus(leg);
    }

    // Rebuilds legsByToken/parentLegId/childByLevel from the broker's open
    // trades (fetched by the caller) plus the legLineage collection - see
    // ContinuousStrategy.reconcile()'s original doc comment for the full
    // rationale (restart-safety, why lineage docs are needed, the two-pass
    // parentLegRef resolution). The caller (owning strategy) is responsible
    // for the retry-against-OrderClient policy and setting its own `ordered`
    // gate once this resolves - that's strategy-specific semantics, not leg-
    // lifecycle logic.
    async restoreFromOpenTrades(openTrades: Trade[]): Promise<void> {
        if (openTrades.length === 0) return; // fresh in-memory defaults already correct
        this.legsByToken.clear();
        const cfg = this.deps.getConfig();
        const lineageByToken = await this.loadLatestLegLineage(openTrades.map((t) => t.token));
        for (const trade of openTrades) {
            // Same guard as the entry path - don't silently merge two
            // broker-reported open trades on the same token into one Leg.
            if (this.legsByToken.has(trade.token)) {
                Log.log(`[${this.deps.ownerType}] reconcile: REFUSING to merge - order reports more than one open trade for token ${trade.token} (${trade.tsym}); keeping the first, skipping the rest`);
                continue;
            }
            const contract = AntContractMaster.getInstance().findByToken(trade.token);
            // A spawn always creates a new token/leg (never accumulates onto an
            // existing one), so a same-token quantity above one fill's size can
            // only come from tryAverageLevel having fired pre-restart. We don't
            // know exactly which levels triggered, so seed every level as
            // already-averaged: this both makes the target formula correctly
            // fall back to postAverageTargetDistance and blocks re-averaging
            // entirely on the restored leg rather than guessing which levels
            // are still eligible.
            const wasAveraged = cfg.initialQuantity != null && trade.quantity > cfg.initialQuantity;
            // entryPrice/quantity are "fixed forever" - still what adverse-level/
            // square-off triggers and refill sizing read - so they must come
            // from the leg's true first fill (originalEntryPrice/Quantity), not
            // the broker's current blended/aggregate values (trade.price/
            // quantity, which belong in avgPrice/totalQuantity instead).
            const lineage = lineageByToken.get(trade.token);
            const leg: Leg = {
                legId: this.nextLegId(),
                token: trade.token, tsym: trade.tsym,
                strike: contract?.strike ?? 0,
                exchange: contract?.exch === 'BFO' ? 'BFO' : 'NFO',
                // Must be the CALL/PUT constants (lowercase 'call'/'put'), not the
                // contract master's 'CE'/'PE' format - trySpawnLevel's
                // `leg.right === CALL` hedge-direction check silently always takes
                // the false branch otherwise.
                right: contract?.optionType === 'PE' ? PUT : CALL,
                entryPrice: trade.originalEntryPrice ?? trade.price,
                quantity: trade.originalEntryQuantity ?? trade.quantity,
                // Defaults (isRoot:true, no parent) apply only when this token has
                // no legLineage doc at all.
                isRoot: lineage?.isRoot ?? true,
                parentLegId: null, // resolved in the second pass below, once every restored leg exists
                parentLevel: lineage?.parentLevel ?? null,
                childByLevel: new Map(), status: 'OPEN',
                avgPrice: trade.price, totalQuantity: trade.quantity,
                averagedLevels: wasAveraged ? new Set([1, 2, 3, 4]) : new Set(),
                legRef: lineage?.legRef ?? crypto.randomUUID(),
                parentLegRef: lineage?.parentLegRef ?? null,
            };
            this.legsByToken.set(trade.token, leg);
            // registerTrade is normally only called from the fill handler (a
            // live Buy fill) - a restored leg never goes through that path, so
            // without this call its token is never resubscribed after a
            // restart, leaving the leg silently tick-starved.
            registerTrade(trade.token, this.deps.strategyRef);
        }
        // Pass 2: every restored leg now exists (with a freshly-generated
        // legId), so parentLegRef can be resolved to the parent's actual
        // legId and that parent's childByLevel slot re-populated.
        const legByRef = new Map<string, Leg>();
        for (const leg of this.legsByToken.values()) legByRef.set(leg.legRef, leg);
        for (const leg of this.legsByToken.values()) {
            if (!leg.parentLegRef) continue;
            const parent = legByRef.get(leg.parentLegRef);
            if (parent && leg.parentLevel != null) {
                leg.parentLegId = parent.legId;
                parent.childByLevel.set(leg.parentLevel, leg.legId);
            } else {
                Log.log(`[${this.deps.ownerType}] reconcile: lineage parent not found for ${leg.tsym} (parentLegRef=${leg.parentLegRef}) - treating as parent-less for refill eligibility`);
            }
        }
        // logLegStatus is otherwise only called after an event that changes a
        // leg's size/basis - a restored leg has none of those in this
        // process's lifetime, so without this call it would never appear in
        // orchestrator.log at all until its next such event.
        for (const leg of this.legsByToken.values()) this.logLegStatus(leg);
        Log.log(`[${this.deps.ownerType}] reconcile: restored ${this.legsByToken.size} open leg(s) after restart - blocking new entries until they close`);
    }

    reset(): void {
        this.legsByToken.clear();
        this.pendingReEntries.clear();
        this.deferredRootRefill = null;
        this.capitalGateTripped = false;
        this.maxProfitTripped = false;
        this.maxProfitBaseline = this.realizedPnL;
    }
}
