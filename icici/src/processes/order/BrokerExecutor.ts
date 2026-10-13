import { Trade } from '../../model/model';
import Log from '../../util/Log';

export type Exchange = 'NFO' | 'BFO' | 'NSE'; // NSE added for Breeze cash-equity orders

// Thrown by every broker's cancelOrderOnX (zerodhaExecutor.ts, antExecutor.ts,
// prismExecutor.ts, breezeExecutor.ts) specifically when a post-cancel status
// recheck confirms the order actually filled, regardless of whether the
// broker's own cancel call succeeded or failed. A distinct type (not a plain
// Error) so a caller that must react differently to "already filled" than to
// a genuine cancel failure - e.g. orderProcess.ts's cancelAnyRestingLimitSell,
// which must skip a subsequent force-close squareOff for an already-filled
// position instead of double-selling it - can tell the two apart without
// string-matching an error message.
export class OrderAlreadyFilledError extends Error {
    constructor(orderId: string) {
        super(`Order ${orderId} already filled`);
        this.name = 'OrderAlreadyFilledError';
    }
}

// Shared cancel-then-recheck implementation for every broker's cancelOrderOnX
// (zerodhaExecutor/antExecutor/prismExecutor/breezeExecutor) - factored out
// after the same fix (always recheck status regardless of cancel
// success/failure; throw OrderAlreadyFilledError on a confirmed fill rather
// than swallowing or returning normally) had to be applied to all four
// independently, and two real regressions (cancel-failed+filled swallowed;
// cancel-succeeded+filled not surfaced) slipped through on one file before
// being caught by review and only then backported to the others. Each
// broker still owns its own cancel/isFilled/untrack calls (the actual
// broker API shapes genuinely differ), just not the control flow around them.
export async function cancelOrderWithFillRecheck(params: {
    orderId: string;
    label: string; // e.g. 'cancelOrderOnAnt' - only used for log lines
    cancel: () => Promise<void>;
    isFilled: () => Promise<boolean>;
    untrack: () => void;
}): Promise<void> {
    let cancelError: unknown;
    try {
        await params.cancel();
    } catch (e) {
        cancelError = e;
        // Two args (not interpolated into the message) so Log.log's own
        // Error handling (full stack, not just toString()) applies.
        Log.log(`[order] ${params.label}: cancel failed for ${params.orderId} - re-checking status:`, e);
    }
    if (await params.isFilled()) {
        Log.log(`[order] ${params.label}: ${params.orderId} filled in the cancel race window - leaving tracked so the next poll records the fill`);
        throw new OrderAlreadyFilledError(params.orderId);
    }
    if (cancelError) throw cancelError;
    params.untrack();
}

// Broker-agnostic order-placement contract - see zerodhaExecutor.ts,
// antExecutor.ts, prismExecutor.ts for the concrete implementations, and
// getBrokerExecutor() (bookkeeping.ts) for how a user's configured broker
// resolves to one of these. Deliberately excludes broker-specific mechanics
// (Zerodha's GTT/buy-halt latch, ANT's bracket/cover order fields and
// AntOrderNotifyStream push-fill detection, Prism's raw Noren order fields)
// and contract *resolution* (AntContractMaster/ZerodhaContractMaster/
// PrismContractMaster all differ genuinely) - both stay internal to each
// executor. Only the "place/close/cancel/poll a resolved order" surface is
// common.
export interface BuyRequest {
    userId: string;
    tradingSymbol: string;
    instrumentId: string; // broker-specific contract id (ANT token / Zerodha instrument_token / Prism token) - already resolved by the caller, opaque here
    quantity: number;
    exchange: Exchange;
    // Optional protection - when both are set, the implementation protects the
    // position however that broker natively can:
    //   Zerodha: places a GTT after entry (or registers an in-app exitMonitor
    //     watch instead, per the placing user's useGTT setting).
    //   ANT: places a native bracket order (BO) at entry instead of a plain order.
    //   Prism: places a native cover order (product_type 'H') at entry.
    // Omit both for an unprotected/"bare" buy (ContinuousStrategy's use case -
    // it self-monitors every leg's target/adverse-level thresholds itself).
    targetPoints?: number;
    stopLossPoints?: number;
    // Zerodha-only (for now): when set, each chunk's resting limit buy is
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

export interface BrokerExecutor {
    readonly brokerName: 'zerodha' | 'ant' | 'prism' | 'breeze';

    hasValidSession(): Promise<boolean>;

    buy(request: BuyRequest): Promise<Trade>;

    // Matches the signature zerodhaExecutor.squareOffOnZerodha/antExecutor.squareOffOnAnt
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
    // Optional on the interface for callers that can't assume it (a future
    // broker executor need not implement it) - every current executor
    // (Zerodha, ANT, Breeze, Prism) does implement it as of this writing.
    squareOffLimit?(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: Exchange, limitPrice: number): Promise<{ orderId: string }>;

    // Each broker's cancelOrderOnX implementation throws OrderAlreadyFilledError
    // (not a plain Error) specifically when its post-cancel status recheck
    // confirms the order actually filled, regardless of whether the broker's
    // own cancel call itself succeeded or failed - callers that must not then
    // also force-close the same quantity (e.g. cancelAnyRestingLimitSell)
    // check for this type to tell "already closed, don't touch again" apart
    // from a genuine cancel failure that still leaves the position open.
    cancelOrder(orderId: string): Promise<void>;

    getFillPrice(orderId: string): Promise<number>;

    getPositions(): Promise<BrokerPosition[]>;

    getTrades(): Promise<Trade[]>;
}
