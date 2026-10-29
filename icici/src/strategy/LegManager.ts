import GateLogger from '../util/GateLogger';
import { HEDGE_UNCONFIRMED_TAG, ORDER_MAY_BE_LIVE_TAG } from '../ipc/orderProtocol';
import crypto from 'crypto';
import Log from '../util/Log';
import { CALL, PUT, DEFAULT_MAX_INVESTMENT } from '../constants';
import { Trade } from '../model/model';
import AntContractMaster from '../ant/AntContractMaster';
import { watchToken, unwatchToken, registerTrade } from '../processes/strategies/tokenRouter';
import Mongo from '../tools/mongo';
import { toPercentNumber } from '../prism/percentConfig';
import { Strategy } from './strategy';
import { localDayKey } from './dayKey';
import { LegBrokerOps, PartialSellError, defaultLegOps, dryRunOps } from './LegBrokerOps';

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


// A Map that calls `onChange` after every set/delete/clear.
class ChangeNotifyingMap<K, V> extends Map<K, V> {
    constructor(private readonly onChange: () => void) { super(); }
    set(key: K, value: V): this { super.set(key, value); this.onChange?.(); return this; }
    delete(key: K): boolean { const removed = super.delete(key); this.onChange?.(); return removed; }
    clear(): void { super.clear(); this.onChange?.(); }
}

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
    orderId: string; // Kite order id, for cancelling on drift (see checkRefillDrift)
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
    targetDistance?: number; // first-level (un-averaged) target = avg + this; default slDistance
    marketSentiment?: string;
    refillCancelDistance?: number; // default 50
    minPremium?: number; // default 100
    maxExposure?: number; // canonical; falls back to maxInvestment, then DEFAULT_MAX_INVESTMENT
    /** @deprecated use maxExposure */
    maxInvestment?: number;
    maxProfit?: number | null; // null/undefined disables the feature
    maxLoss?: number | null; // % of maxInvestment, mirrors maxProfit on the loss side; null/undefined disables the feature
    // Used only by restoreFromOpenTrades's wasAveraged heuristic - optional
    // since not every owning strategy has an "initial entry size" config key
    // (e.g. SupportResistanceStrategy has none; restored legs there simply
    // default to wasAveraged=false, a harmless default for a brand-new
    // strategy with no restore history to preserve).
    initialQuantity?: number;
    // false blocks target-hit re-entry (placeRefill) for every leg, root and
    // nested alike - used by BulkPcrStrategy's hedge tree, where antLegOps's
    // buyLimit is unimplemented (ANT has no resting-limit-buy bare op wired
    // up for this path). Unset/true preserves today's refill behavior.
    refillEnabled?: boolean;
    // Read LIVE on every ops call (via this.currentOps(), not resolved once at
    // construction) so toggling this in config.yml takes effect on the next tick,
    // not only on the next process restart - unlike `ops` itself, which is a
    // one-time wiring choice (which broker's bare-IPC family to use), dryRun is a
    // runtime safety toggle an operator may need to flip while the process is
    // already running (e.g. pausing real hedge-leg orders mid-investigation).
    dryRun?: boolean;
}

// antLegOps.buy tags a buy whose fill is unresolved (the order may still be live) as '[HEDGE_UNCONFIRMED]'; the order process tags
// any broker's unsettled fill wait as '[ORDER_MAY_BE_LIVE]'.
export function isUnconfirmedBuyError(e: any): boolean {
    const message = String(e?.message ?? e);
    return message.includes(HEDGE_UNCONFIRMED_TAG) || message.includes(ORDER_MAY_BE_LIVE_TAG);
}

export interface LegManagerDeps {
    userId: string;
    ownerType: string; // log-prefix + legLineage discriminator
    strategyRef: Strategy; // passed to watchToken/unwatchToken/registerTrade (tokenRouter keys off the Strategy instance)
    getConfig: () => LegManagerConfig;
    getLastUnderlyingLtp: () => number;
    recordOutcome: (outcome: 'win' | 'loss' | 'timeout', pnl: number) => void;
    ops?: LegBrokerOps; // default: defaultLegOps (today's Kite/Breeze 'Bare' IPCs)
    // Called with the raw error whenever any LegManager buy (hedge spawn, average-add,
    // refill) fails - lets an owning strategy notice a '[HEDGE_UNCONFIRMED]'-prefixed error
    // (antLegOps.ts's buy: the fill wait timed out, so the order may still be live -
    // never safe to retry) and flip its own manual-review flag. Every other spawn
    // failure (pickContract/capitalCheck/ordinary buy rejection) already self-heals by
    // freeing the slot for retry on the next qualifying tick - this hook exists only
    // for the one failure mode that must NOT self-heal.
    onSpawnBuyError?: (e: any) => void;
    // The owner can veto every NEW buy (entry, hedge spawn, average-in, refill) - e.g. an ANT buy whose fill could not be
    // confirmed and may still be live. Exits are never blocked by this.
    isOrderingBlocked?: () => boolean;
}

// A cancel that lost the race to a fill. The order process throws OrderAlreadyFilledError (name + filledQuantity), but
// across the IPC hop to this process it arrives as a plain Error carrying only the message, so fall back to parsing
// "Order <id> already filled (qty=N)" (real 2026-10-27 10:04: the direct sell-back never fired, only the fill-echo net did).
function alreadyFilledQty(e: any): number {
    if (e?.name === 'OrderAlreadyFilledError') return Number(e.filledQuantity ?? 0);
    const m = /already filled \(qty=(\d+)\)/.exec(String(e?.message ?? ''));
    return m ? Number(m[1]) : 0;
}

