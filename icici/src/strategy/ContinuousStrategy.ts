import moment from 'moment';
import Log from '../util/Log';
import { CALL, PUT, MOCK_BROKER } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { Strategy } from './strategy';
import { LegManager, LegManagerConfig } from './LegManager';
import MomentumSignal from './MomentumSignal';

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

// ContinuousStrategy - opens a root leg (T1) via BuySellStrategy-style entry
// triggers, then self-monitors every open leg's own price against a target
// and a configurable number of stacked adverse levels (1x-Nx of a configured
// SL distance, each spawning a new opposite-direction leg) plus a separately
// configured hard square-off distance. Every leg
// (root or nested) refills at its original entry price on a target-hit,
// gated so the tree can't grow without bound: a nested leg only refills
// while its own parent is still a live leg (isParentAlive), a leg that ends
// up not refilling cancels its own children's pending refills
// (cancelChildRefills), and a new deeper/retraced spawn under a leg first
// cancels that leg's own shallower still-resting refills. See spec.md and
// continuous-strategy-plan.md at the repo root for the full design.
//
// The actual leg lifecycle (spawn-on-loss, same-leg averaging, refill-on-
// target, capitalCheck, maxProfit trip/close-all) lives in LegManager.ts
// (extracted 2026-09-11 so SupportResistanceStrategy can reuse it) - this
// class owns only the entry-trigger logic (PCR-based direction resolution,
// T1 gating) and delegates everything else to its own private LegManager
// instance.
export default class ContinuousStrategy extends Strategy {
    name = 'ContinuousStrategy';

    private legManager: LegManager;
    private momentum = new MomentumSignal();
    private lastNiftyLtp = 0;
    private lastGateLog = new Map<string, number>();
    private lastPcrCheckTime = 0;

    constructor(userId?: string) {
        super(userId);
        this.legManager = new LegManager({
            userId: this.userId,
            ownerType: 'ContinuousStrategy',
            strategyRef: this,
            getConfig: (): LegManagerConfig => this.cfg() as unknown as LegManagerConfig,
            getLastUnderlyingLtp: () => this.lastNiftyLtp,
            recordOutcome: (outcome, pnl) => this.recordOutcome(outcome, pnl),
        });
    }

    receive(oldStats, newStats) {}

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

