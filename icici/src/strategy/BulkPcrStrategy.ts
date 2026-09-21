import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { registerTrade } from '../processes/strategies/tokenRouter';
import { Strategy } from './strategy';

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot - no recheck-throttle needed here (one-shot)

// One-shot large block order via ICICI Breeze: buys a total quantity (config
// `quantity`, default 13975 = 215 lots x 65) of a NIFTY option in one go,
// exits at a fixed points target with NO stop-loss (holds indefinitely,
// however long that takes), then durably disables itself so it can never
// fire a second block order on a later restart.
//
// Direction: if config `right` is 'call'/'put', use that fixed direction
// directly (no PCR check). If 'none' (default), PCR (put/call OI ratio)
// decides - reuses ContinuousStrategy's exact PCR>1-favors-PUT logic, but
// WITHOUT its PCR_RECHECK_MS/lastPcrCheckTime recheck-throttle, which exists
// there only because it re-evaluates repeatedly all day - this strategy
// fires at most once ever per arming, so a single direct fetch when the
// entry gate first clears is all that's needed.
//
// NIFTY's exchange freeze quantity (1755, see NIFTY_FREEZE_QUANTITY in
// constants.ts) caps any single order - both the entry buy and the exit sell
// are placed via the shared, broker-agnostic buyChunked/squareOffChunked
// helpers (src/processes/order/chunkedOrder.ts) through the IPC-exposed
// chunkedBuyIndex/chunkedSquareOff order-process handlers, which split into
// exchange-compliant chunks automatically.
export default class BulkPcrStrategy extends Strategy {
    name = 'BulkPcrStrategy';

    private phase: 'idle' | 'buying' | 'holding' | 'selling' | 'error' | 'done' = 'idle';
    private heldTsym: string | null = null;
    private heldToken: string | null = null;
    private entryAvg = 0;
    private lastGateLog = new Map<string, number>();

    receive(oldStats, newStats) {}

