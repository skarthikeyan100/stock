import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';
import { roundToTick } from '../zerodha/Zerodha';
import MomentumSignal from './MomentumSignal';
import { isPastMarketClose } from '../util/marketHours';
import { LegManager, LegManagerConfig } from './LegManager';
import { antLegOps } from './antLegOps';
import AntContractMaster from '../ant/AntContractMaster';
import { watchToken, unwatchToken } from '../processes/strategies/tokenRouter';

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot

// Minimum gap between resolveEntryRight attempts (PCR option-chain fetch +
// momentum's ATM subscribe/unsubscribe round trip). NiftyQuote ticks arrive
// several times a second, and without this throttle a momentum/PCR
// disagreement (which retries "on the next tick" by design) hammers ANT's
// getOptionChainPCR/OHLC endpoints at that same multi-per-second rate -
// live incident 2026-10-12: ~2-3 attempts/sec for several minutes 429'd
// AliceBlue's OHLC endpoint, which then made the real chunkedBuyIndex entry
// (once PCR/momentum finally agreed) fail outright with the same 429,
// landing the broker position in phase='error' for no reason other than
// this strategy's own call volume.
const ENTRY_ATTEMPT_THROTTLE_MS = 10_000;

// onOrderCancelled's re-placement cap/backoff (live incident 2026-10-15 - see BrokerPosition's
// exitRejectCount comment). A rejection whose broker-supplied reason looks like a margin/
// shortfall problem is never retried at all: it means there's nothing left to sell against
// (e.g. the position was already closed outside the app), and resubmitting the identical
// order will only be rejected identically forever.
// Counts RE-PLACEMENTS after the original (non-retry) placement, not total placements -
// exitRejectCount increments once per rejection and is checked with `>`, so rejections 1-5 each
// still get a retry (5 re-placements total) and rejection 6 is what stops it. "6 total
// placements of this exit" (the original plus 5 retries) is the same behavior described a
// different way, not a bug - flagged twice on review as apparently off-by-one, so spelling it
// out here to save a third look.
const MAX_EXIT_REJECT_RETRIES = 5;
const EXIT_REJECT_RETRY_DELAY_MS = 5000;
// Rejections more than this far apart don't count as the same streak - narrowed on review:
// a bare "insufficient" or "margin" match was broad enough to catch an unrelated transient
// rejection (e.g. a liquidity/order-book message) on its very first occurrence and stop retrying
// forever. Requiring "margin" together with a shortfall/insufficiency word is a closer match to
// the actual broker wording this guards against ("insufficient margin" / "margin shortfall").
// FIX (found on re-review): the first version used `[^a-z]{0,20}` for the gap between the two
// words, which excludes ANY letter - so ordinary English phrasing with connector words in
// between ("Margin is insufficient", "Not enough margin to cover order") never matched at all.
// `.{0,30}` (any character) fixes this; `enough`/`short` added to catch "not enough margin"
// phrasing specifically.
const MARGIN_SHORTFALL_REASON_PATTERN = /margin.{0,30}(shortfall|insufficient|exceed|short)|(?:shortfall|insufficient|exceed|short|enough).{0,30}margin/i;
const EXIT_REJECT_STREAK_RESET_MS = 120_000;

const STATE_COLLECTION = 'bulkPcrStrategyState';

// chunkedBuyIndex/chunkedSquareOffLimit (orderProcess.ts) support all four
// brokers - ant and prism were added alongside BulkPcrAutoStartStrategy
// (the scheduled auto-arm wrapper) to let that wrapper run this strategy
// against ant/prism instead of zerodha/breeze.
type BrokerName = 'zerodha' | 'breeze' | 'ant' | 'prism';

interface BrokerPosition {
    // 'tree' = hand-off to the hedge LegManager tree has happened (or is in the
    // process of happening) - see handOff/hedgeCfg/the file header's hedge-tree note.
    phase: 'buying' | 'selling' | 'error' | 'done' | 'tree';
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
    // True while handOff() is in flight for this broker - set synchronously before
    // any await (race guard: a second concurrent tick must not start a second
    // hand-off). NOT persisted - a restart mid-hand-off is handled by the
    // crash-safety rule in handOff's own comment (phase='selling' vs phase='tree'
    // tells reconcile() which side of the race it landed on), not by this flag.
    adopting?: boolean;
    // Cost basis of the adopted root leg (entryAvg * remaining quantity at the
    // moment of hand-off) - feeds hedgeCfg()'s maxInvestment (root cost +
    // hedgeMaxInvestment budget). Only ever set once, at hand-off.
    rootCost?: number;
    // Consecutive hand-off cancel failures (NOT "already filled" - a genuine cancel
    // failure, retried with backoff). NOT persisted - resets to 0 across a restart,
    // same as exitRejectCount's in-memory-only streak tracking.
    handoffRetryCount?: number;
    // Epoch ms when phase last transitioned to 'selling' - lets reconcile()
    // tell a genuinely still-resting exit apart from one that's certainly
    // gone: every resting sell chunk placed by chunkedSquareOffLimit is a DAY
    // order, which the exchange cancels/expires unfilled at EOD regardless of
    // what this app believes - see reconcile()'s use of this field.
    sellPlacedAt?: number;
    // Consecutive REJECTED re-placements, reset on a non-rejected cancellation or once the gap
    // since the last rejection exceeds EXIT_REJECT_STREAK_RESET_MS. Live incident 2026-10-15: a
    // position that had already been closed manually, outside this app, had its stale resting
    // exit resumed by reconcile() and then re-placed identically on every REJECTED response with
    // no cap - see onOrderCancelled's use of this field.
    //
    // KNOWN LIMITATION (found on review): this counts rejections per BROKER POSITION, not per
    // resting-sell chunk (chunkedSquareOffLimit can split a large exit into several concurrently-
    // resting orders - see Haiku-fixes.md's/ToDo.md's "chunk ownership" gap, which this doesn't
    // solve). A handful of independent, one-off transient rejections spread across different
    // chunks could still add up and trip the cap even though no single chunk failed repeatedly.
    // The time-window reset below (exitLastRejectAt) narrows this - rejections more than
    // EXIT_REJECT_STREAK_RESET_MS apart never accumulate - but doesn't fully solve it for
    // rejections that land close together across different chunks. A real fix needs a stable
    // per-chunk identity threaded through re-placement, which doesn't exist anywhere in this
    // codebase yet.
    exitRejectCount?: number;
    exitLastRejectAt?: number;
}

interface PersistedState {
    positions: Partial<Record<BrokerName, BrokerPosition>>;
}

