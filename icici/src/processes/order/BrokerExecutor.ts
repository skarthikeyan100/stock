import { Trade } from '../../model/model';
import Log from '../../util/Log';

export type Exchange = 'NFO' | 'BFO' | 'NSE'; // NSE added for Breeze cash-equity orders
export type OptionExchange = Exclude<Exchange, 'NSE'>; // an option contract's exchange

// Thrown by every broker's cancelOrderOnX (kiteExecutor.ts, antExecutor.ts,
// prismExecutor.ts, breezeExecutor.ts) specifically when a post-cancel status
// recheck confirms the order actually filled, regardless of whether the
// broker's own cancel call succeeded or failed. A distinct type (not a plain
// Error) so a caller that must react differently to "already filled" than to
// a genuine cancel failure - e.g. orderProcess.ts's cancelAnyRestingLimitSell,
// which must skip a subsequent force-close squareOff for an already-filled
// position instead of double-selling it - can tell the two apart without
// string-matching an error message.
// filledQuantity is the actual confirmed-filled quantity as of the status
// recheck - NOT necessarily the order's full original quantity. A resting
// sell/buy can partially fill before the remainder is cancelled (Kite
// reports this as a 'CANCELLED' history record with a nonzero
// filled_quantity; AliceBlue/Breeze equivalently via filledQuantity/
// quantity-pending-cancelled), and a caller that assumes "already filled"
// always means "the whole order" will silently either double-sell the
// genuinely-still-open remainder or drop the real partial fill from
// bookkeeping entirely - see gaps.md's "Partial-fill accounting" entry for
// the full incident history. Every caller of this error MUST use
// filledQuantity, never the order's own requested quantity, to decide how
// much is actually closed.
export class OrderAlreadyFilledError extends Error {
    readonly filledQuantity: number;
    constructor(orderId: string, filledQuantity: number) {
        super(`Order ${orderId} already filled (qty=${filledQuantity})`);
        this.name = 'OrderAlreadyFilledError';
        this.filledQuantity = filledQuantity;
    }
}

// NEVER-SHORT GUARD for brokers whose client layer has none (Kite has its own in Kite.getSellableQuantity). How much of a
// contract can still be sold without going net short: the broker's live net long position minus quantity already resting in
// sells. 2026-10-19: strategies re-sold their tracked quantity on retries and mass closes while earlier sells had already filled,
// leaving a naked short. Refuses when nothing is sellable and clamps when the request exceeds it. A live position that cannot be
// read leaves the request unchanged (logged): refusing blind would block stop-loss exits on a transient API error.
export async function neverShortSellable(args: {
    label: string;
    quantity: number;
    livePosition: () => Promise<number>;
    restingSellQuantity: number;
    // Re-read once after a short wait before refusing on a flat reading. Only for a sell placed right after the entry fill (a target
    // sell, a sell-back), where the positions endpoint can lag; never for a stop-loss/EOD exit, which must not wait.
    recheckIfFlat?: boolean;
}): Promise<number> {
    let live: number;
    try {
        live = await args.livePosition();
        // A positions endpoint can lag a fill by a few seconds (a target sell placed right after the entry fill, a sell-back right
        // after its buy): before refusing on a flat reading, look once more.
        if (args.recheckIfFlat && Number.isFinite(live) && live - args.restingSellQuantity <= 0) {
            await new Promise((r) => setTimeout(r, 2500));
            live = await args.livePosition();
        }
    } catch (e) {
        Log.log(`[order] NEVER-SHORT GUARD: could not read the live position for ${args.label} - selling the requested ${args.quantity} unverified:`, e);
        return args.quantity;
    }
    if (!Number.isFinite(live)) return args.quantity;
    const sellable = live - args.restingSellQuantity;
    if (sellable <= 0) {
        Log.log(`[order] ALERT: NEVER-SHORT GUARD refused a sell of ${args.quantity} ${args.label} - nothing sellable (live=${live}, resting sells=${args.restingSellQuantity}); position tracking is out of sync with the broker`);
        throw new Error(`NEVER-SHORT GUARD: nothing sellable for ${args.label} (live=${live}, resting=${args.restingSellQuantity}) - refusing to sell ${args.quantity}`);
    }
    if (args.quantity > sellable) {
        Log.log(`[order] ALERT: NEVER-SHORT GUARD clamped a sell of ${args.label} from ${args.quantity} to ${sellable} - position tracking is out of sync with the broker`);
        return sellable;
    }
    return args.quantity;
}