export class LegManager {
    private rawOps: LegBrokerOps;
    private legsByToken: Map<string, Leg> = new Map();
    // keyed by token. Mirrored to Mongo on every change (see persistPendingReEntries): the limit buy is live at the broker, so a restart
    // must still know which leg it belongs to when it fills, or the position ends up with no stop (review R5-8).
    private pendingReEntries: Map<string, PendingReEntry> = new ChangeNotifyingMap<string, PendingReEntry>(() => this.persistPendingReEntries());
    private deferredRootRefill: PendingReEntry | null = null;
    private legIdCounter = 0;
    private gateLog?: GateLogger; // created on first use: the prefix needs deps.ownerType
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
    // Loss-side mirror of maxProfitTripped: cumulative (realized + unrealized) P&L <= -threshold. Same close-all, same
    // same-day Mongo latch, cleared by reset().
    private maxLossTripped = false;
    // Target-hit / square-off closes delete the leg from legsByToken BEFORE their sell await, and a target-hit root
    // registers its refill only after that await. Without this counter isIdle() is true for that whole window, so
    // the owning strategy's T1 gate re-enters (real 2026-10-27 09:51 bug: a fresh T1 entry stacked on the refill,
    // leaving an untracked 65-qty position). Held until the refill is registered (or the close failed/finished).
    private closesInFlight = 0;
    // End-of-day force close latch: once set, onOptionTick keeps closing every leg (retrying a failed sell on the
    // next tick) and nothing new is opened. Not persisted - the trading day is over either way.
    private eodClosing = false;
    // Calendar day the latches above belong to. They are one-day latches (persistLatch is keyed by day), but this
    // object can outlive the day when the process is not restarted overnight - see rollDayIfNeeded.
    private activeDay = LegManager.latchDay();
    // Refill limit buys superseded by a deeper spawn (cancelChildRefills), keyed by broker order id. The pending
    // intent is deleted up front, so a fill that lands anyway (before/while the cancel goes through) has no intent to
    // match and used to be dropped silently - an orphaned position (2026-10-19: 325 + 130 lots). A fill carrying one of
    // these order ids is sold straight back instead.
    private supersededRefills = new Map<string, { tsym: string; token: string; exchange: 'NFO' | 'BFO' }>();
    // Order ids whose fill was already dealt with (adopted as a refill leg, or sold back), so an echo of the same fill
    // is never acted on twice.
    private handledBuyOrderIds = new Set<string>();
    // Quantity of our OWN sell-backs (duplicate entry, orphaned average-add, superseded refill) still expected to
    // echo back as Sell fills, per token. Without it the echo lands while a different leg on that token is tracked and
    // is mistaken for an external sell of THAT leg. Entries expire so an echo that never arrives cannot swallow a
    // genuine later external sell.
    private ignoredSellEchoes = new Map<string, { qty: number; expires: number }>();
    private async sellBack(tsym: string, token: string, qty: number, exchange: 'NFO' | 'BFO'): Promise<void> {
        const prev = this.ignoredSellEchoes.get(token);
        const live = prev && prev.expires > Date.now() ? prev.qty : 0;
        this.ignoredSellEchoes.set(token, { qty: live + qty, expires: Date.now() + 60_000 });
        try {
            await this.currentOps().sell(this.deps.userId, tsym, token, qty, exchange);
        } catch (e) {
            const cur = this.ignoredSellEchoes.get(token);
            if (cur) { cur.qty -= qty; if (cur.qty <= 0) this.ignoredSellEchoes.delete(token); }
            throw e;
        }
    }
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

    constructor(private deps: LegManagerDeps) {
        this.rawOps = deps.ops ?? defaultLegOps;
    }

    // Resolved fresh on every call site (not cached) - LegManagerConfig.dryRun is
    // read live from deps.getConfig() so toggling it in config.yml takes effect on
    // the very next op, not only after a process restart. See
    // LegManagerConfig.dryRun's comment.
    //
    // The toggle is only honoured while this manager is idle (no open leg, no resting refill). Once anything is
    // live the mode in force when it was opened stays in force for it: flipping to dry-run mid-position would turn
    // its sells/cancels into no-ops (an unmanageable live position), flipping the other way would "sell" a leg
    // that was only ever simulated.
    private dryRunLatched = false;
    // Only an ENTRY call (pickContract/buy/buyLimit, forEntry=true) may re-read the toggle, and only while idle.
    // Close paths delete the leg from legsByToken BEFORE their sell/cancel runs, so the manager looks idle at that
    // moment - re-reading there would flip a live leg's sell into a dry-run no-op.
    private currentOps(forEntry = false): LegBrokerOps {
        if (forEntry && this.isIdle()) this.dryRunLatched = !!this.deps.getConfig().dryRun;
        return this.dryRunLatched ? dryRunOps(this.rawOps) : this.rawOps;
    }

    // True once any latch says no NEW order may be placed (the open legs are being, or about to be, closed).
    // Re-checked INSIDE withOpLock: a spawn/average/entry queued behind the lock must not buy after a max-profit,
    // max-loss or EOD trip that happened while it waited.
    private newOrdersBlocked(): boolean {
        this.rollDayIfNeeded();
        return this.maxProfitTripped || this.maxLossTripped || this.eodClosing || (this.deps.isOrderingBlocked?.() ?? false);
    }

