import Log from '../util/Log';
import { CALL, PUT } from '../constants';
import { NiftyQuote, OptionQuote, Trade } from '../model/model';
import configService from '../prism/ConfigService';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { Strategy } from './strategy';

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot - no recheck-throttle needed here (one-shot)

const STATE_COLLECTION = 'bulkPcrStrategyState';

interface PersistedState {
    phase: 'selling' | 'error';
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
}

// One-shot large block order via ICICI Breeze: buys a total quantity (config
// `quantity`, default 13975 = 215 lots x 65) of a NIFTY option in one go,
// then immediately exits at a fixed points target with NO stop-loss (holds
// indefinitely until the resting exit fills, however long that takes), then
// durably disables itself so it can never fire a second block order on a
// later restart.
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
// splits into exchange-compliant chunks automatically and only returns once
// every chunk has filled. The exit sell is placed the same way via
// squareOffLimitChunked/chunkedSquareOffLimit, as soon as the buy resolves
// (see placeExitSell below) - as a resting LIMIT sell at the target price,
// NOT a market order. A blind market square-off is what caused the
// 2026-09-22 loss above (a single bad/stale tick falsely read as "target
// hit" sold straight into a loss, since a market order has no price floor);
// a resting LIMIT order can only ever fill at the target price or better,
// so that failure mode doesn't apply here regardless of when it's placed -
// there is deliberately no tick-based "confirm the target first" gate
// before placing it, since one would add nothing but a dependency on the
// live option-tick feed being connected and a delay in placing an already
// price-safe order.
export default class BulkPcrStrategy extends Strategy {
    name = 'BulkPcrStrategy';

    private phase: 'idle' | 'buying' | 'selling' | 'error' | 'done' = 'idle';
    private heldTsym: string | null = null;
    private heldToken: string | null = null;
    private entryAvg = 0;
    // Exit-fill accumulation - the limit-sell chunks placed in
    // placeExitSell (immediately once the buy completes) fill asynchronously
    // and independently (each one only once the market actually reaches the
    // target price), so updateTrade tallies them here until the full
    // position is confirmed sold.
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

    // Persists just enough state for reconcile() to tell 'selling' (a
    // limit-sell exit is already resting at the broker - re-placing it on
    // restart would risk a SECOND exit for the same quantity) apart from
    // 'error' (something failed and needs manual review - re-placing an
    // exit automatically on restart would be just as wrong, whether the
    // failure was a partial buy or a partial/failed sell) - see reconcile()
    // below. Fire-and-forget, same convention as bookkeeping's own Mongo
    // writes elsewhere.
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
            Log.log(`[BulkPcrStrategy] Entry complete: ${this.heldTsym} qty=${result.quantity} avg=${this.entryAvg}`);
            await this.placeExitSell(result.quantity);
        } catch (e) {
            Log.log('[BulkPcrStrategy] Chunked entry failed - manual review required:', e);
            this.phase = 'error';
            this.persistState(); // so reconcile() on restart knows this needs manual review, not an auto-placed exit
        }
    }

    // Places the resting LIMIT exit sell immediately once `quantity` (the
    // full held position) is confirmed bought - no live-tick "confirm the
    // target first" gate (see file header comment for why one isn't needed
    // here). Called both from the live entry path above and from
    // reconcile() below when a restart lands between "buy filled" and "sell
    // placed".
    private async placeExitSell(quantity: number): Promise<void> {
        const cfg = this.cfg();
        const targetPoints = cfg.targetPoints ?? 2;
        const targetPrice = this.entryAvg + targetPoints;

        this.phase = 'selling'; // synchronous, before any await
        this.soldQty = 0;
        this.soldValue = 0;
        this.targetQuantity = quantity;
        Log.log(`[BulkPcrStrategy] Placing resting limit sell for ${this.heldTsym} qty=${quantity} @ ${targetPrice}`);
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
    }

    canHandleOptionQuote(quote: OptionQuote): boolean {
        return false; // no live-tick trigger needed - see placeExitSell
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {}

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
            // feeding fills back through updateTrade as usual. Falling
            // through to the 'error'/open-trades branches below instead
            // would risk calling placeExitSell again and placing a SECOND
            // limit sell for the same already-resting quantity - an oversell
            // if both eventually filled.
            this.phase = 'selling';
            this.heldTsym = persisted.heldTsym;
            this.heldToken = persisted.heldToken;
            this.entryAvg = persisted.entryAvg;
            this.targetQuantity = persisted.targetQuantity;
            this.soldQty = persisted.soldQty;
            this.soldValue = persisted.soldValue;
            Log.log(`[BulkPcrStrategy] reconcile: restored in-flight limit-sell exit for ${this.heldTsym} (${this.soldQty}/${this.targetQuantity} filled so far) - resuming fill watch`);
            return;
        }

        if (persisted?.phase === 'error') {
            // Last run failed - either a partial buy (chunkedBuyIndex threw
            // mid-chunk) or a partial/failed exit placement
            // (chunkedSquareOffLimit threw after some chunks may already be
            // resting, see placeExitSell's catch). Either way, getOpenTrades
            // below can't tell "clean buy done, exit never attempted" apart
            // from "exit partially placed then failed" - blindly calling
            // placeExitSell here (as the openTrades branch below does) could
            // place a SECOND full-quantity resting sell on top of chunks
            // already resting from the failed attempt, risking an oversell
            // if both fill. Stay in 'error' and require the manual review
            // the original failure already called for.
            this.phase = 'error';
            this.heldTsym = persisted.heldTsym;
            this.heldToken = persisted.heldToken;
            this.entryAvg = persisted.entryAvg;
            this.targetQuantity = persisted.targetQuantity;
            this.soldQty = persisted.soldQty;
            this.soldValue = persisted.soldValue;
            Log.log(`[BulkPcrStrategy] reconcile: last run ended in 'error' for ${this.heldTsym} - manual review required, NOT auto-placing an exit`);
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

        // Reached only when persisted state was neither 'selling' nor
        // 'error' (i.e. a clean buy completed and crashed before
        // placeExitSell's very first, synchronous persistState() call could
        // run) - a genuinely never-attempted exit, safe to place now.
        // trade.quantity is bookkeeping's volume-weighted aggregate over
        // every buy chunk for this tsym+user (bookkeeping.ts recordFill),
        // i.e. the same total the live path's result.quantity would give.
        const trade = openTrades[0];
        this.heldTsym = trade.tsym;
        this.heldToken = String(trade.token);
        this.entryAvg = trade.price;
        Log.log(`[BulkPcrStrategy] reconcile: restored open position ${this.heldTsym} avg=${this.entryAvg} qty=${trade.quantity} - placing exit sell`);
        await this.placeExitSell(trade.quantity);
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
