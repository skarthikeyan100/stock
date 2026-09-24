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

const PCR_WINDOW_POINTS = 300; // same window width ContinuousStrategy uses around spot - no recheck-throttle needed here (one-shot)

const STATE_COLLECTION = 'bulkPcrStrategyState';

// chunkedBuyIndex/chunkedSquareOffLimit (orderProcess.ts) only support these
// two brokers today - 'ant' is deliberately not in this union yet (see
// getBrokerExecutor's brokerOverride type); adding it would need its own
// contract-resolution/pricing branch in orderProcess.ts first.
type BrokerName = 'zerodha' | 'breeze';

interface BrokerPosition {
    phase: 'buying' | 'selling' | 'error' | 'done';
    heldTsym: string | null;
    heldToken: string | null;
    entryAvg: number;
    targetQuantity: number;
    soldQty: number;
    soldValue: number;
    // Epoch ms when phase last transitioned to 'selling' - lets reconcile()
    // tell a genuinely still-resting exit apart from one that's certainly
    // gone: every resting sell chunk placed by chunkedSquareOffLimit is a DAY
    // order, which the exchange cancels/expires unfilled at EOD regardless of
    // what this app believes - see reconcile()'s use of this field.
    sellPlacedAt?: number;
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
// default 13975 = 215 lots x 65) of a NIFTY option independently and in
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

    receive(oldStats, newStats) {}

    private cfg() {
        return configService.getStrategyConfig('BulkPcrStrategy');
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
        if (!this.enabled) { this.logGateOnce('disabled'); return; }
        if (this.phase !== 'idle') { this.logGateOnce(`entry already in progress or done (phase=${this.phase})`); return; }
        if (!this.isTimeInRange()) { this.logGateOnce('outside time window'); return; }
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
    private async enterOnBroker(broker: BrokerName, right: string, quantity: number, niftyLtp: number): Promise<void> {
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
            const result = await OrderClient.getInstance().chunkedBuyIndex(this.userId, { right, quantity, niftyLtp, broker });
            const pos = this.positions.get(broker)!;
            pos.heldTsym = result.tsym;
            pos.heldToken = String(result.token);
            pos.entryAvg = result.avgPrice;
            Log.log(`[BulkPcrStrategy] [${broker}] Entry complete: ${pos.heldTsym} qty=${result.quantity} avg=${pos.entryAvg}`);
            await this.placeExitSell(broker, result.quantity);
        } catch (e) {
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

    // Momentum-only tick consumer - this strategy has no live-tick "confirm
    // target" gate of its own (see file header), so the only option ticks it
    // ever needs are the ATM CE/PE legs MomentumSignal itself subscribes to
    // for a one-shot direction reading. Mirrors ContinuousStrategy's exact
    // wiring.
    canHandleOptionQuote(quote: OptionQuote): boolean {
        return this.momentum.isTracking(String(quote.token));
    }

    async processOptionQuote(quote: OptionQuote): Promise<void> {
        if (this.momentum.isTracking(String(quote.token))) {
            this.momentum.onTick(quote);
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
        if (!pos || pos.phase !== 'selling') return;
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
        Log.log('[BulkPcrStrategy] Cycle complete on every configured broker - durably disabled. Flip enabled: true in config.yml manually to arm another run.');
    };

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

        Log.log(`[BulkPcrStrategy] [${broker}] Order cancelled: ${notification.tradingSymbol} qty=${notification.quantity} (${notification.reason}) - re-placing resting sell`);
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

                const remaining = persistedPos.targetQuantity - persistedPos.soldQty;
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
            Log.log(`[BulkPcrStrategy] [${broker}] reconcile: restored open position ${brokerTrade.tsym} avg=${brokerTrade.price} qty=${brokerTrade.quantity} - placing exit sell`);
            await this.placeExitSell(broker, brokerTrade.quantity);
        }

        if (anyRestored) this.phase = 'running';
    }

    reset(): void {
        this.phase = 'idle';
        this.positions.clear();
        Mongo.getInstance()?.db.collection(STATE_COLLECTION).deleteOne({ userId: this.userId })
            .catch((e) => Log.log('[BulkPcrStrategy] reset: persisted-state clear failed:', e));
        Log.log(`[${this.userId}] Reset via admin request`);
    }
}
