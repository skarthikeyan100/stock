import { Trade } from '../../model/model';

export type Exchange = 'NFO' | 'BFO' | 'NSE'; // NSE added for Breeze cash-equity orders

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
    // Not implemented for every broker (e.g. Prism) - callers must check for its
    // presence before use.
    squareOffLimit?(userId: string, tradingSymbol: string, instrumentId: string, quantity: number, exchange: Exchange, limitPrice: number): Promise<{ orderId: string }>;

    cancelOrder(orderId: string): Promise<void>;

    getFillPrice(orderId: string): Promise<number>;

    getPositions(): Promise<BrokerPosition[]>;

    getTrades(): Promise<Trade[]>;
}
