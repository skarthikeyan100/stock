import Log from '../../util/Log';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import Mongo from '../../tools/mongo';
import Kite from '../../kite/Kite';
import ANT from '../../ant/ANT';
import Breeze from '../../breeze/Breeze';
import BreezeContractMaster, { indexNameFor, breezeTsym, breezeLegacyTsym } from '../../breeze/BreezeContractMaster';
import { Trade } from '../../model/model';
import { UserContext, closeUserAccount } from '../../user';
import { PUT, CALL, UNKNOWN_USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT, INDEX_LOT_SIZE } from '../../constants';
import * as exitMonitor from './exitMonitor';
import { collapseFillsByOrderId, netFifoLots, pairFillsFifo } from './fillNetting';
import { recordOrderOwner, loadOrderOwners } from './orderOwners';
import configService from '../../prism/ConfigService';
import { drawdownLimit, drawdownDecision } from '../../prism/percentConfig';
import { startOfWeek } from '../../util/weekWindow';
import AntContractMaster from '../../ant/AntContractMaster';
import { normalizeBrokerName } from '../../util/brokerName';
import { localDayKey } from '../../strategy/dayKey';
import { exchangeForTsym } from '../../util/underlyings';

// One row of a broker's position list, normalised across the four brokers (see OrderBookkeeping.readBrokerRows). `tsyms` and `tokens` are every
// spelling/id the platform may have stored for the contract; `soldQty`/`soldValue` are TODAY's sells at the broker (absent where the broker does not report them).
type BrokerRow = { tsyms: string[]; tokens: string[]; qty: number; soldQty?: number; soldValue?: number; ltp?: number };
type BrokerKey = 'kite' | 'ant' | 'breeze' | 'prism';
type BrokerFill = { orderId: string; action: 'Buy' | 'Sell'; tsym: string; token?: string; qty: number; price: number };
export type EodMismatchKind = 'unattributedFill' | 'partialUnattributable' | 'brokerExcess' | 'brokerShort' | 'sellWithoutBuy';
export type EodMismatch = { kind: EodMismatchKind; broker: BrokerKey; tsym: string; brokerQty?: number; mongoQty?: number; note?: string };
export type EodBrokerReport = { ok: boolean; skipped?: string; error?: string; bookedFills: number; bookedFlat: number; repairedClosed: number; mismatches: EodMismatch[] };
export type MongoRestoreResult = { ok: boolean; restored: number; contracts: number; skippedExpired: string[]; skippedUnknownToken: string[]; skippedNoToken: string[]; error?: string };

// Open-P&L pricing gets a short budget: it runs inside every buy's drawdown check, so a slow quote must not stall an order.
const OPEN_PNL_TIMEOUT_MS = 4_000;
const OPEN_PNL_LOG_EVERY_MS = 60_000;

// Local YYYY-MM-DD, same key as PnlStop's latch day.
function dayKeyLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Order-process-local replacement for Monitor's bookkeeping (trades/closedTrades,
// risk limits, order<->user attribution, P&L). Ported from src/monitor.ts, with
// everything quote-driven removed: no AntStream subscribe/unsubscribe. Target/SL
// exits are a GTT placed once at entry (see kiteExecutor.ts) for users with
// useGTT=true; for useGTT=false users, exitMonitor.ts watches the tick feed
// piped in from `data` (see orderProcess.ts) and squares off in-app instead.
// Strategy notification (Monitor.strategyMap) is replaced by fillListeners,
// pushed out over the order<->strategies IPC socket by orderProcess.ts.

// Breeze's underlying breezeconnect SDK calls have no configured HTTP
// timeout anywhere (unlike ANT's ANT_HTTP_TIMEOUT_MS-bound axios instance or
// kiteconnect's own default) - a hung/slow Breeze call inside
// reconcileBreezePositions would otherwise never resolve, and since
// orderProcess.ts's canPlaceOrder/squareOff/openTrades/placeOrderWithPendingGuard
// all now await reconcileInFlight (see that file's comment), a stuck Breeze
// reconcile would block every user's order placement AND square-off/
// emergency-stop indefinitely, not just Breeze's own. Bounds the promise so
// reconcileBreezePositions's existing catch-and-continue behavior (see below)
// kicks in on a timeout too, same as a genuine rejection.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type FillListener = (userId: string, trade: Trade) => void;
type PositionsChangedListener = () => void;
type DrawdownBreachListener = (userId: string) => void;

interface UserSettings {
    lossLimit: number;
    lotLimit?: number;
    maxInvestment?: number;
    // Per-broker investment caps (BulkPcr `maxInvestmentByBroker`, keyed by canonical broker name). A broker without an entry uses maxInvestment.
    maxInvestmentByBroker?: Record<string, number>;
    investmentMode?: string;
    accountCapital?: number;
    useGTT?: boolean;
    broker?: 'kite' | 'ant' | 'breeze';
    perOrderCap?: number;
    strategyCapital?: number;
    targetPoints?: number;
    stopLossPoints?: number;
    accountClosed?: boolean;
    closedAtMs?: number; // when this process closed the account (see updateUserSettings)
}

// One reservation per in-flight, not-yet-resolved buy request. A Set<string>
// can't represent two concurrent pending orders for the same user (a second
// add() is a no-op, and a single delete() would wipe out both) - that's
// exactly the gap this whole fix closes, so this must be a per-user list.
interface PendingOrder {
    orderId?: string; // set for a resting limit buy once placed, so its fill or cancel releases THIS reservation (see releaseReservationForOrder)
    filledInContext?: boolean; // a fill booked inside the owning request already consumed part of estimatedValue
    estimatedLots: number;  // always 1: a conservative reservation - real
                             // quantity isn't always known yet (see buyIndex/
                             // antBuyIndex, which resolve it inside the
                             // broker executor)
    estimatedValue: number; // mirrors canPlaceOrder's estimatedOrderValue
                             // param; 0 when the caller didn't have one
                             // (buyIndex/antBuyIndex) - those get lot-limit
                             // protection while pending but not investment-
                             // limit protection
    broker?: string;        // which broker this reservation is for - lets
                             // releasePending/pendingValue scope to the same
                             // (user, broker) pair maxInvestment now gates on
                             // (see canPlaceOrder's own comment); undefined
                             // for a caller that never resolved one (treated
                             // as "any broker" by the broker-scoped filters)
}

