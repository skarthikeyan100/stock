import { isPastTime } from '../util/marketHours';
import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import { CALL, PUT, MOCK_BROKER } from '../constants';
import { LegManager, LegManagerConfig } from './LegManager';
import { brokerLegOps } from './LegBrokerOps';
import { initSRState, processTick, SRConfig, SRState } from '../lib/supportResistance';
import { fetchOpenTradesWithRetry } from './openTrades';

// Trades NIFTY options on Kite off the dynamic support/resistance breach
// detector (src/lib/supportResistance.ts, the same SEEKING/LOCKED/BREACH
// state machine SupportResistanceHypothesisTest.ts validates offline): a
// confirmed resistance breach buys a CALL, a confirmed support breach buys a
// PUT, gated by the held-duration filter (only trust a breach if its range
// stayed LOCKED for heldMinSec-heldMaxSec before breaching - see
// config.yml's srHypothesis: block and
// ~/.claude/plans/1-maxprofit-is-added-rustling-platypus.md for the full
// rationale). Detector tuning (confirmWindowMin/maxJump/maxRangeWidth/
// buffer/breachBuffer/breachConfirmSec/heldMinSec/heldMaxSec) is read from
// the shared srHypothesis: config block - the same values
// SupportResistanceHypothesisTest.ts uses offline are now also live/
// backtest-facing here.
//
// Self-monitored, like ContinuousStrategy (extracted 2026-09-11 into
// LegManager.ts) - CE and PE legs share one LegManager instance (so
// maxProfit is a single combined latch across both sides), each side spawns
// hedge legs/averages on an adverse move and refills on a target hit exactly
// like ContinuousStrategy's root legs do. No broker-side GTT bracket is
// placed for these trades (self-monitored) - the strategy
// owns the whole exit lifecycle itself via LegManager.
export default class SupportResistanceStrategy extends Strategy {
    name = 'SupportResistanceStrategy';

    private legManager: LegManager;
    legTokenFeed = 'ant' as const; // LegManager legs carry ANT tokens on every broker (see Strategy.legTokenFeed)
    private lastNiftyLtp = 0;
    private srState: SRState = initSRState();
    // Sides with a root-leg attempt in flight: two breach events in quick succession must not both pass the
    // hasOpenLegOfRight check before the first leg is registered (they would stack two same-side positions).
    private opening = new Set<string>();
    private lastEodAttempt = 0;
    private restoreFailed = false; // reconcile could not read open trades: fail closed (a duplicate live entry is worse than a missed one)

    constructor(userId?: string) {
        super(userId);
        this.enabled = this.instanceConfig().enabled;
        this.legManager = new LegManager({
            userId: this.userId,
            ownerType: 'SupportResistanceStrategy',
            strategyRef: this,
            getConfig: (): LegManagerConfig => this.cfg() as unknown as LegManagerConfig,
            getLastUnderlyingLtp: () => this.lastNiftyLtp,
            recordOutcome: (outcome, pnl) => this.recordOutcome(outcome, pnl),
            ops: brokerLegOps(() => this.cfg()?.broker), // `broker: ant` used to throw here: the ANT-only contract pick was never wired in
        });
    }

    private cfg() {
        return this.instanceConfig();
    }

    // Detector tuning lives in the shared srHypothesis: block (config.yml),
    // not this strategy's own config - same source SupportResistanceHypothesisTest.ts
    // reads, so live behavior and offline analysis stay in sync.
    private srConfig(): SRConfig {
        const sr = (configService.getConfig() as any).srHypothesis;
        return {
            confirmWindowMs: sr.confirmWindowMin * 60_000,
            maxJump: sr.maxJump,
            maxRangeWidth: sr.maxRangeWidth,
            buffer: sr.buffer,
            breachBuffer: sr.breachBuffer,
            breachConfirmMs: sr.breachConfirmSec * 1000,
        };
    }