function isSameCalendarDay(epochMs: number): boolean {
    const a = new Date(epochMs);
    const b = new Date();
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// A resting DAY-validity sell placed today is only still trustworthy as
// "resting" if today's market hasn't closed since it was placed - same
// calendar day alone isn't enough (a restart at, say, 20:00 the same day it
// was placed would otherwise wrongly treat an already-EOD-expired order as
// still resting). See reconcile()'s use of this below.
function isStillWithinSameTradingSession(epochMs: number): boolean {
    return isSameCalendarDay(epochMs) && !isPastMarketClose();
}

// One-shot large block order: buys a total quantity (config `quantity`,
// default 13975 = 215 lots x 65 - or -1, meaning "size it from maxInvestment
// instead of a fixed number": resolveChunkedBuyQuantity/
// resolveMaxInvestmentQuantity in orderProcess.ts/bookkeeping.ts compute the
// largest lot-aligned quantity that fits under `maxInvestment` once that
// broker's option premium is known) of a NIFTY option independently and in
// FULL on every configured broker (config `brokers: [zerodha, breeze]`,
// falling back to a single legacy `broker:` field) - not a split of one
// pooled quantity. One PCR-driven direction decision drives every broker's
// entry; each broker then runs its own entirely independent chunked
// buy -> immediate resting-limit exit -> fill-tracking lifecycle, tracked in
// `positions` (keyed by broker). The whole cycle only durably self-disables
// once EVERY configured broker's position has been fully sold - see
// updateTrade.
//
// Direction: if config `right` is 'call'/'put', use that fixed direction
// directly (no PCR check). If 'none' (default), PCR (put/call OI ratio)
// decides - reuses ContinuousStrategy's exact PCR>1-favors-PUT logic, but
// WITHOUT its PCR_RECHECK_MS/lastPcrCheckTime recheck-throttle, which exists
// there only because it re-evaluates repeatedly all day - this strategy
// fires at most once ever per arming, so a single direct fetch when the
// entry gate first clears is all that's needed. MomentumSignal (ANT
// depth-mode tbq/tsq order-book imbalance on the ATM CALL/PUT) always acts
// as an additional veto ahead of this - no config toggle, unlike
// ContinuousStrategy's optional momentumEnabled, since this strategy places
// a single large one-shot block order and the extra confirmation is worth
// always paying for. PCR still decides direction, but an ACTIVE
// disagreement from momentum blocks the entry for this tick (retried on the
// next one). Momentum unavailable/inconclusive never blocks by itself.
//
// NIFTY's exchange freeze quantity (1755, see NIFTY_FREEZE_QUANTITY in
// constants.ts) caps any single order - each broker's entry buy is placed
// via the shared, broker-agnostic buyChunked helper
// (src/processes/order/chunkedOrder.ts) through the IPC-exposed
// chunkedBuyIndex order-process handler, which splits into
// exchange-compliant chunks automatically and only returns once every chunk
// has filled. Each broker's exit sell is placed the same way via
// squareOffLimitChunked/chunkedSquareOffLimit, as soon as that broker's own
// buy resolves (see placeExitSell below) - as a resting LIMIT sell at that
// broker's own (entryAvg + targetPoints) price, NOT a market order. A blind
// market square-off is what caused the 2026-09-22 loss above (a single
// bad/stale tick falsely read as "target hit" sold straight into a loss,
// since a market order has no price floor); a resting LIMIT order can only
// ever fill at the target price or better, so that failure mode doesn't
// apply here regardless of when it's placed - there is deliberately no
// tick-based "confirm the target first" gate before placing it.
export default class BulkPcrStrategy extends Strategy {
    name = 'BulkPcrStrategy';

    // Outer one-shot reentrancy gate only - every broker's actual progress
    // lives in `positions`, keyed by broker, since brokers advance through
    // buying/selling/error/done entirely independently of each other.
    private phase: 'idle' | 'running' | 'done' = 'idle';
    private positions = new Map<BrokerName, BrokerPosition>();
    private momentum = new MomentumSignal();
    private lastGateLog = new Map<string, number>();
    private lastEntryAttemptTime = 0;
    // Most recent NIFTY tick seen by processNiftyQuote. enterOnBroker's one-shot retry reads
    // this (not the stale quote captured at the first attempt) so the direction and LTP it
    // re-resolves against are current.
    private lastNiftyQuote: NiftyQuote | null = null;

    // Hedge tree infrastructure (see file header's "hedge tree" note and handOff below).
    // v1 only supports a single 'ant' broker for hedging - see hedgeCfg's startup guard.
    // Private LegManager, NOT ContinuousStrategy - ContinuousStrategy has its own T1 entry
    // gating this strategy doesn't want, and its LegManager wiring defaults to the
    // Zerodha/Breeze-only 'Bare' IPCs, which can't route BulkPcr's ANT-held root. `ops:
    // antLegOps` is what makes this instance trade the tree on ANT instead.
    private legManager: LegManager = new LegManager({
        userId: this.userId,
        ownerType: 'BulkPcrStrategy',
        strategyRef: this,
        getConfig: () => this.hedgeCfg(),
        getLastUnderlyingLtp: () => this.lastNiftyQuote?.ltp ?? 0,
        // BulkPcrStrategy keeps no realized P&L of its own distinct from a broker
        // position's soldValue/soldQty bookkeeping - log only.
        recordOutcome: (outcome, pnl) => Log.log(`[BulkPcrStrategy] hedge leg outcome: ${outcome} pnl=${Math.round(pnl)}`),
        ops: antLegOps,
        // Deliberately NOT resolved eagerly here (`this.hedgeCfg().hedgeDryRun` at
        // construction time): dryRun lives inside LegManagerConfig itself (see
        // hedgeCfg below) and LegManager reads it live via getConfig() on every op,
        // so toggling hedgeDryRun in config.yml takes effect on the next tick, not
        // only on the next restart. Also sidesteps a field-initializer-order trap:
        // calling this.hedgeCfg() here (before hedgeLoggedMultiBrokerWarning's own
        // field initializer below has run) would get its one-time ALERT dedupe
        // flag clobbered back to false immediately after.
        onSpawnBuyError: (e: any) => {
            const message = typeof e?.message === 'string' ? e.message : String(e);
            if (message.includes('[HEDGE_UNCONFIRMED]')) this.treeError = true;
        },
    });
    // Set when a hedge-tree buy's fill confirmation is lost (order may still be live at
    // the broker - never safe to retry). Once set, the tree stops spawning new levels and
    // logs loudly on every tick until a human resolves it - see processOptionQuote.
    private treeError = false;
    // EOD force-close one-shot guard for an open hedge tree - see processNiftyQuote.
    private eodDone = false;

    receive(oldStats, newStats) {}

    // LegManagerConfig derived from config.yml's BulkPcrStrategy block, plus the
    // dynamic maxInvestment budget (root cost at the moment of hand-off +
    // hedgeMaxInvestment) and refillEnabled: false (ANT's buyLimit bare op isn't
    // wired up - see antLegOps.ts's buyLimit).
    private hedgeLoggedMultiBrokerWarning = false;

    private hedgeCfg(): LegManagerConfig & { hedgeEnabled: boolean; hedgeDryRun: boolean } {
        const cfg = this.cfg();
        const rootCost = this.positions.get('ant')?.rootCost ?? 0;
        // v1 only supports a single 'ant' broker for hedging (antLegOps.ts is ANT-only,
        // and hedge hand-off is keyed off this.positions.get('ant') throughout) - force
        // hedgeEnabled false rather than hedge only the 'ant' leg of a multi-broker
        // config while silently leaving other brokers' positions unhedged.
        const brokers = this.configuredBrokers();
        const multiBrokerConfigured = !(brokers.length === 1 && brokers[0] === 'ant');
        if (cfg.hedgeEnabled === true && multiBrokerConfigured && !this.hedgeLoggedMultiBrokerWarning) {
            this.hedgeLoggedMultiBrokerWarning = true;
            Log.log(`[BulkPcrStrategy] ALERT: hedgeEnabled is true but brokers=[${brokers.join(', ')}] is not just ['ant'] - hedging is ANT-only (v1); forcing hedgeEnabled: false`);
        }
        return {
            hedgeEnabled: cfg.hedgeEnabled === true && !multiBrokerConfigured,
            hedgeDryRun: cfg.hedgeDryRun === true,
            slDistance: cfg.slDistance ?? 10,
            squareOffDistance: cfg.squareOffDistance ?? 50,
            maxLevels: cfg.maxLevels ?? 4,
            hedgeStartLevel: cfg.hedgeStartLevel ?? 1,
            spawnQuantityMode: cfg.spawnQuantityMode ?? '1',
            averageQuantityMode: cfg.averageQuantityMode ?? 'same',
            postAverageTargetDistance: cfg.postAverageTargetDistance ?? 1,
            minPremium: cfg.minPremium ?? 100,
            maxInvestment: rootCost + (cfg.hedgeMaxInvestment ?? 100000),
            refillEnabled: false,
            // Read live by LegManager.currentOps() on every op - see LegManagerConfig.dryRun's comment.
            dryRun: cfg.hedgeDryRun === true,
        };
    }

    // Not configService.getStrategyConfig(type) - that returns only the FIRST
    // config.yml entry of this type, regardless of userId. config.yml can
    // configure multiple instances of this strategy under distinct userId
    // values, and each instance must read its OWN block, not silently inherit
    // whichever instance's block happens to be listed first. Same (cfg.userId
    // || type) === userId convention exitMonitor.ts's isSelfManagedTradeUser
    // and durablyDisable below already use for the identical type-vs-instance
    // distinction.
    private cfg() {
        return configService.getConfig().strategies?.find(
            (s) => s.type === 'BulkPcrStrategy' && (s.userId || s.type) === this.userId
        ) ?? { type: 'BulkPcrStrategy', enabled: false };
    }

    // `brokers: [zerodha, breeze]` (new, multi-broker) takes priority when
    // present and non-empty; falls back to the legacy single `broker:`
    // field (defaulting to zerodha) for backward compatibility. Deduped and
    // lowercased so a config typo/duplicate can't silently double-run a
    // broker.
    private configuredBrokers(): BrokerName[] {
        const cfg = this.cfg();
        const list: string[] = Array.isArray(cfg.brokers) && cfg.brokers.length > 0 ? cfg.brokers : [cfg.broker ?? 'zerodha'];
        return Array.from(new Set(list.map((b: string) => String(b).toLowerCase()))) as BrokerName[];
    }

    // Throttled gate-visibility logging, same shape as ContinuousStrategy's
    // logGateOnce - low-value here since this strategy only ever transitions
    // through its phases once, but keeps the "why isn't it firing" question
    // answerable from orchestrator.log the same way as every other strategy.
    private logGateOnce(reason: string): void {
        const now = Date.now();
        const last = this.lastGateLog.get(reason) ?? 0;
        if (now - last < 5 * 60 * 1000) return;
        this.lastGateLog.set(reason, now);
        Log.log(`[BulkPcrStrategy] gate: ${reason}`);
    }

    // Persists one BrokerPosition per configured broker, keyed by broker -
    // lets reconcile() tell 'selling' (a limit-sell exit is already resting
    // at that broker - re-placing it on restart would risk a SECOND exit for
    // the same quantity) apart from 'error' (something failed and needs
    // manual review - re-placing an exit automatically on restart would be
    // just as wrong, whether the failure was a partial buy or a
    // partial/failed sell) on a PER-BROKER basis - one broker can be resting
    // fine while a different broker sits in 'error' needing manual review.
    // Fire-and-forget, same convention as bookkeeping's own Mongo writes
    // elsewhere.
    private persistState(): void {
        const positions: Partial<Record<BrokerName, BrokerPosition>> = {};
        for (const [broker, pos] of this.positions) positions[broker] = pos;
        Mongo.getInstance()?.db.collection(STATE_COLLECTION)
            .replaceOne(
                { userId: this.userId },
                { userId: this.userId, positions },
                { upsert: true }
            )
            .catch((e) => Log.log('[BulkPcrStrategy] persistState failed:', e));
    }

    private async loadState(): Promise<PersistedState | null> {
        try {
            const doc = await Mongo.getInstance()?.db.collection(STATE_COLLECTION).findOne({ userId: this.userId });
            return (doc as any) ?? null;
        } catch (e) {
            Log.log('[BulkPcrStrategy] loadState failed:', e);
            return null;
        }
    }

    // See file header for the momentum-veto rationale.
    private static readonly MOMENTUM_TIMEOUT_MS = 3000;

    private async resolveEntryRight(quote: NiftyQuote, configuredRight?: string): Promise<string | null> {
        if (configuredRight && configuredRight !== 'none') return configuredRight; // explicit direction - skip PCR entirely
        try {
            const pcr = await OrderClient.getInstance().getPCR(this.userId, 'NIFTY', quote.ltp, PCR_WINDOW_POINTS);
            const pcrFavors = pcr > 1 ? PUT : CALL;
            Log.log(`[BulkPcrStrategy] PCR=${pcr.toFixed(3)} -> resolved direction ${pcrFavors}`);

            const momentumFavors = await this.momentum.getDirection(this, quote.ltp, BulkPcrStrategy.MOMENTUM_TIMEOUT_MS);
            if (momentumFavors != null && momentumFavors !== pcrFavors) {
                Log.log(`[BulkPcrStrategy] Momentum (${momentumFavors}) disagrees with PCR (${pcrFavors}) - blocking entry this window`);
                return null;
            }
            return pcrFavors;
        } catch (e) {
            Log.log('[BulkPcrStrategy] PCR check failed, blocking entry (fail-closed):', e);
            return null;
        }
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        this.lastNiftyQuote = quote;

        // EOD force-close for an open hedge tree - checked before the phase==='idle'
        // gate below, since by the time a tree exists the outer phase is already
        // 'running' (set once any broker's entry starts) and would otherwise return
        // before this ever runs. One-shot per day via eodDone; a NIFTY tick after
        // 15:15 is frequent enough that this doesn't need its own interval poll.
        const antPos = this.positions.get('ant');
        if (antPos?.phase === 'tree' && !this.eodDone) {
            const now = new Date();
            const pastEodCutoff = now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 15);
            if (pastEodCutoff) {
                this.eodDone = true;
                Log.log('[BulkPcrStrategy] EOD cutoff reached with an open hedge tree - force-closing all legs');
                await this.legManager.closeAll();
            }
        }

        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (this.phase !== 'idle') { this.logGateOnce(`entry already in progress or done (phase=${this.phase})`); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }

        const now = Date.now();
        if (now - this.lastEntryAttemptTime < ENTRY_ATTEMPT_THROTTLE_MS) return; // see ENTRY_ATTEMPT_THROTTLE_MS comment
        this.lastEntryAttemptTime = now;

        this.logGateOnce('gates clear - attempting entry');

        // Reentrancy guard set synchronously here, BEFORE the PCR/momentum
        // resolution below awaits - resolveEntryRight makes async IPC calls,
        // and a second tick arriving during that gap would otherwise still
        // see phase='idle' (this used to be set only after the await, which
        // let concurrent ticks race past the idle-check together and each
        // launch their own chunkedBuyIndex call - observed live 2026-09-21,
        // caused multiple duplicate block buys before Breeze's own rate
        // limit accidentally capped the damage).
        this.phase = 'running';

        const cfg = this.cfg();
        const configuredRight = cfg.right && cfg.right !== 'none' ? cfg.right : undefined;
        const right = await this.resolveEntryRight(quote, configuredRight);
        if (right == null) { this.phase = 'idle'; return; } // retried on the next tick

        const quantity = cfg.quantity ?? 13975;
        const brokers = this.configuredBrokers();
        Log.log(`[BulkPcrStrategy] Entering ${right} qty=${quantity} independently on: ${brokers.join(', ')}`);

        // allSettled, not all - one broker's entry failing must not abort a
        // different broker's already-in-flight buy. Each broker's own
        // success/failure is handled entirely inside enterOnBroker.
        await Promise.allSettled(brokers.map((broker) => this.enterOnBroker(broker, right, quantity, quote.ltp)));
    }

    // One broker's entire entry: buy the full configured quantity on this
    // broker only, then immediately place this broker's own resting exit
    // sell. Independent of every other broker's own enterOnBroker call -
    // failure here only marks THIS broker's position 'error', never touches
    // another broker's state.
    //
    // Note: bookkeeping's investment/lot caps (canPlaceOrder) are per-USER,
    // not per-broker, and this.userId is the same across every concurrent
    // call here - so with 2+ brokers configured, `maxInvestment` is a
    // COMBINED cap across all of them, not a per-broker one. Size it for the
    // full combined exposure, or a later broker's chunkedBuyIndex call can
    // legitimately get rejected on "max investment" purely because an
    // earlier one already reserved its own share of the same cap - this is
    // the capital gate working as designed, not a bug, but easy to be
    // surprised by if `maxInvestment` was only ever sized for one broker.
    // With `quantity: -1` this gets sharper: each broker's chunkedBuyIndex
    // independently computes "max quantity for the FULL maxInvestment" (see
    // bookkeeping.resolveMaxInvestmentQuantity), so 2+ concurrently-entering
    // brokers can together request well over maxInvestment before either's
    // fill lands and reduces the other's headroom - see that method's
    // comment. Only safe today because config.yml's `brokers` list is a
    // single entry.
    private async enterOnBroker(broker: BrokerName, right: string, quantity: number, niftyLtp: number, isRetry: boolean = false): Promise<void> {
        this.positions.set(broker, {
            phase: 'buying',
            heldTsym: null,
            heldToken: null,
            entryAvg: 0,
            targetQuantity: 0,
            soldQty: 0,
            soldValue: 0,
        });

        try {
            const chunkDriftCancelPoints = this.cfg().chunkDriftCancelPoints ?? 10;
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, { right, quantity, niftyLtp, broker, driftCancelPoints: chunkDriftCancelPoints });
            const pos = this.positions.get(broker)!;
            pos.heldTsym = result.tsym;
            pos.heldToken = String(result.token);
            pos.entryAvg = result.avgPrice;
            Log.log(`[BulkPcrStrategy] [${broker}] Entry complete: ${pos.heldTsym} qty=${result.quantity} avg=${pos.entryAvg}`);
            await this.placeExitSell(broker, result.quantity);
        } catch (e: any) {
            // Distinguish "nothing was bought" from a real broker-order-level problem, and
            // auto-retry only the former - a persistent/ambiguous failure still needs the same
            // manual review as before. Two safe-to-retry shapes seen live, both meaning no
            // broker order resulted in any fill at all:
            //  - sizing/pricing failed before any order was placed at all
            //    (resolveChunkedBuyQuantity, orderProcess.ts - this exact message, thrown
            //    BEFORE placeOrderWithPendingGuard ever runs) - live incident 2026-10-15, an
            //    ANT OHLC 429 outlasted the sizing quote's retry budget.
            //  - an order WAS placed but resolveUnconfirmedAntBuy (antExecutor.ts) cancelled it
            //    and confirmed via the trade book that it filled 0 - buyChunked (chunkedOrder.ts)
            //    wraps this as "failed after filling 0/<requested>" - live incident 2026-10-15,
            //    the 12:35 slot's order never got a fill before the order-notify AND REST-fallback
            //    polls both timed out, and was genuinely unfilled when cancelled.
            // Explicitly EXCLUDED: resolveUnconfirmedAntBuy's own ambiguous-outcome throws all
            // contain "fill status unresolved" (cancel failed, bracket/cover parent left
            // untouched, trade-book read failed, etc.) - those must stay a hard stop, and so must
            // any partial fill ("failed after filling N/<requested>" with N>0 - there's a real,
            // unmonitored position at stake then, not nothing). One retry only (isRetry).
            const message = typeof e?.message === 'string' ? e.message : '';
            const ambiguousOutcome = message.includes('fill status unresolved');
            const nothingWasBought = !ambiguousOutcome && (
                message.includes('no available investment headroom to size an order from')
                || /failed after filling 0\//.test(message)
            );
            if (nothingWasBought && !isRetry) {
                Log.log(`[BulkPcrStrategy] [${broker}] Chunked entry failed with nothing bought - retrying once in 10s: ${message || e}`);
                await new Promise((resolve) => setTimeout(resolve, 10000));
                // The first attempt's PCR read and LTP are stale by now (the order-notify wait,
                // cancel and 10s sleep can be ~2 min). Re-resolve direction and use the latest
                // tick's LTP. Proceed with whatever direction is confirmed now, even if it
                // differs from the original - the first order was confirmed cancelled-unfilled,
                // so there is no position in the old direction to unwind.
                const latest = this.lastNiftyQuote;
                const retryRight = latest ? await this.resolveEntryRight(latest, this.cfg().right !== 'none' ? this.cfg().right : undefined) : null;
                if (latest == null || retryRight == null) {
                    Log.log(`[BulkPcrStrategy] [${broker}] Retry aborted: no confirmed direction on re-resolution - manual review required`);
                    const pos = this.positions.get(broker);
                    if (pos) pos.phase = 'error';
                    this.persistState();
                    return;
                }
                if (retryRight !== right) {
                    Log.log(`[BulkPcrStrategy] [${broker}] Direction changed on retry: ${right} -> ${retryRight}`);
                }
                await this.enterOnBroker(broker, retryRight, quantity, latest.ltp, true);
                return;
            }
            Log.log(`[BulkPcrStrategy] [${broker}] Chunked entry failed - manual review required:`, e);
            const pos = this.positions.get(broker);
            if (pos) pos.phase = 'error';
            this.persistState(); // so reconcile() on restart knows this broker needs manual review, not an auto-placed exit
        }
    }

    // Shared logic for placing a resting limit exit sell at the strategy's target
    // price. Factored out so both placeExitSell and onOrderCancelled use the same
    // price-rounding/chunking code without duplication.
    private async placeExitSellAtTargetPrice(broker: BrokerName, quantity: number, resetProgress: boolean = true): Promise<void> {
        const pos = this.positions.get(broker);
        if (!pos) return; // defensive - should always exist by the time this is called

        const cfg = this.cfg();
        const targetPoints = cfg.targetPoints ?? 2;
        // entryAvg is a multi-chunk weighted average (buyChunked's
        // filledValue/filledQty) and essentially never lands on an exact
        // multiple of NFO's 0.05 tick size, so entryAvg + targetPoints must
        // be rounded before it's used as an order price - confirmed live
        // 2026-09-23: an unrounded price was REJECTED by Zerodha on all 8
        // resting sell chunks, leaving the full position with no exit order
        // at all. Same helper zerodhaExecutor.ts/antExecutor.ts already use
        // for this.
        const targetPrice = roundToTick(pos.entryAvg + targetPoints);

        if (resetProgress) {
            // First-time placement: reset progress counters
            pos.soldQty = 0;
            pos.soldValue = 0;
            pos.targetQuantity = quantity;
        }
        // Cancellation re-placement: keep soldQty/soldValue/targetQuantity untouched,
        // just re-place the chunk that was orphaned by cancellation

        pos.phase = 'selling'; // synchronous, before any await
        pos.sellPlacedAt = Date.now();
        Log.log(`[BulkPcrStrategy] [${broker}] Placing resting limit sell for ${pos.heldTsym} qty=${quantity} @ ${targetPrice}`);
        this.persistState();

        try {
            // Resting LIMIT sell at the target price, not a market order -
            // either fills at (at least) the intended profit, or doesn't
            // fill at all if the market never actually gets there. See the
            // file header comment for why this replaced a blind market
            // square-off. Returns once the chunks are placed, not once
            // filled; completion is handled in updateTrade below as fills
            // arrive asynchronously.
            await OrderClient.getInstance().chunkedSquareOffLimit(this.userId, {
                tsym: pos.heldTsym!,
                instrumentId: pos.heldToken!,
                quantity,
                price: targetPrice,
                broker,
            });
            Log.log(`[BulkPcrStrategy] [${broker}] Limit sell chunks resting for ${pos.heldTsym} @ ${targetPrice} - waiting for fills`);
            // Watch the held token so its option ticks reach processOptionQuote's
            // slDistance check below - without this, a hedge-eligible position's
            // adverse move is never observed (tokenRouter only routes ticks for
            // watched/registered tokens). Only needed when hedging is actually
            // configured, and only for 'ant' (hedgeCfg's v1 single-broker guard).
            if (broker === 'ant' && this.hedgeCfg().hedgeEnabled && pos.heldToken) {
                watchToken(pos.heldToken, this);
            }
        } catch (e) {
            Log.log(`[BulkPcrStrategy] [${broker}] Chunked limit-sell placement failed - manual review required:`, e);
            pos.phase = 'error';
            this.persistState();
        }
    }

    // Places broker's resting LIMIT exit sell immediately once `quantity`
    // (that broker's full held position) is confirmed bought - no live-tick
    // "confirm the target first" gate (see file header comment for why one
    // isn't needed here). Called both from enterOnBroker above and from
    // reconcile() below when a restart lands between "buy filled" and "sell
    // placed" for a given broker.
    private async placeExitSell(broker: BrokerName, quantity: number): Promise<void> {
        await this.placeExitSellAtTargetPrice(broker, quantity, true);
    }

    // Momentum-only tick consumer PLUS (when hedgeEnabled) the hedge tree's own
    // LegManager-tracked tokens, and the held ANT root's own token while it's
    // resting on its +2 sell (needed to observe the slDistance adverse-move
    // trigger that starts a hand-off). Mirrors ContinuousStrategy's momentum
    // wiring, extended for the hedge tree - see file header's hedge-tree note.
    canHandleOptionQuote(quote: OptionQuote): boolean {
        const token = String(quote.token);
        if (this.momentum.isTracking(token)) return true;
        if (this.legManager.canHandle(token)) return true;
        const pos = this.positions.get('ant');
        return !!pos && pos.phase === 'selling' && !pos.adopting && pos.heldToken === token && this.hedgeCfg().hedgeEnabled;
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        const token = String(quote.token);
        if (this.momentum.isTracking(token)) {
            this.momentum.onTick(quote);
            return;
        }
        if (!this.hedgeCfg().hedgeEnabled) return;
        const pos = this.positions.get('ant');
        if (!pos) return;
        if (pos.phase === 'tree') {
            if (this.treeError) {
                Log.log('[BulkPcrStrategy] ALERT: hedge buy unconfirmed on a previous spawn - manual review required, not spawning further');
                return;
            }
            await this.legManager.onOptionTick(token, quote.ltp);
            if (this.legManager.isIdle()) this.durablyDisable('hedge tree closed');
            return;
        }
        if (pos.phase === 'selling' && !pos.adopting && token === pos.heldToken
            && quote.ltp <= pos.entryAvg - this.hedgeCfg().slDistance) {
            await this.handOff('ant');
        }
    }

    // Hands the ANT root position off to the hedge LegManager tree once it moves
    // slDistance points against entry - cancels the resting +2 exit sell, adopts
    // whatever quantity is confirmed still open as the tree's root leg, and from
    // then on the tree (not the simple +2 sell) owns this position's exit. Steps
    // run in this exact order for crash-safety - see each step's comment.
    private async handOff(broker: BrokerName): Promise<void> {
        const pos = this.positions.get(broker);
        if (!pos) return;
        // 1. Race guard, synchronous, before any await - a second concurrent tick
        // (or a second slDistance-crossing tick arriving before this resolves)
        // must not start a second hand-off.
        if (pos.adopting) return;
        pos.adopting = true;

        try {
            const hedgeDryRun = this.hedgeCfg().hedgeDryRun;
            // 2. Cancel the resting +2 exit sell before adopting anything - the tree's
            // own onOptionTick (slDistance/square-off/target) becomes the sole exit
            // from here on; a stray fill of the old +2 sell during/after adoption
            // would silently reduce the tree's root quantity out from under it.
            let filledQty = 0;
            if (hedgeDryRun) {
                Log.log(`[BulkPcrStrategy] [${broker}] [DRYRUN] would cancel resting sell for ${pos.heldTsym}`);
            } else {
                const r = await OrderClient.getInstance().cancelRestingLimitSells(this.userId, { tsym: pos.heldTsym! });
                if (r.cancelFailed) {
                    // 3. Cancel failed for a reason other than "already filled" - the resting
                    // sell's true state is unknown. Never adopt on this outcome (see
                    // antLegOps.ts/LegBrokerOps.ts's header for why a naked, un-exited
                    // position is worse than a late hand-off). Retry with backoff, capped.
                    pos.adopting = false;
                    pos.handoffRetryCount = (pos.handoffRetryCount ?? 0) + 1;
                    const MAX_HANDOFF_RETRIES = 5;
                    if (pos.handoffRetryCount > MAX_HANDOFF_RETRIES) {
                        Log.log(`[BulkPcrStrategy] [${broker}] Hand-off cancel failed ${pos.handoffRetryCount} times in a row for ${pos.heldTsym} - giving up, manual review required`);
                        return;
                    }
                    Log.log(`[BulkPcrStrategy] [${broker}] Hand-off: cancel of resting sell failed for ${pos.heldTsym} (attempt ${pos.handoffRetryCount}/${MAX_HANDOFF_RETRIES}) - retrying in 10s`);
                    setTimeout(() => {
                        this.handOff(broker).catch((e) => Log.log(`[BulkPcrStrategy] [${broker}] Hand-off retry failed:`, e));
                    }, 10_000);
                    return;
                }
                pos.handoffRetryCount = 0;
                filledQty = r.filledQty;
            }

            // 4. The exit may have completed during the cancel race (fully filled
            // before/while it was being cancelled) - nothing left to adopt.
            const remaining = pos.targetQuantity - filledQty;
            if (remaining <= 0) {
                pos.adopting = false;
                Log.log(`[BulkPcrStrategy] [${broker}] Hand-off: exit completed during the cancel race for ${pos.heldTsym} - nothing to adopt`);
                return;
            }

            // 5. Persist phase='tree' BEFORE adopting (crash-safety rule - see the comment
            // on BrokerPosition.phase and reconcile()'s 'tree' branch): a crash after this
            // point restores from open trades (the root is still open at the broker,
            // reconcile's 'tree' branch calls legManager.restoreFromOpenTrades); a crash
            // BEFORE this point leaves phase='selling', so reconcile() re-places the exit
            // sell as it already does today.
            pos.phase = 'tree';
            pos.rootCost = pos.entryAvg * remaining;
            this.persistState();

            // 6. Adopt the remainder as the tree's root leg.
            const m = AntContractMaster.getInstance().findByToken(pos.heldToken!);
            const right = m?.optionType === 'PE' ? PUT : CALL;
            try {
                await this.legManager.adoptRootLeg({
                    tsym: pos.heldTsym!, token: pos.heldToken!, strike: m?.strike ?? 0, exchange: 'NFO',
                    right, entryPrice: pos.entryAvg, quantity: remaining,
                });
            } catch (e) {
                // Revert: the exit sell is no longer resting (cancelled in step 2) and
                // nothing adopted it, so the position must get a fresh exit sell to stay
                // protected - re-placing it also flips phase back to 'selling'.
                pos.phase = 'selling';
                pos.adopting = false;
                this.persistState();
                Log.log(`[BulkPcrStrategy] [${broker}] ALERT: adoptRootLeg failed for ${pos.heldTsym} - re-placing exit sell:`, e);
                await this.placeExitSellAtTargetPrice(broker, remaining, false);
                return;
            }

            pos.adopting = false;
            Log.log(`[BulkPcrStrategy] [${broker}] Hand-off: adopted root ${pos.heldTsym} qty=${remaining} entry=${pos.entryAvg}`);
        } catch (e) {
            pos.adopting = false;
            Log.log(`[BulkPcrStrategy] [${broker}] Hand-off failed unexpectedly for ${pos.heldTsym}:`, e);
        }
    }


    // Fills for a broker's exit round-trip back here asynchronously, one
    // chunk at a time, potentially far apart - a resting limit sell only
    // fills once the market actually reaches the target price, unlike the
    // old synchronous market-order exit this replaced. Accumulates until
    // that broker's full sold quantity is confirmed, then - only once EVERY
    // configured broker has independently reached that same point - runs the
    // completion (durable self-disable) logic that used to run
    // unconditionally right after a single chunkedSquareOff returned.
    updateTrade = async (trade: Trade): Promise<void> => {
        const broker = trade.broker as BrokerName | undefined;
        if (!broker) return; // untagged fill - can't attribute to a broker position, ignore defensively
        const pos = this.positions.get(broker);
        if (!pos) return;

        if (pos.phase === 'tree' && broker === 'ant') {
            await this.legManager.handleFillOrExternalSell(trade);
            if (this.legManager.isIdle()) this.durablyDisable('hedge tree closed');
            return;
        }

        if (pos.phase !== 'selling') return;
        if (trade.action !== 'Sell' || trade.tsym !== pos.heldTsym) return;

        pos.soldQty += trade.quantity;
        pos.soldValue += trade.quantity * trade.price;
        Log.log(`[BulkPcrStrategy] [${broker}] Exit fill: ${trade.tsym} qty=${trade.quantity} @ ${trade.price} (sold ${pos.soldQty}/${pos.targetQuantity})`);
        this.persistState();
        if (pos.soldQty < pos.targetQuantity) return; // more chunks still resting for this broker

        const avgExit = pos.soldValue / pos.soldQty;
        pos.phase = 'done';
        Log.log(`[BulkPcrStrategy] [${broker}] Exit complete: ${pos.heldTsym} qty=${pos.soldQty} avgExit=${avgExit}`);
        this.persistState();

        const brokers = this.configuredBrokers();
        const allDone = brokers.every((b) => this.positions.get(b)?.phase === 'done');
        if (!allDone) return; // other broker(s) still buying/selling/erroring - wait for them

        this.durablyDisable('Cycle complete on every configured broker');
    };

    // Durable self-disable - mirrors GoodMorningStrategy.ts's exact pattern
    // (configService.writeConfig), since an in-memory-only this.enabled = false
    // would be silently overwritten back to config.yml's static enabled: true
    // on the next restart (StrategyFactory.createStrategy always does
    // strategy.enabled = config.enabled after construction). Shared by
    // updateTrade (every broker's exit filled normally) and reconcile (a
    // restart discovers every broker was already fully closed at the broker -
    // see reconcile's 2026-10-15 bug-fix comment: without this, a position
    // closed outside the app left this.phase stuck at 'running' forever,
    // since nothing else would ever flip it to 'done').
    private durablyDisable(reason: string): void {
        // Found on review: reconcile()'s own allBrokersDone check and updateTrade's allDone check
        // can both observe "every broker done" and both call this - reconcile() awaits network
        // calls per broker with nothing excluding a fill notification from landing mid-loop. Both
        // calls were already idempotent (same end state either way), but this guard skips the
        // redundant config write and avoids a second, confusing "already fully closed at the
        // broker on restart" log line for what was actually just a normal fill.
        if (this.phase === 'done') return;
        // Unwatch the ANT position's held token - a no-op if it was never watched
        // (hedging disabled, or this call isn't the hedge-tree completion path).
        const antPos = this.positions.get('ant');
        if (antPos?.heldToken) unwatchToken(antPos.heldToken, this);
        const liveCfg = configService.getStrategyConfig('BulkPcrStrategy');
        liveCfg.enabled = false;
        configService.writeConfig(configService.getConfig());
        this.enabled = false; // stop in-memory immediately too - config.yml only gets re-read on next restart
        this.phase = 'done';
        Log.log(`[BulkPcrStrategy] ${reason} - durably disabled. Flip enabled: true in config.yml manually to arm another run.`);
    }

    // Called when a resting limit order (e.g. an exit sell) is cancelled/rejected,
    // typically because a DAY-validity order expires unfilled at end of session.
    // Re-places a resting sell for the cancelled quantity at the same target price,
    // without disturbing already-filled or still-resting chunks.
    onOrderCancelled = async (notification: any): Promise<void> => {
        const broker = notification.broker as BrokerName | undefined;
        if (!broker) return;
        const pos = this.positions.get(broker);

        // Ignore if this notification doesn't match an open/selling position we care about.
        if (!pos || pos.phase !== 'selling' || pos.heldTsym !== notification.tradingSymbol) {
            return;
        }

        const rejectReason: string | undefined = notification.rejectReason;
        if (notification.reason === 'REJECTED') {
            const now = Date.now();
            // Found on review: a streak of well-separated, one-off rejections (e.g. from
            // different resting chunks, each failing for its own unrelated transient reason)
            // must not accumulate toward the cap the same way a tight, genuinely-stuck loop
            // would (the actual 2026-10-15 incident: 4 rejections in under 30s). Reset the
            // streak if the gap since the last rejection is too large to plausibly be the same
            // problem - see BrokerPosition.exitRejectCount's comment for the remaining gap this
            // doesn't fully close (no per-chunk identity exists to solve it precisely).
            const withinStreak = pos.exitLastRejectAt != null && now - pos.exitLastRejectAt <= EXIT_REJECT_STREAK_RESET_MS;
            pos.exitRejectCount = (withinStreak ? pos.exitRejectCount ?? 0 : 0) + 1;
            pos.exitLastRejectAt = now;

            if (rejectReason && MARGIN_SHORTFALL_REASON_PATTERN.test(rejectReason)) {
                // A margin/shortfall rejection means there's nothing left to sell against -
                // most likely the position was already closed outside the app (see the
                // 2026-10-15 incident this guards against). Retrying would just repeat the
                // same rejection forever.
                Log.log(`[BulkPcrStrategy] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED (${rejectReason}) - looks like a margin/shortfall rejection, likely because the position is already closed at the broker. NOT re-placing - manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }

            if (pos.exitRejectCount > MAX_EXIT_REJECT_RETRIES) {
                Log.log(`[BulkPcrStrategy] [${broker}] Exit sell for ${notification.tradingSymbol} REJECTED ${pos.exitRejectCount} times in a row (${rejectReason ?? 'no reason given'}) - giving up on auto re-placement. Manual review required.`);
                pos.phase = 'error';
                this.persistState();
                return;
            }
        } else {
            pos.exitRejectCount = 0; // a plain (non-rejected) cancellation, e.g. EOD expiry - not a rejection streak
            pos.exitLastRejectAt = undefined;
        }

        Log.log(`[BulkPcrStrategy] [${broker}] Order cancelled: ${notification.tradingSymbol} qty=${notification.quantity} (${notification.reason}${rejectReason ? `: ${rejectReason}` : ''}) - re-placing resting sell`);
        if ((pos.exitRejectCount ?? 0) > 1) {
            // Back off before resubmitting a repeat rejection, instead of tight-looping
            // identical orders (2026-10-15: 4 resubmissions in under 30s with no delay).
            await new Promise((resolve) => setTimeout(resolve, EXIT_REJECT_RETRY_DELAY_MS));
        }
        await this.placeExitSellAtTargetPrice(broker, notification.quantity, false);
    };

    getMonitorConfig() {
        return null; // self-monitored, no GTT/bracket - Breeze doesn't support them anyway
    }

    // Restart-safety: without this, a restart mid-cycle would reset phase to
    // 'idle' in memory and could fire a SECOND live block buy on the next
    // PCR-aligned tick. Runs independently per configured broker - one
    // broker can be resting fine while a different broker sits in 'error'
    // needing manual review, or a third was never even attempted yet.
    // Mirrors ContinuousStrategy.reconcile()'s retry shape.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        const persisted = await this.loadState();
        const brokers = this.configuredBrokers();
        let anyRestored = false;

        // getOpenTrades(userId) returns the SAME full list regardless of
        // which broker is asking (bookkeeping.trades filtered by user only,
        // each entry separately tagged with its own broker) - fetched at
        // most once, lazily, the first time any broker actually needs it
        // below, and reused for every other broker that also needs it.
        // Avoids both a redundant IPC round-trip per broker and (more
        // importantly) doubling the worst-case retry-exhaustion latency if
        // the order-process IPC channel is down at startup - a query that's
        // already proven to fail 15 times for broker A tells us nothing new
        // by failing 15 more times for broker B.
        let openTradesFetch: Promise<any[] | undefined> | null = null;
        const getOpenTradesOnce = (): Promise<any[] | undefined> => {
            if (!openTradesFetch) {
                openTradesFetch = (async () => {
                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        try {
                            return await OrderClient.getInstance().getOpenTrades(this.userId);
                        } catch (e) {
                            Log.log(`[BulkPcrStrategy] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                            if (attempt === maxAttempts) {
                                Log.log('[BulkPcrStrategy] reconcile: order query exhausted retries - failing closed for every broker still pending reconciliation');
                                return undefined;
                            }
                            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                        }
                    }
                    return undefined;
                })();
            }
            return openTradesFetch;
        };

        for (const broker of brokers) {
            const persistedPos = persisted?.positions?.[broker];

            if (persistedPos?.phase === 'tree') {
                // A hedge tree was open when this process last shut down - rebuild it from
                // the broker's open trades + legLineage (LegManager.restoreFromOpenTrades),
                // never from the persisted snapshot's own leg data (which doesn't exist -
                // only the root's rootCost is persisted). Never calls placeExitSell: the
                // tree itself (once restored) is the sole exit, same as a live tree's normal
                // onOptionTick-driven sells.
                const openTrades = await getOpenTradesOnce();
                if (openTrades === undefined) {
                    // Fail closed - same reasoning as the never-attempted-exit branch below:
                    // can't confirm what's actually open at the broker, so don't guess.
                    this.positions.set(broker, { ...persistedPos, phase: 'error' });
                    anyRestored = true;
                    this.persistState();
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: order query exhausted retries while an open hedge tree needed restoring - failing closed, manual review required`);
                    continue;
                }
                const antTrades = openTrades.filter((t: any) => t.broker === 'ant');
                await this.legManager.restoreFromOpenTrades(antTrades);
                this.positions.set(broker, { ...persistedPos, phase: 'tree', heldTsym: null, heldToken: null, entryAvg: 0, targetQuantity: 0, soldQty: 0, soldValue: 0 });
                anyRestored = true;
                if (isPastMarketClose()) {
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: ALERT - open hedge tree restored after market close, manual action may be needed (no orders will be placed now)`);
                }
                continue;
            }

            if (persistedPos?.phase === 'selling') {
                // A limit-sell exit was already resting for this broker when
                // this process last shut down. The broker-side pending-order
                // trackers (pendingLimitOrders.ts / breezePendingLimitOrders.ts)
                // are independently restart-safe and will keep polling that
                // same resting order to completion, feeding fills back
                // through updateTrade as usual. Falling through to the
                // 'error'/open-trades branches below instead would risk
                // calling placeExitSell again and placing a SECOND limit sell
                // for the same already-resting quantity - an oversell if both
                // eventually filled.
                //
                // BUT every resting sell chunk is a DAY order - the exchange
                // cancels/expires it unfilled at EOD regardless of what this
                // app believes. If sellPlacedAt is missing (persisted before
                // this field existed), falls on an earlier calendar day than
                // now, OR falls on today but today's market has already
                // closed since (a same-day restart after 15:25 - calendar
                // date alone isn't enough), the resting order is certainly
                // gone already, not "still resting" - live incident
                // 2026-09-24: both the Zerodha and Breeze legs' chunks from
                // 23-Sep expired unfilled at that day's EOD (Breeze's own
                // order book showed status "Expired" on all of them), leaving
                // the position with zero exit protection into the next day.
                // Detected here rather than trusted, and re-placed for the
                // remaining unsold quantity (soldQty/soldValue preserved, not
                // reset).
                //
                // Before any of that: confirm the position is still genuinely open at the
                // broker at all. Live incident 2026-10-15 - a position that had already been
                // squared off manually, outside this app, had its stale 'selling' state
                // resumed here purely from this persisted Mongo doc with no broker
                // confirmation, then (once the resting sell was rejected as a naked short with
                // no position to cover it) looped re-placing the identical doomed sell forever.
                // getOpenTrades is the same broker-truth signal the 'buying'/never-attempted
                // branch below already trusts - reused here rather than adding a second
                // broker-facing path. A failed query can't confirm either way, so it does NOT
                // treat the position as closed - that would be worse than the bug it's fixing.
                const openTrades = await getOpenTradesOnce();
                const matchingOpenTrade = openTrades?.find((t: any) => t.broker === broker && t.tsym === persistedPos.heldTsym);
                const stillOpenAtBroker = openTrades === undefined || matchingOpenTrade != null;
                if (!stillOpenAtBroker) {
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted exit state for ${persistedPos.heldTsym} says 'selling', but no matching open position was found at the broker - treating it as already closed and clearing the stale exit state (NOT resuming fill-watch or re-placing)`);
                    this.positions.set(broker, { ...persistedPos, phase: 'done' });
                    anyRestored = true;
                    this.persistState();
                    continue;
                }

                // Considered on review: unlike the previous-trading-day branch below, this one
                // places no new order - it only resumes the poller's watch on a sell that's
                // ALREADY resting at the broker at whatever quantity it was given when placed.
                // The quantity-clamp fix below (liveOpenQty) exists because THAT branch chooses a
                // fresh quantity to place; there's nothing to clamp here since no placement
                // decision is made in this branch at all. A stale soldQty/targetQuantity here
                // only affects bookkeeping of a fill already in flight, not a new order size.
                const placedSameDay = persistedPos.sellPlacedAt != null && isStillWithinSameTradingSession(persistedPos.sellPlacedAt);
                if (placedSameDay) {
                    this.positions.set(broker, { ...persistedPos });
                    anyRestored = true;
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: restored in-flight limit-sell exit for ${persistedPos.heldTsym} (${persistedPos.soldQty}/${persistedPos.targetQuantity} filled so far) - resuming fill watch`);
                    continue;
                }

                if (isPastMarketClose()) {
                    // reconcile() itself is running after hours (e.g. an
                    // evening restart) - re-placing now would hit a closed
                    // exchange and fail immediately, same reason
                    // pendingLimitOrders.ts/breezePendingLimitOrders.ts defer
                    // an EOD-detected cancellation instead of re-placing
                    // on the spot. Restore the position as-is (still
                    // 'selling', no live resting order at the broker) without
                    // attempting a doomed placement - the next restart's
                    // reconcile() re-evaluates this exact branch and will
                    // succeed once it runs during market hours.
                    this.positions.set(broker, { ...persistedPos });
                    anyRestored = true;
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted limit-sell exit for ${persistedPos.heldTsym} expired unfilled at EOD, but market is currently closed - deferring re-placement to the next restart during market hours (NOT auto-placing now)`);
                    continue;
                }

                let remaining = persistedPos.targetQuantity - persistedPos.soldQty;
                // BUG FIX 2026-10-15 (found on review): stillOpenAtBroker above only checks
                // WHETHER a position exists, not whether its quantity still covers the persisted
                // "remaining" amount. A partial manual sell outside the app between restarts
                // (e.g. targetQuantity=100, soldQty=40 persisted, but the user manually sold 30
                // of the remaining 60 at the broker) would otherwise re-place a sell for the
                // stale 60 - a naked short for the 30 that's no longer held. Clamp to whatever
                // the broker actually still shows open for this exact (broker, tsym).
                const liveOpenQty = matchingOpenTrade?.quantity;
                if (liveOpenQty != null && liveOpenQty < remaining) {
                    Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted remaining qty=${remaining} for ${persistedPos.heldTsym} exceeds what the broker actually shows open (${liveOpenQty}) - some may have been sold outside the app; clamping to ${liveOpenQty}`);
                    remaining = liveOpenQty;
                }
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: persisted limit-sell exit for ${persistedPos.heldTsym} was placed on a previous trading day (sellPlacedAt=${persistedPos.sellPlacedAt ?? 'unset'}) - DAY-order validity means it has certainly expired unfilled at the broker; re-placing exit for remaining qty=${remaining}`);
                this.positions.set(broker, { ...persistedPos });
                anyRestored = true;
                await this.placeExitSellAtTargetPrice(broker, remaining, false);
                continue;
            }

            if (persistedPos?.phase === 'error') {
                // Last run failed for this broker - either a partial buy or a
                // partial/failed exit placement. Either way, getOpenTrades
                // below can't tell "clean buy done, exit never attempted"
                // apart from "exit partially placed then failed" - blindly
                // calling placeExitSell here could place a SECOND
                // full-quantity resting sell on top of chunks already resting
                // from the failed attempt, risking an oversell if both fill.
                // Stay in 'error' for this broker and require the manual
                // review the original failure already called for.
                this.positions.set(broker, { ...persistedPos });
                anyRestored = true;
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: last run ended in 'error' for ${persistedPos.heldTsym} - manual review required, NOT auto-placing an exit`);
                continue;
            }

            // Reached only when persisted state for this broker was neither
            // 'selling' nor 'error' - check the live broker for an open
            // position a crash left with a genuinely never-attempted exit.
            const openTrades = await getOpenTradesOnce();
            if (!openTrades) {
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: order query exhausted retries - failing closed`);
                this.positions.set(broker, { phase: 'error', heldTsym: null, heldToken: null, entryAvg: 0, targetQuantity: 0, soldQty: 0, soldValue: 0 });
                anyRestored = true;
                continue;
            }

            // getOpenTrades(userId) returns one entry per broker this user
            // holds a position on (bookkeeping.trades is keyed by (tsym,
            // user, broker)) - filter to this broker specifically rather
            // than assuming a single entry describes the whole position, as
            // was safe in the single-broker world.
            const brokerTrade = openTrades.find((t: any) => t.broker === broker);
            if (!brokerTrade) continue; // nothing open for this broker - stays untracked

            anyRestored = true;
            this.positions.set(broker, {
                phase: 'buying',
                heldTsym: brokerTrade.tsym,
                heldToken: String(brokerTrade.token),
                entryAvg: brokerTrade.price,
                targetQuantity: 0,
                soldQty: 0,
                soldValue: 0,
            });

            if (isPastMarketClose()) {
                // Same reasoning as the persisted 'selling' branch above: a
                // crash between the buy fill and the first placeExitSell call
                // (never persisted mid-flight, since 'buying' isn't a phase
                // this.persistState() is called for) can leave a live open
                // position with zero exit protection. If reconcile() itself
                // is running after hours, placing now would hit a closed
                // exchange and fail into phase='error' - defer instead; the
                // next restart's reconcile() re-runs this exact branch during
                // market hours and will place it then.
                Log.log(`[BulkPcrStrategy] [${broker}] reconcile: found open position ${brokerTrade.tsym} avg=${brokerTrade.price} qty=${brokerTrade.quantity} with no exit ever attempted, but market is currently closed - deferring exit placement to the next restart during market hours (NOT auto-placing now)`);
                continue;
            }

            Log.log(`[BulkPcrStrategy] [${broker}] reconcile: restored open position ${brokerTrade.tsym} avg=${brokerTrade.price} qty=${brokerTrade.quantity} - placing exit sell`);
            await this.placeExitSell(broker, brokerTrade.quantity);
        }

        // BUG FIX 2026-10-15 (found on review): blindly setting 'running' whenever anyRestored
        // overrode the stillOpenAtBroker branch's per-broker phase='done' - nothing else would
        // ever flip the outer phase back to 'done' (that normally only happens via updateTrade's
        // allDone check, which this restart path never reaches), so isRunning() would report
        // true FOREVER and hasBrokerError() would report false (the broker position is 'done',
        // not 'error') - a silent, permanent hang invisible to BulkPcrAutoStartStrategy, which
        // has no way to tell it apart from a healthy in-progress cycle.
        const allBrokersDone = anyRestored && brokers.every((b) => this.positions.get(b)?.phase === 'done');
        if (allBrokersDone) {
            this.durablyDisable('reconcile: every configured broker was already fully closed at the broker on restart');
        } else if (anyRestored) {
            this.phase = 'running';
        }
    }

    // Exposes the outer one-shot reentrancy gate to callers outside this
    // class (BulkPcrAutoStartStrategy, the scheduled auto-arm wrapper) that
    // need to know "is a cycle actively in flight right now" before
    // deciding to re-arm. phase='done' (finished, waiting to be reset) and
    // phase='idle' (never run / already reset) both correctly report false -
    // both are safe states to re-arm from.
    isRunning(): boolean {
        return this.phase === 'running';
    }

    // isRunning() alone can't tell a healthy in-flight cycle apart from a
    // permanently stuck one: once any configured broker's position enters
    // phase='error' (a failed chunked buy or failed limit-sell placement),
    // the outer phase can never reach 'done' (requires EVERY broker 'done')
    // and reconcile() re-forces it back to 'running' on every restart too -
    // so isRunning() stays true indefinitely until a human calls reset()
    // after the manual review the 'error' phase already demands (see
    // enterOnBroker/placeExitSellAtTargetPrice's "manual review required"
    // logging). Exposed so BulkPcrAutoStartStrategy can log this case
    // distinctly from an ordinary "already running - skipping" line, which
    // otherwise looks identical for both.
    hasBrokerError(): boolean {
        return Array.from(this.positions.values()).some((p) => p.phase === 'error');
    }

    reset(): void {
        this.phase = 'idle';
        this.positions.clear();
        Mongo.getInstance()?.db.collection(STATE_COLLECTION).deleteOne({ userId: this.userId })
            .catch((e) => Log.log('[BulkPcrStrategy] reset: persisted-state clear failed:', e));
        Log.log(`[${this.userId}] Reset via admin request`);
    }
}
