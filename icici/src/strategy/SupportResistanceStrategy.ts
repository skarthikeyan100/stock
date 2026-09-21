import Log from '../util/Log';
import { Strategy } from './strategy';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { CALL, PUT } from '../constants';
import { LegManager, LegManagerConfig } from './LegManager';
import { initSRState, processTick, SRConfig, SRState } from '../lib/supportResistance';

// Trades NIFTY options on Zerodha off the dynamic support/resistance breach
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
// placed for these trades (getMonitorConfig() returns null) - the strategy
// owns the whole exit lifecycle itself via LegManager.
export default class SupportResistanceStrategy extends Strategy {
    name = 'SupportResistanceStrategy';

    private legManager: LegManager;
    private lastNiftyLtp = 0;
    private srState: SRState = initSRState();

    constructor(userId?: string) {
        super(userId);
        this.enabled = configService.getStrategyConfig('SupportResistanceStrategy').enabled;
        this.legManager = new LegManager({
            userId: this.userId,
            ownerType: 'SupportResistanceStrategy',
            strategyRef: this,
            getConfig: (): LegManagerConfig => this.cfg() as unknown as LegManagerConfig,
            getLastUnderlyingLtp: () => this.lastNiftyLtp,
            recordOutcome: (outcome, pnl) => this.recordOutcome(outcome, pnl),
        });
    }

    private cfg() {
        return configService.getStrategyConfig('SupportResistanceStrategy');
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

    getMonitorConfig() {
        return null; // self-monitored, like ContinuousStrategy - bypass the base's GTT/exitMonitor bracket path
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
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        let openTrades: Trade[] | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                openTrades = await OrderClient.getInstance().getOpenTrades(this.userId);
                break;
            } catch (e) {
                Log.log(`[SupportResistance] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                if (attempt === maxAttempts) {
                    Log.log('[SupportResistance] reconcile: order query exhausted retries, blocking new entries until next restart');
                    this.ordered = true;
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
        if (openTrades!.length === 0) return;
        await this.legManager.restoreFromOpenTrades(openTrades);
        this.ordered = true;
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled || !quote?.ltp) return;
        this.lastNiftyLtp = quote.ltp;
        if (this.legManager.isCapitalGateTripped() || this.legManager.isMaxProfitTripped()) return;

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
        if (this.legManager.hasOpenLegOfRight(right)) return; // one position per side at a time, in-memory (see class doc comment)

        try {
            const leg = await this.legManager.openRootLeg({
                right, underlyingLtp: niftyLtp, minPremium: config.minPremium ?? 50, quantity: config.quantity, entryLabel: 'Entry',
            });
            if (leg) this.recordTriggerTime();
        } catch (e) {
            Log.log('[SupportResistance] Entry failed:', e);
        }
    }

    reset(): void {
        super.reset();
        this.legManager.reset();
        this.srState = initSRState();
        this.ordered = false;
    }
}