// The "nothing left to sell" result of a square-off whose resting sells already closed the position: a zero-quantity, complete Sell.
export function emptyExitTrade(userId: string, tsym: string, broker: 'kite' | 'ant' | 'breeze' | 'prism'): Trade {
    const done = new Trade();
    done.tsym = tsym;
    done.quantity = 0;
    done.price = 0;
    done.action = 'Sell';
    done.status = 'COMPLETE';
    done.user = userId;
    done.broker = broker;
    return done;
}

// Cancels a broker's resting limit sells on one contract ahead of a market-style exit (squareOff), so both cannot fill and
// oversell (e.g. BulkPcr's resting target chunks). Each cancel rechecks for a fill (OrderAlreadyFilledError); a fill that landed in
// the race window is not booked yet (the poller books it), so it is subtracted from the quantity to sell. A cancel that fails for
// any other reason leaves the resting order's state unknown, so this throws rather than risk a double-sell.
// `openQuantity` reads the live bookkeeping size, since the poller may book a fill (shrinking it) while a cancel is in flight.
export async function cancelRestingSellsAheadOfExit(args: {
    pending: { orderId: string; action: string; exchange?: OptionExchange }[];
    cancel: (orderId: string, exchange?: OptionExchange) => Promise<void>;
    openQuantity: () => number | undefined;
    requested: number;
    label: string;
}): Promise<{ quantity: number; cancelledAny: boolean }> {
    const resting = args.pending.filter((o) => o.action === 'Sell');
    if (resting.length === 0) return { quantity: args.requested, cancelledAny: false };
    const openBefore = args.openQuantity();
    let filledNotBooked = 0;
    let cancelledAny = false;
    for (const order of resting) {
        try {
            await args.cancel(order.orderId, order.exchange);
            cancelledAny = true;
        } catch (e) {
            if (e instanceof OrderAlreadyFilledError) filledNotBooked += e.filledQuantity;
            else throw e;
        }
    }
    const openNow = args.openQuantity();
    let quantity = args.requested;
    if (openBefore !== undefined && openNow !== undefined) {
        // The smaller of the two views is right in both orderings (fill booked during the cancel, or not yet booked).
        quantity = Math.min(quantity, openNow, openBefore - filledNotBooked);
    } else {
        quantity = Math.min(quantity, args.requested - filledNotBooked);
    }
    if (filledNotBooked > 0 || cancelledAny) Log.log(`[order] ${args.label}: resting sell(s) settled (cancelled=${cancelledAny}, filledNotBooked=${filledNotBooked}) - selling ${quantity}`);
    return { quantity, cancelledAny };
}

