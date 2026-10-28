export const NIFTY = 'NIFTY'
export const FINNIFTY = 'FINNIFTY'
export const BANKNIFTY = 'BANKNIFTY'
export const VIRTUAL = false
export const SIMULATION = false;
export const CALL = 'call';
export const PUT = 'put';
export const BOUGHT = 'BOUGHT';
export const CLOSED = 'CLOSED';
// Loss limit of a strategy pseudo-user with no user document (BulkPcr-NIFTY etc.): effectively unlimited, set explicitly in
// applyConfigStrategyLimits. Never a fallback for an unknown user - see UNKNOWN_USER_LOSS_LIMIT.
export const USER_LOSS_LIMIT = 150000000;
// Loss limit applied to a user who is missing from the settings cache (not yet synced / unknown): fail closed, not open.
export const UNKNOWN_USER_LOSS_LIMIT = 15000;
export const DEFAULT_LOT_LIMIT = 10;
export const DEFAULT_MAX_INVESTMENT = 100000;
export const DEFAULT_PROFIT_SPLIT_PERCENT = 80;
export const TDS_RATE_PERCENT = 10;

// Exchange-mandated max quantity per single NIFTY options order (27 lots x 65).
// Confirmed 2026-09-18. Used by BulkPcrStrategy's chunked buy/sell (see
// src/processes/order/chunkedOrder.ts) - any single order above this is
// rejected by the exchange.
export const NIFTY_FREEZE_QUANTITY = 1755;

// Exchange-mandated max quantity per single SENSEX (BFO) options order.
// 1000 units per the NSE/BSE quantity-freeze-limit revision effective
// 2025-11-03 (https://zerodha.com/marketintel/bulletin/432323/ - BSE did not
// revise SENSEX in that round, so this figure predates and survives it).
// Re-verify against the live BFO contract master's MaxTradQty field if this
// is ever suspected stale - exchange freeze limits are revised periodically.
// Used by chunkedOrder.ts's buy/squareOff/squareOffLimit helpers whenever
// the request/exchange is BFO, instead of silently reusing NIFTY's much
// larger NFO limit (found on code review 2026-10-20 - a single un-chunked
// SENSEX order sized above this would be rejected by the exchange outright).
export const SENSEX_FREEZE_QUANTITY = 1000;

// Mock broker flags — set MOCK_BROKER=false for live trading
export const MOCK_BROKER = process.env.MOCK_BROKER === 'true';   // true = use MockAPI instead of real Shoonya broker
export const MOCK_QUOTES = process.env.MOCK_QUOTES === 'true';   // true = mock subscribe/quotes (Option B); false = real quotes, mock orders only (Option A)
export const MOCK_DATE   = process.env.MOCK_DATE || '2026-03-02';  // date to replay from Quote collection (YYYY-MM-DD)