// Bound on any Mongo call the fill path awaits. A hung socket must not stall
// fill handling; a timed-out ledger read resolves to the caller's fallback
// (drawdown reads then report 'unknown' - buys blocked, nothing liquidated).
const LEDGER_TIMEOUT_MS = 5_000;
// A closed-trade row that keeps failing is retried until it lands (flushed on every fill and on a timer);
// the failure is logged at error level every this-many attempts rather than on each one.
const CLOSED_ROW_ERROR_LOG_EVERY = 20;
const CLOSED_ROW_FLUSH_INTERVAL_MS = 60_000;
const RECENTLY_LANDED_MS = 30_000;
function withFallbackTimeout<T, F>(p: Promise<T>, ms: number, fallback: F, label: string): Promise<T | F> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<F>((resolve) => {
        timer = setTimeout(() => {
            Log.log(`[order] ${label} timed out after ${ms}ms`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    // Separate ledger for a strategy's legitimate SHORT positions (e.g. ButterflyStrategy's
    // sell-to-open legs) - deliberately NOT `trades` above, which every existing Buy/Sell
    // branch in _processTradeEvent treats as long-only (see recordShortFill's own comment).
    // Keyed identically to `trades`: (tsym, user, broker).
    shortTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingOrders: Map<string, PendingOrder[]> = new Map();
    // Square-off (exit/sell) in-flight guard, keyed by `${userId}:${tsym}` -
    // set synchronously at the very top of squareOffOnAnt (antExecutor.ts),
    // before any await, and released in a finally block there. Prevents a
    // manual square-off and exitMonitor's (or the drawdown-breach handler's)
    // auto-triggered exit from both issuing a live SELL order for the same
    // trade when they fire close together. Entirely separate from
    // pendingUsers/pendingOrders (the BUY-side reservation, unrelated - square-off
    // never goes through canPlaceOrder) - do not merge the two.
    pendingSquareOffs: Set<string> = new Set();
    // brokerOrderId values already processed by recordFill, so a redelivered
    // fill event (reconnect replay, webhook retry) doesn't double-book P&L.
    // In-memory/per-process-lifetime only - matches this file's existing
    // in-memory-state conventions (see CLAUDE.md).
    private processedFillIds: Set<string> = new Set();
    // Fill ids whose booking threw after the raw doc may have been written (see recordFill).
    private failedBookingFillIds: Set<string> = new Set();
    // Raw-doc inserts still in flight, by broker order id: a retry waits for them so its stored-doc lookup is not racing the write.
    private pendingFillInserts: Map<string, Promise<unknown>> = new Map();
    // Per-session, per-user set of drawdown-warning thresholds (80, 100) already
    // notified, so a losing streak doesn't spam a fresh notification per trade.
    private notifiedThresholds: Map<string, Set<number>> = new Map();
    userSettingsCache: Map<string, UserSettings> = new Map();
    private fillListeners: FillListener[] = [];
    // Broker order ids of sells the BROKER itself executed (a GTT target/stop that fired), booked by the GTT poll. Not stored in Mongo. A fill
    // listener (mirror.ts) reads it to tell a broker-side exit, which the matching admin GTT performs by itself, from a sell this platform placed.
    readonly brokerOwnedExitOrderIds = new Set<string>();
    private positionsChangedListeners: PositionsChangedListener[] = [];
    private drawdownBreachListeners: DrawdownBreachListener[] = [];

    /** True when this broker order id was already booked (or is being booked) in this process. */
    isFillProcessed(orderId: string): boolean { return this.processedFillIds.has(orderId); }

    onFill(listener: FillListener) {
        this.fillListeners.push(listener);
    }

    // Registered from orderProcess.ts (which has access to both broker
    // executors - bookkeeping.ts can't import them, they already import it,
    // same problem exitMonitor.ts's onExit(broker, handler) solves). Fired
    // from _processTradeEvent when a closing trade pushes the user past the
    // daily or weekly drawdown limit, so the listener can square off their
    // remaining open positions.
    onDrawdownBreach(listener: DrawdownBreachListener) {
        this.drawdownBreachListeners.push(listener);
    }

    // Broader than onFill - fires on every trades/closedTrades mutation
    // (fills, closes, and target/SL edits), not just completed fills. Feeds
    // GET /positionstream's per-user SSE push in the frontend process.
    onPositionsChanged(listener: PositionsChangedListener) {
        this.positionsChangedListeners.push(listener);
    }

    private notifyPositionsChanged() {
        for (const l of this.positionsChangedListeners) l();
    }

    // Public entry point for callers outside this class that can't call
    // notifyPositionsChanged() directly (see exitMonitor.ts's onPriceUpdate,
    // wired up in orderProcess.ts - exitMonitor.ts can't import this module
    // directly, since this module already imports exitMonitor.ts).
    triggerPositionsChanged(): void {
        this.notifyPositionsChanged();
    }

    // `settings` may still carry the pre-migration names (a frontend/strategies process on the previous build): they are mapped on entry.
    updateUserSettings(user: string, rawSettings: UserSettings & { investmentAmount?: number; allottedCapital?: number }) {
        const { investmentAmount, allottedCapital, ...settings } = rawSettings;
        if (settings.accountCapital === undefined && investmentAmount !== undefined) settings.accountCapital = investmentAmount;
        if (settings.strategyCapital === undefined && allottedCapital !== undefined) settings.strategyCapital = allottedCapital;
        // A closure this process made moments ago may not be in the user document yet, so a push built from a document that has not
        // caught up must not re-open the account. Once the closure is older than the persist window the document is authoritative
        // again, which is how an admin clearing accountClosed in Mongo takes effect without a restart.
        const prev = this.userSettingsCache.get(user);
        const recentlyClosed = prev?.accountClosed === true && Date.now() - (prev.closedAtMs ?? 0) < 60_000;
        const closed = settings.accountClosed === true || recentlyClosed;
        this.userSettingsCache.set(user, { ...settings, accountClosed: closed, closedAtMs: closed ? (prev?.closedAtMs ?? Date.now()) : undefined });
    }

    getUserLossLimit(user: string): number {
        return this.userSettingsCache.get(user)?.lossLimit ?? UNKNOWN_USER_LOSS_LIMIT;
    }

    getUserLotLimit(user: string): number {
        return this.userSettingsCache.get(user)?.lotLimit ?? DEFAULT_LOT_LIMIT;
    }

    // `broker` selects that broker's own cap: today's runtime override (a BulkPcr loss-trip cut, see setBrokerInvestmentCap), else the
    // configured per-broker cap, else the user's single cap. Without `broker` it is the user's single cap.
    getUserMaxInvestment(user: string, broker?: string): number {
        const settings = this.userSettingsCache.get(user);
        if (broker) {
            const override = this.brokerCapOverride.get(`${user}|${broker}`);
            if (override && override.day === localDayKey()) return override.cap;
            const configured = settings?.maxInvestmentByBroker?.[broker];
            if (configured !== undefined) return configured;
        }
        return settings?.maxInvestment ?? DEFAULT_MAX_INVESTMENT;
    }

    // Runtime per-(user, broker) cap for the rest of the local day. Kept apart from userSettingsCache because a config reload
    // replaces that whole entry (updateUserSettings) and must not undo the day's cuts; a stale day's override is ignored.
    private brokerCapOverride = new Map<string, { day: string; cap: number }>();
    setBrokerInvestmentCap(user: string, broker: string, cap: number): void {
        this.brokerCapOverride.set(`${user}|${broker}`, { day: localDayKey(), cap });
    }

    getUserUseGTT(user: string): boolean {
        return this.userSettingsCache.get(user)?.useGTT ?? true;
    }

    // A strategy with no explicit `userId:` in config.yml runs under its own
    // type name as a pseudo-user (StrategyFactory.createStrategy: userId =
    // config.userId || config.type) - there's no real per-email user account
    // for that pseudo-user, so userSettingsCache (populated from the Users
    // collection, keyed by email) never has an entry for it, and every
    // strategy's own `broker:` config field was silently ignored, always
    // falling back to the 'kite' default below regardless of what was
    // configured. Used only as a FALLBACK, after userSettingsCache, in
    // getUserBroker below - a real user's own account-level broker
    // preference must still win over a strategy's config broker if that
    // strategy was ever given an explicit `userId:` equal to a real email
    // (config's broker overriding a human's own setting with no log/error
    // would be a silent, surprising precedence hazard otherwise).
    private getStrategyConfigBroker(user: string): 'kite' | 'ant' | 'breeze' | undefined {
        const strategy = configService.getInstances().find((s) => (s.userId || s.type) === user);
        return strategy?.broker ? (normalizeBrokerName(strategy.broker) as 'kite' | 'ant' | 'breeze') : undefined;
    }

    getUserBroker(user: string): 'kite' | 'ant' | 'breeze' {
        const userBroker = this.userSettingsCache.get(user)?.broker;
        return userBroker ? (normalizeBrokerName(userBroker) as 'kite' | 'ant' | 'breeze') : this.getStrategyConfigBroker(user) ?? 'kite';
    }

    getUserPerOrderCap(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.perOrderCap;
    }

    // undefined signals "no per-user override" - callers fall back to their
    // own strategy-level config.yml value (see ContinuousStrategy.capitalCheck).
    getUserAllottedCapital(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.strategyCapital;
    }

    // undefined signals "no per-user override" - callers fall back to
    // config.yml's global settings.targetPriceDiff/stopLossPriceDiff (see
    // kiteExecutor.ts/antExecutor.ts's target/stopLoss point resolution).
    getUserTargetPoints(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.targetPoints;
    }

    getUserStopLossPoints(user: string): number | undefined {
        return this.userSettingsCache.get(user)?.stopLossPoints;
    }

    getUserContext(email: string): UserContext {
        const cache = this.userSettingsCache.get(email);
        const accountCapital = cache?.accountCapital ?? 0;
        return {
            email,
            lossLimit: cache?.lossLimit ?? UNKNOWN_USER_LOSS_LIMIT,
            lotLimit: cache?.lotLimit ?? DEFAULT_LOT_LIMIT,
            investmentMode: (cache?.investmentMode ?? 'investmentAmount') as 'lotCount' | 'investmentAmount',
            accountCapital,
            availableAmount: accountCapital - this.getCurrentInvestment(email),
        };
    }

    // Fallback only - callers that already resolved a contract from a broker's own contract
    // master (AntContractMaster/KiteContractMaster/BreezeContractMaster) should pass that
    // contract's own lotSize instead (see orderProcess.ts's resolveChunkedBuyQuantity), since
    // this name-based guess doesn't recognize every index and a wrong guess sizes an order to
    // a quantity the broker rejects as not a multiple of the real lot size (live 2026-10-21,
    // SENSEX sized against this 65 default instead of its real 20).
    getInstrumentLotSize(tsym: string): number {
        if (tsym.startsWith('BANKNIFTY')) return 15;
        if (tsym.startsWith('FINNIFTY')) return 25;
        if (tsym.startsWith('SENSEX')) return INDEX_LOT_SIZE.SENSEX;
        return INDEX_LOT_SIZE.NIFTY;
    }

    // Broker-agnostic manual-buy sizing: an explicit quantity always wins;
    // otherwise a user on investmentMode='investmentAmount' gets as many
    // lots as their remaining capital covers at the given price (at least
    // one lot if they have any headroom at all), and everyone else falls
    // back to a single lot - unchanged from the prior default behavior.
    resolveManualBuyQuantity(userId: string, tsym: string, price: number, explicitQuantity?: number): number {
        if (explicitQuantity != null) return explicitQuantity;
        const lotSize = this.getInstrumentLotSize(tsym);
        const ctx = this.getUserContext(userId);
        if (ctx.investmentMode === 'investmentAmount' && ctx.availableAmount > 0 && price > 0) {
            const lots = Math.max(1, Math.floor(ctx.availableAmount / (price * lotSize)));
            return lots * lotSize;
        }
        return lotSize;
    }

    // Used by chunkedBuyIndex (orderProcess.ts) when a caller passes
    // quantity: -1, meaning "spend whatever investment headroom is left" -
    // mirrors resolveManualBuyQuantity's lot-sizing-from-available-capital
    // math above, but driven by maxInvestment/getCurrentInvestment (the cap
    // BulkPcrStrategy-style pseudo-users actually use - see canPlaceOrder's
    // own comment) rather than investmentAmount/availableAmount, which only
    // real per-user accounts have configured. Nets out pendingValue() too
    // (not just confirmed trades), same as canPlaceOrder's own check.
    //
    // `broker` scopes getCurrentInvestment/pendingValue to that broker only -
    // maxInvestment is checked per (user, broker), not per user alone (see
    // canPlaceOrder's comment), so two configured brokers for the same
    // strategy pseudo-user (BulkPcrStrategy.enterOnBroker fires every
    // configured broker concurrently via Promise.allSettled) each size
    // against their OWN headroom instead of racing a single shared pool -
    // this closes the "together request up to ~2x maxInvestment" gap this
    // comment used to describe for the multi-broker case. A narrower race
    // remains WITHIN one broker: two concurrent chunkedBuyIndex calls for the
    // same (user, broker) whose own async price-fetches are both in flight
    // before either reaches markPending can still each compute against the
    // same full, undebited per-broker headroom - canPlaceOrder's post-hoc
    // ratchet check only blocks a THIRD such call once pending+current has
    // already reached that broker's cap, it does not shrink an in-flight one.
    // Returns 0 (never negative, never a fraction of a lot) when there's no
    // headroom left or the price/lotSize inputs are non-positive, so callers
    // can treat 0 as "nothing to buy" uniformly instead of special-casing
    // negative/NaN.
    resolveMaxInvestmentQuantity(user: string, pricePerUnit: number, lotSize: number, broker?: string): number {
        if (!(pricePerUnit > 0) || !(lotSize > 0)) return 0;
        const available = this.getUserMaxInvestment(user, broker) - this.getCurrentInvestment(user, broker) - this.pendingValue(user, broker);
        if (available <= 0) return 0;
        const lots = Math.floor(available / (pricePerUnit * lotSize));
        return lots * lotSize;
    }

    getTradedLots(user: string): number {
        return this.trades
            .filter((t) => t.user === user)
            .reduce((sum, t) => sum + Math.ceil(t.quantity / this.getInstrumentLotSize(t.tsym)), 0);
    }

    hasActiveTrade(user: string): boolean {
        return this.trades.some((t) => t.user === user) || (this.pendingOrders.get(user)?.length ?? 0) > 0;
    }

    getOpenTrades(user: string): Trade[] {
        return this.trades.filter((t) => t.user === user);
    }

    // `broker` scopes the sum to this user's trades on that broker only - see
    // canPlaceOrder's own comment for why maxInvestment is now checked per
    // (user, broker). Omitted, sums across every broker (the original,
    // user-wide behavior still used by callers - e.g. getUserContext - that
    // intentionally want the whole-user total).
    getCurrentInvestment(user: string, broker?: string): number {
        return this.trades
            .filter((t) => t.user === user && (broker === undefined || t.broker === broker))
            .reduce((sum, t) => sum + t.price * t.quantity, 0);
    }

    // Called by orderProcess.ts immediately after canPlaceOrder() returns
    // allowed:true and before the broker call, so a concurrent canPlaceOrder()
    // call for the same user sees this reservation for the duration of the
    // broker round trip - this is what closes the race where two concurrent
    // requests both read only confirmed trades and both pass. Every
    // markPending() must be paired with exactly one releasePending() call -
    // either from the fill path (_processTradeEvent, already wired) or from
    // orderProcess.ts's failure path (placeOrderWithPendingGuard) - or the
    // reservation leaks and this user is blocked until the next fill.
    markPending(user: string, estimatedOrderValue?: number, broker?: string): PendingOrder {
        const list = this.pendingOrders.get(user) ?? [];
        const entry: PendingOrder = { estimatedLots: 1, estimatedValue: estimatedOrderValue ?? 0, broker };
        list.push(entry);
        this.pendingOrders.set(user, list);
        return entry;
    }

    // The reservation owned by the request currently being placed (set by runWithReservation). A chunked order
    // records one fill per chunk, each calling releasePending: inside the owning request's async context those
    // releases target ITS reservation (a no-op once gone) instead of draining other in-flight requests' entries.
    private reservationContext = new AsyncLocalStorage<{ user: string; entry: PendingOrder }>();

    runWithReservation<T>(user: string, entry: PendingOrder, fn: () => Promise<T>): Promise<T> {
        return this.reservationContext.run({ user, entry }, fn);
    }

    // Releases exactly this reservation (by identity); no-op if it was already released.
    releaseReservation(user: string, entry: PendingOrder): void {
        const list = this.pendingOrders.get(user);
        if (!list) return;
        const idx = list.indexOf(entry);
        if (idx === -1) return;
        list.splice(idx, 1);
        if (list.length === 0) this.pendingOrders.delete(user);
    }

    // Releases the reservation a resting limit buy took when it was placed (matched by broker order id). Returns false when no
    // reservation carries that id (already released by its fill, a market buy, or lost in a restart). A cancelled or rejected
    // resting buy never fills, so without this its reservation leaked until restart: 2026-10-28 ~150k of phantom pending value
    // made ContinuousStrategy's max-investment gate reject every hedge for an open leg.
    releaseReservationForOrder(orderId: string): boolean {
        const id = String(orderId);
        for (const [user, list] of this.pendingOrders) {
            const idx = list.findIndex((p) => p.orderId === id);
            if (idx === -1) continue;
            list.splice(idx, 1);
            if (list.length === 0) this.pendingOrders.delete(user);
            return true;
        }
        return false;
    }

    // Releases exactly one pending reservation for `user` - never all of them -
    // so releasing/resolving one in-flight order can't silently drop a
    // different, still-in-flight order's reservation for the same user. Safe
    // to call when nothing is pending (no-op), so both the fill path and
    // orderProcess's failure path can call it unconditionally.
    //
    // When `broker` is given, releases the oldest reservation tagged with
    // THAT broker, not just the oldest overall - a plain user-wide FIFO would
    // otherwise sometimes release a different broker's reservation (e.g. two
    // concurrent legs for the same strategy pseudo-user on kite and
    // breeze), permanently leaking the broker whose own order this call is
    // actually for while wrongly freeing up headroom for the other. Falls
    // back to the oldest entry overall if no entry tagged with this broker is
    // found (e.g. broker omitted, or every pending caller for this user left
    // it undefined) - matches the old plain-FIFO behavior for single-broker
    // users.
    releasePending(user: string, broker?: string, filledValue?: number): void {
        const ctx = this.reservationContext.getStore();
        if (ctx && ctx.user === user) {
            // A chunked request books one fill per chunk: consume only that chunk's value so the unfilled remainder stays reserved
            // (releasing it all on the first chunk let a concurrent request pass the investment gate against that headroom). The
            // caller releases the residual once the request returns (placeOrderWithPendingGuard).
            if (filledValue !== undefined && Number.isFinite(filledValue) && filledValue > 0 && ctx.entry.estimatedValue > filledValue) {
                ctx.entry.estimatedValue -= filledValue;
                ctx.entry.filledInContext = true;
                return;
            }
            this.releaseReservation(user, ctx.entry);
            return;
        }
        const list = this.pendingOrders.get(user);
        if (!list || list.length === 0) return;
        const idx = broker !== undefined ? list.findIndex((p) => p.broker === broker) : 0;
        list.splice(idx === -1 ? 0 : idx, 1);
        if (list.length === 0) this.pendingOrders.delete(user);
    }

    private pendingLots(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedLots, 0);
    }

    // `broker` scopes the sum to reservations tagged with that broker only -
    // see canPlaceOrder's own comment on why maxInvestment is now checked per
    // (user, broker), not per user alone. Omitted (undefined), it sums every
    // pending reservation for this user regardless of broker - the original,
    // user-wide behavior still used by callers that don't need per-broker
    // scoping.
    private pendingValue(user: string, broker?: string): number {
        return (this.pendingOrders.get(user) ?? [])
            .filter((p) => broker === undefined || p.broker === broker)
            .reduce((sum, p) => sum + p.estimatedValue, 0);
    }

    private static startOfDay(): Date {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Realized P&L only (not unrealized/open-position exposure), summed from
    // the closedTrades collection (see persistClosedTrade) rather than the
    // in-memory, never-resetting userPnL map, so the daily/weekly window is
    // correct across process restarts. Returns 0 (never blocks) on a Mongo
    // hiccup - matches this file's existing "don't let Mongo block live
    // trading" convention (see persistClosedTrade's comment).
    // Returns null when the ledger cannot be read. Callers that gate on this
    // (the drawdown checks) must fail closed on null, not treat it as zero loss.
    private async getRealizedPnLSince(user: string, since: Date): Promise<number | null> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db) return null;
            // recentlyLanded keeps just-written rows visible briefly, so a row that commits after the
            // find scanned but leaves unpersistedClosed before the second snapshot is still counted.
            type HeldRow = { user: string; realizedPnL: number; exitTime: Date };
            const snapshotHeld = (): [string, HeldRow][] => {
                const cutoff = Date.now() - RECENTLY_LANDED_MS;
                for (const [id, r] of this.recentlyLanded) if (r.at < cutoff) this.recentlyLanded.delete(id);
                return [...this.unpersistedClosed.entries(), ...this.recentlyLanded.entries()]
                    .filter(([, p]) => p.user === user && p.exitTime >= since);
            };
            // Snapshot held rows both BEFORE and AFTER the read, unioned by _id. Before: covers a row
            // whose insert commits after the find but returns (and leaves the map) before the second
            // snapshot. After: covers a row added while the find was running. Anything in either
            // snapshot that the read also returned is deduped below.
            const before = snapshotHeld();
            const rows = await withFallbackTimeout(
                db.collection('closedTrades').find({ user, exitTime: { $gte: since } }).toArray(),
                LEDGER_TIMEOUT_MS, null, 'closedTrades read');
            if (rows === null) return null;
            const heldSnapshot = [...new Map<string, HeldRow>([...before, ...snapshotHeld()]).entries()];
            // Held rows that have already landed are counted once, by their _id.
            const landed = new Set(rows.map((r) => String(r._id)));
            const held = heldSnapshot
                .filter(([id]) => !landed.has(id))
                .reduce((sum, [, p]) => sum + p.realizedPnL, 0);
            return rows.reduce((sum, r) => sum + (r.realizedPnL || 0), 0) + held;
        } catch (e) {
            Log.log('[order] getRealizedPnLSince failed - drawdown check will block until it can be read:', e);
            return null;
        }
    }

    // Only users with an investmentAmount configured are subject to these -
    // strategy pseudo-users (see orderProcess.ts loadUserLimits) never get
    // investmentAmount populated, and 25%/50% of an unset (0) amount would
    // instantly block every automated strategy.
    // 'unknown' means the ledger could not be read. New buys are blocked on
    // anything other than 'ok'; the sell-side liquidation trigger acts only on
    // a definite 'breached' - an unreadable ledger must never close positions.
    // True when `user` is a configured strategy instance (a pseudo-user), not a real account.
    isStrategyUser(user: string): boolean {
        return configService.getInstances().some((s) => (s.userId || s.type) === user);
    }

    async drawdownState(user: string, window: 'daily' | 'weekly'): Promise<'ok' | 'breached' | 'unknown'> {
        // The account drawdown limits are for real users only. A strategy runs under its own loss stops (maxLoss, maxLossPerOrder, ...), and a
        // strategy instance must never be blocked or liquidated by them, whatever accountCapital happens to be cached for its id.
        if (this.isStrategyUser(user)) return 'ok';
        const accountCapital = this.userSettingsCache.get(user)?.accountCapital;
        if (!accountCapital) return 'ok';
        // Once today's daily breach is latched it stays breached for the day, even if the position that caused it closed at a better price.
        if (window === 'daily' && this.drawdownLatched(user)) return 'breached';
        const settings = configService.getConfig().settings as any;
        const limitPercent = window === 'daily'
            ? drawdownLimit(settings, 'maxDailyDrawdownPercent')
            : drawdownLimit(settings, 'maxWeeklyDrawdownPercent');
        const since = window === 'daily' ? OrderBookkeeping.startOfDay() : startOfWeek();
        const pnl = await this.getRealizedPnLSince(user, since);
        // Daily only: open P&L at live prices counts toward the daily loss (maxloss.md B4.2). A failed price adds 0.
        const unrealized = window === 'daily'
            ? await withFallbackTimeout(this.getOpenUnrealizedPnL(user), OPEN_PNL_TIMEOUT_MS, null, 'open P&L pricing')
            : null;
        const total = pnl === null ? null : pnl + (unrealized ?? 0);
        return drawdownDecision(total, accountCapital, limitPercent);
    }

    // Open P&L of this user's positions at live ANT prices (maxloss.md B4.1). Long: (ltp - price) * qty; short: the reverse.
    // The token comes from the trading symbol via AntContractMaster, not Trade.token: Kite and Breeze rows carry their own
    // broker's instrument token there, which ANT would price as a different contract. Returns null when no row could be priced.
    // Never throws; a row whose quote fails counts as 0 (a failed quote must never by itself breach the limit).
    private openPnlLogAt = 0;
    async getOpenUnrealizedPnL(user: string): Promise<number | null> {
        const rows: Array<{ trade: Trade; sign: 1 | -1 }> = [
            ...this.trades.filter((t) => t.user === user).map((trade) => ({ trade, sign: 1 as const })),
            ...this.shortTrades.filter((t) => t.user === user).map((trade) => ({ trade, sign: -1 as const })),
        ];
        if (rows.length === 0) return 0;
        const quotes = new Map<string, Promise<number>>(); // one live quote per token, shared by every row on it
        let total = 0;
        let priced = 0;
        let failed = 0;
        for (const { trade, sign } of rows) {
            let token: string | undefined;
            try {
                const exch = exchangeForTsym(trade.tsym);
                token = AntContractMaster.getInstance().findByTradingSymbol(trade.tsym, exch)?.token;
                if (!token || !Number.isFinite(trade.price) || !(trade.quantity > 0)) { failed++; continue; }
                let ltp = quotes.get(token);
                if (!ltp) {
                    ltp = ANT.getInstance().getLiveQuote(exch, token).then((q) => q.ltp);
                    quotes.set(token, ltp);
                }
                const price = await ltp;
                if (!(price > 0)) { failed++; continue; }
                total += sign * (price - trade.price) * trade.quantity;
                priced++;
            } catch (e) {
                failed++;
                if (token) quotes.delete(token); // a failed quote is retried on the next call, not cached
            }
        }
        if (failed > 0 && Date.now() - this.openPnlLogAt > OPEN_PNL_LOG_EVERY_MS) {
            this.openPnlLogAt = Date.now();
            Log.log(`[order] open P&L for ${user}: ${failed}/${rows.length} position(s) could not be priced live - counted as 0`);
        }
        return priced === 0 ? null : total;
    }

    // Users whose daily drawdown breached today (maxloss.md B4.4). Persisted so a restart keeps buys blocked.
    private drawdownLatchedDay = new Map<string, string>();
    private drawdownLatched(user: string): boolean {
        return this.drawdownLatchedDay.get(user) === dayKeyLocal();
    }

    private latchDrawdown(user: string): void {
        const day = dayKeyLocal();
        this.drawdownLatchedDay.set(user, day);
        Mongo.getInstance()?.db.collection('strategyLatches')
            .updateOne({ ownerType: 'user', userId: user, scope: 'drawdown', day }, { $set: { updatedAt: new Date() } }, { upsert: true })
            .catch((e) => Log.log(`[order] drawdown latch write failed for ${user} (in-memory latch still holds):`, e));
    }

    // Startup: restores today's drawdown latches. A read failure leaves them unset but logs loudly.
    async loadDrawdownLatches(): Promise<void> {
        try {
            const day = dayKeyLocal();
            const rows = await Mongo.getInstance()?.db.collection('strategyLatches')
                .find({ ownerType: 'user', scope: 'drawdown', day }).toArray();
            for (const r of rows ?? []) this.drawdownLatchedDay.set(String(r.userId), day);
            if (rows?.length) Log.log(`[order] drawdown latch restored for today: ${rows.map((r: any) => r.userId).join(', ')}`);
        } catch (e) {
            Log.log('[order] ALERT: could not read drawdown latches - continuing UNLATCHED (realized check still applies):', e);
        }
    }

    // Periodic daily-drawdown evaluation for users with open positions (maxloss.md B4.3): open P&L moves between fills.
    // Per-user in-flight guard so a slow pass never overlaps the next tick for the same user.
    private drawdownEvalInFlight = new Set<string>();
    async evaluateOpenDrawdowns(): Promise<void> {
        const users = new Set([...this.trades, ...this.shortTrades].map((t) => t.user));
        for (const user of users) {
            if (this.isStrategyUser(user) || !this.userSettingsCache.get(user)?.accountCapital) continue; // strategy pseudo-users are skipped by design
            if (this.drawdownEvalInFlight.has(user)) continue;
            this.drawdownEvalInFlight.add(user);
            try {
                await this.checkBreachAndNotify(user);
            } finally {
                this.drawdownEvalInFlight.delete(user);
            }
        }
    }

    // Runs the daily/weekly check after a fill and acts on it. 'breached' fires
    // the liquidation listeners; 'unknown' (ledger unreadable) schedules a
    // re-check. Only a definite breach liquidates.
    private async checkBreachAndNotify(user: string): Promise<void> {
        try {
            // Not awaited: held rows are counted in the read below either way, so a slow flush must not stall the decision.
            this.flushUnpersistedClosed().catch((e) => Log.log('[order] flush of held closedTrades failed:', e));
            const daily = await this.drawdownState(user, 'daily');
            // Evaluated even when the daily limit is breached: the weekly breach closes the account and a latched
            // daily breach would otherwise mask it for the rest of the day.
            const weekly = await this.drawdownState(user, 'weekly');
            if (weekly === 'breached') this.closeAccountForWeeklyBreach(user);
            if (daily === 'breached' || weekly === 'breached') {
                if (daily === 'breached' && !this.drawdownLatched(user)) this.latchDrawdown(user);
                this.cancelDrawdownRecheck(user);
                for (const l of this.drawdownBreachListeners) l(user);
            } else if (daily === 'unknown' || weekly === 'unknown') {
                this.scheduleDrawdownRecheck(user);
            }
        } catch (e) {
            // A failed check must not silently drop enforcement: re-check later.
            Log.log('[order] drawdown check failed for', user, '- re-checking:', e);
            this.scheduleDrawdownRecheck(user);
        }
    }

    // Weekly drawdown breach closes the account: the user document is kept and flagged accountClosed, and
    // canPlaceOrder rejects every new order for a closed account. The cache flag is set synchronously so the
    // block is immediate; the Mongo write is retried on the next breach evaluation if it fails.
    private closeAccountForWeeklyBreach(user: string): void {
        const settings = this.userSettingsCache.get(user);
        if (!settings || settings.accountClosed) return;
        settings.accountClosed = true;
        settings.closedAtMs = Date.now();
        const reason = `Weekly loss limit of ${drawdownLimit(configService.getConfig().settings as any, 'maxWeeklyDrawdownPercent')}% breached`;
        Log.log(`[order] Account closed for ${user}: ${reason}`);
        closeUserAccount(user, reason).catch((e) => {
            settings.accountClosed = false;
            Log.log(`[order] Failed to persist account closure for ${user} (will retry on the next breach check):`, e);
        });
    }

    private drawdownRecheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private cancelDrawdownRecheck(user: string): void {
        const timer = this.drawdownRecheckTimers.get(user);
        if (timer) clearTimeout(timer);
        this.drawdownRecheckTimers.delete(user);
    }

    // While the ledger is unreadable, re-check every 60s. Does not give up while
    // the user still has open positions - a breach during an outage must still be
    // enforced once reads succeed. Stops once nothing is open.
    private scheduleDrawdownRecheck(user: string): void {
        if (this.drawdownRecheckTimers.has(user)) return;
        const timer = setTimeout(async () => {
            this.drawdownRecheckTimers.delete(user);
            const hasOpen = this.trades.some((t) => t.user === user) || this.shortTrades.some((t) => t.user === user);
            if (!hasOpen) return;
            try {
                await this.checkBreachAndNotify(user);
            } catch (e) {
                Log.log('[order] drawdown re-check failed for', user, e);
                this.scheduleDrawdownRecheck(user);
            }
        }, 60_000);
        this.drawdownRecheckTimers.set(user, timer);
    }

    // estimatedOrderValue is necessarily approximate for index-based buys
    // (niftyLtp * quantity - the real option premium isn't known until
    // contract selection) but exact for buyContract's price * quantity.
    // Strategy TYPES (not literal userId strings) that get the capital-only
    // exemption below - resolved via config.yml's own `type` field, keyed by
    // (userId || type), rather than a hardcoded userId literal. A literal
    // check (`user === 'BulkPcrStrategy'`) silently stops matching the
    // moment a second instance of that type is configured under its own
    // `userId` (e.g. 'BulkPcr-NIFTY'/'BulkPcr-SENSEX') - exactly the
    // type-vs-instance gap BulkPcrStrategy.cfg()/ButterflyStrategy.cfg()
    // already guard against for their OWN config reads; this is the same
    // mistake, just inside the shared risk gate instead of a strategy's own
    // config lookup.
    private static readonly CAPITAL_ONLY_EXEMPT_TYPES = ['ContinuousStrategy', 'SimpleContinuousStrategy', 'ScaledHedgedContinuousStrategy', 'BulkPcrStrategy', 'HourlyStrategy'];

    private isCapitalOnlyExemptUser(user: string): boolean {
        const cfg = configService.getInstances().find((s) => (s.userId || s.type) === user);
        return !!cfg && OrderBookkeeping.CAPITAL_ONLY_EXEMPT_TYPES.includes(cfg.type);
    }

    // `broker`, when given, scopes the maxInvestment check to this user's
    // trades/pending reservations on THAT broker only, instead of pooling
    // every broker a multi-broker strategy pseudo-user trades under one
    // shared cap - e.g. TopStockOptionsOpeningGapStrategy/BulkPcrStrategy
    // running the same userId across kite/breeze/ant, each with its own
    // maxInvestment headroom rather than racing (and potentially starving
    // each other out of) one pooled number. Every OTHER check here (lot
    // limit, per-order cap, drawdown, daily trade count) stays user-wide -
    // only capital usage is broker-scoped, since those others are either
    // already no-ops for strategy pseudo-users (see this function's own
    // exemption comment) or are deliberately meant to bound the user as a
    // whole regardless of which broker a given leg happens to run on.
    // skipInvestmentCap: honoured only for the capital-only-exempt strategy pseudo-users below (BulkPcr's hedge re-buy, which re-opens a slot the
    // cap already counted: live 2026-10-30 a cap refusal left a put naked). Every other gate, and every other user, is unchanged.
    async canPlaceOrder(user: string, estimatedOrderValue?: number, broker?: string, skipInvestmentCap = false): Promise<{ allowed: boolean; reason?: string }> {
        // ContinuousStrategy manages its own risk (per-leg averaging/hedging,
        // its own allottedCapital gate in ContinuousStrategy.capitalCheck())
        // and was hitting the shared daily-trade-count limit on ordinary
        // multi-leg activity - at the user's request, only the capital-usage
        // check below still gates it; lot limit, per-order cap, drawdown
        // breach, and the trade-count limit are skipped entirely.
        //
        // BulkPcrStrategy gets the same exemption, at the user's request
        // 2026-09-23 - it hit the (since removed) shared trade-count limit
        // purely from live testing, and it already self-manages via its own
        // `maxInvestment` config field, same as ContinuousStrategy. Lot
        // limit is a non-issue for it anyway (getTradedLots only counts
        // currently-open trades, which reset to 0 every time a cycle fully
        // sells out), and per-order cap/drawdown are already no-ops for any
        // strategy pseudo-user (see drawdownState's comment - they
        // never have investmentAmount configured).
        // HourlyStrategy gets the same exemption for the same reason - its own
        // `quantity: -1` config sentinel (same value BulkPcrStrategy uses, not
        // a separate per-type magic number) sizes off this same
        // maxInvestment-only gate.
        if (this.isCapitalOnlyExemptUser(user)) {
            const currentInvestment = this.getCurrentInvestment(user, broker) + this.pendingValue(user, broker);
            const maxInvestment = this.getUserMaxInvestment(user, broker);
            if (currentInvestment >= maxInvestment) {
                if (skipInvestmentCap) {
                    Log.log(`[order] hedge re-buy for '${user}'${broker ? ` (${broker})` : ''} allowed over the max-investment cap (${currentInvestment}/${maxInvestment}): it re-opens a slot the cap already counted`);
                    return { allowed: true };
                }
                return { allowed: false, reason: `User '${user}'${broker ? ` (${broker})` : ''} has reached max investment (${currentInvestment}/${maxInvestment}).` };
            }
            return { allowed: true };
        }
        const tradedLots = this.getTradedLots(user) + this.pendingLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        const currentInvestment = this.getCurrentInvestment(user, broker) + this.pendingValue(user, broker);
        const maxInvestment = this.getUserMaxInvestment(user, broker);
        if (currentInvestment >= maxInvestment) {
            return { allowed: false, reason: `User '${user}'${broker ? ` (${broker})` : ''} has reached max investment (${currentInvestment}/${maxInvestment}).` };
        }
        const perOrderCap = this.getUserPerOrderCap(user);
        if (estimatedOrderValue !== undefined && perOrderCap !== undefined && estimatedOrderValue > perOrderCap) {
            return { allowed: false, reason: `Order value ₹${estimatedOrderValue.toFixed(2)} exceeds per-order cap ₹${perOrderCap}.` };
        }
        if (this.userSettingsCache.get(user)?.accountClosed) {
            const reason = `User '${user}' account is closed (weekly loss limit breached).`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        const dailyDrawdown = await this.drawdownState(user, 'daily');
        if (dailyDrawdown !== 'ok') {
            const reason = dailyDrawdown === 'breached'
                ? `User '${user}' has reached the maximum daily drawdown.`
                : `User '${user}' daily drawdown could not be verified (trade ledger unreadable) - buys blocked.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        const weeklyDrawdown = await this.drawdownState(user, 'weekly');
        if (weeklyDrawdown === 'breached') this.closeAccountForWeeklyBreach(user);
        if (weeklyDrawdown !== 'ok') {
            const reason = weeklyDrawdown === 'breached'
                ? `User '${user}' has reached the maximum weekly drawdown.`
                : `User '${user}' weekly drawdown could not be verified (trade ledger unreadable) - buys blocked.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        return { allowed: true };
    }

    // `order` writes drawdown notifications directly to Mongo (own connection)
    // but can't push SSE itself - SSE terminates in the `frontend` process,
    // which polls the `notifications` collection for unread items instead
    // (see server.ts's /notificationstream). Only fires once per threshold
    // per session so a losing streak doesn't spam a notification per trade.
    private checkDrawdownNotification(user: string, cumulative: number) {
        const limit = this.getUserLossLimit(user);
        if (limit <= 0 || cumulative >= 0) return;
        const pctOfLimit = (-cumulative / limit) * 100;
        const notified = this.notifiedThresholds.get(user) ?? new Set<number>();
        for (const [threshold, type] of [[100, 'drawdown_breach'], [80, 'drawdown_warning']] as const) {
            if (pctOfLimit >= threshold && !notified.has(threshold)) {
                // Only what was actually crossed: an 80% warning must not mark the 100% breach as already sent.
                notified.add(threshold);
                if (threshold === 100) notified.add(80); // a breach implies the warning was passed
                Mongo.getInstance()?.db.collection('notifications').insertOne({
                    user,
                    type,
                    message: `You've reached ${pctOfLimit.toFixed(0)}% of your session loss limit (₹${(-cumulative).toFixed(2)} of ₹${limit}).`,
                    read: false,
                    createdAt: new Date(),
                }).catch((e) => Log.log('[order] Failed to write drawdown notification for', user, ':', e));
                break; // higher threshold implies the lower one - only notify the highest newly-crossed
            }
        }
        this.notifiedThresholds.set(user, notified);
    }

    // Captures the day/cumulative-P&L/threshold numbers already in the
    // rejection reason string, structured, so a trader-facing "why was this
    // order rejected" screen can be built without re-deriving them later.
    // Fire-and-forget, same-process insert (order has its own Mongo connection).
    private logOrderRejection(user: string, reason: string) {
        Mongo.getInstance()?.db.collection('payoutDecisionLog').insertOne({
            user,
            type: 'order_rejected',
            reason,
            detail: {
                cumulativePnL: this.userPnL.get(user) || 0,
                lossLimitThreshold: this.getUserLossLimit(user),
            },
            createdAt: new Date(),
        }).catch((e) => Log.log('[order] Failed to log order rejection for', user, ':', e));
    }

    trackPendingOrder(tsym: string, user: string) {
        const queue = this.pendingOrdersByTsym.get(tsym) || [];
        queue.push(user);
        this.pendingOrdersByTsym.set(tsym, queue);
    }

    clearPendingOrder(tsym: string, user: string) {
        const queue = this.pendingOrdersByTsym.get(tsym);
        if (!queue) return;
        const idx = queue.indexOf(user);
        if (idx !== -1) queue.splice(idx, 1);
        if (queue.length === 0) this.pendingOrdersByTsym.delete(tsym);
    }

    trackOrder(orderNo: string, user: string) {
        this.orderUserMap.set(orderNo, user);
    }

    resolveUser(orderNo: string, tsym?: string): string {
        if (orderNo) {
            const user = this.orderUserMap.get(orderNo);
            if (user) return user;
        }
        if (tsym) {
            const queue = this.pendingOrdersByTsym.get(tsym);
            if (queue && queue.length > 0) return queue[0];
        }
        return 'Default';
    }

    clearOrder(orderNo: string) {
        if (orderNo) this.orderUserMap.delete(orderNo);
    }

    refreshTrades(trades: Trade[]) {
        this.trades = trades;
        this.trades.forEach((t) => (t.lastTradePrice = t.price));
    }

    // True when a raw fill doc for this broker order and side is already in Mongo. Fails open (false) if Mongo is unreadable:
    // a fill must never be dropped just because the lookup failed.
    private async fillAlreadyStored(tradeEvent: Trade): Promise<boolean> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db || !tradeEvent.brokerOrderId) return false;
            const hit = await db.collection('Trade').findOne({ brokerOrderId: tradeEvent.brokerOrderId, action: tradeEvent.action }, { projection: { _id: 1 } });
            return !!hit;
        } catch (e) {
            Log.log('[order] fillAlreadyStored: Mongo lookup failed (treating as not stored):', tradeEvent.brokerOrderId, e);
            return false;
        }
    }

    // Records a fill directly (used by the Kite buy/GTT-trigger path, which
    // doesn't go through Prism's websocket 'om' message shape at all).
    async recordFill(tradeEvent: Trade): Promise<void> {
        let skipInsert = false;
        const id = tradeEvent.brokerOrderId;
        if (id) {
            if (this.processedFillIds.has(id)) {
                Log.log(`[order] Ignoring redelivered fill for broker order ${id} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            // Claim the id BEFORE the first await: the Mongo lookup below yields, and two concurrent deliveries of the same
            // order (exit path + poller) would otherwise both pass has() and both book it.
            this.processedFillIds.add(id);
            try {
                // Let an in-flight raw-doc insert for this order settle so the lookup below does not race the write (bounded: a hung
                // driver call must not wedge the claimed id).
                const inflight = this.pendingFillInserts.get(id);
                if (inflight) await Promise.race([inflight, new Promise((r) => setTimeout(r, 5000))]);
                // processedFillIds dies with the process; the raw fill doc does not. A restart used to forget it, so the same broker
                // order was booked a second time (real 2026-10-27: one Kite sell sat in Mongo under two users).
                if (await this.fillAlreadyStored(tradeEvent)) {
                    if (!this.failedBookingFillIds.has(id)) {
                        Log.log(`[order] Ignoring fill for broker order ${id} (${tradeEvent.tsym}) - already stored in Mongo`);
                        return; // id stays claimed
                    }
                    // A previous attempt wrote the raw doc then threw before the in-memory update: this retry must update memory
                    // but not insert the doc a second time (restore nets Buy docs, a duplicate would double the position).
                    skipInsert = true;
                }
                // First writer wins: resting orders were recorded at placement, so this only fills in the owner of orders that fill
                // in the same call that placed them.
                recordOrderOwner(id, tradeEvent.user, tradeEvent.broker ?? 'kite');
            } catch (e) {
                this.processedFillIds.delete(id);
                throw e;
            }
        }
        try {
            await this._processTradeEvent(tradeEvent, skipInsert);
        } catch (e) {
            // Not booked in memory: release the id so a retry is processed instead of silently dropped as a duplicate, and
            // remember that the raw doc may already exist so the retry does not mistake it for a completed booking.
            if (id) {
                this.processedFillIds.delete(id);
                this.failedBookingFillIds.add(id);
            }
            throw e;
        }
        if (id) this.failedBookingFillIds.delete(id);
        for (const l of this.fillListeners) l(tradeEvent.user || 'Default', tradeEvent);
    }

    // Dedicated recorder for a strategy's own SellToOpen/BuyToClose fills (e.g.
    // ButterflyStrategy's short legs). Never routes through _processTradeEvent's Buy/Sell
    // branches: those assume every Buy opens/adds-to a long and every Sell reduces an
    // existing long-trades entry (no-op, zero audit trail, if none exists) - a BuyToClose
    // recorded as a plain 'Buy' there would hit the "no existing entry" case and wrongly
    // create a phantom open-long that nothing ever naturally closes. Additive only - every
    // other strategy's bookkeeping behavior via recordFill/_processTradeEvent is untouched.
    async recordShortFill(tradeEvent: Trade): Promise<void> {
        if (tradeEvent.brokerOrderId) {
            if (this.processedFillIds.has(tradeEvent.brokerOrderId)) {
                Log.log(`[order] Ignoring redelivered short fill for broker order ${tradeEvent.brokerOrderId} (${tradeEvent.tsym}) - already processed`);
                return;
            }
            this.processedFillIds.add(tradeEvent.brokerOrderId);
        }
        Log.log(`[order] ${tradeEvent.action} (short) ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        tradeEvent.entryTime = new Date();
        Mongo.getInstance()?.insert(tradeEvent).catch((e) => {
            Log.log('[order] Mongo insert failed for short fill (continuing without persistence):', tradeEvent.tsym, e);
        });

        if (tradeEvent.action === 'SellToOpen') {
            const idx = this.shortTrades.findIndex((t) => t.tsym === tradeEvent.tsym && t.user === tradeEvent.user && t.broker === tradeEvent.broker);
            if (idx === -1) {
                this.shortTrades.push(tradeEvent);
            } else {
                const t = this.shortTrades[idx];
                const traded = t.quantity * t.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                t.quantity += tradeEvent.quantity;
                t.price = (traded + newTraded) / t.quantity;
            }
        } else if (tradeEvent.action === 'BuyToClose') {
            const idx = this.shortTrades.findIndex((t) => t.tsym === tradeEvent.tsym && t.user === tradeEvent.user && t.broker === tradeEvent.broker);
            if (idx === -1) {
                Log.log(`[order] WARNING: BuyToClose for ${tradeEvent.tsym} (${tradeEvent.user}) has no matching SellToOpen entry - dropping (no phantom position created)`);
                this.notifyPositionsChanged();
                return;
            }
            const shortTrade = this.shortTrades[idx];
            // Clamp, same discipline _processTradeEvent's long-side Sell branch uses - a
            // strategy bug or a desynced close must never go negative here.
            const closeQty = Math.min(tradeEvent.quantity, shortTrade.quantity);
            if (tradeEvent.quantity > shortTrade.quantity) {
                Log.log(`[order] WARNING: BuyToClose qty ${tradeEvent.quantity} for ${tradeEvent.tsym} (${tradeEvent.user}) exceeds tracked short qty ${shortTrade.quantity} - clamping`);
            }
            // Reversed vs. the long P&L formula in _processTradeEvent: a short profits when
            // price falls (sold high, bought back low).
            const realizedPnL = (shortTrade.price - tradeEvent.price) * closeQty;
            const user = shortTrade.user || 'Default';
            const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
            this.userPnL.set(user, cumulative);
            this.checkDrawdownNotification(user, cumulative);

            const closedPortion = new Trade();
            closedPortion.tsym = shortTrade.tsym;
            closedPortion.token = shortTrade.token;
            closedPortion.quantity = closeQty;
            closedPortion.price = shortTrade.price;
            closedPortion.action = 'BuyToClose';
            closedPortion.user = user;
            closedPortion.broker = shortTrade.broker;
            closedPortion.open = false;
            closedPortion.realizedPnL = realizedPnL;
            closedPortion.entryTime = shortTrade.entryTime;
            closedPortion.exitTime = new Date();
            closedPortion.strategy = shortTrade.strategy;
            this.closedTrades.push(closedPortion);
            this.persistClosedTrade(closedPortion, user, tradeEvent.price);

            shortTrade.quantity -= closeQty;
            if (shortTrade.quantity <= 0) this.shortTrades.splice(idx, 1);
        } else {
            Log.log(`[order] WARNING: recordShortFill called with unexpected action '${tradeEvent.action}' for ${tradeEvent.tsym} - ignoring (expected SellToOpen/BuyToClose)`);
            return;
        }
        this.notifyPositionsChanged();
    }

    // Prism/Shoonya websocket 'om' message shape - kept for the legacy order path.
    async updateTradeFromPrismMessage(data: any): Promise<Trade | void> {
        const user = this.resolveUser(data.norenordno, data.tsym);
        if (data.flqty == undefined) return;

        const tradeEvent = new Trade();
        tradeEvent.tsym = data.tsym as string;
        tradeEvent.quantity = parseInt(data.qty);
        tradeEvent.price = parseFloat(data.flprc);
        tradeEvent.action = data.trantype == 'S' ? 'Sell' : 'Buy';
        tradeEvent.status = data.status;
        tradeEvent.right = tradeEvent.tsym.indexOf('P') !== -1 ? PUT : CALL;
        tradeEvent.user = user;
        tradeEvent.broker = 'prism';
        tradeEvent.brokerOrderId = data.norenordno;
        if (tradeEvent.action == 'Buy') tradeEvent.lastTradePrice = tradeEvent.price;

        const isCompleted = data.fillshares == data.qty && data.status == 'COMPLETE';
        if (!isCompleted) return;

        this.clearOrder(data.norenordno);
        await this.recordFill(tradeEvent);
        return tradeEvent;
    }

    private async _processTradeEvent(tradeEvent: Trade, skipInsert = false) {
        Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        // Every raw fill doc needs a real entryTime, not just a token's first
        // fill - restoreOneOpenTrade's `entryTime: { $gte: startOfDay() }`
        // query otherwise silently excludes later same-day fills (e.g. an
        // averaging buy) from restart recovery.
        tradeEvent.entryTime = new Date();
        // Fire-and-forget, same convention as checkDrawdownNotification/
        // persistClosedTrade elsewhere in this class - never let a Mongo
        // hiccup block live bookkeeping. The .catch() (not a try/catch,
        // which cannot catch a rejection from a promise that isn't awaited)
        // is what actually prevents an unhandled promise rejection from
        // crashing the `order` process on a transient Mongo error.
        if (!skipInsert) {
            const p = Mongo.getInstance()?.insert(tradeEvent).catch((e) => {
                Log.log('[order] Mongo insert failed for trade event (continuing without persistence):', tradeEvent.tsym, e);
            });
            const oid = tradeEvent.brokerOrderId;
            if (p && oid) {
                // Chained with any earlier insert for the same order so a retry waits for all of them, not just the latest.
                const prior = this.pendingFillInserts.get(oid);
                const tracked: Promise<unknown> = (prior ? Promise.all([prior, p]) : p).finally(() => { if (this.pendingFillInserts.get(oid) === tracked) this.pendingFillInserts.delete(oid); });
                this.pendingFillInserts.set(oid, tracked);
            }
        }

        if (tradeEvent.action == 'Buy') {
            // A resting buy's own reservation first (by order id); otherwise the FIFO/in-context release as before.
            if (!(tradeEvent.brokerOrderId && this.releaseReservationForOrder(tradeEvent.brokerOrderId))) {
                this.releasePending(tradeEvent.user || 'Default', tradeEvent.broker, tradeEvent.quantity * tradeEvent.price);
            }
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user && t.broker == tradeEvent.broker);
            if (index == -1) {
                this.trades.push(tradeEvent);
            } else {
                const trade = this.trades[index];
                const traded = trade.quantity * trade.price;
                const newTraded = tradeEvent.quantity * tradeEvent.price;
                trade.quantity += tradeEvent.quantity;
                trade.price = (traded + newTraded) / trade.quantity;
                // A later buy that brought its own GTT: the merged row can hold only one primary id, and dropping the other would leave
                // that trigger live with nothing ever deleting it (it sells without the never-short guard).
                if (tradeEvent.gttTriggerId != null) {
                    if (trade.gttTriggerId == null) trade.gttTriggerId = tradeEvent.gttTriggerId;
                    else if (trade.gttTriggerId !== tradeEvent.gttTriggerId) trade.extraGttTriggerIds = [...(trade.extraGttTriggerIds ?? []), tradeEvent.gttTriggerId];
                }
            }
            // A buy that fills after a breach (a pending order) must not stay open
            // uncovered: the same check that runs on sells liquidates it.
            // Not awaited: the ledger reads must not delay this fill's publication.
            this.checkBreachAndNotify(tradeEvent.user || 'Default').catch((e) => Log.log('[order] breach check failed after buy fill:', e));
        } else {
            const index = this.trades.findIndex((t) => t.tsym == tradeEvent.tsym && t.user == tradeEvent.user && t.broker == tradeEvent.broker);
            if (index != -1) {
                const buyTrade = this.trades[index];
                const user = buyTrade.user || 'Default';

                // A single tsym+user entry here is an aggregate over every buy
                // seen for that contract (see the Buy branch above) - a strategy
                // that stacks multiple concurrent legs on the same contract
                // (e.g. ContinuousStrategy's spawn levels) can sell less than
                // the full aggregate in one fill. Reduce by the sold quantity
                // instead of closing the whole aggregate, so the remainder
                // stays tracked as open (was previously deleted outright on any
                // sell, silently orphaning the rest of the position from
                // bookkeeping - and therefore from capitalCheck/getCurrentInvestment
                // - even though it was still open at the broker).
                let sellQty = tradeEvent.quantity;
                if (sellQty > buyTrade.quantity) {
                    Log.log(`[order] WARNING: sell qty ${sellQty} for ${tradeEvent.tsym} (${user}) exceeds tracked open qty ${buyTrade.quantity} - clamping; bookkeeping may be desynced from the broker`);
                    sellQty = buyTrade.quantity;
                }

                const realizedPnL = (tradeEvent.price - buyTrade.price) * sellQty;
                const cumulative = (this.userPnL.get(user) || 0) + realizedPnL;
                this.userPnL.set(user, cumulative);
                Log.log(`[order] User '${user}' closed. P&L: ${realizedPnL.toFixed(2)}, Cumulative: ${cumulative.toFixed(2)}`);
                this.checkDrawdownNotification(user, cumulative);

                const closedPortion = new Trade();
                closedPortion.tsym = buyTrade.tsym;
                closedPortion.token = buyTrade.token;
                closedPortion.right = buyTrade.right;
                closedPortion.quantity = sellQty;
                closedPortion.price = buyTrade.price;
                closedPortion.action = 'Sell';
                closedPortion.user = user;
                closedPortion.broker = buyTrade.broker;
                closedPortion.open = false;
                closedPortion.realizedPnL = realizedPnL;
                closedPortion.entryTime = buyTrade.entryTime;
                closedPortion.exitTime = new Date();
                closedPortion.strategy = buyTrade.strategy;
                this.closedTrades.push(closedPortion);
                // Position state is updated BEFORE any await: other fills run while
                // this one awaits, and must see this fill's quantity and removal.
                buyTrade.quantity -= sellQty;
                // A Kite GTT bypasses the never-short guard: left live after this exit it could sell a flat (or smaller) account short, and a
                // GTT sized for the old quantity is wrong for what remains. The GTT's own fill (pollGttFills) clears the id before booking.
                const gttsToRelease = [buyTrade.gttTriggerId, ...(buyTrade.extraGttTriggerIds ?? [])].filter((id): id is number => id != null);
                if (gttsToRelease.length > 0) {
                    buyTrade.gttTriggerId = undefined as any;
                    buyTrade.extraGttTriggerIds = undefined;
                    this.trackGttRelease(this.releaseGtt(buyTrade, gttsToRelease));
                }
                if (buyTrade.quantity <= 0) {
                    this.trades.splice(index, 1);
                    if (buyTrade.token) exitMonitor.unregisterTrade(user, buyTrade.token, buyTrade.broker === 'ant' || buyTrade.broker === 'prism' || buyTrade.broker === 'kite' ? buyTrade.broker : undefined);
                }

                // Not awaited: the row is counted from memory (unpersistedClosed) while its
                // write is in flight, so the breach check needs no wait on the ledger write.
                this.persistClosedTrade(closedPortion, user, tradeEvent.price);
                this.checkBreachAndNotify(user);
            } else if (tradeEvent.user && tradeEvent.broker) {
                // No open position in memory for this Sell, so no closed-trade row is written here. The raw fill is stored; once its insert has
                // landed, rebuild this contract's closes from the fills (a no-op when Mongo holds no Buy for it, i.e. a foreign sell).
                Log.log(`[order] ALERT: Sell ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} (${tradeEvent.user}, ${tradeEvent.broker}) has no open position in memory - the fill is stored; repairing its closed trade from Mongo`);
                const inserted = tradeEvent.brokerOrderId ? this.pendingFillInserts.get(tradeEvent.brokerOrderId) : undefined;
                void Promise.resolve(inserted).catch(() => undefined)
                    .then(() => this.repairClosedTradesFromFills(tradeEvent.broker as BrokerKey, [], { lookbackDays: 1, only: { user: tradeEvent.user as string, tsym: tradeEvent.tsym } }))
                    .catch((e) => Log.log('[order] closed-trade repair after an unmatched Sell failed:', e?.message ?? e));
            }
        }
        this.notifyPositionsChanged();
    }

    private gttReleases = new Set<Promise<void>>();
    private trackGttRelease(p: Promise<void>): void {
        this.gttReleases.add(p);
        p.finally(() => this.gttReleases.delete(p));
    }
    // Resolves once every GTT delete started by a Sell fill has finished (tests; the order process never needs to wait).
    async whenGttReleased(): Promise<void> {
        while (this.gttReleases.size > 0) await Promise.all([...this.gttReleases]);
    }

    // Deletes the GTT of a position that has just been sold from, then hands what is left (if anything) to the in-app exit monitor.
    private async releaseGtt(trade: Trade, gttTriggerIds: number[]): Promise<void> {
        for (const gttTriggerId of gttTriggerIds) {
            try {
                await Kite.getInstance().deleteGTT(gttTriggerId);
                Log.log(`[order] GTT ${gttTriggerId} for ${trade.tsym} (${trade.user}) deleted - the position was sold from outside the GTT`);
            } catch (e) {
                // A GTT that already fired (its own sell is the fill being booked) cannot be deleted: only an ACTIVE one is a danger.
                let stillActive = true;
                try {
                    const live: any[] = await Kite.getInstance().getGTTs();
                    stillActive = live.some((g) => g.id === gttTriggerId && g.status === 'active');
                } catch { /* cannot tell: assume it is live */ }
                if (stillActive) Log.log(`[order] ALERT: GTT ${gttTriggerId} for ${trade.tsym} (${trade.user}) could NOT be deleted after a sell and may still be live - delete it by hand in Kite:`, e);
            }
        }
        if (trade.quantity > 0 && trade.token && (trade.targetPrice != null || trade.stopLossPrice != null)) {
            exitMonitor.registerTrade(trade, exchangeForTsym(trade.tsym), 'kite'); // replaces the watch-only entry: the in-app monitor now owns the exit
        }
    }

    // Called once at order-process startup: this.closedTrades is in-memory
    // only and doesn't survive a restart, but the 'closedTrades' Mongo
    // collection (see persistClosedTrade) is the durable record of every
    // realized trade. Reloads today's closed trades back into memory so
    // /closedtrades and /positionstream (both served from this.closedTrades,
    // not Mongo) don't go blank on every restart even though the trades were
    // never actually lost. Scoped to today (not all-time) to match the
    // existing "today" convention used elsewhere in this file (drawdown
    // checks, daily trade limit) and to keep the reload bounded.
    async loadClosedTradesFromMongo(): Promise<void> {
        try {
            const db = Mongo.getInstance()?.db;
            if (!db) return;
            const rows = await db.collection('closedTrades').find({ exitTime: { $gte: OrderBookkeeping.startOfDay() } }).toArray();
            for (const row of rows) {
                const trade = new Trade();
                trade.tsym = row.tsym;
                trade.token = row.token;
                trade.right = row.right;
                trade.quantity = row.quantity;
                trade.price = row.entryPrice;
                trade.lastTradePrice = row.exitPrice;
                trade.action = 'Sell';
                trade.status = 'COMPLETE';
                trade.user = row.user;
                trade.broker = normalizeBrokerName(row.broker) as any;
                trade.open = false;
                trade.realizedPnL = row.realizedPnL;
                trade.entryTime = row.entryTime;
                trade.exitTime = row.exitTime;
                trade.strategy = row.strategy;
                this.closedTrades.push(trade);
            }
            if (rows.length > 0) {
                Log.log(`[order] Reloaded ${rows.length} closed trade(s) from Mongo for today`);
            }
        } catch (e) {
            Log.log('[order] loadClosedTradesFromMongo failed (not blocking startup):', e);
        }
    }

    // Called once at order-process startup, alongside loadClosedTradesFromMongo:
    // this.trades (currently-open positions) is in-memory only and has no
    // closedTrades-style durable "open positions" collection to reload from -
    // every fill, Buy AND Sell, gets its own raw insertOne into Mongo's `Trade`
    // collection (see _processTradeEvent), with no open/closed flag or linkage
    // between them. Not safely queryable as "current open positions" on its
    // own (would require replaying/netting fills, exactly the kind of fragile
    // logic to avoid for a live-money restore path).
    //
    // Design: the broker is ground truth for *which* contracts are actually
    // open right now, immune to any of our own process restarts. For each
    // open broker position, restoreOpenTradesForTsym (below) recovers the
    // app-only fields the broker doesn't know (user/targetPrice/
    // stopLossPrice/gttTriggerId/strategy/antOrderNo/prismCoverOrderNo) from
    // Mongo's raw Buy fills - finalizeEntry (kiteExecutor.ts/
    // antExecutor.ts)/prismExecutor.ts's buyOnPrism always set those on the
    // Trade object before calling recordFill, so the raw Mongo insert
    // already captured them. Split per-user (not just per-tsym) - see that
    // function's own comment for why that split matters once more than one
    // app user can share a broker.
    // Was NIFTY-only ("this app only trades NIFTY index options") until
    // TopStockOptionsOpeningGapStrategy started trading individual stock
    // options over ANT too - a hardcoded NIFTY-prefix filter here silently
    // excluded every one of its positions from reconcileAntPositions,
    // dropping them from bookkeeping.trades on any order-process restart (and
    // from restoreOpenTradesForTsym's resulting Mongo-event processing, which
    // is what feeds the realized-P&L bookkeeping on the eventual exit fill).
    // Broadened to any option contract (CE/PE), relying on
    // restoreOpenTradesForTsym's own per-tsym Mongo lookup (below) - not this
    // filter - as the real guard against the 2026-09-03 incident (unrelated
    // stock-option/other-index positions placed outside the app, e.g. AMBER,
    // BANKNIFTY): a tsym with no matching app-originated Buy doc in Mongo
    // restores nothing and just logs a WARNING (restoreOpenTradesForTsym's
    // `restored.length === 0` branch), so broadening the candidate set here
    // doesn't let a genuinely foreign broker position back in.
    // ANT uses TWO different tsym conventions depending on index, confirmed live
    // 2026-10-21: SENSEX/BFO has a genuine trailing 'CE'/'PE' suffix after the strike
    // (e.g. 'SENSEX26O2274300PE'), but NIFTY embeds the option-type letter right
    // before the strike with nothing after it (e.g. 'NIFTY27OCT26C23000',
    // '...P22950' - ends in digits, never 'CE'/'PE'). The old endsWith-only check
    // silently excluded every NIFTY ANT option position from reconcileAntPositions,
    // dropping them from bookkeeping.trades (and therefore every strategy's own
    // reconcile()/getOpenTrades view) on every order-process restart - the real root
    // cause of a live incident where a naked BulkPcr-NIFTY call was invisible to
    // reconcile() no matter how long the order process had been warm, since this
    // gate ran before any per-tsym Mongo lookup ever got a chance to run.
    private static isOptionContract(tsym: string | undefined): boolean {
        if (typeof tsym !== 'string') return false;
        if (tsym.endsWith('CE') || tsym.endsWith('PE')) return true;
        return /[CP]\d+$/.test(tsym);
    }

    private mergeRestored(restored: Trade[]): void {
        for (const trade of restored) {
            // Same guard as ContinuousStrategy's Fix 4 (legsByToken collision) -
            // never silently merge two broker-reported open positions on the
            // same token into one bookkeeping entry.
            if (this.trades.some((t) => t.token === trade.token && t.user === trade.user && t.broker === trade.broker)) {
                Log.log(`[order] loadOpenTradesFromBroker: REFUSING to add duplicate - token ${trade.token} (${trade.tsym}) already restored for user ${trade.user}`);
                continue;
            }
            this.trades.push(trade);
        }
        if (restored.length > 0) {
            Log.log(`[order] Reloaded ${restored.length} open trade(s) from broker`);
            exitMonitor.reconcileFromTrades(this.trades);
        }
    }

    // Run only by the explicit 'reconcileBrokerPositions' step (POST /reconcile)
    // - not at startup or on login. A stale/expired session at the time of an
    // earlier run must not leave real open positions untracked; the user re-runs
    // it after a login (2026-09-03
    // incident: session was invalid at startup, a same-session re-login later
    // fixed it, but nothing re-ran this, so bookkeeping.trades stayed empty
    // against 4 real open Kite positions).
    // Returns true only when the broker's positions were fetched and restored;
    // false means this broker could not be read (reported back to the
    // POST /reconcile caller).
    async reconcileKitePositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            const positions = await Kite.getInstance().getPositions();
            const open = (positions?.net || []).filter((p: any) => p.quantity !== 0 && OrderBookkeeping.isOptionContract(p.tradingsymbol));
            for (const p of open) {
                restored.push(...(await this.restoreOpenTradesForTsym(p.tradingsymbol, p.quantity, p.instrument_token != null ? String(p.instrument_token) : undefined, 'kite', { avg: p.average_price, ltp: p.last_price })));
            }
        } catch (e) {
            Log.log('[order] reconcileKitePositions: Kite getPositions failed (continuing without restore):', e?.message ?? e);
            return false;
        }
        this.mergeRestored(restored);
        await this.syncExternalClosesSafe('kite'); // a position the broker closed on its own is booked (the readers above only add)
        return true;
    }

    // Caveat, not yet live-verified: ANT's getPositions() return shape is
    // untyped/`any` and hasn't been confirmed against a real response - same
    // caveat ToDo.md already carries for AntOrderNotifyStream's norenordno/
    // flprc fields. The field names below were confirmed live 2026-10-21 against a
    // real GET /open-api/od/v1/positions response (ANT.getPositions()): quantity is
    // `netQuantity`, the instrument token is `instrumentId` - NOT `netQty`/`netqty`/
    // `token`, which was this function's previous never-observed guess and meant
    // `Number(p.netQty ?? p.netqty ?? 0)` always fell through to the `?? 0` default,
    // so this filter excluded every single ANT position regardless of quantity or
    // symbol - reconcileAntPositions had never actually restored anything. Called
    // both at startup and reactively after a successful ANT login (see
    // reconcileKitePositions's comment for why).
    async reconcileAntPositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            const positions = await ANT.getInstance().getPositions();
            const list = Array.isArray(positions) ? positions : [];
            const open = list.filter((p: any) => Number(p.netQuantity ?? 0) !== 0 && OrderBookkeeping.isOptionContract(p.tradingSymbol));
            for (const p of open) {
                const tsym = p.tradingSymbol;
                const qty = Number(p.netQuantity);
                const token = p.instrumentId != null ? String(p.instrumentId) : undefined;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, token, 'ant', { avg: p.netAveragePrice, ltp: p.ltp })));
            }
        } catch (e) {
            Log.log('[order] reconcileAntPositions: ANT getPositions failed (continuing without restore):', e?.message ?? e);
            return false;
        }
        this.mergeRestored(restored);
        await this.syncExternalClosesSafe('ant'); // a position the broker closed on its own is booked (the readers above only add)
        return true;
    }

    // Mirrors reconcileAntPositions's shape exactly. Without this, restarting
    // `order` while a LegManager-driven strategy (ContinuousStrategy/
    // SupportResistanceStrategy) has an open Breeze leg would leave
    // bookkeeping.trades empty for it - the strategy's own restart-reconcile
    // (LegManager.restoreFromOpenTrades) never runs since it only fires when
    // OrderClient.getOpenTrades reports something to restore, so it would
    // silently open a duplicate root leg while the real one sits open and
    // untracked at the broker. Field names (stock_code/expiry_date/
    // strike_price/right/quantity) confirmed live 2026-09-17 against a real
    // open position - see breezeExecutor.ts's getPositionsOnBreeze comment.
    // The tokens that identify one Breeze position's exact contract (expiry included) in the Mongo fills: the ANT-native token (what a
    // bare Breeze buy stores as Trade.token) and Breeze's own. Empty when the contract cannot be resolved (the restore then keeps the old
    // tsym-wide behaviour).
    private async breezeContractTokens(p: any, optionType: 'CE' | 'PE'): Promise<string[]> {
        const tokens: string[] = [];
        try {
            const strike = Number(p.strike_price);
            const rec = await BreezeContractMaster.getInstance().findOption(String(p.stock_code), String(p.expiry_date), strike, optionType);
            if (rec?.token) tokens.push(String(rec.token));
            const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(p.expiry_date));
            const month = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) : -1;
            if (m && month >= 0 && rec) {
                const ant = AntContractMaster.getInstance().findOption({ symbol: indexNameFor(String(p.stock_code)), exch: rec.exchange, strike: String(strike), optionType, expiryEpochMs: Date.UTC(Number(m[3]), month, Number(m[1])) });
                if (ant?.token) tokens.push(String(ant.token));
            }
        } catch (e: any) {
            Log.log(`[order] reconcileBreezePositions: could not resolve the contract tokens of ${p.stock_code} ${p.expiry_date} ${p.strike_price} ${optionType} (${e?.message ?? e}) - restoring by trading symbol only`);
        }
        return tokens;
    }

    async reconcileBreezePositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            // No valid session = positions can't be read, so this is NOT reconciled
            // (a logged-out Breeze must be logged in before it can be reconciled).
            if (!(await withTimeout(Breeze.getInstance().hasValidSession(), 15000, 'Breeze hasValidSession'))) return false;
            const result = await withTimeout(Breeze.getInstance().getPortfolioPositions(), 15000, 'Breeze getPortfolioPositions');
            const rows = Array.isArray(result?.Success) ? result.Success : [];
            for (const p of rows) {
                const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
                if (!optionType) continue;
                const tsym = breezeTsym(String(p.stock_code), String(p.expiry_date), p.strike_price, optionType);
                const qty = Number(p.quantity ?? 0);
                if (qty === 0 || !OrderBookkeeping.isOptionContract(tsym)) continue;
                restored.push(...(await this.restoreOpenTradesForTsym(tsym, qty, undefined, 'breeze', { avg: p.average_price, ltp: p.ltp }, await this.breezeContractTokens(p, optionType), [breezeLegacyTsym(String(p.stock_code), p.strike_price, optionType), `${p.stock_code}${p.strike_price}${optionType}`])));
            }
        } catch (e) {
            Log.log('[order] reconcileBreezePositions: Breeze getPortfolioPositions failed (continuing without restore):', e?.message ?? e);
            return false;
        }
        this.mergeRestored(restored);
        await this.syncExternalClosesSafe('breeze'); // a position the broker closed on its own is booked (the readers above only add)
        return true;
    }

    // Mirrors reconcileAntPositions: without it a restart leaves bookkeeping.trades empty for an open prism leg and the owning
    // strategy's own reconcile() concludes "no longer held by the broker" and closes the leg in its state. Prism position rows
    // (Shoonya position book): tsym, netqty, netavgprc, token, lp (ltp).
    async reconcilePrismPositions(): Promise<boolean> {
        const restored: Trade[] = [];
        try {
            // Lazy import: prism.ts imports this module, so a top-level import here would be a cycle.
            const Prism = (await import('../../prism')).default;
            // No valid session = positions can't be read, so this is NOT reconciled (log in to Shoonya first).
            if (!(await withTimeout(Prism.getInstance().hasValidSession(), 15000, 'Prism hasValidSession'))) return false;
            const list = await withTimeout(Prism.getInstance().getPositions({ strict: true }), 15000, 'Prism getPositions');
            const open = list.filter((p: any) => Number(p.netqty ?? 0) !== 0 && OrderBookkeeping.isOptionContract(p.tsym));
            for (const p of open) {
                restored.push(...(await this.restoreOpenTradesForTsym(p.tsym, Number(p.netqty), p.token != null ? String(p.token) : undefined, 'prism', { avg: p.netavgprc, ltp: p.lp })));
            }
        } catch (e: any) {
            Log.log('[order] reconcilePrismPositions: Prism getPositions failed (continuing without restore):', e?.message ?? e);
            return false;
        }
        this.mergeRestored(restored);
        await this.syncExternalClosesSafe('prism'); // a position the broker closed on its own is booked (the readers above only add)
        return true;
    }

    // Rebuilds `trades` from Mongo ALONE - no broker read, no login (user's design, 2026-11-11: a restart restores from Mongo; the end-of-day
    // sync / `npm run sync` is what keeps Mongo equal to the brokers). Every (broker, token) with a Buy in the last `lookbackDays` goes through the
    // same per-user FIFO restore the broker-driven reconcile uses, with no broker quantity to cap against (restoreOpenTradesForTsym's `null` mode).
    // Contracts that expired before today are skipped (an expired contract still open per Mongo is a record that was never closed, not a position;
    // the end-of-day sync reports it), as are docs without a token or whose token the contract master does not know (ALERT: not restored).
    // Idempotent: mergeRestored refuses a user+token+broker that is already tracked.
    async restoreOpenTradesFromMongo(opts: { lookbackDays?: number } = {}): Promise<MongoRestoreResult> {
        const result: MongoRestoreResult = { ok: false, restored: 0, contracts: 0, skippedExpired: [], skippedUnknownToken: [], skippedNoToken: [] };
        const db = Mongo.getInstance()?.db;
        if (!db) { result.error = 'Mongo is not available'; return result; }
        try {
            const since = new Date(Date.now() - (opts.lookbackDays ?? 120) * 86400000);
            const docs: any[] = await db.collection('Trade').find({ action: 'Buy', entryTime: { $gte: since } }).project({ tsym: 1, token: 1, broker: 1 }).sort({ entryTime: 1 }).toArray();
            const groups = new Map<string, { broker: BrokerKey; token?: string; newest: string; tsyms: Set<string> }>();
            for (const d of docs) {
                if (!d.tsym) continue;
                const brokerName = d.broker == null || String(d.broker).trim() === '' ? 'kite' : normalizeBrokerName(d.broker);
                if (brokerName !== 'kite' && brokerName !== 'ant' && brokerName !== 'breeze' && brokerName !== 'prism') continue;
                const token = d.token != null && String(d.token) !== '' ? String(d.token) : undefined;
                const key = `${brokerName}|${token ?? 'tsym:' + d.tsym}`;
                const g = groups.get(key) ?? { broker: brokerName as BrokerKey, token, newest: String(d.tsym), tsyms: new Set<string>() };
                g.newest = String(d.tsym);
                g.tsyms.add(String(d.tsym));
                groups.set(key, g);
            }
            const todayStartUtc = Math.floor(Date.now() / 86400000) * 86400000;
            const restored: Trade[] = [];
            for (const g of groups.values()) {
                if (!OrderBookkeeping.isOptionContract(g.newest)) continue;
                if (!g.token) { result.skippedNoToken.push(`${g.broker}:${g.newest}`); continue; }
                const contract = AntContractMaster.getInstance().findByToken(g.token);
                if (!contract) { result.skippedUnknownToken.push(`${g.broker}:${g.newest}(${g.token})`); continue; }
                if (contract.expiryMs < todayStartUtc) { result.skippedExpired.push(`${g.broker}:${g.newest}`); continue; }
                result.contracts++;
                const others = Array.from(g.tsyms).filter((t) => t !== g.newest);
                restored.push(...(await this.restoreOpenTradesForTsym(g.newest, null, g.token, g.broker, undefined, [g.token], others.length > 0 ? others : undefined)));
            }
            this.mergeRestored(restored);
            result.restored = restored.length;
            result.ok = true;
            Log.log(`[order] Restored ${restored.length} open trade(s) from Mongo alone (${result.contracts} live contract(s) with a recent Buy; no broker was read)`);
            // A restore that silently drops a contract would leave a held position unmanaged: say so for every kind of skip that is not an expiry.
            if (result.skippedNoToken.length > 0) Log.log(`[order] ALERT: restore from Mongo: Buy docs without a token were NOT restored (${result.skippedNoToken.join(', ')}) - check them by hand`);
            if (result.skippedUnknownToken.length > 0) Log.log(`[order] ALERT: restore from Mongo: contracts unknown to the contract master were NOT restored (${result.skippedUnknownToken.join(', ')}) - refresh the contract master and restart`);
            if (result.skippedExpired.length > 0) Log.log(`[order] restore from Mongo: ${result.skippedExpired.length} expired contract(s) skipped (${result.skippedExpired.slice(0, 6).join(', ')}${result.skippedExpired.length > 6 ? ', ...' : ''})`);
        } catch (e: any) {
            result.error = e?.message ?? String(e);
            Log.log('[order] ALERT: restore from Mongo failed - no trade was restored:', e);
        }
        return result;
    }

    // ---- Closes that happened outside the platform (2026-11-11) ----
    // The reconcile*Positions readers above only ADD what a broker still holds. A tracked trade whose broker position went flat on its own - AliceBlue's
    // intraday (MIS) square-off at ~15:16, a sell in the broker's own app, an expiry - therefore stayed "open" in `trades` for the life of the order
    // process: the status showed it open with a made-up unrealized P&L, strategies kept it as held, its realized P&L was never booked, and Mongo had a
    // Buy with no Sell (so a later restart's FIFO restore saw a "cost basis uncertain" contract). POST /reconcile did not repair it (live 2026-11-11,
    // ANT NIFTY17NOV26C25400 390 sold by the broker at 15:16, still open at 15:22).
    // syncExternalCloses books such a close as a normal Sell fill (raw Mongo doc, closedTrades row, realized P&L, exit-monitor unregister) WITHOUT
    // notifying the strategies' fill listeners: a reconcile must place nothing, and a strategy would answer a loss-close with a hedge buy. The strategies
    // learn of it from their own reconcile(), which reads the open trades afterwards. Only a contract that is FLAT at the broker is closed: a smaller
    // but non-zero broker quantity is alerted (see below), never guessed at.
    private flatSeen = new Map<string, number>(); // "<broker>|<user>|<tsym>" -> when the periodic sync first saw it flat
    private partialAlerted = new Map<string, string>(); // "<broker>|<tsym>" -> "<tracked>/<held>" last alerted

    private static num(v: unknown): number | undefined {
        const n = Number(v);
        return v != null && v !== '' && Number.isFinite(n) ? n : undefined;
    }

    // The broker's position list as BrokerRows, or null when it cannot be read or is not a list (a failed read must never look like "everything flat").
    private async readBrokerRows(broker: BrokerKey): Promise<BrokerRow[] | null> {
        const num = OrderBookkeeping.num;
        try {
            if (broker === 'kite') {
                const net = (await Kite.getInstance().getPositions())?.net;
                if (!Array.isArray(net)) return null;
                return net.map((p: any) => ({ tsyms: [String(p.tradingsymbol)], tokens: p.instrument_token != null ? [String(p.instrument_token)] : [], qty: Number(p.quantity ?? 0), soldQty: num(p.sell_quantity), soldValue: num(p.sell_value), ltp: num(p.last_price) }));
            }
            if (broker === 'ant') {
                const list = await ANT.getInstance().getPositions();
                if (!Array.isArray(list)) return null;
                return list.map((p: any) => ({ tsyms: [String(p.tradingSymbol)], tokens: p.instrumentId != null ? [String(p.instrumentId)] : [], qty: Number(p.netQuantity ?? 0), soldQty: num(p.daySellQuantity), soldValue: num(p.daySellValue), ltp: num(p.ltp) }));
            }
            if (broker === 'breeze') {
                if (!(await withTimeout(Breeze.getInstance().hasValidSession(), 15000, 'Breeze hasValidSession'))) return null;
                const result = await withTimeout(Breeze.getInstance().getPortfolioPositions(), 15000, 'Breeze getPortfolioPositions');
                if (!Array.isArray(result?.Success)) return null;
                const rows: BrokerRow[] = [];
                for (const p of result.Success) {
                    const optionType = p.right === 'Call' ? 'CE' : p.right === 'Put' ? 'PE' : undefined;
                    if (!optionType) continue;
                    rows.push({
                        tsyms: [breezeTsym(String(p.stock_code), String(p.expiry_date), p.strike_price, optionType), breezeLegacyTsym(String(p.stock_code), p.strike_price, optionType), `${p.stock_code}${p.strike_price}${optionType}`],
                        tokens: await this.breezeContractTokens(p, optionType), qty: Number(p.quantity ?? 0), ltp: num(p.ltp),
                    });
                }
                return rows;
            }
            const Prism = (await import('../../prism')).default;
            if (!(await withTimeout(Prism.getInstance().hasValidSession(), 15000, 'Prism hasValidSession'))) return null;
            const list = await withTimeout(Prism.getInstance().getPositions({ strict: true }), 15000, 'Prism getPositions');
            if (!Array.isArray(list)) return null;
            return list.map((p: any) => ({ tsyms: [String(p.tsym)], tokens: p.token != null ? [String(p.token)] : [], qty: Number(p.netqty ?? 0), soldQty: num(p.daysellqty), soldValue: num(p.daysellamt), ltp: num(p.lp) }));
        } catch (e: any) {
            Log.log(`[order] readBrokerRows(${broker}): positions not readable (no close is booked from this read):`, e?.message ?? e);
            return null;
        }
    }

    private static rowsFor(rows: BrokerRow[], t: Trade): BrokerRow[] {
        return rows.filter((r) => r.tsyms.includes(t.tsym) || (t.token != null && r.tokens.includes(String(t.token))));
    }

    // Today's sells already in Mongo for the contract (every user), so the broker's sell totals minus these are the sells nobody booked.
    private async bookedSellsToday(broker: BrokerKey, tsyms: string[]): Promise<{ qty: number; value: number } | null> {
        const db = Mongo.getInstance()?.db;
        if (!db) return null;
        try {
            const brokerMatch = { $or: [{ broker: broker === 'kite' ? { $in: ['kite', /^\s*zerodha\s*$/i] } : broker }, { broker: { $exists: false } }] };
            const docs: any[] = await db.collection('Trade').find({ tsym: { $in: tsyms }, action: 'Sell', entryTime: { $gte: OrderBookkeeping.startOfDay() }, ...brokerMatch }).toArray();
            let qty = 0, value = 0;
            for (const d of docs) { const q = Number(d.quantity) || 0; qty += q; value += q * (Number(d.price) || 0); }
            return { qty, value };
        } catch (e: any) {
            Log.log('[order] bookedSellsToday: Mongo read failed:', e?.message ?? e);
            return null;
        }
    }

    // The price an unbooked broker-side sell of `qty` was done at: the broker's sell totals for today minus what is booked, when that leaves exactly
    // `qty`; otherwise the broker's last price (flagged ESTIMATED - the realized P&L of that close is approximate), else the entry price (zero P&L).
    private async impliedExternalSell(broker: BrokerKey, rows: BrokerRow[], qty: number, t: Trade): Promise<{ price: number; how: string }> {
        const withTotals = rows.filter((r) => r.soldQty != null && r.soldValue != null);
        if (rows.length > 0 && withTotals.length === rows.length) {
            const booked = await this.bookedSellsToday(broker, Array.from(new Set(rows.flatMap((r) => r.tsyms))));
            if (booked) {
                const sold = withTotals.reduce((s, r) => s + (r.soldQty as number), 0) - booked.qty;
                const value = withTotals.reduce((s, r) => s + (r.soldValue as number), 0) - booked.value;
                if (Math.abs(sold - qty) <= 0.5 && value > 0) return { price: value / sold, how: "from the broker's sell totals" };
            }
        }
        const ltp = rows.map((r) => r.ltp).find((v) => v != null && v > 0);
        return ltp != null ? { price: ltp, how: "ESTIMATED at the broker's last price" } : { price: t.price, how: 'ESTIMATED at the entry price (no P&L)' };
    }

    // Lots bought TODAY (per Mongo, netted the same way the restore does) on contracts the broker no longer holds and that `trades` does not track: the
    // close happened while no process was tracking them (before a restart, or while `order` was down), so nothing in memory can be matched against it.
    // Today only: an older open lot with no matching close is an expiry or a lost record, not "a close that happened today". Built as open Trades so the
    // normal Sell path can close them; the caller pushes them into `trades` right before booking.
    private async mongoOpenLotsFlatAtBroker(broker: BrokerKey, rows: BrokerRow[]): Promise<Trade[]> {
        const db = Mongo.getInstance()?.db;
        if (!db) return [];
        try {
            const brokerMatch = { $or: [{ broker: broker === 'kite' ? { $in: ['kite', /^\s*zerodha\s*$/i] } : broker }, { broker: { $exists: false } }] };
            const docs: any[] = await db.collection('Trade').find({ action: { $in: ['Buy', 'Sell'] }, entryTime: { $gte: OrderBookkeeping.startOfDay() }, ...brokerMatch }).sort({ entryTime: 1 }).toArray();
            const byTsym = new Map<string, any[]>();
            for (const d of docs) byTsym.set(String(d.tsym), [...(byTsym.get(String(d.tsym)) ?? []), d]);
            const out: Trade[] = [];
            for (const [tsym, fills] of byTsym) {
                if (!OrderBookkeeping.isOptionContract(tsym)) continue;
                const probe = Object.assign(new Trade(), { tsym, token: fills.find((f) => f.token != null)?.token });
                if (OrderBookkeeping.rowsFor(rows, probe).reduce((sum, r) => sum + r.qty, 0) !== 0) continue; // still held: the restore owns it
                const owners = await loadOrderOwners(Array.from(new Set(fills.map((f) => f.brokerOrderId).filter(Boolean).map(String))));
                const { fills: owned, ambiguousOrderIds } = collapseFillsByOrderId(fills, (id) => owners.get(id));
                if (ambiguousOrderIds.length > 0) continue; // an order booked under several users: not guessed at (the restore holds it for review too)
                for (const user of Array.from(new Set(owned.map((f: any) => String(f.user))))) {
                    if (this.trades.some((t) => t.broker === broker && t.user === user && t.tsym === tsym)) continue; // tracked: the in-memory pass handles it
                    const open = netFifoLots<any>(owned.filter((f: any) => String(f.user) === user)).filter((l) => l.remaining > 0);
                    if (open.length === 0) continue;
                    const qty = open.reduce((sum, l) => sum + l.remaining, 0);
                    const first = open[0].doc;
                    const t = new Trade();
                    t.tsym = tsym; t.token = first.token ?? probe.token ?? ''; t.right = first.right; t.quantity = qty;
                    t.price = open.reduce((sum, l) => sum + l.remaining * Number(l.doc.price), 0) / qty;
                    t.action = 'Buy'; t.status = 'COMPLETE'; t.user = user; t.broker = broker; t.open = true;
                    t.strategy = first.strategy; t.entryTime = first.entryTime; t.originalEntryPrice = Number(first.price); t.originalEntryQuantity = Number(first.quantity);
                    out.push(t);
                }
            }
            return out;
        } catch (e: any) {
            Log.log('[order] mongoOpenLotsFlatAtBroker failed (no backfill):', e?.message ?? e);
            return [];
        }
    }

    // Books one tracked trade as sold at `price` through the normal Sell path (no strategy notification, see above).
    private async bookExternalSell(t: Trade, price: number, how: string): Promise<void> {
        const ev = new Trade();
        ev.tsym = t.tsym; ev.token = t.token; ev.right = t.right; ev.quantity = t.quantity; ev.price = price;
        ev.action = 'Sell'; ev.status = 'COMPLETE'; ev.user = t.user; ev.broker = t.broker; ev.strategy = t.strategy;
        ev.brokerOrderId = `BROKER-SYNC-${t.broker}-${t.tsym}-${Date.now()}`;
        recordOrderOwner(ev.brokerOrderId, ev.user, ev.broker ?? 'kite');
        Log.log(`[order] ALERT: ${t.user} ${t.tsym} (${t.broker}) qty=${t.quantity} was closed outside the platform (the broker position is flat) - booked as a sell @ ${price.toFixed(2)} ${how}; entry ${Number(t.price).toFixed(2)}`);
        await this._processTradeEvent(ev);
    }

    // Closes every tracked trade of `broker` whose contract is flat at the broker. `minFlatMs` > 0 (the periodic run) also requires the contract to have
    // been seen flat for that long, so an own sell whose fill notification is still on its way is booked by that fill, not by this. Returns how many
    // trades were booked. Never throws (see syncExternalClosesSafe).
    async syncExternalCloses(broker: BrokerKey, minFlatMs = 0): Promise<number> {
        const tracked = () => this.trades.filter((t) => t.broker === broker && Number(t.quantity) > 0);
        const prefix = `${broker}|`;
        const explicit = minFlatMs === 0; // a reconcile (startup / POST /reconcile), not the periodic run: also backfills closes from Mongo
        if (tracked().length === 0 && !explicit) {
            for (const k of Array.from(this.flatSeen.keys())) if (k.startsWith(prefix)) this.flatSeen.delete(k);
            return 0;
        }
        const heldOf = (rows: BrokerRow[], t: Trade) => OrderBookkeeping.rowsFor(rows, t).reduce((s, r) => s + r.qty, 0);
        const rows1 = await this.readBrokerRows(broker);
        if (!rows1) return 0; // unreadable: nothing is concluded from it
        const ghosts = new Set<Trade>(explicit ? await this.mongoOpenLotsFlatAtBroker(broker, rows1) : []);
        let candidates = [...tracked().filter((t) => heldOf(rows1, t) === 0), ...ghosts];
        // A broker quantity smaller than (but not zero against) what is tracked: part of it left outside the platform. Which user's share it was cannot be
        // told, so it is alerted (once per change), not booked.
        const byTsym = new Map<string, Trade[]>();
        for (const t of tracked()) byTsym.set(t.tsym, [...(byTsym.get(t.tsym) ?? []), t]);
        for (const [tsym, ts] of byTsym) {
            const held = heldOf(rows1, ts[0]);
            const total = ts.reduce((s, t) => s + Number(t.quantity), 0);
            const key = `${broker}|${tsym}`;
            if (held > 0 && held < total) {
                const state = `${total}/${held}`;
                if (this.partialAlerted.get(key) !== state) {
                    this.partialAlerted.set(key, state);
                    Log.log(`[order] ALERT: ${tsym} (${broker}) is tracked at ${total} but the broker holds only ${held} - part of it was closed outside the platform; not adjusted (which user's share is unknown), POST /reconcile after fixing by hand`);
                }
            } else this.partialAlerted.delete(key);
        }
        const flatKey = (t: Trade) => `${broker}|${t.user}|${t.tsym}`;
        for (const k of Array.from(this.flatSeen.keys())) if (k.startsWith(prefix) && !candidates.some((t) => flatKey(t) === k)) this.flatSeen.delete(k);
        if (candidates.length === 0) return 0;
        // Confirmation read: a lagging or glitchy list must not close a position the broker still holds.
        await new Promise((r) => setTimeout(r, 3000));
        const rows2 = await this.readBrokerRows(broker);
        if (!rows2) return 0;
        const now = Date.now();
        candidates = candidates.filter((t) => (ghosts.has(t) || this.trades.includes(t)) && Number(t.quantity) > 0 && heldOf(rows2, t) === 0);
        for (const t of candidates) if (!this.flatSeen.has(flatKey(t))) this.flatSeen.set(flatKey(t), now);
        candidates = candidates.filter((t) => now - (this.flatSeen.get(flatKey(t)) ?? now) >= minFlatMs);
        if (candidates.length === 0) return 0;
        const groups = new Map<string, Trade[]>();
        for (const t of candidates) groups.set(t.tsym, [...(groups.get(t.tsym) ?? []), t]);
        let booked = 0;
        for (const [, ts] of groups) {
            const live = ts.filter((t) => (ghosts.has(t) || this.trades.includes(t)) && Number(t.quantity) > 0); // a fill may have closed one while the price was looked up
            if (live.length === 0) continue;
            const qty = live.reduce((s, t) => s + Number(t.quantity), 0);
            const { price, how } = await this.impliedExternalSell(broker, OrderBookkeeping.rowsFor(rows2, live[0]), qty, live[0]);
            for (const t of live) {
                if (!(Number(t.quantity) > 0)) continue;
                if (ghosts.has(t)) {
                    // Re-check at the last moment: a restore or a live buy may have tracked this user+contract since the Mongo read.
                    if (this.trades.some((x) => x.broker === broker && x.user === t.user && x.tsym === t.tsym)) continue;
                    this.trades.push(t);
                    Log.log(`[order] ALERT: ${t.user} ${t.tsym} (${broker}) qty=${t.quantity} was bought today, is flat at the broker and was never booked as closed - backfilling the close`);
                } else if (!this.trades.includes(t)) continue;
                await this.bookExternalSell(t, price, how);
                this.flatSeen.delete(flatKey(t));
                booked++;
            }
        }
        return booked;
    }

    // ---- End-of-day repair (2026-11-11): broker trade book + positions -> Mongo ----
    // One central job (user's design): after the close, and on demand (`npm run sync`), look at Mongo and at what each broker says it did today
    // (trade book / order book fills, open positions) and update Mongo to match. It reads brokers and writes Mongo and bookkeeping only; it places no
    // order and does not notify strategies. Closes the broker made on its own are booked from the broker's own fills at their exact price; what cannot
    // be attributed with evidence is REPORTED, never guessed into Mongo.

    // Today's (and the last days') executed fills as the broker reports them, one row per broker order (partial fills of one order summed). null =
    // unreadable. Kite/ANT/Breeze have a trade book; Prism has none wired, but its order book carries the filled quantity and average price.
    private async readBrokerFills(broker: BrokerKey): Promise<BrokerFill[] | null> {
        const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        const sum = (rows: { orderId: string; action: 'Buy' | 'Sell'; tsym: string; token?: string; qty: number; price: number }[]): BrokerFill[] => {
            const by = new Map<string, BrokerFill & { value: number }>();
            for (const r of rows) {
                if (!r.orderId || !(r.qty > 0)) continue;
                const k = `${r.action}|${r.orderId}`;
                const cur = by.get(k) ?? { orderId: r.orderId, action: r.action, tsym: r.tsym, token: r.token, qty: 0, price: 0, value: 0 };
                cur.qty += r.qty; cur.value += r.qty * r.price; by.set(k, cur);
            }
            return Array.from(by.values()).map(({ value, ...f }) => ({ ...f, price: f.qty > 0 ? value / f.qty : 0 }));
        };
        const act = (v: unknown): 'Buy' | 'Sell' | null => { const t = String(v ?? '').trim().toUpperCase(); return t === 'BUY' || t === 'B' ? 'Buy' : t === 'SELL' || t === 'S' ? 'Sell' : null; };
        try {
            if (broker === 'kite') {
                const rows = await Kite.getInstance().getTrades();
                if (!Array.isArray(rows)) return null;
                return sum(rows.flatMap((r: any) => { const a = act(r.transaction_type); return a ? [{ orderId: String(r.order_id ?? ''), action: a, tsym: String(r.tradingsymbol), qty: num(r.quantity), price: num(r.average_price) }] : []; }));
            }
            if (broker === 'ant') {
                const rows = await ANT.getInstance().getTrades();
                if (!Array.isArray(rows)) return null;
                return sum(rows.flatMap((r: any) => { const a = act(r.transactionType); return a ? [{ orderId: String(r.brokerOrderId ?? ''), action: a, tsym: String(r.tradingSymbol), token: r.instrumentId != null ? String(r.instrumentId) : undefined, qty: num(r.filledQuantity), price: num(r.tradedPrice) }] : []; }));
            }
            if (broker === 'breeze') {
                if (!(await withTimeout(Breeze.getInstance().hasValidSession(), 15000, 'Breeze hasValidSession'))) return null;
                const from = new Date(); from.setHours(0, 0, 0, 0);
                let result: any;
                try {
                    result = await withTimeout(Breeze.getInstance().getTradeList({ fromDate: from.toISOString(), toDate: new Date().toISOString(), exchangeCode: 'NFO' }), 20000, 'Breeze getTradeList');
                } catch (e: any) {
                    // Breeze answers an EMPTY trade list with Error 'No Data Found' (live every sync on a day Breeze traded nothing): that is a readable, empty book.
                    if (/No Data Found/i.test(String(e?.message ?? e))) return [];
                    throw e;
                }
                if (!Array.isArray(result?.Success)) return null;
                return sum(result.Success.flatMap((r: any) => {
                    const a = act(r.action); const optionType = r.right === 'Call' ? 'CE' : r.right === 'Put' ? 'PE' : undefined;
                    if (!a || !optionType) return [];
                    return [{ orderId: String(r.order_id ?? ''), action: a, tsym: breezeTsym(String(r.stock_code), String(r.expiry_date), r.strike_price, optionType), qty: num(r.quantity), price: num(r.average_cost ?? r.average_price) }];
                }));
            }
            const Prism = (await import('../../prism')).default;
            if (!(await withTimeout(Prism.getInstance().hasValidSession(), 15000, 'Prism hasValidSession'))) return null;
            const book = await withTimeout(Prism.getInstance().getOrderBook(), 20000, 'Prism getOrderBook');
            if (!Array.isArray(book)) return null;
            return sum(book.flatMap((r: any) => { const a = act(r.trantype); return a && String(r.status).toUpperCase() === 'COMPLETE' ? [{ orderId: String(r.norenordno ?? ''), action: a, tsym: String(r.tsym), token: r.token != null ? String(r.token) : undefined, qty: num(r.fillshares ?? r.qty), price: num(r.avgprc) }] : []; }));
        } catch (e: any) {
            Log.log(`[order] readBrokerFills(${broker}): trade book not readable:`, e?.message ?? e);
            return null;
        }
    }

    // `${action}|${brokerOrderId}` of every fill Mongo already holds for this broker over the last days (a Breeze trade list spans several days).
    private async mongoFillKeys(broker: BrokerKey): Promise<{ keys: Set<string>; tsyms: Set<string> } | null> {
        const db = Mongo.getInstance()?.db;
        if (!db) return null;
        try {
            const brokerMatch = { $or: [{ broker: broker === 'kite' ? { $in: ['kite', /^\s*zerodha\s*$/i] } : broker }, { broker: { $exists: false } }] };
            const docs: any[] = await db.collection('Trade').find({ brokerOrderId: { $exists: true, $ne: null }, entryTime: { $gte: new Date(Date.now() - 8 * 86400000) }, ...brokerMatch }).project({ brokerOrderId: 1, action: 1, tsym: 1 }).toArray();
            return { keys: new Set(docs.map((d) => `${d.action}|${d.brokerOrderId}`)), tsyms: new Set(docs.map((d) => String(d.tsym))) };
        } catch (e: any) {
            Log.log('[order] mongoFillKeys: Mongo read failed:', e?.message ?? e);
            return null;
        }
    }

    // Books a Sell the broker reports but Mongo does not have, to the user whose tracked position it closed: the order-owner ledger names the owner, or the
    // contract has exactly one holder. The sell must also fit what the broker still holds (tracked - sold >= held), otherwise it was already booked under
    // another id, or belongs to something this platform does not track, and is only reported. Buys that Mongo lacks are only reported.
    private async bookMissingSellFills(broker: BrokerKey, fills: BrokerFill[], rows: BrokerRow[], mismatches: EodMismatch[]): Promise<number> {
        const have = await this.mongoFillKeys(broker);
        if (!have) return 0;
        const missing = fills.filter((f) => !have.keys.has(`${f.action}|${f.orderId}`));
        if (missing.length === 0) return 0;
        const owners = await loadOrderOwners(Array.from(new Set(missing.map((f) => f.orderId))));
        let booked = 0;
        for (const f of missing) {
            // A fill on a contract this platform never traded (in the last days) is the user's own trade in the broker's app: not ours to report.
            if (!have.tsyms.has(f.tsym) && !this.trades.some((t) => t.broker === broker && (t.tsym === f.tsym || (f.token != null && String(t.token) === f.token)))) continue;
            const holders = this.trades.filter((t) => t.broker === broker && Number(t.quantity) > 0 && (t.tsym === f.tsym || (f.token != null && String(t.token) === f.token)));
            const trackedTotal = holders.reduce((sum, t) => sum + Number(t.quantity), 0);
            const held = OrderBookkeeping.rowsFor(rows, Object.assign(new Trade(), { tsym: f.tsym, token: f.token })).reduce((sum, r) => sum + r.qty, 0);
            // Nothing is tracked on the contract and the broker holds none of it: a round trip nobody here depends on (typically the user's own trades in the
            // broker's app on a contract the platform also traded earlier) - not worth a report line.
            if (trackedTotal === 0 && held === 0) continue;
            if (f.action === 'Buy') {
                mismatches.push({ kind: 'unattributedFill', broker, tsym: f.tsym, note: `a Buy of ${f.qty} @ ${f.price.toFixed(2)} (order ${f.orderId}) is at the broker but not in Mongo - not booked, check it` });
                continue;
            }
            const owner = owners.get(f.orderId);
            const target = owner ? holders.find((t) => t.user === owner) : holders.length === 1 ? holders[0] : undefined;
            const qty = target ? Math.min(f.qty, Number(target.quantity)) : 0;
            if (!target || !(qty > 0) || trackedTotal - qty < held) {
                mismatches.push({ kind: 'unattributedFill', broker, tsym: f.tsym, brokerQty: held, mongoQty: trackedTotal, note: `a Sell of ${f.qty} @ ${f.price.toFixed(2)} (order ${f.orderId}) is at the broker but not in Mongo and cannot be attributed with evidence - not booked` });
                continue;
            }
            const ev = new Trade();
            ev.tsym = target.tsym; ev.token = target.token; ev.right = target.right; ev.quantity = qty; ev.price = f.price;
            ev.action = 'Sell'; ev.status = 'COMPLETE'; ev.user = target.user; ev.broker = broker; ev.strategy = target.strategy; ev.brokerOrderId = f.orderId;
            recordOrderOwner(f.orderId, ev.user, broker);
            Log.log(`[order] ALERT: EOD sync ${broker}: ${target.user} ${target.tsym} - a Sell of ${qty} @ ${f.price.toFixed(2)} (order ${f.orderId}) is in the broker's own fills but was never booked - booking it now`);
            await this._processTradeEvent(ev);
            booked++;
        }
        return booked;
    }

    // Report-only differences between Mongo-derived positions and the broker (after the booking above).
    private collectEodMismatches(broker: BrokerKey, rows: BrokerRow[], out: EodMismatch[]): void {
        const byTsym = new Map<string, Trade[]>();
        for (const t of this.trades) if (t.broker === broker && Number(t.quantity) > 0) byTsym.set(t.tsym, [...(byTsym.get(t.tsym) ?? []), t]);
        for (const [tsym, ts] of byTsym) {
            const held = OrderBookkeeping.rowsFor(rows, ts[0]).reduce((sum, r) => sum + r.qty, 0);
            const total = ts.reduce((sum, t) => sum + Number(t.quantity), 0);
            if (held > 0 && held < total) out.push({ kind: 'partialUnattributable', broker, tsym, brokerQty: held, mongoQty: total, note: 'part of the position was closed outside the platform; which user\'s share is unknown' });
            else if (held > total) out.push({ kind: 'brokerExcess', broker, tsym, brokerQty: held, mongoQty: total });
        }
        for (const r of rows) {
            if (r.qty < 0) out.push({ kind: 'brokerShort', broker, tsym: r.tsyms[0], brokerQty: r.qty, note: 'net short at the broker' });
            else if (r.qty > 0 && !this.trades.some((t) => t.broker === broker && Number(t.quantity) > 0 && (r.tsyms.includes(t.tsym) || (t.token != null && r.tokens.includes(String(t.token)))))) {
                out.push({ kind: 'brokerExcess', broker, tsym: r.tsyms[0], brokerQty: r.qty, mongoQty: 0, note: 'held at the broker with no open position in Mongo (a manual trade, or a Buy that was never recorded)' });
            }
        }
    }

    // A Sell fill in Mongo's `Trade` with no closedTrades row is a close the books lost: _processTradeEvent writes the row only when the open
    // position is in memory, so a fill that arrived while memory did not hold it (a restart whose restore did not run, 2026-11-11 16:19: Breeze
    // Momentum 25400CE sold at 150 for -35,139) left only the raw fill. Rebuilds each contract's closes from its fills (FIFO, per user, one order
    // id counted once for its owner) over the last `lookbackDays` days, and writes a closedTrades row for every close that has none. Mongo only:
    // no broker read, no order. A row already there is matched on user/contract/quantity/exit time (+-5 min) and left alone, so it is safe to
    // run again. A Sell with no Buy before it is reported (`sellWithoutBuy`), never turned into a closed trade. `only` limits it to one contract.
    async repairClosedTradesFromFills(broker: BrokerKey, mismatches: EodMismatch[] = [], opts: { lookbackDays?: number; only?: { user: string; tsym: string } } = {}): Promise<number> {
        const db = Mongo.getInstance()?.db;
        if (!db) return 0;
        // A close still waiting for its write must not look missing (it would be written twice): land the held rows first.
        await this.flushUnpersistedClosed().catch(() => undefined);
        if (this.unpersistedClosed.size > 0) { mismatches.push({ kind: 'sellWithoutBuy', broker, tsym: '*', note: 'closed-trade rows are still waiting to be written to Mongo - repair skipped, run the sync again' }); return 0; }
        const since = OrderBookkeeping.startOfDay();
        since.setDate(since.getDate() - (opts.lookbackDays ?? 7));
        const brokerMatch: any = broker === 'kite' ? { $in: ['kite', /^\s*zerodha\s*$/i] } : broker;
        const sellFilter: any = { action: 'Sell', broker: brokerMatch, entryTime: { $gte: since } };
        if (opts.only) { sellFilter.user = opts.only.user; sellFilter.tsym = opts.only.tsym; }
        const sells: any[] = await db.collection('Trade').find(sellFilter).toArray();
        const contracts = new Map<string, { user: string; tsym: string; token?: string }>();
        for (const s of sells) {
            if (!s.user || !s.tsym) continue;
            contracts.set(`${s.user}|${s.tsym}|${s.token ?? ''}`, { user: String(s.user), tsym: String(s.tsym), token: s.token != null ? String(s.token) : undefined });
        }
        let inserted = 0;
        for (const c of contracts.values()) {
            const fillFilter: any = { tsym: c.tsym, action: { $in: ['Buy', 'Sell'] }, broker: brokerMatch };
            const all: any[] = await db.collection('Trade').find(fillFilter).sort({ entryTime: 1 }).toArray();
            // One tsym can name several contracts (a Breeze tsym had no expiry before 2026-11-09): the token keeps them apart when both sides carry one.
            const ofContract = c.token ? all.filter((f) => f.token == null || String(f.token) === c.token) : all;
            const owners = await loadOrderOwners(Array.from(new Set(ofContract.map((f) => f.brokerOrderId).filter(Boolean).map(String))));
            const { fills, ambiguousOrderIds } = collapseFillsByOrderId(ofContract, (id) => owners.get(id));
            if (ambiguousOrderIds.length > 0) {
                mismatches.push({ kind: 'sellWithoutBuy', broker, tsym: c.tsym, note: `broker order(s) ${ambiguousOrderIds.join(', ')} are booked under more than one user with no recorded owner - closed trades of this contract not repaired` });
                continue;
            }
            const { pieces, unmatched } = pairFillsFifo(fills.filter((f) => f.user === c.user));
            for (const u of unmatched) {
                if (new Date(u.sell.entryTime) >= since) mismatches.push({ kind: 'sellWithoutBuy', broker, tsym: c.tsym, mongoQty: u.qty, note: `${c.user}: a Sell of ${u.qty} @ ${Number(u.sell.price).toFixed(2)} (order ${u.sell.brokerOrderId ?? '-'}) has no Buy before it in Mongo - no closed trade written` });
            }
            const wanted = pieces.filter((p) => new Date(p.sell.entryTime) >= since);
            if (wanted.length === 0) continue;
            const rows: any[] = await db.collection('closedTrades').find({ user: c.user, tsym: c.tsym, broker: brokerMatch, $or: [{ exitTime: { $gte: new Date(since.getTime() - 3600_000) } }, { repairedFromFills: true }] }).toArray();
            const used = new Set<any>();
            for (const p of wanted) {
                const at = new Date(p.sell.entryTime).getTime();
                let best: any; let bestGap = 5 * 60_000 + 1;
                // A row this repair wrote earlier is recognised by the sell it was written for, whatever day it was dated to.
                const byOrder = p.sell.brokerOrderId ? rows.find((r) => !used.has(r) && r.sellOrderId != null && String(r.sellOrderId) === String(p.sell.brokerOrderId) && Number(r.quantity) === p.qty) : undefined;
                if (byOrder) { used.add(byOrder); continue; }
                for (const r of rows) {
                    if (used.has(r) || Number(r.quantity) !== p.qty) continue;
                    if (c.token && r.token != null && String(r.token) !== c.token) continue;
                    const gap = Math.abs(new Date(r.exitTime).getTime() - at);
                    if (gap < bestGap) { best = r; bestGap = gap; }
                }
                if (best) { used.add(best); continue; }
                const exitPrice = Number(p.sell.price);
                const pnl = (exitPrice - p.entryPrice) * p.qty;
                // A Breeze order id starts with its placement date (YYYYMMDD...). A Day order cannot fill on a later day, so a fill booked after
                // that day (the notification only reached the books on a later one) closed on the order's own day: dated at that day's close.
                const bookedAt = new Date(p.sell.entryTime);
                let exitAt = bookedAt; let exitApprox = false;
                const od = broker === 'breeze' ? /^(\d{4})(\d{2})(\d{2})/.exec(String(p.sell.brokerOrderId ?? '')) : null;
                if (od) {
                    const placedClose = new Date(`${od[1]}-${od[2]}-${od[3]}T15:30:00+05:30`);
                    if (!isNaN(placedClose.getTime()) && placedClose.getTime() < bookedAt.getTime() - 3600_000) { exitAt = placedClose; exitApprox = true; }
                }
                const row = {
                    _id: randomUUID(), user: c.user, tsym: c.tsym, token: p.buy.token ?? p.sell.token, right: p.buy.right ?? p.sell.right, quantity: p.qty,
                    entryPrice: p.entryPrice, exitPrice, realizedPnL: pnl, entryTime: p.buy.entryTime, exitTime: exitAt, ...(exitApprox ? { exitTimeApprox: true, bookedAt } : {}),
                    strategy: p.buy.strategy ?? p.sell.strategy, broker: normalizeBrokerName(String(p.sell.broker ?? broker)) ?? broker,
                    createdAt: new Date(), repairedFromFills: true, sellOrderId: p.sell.brokerOrderId,
                };
                await db.collection('closedTrades').insertOne(row as any);
                inserted++;
                Log.log(`[order] ALERT: closed-trade repair ${broker}: ${c.user} ${c.tsym} - the Sell of ${p.qty} @ ${exitPrice.toFixed(2)} (order ${p.sell.brokerOrderId ?? '-'}, ${new Date(p.sell.entryTime).toISOString()}) had no closed-trade row - wrote one, P&L ${pnl.toFixed(2)}${exitApprox ? ` (dated to the order's own day ${exitAt.toISOString()})` : ''}`);
                if (new Date(row.exitTime) >= OrderBookkeeping.startOfDay()) {
                    const t = new Trade();
                    t.tsym = row.tsym; t.token = row.token; t.right = row.right; t.quantity = row.quantity; t.price = row.entryPrice; t.action = 'Sell';
                    t.user = row.user; t.broker = row.broker as any; t.open = false; t.realizedPnL = pnl; t.entryTime = row.entryTime; t.exitTime = row.exitTime; t.strategy = row.strategy;
                    this.closedTrades.push(t);
                    this.userPnL.set(c.user, (this.userPnL.get(c.user) || 0) + pnl);
                }
            }
        }
        if (inserted > 0) this.notifyPositionsChanged();
        return inserted;
    }

    // One broker's end-of-day repair. Never throws.
    async eodRepairBroker(broker: BrokerKey): Promise<EodBrokerReport> {
        const report: EodBrokerReport = { ok: false, bookedFills: 0, bookedFlat: 0, repairedClosed: 0, mismatches: [] };
        try {
            const restored = await this.restoreOpenTradesFromMongo(); // idempotent: memory must equal Mongo before it is compared with the broker
            if (!restored.ok) { report.error = `restore from Mongo failed: ${restored.error}`; return report; }
            // Mongo-only, so it runs before (and whether or not) the broker can be read: a Sell fill that never got its closed-trade row.
            report.repairedClosed = await this.repairClosedTradesFromFills(broker, report.mismatches);
            const rows = await this.readBrokerRows(broker);
            if (!rows) {
                if (!this.trades.some((t) => t.broker === broker && Number(t.quantity) > 0)) { report.ok = true; report.skipped = 'broker not readable (no valid session?) and nothing is open on it in Mongo'; return report; }
                report.error = 'positions not readable (no valid session?) while Mongo has open lots on this broker';
                Log.log(`[order] ALERT: EOD sync ${broker}: ${report.error}`);
                return report;
            }
            const fills = await this.readBrokerFills(broker);
            if (fills) report.bookedFills = await this.bookMissingSellFills(broker, fills, rows, report.mismatches);
            else report.mismatches.push({ kind: 'unattributedFill', broker, tsym: '*', note: 'the broker trade book could not be read - closes were booked from position totals only' });
            report.bookedFlat = await this.syncExternalCloses(broker, 0); // contracts flat at the broker with no exact fill: implied price
            this.collectEodMismatches(broker, (await this.readBrokerRows(broker)) ?? rows, report.mismatches);
            for (const m of report.mismatches) Log.log(`[order] ALERT: EOD sync ${broker}: ${m.kind} ${m.tsym}${m.brokerQty != null ? ` broker=${m.brokerQty}` : ''}${m.mongoQty != null ? ` mongo=${m.mongoQty}` : ''}${m.note ? ' - ' + m.note : ''}`);
            report.ok = true;
        } catch (e: any) {
            report.error = e?.message ?? String(e);
            Log.log(`[order] ALERT: EOD sync ${broker} failed:`, e);
        }
        return report;
    }

    async syncExternalClosesSafe(broker: BrokerKey, minFlatMs = 0): Promise<number> {
        try {
            return await this.syncExternalCloses(broker, minFlatMs);
        } catch (e: any) {
            Log.log(`[order] syncExternalCloses(${broker}) failed (reconcile continues):`, e?.message ?? e);
            return 0;
        }
    }

    // Recovers the app-only fields (user/target/stopLoss/gttTriggerId/strategy)
    // for one broker-reported open position, from the most recent Buy fill(s)
    // in Mongo's raw `Trade` collection - one restored Trade PER distinct
    // user who holds it, not one merged Trade for the whole tsym. The broker
    // only reports one aggregate position per contract (it has no concept of
    // "app user" at all), so if two different app users both hold the same
    // contract via the same shared broker, treating it as a single position
    // would attribute the whole thing to whichever user's Buy doc is most
    // recent, silently losing the other user's tracked position - this was a
    // known, deliberately-deferred risk ("very low likelihood on this
    // single-account setup") until the multi-user-per-broker model made it a
    // real, expected scenario. Returns an empty array (logged loudly, not
    // thrown) when no matching doc exists for any user - a manual trade
    // placed outside the app, or a failed insert - so the caller can leave it
    // visibly untracked rather than guessing at its fields.
    // `broker` scopes every query here alongside tsym/user - without it, two
    // brokers holding the identical tsym+user (e.g. BulkPcrStrategy trading
    // NIFTY23450PE on both Kite and Breeze at once) would pool both
    // brokers' Mongo Buy/Sell docs into one blended restored position on
    // restart, corrupting quantity/avgPrice and losing which broker a
    // resting exit order belongs to.
    private async restoreOpenTradesForTsym(tsym: string, brokerQuantity: number | null, brokerToken: string | undefined, broker: 'kite' | 'ant' | 'breeze' | 'prism', brokerView?: { avg?: unknown; ltp?: unknown }, contractTokens?: string[], alsoTsyms?: string[]): Promise<Trade[]> {
        const db = Mongo.getInstance()?.db;
        if (!db || !tsym) return [];

        // Matches this broker's own docs, OR any doc with no `broker` field at
        // all - every Trade document written before the broker field existed
        // has no such field, and a strict `{broker}` equality match would
        // silently exclude all of them (confirmed: MongoDB equality never
        // matches a missing field), dropping any position opened before this
        // change from restart recovery entirely. Safe to treat a fieldless
        // doc as belonging to whichever single broker is being reconciled
        // here - multi-broker overlap for one tsym+user is only possible from
        // this change onward, so a legacy fieldless doc can never actually be
        // one half of a genuine two-broker collision.
        // 'zerodha' = rows persisted before the Kite rename (scripts/migrate-broker-names.js); match both spellings.
        const brokerOrLegacy = { $or: [{ broker: broker === 'kite' ? { $in: ['kite', /^\s*zerodha\s*$/i] } : broker }, { broker: { $exists: false } }] };

        // Every user who has ever bought this tsym on this broker - each
        // reconciled independently below (including their own last-Sell
        // boundary), so one user's Sell can no longer wrongly close the
        // boundary calculation for a *different* user's still-open position on
        // the same tsym (the previous single-query version scoped the
        // last-Sell boundary globally across all users, not per user - a
        // second latent bug this fixes at the same time).
        // `alsoTsyms`: older spellings of the same contract (a Breeze tsym had no expiry before 2026-11-09); the token filter below keeps two
        // expiries that shared the old spelling apart.
        const tsymMatch = alsoTsyms && alsoTsyms.length > 0 ? { $in: [tsym, ...alsoTsyms] } : tsym;
        let users: string[] = await db.collection('Trade').distinct('user', { tsym: tsymMatch, action: 'Buy', ...brokerOrLegacy });

        // Every user's fills for this contract in one pass, collapsed so each broker order id counts once, for its owner (the
        // order-owner ledger). An order id booked under several users with no ledger answer is not guessed at: the whole contract
        // is held for manual review, because a wrong split here is what sizes the exit sells.
        const allTsymFills: any[] = await db.collection('Trade')
            .find({ tsym: tsymMatch, action: { $in: ['Buy', 'Sell'] }, ...brokerOrLegacy })
            .sort({ entryTime: 1 })
            .toArray();
        // One tsym can name SEVERAL contracts: a Breeze tsym has no expiry (NIFTY24950CE is both the 09-Nov and the 17-Nov contract), so two
        // owners holding different expiries of one strike looked like one pool of lots (1170 restored against a broker position of 780 or
        // 390, nothing restored, 2026-11-09 13:31). The caller passes the tokens of the broker position's own contract (its ANT-native token
        // and the broker's own); the fills that carry one of them are that contract's. No fill with such a token (rows written before the token
        // was stored) keeps the old tsym-wide behaviour.
        let allFills = allTsymFills;
        if (contractTokens && contractTokens.length > 0) {
            const wanted = new Set(contractTokens.map(String));
            const byContract = allTsymFills.filter((f: any) => f.token != null && wanted.has(String(f.token)));
            if (byContract.length > 0) {
                allFills = byContract;
                users = Array.from(new Set(byContract.filter((f: any) => f.action === 'Buy').map((f: any) => String(f.user))));
            }
        }
        const owners = await loadOrderOwners(Array.from(new Set(allFills.map((f: any) => f.brokerOrderId).filter(Boolean).map(String))));
        const { fills: ownedFills, ambiguousOrderIds } = collapseFillsByOrderId(allFills, (id) => owners.get(id));
        if (ambiguousOrderIds.length > 0) {
            Log.log(`[order] loadOpenTradesFromBroker: ALERT - ${tsym} (${broker}) has broker order(s) booked under more than one user with no recorded owner (${ambiguousOrderIds.join(', ')}) - restoring NOTHING for this contract, manual review required`);
            return [];
        }

        const restored: Trade[] = [];
        let totalRestoredQty = 0;
        for (const user of users) {
            // A same-tsym position can close and reopen (e.g. ContinuousStrategy's
            // root-refill re-enters the identical contract right after a
            // target-hit sell) - all-time Buy docs for this tsym can therefore
            // span multiple unrelated legs. Scope to only the Buy docs after the
            // most recent Sell (if any), so a closed leg's old fills never bleed
            // into the currently-open leg's restored price/quantity.
            //
            // Deliberately NOT bounded to "today" (startOfDay()) on either query
            // below: this app carries NRML/overnight positions across multiple
            // days (ContinuousStrategy), and a position opened yesterday but
            // still open today has no Buy doc within a same-day window - fixed
            // 2026-09-03 after exactly that scenario left 3 real overnight NIFTY
            // legs untracked despite having been opened by this app the day
            // before. tsym already encodes the specific contract (strike+expiry),
            // so an unbounded search can't cross-match a different contract.
            // Net the fills FIFO: every Sell (including a PARTIAL one - a partly-sold leg is still open for the
            // rest) consumes the oldest remaining Buy lots, so what's left is the position actually still held.
            // The old "buys after the last Sell" boundary ignored partial sells and restored the full quantity.
            const lots = netFifoLots<any>(ownedFills.filter((f: any) => f.user === user));
            // newest-first, same orientation the rest of this block expects; quantity = what is still held per lot
            const rows = lots.map((l) => ({ ...l.doc, quantity: l.remaining, originalQuantity: Number(l.doc.quantity) })).reverse();
            const row = rows[0];
            if (!row) continue; // this user's position on this tsym is fully closed

            // A multi-fill position (e.g. ContinuousStrategy's tryAverageLevel
            // averaging into an existing leg) has one Buy doc per fill, not one
            // per position - blend them into a single quantity-weighted average
            // price (same formula _processTradeEvent's live merge path uses)
            // instead of trusting just the latest fill's price.
            const totalQty = rows.reduce((sum, r) => sum + r.quantity, 0);
            const blendedPrice = rows.reduce((sum, r) => sum + r.quantity * r.price, 0) / totalQty;
            // The earliest surviving fill (rows is sorted newest-first) is this
            // leg's true original entry - distinct from the blended price/current
            // broker total above. See originalEntryPrice/originalEntryQuantity's
            // doc comments on Trade (model.ts) for why ContinuousStrategy.reconcile()
            // needs both.
            const firstFill = rows[rows.length - 1];
            const trade = new Trade();
            trade.tsym = tsym;
            // Prefer the common/ANT-native token already recorded on the Mongo doc
            // (trade.token is always ANT-native since the 2026-08-27 fix - see
            // ToDo.md) over the broker's own token, which may use a different
            // scheme (e.g. Kite's instrument_token).
            trade.token = row.token ?? brokerToken ?? '';
            trade.right = row.right;
            trade.quantity = totalQty; // this user's own portion, not the broker's aggregate total
            trade.price = blendedPrice;
            // The broker's last price, not the cost: nothing refreshes lastTradePrice for a row restored here until a tick arrives (and
            // none arrives while its strategy is disabled), so seeding it with the cost made every stop and P&L read "flat" (live
            // 2026-10-29: restored puts showed no loss while the market was 15 points under them).
            const brokerLtp = Number(brokerView?.ltp);
            trade.lastTradePrice = brokerLtp > 0 ? brokerLtp : blendedPrice;
            trade.originalEntryPrice = firstFill.price;
            trade.originalEntryQuantity = firstFill.originalQuantity ?? firstFill.quantity;
            trade.action = 'Buy';
            trade.status = 'COMPLETE';
            trade.user = user;
            trade.broker = broker;
            trade.open = true;
            trade.targetPrice = row.targetPrice;
            trade.stopLossPrice = row.stopLossPrice;
            trade.gttTriggerId = row.gttTriggerId;
            trade.antOrderNo = row.antOrderNo;
            trade.product = row.product;
            trade.prismCoverOrderNo = row.prismCoverOrderNo;
            trade.strategy = row.strategy;
            trade.entryTime = row.entryTime;

            restored.push(trade);
            totalRestoredQty += totalQty;
        }

        // Mongo-only restore (restoreOpenTradesFromMongo, brokerQuantity === null): the FIFO net IS the position, there is no broker quantity or
        // average to cross-check against, cap at or compare with.
        if (brokerQuantity == null) return restored;

        // Cost cross-check. The cost above is a FIFO net of Mongo buys and sells, which assumes exits consume the oldest lots; when an
        // exit sold the newest lot instead (a restart-orphaned older lot, live 2026-10-29: puts bought near 105-108 restored at 91) the
        // surviving lot gets the wrong cost and every stop and P&L built on it is wrong. The broker's own average is a different
        // blend, but it is independent of that assumption: when the two differ by more than 5%, say so and use the HIGHER of the two
        // (the cautious one for a long's loss stop). Only for a single owner - the broker average spans every owner's lots.
        const brokerAvg = Number(brokerView?.avg);
        // Only when this owner holds the broker's WHOLE position: if the broker holds more (another strategy's lots on the same contract), its
        // average blends their fills and says nothing about this owner's cost (2026-11-02: 85.85 FIFO vs 73.44 broker average, a false alert).
        if (restored.length === 1 && totalRestoredQty === brokerQuantity && brokerAvg > 0 && Math.abs(restored[0].price - brokerAvg) / brokerAvg > 0.05) {
            const fifoCost = restored[0].price;
            const used = Math.max(fifoCost, brokerAvg);
            Log.log(`[order] loadOpenTradesFromBroker: ALERT - ${tsym} (${broker}) cost basis uncertain: Mongo FIFO says ${fifoCost.toFixed(2)}, broker average ${brokerAvg.toFixed(2)} - using ${used.toFixed(2)}; stops and realized P&L for this position are measured from it`);
            restored[0].price = used;
        }

        if (totalRestoredQty > brokerQuantity) {
            if (!(brokerQuantity > 0)) {
                Log.log(`[order] loadOpenTradesFromBroker: ALERT - ${tsym} (${broker}) broker quantity is ${brokerQuantity} (not a long position) but Mongo restores ${totalRestoredQty} - restoring NOTHING, manual review required`);
                return [];
            }
            if (restored.length > 1) {
                // Several owners and the missing exit cannot be attributed to any one of them: guessing would size one user's exits
                // from another's lots. Restore nothing and leave it for review.
                Log.log(`[order] loadOpenTradesFromBroker: ALERT - ${tsym} (${broker}) restores to ${totalRestoredQty} across ${restored.length} users but the broker holds only ${brokerQuantity} - restoring NOTHING for this contract, manual review required`);
                return [];
            }
            // One owner, more restored than the broker holds (typically a Sell fill doc that never reached Mongo, or an exit made
            // outside this system). The broker is ground truth: cap at what it holds, so exits are never sized past the real
            // position, but keep the position monitored rather than leaving real exposure with no stop or target.
            Log.log(`[order] loadOpenTradesFromBroker: ALERT - ${tsym} (${broker}) restores to ${totalRestoredQty} but the broker holds only ${brokerQuantity} - capping at the broker quantity, manual review required`);
            restored[0].quantity = brokerQuantity;
            totalRestoredQty = brokerQuantity;
        }
        if (restored.length === 0) {
            Log.log(`[order] loadOpenTradesFromBroker: WARNING - broker reports an open position on ${tsym} (qty=${brokerQuantity}) with no matching Mongo Buy doc for any user - leaving untracked`);
        } else if (totalRestoredQty !== brokerQuantity) {
            Log.log(`[order] loadOpenTradesFromBroker: WARNING - broker reports ${brokerQuantity} total on ${tsym} but Mongo reconciliation across ${restored.length} user(s) totals ${totalRestoredQty} - broker is ground truth for aggregate size, but the per-user split above may be stale/wrong`);
        }

        return restored;
    }

    // Additive, purpose-built realized-P&L ledger - distinct from the raw
    // per-fill insert in _processTradeEvent (that's a fill log, this is one
    // row per closed position, with entry/exit timestamps). Feeds payout
    // history and drawdown-breach explanations (see src/payout.ts). Never
    // let a Mongo hiccup block live bookkeeping - the row is held in
    // unpersistedClosed until its write is confirmed, and the breach check
    // counts it from there, so the write is never awaited on the fill path.
    private unpersistedClosed = new Map<string, { user: string; realizedPnL: number; exitTime: Date; row: Record<string, any>; attempts: number; inFlight: boolean }>();

    // Never throws: a failure here must not reject the fill handler after
    // position state has already changed.
    private async persistClosedTrade(trade: Trade, user: string, exitPrice: number): Promise<boolean> {
        const id = randomUUID();
        const row = {
            _id: id,
            user,
            tsym: trade.tsym,
            token: trade.token,
            right: trade.right,
            quantity: trade.quantity,
            entryPrice: trade.price,
            exitPrice,
            realizedPnL: trade.realizedPnL,
            entryTime: trade.entryTime,
            exitTime: trade.exitTime,
            strategy: trade.strategy,
            broker: trade.broker,
            createdAt: new Date(),
        };
        this.unpersistedClosed.set(id, { user, realizedPnL: trade.realizedPnL || 0, exitTime: trade.exitTime, row, attempts: 0, inFlight: false });
        this.ensureClosedRowFlushTimer();
        return this.writeClosedRow(id);
    }

    // Writes one held row. The _id makes this idempotent: a duplicate-key error
    // means an earlier attempt (e.g. one that outlived a timeout) already landed.
    // Never more than one insert in flight per row (a flush and the immediate write
    // would otherwise both send it). A timed-out insert stays in flight until it
    // settles - and clears the row itself if it lands late - and is still safe to
    // retry because _id is unique.
    private async writeClosedRow(id: string): Promise<boolean> {
        const entry = this.unpersistedClosed.get(id);
        if (!entry || entry.inFlight) return !entry;
        try {
            const col = Mongo.getInstance()?.db?.collection('closedTrades');
            if (!col) return false;
            entry.inFlight = true;
            // Promise.resolve().then turns a synchronous throw from insertOne into a rejection,
            // so the settled chain below always runs and clears inFlight.
            const settled = Promise.resolve().then(() => col.insertOne(entry.row)).then(
                () => ({ ok: true as const }),
                (error: any) => ({ ok: false as const, error }),
            ).then((outcome) => {
                entry.inFlight = false;
                // Only a duplicate on _id means this row already landed; a duplicate on any other unique index is a real failure.
                const keys = Object.keys((outcome as any).error?.keyPattern ?? (outcome as any).error?.keyValue ?? {});
                const landed = outcome.ok || ((outcome as any).error?.code === 11000 && keys.length === 1 && keys[0] === '_id');
                if (landed) {
                    this.recentlyLanded.set(id, { user: entry.user, realizedPnL: entry.realizedPnL, exitTime: entry.exitTime, at: Date.now() });
                    this.unpersistedClosed.delete(id);
                }
                return { ...outcome, landed };
            });
            const outcome = await withFallbackTimeout(settled, LEDGER_TIMEOUT_MS, null, 'closedTrades write');
            if (outcome === null) return false; // still in flight - settled by its own promise
            if (outcome.landed) return true;
            entry.attempts += 1;
            const error = (outcome as any).error;
            if (entry.attempts % CLOSED_ROW_ERROR_LOG_EVERY === 0) {
                Log.log('[order] ERROR closedTrade for', entry.user, `still failing after ${entry.attempts} attempts - kept in memory and retried:`, error);
            } else {
                Log.log('[order] Failed to persist closedTrade for', entry.user, '- will retry:', error);
            }
            return false;
        } catch (e) {
            entry.inFlight = false;
            Log.log('[order] closedTrade write threw for', entry.user, '- will retry:', e);
            return false;
        }
    }

    // A held row must keep being retried even when no further fill (and so no flush) happens.
    // Started on the first held row; stops itself once nothing is held.
    private recentlyLanded = new Map<string, { user: string; realizedPnL: number; exitTime: Date; at: number }>();
    private closedRowFlushTimer: ReturnType<typeof setInterval> | undefined;
    private ensureClosedRowFlushTimer(): void {
        if (this.closedRowFlushTimer) return;
        this.closedRowFlushTimer = setInterval(() => {
            if (this.unpersistedClosed.size === 0) {
                clearInterval(this.closedRowFlushTimer);
                this.closedRowFlushTimer = undefined;
                return;
            }
            this.flushUnpersistedClosed().catch((e) => Log.log('[order] periodic flush of held closedTrades failed:', e));
        }, CLOSED_ROW_FLUSH_INTERVAL_MS);
        this.closedRowFlushTimer.unref?.();
    }

    private async flushUnpersistedClosed(): Promise<void> {
        for (const id of [...this.unpersistedClosed.keys()]) await this.writeClosedRow(id);
    }

    // Called after kiteExecutor.setTargetStopLoss (or the Prism-routed
    // equivalent, if ever added) mutates a trade's target/SL fields in place -
    // matches Monitor.setTargetStopLoss's old myEmitter.emit('position', ...).
    notifyTargetStopLossChanged() {
        this.notifyPositionsChanged();
    }
}

export default new OrderBookkeeping();