// Shared cancel-then-recheck implementation for every broker's cancelOrderOnX
// (kiteExecutor/antExecutor/prismExecutor/breezeExecutor) - factored out
// after the same fix (always recheck status regardless of cancel
// success/failure; throw OrderAlreadyFilledError on a confirmed fill rather
// than swallowing or returning normally) had to be applied to all four
// independently, and two real regressions (cancel-failed+filled swallowed;
// cancel-succeeded+filled not surfaced) slipped through on one file before
// being caught by review and only then backported to the others. Each
// broker still owns its own cancel/isFilled/untrack calls (the actual
// broker API shapes genuinely differ), just not the control flow around them.
export async function cancelOrderWithFillRecheck(params: Parameters<typeof cancelAndRecheck>[0] & {
    // The pending-order poller marks the order "cancelling" for the whole call: a poll that lands between the broker's cancel and
    // our untrack sees CANCELLED, and without the mark it would tell the cancelled listeners, which re-place an exit for quantity a
    // force-close is already selling. A marked order still has its fills booked; only the untrack/notify is left to this caller.
    beginCancel: () => void;
    endCancel: () => void;
    // Called when the recheck finds a fill in the race window (OrderAlreadyFilledError): the order stays tracked so the poller books
    // that fill, but its eventual CANCELLED status must not reach the cancelled listeners: every caller of an explicit cancel
    // (force-closes, squareOff-ahead-of-exit, the hedge hand-off) sells or owns the rest itself, and a re-placed exit would sell it
    // twice. Cleared by untrack.
    silenceListeners: () => void;
}): Promise<void> {
    params.beginCancel();
    try {
        await cancelAndRecheck(params);
    } catch (e) {
        if (e instanceof OrderAlreadyFilledError) params.silenceListeners();
        throw e;
    } finally {
        params.endCancel();
    }
}

async function cancelAndRecheck(params: {
    orderId: string;
    label: string; // e.g. 'cancelOrderOnAnt' - only used for log lines
    cancel: () => Promise<void>;
    // Actual confirmed-filled quantity as of the recheck (0 = not filled at
    // all) - NOT a boolean. A partial fill (some quantity filled, the rest
    // genuinely cancelled) must return that partial number, not collapse it
    // to true/false - see OrderAlreadyFilledError's own comment for why.
    //
    // terminal: whether the order has reached a FINAL state at the broker
    // (COMPLETE, or CANCELLED/REJECTED with nothing still resting) as of
    // this same recheck - i.e. no further fills are possible without a new
    // order. This is load-bearing specifically when cancel() itself FAILED
    // (see below): a cancel() call failing does NOT by itself mean the
    // order reached a terminal state - it can just as easily mean the
    // cancel API call failed for an unrelated/transient reason (network,
    // rate-limit, auth) while the order is still genuinely resting at the
    // broker, able to fill further after this function returns. Confirmed
    // via code review: an earlier version treated ANY confirmed partial
    // fill (filledQuantity > 0) as proof the unfilled remainder was gone,
    // regardless of whether cancel() actually succeeded - which let a
    // caller (e.g. squareOffOnBreeze) place a brand-new order for that same
    // "remainder" while the ORIGINAL order was still live for it too,
    // risking a double-sell if both eventually fill.
    isFilled: () => Promise<{ filledQuantity: number; terminal: boolean }>;
    untrack: () => void;
}): Promise<void> {
    let cancelFailed = false;
    let cancelError: unknown;
    try {
        await params.cancel();
    } catch (e) {
        cancelFailed = true;
        cancelError = e;
        // Two args (not interpolated into the message) so Log.log's own
        // Error handling (full stack, not just toString()) applies.
        Log.log(`[order] ${params.label}: cancel failed for ${params.orderId} - re-checking status:`, e);
    }
    // isFilled() is itself a real network call and can fail independently of
    // the cancel above. Two things must both be true to reach untrack() at
    // the bottom: the recheck must have POSITIVELY confirmed "not filled"
    // (not merely failed to confirm either way), and the cancel must not
    // have failed either. If isFilled() throws, rethrow immediately instead
    // of falling through - confirmed via code review (two rounds): an
    // earlier version defaulted the unconfirmed case to "not filled" and let
    // it reach untrack() unconditionally, silently dropping tracking of an
    // order whose actual status was never established; before that, an even
    // earlier version let the isFilled() throw silently replace cancelError.
    // Prioritize cancelError when both calls failed - it's the more specific,
    // more actionable of the two for diagnosing a live incident.
    let filledQuantity: number;
    let terminal: boolean;
    try {
        ({ filledQuantity, terminal } = await params.isFilled());
    } catch (e) {
        Log.log(`[order] ${params.label}: status recheck failed for ${params.orderId} - leaving tracked, status unconfirmed:`, e);
        throw cancelFailed ? cancelError : e;
    }
    // Ambiguous case: cancel() failed AND the recheck shows the order is
    // still genuinely open (not terminal) - we cannot tell whether the
    // unfilled remainder is gone or still resting live, so we must not let
    // the caller treat this as resolved either way (not "safely closed" via
    // OrderAlreadyFilledError, not "safely untracked"). Surface the original
    // cancel failure and leave the order tracked so the next poll/attempt
    // re-evaluates it, instead of guessing.
    if (cancelFailed && !terminal) {
        Log.log(`[order] ${params.label}: cancel failed for ${params.orderId} and it's still open at the broker (filled so far: ${filledQuantity}) - leaving tracked, NOT treating the remainder as resolved`);
        throw cancelError;
    }
    if (filledQuantity > 0) {
        Log.log(`[order] ${params.label}: ${params.orderId} filled (qty=${filledQuantity}) in the cancel race window - leaving tracked so the next poll records the fill`);
        throw new OrderAlreadyFilledError(params.orderId, filledQuantity);
    }
    if (cancelFailed) throw cancelError;
    params.untrack();
}