    receive(oldStats: any, newStats: any) {}

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.legManager.canHandle(String(quote.token));
    };

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        await this.legManager.onOptionTick(String(quote.token), quote.ltp);
        if (this.legManager.isIdle()) this.ordered = false;
    };

    updateTrade = async (trade: Trade): Promise<void> => {
        await this.legManager.handleFillOrExternalSell(trade);
        if (this.legManager.isIdle()) this.ordered = false;
    };

    // Restores open legs after a strategies-process restart, mirroring
    // ContinuousStrategy.reconcile() - this strategy gained real leg state
    // (and therefore this same restart-safety gap) only once it became
    // self-monitored. Same retry policy against a not-yet-connected order
    // IPC socket at startup.
    // Called by strategiesProcess at startup, independent of reconcile() (which runs right after, once the broker positions are loaded; or on an explicit POST
    // /reconcile): a restart after a max-profit/max-loss trip must not re-open the strategy.
    async restoreLatches(): Promise<void> {
        await this.legManager.loadPersistedLatches();
    }

    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        // Restore today's max-profit / max-loss stop first, so a restart does not re-open a strategy that tripped.
        await this.legManager.loadPersistedLatches();
        const openTrades = await fetchOpenTradesWithRetry(this.userId, 'SupportResistance', maxAttempts, retryDelayMs);
        if (!openTrades) {
            Log.log('[SupportResistance] reconcile: order query exhausted retries, blocking new entries until next restart');
            this.ordered = true;
            this.restoreFailed = true;
            return;
        }
        if (openTrades.length === 0) {
            await this.legManager.restorePendingReEntries(); // a root refill may be resting while no leg is held
            return;
        }
        await this.legManager.restoreFromOpenTrades(openTrades);
        await this.legManager.restorePendingReEntries();
        this.ordered = true;
    }

    // Same end-of-day close as ContinuousStrategy: cfg.eodCloseTime ('HH:mm', default 15:10).
    private isPastEodCloseTime(): boolean {
        if (MOCK_BROKER) return false;
        return isPastTime(this.cfg().eodCloseTime);
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!quote?.ltp) return;
        this.lastNiftyLtp = quote.ltp;
        // Ahead of the enabled gate and every latch: legs must still close at EOD (retried every 5s on failure).
        if (this.isPastEodCloseTime() && Date.now() - this.lastEodAttempt > 5000) {
            this.lastEodAttempt = Date.now();
            await this.legManager.closeAllForEod();
        }
        if (!this.enabled) return;
        if (this.restoreFailed) return; // restore failed (fail closed) - no new entries until the next restart/reset
        if (this.legManager.isCapitalGateTripped() || this.legManager.isMaxProfitTripped() || this.legManager.isMaxLossTripped()) return;
        if (this.isPastEodCloseTime()) return;

        // See Strategy.toMillis() - quote.ltt is ANT epoch seconds, not ms;
        // confirmWindowMs/breachConfirmMs (below) are genuinely millisecond-
        // scaled, so comparing raw seconds against them would need ~83 hours
        // to ever confirm a breach instead of the configured seconds/minutes
        // window (same class of bug fixed live in ContinuousStrategy 2026-09-18).
        const { state, event } = processTick(this.srState, { ltp: quote.ltp, ltt: this.toMillis(quote.ltt) ?? Date.now() }, this.srConfig());
        this.srState = state;
        if (event.type !== 'BREACH') return;

        const sr = (configService.getConfig() as any).srHypothesis;
        const heldMs = event.heldMs;
        const heldOk = heldMs >= sr.heldMinSec * 1000 && heldMs <= sr.heldMaxSec * 1000;
        if (!heldOk) {
            Log.log(`[SupportResistance] Breach ignored - held ${Math.round(heldMs / 1000)}s outside [${sr.heldMinSec}s, ${sr.heldMaxSec}s] window: ${event.direction} at ${event.ltp}`);
            return;
        }

        const right = event.direction === 'resistance' ? CALL : PUT;
        await this.tryOpen(right, quote.ltp);
    }

    private async tryOpen(right: string, niftyLtp: number): Promise<void> {
        const config = this.cfg();
        if (!this.isCooldownElapsed(config.cooldownSeconds ?? 60)) return;
        if (this.legManager.hasOpenLegOfRight(right) || this.opening.has(right)) return; // one position per side at a time, in-memory (see class doc comment)

        this.opening.add(right);
        try {
            const leg = await this.legManager.openRootLeg({
                right, underlyingLtp: niftyLtp, minPremium: config.minPremium ?? 50, quantity: config.quantity, entryLabel: 'Entry',
            });
            if (leg) this.recordTriggerTime();
        } catch (e) {
            Log.log('[SupportResistance] Entry failed:', e);
        } finally {
            this.opening.delete(right);
        }
    }

    reset(): void {
        super.reset();
        this.legManager.reset();
        this.srState = initSRState();
        this.opening.clear();
        this.restoreFailed = false;
        this.ordered = false;
    }
}
