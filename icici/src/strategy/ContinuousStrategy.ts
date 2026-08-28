import moment from 'moment';
import Log from '../util/Log';
import { CALL, PUT, MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { watchToken, unwatchToken } from '../processes/strategies/tokenRouter';
import { Strategy } from './strategy';

// Sentinel used to reserve a level slot synchronously (before the spawn's
// contract-lookup/buy await resolves) so a burst of unawaited ticks for the
// same token (strategiesProcess.ts does not await onTick sequentially) can't
// double-spawn the same level. Replaced with the real legId on success, or
// removed again on failure/capital-block so the slot can retry.
const PENDING = '__pending__';

// PCR (Put/Call OI ratio) re-check cadence and near-the-money window for T1's
// alignment gate - see isPcrAligned(). Not config-driven: exact values agreed
// with the user (retest every 5 min, +/-300 points around spot).
const PCR_RECHECK_MS = 5 * 60 * 1000;
const PCR_WINDOW_POINTS = 300;

// Gate-log throttle (see logGateOnce) - matches PCR_RECHECK_MS so the
// "pcr check throttled - waiting for next 5-min window" message (and other
// gate reasons, which change on a similarly slow cadence) doesn't re-log
// on every tick while the underlying gate state hasn't actually changed.
const GATE_LOG_THROTTLE_MS = PCR_RECHECK_MS;

interface Leg {
    legId: string;
    token: string;
    tsym: string;
    strike: number;
    exchange: 'NFO' | 'BFO';
    right: string; // CALL | PUT
    entryPrice: number; // E - original entry price, fixed forever; still what adverse-level/5x
    // triggers and hedge-spawn's spawnQuantityMode sizing are measured against, unaffected by averaging.
    quantity: number; // original entry quantity, fixed forever; still what hedge-spawn sizing reads.
    isRoot: boolean; // true only for T1 and any later refill/restart of T1
    parentLegId: string | null; // null for root legs
    parentLevel: number | null; // 1-4: which slot on the parent this leg occupies; null for root
    childByLevel: Map<number, string>; // level (1-4) -> currently-open child legId (or PENDING while spawning)
    status: 'OPEN' | 'CLOSING';
    avgPrice: number; // running average cost basis; == entryPrice until the first average-add
    totalQuantity: number; // actual held size including average-adds; == quantity until the first average-add
    averagedLevels: Set<number>; // which of levels 1-4 already triggered an average-add on this leg
}

interface PendingReEntry {
    token: string;
    tsym: string;
    exchange: 'NFO' | 'BFO';
    strike: number;
    right: string;
    quantity: number;
    limitPrice: number; // = the original entry price E being re-entered at
    orderId: string; // Zerodha order id, for cancelling on drift (see checkRefillDrift)
    isRoot: boolean; // mirrors Leg.isRoot - which identity to reconstruct once this fills (see updateTrade)
    parentLegId: string | null; // mirrors Leg.parentLegId - null for a root refill
    parentLevel: number | null; // mirrors Leg.parentLevel - which slot to reoccupy on fill (see updateTrade)
}

// ContinuousStrategy - opens a root leg (T1) via BuySellStrategy-style entry
// triggers, then self-monitors every open leg's own price against a target
// and four stacked adverse levels (1x-4x of a configured SL distance, each
// spawning a new opposite-direction leg) plus a 5x square-off. Every leg
// (root or nested) refills at its original entry price on a target-hit,
// gated so the tree can't grow without bound: a nested leg only refills
// while its own parent is still a live leg (isParentAlive), a leg that ends
// up not refilling cancels its own children's pending refills
// (cancelChildRefills), and a new deeper/retraced spawn under a leg first
// cancels that leg's own shallower still-resting refills. See spec.md and
// continuous-strategy-plan.md at the repo root for the full design.
export default class ContinuousStrategy extends Strategy {
    name = 'ContinuousStrategy';

    private legsByToken: Map<string, Leg> = new Map();
    private pendingReEntries: Map<string, PendingReEntry> = new Map(); // keyed by token
    private deferredRootRefill: PendingReEntry | null = null;
    private lastNiftyLtp = 0;
    private legIdCounter = 0;
    private lastGateLog = new Map<string, number>();
    private lastPcrCheckTime = 0;
    // Serializes every contract-selection+buy decision (T1 entry, spawns,
    // root refill) on this strategy instance. Without this, concurrent ticks
    // (e.g. two different open legs both crossing a spawn threshold within
    // the same event-loop turn) can each compute openStrikesFor()/capitalCheck()
    // against the same "before" snapshot of legsByToken, independently pass,
    // and both buy - landing on the same strike/token. legsByToken is keyed
    // by token, so the second commit silently overwrites the first leg's
    // tracking even though both fills are real and open at the broker,
    // leaving real exposure with no target/SL monitoring and undercounting
    // capitalCheck's total. See 2026-08-25 incident: 4 concurrent spawns
    // landed on NIFTY26AUG24100CE, only the last stayed tracked.
    private opLock: Promise<any> = Promise.resolve();

    constructor(userId?: string) {
        super(userId);
    }

    receive(oldStats, newStats) {}

    private withOpLock<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.opLock.then(fn, fn);
        this.opLock = result.catch(() => {}); // don't let one failure poison the chain for later callers
        return result;
    }

    // Overrides Strategy's default 10:00-15:00 window (src/strategy/strategy.ts)
    // with ContinuousStrategy's own 09:30-15:00 - other strategies are unaffected.
    isTimeInRange(): boolean {
        if (MOCK_BROKER) return true; // bypass in mock/test/backtest mode, same as the base class
        const now = moment();
        const startTime = moment().hour(9).minute(30);
        const endTime = moment().hour(15).minute(0);
        return now.isAfter(startTime) && now.isBefore(endTime);
    }

    private cfg() {
        return configService.getStrategyConfig('ContinuousStrategy');
    }

    // Temporary diagnostic: T1's gate checks (enabled/time-window/ordered/
    // cooldown) were previously silent on every early return, giving no
    // visibility into which one (if any) blocks a given tick. Throttled to
    // avoid spamming on every tick - at most once per GATE_LOG_THROTTLE_MS
    // per distinct reason. Tracked per-reason (not just the last-seen one)
    // since gates that alternate between two reasons tick-to-tick (e.g.
    // "gates clear" then "pcr throttled") would otherwise look "new" every
    // time and bypass the throttle entirely.
    private logGateOnce(reason: string): void {
        const now = Date.now();
        const last = this.lastGateLog.get(reason) ?? 0;
        if (now - last < GATE_LOG_THROTTLE_MS) return;
        this.lastGateLog.set(reason, now);
        Log.log(`[ContinuousStrategy] T1 gate: ${reason}`);
    }

    private nextLegId(): string {
        return `${this.userId}-leg-${++this.legIdCounter}`;
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

    // Section 5a: sum(qty * entryPrice) over open legs + pending re-entries,
    // plus the new order's own projected cost, must stay under allottedCapital.
    // A skip is not sticky - callers simply leave the relevant slot/intent free
    // to be re-evaluated on a later tick once capital frees up.
    // Per-user override (set by an admin on the placing user's profile) takes
    // precedence over this strategy instance's own config.yml value, so the
    // same ContinuousStrategy config can be capital-capped differently per
    // real user once it's ever assigned a real userId (see src/user.ts's
    // allottedCapital field).
    private async capitalCheck(newQty: number, estimatedPremium: number): Promise<boolean> {
        const allottedCapital = (await OrderClient.getInstance().getUserAllottedCapital(this.userId)) ?? this.cfg().allottedCapital;
        if (allottedCapital == null) return true; // no cap configured
        let total = 0;
        for (const leg of this.legsByToken.values()) total += leg.totalQuantity * leg.avgPrice;
        for (const pending of this.pendingReEntries.values()) total += pending.quantity * pending.limitPrice;
        total += newQty * estimatedPremium;
        return total <= allottedCapital;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        const token = String(quote.token);
        return this.legsByToken.has(token) || this.pendingReEntries.has(token);
    };

    // Real T1 direction/alignment gate, replacing the dead isSentimentAligned(quote,
    // right) base-class check (that one keys off quote.buyQty/sellQty, which ANT
    // ticks never populate, so it always auto-passed) and the old prevClose-based
    // momentum direction (removed - a mismatch between momentum and PCR was
    // blocking real entries, e.g. 2026-08-26: PCR favored CE while momentum favored
    // PE). PCR is now the only source of direction. PCR = sum(PE oi)/sum(CE oi) over
    // strikes within PCR_WINDOW_POINTS of spot, from AliceBlue's Option Chain API
    // (routed through OrderClient -> order process, which owns the ANT REST call -
    // see ANT.getOptionChainPCR). PCR > 1 (more put OI) favors PUT, PCR < 1 favors
    // CALL. Re-checked at most every PCR_RECHECK_MS; a throttled/failed fetch fails
    // closed (blocks T1) until the next window.
    private async fetchPcrIfDue(quote: NiftyQuote): Promise<number | null> {
        const now = Date.now();
        if (now - this.lastPcrCheckTime < PCR_RECHECK_MS) {
            this.logGateOnce('pcr check throttled - waiting for next 5-min window');
            return null;
        }
        this.lastPcrCheckTime = now;
        try {
            return await OrderClient.getInstance().getPCR(this.userId, 'NIFTY', quote.ltp, PCR_WINDOW_POINTS);
        } catch (e) {
            Log.log('[ContinuousStrategy] PCR check failed, blocking T1 (fail-closed):', e);
            return null;
        }
    }

    // Direction to trade this tick, or null to block entry. If configuredRight is
    // set, PCR must agree with it (mismatch blocks, same as before). If unset
    // ('none'/undefined), direction is derived directly from PCR - aligned by
    // construction, since there's no separate momentum term left to disagree with.
    private async resolveEntryRight(quote: NiftyQuote, configuredRight?: string): Promise<string | null> {
        const pcr = await this.fetchPcrIfDue(quote);
        if (pcr == null) return null;
        const pcrFavors = pcr > 1 ? PUT : CALL;
        if (!configuredRight) {
            Log.log(`[ContinuousStrategy] PCR=${pcr.toFixed(3)} -> auto-resolved direction ${pcrFavors}`);
            return pcrFavors;
        }
        const aligned = pcrFavors === configuredRight;
        Log.log(`[ContinuousStrategy] PCR=${pcr.toFixed(3)} favors ${pcrFavors}, configured right ${configuredRight} -> ${aligned ? 'ALIGNED' : 'NOT aligned'}`);
        return aligned ? configuredRight : null;
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        this.lastNiftyLtp = quote.ltp;
        const cfg = this.cfg();
        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
        if (this.ordered) { this.logGateOnce('already ordered / T1 in flight'); return; }
        if (!this.isCooldownElapsed(cfg.cooldownSeconds ?? 60)) { this.logGateOnce('cooldown not elapsed'); return; }
        this.logGateOnce('all T1 gates clear - attempting entry');

        this.ordered = true;

        const configuredRight = (cfg.right && cfg.right !== 'none') ? cfg.right : undefined;
        const right = await this.resolveEntryRight(quote, configuredRight);
        if (right == null) {
            this.ordered = false;
            return;
        }

        const optionType = right === CALL ? 'CE' : 'PE';
        const minPremium = cfg.minPremium ?? 100;
        const initialQuantity = cfg.initialQuantity;

        try {
            // Locked: strike selection (excludeStrikes) and the commit to
            // legsByToken must be atomic with respect to every other spawn/entry
            // decision on this instance - see opLock's comment.
            await this.withOpLock(async () => {
                const excludeStrikes = Array.from(this.openStrikesFor(right));
                const contract = await OrderClient.getInstance().getContractByPriceRangeZerodha(
                    this.userId, quote.ltp, optionType, minPremium, 'NIFTY', excludeStrikes
                );
                if (!(await this.capitalCheck(initialQuantity, contract.premium))) {
                    Log.log('[ContinuousStrategy] T1 entry skipped - would exceed allotted capital');
                    this.ordered = false;
                    return;
                }
                // ANT token, not Zerodha's instrumentToken - live option ticks are keyed by
                // ANT's own token (OptionQuote.fromAnt), so this leg's tick subscription and
                // canHandleOptionQuote matching (both keyed off this token) must use it too.
                const trade: Trade = await OrderClient.getInstance().buyContractZerodhaBare(
                    this.userId, contract.tradingSymbol, String(contract.antToken), initialQuantity, contract.exchange, contract.premium
                );
                const legId = this.nextLegId();
                const leg: Leg = {
                    legId, token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                    right, entryPrice: trade.price, quantity: trade.quantity, isRoot: true,
                    parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN',
                    avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
                };
                this.legsByToken.set(trade.token, leg);
                Log.log(`[ContinuousStrategy] T1 entry: ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
                this.logLegStatus(leg);
                this.recordTriggerTime();
            });
        } catch (e) {
            Log.log('[ContinuousStrategy] T1 entry failed:', e);
            this.ordered = false;
        }
    }

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        const leg = this.legsByToken.get(String(quote.token));
        if (!leg) {
            await this.checkRefillDrift(String(quote.token), quote.ltp);
            return;
        }

        const cfg = this.cfg();
        const D = cfg.slDistance;
        const ltp = quote.ltp;

        // Target hit - avgPrice/totalQuantity equal entryPrice/quantity until this leg
        // has been averaged at least once, so this is unchanged for a never-averaged leg.
        const target = leg.avgPrice + (leg.averagedLevels.size > 0 ? 1 : D);
        if (ltp >= target) {
            this.legsByToken.delete(leg.token); // synchronous, before any await
            try {
                await OrderClient.getInstance().sellContractZerodhaBare(this.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            } catch (e) {
                Log.log('[ContinuousStrategy] Target-hit sell failed:', e);
            }
            const pnl = (ltp - leg.avgPrice) * leg.totalQuantity;
            this.recordOutcome('win', pnl);
            Log.log(`[ContinuousStrategy] Target hit (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

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
                };
                let placed: boolean;
                if (leg.isRoot && this.hasOpenNestedLegs()) {
                    this.deferredRootRefill = intent;
                    Log.log(`[ContinuousStrategy] Root refill deferred (nested legs still open): ${leg.tsym}`);
                    placed = true;
                } else {
                    placed = await this.placeRefill(intent);
                }
                if (!placed) await this.cancelChildRefills(leg);
            } else {
                Log.log(`[ContinuousStrategy] No refill - parent closed: ${leg.tsym}`);
                await this.cancelChildRefills(leg);
            }

            this.maybeRearmEntry();
            return;
        }

        // Adverse levels (1x-5x), measured from this leg's own ORIGINAL entry price -
        // unaffected by averaging, so hedge-spawn timing and the 5x trigger point are
        // exactly as before averaging existed.
        const adverseMove = leg.entryPrice - ltp;
        if (adverseMove <= 0) return;
        const level = Math.min(5, Math.floor(adverseMove / D));

        if (level >= 1 && level <= 4) {
            if (!leg.childByLevel.has(level)) {
                await this.trySpawnLevel(leg, level);
            }
            if (!leg.averagedLevels.has(level)) {
                await this.tryAverageLevel(leg, level, ltp);
            }
            return;
        }

        if (level === 5) {
            this.legsByToken.delete(leg.token); // synchronous, before any await
            try {
                await OrderClient.getInstance().sellContractZerodhaBare(this.userId, leg.tsym, leg.token, leg.totalQuantity, leg.exchange);
            } catch (e) {
                Log.log('[ContinuousStrategy] 5x square-off sell failed:', e);
            }
            const pnl = (ltp - leg.avgPrice) * leg.totalQuantity;
            this.recordOutcome('loss', pnl);
            Log.log(`[ContinuousStrategy] 5x square-off (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

            if (!leg.isRoot) {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }
            await this.cancelChildRefills(leg); // leg is gone for good either way (root or nested)
            this.maybeRearmEntry();
        }
    };

    private async trySpawnLevel(leg: Leg, level: number): Promise<void> {
        const cfg = this.cfg();
        const mode = cfg.spawnQuantityMode || 'multiplied';
        const spawnQty = mode === 'same' ? leg.quantity : leg.quantity * level;
        const oppositeRight = leg.right === CALL ? PUT : CALL;
        const optionType = oppositeRight === CALL ? 'CE' : 'PE';

        // Reserve the slot synchronously before any await - see PENDING's comment.
        leg.childByLevel.set(level, PENDING);

        try {
            // Locked: same reasoning as T1 entry - strike selection and the
            // legsByToken commit must be atomic across every concurrent
            // spawn/entry attempt on this instance, or two different parent
            // legs can independently pick the same strike before either has
            // committed, and the second commit silently overwrites the first
            // leg's tracking (see opLock's comment).
            await this.withOpLock(async () => {
                // A deeper (or retraced/re-triggered) level under this same leg
                // supersedes any of its shallower slots' still-resting refills -
                // cancel them first so capitalCheck below sees the freed capital.
                await this.cancelChildRefills(leg, level);
                const excludeStrikes = Array.from(this.openStrikesFor(oppositeRight));
                const contract = await OrderClient.getInstance().getContractByPriceRangeZerodha(
                    this.userId, this.lastNiftyLtp, optionType, cfg.minPremium ?? 100, 'NIFTY', excludeStrikes
                );
                if (!(await this.capitalCheck(spawnQty, contract.premium))) {
                    leg.childByLevel.delete(level); // not sticky - retried on a later qualifying tick
                    if (cfg.logEnabled) Log.log(`[ContinuousStrategy] Level ${level} spawn skipped - would exceed allotted capital`);
                    return;
                }
                // ANT token, not Zerodha's instrumentToken - see the T1 entry comment above.
                const trade: Trade = await OrderClient.getInstance().buyContractZerodhaBare(
                    this.userId, contract.tradingSymbol, String(contract.antToken), spawnQty, contract.exchange, contract.premium
                );
                const childLegId = this.nextLegId();
                const childLeg: Leg = {
                    legId: childLegId, token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                    right: oppositeRight, entryPrice: trade.price, quantity: trade.quantity, isRoot: false,
                    parentLegId: leg.legId, parentLevel: level, childByLevel: new Map(), status: 'OPEN',
                    avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
                };
                this.legsByToken.set(trade.token, childLeg);
                leg.childByLevel.set(level, childLegId);
                Log.log(`[ContinuousStrategy] Level ${level} spawn: ${trade.tsym} qty=${trade.quantity} entry=${trade.price} (parent ${leg.tsym})`);
                this.logLegStatus(childLeg);
            });
        } catch (e) {
            leg.childByLevel.delete(level); // spawn failed - free the slot so it can retry
            Log.log(`[ContinuousStrategy] Level ${level} spawn failed:`, e);
        }
    }

    // Averages into the SAME losing leg, in addition to (not instead of) the opposite-
    // leg hedge spawned by trySpawnLevel above at the same adverse-level trigger. Lowers
    // leg.avgPrice/raises leg.totalQuantity so the leg's own target (see processOptionQuote)
    // becomes avg+1 instead of avg+D once at least one average-add has happened - a faster
    // exit than waiting for the full D-point recovery. Deliberately does not touch
    // leg.quantity/leg.entryPrice - those stay exactly as trySpawnLevel's spawnQuantityMode
    // sizing and the adverse-level/5x triggers already read them.
    private async tryAverageLevel(leg: Leg, level: number, ltp: number): Promise<void> {
        const cfg = this.cfg();
        const mode = cfg.averageQuantityMode || 'same';
        const addQty = mode === 'same' ? leg.quantity : leg.quantity * level;

        // Reserve the slot synchronously before any await, same reasoning as
        // childByLevel's PENDING sentinel above.
        leg.averagedLevels.add(level);

        try {
            await this.withOpLock(async () => {
                // The leg may have hit its own target/5x (and been deleted from
                // legsByToken) on a later tick while this was queued on opLock.
                if (!this.legsByToken.has(leg.token)) {
                    leg.averagedLevels.delete(level); // leg closed before this could run
                    return;
                }
                // ltp (the current tick, not leg.avgPrice) is the correct estimate here -
                // it's what capitalCheck and the real order-process risk gate (estimatedValue
                // = price*quantity, see orderProcess.ts's buyContractZerodhaBare handler)
                // should size against, same as trySpawnLevel uses the fresh contract.premium
                // rather than anything already-stale.
                if (!(await this.capitalCheck(addQty, ltp))) {
                    leg.averagedLevels.delete(level); // not sticky - retried on a later qualifying tick
                    if (cfg.logEnabled) Log.log(`[ContinuousStrategy] Level ${level} average skipped - would exceed allotted capital`);
                    return;
                }
                const trade: Trade = await OrderClient.getInstance().buyContractZerodhaBare(
                    this.userId, leg.tsym, leg.token, addQty, leg.exchange, ltp
                );
                leg.avgPrice = (leg.avgPrice * leg.totalQuantity + trade.price * trade.quantity) / (leg.totalQuantity + trade.quantity);
                leg.totalQuantity += trade.quantity;
                Log.log(`[ContinuousStrategy] Level ${level} average: ${leg.tsym} +qty=${trade.quantity} @ ${trade.price} -> totalQty=${leg.totalQuantity} avg=${leg.avgPrice.toFixed(2)} (${leg.tsym})`);
                this.logLegStatus(leg);
            });
        } catch (e) {
            leg.averagedLevels.delete(level); // average-add failed - free the slot so it can retry
            Log.log(`[ContinuousStrategy] Level ${level} average failed:`, e);
        }
    }

    // Section 3: visibility into a leg's live thresholds after any event that changes
    // its size/basis (open, spawn, root refill, average-add) - answers "when will this
    // close, or move to the next level" without having to compute it by hand from logs.
    private logLegStatus(leg: Leg): void {
        const cfg = this.cfg();
        const D = cfg.slDistance;
        const target = leg.avgPrice + (leg.averagedLevels.size > 0 ? 1 : D);
        let nextLevel = 1;
        while (nextLevel <= 4 && leg.childByLevel.has(nextLevel)) nextLevel++;
        const nextLevelPrice = leg.entryPrice - nextLevel * D;
        const squareOff = leg.entryPrice - 5 * D;
        Log.log(`[ContinuousStrategy] ${leg.tsym} status: qty=${leg.totalQuantity} avg=${leg.avgPrice.toFixed(2)} target=${target.toFixed(2)} nextLevel(${nextLevel})@${nextLevelPrice.toFixed(2)} squareOff@${squareOff.toFixed(2)}`);
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
    // of them (leg is closing for good: 5x, parent-not-alive, or capital-blocked
    // nested refill), or only those at level <= atOrBelowLevel (a new, deeper hedge
    // is about to spawn under this same leg, so shallower stale refills are cleared
    // first - see trySpawnLevel). Same cancel/unwatch/log pattern as checkRefillDrift.
    private async cancelChildRefills(leg: Leg, atOrBelowLevel?: number): Promise<void> {
        const stale = Array.from(this.pendingReEntries.entries()).filter(([, intent]) =>
            intent.parentLegId === leg.legId && (atOrBelowLevel == null || (intent.parentLevel != null && intent.parentLevel <= atOrBelowLevel))
        );
        for (const [token, intent] of stale) {
            this.pendingReEntries.delete(token);
            unwatchToken(token, this);
            try {
                await OrderClient.getInstance().cancelOrderZerodha(this.userId, intent.orderId);
                Log.log(`[ContinuousStrategy] Pending refill at level ${intent.parentLevel} cancelled (parent ${leg.tsym}): ${intent.tsym}`);
            } catch (e) {
                Log.log('[ContinuousStrategy] Child refill cancel failed:', e);
            }
        }
    }

    // Returns true if the refill is either placed or (root-only) deferred for later
    // retry - i.e. this leg's identity isn't gone for good. Returns false when it is
    // gone for good (nested + capital-blocked = skipped outright, no retry; or a
    // genuine placement failure) - callers use this to decide whether to cascade-
    // cancel this leg's OWN children's pending refills (see cancelChildRefills).
    private async placeRefill(intent: PendingReEntry): Promise<boolean> {
        try {
            // Locked so this capitalCheck reads a consistent snapshot against
            // any concurrent T1 entry/spawn decision - see opLock's comment.
            // No fresh strike selection here (the refill reuses intent's
            // already-decided contract), but the capital total it checks is
            // shared with those other paths.
            return await this.withOpLock(async () => {
                if (!(await this.capitalCheck(intent.quantity, intent.limitPrice))) {
                    if (intent.isRoot) {
                        Log.log('[ContinuousStrategy] Root refill deferred - would exceed allotted capital');
                        this.deferredRootRefill = intent;
                        return true;
                    }
                    Log.log(`[ContinuousStrategy] Nested refill skipped - would exceed allotted capital: ${intent.tsym}`);
                    return false;
                }
                const { orderId } = await OrderClient.getInstance().placeLimitBuyZerodhaBare(
                    this.userId, intent.tsym, intent.token, intent.quantity, intent.limitPrice, intent.exchange
                );
                intent.orderId = orderId;
                this.pendingReEntries.set(intent.token, intent);
                watchToken(intent.token, this); // keep ticks flowing so checkRefillDrift can see this contract's LTP
                Log.log(`[ContinuousStrategy] Refill placed (${intent.isRoot ? 'root' : 'nested'}): ${intent.tsym} qty=${intent.quantity} price=${intent.limitPrice}`);
                return true;
            });
        } catch (e) {
            Log.log('[ContinuousStrategy] Refill placement failed:', e);
            return false;
        }
    }

    private async maybePromoteDeferredRootRefill(): Promise<void> {
        if (!this.deferredRootRefill) return;
        if (this.hasOpenNestedLegs()) return;
        const intent = this.deferredRootRefill;
        this.deferredRootRefill = null;
        Log.log(`[ContinuousStrategy] Promoting deferred root refill: ${intent.tsym}`);
        await this.placeRefill(intent);
    }

    // A refill's limit buy sits below the price at the moment it's placed (the leg
    // just hit target and sold above its entry price) - once LTP runs more than
    // refillCancelDistance points above that resting price, the order is unlikely to
    // fill soon, so give up on this contract entirely: cancel and drop the pending
    // re-entry outright (no re-place at a new price). Applies to any leg's refill
    // (root or nested) - root re-enters fresh via its normal entry gates
    // (processNiftyQuote) the next time they clear; a nested leg's slot just stays
    // free until its own parent's adverse level re-triggers it.
    // ltp - limitPrice (not Math.abs) is deliberate - only upward drift away from a
    // fillable price is the failure mode being guarded against.
    private async checkRefillDrift(token: string, ltp: number): Promise<void> {
        const intent = this.pendingReEntries.get(token);
        if (!intent) return;
        const cancelDistance = this.cfg().refillCancelDistance ?? 50;
        if (ltp - intent.limitPrice <= cancelDistance) return;
        this.pendingReEntries.delete(token); // synchronous, before any await - same pattern as leg-close paths
        unwatchToken(token, this);
        try {
            await OrderClient.getInstance().cancelOrderZerodha(this.userId, intent.orderId);
            Log.log(`[ContinuousStrategy] Root refill cancelled - LTP drifted ${(ltp - intent.limitPrice).toFixed(2)} above limit ${intent.limitPrice}: ${intent.tsym}`);
        } catch (e) {
            Log.log('[ContinuousStrategy] Root refill cancel failed:', e);
        }
        this.maybeRearmEntry();
    }

    private maybeRearmEntry(): void {
        if (this.legsByToken.size === 0 && this.pendingReEntries.size === 0 && !this.deferredRootRefill) {
            this.ordered = false;
        }
    }

    // Only meaningful for root-refill limit fills - every other fill (T1/spawn/
    // target-close market buys and sells) is already handled synchronously by
    // the code path that placed it, since those all return the fill directly.
    updateTrade = async (trade: Trade): Promise<void> => {
        if (trade.action !== 'Buy') return; // Sell echoes: already handled synchronously
        const intent = this.pendingReEntries.get(trade.token);
        if (!intent) return; // redundant echo of a market buy already handled synchronously
        this.pendingReEntries.delete(trade.token);
        unwatchToken(trade.token, this);
        const legId = this.nextLegId();
        const leg: Leg = {
            legId, token: trade.token, tsym: intent.tsym, strike: intent.strike, exchange: intent.exchange,
            right: intent.right, entryPrice: trade.price, quantity: trade.quantity, isRoot: intent.isRoot,
            parentLegId: intent.parentLegId, parentLevel: intent.parentLevel, childByLevel: new Map(), status: 'OPEN',
            avgPrice: trade.price, totalQuantity: trade.quantity, averagedLevels: new Set(),
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
        Log.log(`[ContinuousStrategy] Refill filled (${intent.isRoot ? 'root' : 'nested'}): ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
        this.logLegStatus(leg);
    };

    getMonitorConfig() {
        return null; // never goes through the base's GTT/exitMonitor bracket path - self-monitored
    }

    reset(): void {
        super.reset();
        this.legsByToken.clear();
        this.pendingReEntries.clear();
        this.deferredRootRefill = null;
        this.ordered = false;
    }
}
