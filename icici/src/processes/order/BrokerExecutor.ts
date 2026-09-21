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

    cancelOrder(orderId: string): Promise<void>;

    getFillPrice(orderId: string): Promise<number>;

    getPositions(): Promise<BrokerPosition[]>;

    getTrades(): Promise<Trade[]>;
}
