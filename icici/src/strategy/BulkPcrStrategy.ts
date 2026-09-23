import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import { registerTrade } from '../processes/strategies/tokenRouter';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot - no recheck-throttle needed here (one-shot)

// Defense-in-depth against a single bad/stale option tick satisfying the
// target check on its own - 2026-09-22 incident: entered NIFTY2692223400CE
// at avg 52.22, and one second later a single ltp=138.6 tick (real market
// ~50-52 the whole time, per every actual fill before and after) falsely
// read as "target hit", triggering an exit that lost ~15,600. A tick priced
// more than this multiple above entryAvg is treated as untrustworthy and
// ignored outright rather than acted on - cheap, independent of the
// limit-order fix below (which already can't fill below target, but this
// catches the bad tick before it even reaches that logic).
const MAX_SANE_LTP_MULTIPLE = 2;

const STATE_COLLECTION = 'bulkPcrStrategyState';

interface PersistedState {
    phase: 'holding' | 'selling';
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
}

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
// constants.ts) caps any single order - the entry buy is placed via the
// shared, broker-agnostic buyChunked helper (src/processes/order/chunkedOrder.ts)
// through the IPC-exposed chunkedBuyIndex order-process handler, which
// splits into exchange-compliant chunks automatically. The exit sell is
// placed the same way via squareOffLimitChunked/chunkedSquareOffLimit - as a
// resting LIMIT sell at the target price, NOT a market order (see
// processOptionQuote below for why: a blind market square-off is exactly
// what caused the 2026-09-22 loss above - it has no price floor at all, so
// a false target-hit tick sold straight into a loss instead of the order
// simply not filling).
export default class BulkPcrStrategy extends Strategy {
    name = 'BulkPcrStrategy';

    private phase: 'idle' | 'buying' | 'holding' | 'selling' | 'error' | 'done' = 'idle';
    private heldTsym: string | null = null;
    private heldToken: string | null = null;
    private entryAvg = 0;
    // Exit-fill accumulation - the limit-sell chunks placed in
    // processOptionQuote fill asynchronously and independently (each one
    // only when the market actually reaches the target price), so
    // updateTrade tallies them here until the full position is confirmed sold.
    private targetQuantity = 0;
    private soldQty = 0;
    private soldValue = 0;
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