    private cfg() {
        return configService.getStrategyConfig('BulkPcrStrategy');
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

    private async resolveEntryRight(quote: NiftyQuote, configuredRight?: string): Promise<string | null> {
        if (configuredRight && configuredRight !== 'none') return configuredRight; // explicit direction - skip PCR entirely
        try {
            const pcr = await OrderClient.getInstance().getPCR(this.userId, 'NIFTY', quote.ltp, PCR_WINDOW_POINTS);
            const right = pcr > 1 ? PUT : CALL;
            Log.log(`[BulkPcrStrategy] PCR=${pcr.toFixed(3)} -> resolved direction ${right}`);
            return right;
        } catch (e) {
            Log.log('[BulkPcrStrategy] PCR check failed, blocking entry (fail-closed):', e);
            return null;
        }
    }

    async processNiftyQuote(quote: NiftyQuote): Promise<void> {
        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (this.phase !== 'idle') { this.logGateOnce(`entry already in progress or done (phase=${this.phase})`); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
        this.logGateOnce('gates clear - attempting entry');

        // Reentrancy guard set synchronously here, BEFORE the PCR resolution
        // below awaits - resolveEntryRight makes an async IPC call, and a
        // second tick arriving during that gap would otherwise still see
        // phase='idle' (this used to be set only after the await, which let
        // concurrent ticks race past the idle-check together and each
        // launch their own chunkedBuyIndex call - observed live 2026-09-21,
        // caused multiple duplicate block buys before Breeze's own rate
        // limit accidentally capped the damage).
        this.phase = 'buying';

        const cfg = this.cfg();
        const configuredRight = cfg.right && cfg.right !== 'none' ? cfg.right : undefined;
        const right = await this.resolveEntryRight(quote, configuredRight);
        if (right == null) { this.phase = 'idle'; return; } // retried on the next tick

        const quantity = cfg.quantity ?? 13975;

        try {
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, { right, quantity, niftyLtp: quote.ltp });
            this.heldTsym = result.tsym;
            this.heldToken = String(result.token);
            this.entryAvg = result.avgPrice;
            this.phase = 'holding';
            Log.log(`[BulkPcrStrategy] Entry complete: ${this.heldTsym} qty=${result.quantity} avg=${this.entryAvg}`);
        } catch (e) {
            Log.log('[BulkPcrStrategy] Chunked entry failed - manual review required:', e);
            this.phase = 'error';
        }
    }

    canHandleOptionQuote = (quote: OptionQuote): boolean => {
        return this.heldToken != null && String(quote.token) === this.heldToken;
    };

    processOptionQuote = async (quote: OptionQuote): Promise<void> => {
        if (this.phase !== 'holding') return;
        const cfg = this.cfg();
        const targetPoints = cfg.targetPoints ?? 2;
        if (quote.ltp < this.entryAvg + targetPoints) return;

        this.phase = 'selling'; // synchronous, before any await
        Log.log(`[BulkPcrStrategy] Target hit: ltp=${quote.ltp} >= ${this.entryAvg + targetPoints} - exiting ${this.heldTsym}`);

        try {
            const quantity = cfg.quantity ?? 13975;
            await OrderClient.getInstance().chunkedSquareOff(this.userId, { tsym: this.heldTsym!, quantity });

            // Durable self-disable - mirrors GoodMorningStrategy.ts's exact
            // pattern (configService.writeConfig), since an in-memory-only
            // this.enabled = false would be silently overwritten back to
            // config.yml's static enabled: true on the next restart
            // (StrategyFactory.createStrategy always does
            // strategy.enabled = config.enabled after construction).
            const liveCfg = configService.getStrategyConfig('BulkPcrStrategy');
            liveCfg.enabled = false;
            configService.writeConfig(configService.getConfig());
            this.enabled = false; // stop in-memory immediately too - config.yml only gets re-read on next restart
            this.phase = 'done';
            Log.log('[BulkPcrStrategy] Cycle complete - durably disabled. Flip enabled: true in config.yml manually to arm another run.');
        } catch (e) {
            Log.log('[BulkPcrStrategy] Chunked exit failed - manual review required, position may be partially closed:', e);
            this.phase = 'error';
        }
    };

    // Every chunk fill (buy and sell) round-trips back through
    // strategiesProcess.ts's generic onFill -> strategy.updateTrade(trade),
    // but the chunked orchestrator (running in the `order` process) already
    // accounts for every fill synchronously inside its own loop - reacting
    // here too would double-drive the phase machine. Deliberate no-op.
    updateTrade = async (trade: Trade): Promise<void> => {};

    getMonitorConfig() {
        return null; // self-monitored, no GTT/bracket - Breeze doesn't support them anyway
    }

    // Restart-safety: without this, a restart between "buy completed" and
    // "target hit" would reset phase to 'idle' in memory and could fire a
    // SECOND live block buy on the next PCR-aligned tick. Mirrors
    // ContinuousStrategy.reconcile()'s retry shape.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        let openTrades: any[] | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                openTrades = await OrderClient.getInstance().getOpenTrades(this.userId);
                break;
            } catch (e) {
                Log.log(`[BulkPcrStrategy] reconcile: order query attempt ${attempt}/${maxAttempts} failed:`, e);
                if (attempt === maxAttempts) {
                    Log.log('[BulkPcrStrategy] reconcile: order query exhausted retries - failing closed');
                    this.phase = 'error';
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
        if (!openTrades || openTrades.length === 0) return; // nothing open - stays 'idle'

        const trade = openTrades[0];
        this.heldTsym = trade.tsym;
        this.heldToken = String(trade.token);
        this.entryAvg = trade.price;
        this.phase = 'holding';
        registerTrade(trade.token, this); // required - only the live fill handler calls this normally, not a restart
        Log.log(`[BulkPcrStrategy] reconcile: restored open position ${this.heldTsym} avg=${this.entryAvg} - resuming target watch`);
    }

    reset(): void {
        this.phase = 'idle';
        this.heldTsym = null;
        this.heldToken = null;
        this.entryAvg = 0;
        Log.log(`[${this.userId}] Reset via admin request`);
    }
}