    // Cancels a resting refill and, if it had already (partly) filled, sells that quantity straight back so no
    // untracked position remains. Used by every path that has already deleted the intent.
    private async cancelIntentOrSellBack(intent: PendingReEntry, label: string): Promise<void> {
        try {
            await this.currentOps().cancel(this.deps.userId, intent.orderId, intent.exchange);
            Log.log(`[${this.deps.ownerType}] ${label}: pending re-entry cancelled: ${intent.tsym}`);
        } catch (e: any) {
            const filledQty = alreadyFilledQty(e);
            if (filledQty > 0) {
                if (intent.orderId) { this.supersededRefills.delete(intent.orderId); this.handledBuyOrderIds.add(intent.orderId); }
                Log.log(`[${this.deps.ownerType}] ALERT: ${label}: refill ${intent.orderId} (${intent.tsym}) had already filled ${filledQty} - selling it back so it is not left untracked`);
                try {
                    await this.currentOps().sell(this.deps.userId, intent.tsym, intent.token, filledQty, intent.exchange);
                } catch (sellErr) {
                    Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the filled refill (${intent.tsym} qty=${filledQty}) - UNTRACKED POSITION, manual action required:`, sellErr);
                }
            } else {
                Log.log(`[${this.deps.ownerType}] ${label}: pending re-entry cancel failed:`, e);
            }
        }
    }

    private withOpLock<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.opLock.then(fn, fn);
        this.opLock = result.catch(() => {}); // don't let one failure poison the chain for later callers
        return result;
    }

    private logGateOnce(reason: string): void {
        (this.gateLog ??= new GateLogger(`[${this.deps.ownerType}]`)).log(reason);
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

    // One document per (user, owner): today's resting refill intents. Fire-and-forget like persistLegLineage.
    private persistPendingReEntries(): void {
        Mongo.getInstance()?.db.collection('legPendingReEntries').replaceOne(
            { userId: this.deps.userId, ownerType: this.deps.ownerType },
            { userId: this.deps.userId, ownerType: this.deps.ownerType, day: LegManager.latchDay(), intents: Array.from(this.pendingReEntries.values()) },
            { upsert: true },
        ).catch((e) => Log.log(`[${this.deps.ownerType}] pending re-entry persist failed (continuing without persistence):`, e));
    }

    // Called by the owning strategy's reconcile() AFTER restoreFromOpenTrades (or when there are no open trades at all - a root refill is
    // resting while no leg is held). Re-creates today's resting refill intents so their fill finds its intent. An intent whose token now
    // has a leg already filled while this process was down and was restored from the broker's open trades: dropped.
    async restorePendingReEntries(): Promise<void> {
        let doc: any;
        try {
            doc = await Mongo.getInstance()?.db.collection('legPendingReEntries').findOne({ userId: this.deps.userId, ownerType: this.deps.ownerType });
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] reconcile: could not read pending re-entries (a resting refill that fills will be untracked):`, e);
            return;
        }
        if (!doc || doc.day !== LegManager.latchDay()) return;
        const legByRef = new Map<string, Leg>();
        for (const leg of this.legsByToken.values()) legByRef.set(leg.legRef, leg);
        let restored = 0;
        for (const raw of (doc.intents ?? []) as PendingReEntry[]) {
            if (this.legsByToken.has(raw.token) || this.pendingReEntries.has(raw.token)) continue;
            const parent = raw.parentLegRef ? legByRef.get(raw.parentLegRef) : undefined;
            this.pendingReEntries.set(raw.token, { ...raw, parentLegId: parent?.legId ?? null });
            watchToken(raw.token, this.deps.strategyRef, raw.exchange); // keeps ticks flowing for checkRefillDrift
            restored++;
        }
        if (restored > 0) Log.log(`[${this.deps.ownerType}] reconcile: restored ${restored} resting refill intent(s) after restart`);
    }

    private nextLegId(): string {
        return `${this.deps.userId}-leg-${++this.legIdCounter}`;
    }

    private openStrikesFor(right: string): Set<number> {
        const strikes = new Set<number>();
        for (const leg of this.legsByToken.values()) {
            if (leg.right === right) strikes.add(leg.strike);
        }
        // A resting refill buy will become a leg on its strike when it fills: a spawn must not pick the same strike.
        for (const intent of this.pendingReEntries.values()) {
            if (intent.right === right) strikes.add(intent.strike);
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
        this.rollDayIfNeeded();
        if (this.capitalGateTripped) return false; // latched permanently - see field comment
        const cfg = this.deps.getConfig();
        const maxInvestment = cfg.maxExposure ?? cfg.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
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
        return (this.realizedPnL - this.maxProfitBaseline) + this.computeOpenUnrealized();
    }

    // Unrealized P&L of the legs open right now, with no realized P&L netted in (the max-loss stop's measure).
    private computeOpenUnrealized(): number {
        let unrealized = 0;
        for (const leg of this.legsByToken.values()) {
            const ltp = leg.lastLtp ?? leg.avgPrice; // no quote seen yet -> contributes 0
            unrealized += (ltp - leg.avgPrice) * leg.totalQuantity;
        }
        return unrealized;
    }

    // One-way latch, mirrors capitalGateTripped but keyed off cumulative P&L
    // instead of exposure. maxProfit is a % of maxInvestment (the CONFIGURED
    // cap, not live deployed capital). Unset/null maxProfit disables the
    // feature entirely (no-op).
    private checkAndMaybeTripMaxProfit(cfg: LegManagerConfig): void {
        this.rollDayIfNeeded();
        if (this.maxProfitTripped) return; // latched permanently - see field comment
        if (cfg.maxProfit == null) return; // feature not configured
        const maxProfitPct = toPercentNumber(cfg.maxProfit);
        if (maxProfitPct === null) { this.logUnparseablePercent('maxProfit', cfg.maxProfit); return; }
        const maxInvestment = cfg.maxExposure ?? cfg.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
        const threshold = (maxProfitPct / 100) * maxInvestment;
        const cumulative = this.computeCumulativeProfit();
        if (!(cumulative >= threshold)) return; // NaN-safe: a NaN cumulative must not trip it
        this.maxProfitTripped = true;
        this.persistLatch('maxProfitTripped');
        Log.log(`[${this.deps.ownerType}] MAX PROFIT TRIPPED - cumulative=${Math.round(cumulative)} threshold=${Math.round(threshold)} (maxProfit=${maxProfitPct}% of maxInvestment=${maxInvestment}) - closing all legs, cancelling all pending re-entries, and permanently blocking new entries for the rest of this session`);
    }

    // Invoked once maxProfitTripped latches - idempotent/safe to call
    // repeatedly: only acts on legs still 'OPEN' and re-entries still
    // present, so a partial failure (some legs closed, some still resting)
    // simply retries the remainder on the next tick.
    // The max-profit stop is a same-day latch kept in Mongo (collection strategyLatches), so a process restart
    // (a deploy, a crash, tsc-watch) no longer re-enables a strategy that already hit its profit cap -
    // observed 2026-10-19 when two restarts the same day re-opened trading after a mass close. reset() clears it.
    // First touch on a new calendar day clears the per-day latches (capital gate, max profit/loss, EOD close) and
    // rebases the P&L baseline, so yesterday's trip or EOD close cannot block (or instantly sell) today's entries.
    // Open legs are kept. No-op within a day.
    private rollDayIfNeeded(): void {
        const today = LegManager.latchDay();
        if (today === this.activeDay) return;
        // Legs still open (e.g. an EOD/stop close that failed) keep the latches that are closing them; roll once flat.
        if (this.legsByToken.size > 0) return;
        Log.log(`[${this.deps.ownerType}] new trading day ${today} (was ${this.activeDay}) - clearing yesterday's capital/profit/loss/EOD latches`);
        this.activeDay = today;
        this.capitalGateTripped = false;
        this.maxProfitTripped = false;
        this.maxLossTripped = false;
        this.eodClosing = false;
        this.maxProfitBaseline = this.realizedPnL;
    }

    private static latchDay(): string {
        return localDayKey();
    }

    private persistLatch(field: 'maxProfitTripped' | 'maxLossTripped' | null): void {
        const col = Mongo.getInstance()?.db.collection('strategyLatches');
        if (!col) return;
        const key = { ownerType: this.deps.ownerType, userId: this.deps.userId, day: LegManager.latchDay() };
        const op = field
            ? col.updateOne(key, { $set: { [field]: true, updatedAt: new Date() } }, { upsert: true })
            : col.deleteMany({ ownerType: key.ownerType, userId: key.userId }); // reset(): clear every latch
        op.catch((e) => Log.log(`[${this.deps.ownerType}] strategyLatches ${field ? 'write' : 'clear'} failed (continuing):`, e));
    }

    // Called at strategies-process startup (restoreLatches) and again from reconcile(): restores today's max-profit/max-loss latches if it was tripped
    // before the restart.
    async loadPersistedLatches(): Promise<void> {
        try {
            const col = Mongo.getInstance()?.db.collection('strategyLatches');
            if (!col) return;
            const doc = await col.findOne({ ownerType: this.deps.ownerType, userId: this.deps.userId, day: LegManager.latchDay() });
            if (doc?.maxProfitTripped) {
                this.maxProfitTripped = true;
                Log.log(`[${this.deps.ownerType}] max-profit stop was already tripped earlier today - staying stopped after the restart (reset the strategy to trade again)`);
            }
            if (doc?.maxLossTripped) {
                this.maxLossTripped = true;
                Log.log(`[${this.deps.ownerType}] max-loss stop was already tripped earlier today - staying stopped after the restart (reset the strategy to trade again)`);
            }
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] could not read strategyLatches (continuing with the stop untripped):`, e);
        }
    }

    // A stop whose value cannot be read is not enforced. ConfigService rejects
    // such a file on load, so this is only reachable from a path that bypasses
    // it - log it loudly (once per field, not every tick) rather than let it
    // pass silently.
    private unparseablePercentLogged = new Set<string>();
    private logUnparseablePercent(field: string, raw: unknown): void {
        if (this.unparseablePercentLogged.has(field)) return;
        this.unparseablePercentLogged.add(field);
        Log.log(`[${this.deps.ownerType}] ERROR ${field}=${JSON.stringify(raw)} is not a number - this stop is NOT being enforced; fix the config`);
    }

    // Loss-side counterpart of checkAndMaybeTripMaxProfit, but NOT cumulative: maxLoss is a % of the CONFIGURED maxInvestment
    // compared with the unrealized P&L of the legs open right now (computeOpenUnrealized). Realized gains earlier in the session
    // do not offset it - on 2026-10-28 +12.9k of realized profit hid a -16.5k open leg from a -12k stop, so it never fired.
    // (maxProfit stays cumulative.) Unset/null maxLoss disables it.
    private checkAndMaybeTripMaxLoss(cfg: LegManagerConfig): void {
        this.rollDayIfNeeded();
        if (this.maxLossTripped) return;
        if (cfg.maxLoss == null) return;
        const maxLossPct = toPercentNumber(cfg.maxLoss);
        if (maxLossPct === null) { this.logUnparseablePercent('maxLoss', cfg.maxLoss); return; }
        const maxInvestment = cfg.maxExposure ?? cfg.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
        const threshold = (maxLossPct / 100) * maxInvestment;
        const openUnrealized = this.computeOpenUnrealized();
        if (!(openUnrealized <= -threshold)) return; // NaN-safe: a NaN P&L must not trip it
        this.maxLossTripped = true;
        this.persistLatch('maxLossTripped');
        Log.log(`[${this.deps.ownerType}] MAX LOSS TRIPPED - open-position P&L=${Math.round(openUnrealized)} threshold=-${Math.round(threshold)} (maxLoss=${maxLossPct}% of maxInvestment=${maxInvestment}) - closing every open leg and blocking new entries`);
    }

    isMaxLossTripped(): boolean {
        this.rollDayIfNeeded();
        return this.maxLossTripped;
    }

    // Start of the end-of-day close: from here every tick closes whatever is still open and nothing new is opened.
    async closeAllForEod(): Promise<void> {
        this.rollDayIfNeeded();
        if (!this.eodClosing) Log.log(`[${this.deps.ownerType}] End-of-day close - closing every open leg and cancelling pending re-entries`);
        this.eodClosing = true;
        await this.closeAllLegsAndCancelReEntries();
    }

    private async closeAllLegsAndCancelReEntries(): Promise<void> {
        // The same mass close serves three triggers; the log lines say which one (they all used to read "Max-profit").
        const why = this.maxProfitTripped ? 'Max-profit' : this.maxLossTripped ? 'Max-loss' : 'End-of-day';
        for (const leg of Array.from(this.legsByToken.values())) {
            if (leg.status !== 'OPEN') continue; // already closing (this call, or a previous tick's)
            leg.status = 'CLOSING'; // synchronous, before any await
            const ltp = leg.lastLtp ?? leg.avgPrice;
            // Deleted BEFORE the sell await (not after) - see handleFillOrExternalSell's
            // "Sell fills" comment. An ANT fill-notify push for this exact sell can be
            // delivered by the order-notify socket WHILE this await is pending; deleting
            // only after it resolves leaves a window where handleFillOrExternalSell sees
            // the leg still tracked and double-counts this same fill as an "external" sell.
            this.legsByToken.delete(leg.token);
            let fillPrice: number | undefined;
            try {
                fillPrice = await this.sellLeg(leg);
            } catch (e) {
                this.legsByToken.set(leg.token, leg); // still live at broker - put back for retry
                leg.status = 'OPEN';
                Log.log(`[${this.deps.ownerType}] ${why} mass close sell failed, leg remains open for retry:`, e);
                continue;
            }
            const pnl = ((fillPrice ?? ltp) - leg.avgPrice) * leg.totalQuantity;
            // Per-leg sign, independent of the aggregate trigger - a hedge leg individually
            // at a loss is still correctly tagged 'loss' even during an aggregate-profit close.
            this.recordOutcome(pnl >= 0 ? 'win' : 'loss', pnl);
            Log.log(`[${this.deps.ownerType}] ${why} close (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);
        }

        for (const [token, intent] of Array.from(this.pendingReEntries.entries())) {
            this.pendingReEntries.delete(token); // synchronous, before any await
            unwatchToken(token, this.deps.strategyRef, intent.exchange);
            await this.cancelIntentOrSellBack(intent, `${why} mass close`);
        }

        this.deferredRootRefill = null; // never placed at the broker - just drop the intent
    }

    // Sells the leg's whole remaining quantity. When only part was confirmed sold (PartialSellError) the leg shrinks by that part, and its
    // realized P&L is booked, before the error propagates - so the retry sells what is left instead of the original size.
    // Returns the volume-weighted fill price the sell reported (undefined when the broker path does not report one, e.g. a dry run), so
    // the caller books P&L at what the position actually sold for rather than at the tick that triggered the sell.
    private async sellLeg(leg: Leg): Promise<number | undefined> {
        try {
            const res: any = await this.currentOps().sell(this.deps.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            const px = Number(res?.avgPrice);
            return Number.isFinite(px) && px > 0 ? px : undefined;
        } catch (e) {
            if (e instanceof PartialSellError && e.soldQty > 0) {
                const sold = Math.min(e.soldQty, leg.totalQuantity);
                this.realizedPnL += ((leg.lastLtp ?? leg.avgPrice) - leg.avgPrice) * sold;
                leg.totalQuantity -= sold;
                Log.log(`[${this.deps.ownerType}] Partial sell of ${leg.tsym}: ${sold} confirmed sold, ${leg.totalQuantity} left to sell on retry`);
            }
            throw e;
        }
    }

    private recordOutcome(outcome: 'win' | 'loss' | 'timeout', pnl: number): void {
        this.realizedPnL += pnl;
        this.deps.recordOutcome(outcome, pnl);
    }

    canHandle(token: string): boolean {
        return this.legsByToken.has(token) || this.pendingReEntries.has(token);
    }

    isIdle(): boolean {
        return this.legsByToken.size === 0 && this.pendingReEntries.size === 0 && !this.deferredRootRefill && this.closesInFlight === 0;
    }

    isCapitalGateTripped(): boolean {
        this.rollDayIfNeeded();
        return this.capitalGateTripped;
    }

    isMaxProfitTripped(): boolean {
        this.rollDayIfNeeded();
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
        const firstLevelTarget = cfg.targetDistance ?? D;
        if (leg.averagedLevels.size === 0) return leg.avgPrice + firstLevelTarget;
        const sentiment = (cfg.marketSentiment && cfg.marketSentiment !== 'none') ? cfg.marketSentiment : undefined;
        const sentimentAligned = (sentiment === 'up' && leg.right === CALL) || (sentiment === 'down' && leg.right === PUT);
        const postAverageTarget = sentimentAligned ? firstLevelTarget : (cfg.postAverageTargetDistance ?? 1);
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
            if (this.newOrdersBlocked() || this.capitalGateTripped) return null;
            const optionType = params.right === CALL ? 'CE' : 'PE';
            const excludeStrikes = Array.from(this.openStrikesFor(params.right));
            const contract = await this.currentOps(true).pickContract(this.deps.userId, params.underlyingLtp, optionType, params.minPremium, excludeStrikes);
            if (!(await this.capitalCheck(params.quantity, contract.premium, params.entryLabel))) {
                return null;
            }
            // ANT token, not Kite's instrumentToken - live option ticks are keyed by
            // ANT's own token (OptionQuote.fromAnt), so this leg's tick subscription and
            // canHandle matching (both keyed off this token) must use it too.
            const trade: Trade = await this.currentOps(true).buy(
                this.deps.userId, contract.tradingSymbol, contract.token, params.quantity, contract.exchange, contract.premium
            );
            // Defense-in-depth: the buy already executed on the broker by this
            // point, so this can't prevent a duplicate order - only stop it from
            // silently erasing tracking of a pre-existing leg on the same token.
            const existing = this.legsByToken.get(trade.token);
            if (existing) {
                Log.log(`[${this.deps.ownerType}] REFUSING entry - token ${trade.token} already has an open leg in memory: ${JSON.stringify(existing)}. New untracked fill: ${trade.tsym} qty=${trade.quantity} entry=${trade.price} - selling the new quantity back`);
                try {
                    await this.sellBack(trade.tsym, trade.token, trade.quantity, contract.exchange);
                } catch (sellErr) {
                    Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the refused duplicate entry (${trade.tsym} qty=${trade.quantity}) - UNTRACKED POSITION, manual action required:`, sellErr);
                }
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
        this.rollDayIfNeeded();
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
        const validLtp = Number.isFinite(ltp) && ltp > 0; // a depth-only tick can carry ltp undefined/0
        if (leg && validLtp) leg.lastLtp = ltp;

        if (!this.maxProfitTripped) this.checkAndMaybeTripMaxProfit(this.deps.getConfig());
        if (!this.maxLossTripped) this.checkAndMaybeTripMaxLoss(this.deps.getConfig());
        if (this.maxProfitTripped || this.maxLossTripped || this.eodClosing) { await this.closeAllLegsAndCancelReEntries(); return; }

        if (!validLtp) return;
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
            this.closesInFlight++; // held until the refill below is registered - see the field comment
            try {
                // Deleted BEFORE the sell await - see closeAllLegsAndCancelReEntries's
                // identical comment for why (ANT fill-notify race with handleFillOrExternalSell).
                this.legsByToken.delete(leg.token);
                let fillPrice: number | undefined;
                try {
                    fillPrice = await this.sellLeg(leg);
                } catch (e) {
                    this.legsByToken.set(leg.token, leg); // sell never reached the broker - leg is still live there, keep tracking it for retry
                    leg.status = 'OPEN';
                    Log.log(`[${this.deps.ownerType}] Target-hit sell failed, leg remains open for retry:`, e);
                    return;
                }
                const pnl = ((fillPrice ?? ltp) - leg.avgPrice) * leg.totalQuantity;
                this.recordOutcome('win', pnl);
                Log.log(`[${this.deps.ownerType}] Target hit (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

                if (!leg.isRoot) {
                    this.freeParentSlot(leg);
                    await this.maybePromoteDeferredRootRefill();
                }

                const eligible = cfg.refillEnabled !== false && (leg.isRoot || this.isParentAlive(leg.parentLegId));
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
            } finally { this.closesInFlight--; }
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
            this.closesInFlight++;
            try {
                // Deleted BEFORE the sell await - see closeAllLegsAndCancelReEntries's
                // identical comment for why (ANT fill-notify race with handleFillOrExternalSell).
                this.legsByToken.delete(leg.token);
                let fillPrice: number | undefined;
                try {
                    fillPrice = await this.sellLeg(leg);
                } catch (e) {
                    this.legsByToken.set(leg.token, leg); // sell never reached the broker - leg is still live there, keep tracking it for retry
                    leg.status = 'OPEN';
                    Log.log(`[${this.deps.ownerType}] Square-off sell failed, leg remains open for retry:`, e);
                    return;
                }
                const pnl = ((fillPrice ?? ltp) - leg.avgPrice) * leg.totalQuantity;
                this.recordOutcome('loss', pnl);
                Log.log(`[${this.deps.ownerType}] Square-off (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

                if (!leg.isRoot) {
                    this.freeParentSlot(leg);
                    await this.maybePromoteDeferredRootRefill();
                }
                await this.cancelChildRefills(leg); // leg is gone for good either way (root or nested)
                return;
            } finally { this.closesInFlight--; }
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
                if (this.newOrdersBlocked() || this.capitalGateTripped || this.legsByToken.get(leg.token) !== leg || leg.status !== 'OPEN') {
                    leg.childByLevel.delete(level); // parent closed/closing or a stop latched while queued - nothing to hedge any more
                    return;
                }
                // A deeper (or retraced/re-triggered) level under this same leg
                // supersedes any of its shallower slots' still-resting refills -
                // cancel them first so capitalCheck below sees the freed capital.
                await this.cancelChildRefills(leg, level);
                const excludeStrikes = Array.from(this.openStrikesFor(oppositeRight));
                const contract = await this.currentOps(true).pickContract(this.deps.userId, underlyingLtp, optionType, cfg.minPremium ?? 100, excludeStrikes);
                if (!(await this.capitalCheck(spawnQty, contract.premium, `Level ${level} spawn (${leg.tsym})`))) {
                    leg.childByLevel.delete(level); // free the slot regardless - harmless even though the capital gate (now tripped) means it won't actually be retried
                    return;
                }
                // ANT token, not Kite's instrumentToken - see openRootLeg's comment.
                const trade: Trade = await this.currentOps(true).buy(
                    this.deps.userId, contract.tradingSymbol, contract.token, spawnQty, contract.exchange, contract.premium
                );
                // Same guard openRootLeg has: the buy already executed, so this cannot prevent the order, only stop it from
                // silently overwriting tracking of a leg already on this token.
                if (this.legsByToken.has(trade.token)) {
                    Log.log(`[${this.deps.ownerType}] REFUSING level ${level} spawn - token ${trade.token} already has a tracked leg. New untracked fill: ${trade.tsym} qty=${trade.quantity} - selling it back`);
                    leg.childByLevel.delete(level);
                    try {
                        await this.sellBack(trade.tsym, trade.token, trade.quantity, contract.exchange);
                    } catch (sellErr) {
                        Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the refused duplicate spawn (${trade.tsym} qty=${trade.quantity}) - UNTRACKED POSITION, manual action required:`, sellErr);
                    }
                    return;
                }
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
        } catch (e: any) {
            Log.log(`[${this.deps.ownerType}] Level ${level} spawn failed:`, e);
            // An unresolved fill may still be live: keep the slot consumed so no consumer (even one without the owner veto) retries it.
            if (!isUnconfirmedBuyError(e)) leg.childByLevel.delete(level); // ordinary failure - free the slot so it can retry
            this.deps.onSpawnBuyError?.(e);
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
                if (this.legsByToken.get(leg.token) !== leg || leg.status !== 'OPEN' || this.newOrdersBlocked()) {
                    leg.averagedLevels.delete(level); // leg closed/closing (or a stop latched) before this could run
                    return;
                }
                if (!(await this.capitalCheck(addQty, ltp, `Level ${level} average (${leg.tsym})`))) {
                    leg.averagedLevels.delete(level); // free the slot regardless - harmless even though the capital gate (now tripped) means it won't actually be retried
                    return;
                }
                const trade: Trade = await this.currentOps(true).buy(this.deps.userId, leg.tsym, leg.token, addQty, leg.exchange, ltp);
                if (this.legsByToken.get(leg.token) !== leg) {
                    // The leg was sold (target/square-off/mass close) while this add was filling: the sell used the
                    // old size, so the added quantity is an untracked long - sell it back.
                    Log.log(`[${this.deps.ownerType}] ALERT: average-add filled after ${leg.tsym} was closed (+${trade.quantity}) - selling it back`);
                    try {
                        await this.sellBack(leg.tsym, leg.token, trade.quantity, leg.exchange);
                    } catch (sellErr) {
                        Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the orphaned average-add (${leg.tsym} qty=${trade.quantity}) - UNTRACKED POSITION, manual action required:`, sellErr);
                    }
                    return;
                }
                leg.avgPrice = (leg.avgPrice * leg.totalQuantity + trade.price * trade.quantity) / (leg.totalQuantity + trade.quantity);
                leg.totalQuantity += trade.quantity;
                Log.log(`[${this.deps.ownerType}] Level ${level} average: ${leg.tsym} +qty=${trade.quantity} @ ${trade.price} -> totalQty=${leg.totalQuantity} avg=${leg.avgPrice.toFixed(2)} (${leg.tsym})`);
                this.logLegStatus(leg);
            });
        } catch (e) {
            Log.log(`[${this.deps.ownerType}] Level ${level} average failed:`, e);
            // An unresolved fill may still be live: keep the level consumed (a retry would double-buy) and tell the owner so it
            // latches manual review and vetoes every further buy. Any other failure frees the slot to retry.
            if (isUnconfirmedBuyError(e)) this.deps.onSpawnBuyError?.(e);
            else leg.averagedLevels.delete(level);
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
            unwatchToken(token, this.deps.strategyRef, intent.exchange);
            if (intent.orderId) this.supersededRefills.set(intent.orderId, { tsym: intent.tsym, token, exchange: intent.exchange });
            try {
                await this.currentOps().cancel(this.deps.userId, intent.orderId, intent.exchange);
                Log.log(`[${this.deps.ownerType}] Pending refill at level ${intent.parentLevel} cancelled (parent ${leg.tsym}): ${intent.tsym}`);
            } catch (e: any) {
                // The refill filled before the cancel landed (OrderAlreadyFilledError carries the real filled
                // quantity). This refill was just superseded - its intent is already deleted above, so nothing
                // tracks the quantity it bought; left alone it is an orphaned long (2026-10-19: 130 + 195 lots
                // of 23000 CE). Sell it straight back.
                const filledQty = alreadyFilledQty(e);
                if (filledQty > 0) {
                    // Sold back right here, so the echo of this same fill must not trigger a second sell-back.
                    this.supersededRefills.delete(intent.orderId);
                    this.handledBuyOrderIds.add(intent.orderId);
                    Log.log(`[${this.deps.ownerType}] ALERT: superseded refill ${intent.orderId} (${intent.tsym}) had already filled ${filledQty} - selling it back so it is not left untracked`);
                    try {
                        await this.currentOps().sell(this.deps.userId, intent.tsym, intent.token, filledQty, intent.exchange);
                    } catch (sellErr) {
                        Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the filled superseded refill (${intent.tsym} qty=${filledQty}) - UNTRACKED POSITION, manual action required:`, sellErr);
                    }
                } else if (/does not exist|not found/i.test(String(e?.message ?? e))) {
                    // The broker never had the order resting - in practice it was REJECTED right after being placed (live 2026-10-29: Kite
                    // reported "does not exist" for a refill the order tracker then marked REJECTED). It is already in supersededRefills
                    // above, so a fill that somehow still lands is sold back; this is not a failure to alert on.
                    Log.log(`[${this.deps.ownerType}] Child refill ${intent.orderId} (${intent.tsym}): broker reports the order does not exist - most likely rejected before it rested; kept as superseded, a late fill would be sold back`);
                } else {
                    Log.log(`[${this.deps.ownerType}] Child refill cancel failed:`, e);
                }
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
                if (this.newOrdersBlocked()) return false; // a stop latched while queued - never rest a new buy
                // This refill queued behind the lock while a spawn/entry ran first: the intent is only registered in
                // pendingReEntries below, so that spawn's openStrikesFor() could not see the strike and may have picked
                // this very token (2026-10-28 10:07: NIFTY26N0322500PE). Resting a buy on a token a live leg already holds
                // can only end as a duplicate fill that has to be sold back at market.
                if (this.legsByToken.has(intent.token)) {
                    Log.log(`[${this.deps.ownerType}] Refill skipped: ${intent.tsym} is already held by a tracked leg (taken over by a spawn/entry while this refill was queued)`);
                    return false;
                }
                const context = intent.isRoot ? 'Root refill' : `Nested refill (${intent.tsym})`;
                if (!(await this.capitalCheck(intent.quantity, intent.limitPrice, context))) {
                    return false; // capital gate tripped - gone for good, root and nested alike, no retry
                }
                const { orderId } = await this.currentOps(true).buyLimit(
                    this.deps.userId, intent.tsym, intent.token, intent.quantity, intent.exchange, intent.limitPrice
                );
                intent.orderId = orderId;
                this.pendingReEntries.set(intent.token, intent);
                watchToken(intent.token, this.deps.strategyRef, intent.exchange); // keep ticks flowing so checkRefillDrift can see this contract's LTP
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
        unwatchToken(token, this.deps.strategyRef, intent.exchange);
        await this.cancelIntentOrSellBack(intent, `Refill drift (LTP ${(ltp - intent.limitPrice).toFixed(2)} above limit ${intent.limitPrice})`);
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
            let soldQty = Number(trade.quantity);
            const echo = this.ignoredSellEchoes.get(trade.token);
            if (echo && echo.expires > Date.now() && Number.isFinite(soldQty) && soldQty > 0) {
                const consumed = Math.min(echo.qty, soldQty);
                echo.qty -= consumed;
                if (echo.qty <= 0) this.ignoredSellEchoes.delete(trade.token);
                soldQty -= consumed;
                Log.log(`[${this.deps.ownerType}] Ignoring ${consumed} of a Sell fill on ${trade.tsym} - echo of this instance's own sell-back`);
                if (soldQty <= 0) return;
            } else if (echo && echo.expires <= Date.now()) {
                this.ignoredSellEchoes.delete(trade.token);
            }
            if (Number.isFinite(soldQty) && soldQty > 0 && soldQty < leg.totalQuantity) {
                // Partial external sell: the rest of the leg is still live at the broker - keep tracking it.
                const partialPnl = (trade.price - leg.avgPrice) * soldQty;
                leg.totalQuantity -= soldQty;
                this.recordOutcome(partialPnl >= 0 ? 'win' : 'loss', partialPnl);
                Log.log(`[${this.deps.ownerType}] External/manual PARTIAL sell detected: ${leg.tsym} sold ${soldQty}, ${leg.totalQuantity} still open, pnl=${Math.round(partialPnl)}`);
                return;
            }
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
        // A superseded refill (see supersededRefills) that filled anyway: its pending intent is gone, so it can
        // never become a leg. Match it by broker order id BEFORE the token lookup, because a newer refill on the same
        // token would otherwise swallow this fill. Sell it straight back rather than leave an untracked position.
        const oid = trade.brokerOrderId;
        const superseded = oid ? this.supersededRefills.get(oid) : undefined;
        if (oid && superseded && !this.handledBuyOrderIds.has(oid)) {
            this.supersededRefills.delete(oid);
            this.handledBuyOrderIds.add(oid);
            Log.log(`[${this.deps.ownerType}] ALERT: superseded refill ${oid} (${superseded.tsym}) filled ${trade.quantity} @ ${trade.price} after it was replaced - selling it back so it is not left untracked`);
            try {
                await this.sellBack(superseded.tsym, superseded.token, trade.quantity, superseded.exchange);
            } catch (sellErr) {
                Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the filled superseded refill (${superseded.tsym} qty=${trade.quantity}) - UNTRACKED POSITION, manual action required:`, sellErr);
            }
            return;
        }
        const intent = this.pendingReEntries.get(trade.token);
        if (!intent) return; // redundant echo of a market buy already handled synchronously
        if (oid) this.handledBuyOrderIds.add(oid);
        this.pendingReEntries.delete(trade.token);
        unwatchToken(trade.token, this.deps.strategyRef, intent.exchange);
        if (this.legsByToken.has(trade.token)) {
            // A live leg already sits on this token (e.g. a spawn that picked this strike): adopting the refill would overwrite it
            // and lose its size and lineage. The refill's quantity is the untracked part - sell exactly that back.
            Log.log(`[${this.deps.ownerType}] ALERT: refill ${oid ?? ''} (${trade.tsym}) filled ${trade.quantity} while a tracked leg already holds this token - selling the refill back`);
            try {
                await this.sellBack(trade.tsym, trade.token, trade.quantity, intent.exchange);
            } catch (sellErr) {
                Log.log(`[${this.deps.ownerType}] ALERT: could not sell back the duplicate refill (${trade.tsym} qty=${trade.quantity}) - UNTRACKED POSITION, manual action required:`, sellErr);
            }
            return;
        }
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
            registerTrade(trade.token, this.deps.strategyRef, undefined, leg.exchange);
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
        // Resting refill buys are live at the broker: cancel each (or sell it back if it already filled) and stop its tick watch.
        // Cleared bookkeeping alone left them to fill later into no intent, i.e. an untracked long.
        const abandoned = Array.from(this.pendingReEntries.values());
        for (const intent of abandoned) unwatchToken(intent.token, this.deps.strategyRef, intent.exchange);
        this.legsByToken.clear();
        this.pendingReEntries.clear();
        this.deferredRootRefill = null;
        this.capitalGateTripped = false;
        this.maxProfitTripped = false;
        this.maxLossTripped = false;
        this.persistLatch(null);
        this.eodClosing = false;
        this.supersededRefills.clear();
        this.handledBuyOrderIds.clear();
        this.ignoredSellEchoes.clear();
        this.maxProfitBaseline = this.realizedPnL;
        this.activeDay = LegManager.latchDay();
        // After the clears above, so an abandoned refill that fills anyway is recognised and sold back instead of dropped as an echo.
        // Dispatched BEFORE the dry-run latch is cleared: the cancel resolves its ops synchronously, and an intent created in dry-run
        // mode must go to the dry-run ops, never the real broker.
        for (const intent of abandoned) {
            if (intent.orderId) this.supersededRefills.set(intent.orderId, { tsym: intent.tsym, token: intent.token, exchange: intent.exchange });
            this.cancelIntentOrSellBack(intent, 'Reset').catch((e) => Log.log(`[${this.deps.ownerType}] Reset: cancel of pending re-entry ${intent.tsym} failed:`, e));
        }
        this.dryRunLatched = false;
    }
}