// Broker-agnostic order-placement contract - see kiteExecutor.ts,
// antExecutor.ts, prismExecutor.ts for the concrete implementations, and
// getBrokerExecutor() (bookkeeping.ts) for how a user's configured broker
// resolves to one of these. Deliberately excludes broker-specific mechanics
// (Kite's GTT/buy-halt latch, ANT's bracket/cover order fields and
// AntOrderNotifyStream push-fill detection, Prism's raw Noren order fields)
// and contract *resolution* (AntContractMaster/KiteContractMaster/
// PrismContractMaster all differ genuinely) - both stay internal to each
// executor. Only the "place/close/cancel/poll a resolved order" surface is
// common.
export interface BuyRequest {
    userId: string;
    tradingSymbol: string;
    instrumentId: string; // broker-specific contract id (ANT token / Kite instrument_token / Prism token) - already resolved by the caller, opaque here
    quantity: number;
    exchange: Exchange;
    // Optional protection - when both are set, the implementation protects the
    // position however that broker natively can:
    //   Kite: places a GTT after entry (or registers an in-app exitMonitor
    //     watch instead, per the placing user's useGTT setting).
    //   ANT: places a native bracket order (BO) at entry instead of a plain order.
    //   Prism: places a native cover order (product_type 'H') at entry.
    // Omit both for an unprotected/"bare" buy (ContinuousStrategy's use case -
    // it self-monitors every leg's target/adverse-level thresholds itself).
    targetPoints?: number;
    stopLossPoints?: number;
    // Kite-only (for now): when set, each chunk's resting limit buy is
    // cancelled early if live LTP drifts this many points above that chunk's
    // own limit price, rather than waiting out getFillPrice's full timeout.
    // Omitted (or any other broker) = today's unmodified timeout-only behavior.
    driftCancelPoints?: number;
}

export interface BrokerPosition {
    tradingSymbol: string;
    instrumentId: string;
    quantity: number;
    avgPrice: number;
    exchange: string;
}

// Operations only some brokers have. A caller checks the flag and refuses with a clear message; the unsupported executor slot
// also throws, so a missed check still fails loudly. (Every broker has enterShort/buyToClose/marketBuy/marketSell/
// getLiveQuantity/resolveContract today, so those carry no flag.)
export interface BrokerCapabilities {
    placeLimitBuy: boolean;
    getContractByPriceRange: boolean;
}

export type OptionRight = 'CE' | 'PE';
export type OptionIndex = 'NIFTY' | 'SENSEX';