    // Called once at strategies-process startup, after initialize() resolves
    // and before any tick is dispatched (see the ready-gate in
    // strategiesProcess.ts) - restores "is a position already open" state
    // from order's own bookkeeping, since legManager's leg state/this.ordered
    // are pure in-memory and unconditionally wiped on every strategies
    // restart (which the orchestrator's watcher already triggers
    // automatically and often). Without this, a fresh instance re-evaluates
    // the same live PCR condition and fires a duplicate live T1 entry on top
    // of an already-open position - see ToDo.md's 2026-08-28 live incident.
    //
    // maxAttempts/retryDelayMs (~30s total) mirrors BuySellStrategy's own
    // reconcileOrderState retry loop, which hits the identical race: `order`'s
    // IPC socket is frequently not yet connected this early in `strategies`
    // process startup (see strategiesProcess.ts's main() - OrderClient.connect()
    // is fired, then reconcile() runs immediately after, without waiting for
    // the 'connect' event). A single-attempt fail-closed here previously left
    // T1 permanently blocked for the rest of the trading day on nothing more
    // than a transient startup race that resolved itself a second later - see
    // ToDo.md's 2026-08-31 live incident (blocked from 08:57 through the 09:30
    // window open with 0 open positions the whole time).
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        let openTrades: Trade[] | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                openTrades = await OrderClient.getInstance().getOpenTrades(this.userId);
                break;
            } catch (e) {
                Log.log(`[ContinuousStrategy] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                if (attempt === maxAttempts) {
                    // Fail closed: better to skip a possible entry than risk a duplicate live order.
                    Log.log('[ContinuousStrategy] reconcile: order query exhausted retries, blocking new T1 entries until next restart');
                    this.ordered = true;
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
        if (openTrades!.length === 0) return; // fresh in-memory defaults already correct
        await this.legManager.restoreFromOpenTrades(openTrades);
        this.ordered = true;
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.legManager.canHandle(String(quote.token)) || this.momentum.isTracking(String(quote.token));
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
    //
    // Uses quote.ltt (the tick's own timestamp) rather than Date.now() when
    // available, falling back to Date.now() for live quotes that don't carry
    // one and for unit tests (continuousStrategyTest.ts never sets ltt on its
    // mock quotes, so behavior there is unchanged). This matters for
    // ContinuousStrategyBacktest.ts: it replays a full day's ticks in ~10s of
    // real wall-clock time, so gating on Date.now() meant the throttle opened
    // once and then never again for the rest of the simulated day, blocking
    // every T1 attempt after the first. Gating on tick time instead lets the
    // throttle track simulated time, matching live behavior (where ltt tracks
    // real time anyway).
    //
    // CONFIRMED BUG (live, 2026-09-18): comparing raw quote.ltt (ANT epoch
    // seconds) directly against PCR_RECHECK_MS (a milliseconds constant)
    // meant the throttle needed ~83 hours of elapsed time to release instead
    // of 5 minutes, silently blocking every T1 attempt after the first
    // successful PCR check each day. Fixed via the shared toMillis() helper
    // on Strategy (see its own comment for the full seconds-vs-ms rationale).
    private async fetchPcrIfDue(quote: NiftyQuote): Promise<number | null> {
        const now = this.toMillis(quote.ltt) ?? Date.now();
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
    //
    // Momentum (see MomentumSignal.ts) sits as an additional veto ahead of the
    // configuredRight check, when cfg.momentumEnabled: PCR still decides
    // direction, but if momentum resolves to the OPPOSITE direction, the entry
    // is blocked for this window (same shape as the old momentum/PCR gate that
    // caused a missed entry on 2026-08-26 - kept anyway per explicit user
    // decision, see the momentum plan). Momentum unavailable/inconclusive
    // (null - ATM lookup failed, depth ticks timed out, or CE/PE disagreed
    // with each other) never blocks by itself - only an active disagreement
    // with PCR does.
    private async resolveEntryRight(quote: NiftyQuote, configuredRight?: string): Promise<string | null> {
        const pcr = await this.fetchPcrIfDue(quote);
        if (pcr == null) return null;
        const pcrFavors = pcr > 1 ? PUT : CALL;

        const cfg = this.cfg();
        if (cfg.momentumEnabled) {
            const momentumFavors = await this.momentum.getDirection(this, quote.ltp, cfg.momentumTimeoutMs ?? 3000);
            if (momentumFavors != null && momentumFavors !== pcrFavors) {
                Log.log(`[ContinuousStrategy] Momentum (${momentumFavors}) disagrees with PCR (${pcrFavors}) - blocking T1 entry this window`);
                return null;
            }
        }

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
        // Silent (not logGateOnce - that still logs every 5min forever) and
        // first, ahead of the other T1 gates below - once tripped, skip the
        // contract lookup/withOpLock entirely rather than let capitalCheck
        // reject it further in. See LegManager's capitalGateTripped comment.
        if (this.legManager.isCapitalGateTripped()) return;
        if (this.legManager.isMaxProfitTripped()) return; // permanently blocks new T1 entries until reset()
        const cfg = this.cfg();
        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
        if (this.ordered) { this.logGateOnce('entry already in progress or an open leg exists (no broker order implied)'); return; }
        if (!this.isCooldownElapsed(cfg.cooldownSeconds ?? 60)) { this.logGateOnce('cooldown not elapsed'); return; }
        this.logGateOnce('all T1 gates clear - attempting entry');

        this.ordered = true;

        const configuredRight = (cfg.right && cfg.right !== 'none') ? cfg.right : undefined;
        const right = await this.resolveEntryRight(quote, configuredRight);
        if (right == null) {
            this.ordered = false;
            return;
        }

        const minPremium = cfg.minPremium ?? 100;
        const initialQuantity = cfg.initialQuantity;

        try {
            const leg = await this.legManager.openRootLeg({
                right, underlyingLtp: quote.ltp, minPremium, quantity: initialQuantity, entryLabel: 'T1 entry',
            });
            if (leg) {
                this.recordTriggerTime();
            } else {
                this.ordered = false;
            }
        } catch (e) {
            Log.log('[ContinuousStrategy] T1 entry failed:', e);
            this.ordered = false;
        }
    }

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        if (this.momentum.isTracking(String(quote.token))) {
            this.momentum.onTick(quote);
            return; // not a leg - never reaches LegManager
        }
        await this.legManager.onOptionTick(String(quote.token), quote.ltp);
        if (this.legManager.isIdle()) this.ordered = false;
    };

    updateTrade = async (trade: Trade): Promise<void> => {
        await this.legManager.handleFillOrExternalSell(trade);
        if (this.legManager.isIdle()) this.ordered = false;
    };

    getMonitorConfig() {
        return null; // never goes through the base's GTT/exitMonitor bracket path - self-monitored
    }

    reset(): void {
        super.reset();
        this.legManager.reset();
        this.ordered = false;
    }
}
