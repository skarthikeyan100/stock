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
    | 'reconcileBrokerPositions'
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
    | 'chunkedSquareOffLimit'
    // Broker-uniform query of this app's own pending-order trackers (pendingAntLimitOrders.ts
    // and its zerodha/breeze/prism siblings - all four share the same {quantity, action, ...}
    // shape) for a given tsym, filtered to SELL orders only. Added for BulkPcrStrategy.reconcile()
    // to check whether an exit sell already survived from before a crash (live 2026-10-21 -
    // reconcile's no-persisted-state fallback was placing a brand-new sell on top of one still
    // resting from before the incident, oversubscribing the sell quantity and triggering a
    // broker margin-shortfall rejection, not a broker netting bug) before placing a duplicate.
    | 'getPendingSells'
    // ANT-specific (not broker-generic like the 'Bare' family above, which
    // has no ant branch) - used by TopStockOptionsOpeningGapStrategy, which
    // runs in the separate `strategies` process and so cannot call
    // antExecutor.ts's enterPosition/placeLimitSellBareOnAnt directly (those
    // rely on bookkeeping.ts/exitMonitor.ts/pendingAntLimitOrders.ts
    // singletons that only do anything useful inside `order`). Plain buy,
    // no bracket/cover/target broker-side - target is recorded on the Trade
    // and the caller places its own separate resting sell via
    // 'antPlaceLimitSellBare' right after.
    | 'antBuyTargetOnly'
    | 'antPlaceLimitSellBare'
    // Broker-parameterized counterpart of 'antPlaceLimitSellBare' - same
    // plain resting-limit-sell-only shape, dispatched by an explicit
    // `broker` field (zerodha/breeze/ant) instead of being ANT-only, so
    // TopStockOptionsOpeningGapStrategy's zerodha/breeze legs can place
    // their own target-only resting sell too.
    | 'brokerPlaceLimitSellBare'
    // ANT bare ops for BulkPcrStrategy's hedge tree (LegManager via
    // antLegOps.ts) - see orderProcess.ts's case comments for why these are
    // ANT-specific rather than routed through the broker-generic 'Bare'
    // family above (BulkPcr trades the hedge tree on ANT only, and ANT has
    // no contract-by-price-range lookup of its own).
    | 'antBuyContractBare'
    | 'antSquareOffBare'
    | 'antCancelOrderBare'
    // Broker-dispatched (see orderProcess.ts's case comment) - not ANT-specific like
    // the antXBare family above despite living in the same block.
    | 'cancelRestingLimitSells'
    // ButterflyStrategy's narrow sell-to-open/buy-to-close exception (see
    // Zerodha.ts's NEVER-SHORT GUARD comment and bookkeeping.recordShortFill) -
    // dispatches per-broker in orderProcess.ts. 'resolveOptionContract' is a
    // read-only strike+right -> {tsym, token, exchange} lookup, broker-dispatched
    // to each broker's own contract master, used by ButterflyStrategy to resolve
    // all 4 of its legs before placing anything.
    | 'butterflySellToOpen'
    | 'butterflyBuyToClose'
    // Long-side (buy-to-open/sell-to-close) legs, explicit-broker dispatch. NOT the
    // existing 'buyContractBare'/'sellContractBare' (those resolve broker via
    // bookkeeping.getUserBroker(userId) - a per-USER setting, wrong for one strategy
    // instance that runs several brokers' legs concurrently within one tick) nor
    // 'antBuyContractBare'/'buyContract' alone (ant/prism-only, no zerodha/breeze
    // equivalent with this same explicit-broker shape). Mechanically identical to the
    // existing bare buy/sell primitives per broker - just dispatched by an explicit
    // `broker` field in the payload instead of a per-user default.
    | 'butterflyBuyLeg'
    | 'butterflyCloseLeg'
    | 'resolveOptionContract';

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

// Unsolicited push from order -> strategies when a resting limit order is
// cancelled/rejected (e.g. a DAY-validity order expires unfilled at end of session).
// Allows strategies like BulkPcrStrategy to detect and re-place exits that were
// orphaned by broker cancellation, rather than silently abandoning the position.
export interface OrderCancelledNotification {
    kind: 'cancelled';
    userId: string;
    tradingSymbol: string;
    instrumentToken: string;
    quantity: number;        // qty that was resting in the cancelled/rejected order
    exchange: 'NFO' | 'BFO';
    action: 'Buy' | 'Sell';
    broker: 'zerodha' | 'breeze' | 'ant' | 'prism';
    orderId: string;
    reason: 'CANCELLED' | 'REJECTED';
    // The broker's own rejection remark (e.g. a margin-shortfall message), when available.
    // Only populated on the ANT path today (AliceBlue's rejreason field) - other brokers'
    // pending-order pollers don't yet surface an equivalent.
    rejectReason?: string;
}

export type OrderMessage = OrderRequest | OrderResponse | FillNotification | PositionsChangedNotification | OrderCancelledNotification;
