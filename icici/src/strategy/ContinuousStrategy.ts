import moment from 'moment';
import Log from '../util/Log';
import { CALL, PUT, MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
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
    entryPrice: number; // E
    quantity: number;
    isRoot: boolean; // true only for T1 and any later refill/restart of T1
    parentLegId: string | null; // null for root legs
    parentLevel: number | null; // 1-4: which slot on the parent this leg occupies; null for root
    childByLevel: Map<number, string>; // level (1-4) -> currently-open child legId (or PENDING while spawning)
    status: 'OPEN' | 'CLOSING';
}

interface PendingReEntry {
    token: string;
    tsym: string;
    exchange: 'NFO' | 'BFO';
    strike: number;
    right: string;
    quantity: number;
    limitPrice: number; // = the original entry price E being re-entered at
}

// ContinuousStrategy - opens a root leg (T1) via BuySellStrategy-style entry
// triggers, then self-monitors every open leg's own price against a target
// and four stacked adverse levels (1x-4x of a configured SL distance, each
// spawning a new opposite-direction leg) plus a 5x square-off. Only the root
// leg is ever refilled/restarted; every spawned (nested) leg closes for good
// on its own target/5x. See spec.md and continuous-strategy-plan.md at the
// repo root for the full design.
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
        this.enabled = true;
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
    private capitalCheck(newQty: number, estimatedPremium: number): boolean {
        const allottedCapital = this.cfg().allottedCapital;
        if (allottedCapital == null) return true; // no cap configured
        let total = 0;
        for (const leg of this.legsByToken.values()) total += leg.quantity * leg.entryPrice;
        for (const pending of this.pendingReEntries.values()) total += pending.quantity * pending.limitPrice;
        total += newQty * estimatedPremium;
        return total <= allottedCapital;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.legsByToken.has(String(quote.token));
    };

    // Momentum-based direction, ANT/Kite-only (no Prism/Shoonya) - mirrors
    // GoodMorningStrategy's computeDirection convention: price above today's
    // prevClose favors calls, below favors puts. Unlike GoodMorningStrategy
    // this never "skips" - ContinuousStrategy retries on the next qualifying
    // tick regardless, so there's no minimum-movement gate here.
    private resolveRight(quote: NiftyQuote): string {
        if (quote.prevClose != null && quote.ltp < quote.prevClose) return PUT;
        return CALL;
    }

    // Real T1 alignment gate, replacing the dead isSentimentAligned(quote, right)
    // base-class check (that one keys off quote.buyQty/sellQty, which ANT ticks
    // never populate, so it always auto-passed). PCR = sum(PE oi)/sum(CE oi) over
    // strikes within PCR_WINDOW_POINTS of spot, from AliceBlue's Option Chain API
    // (routed through OrderClient -> order process, which owns the ANT REST call -
    // see ANT.getOptionChainPCR). PCR > 1 (more put OI) favors PUT, PCR < 1 favors
    // CALL - sentiment-following, matching the buyQty/sellQty convention it replaces.
    // Re-checked at most every PCR_RECHECK_MS; a mismatch (or a fetch failure -
    // fail closed) blocks T1 until the next 5-minute window re-evaluates both the
    // PCR and the momentum direction fresh.
    private async isPcrAligned(quote: NiftyQuote, right: string): Promise<boolean> {
        const now = Date.now();
        if (now - this.lastPcrCheckTime < PCR_RECHECK_MS) {
            this.logGateOnce('pcr check throttled - waiting for next 5-min window');
            return false;
        }
        this.lastPcrCheckTime = now;
        try {
            const pcr = await OrderClient.getInstance().getPCR(this.userId, 'NIFTY', quote.ltp, PCR_WINDOW_POINTS);
            const pcrFavors = pcr > 1 ? PUT : CALL;
            const aligned = pcrFavors === right;
            Log.log(`[ContinuousStrategy] PCR=${pcr.toFixed(3)} favors ${pcrFavors}, momentum favors ${right} -> ${aligned ? 'ALIGNED' : 'NOT aligned'}`);
            return aligned;
        } catch (e) {
            Log.log('[ContinuousStrategy] PCR check failed, blocking T1 (fail-closed):', e);
            return false;
        }
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        this.lastNiftyLtp = quote.ltp;
        const cfg = this.cfg();
        if (!cfg.enabled) { this.logGateOnce('disabled'); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
        if (this.ordered) { this.logGateOnce('already ordered / T1 in flight'); return; }
        if (!this.isCooldownElapsed(cfg.cooldownSeconds ?? 60)) { this.logGateOnce('cooldown not elapsed'); return; }
        this.logGateOnce('all T1 gates clear - attempting entry');

        this.ordered = true;

        let right = cfg.right;
        if (!right || right === 'none') {
            right = this.resolveRight(quote);
        }

        if (!(await this.isPcrAligned(quote, right))) {
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
                if (!this.capitalCheck(initialQuantity, contract.premium)) {
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
                this.legsByToken.set(trade.token, {
                    legId, token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                    right, entryPrice: trade.price, quantity: trade.quantity, isRoot: true,
                    parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN',
                });
                Log.log(`[ContinuousStrategy] T1 entry: ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
                this.recordTriggerTime();
            });
        } catch (e) {
            Log.log('[ContinuousStrategy] T1 entry failed:', e);
            this.ordered = false;
        }
    }

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        const leg = this.legsByToken.get(String(quote.token));
        if (!leg) return;

        const cfg = this.cfg();
        const D = cfg.slDistance;
        const ltp = quote.ltp;

        // Target hit
        if (ltp >= leg.entryPrice + D) {
            this.legsByToken.delete(leg.token); // synchronous, before any await
            try {
                await OrderClient.getInstance().sellContractZerodhaBare(this.userId, leg.tsym, leg.token, leg.quantity, leg.exchange);
            } catch (e) {
                Log.log('[ContinuousStrategy] Target-hit sell failed:', e);
            }
            const pnl = (ltp - leg.entryPrice) * leg.quantity;
            this.recordOutcome('win', pnl);
            Log.log(`[ContinuousStrategy] Target hit (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

            if (leg.isRoot) {
                const intent: PendingReEntry = {
                    token: leg.token, tsym: leg.tsym, exchange: leg.exchange, strike: leg.strike,
                    right: leg.right, quantity: leg.quantity, limitPrice: leg.entryPrice,
                };
                if (this.hasOpenNestedLegs()) {
                    this.deferredRootRefill = intent;
                    Log.log(`[ContinuousStrategy] Root refill deferred (nested legs still open): ${leg.tsym}`);
                } else {
                    await this.placeRootRefill(intent);
                }
            } else {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }
            this.maybeRearmEntry();
            return;
        }

        // Adverse levels (1x-5x), measured from this leg's own entry price
        const adverseMove = leg.entryPrice - ltp;
        if (adverseMove <= 0) return;
        const level = Math.min(5, Math.floor(adverseMove / D));

        if (level >= 1 && level <= 4) {
            if (!leg.childByLevel.has(level)) {
                await this.trySpawnLevel(leg, level);
            }
            return;
        }

        if (level === 5) {
            this.legsByToken.delete(leg.token); // synchronous, before any await
            try {
                await OrderClient.getInstance().sellContractZerodhaBare(this.userId, leg.tsym, leg.token, leg.quantity, leg.exchange);
            } catch (e) {
                Log.log('[ContinuousStrategy] 5x square-off sell failed:', e);
            }
            const pnl = (ltp - leg.entryPrice) * leg.quantity;
            this.recordOutcome('loss', pnl);
            Log.log(`[ContinuousStrategy] 5x square-off (${leg.isRoot ? 'root' : 'nested'}): ${leg.tsym} pnl=${Math.round(pnl)}`);

            if (!leg.isRoot) {
                this.freeParentSlot(leg);
                await this.maybePromoteDeferredRootRefill();
            }
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
                const excludeStrikes = Array.from(this.openStrikesFor(oppositeRight));
                const contract = await OrderClient.getInstance().getContractByPriceRangeZerodha(
                    this.userId, this.lastNiftyLtp, optionType, cfg.minPremium ?? 100, 'NIFTY', excludeStrikes
                );
                if (!this.capitalCheck(spawnQty, contract.premium)) {
                    leg.childByLevel.delete(level); // not sticky - retried on a later qualifying tick
                    if (cfg.logEnabled) Log.log(`[ContinuousStrategy] Level ${level} spawn skipped - would exceed allotted capital`);
                    return;
                }
                // ANT token, not Zerodha's instrumentToken - see the T1 entry comment above.
                const trade: Trade = await OrderClient.getInstance().buyContractZerodhaBare(
                    this.userId, contract.tradingSymbol, String(contract.antToken), spawnQty, contract.exchange, contract.premium
                );
                const childLegId = this.nextLegId();
                this.legsByToken.set(trade.token, {
                    legId: childLegId, token: trade.token, tsym: trade.tsym, strike: contract.strike, exchange: contract.exchange,
                    right: oppositeRight, entryPrice: trade.price, quantity: trade.quantity, isRoot: false,
                    parentLegId: leg.legId, parentLevel: level, childByLevel: new Map(), status: 'OPEN',
                });
                leg.childByLevel.set(level, childLegId);
                Log.log(`[ContinuousStrategy] Level ${level} spawn: ${trade.tsym} qty=${trade.quantity} entry=${trade.price} (parent ${leg.tsym})`);
            });
        } catch (e) {
            leg.childByLevel.delete(level); // spawn failed - free the slot so it can retry
            Log.log(`[ContinuousStrategy] Level ${level} spawn failed:`, e);
        }
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

    private async placeRootRefill(intent: PendingReEntry): Promise<void> {
        try {
            // Locked so this capitalCheck reads a consistent snapshot against
            // any concurrent T1 entry/spawn decision - see opLock's comment.
            // No fresh strike selection here (the refill reuses intent's
            // already-decided contract), but the capital total it checks is
            // shared with those other paths.
            await this.withOpLock(async () => {
                if (!this.capitalCheck(intent.quantity, intent.limitPrice)) {
                    Log.log('[ContinuousStrategy] Root refill deferred - would exceed allotted capital');
                    this.deferredRootRefill = intent;
                    return;
                }
                await OrderClient.getInstance().placeLimitBuyZerodhaBare(
                    this.userId, intent.tsym, intent.token, intent.quantity, intent.limitPrice, intent.exchange
                );
                this.pendingReEntries.set(intent.token, intent);
                Log.log(`[ContinuousStrategy] Root refill placed: ${intent.tsym} qty=${intent.quantity} price=${intent.limitPrice}`);
            });
        } catch (e) {
            Log.log('[ContinuousStrategy] Root refill placement failed:', e);
        }
    }

    private async maybePromoteDeferredRootRefill(): Promise<void> {
        if (!this.deferredRootRefill) return;
        if (this.hasOpenNestedLegs()) return;
        const intent = this.deferredRootRefill;
        this.deferredRootRefill = null;
        Log.log(`[ContinuousStrategy] Promoting deferred root refill: ${intent.tsym}`);
        await this.placeRootRefill(intent);
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
        const legId = this.nextLegId();
        this.legsByToken.set(trade.token, {
            legId, token: trade.token, tsym: intent.tsym, strike: intent.strike, exchange: intent.exchange,
            right: intent.right, entryPrice: trade.price, quantity: trade.quantity, isRoot: true,
            parentLegId: null, parentLevel: null, childByLevel: new Map(), status: 'OPEN',
        });
        Log.log(`[ContinuousStrategy] Root refill filled: ${trade.tsym} qty=${trade.quantity} entry=${trade.price}`);
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
