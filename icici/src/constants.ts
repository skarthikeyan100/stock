export const NIFTY = 'NIFTY'
export const FINNIFTY = 'FINNIFTY'
export const BANKNIFTY = 'BANKNIFTY'
export const VIRTUAL = false
export const SIMULATION = false;
export const CALL = 'call';
export const PUT = 'put';
export const BOUGHT = 'BOUGHT';
export const CLOSED = 'CLOSED';
export const USER_LOSS_LIMIT = 150000000;
export const DEFAULT_LOT_LIMIT = 10;
export const DEFAULT_MAX_INVESTMENT = 100000;

// Mock broker flags — set MOCK_BROKER=false for live trading
export const MOCK_BROKER = process.env.MOCK_BROKER === 'true';   // true = use MockAPI instead of real Shoonya broker
export const MOCK_QUOTES = process.env.MOCK_QUOTES === 'true';   // true = mock subscribe/quotes (Option B); false = real quotes, mock orders only (Option A)
export const MOCK_DATE   = process.env.MOCK_DATE || '2026-03-02';  // date to replay from Quote collection (YYYY-MM-DD)

