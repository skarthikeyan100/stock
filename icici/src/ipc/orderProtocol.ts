// Message shapes for the order<->strategies/frontend Unix-domain-socket channel.
// `order` is the server (stable, rarely restarted); `strategies` and `frontend`
// are clients that (re)connect to it. Framed as newline-delimited JSON via
// src/ipc/jsonLines.ts over a net.Socket.

export const ORDER_SOCKET_PATH = process.env.ORDER_IPC_SOCKET || '/tmp/icici-order.sock';

export type OrderRequestType =
    | 'buyContract'
    | 'sellContract'
    | 'buyIndex'
    | 'squareOff'
    | 'canPlaceOrder'
    | 'stats'
    | 'getContractByPriceRange'
    | 'calculateRight'
    | 'getToken'
    | 'getNiftyQuote'
    | 'getOptionQuote'
    | 'getStockOptionQuote'
    | 'manualBuy'
    | 'setTargetStopLoss'
    | 'antBuyIndex'
    | 'antManualBuy'
    | 'antPlaceCoverOrder'
    | 'antSquareOff'
    | 'antSetTargetStopLoss'
    | 'reloadSession'
    | 'reloadUserLimits'
    | 'refreshTradeList'
    | 'getOrders'
    | 'updateUserSettings'
    | 'hasActiveTrade'
    | 'openTrades'
    | 'findToken'
    | 'injectTrade'
    | 'connectPrism'
    | 'getIndexQuote'
    | 'getStockQuote'
    // Bare (unprotected, self-monitored) execution path used by LegManager
    // (ContinuousStrategy/SupportResistanceStrategy) - broker-resolved per userId
    // via bookkeeping.getUserBroker in orderProcess.ts's handlers, the same
    // convention buyIndex/manualBuy/squareOff already use for real users. Not
    // broker-specific despite the historical "Zerodha" naming these replaced -
    // see orderProcess.ts's case 'buyContractBare' etc.
    | 'buyContractBare'
    | 'sellContractBare'
    | 'placeLimitBuyBare'
    | 'cancelOrderBare'
    | 'getContractByPriceRangeBare'
    | 'getPCR'
    | 'getATMTokens'
    | 'getUserAllottedCapital'
    | 'breezeBuyIndex'
    | 'breezeSquareOff'
    // Broker-agnostic freeze-quantity-chunked buy/squareoff (see
    // src/processes/order/chunkedOrder.ts) - only Breeze is wired up today
    // (BulkPcrStrategy's use case), but the dispatch already branches on
    // getBrokerExecutor(userId) so extending to other brokers is additive.
    | 'chunkedBuyIndex'
    | 'chunkedSquareOff'
    // LIMIT-priced counterpart of chunkedSquareOff - places resting sells at
    // a caller-chosen price instead of squareOffChunked's immediate market/
    // current-bid exit (see chunkedOrder.ts's squareOffLimitChunked).
    | 'chunkedSquareOffLimit';

export interface OrderRequest {
    kind: 'request';
    id: string;
    type: OrderRequestType;
    userId: string;
    payload: any;
}

export interface OrderResponse {
    kind: 'response';
    id: string;
    ok: boolean;
    result?: any;
    error?: string;
}

// Unsolicited push from order -> strategies when a broker fill/GTT-trigger comes in.
export interface FillNotification {
    kind: 'fill';
    userId: string;
    trade: any;
}

// Unsolicited push from order -> frontend on any trades/closedTrades mutation
// (fills, closes, target/SL edits) - broader than FillNotification, feeds
// GET /positionstream. No payload - frontend re-requests 'stats' and re-filters
// per connected user, same as the original per-connection filter in server.ts.
export interface PositionsChangedNotification {
    kind: 'positionsChanged';
}

export type OrderMessage = OrderRequest | OrderResponse | FillNotification | PositionsChangedNotification;