export interface ResolvedContract {
    tsym: string;
    token: string; // always the ANT common token, never a broker's own instrument id (tick routing keys off it)
    exchange: 'NFO' | 'BFO';
}

export interface BrokerExecutor {
    readonly brokerName: 'kite' | 'ant' | 'prism' | 'breeze';
    readonly capabilities: BrokerCapabilities;

    // "Bare" ops: a single order with no GTT/bracket/cover protection, for strategies that self-monitor their legs.
    // `instrumentToken` is the ANT common token carried on Trade.token (brokers that need their own id resolve it).
    // placeLimitBuy / getContractByPriceRange throw for a broker whose capabilities rule them out.
    enterShort(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade>;
    buyToClose(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade>;
    marketBuy(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade>;
    marketSell(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, exchange: 'NFO' | 'BFO'): Promise<Trade>;
    placeLimitBuy(userId: string, tradingSymbol: string, instrumentToken: string, quantity: number, price: number, exchange: 'NFO' | 'BFO'): Promise<{ orderId: string }>;

    // Net open quantity of a contract, read live from the broker.
    getLiveQuantity(tradingSymbol: string): Promise<number>;

    // Read-only contract lookups. resolveContract: strike + right -> contract (nearest expiry). getContractByPriceRange: the
    // contract whose premium is closest to (and not below) minPremium.
    resolveContract(index: OptionIndex, strike: number, right: OptionRight): Promise<ResolvedContract>;
    getContractByPriceRange(underlyingLtp: number, optionType: 'CE' | 'PE', index: OptionIndex, minPremium: number, excludeStrikes: Set<number>): Promise<any>;

    // This broker's resting limit orders on one contract (the pending-order tracker's view).
    findPendingOrders(userId: string, tradingSymbol: string): { orderId: string; action: 'Buy' | 'Sell'; quantity: number; exchange: OptionExchange }[];

    buy(request: BuyRequest): Promise<Trade>;

    // Matches the signature kiteExecutor.squareOffOnKite/antExecutor.squareOffOnAnt
    // already both happen to share exactly today - no change needed to this shape.
    squareOff(userId: string, tradingSymbol: string, quantity: number, exchange: Exchange): Promise<Trade>;

    // Optional: places a resting LIMIT sell at `limitPrice` instead of squareOff's
    // immediate (market or current-bid) exit - for a caller that must lock in a
    // specific price rather than accept whatever squareOff's own pricing gets
    // filled at (see BulkPcrStrategy's target-hit exit, added 2026-09-22 after a
    // blind MARKET square-off filled below entry on a stray tick). Returns as
    // soon as the order is resting, NOT once filled - the fill round-trips back
    // later via each broker's own pending-limit-order poller into the normal
    // bookkeeping.recordFill -> onFill -> strategy.updateTrade path. instrumentId
    // is the broker-agnostic token (ANT commonToken) already carried on Trade.token
    // for this position, needed by the pending-order tracker for the eventual fill.
    // Required: all four executors implement it.
    // `quantity` (when present) is what was actually placed: Kite's never-short guard can clamp a sell below the request.
    squareOffLimit(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: Exchange, limitPrice: number): Promise<{ orderId: string; quantity?: number }>;

    // Each broker's cancelOrderOnX implementation throws OrderAlreadyFilledError
    // (not a plain Error) specifically when its post-cancel status recheck
    // confirms the order actually filled, regardless of whether the broker's
    // own cancel call itself succeeded or failed - callers that must not then
    // also force-close the same quantity (e.g. cancelAnyRestingLimitSell)
    // check for this type to tell "already closed, don't touch again" apart
    // from a genuine cancel failure that still leaves the position open.
    // `exchange` (when the caller knows it, e.g. from the pending-order tracker) is used by brokers whose cancel API needs it (Breeze).
    cancelOrder(orderId: string, exchange?: OptionExchange): Promise<void>;
}