    // Persists just enough state to distinguish 'holding' (safe to re-arm
    // the target check on restart) from 'selling' (a limit-sell exit is
    // already resting at the broker - re-arming would risk placing a SECOND
    // exit for the same quantity) - see reconcile() below. Fire-and-forget,
    // same convention as bookkeeping's own Mongo writes elsewhere.
    private persistState(): void {
        Mongo.getInstance()?.db.collection(STATE_COLLECTION)
            .replaceOne(
                { userId: this.userId },
                {
                    userId: this.userId,
                    phase: this.phase,
                    heldTsym: this.heldTsym,
                    heldToken: this.heldToken,
                    entryAvg: this.entryAvg,
                    targetQuantity: this.targetQuantity,
                    soldQty: this.soldQty,
                    soldValue: this.soldValue,
                },
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
            this.persistState();
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

        // Reject a non-finite tick outright, BEFORE the target comparison -
        // `NaN < targetPrice` and `NaN > entryAvg*MULTIPLE` are both `false`
        // in JS, so without this a NaN ltp (e.g. an unparseable Breeze
        // tick - OptionQuote.fromBreeze has no presence/NaN guard, unlike
        // fromAnt) would silently slip past both the target check below AND
        // the sanity guard after it, and be treated as a genuine target hit.
        if (!Number.isFinite(quote.ltp)) return;

        const cfg = this.cfg();
        const targetPoints = cfg.targetPoints ?? 2;
        const targetPrice = this.entryAvg + targetPoints;
        if (quote.ltp < targetPrice) return;

        // Sanity guard - see MAX_SANE_LTP_MULTIPLE's comment. Only rejects
        // implausibly HIGH ticks: that's the only direction that can falsely
        // satisfy "ltp >= targetPrice" here, regardless of call/put.
        if (quote.ltp > this.entryAvg * MAX_SANE_LTP_MULTIPLE) {
            this.logGateOnce(`ignoring implausible tick ltp=${quote.ltp} (>${MAX_SANE_LTP_MULTIPLE}x entryAvg=${this.entryAvg}) for ${this.heldTsym} - not treating as target hit`);
            return;
        }

        this.phase = 'selling'; // synchronous, before any await
        this.soldQty = 0;
        this.soldValue = 0;
        this.targetQuantity = cfg.quantity ?? 13975;
        Log.log(`[BulkPcrStrategy] Target hit: ltp=${quote.ltp} >= ${targetPrice} - placing resting limit sell for ${this.heldTsym} @ ${targetPrice}`);
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
                tsym: this.heldTsym!,
                instrumentId: this.heldToken!,
                quantity: this.targetQuantity,
                price: targetPrice,
            });
            Log.log(`[BulkPcrStrategy] Limit sell chunks resting for ${this.heldTsym} @ ${targetPrice} - waiting for fills`);
        } catch (e) {
            Log.log('[BulkPcrStrategy] Chunked limit-sell placement failed - manual review required:', e);
            this.phase = 'error';
            this.persistState();
        }
    };

    // Fills for the exit round-trip back here asynchronously, one chunk at a
    // time, potentially far apart - a resting limit sell only fills once the
    // market actually reaches the target price, unlike the old synchronous
    // market-order exit this replaced. Accumulates until the full sold
    // quantity is confirmed, then runs the completion (durable self-disable)
    // logic that used to run synchronously right after chunkedSquareOff
    // returned.
    updateTrade = async (trade: Trade): Promise<void> => {
        if (this.phase !== 'selling') return;
        if (trade.action !== 'Sell' || trade.tsym !== this.heldTsym) return;

        this.soldQty += trade.quantity;
        this.soldValue += trade.quantity * trade.price;
        Log.log(`[BulkPcrStrategy] Exit fill: ${trade.tsym} qty=${trade.quantity} @ ${trade.price} (sold ${this.soldQty}/${this.targetQuantity})`);
        this.persistState();
        if (this.soldQty < this.targetQuantity) return; // more chunks still resting

        const avgExit = this.soldValue / this.soldQty;
        Log.log(`[BulkPcrStrategy] Exit complete: ${this.heldTsym} qty=${this.soldQty} avgExit=${avgExit}`);

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
        this.persistState();
        Log.log('[BulkPcrStrategy] Cycle complete - durably disabled. Flip enabled: true in config.yml manually to arm another run.');
    };

    getMonitorConfig() {
        return null; // self-monitored, no GTT/bracket - Breeze doesn't support them anyway
    }

    // Restart-safety: without this, a restart between "buy completed" and
    // "target hit" would reset phase to 'idle' in memory and could fire a
    // SECOND live block buy on the next PCR-aligned tick. Mirrors
    // ContinuousStrategy.reconcile()'s retry shape.
    async reconcile(maxAttempts = 15, retryDelayMs = 2000): Promise<void> {
        const persisted = await this.loadState();
        if (persisted?.phase === 'selling') {
            // A limit-sell exit was already resting when this process last
            // shut down. The broker-side pending-order trackers
            // (pendingLimitOrders.ts / breezePendingLimitOrders.ts /
            // pendingAntLimitOrders.ts) are independently restart-safe and
            // will keep polling that same resting order to completion,
            // feeding fills back through updateTrade as usual. Restoring
            // 'holding' instead (the old, pre-fix behavior) would re-arm the
            // target check and could place a SECOND limit sell for the same
            // already-resting quantity on the next qualifying tick - risking
            // an oversell if both eventually filled.
            this.phase = 'selling';
            this.heldTsym = persisted.heldTsym;
            this.heldToken = persisted.heldToken;
            this.entryAvg = persisted.entryAvg;
            this.targetQuantity = persisted.targetQuantity;
            this.soldQty = persisted.soldQty;
            this.soldValue = persisted.soldValue;
            if (this.heldToken) registerTrade(this.heldToken, this);
            Log.log(`[BulkPcrStrategy] reconcile: restored in-flight limit-sell exit for ${this.heldTsym} (${this.soldQty}/${this.targetQuantity} filled so far) - resuming fill watch`);
            return;
        }

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
        this.targetQuantity = 0;
        this.soldQty = 0;
        this.soldValue = 0;
        Mongo.getInstance()?.db.collection(STATE_COLLECTION).deleteOne({ userId: this.userId })
            .catch((e) => Log.log('[BulkPcrStrategy] reset: persisted-state clear failed:', e));
        Log.log(`[${this.userId}] Reset via admin request`);
    }
}
