# API Documentation

This document outlines all the REST API endpoints available in the ICICI trading server. Organized by functional area.

## Base URL
```
http://localhost:3000
```

---

## Authentication Endpoints

### POST /auth/login
**Description:** Create or retrieve a user account

**Request Body:**
```json
{
  "email": "user@example.com",
  "name": "User Name",
  "picture": "https://example.com/pic.jpg"
}
```

**Response:** User object with session cookie set
```json
{
  "email": "user@example.com",
  "name": "User Name",
  "picture": "https://example.com/pic.jpg",
  "lossLimit": 15000,
  "lotCount": 10,
  "investmentMode": "...",
  "investmentAmount": "..."
}
```

**Status Codes:** 200, 400, 500

---

### GET /auth/me
**Description:** Retrieve current authenticated user

**Headers:** Cookie: session=<signed_cookie>

**Response:** User object (same as login response)

**Status Codes:** 200, 401, 500

---

### POST /auth/logout
**Description:** Clear user session

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

## User Management Endpoints

### GET /users
**Description:** Get all users with their current session P&L and trade status

**Response:**
```json
[
  {
    "email": "user@example.com",
    "name": "User Name",
    "picture": "...",
    "lossLimit": 15000,
    "lotCount": 10,
    "investmentMode": "...",
    "investmentAmount": "...",
    "sessionPnL": 5000,
    "hasActiveTrade": true
  }
]
```

**Status Codes:** 200, 500

---

### POST /users
**Description:** Create a new user

**Request Body:**
```json
{
  "email": "user@example.com",
  "name": "User Name",
  "lossLimit": 15000,
  "lotCount": 10,
  "role": "user"
}
```

**Response:** Created user object

**Status Codes:** 200, 400, 409 (conflict if user exists), 500

---

### POST /users/:email/settings
**Description:** Update user trading settings

**URL Parameters:**
- `email` - User email

**Request Body:**
```json
{
  "lossLimit": 15000,
  "lotCount": 10,
  "investmentMode": "...",
  "investmentAmount": "..."
}
```

**Response:** Updated user object

**Status Codes:** 200, 404, 500

---

### DELETE /users/:email
**Description:** Delete a user

**URL Parameters:**
- `email` - User email

**Response:** Empty (200 OK)

**Status Codes:** 200, 404, 500

---

### PATCH /users/:email/role
**Description:** Update user role

**URL Parameters:**
- `email` - User email

**Request Body:**
```json
{
  "role": "admin"
}
```

**Response:** Updated user object

**Status Codes:** 200, 400, 404, 500

---

### PATCH /users/:email/profile
**Description:** Update user profile information

**URL Parameters:**
- `email` - User email

**Request Body:**
```json
{
  "phone": "+91-9876543210"
}
```

**Response:** Updated user object with phone

**Status Codes:** 200, 404, 500

---

### PATCH /users/:email/verify
**Description:** Update verification status for user fields

**URL Parameters:**
- `email` - User email

**Request Body:**
```json
{
  "field": "email|phone|address|dob|pan",
  "verified": true
}
```

**Response:** Updated user object

**Status Codes:** 200, 400, 404, 500

---

### POST /users/:email/documents/:docType
**Description:** Upload verification documents

**URL Parameters:**
- `email` - User email
- `docType` - Document type (address, dob, or pan)

**Request:** Multipart form data with file

**Response:**
```json
{
  "id": "file_id",
  "filename": "email_doctype_timestamp.pdf"
}
```

**Status Codes:** 200, 400, 404, 500

**File Limits:** Max 5MB

---

### GET /users/:email/documents/:docType
**Description:** Download verification document

**URL Parameters:**
- `email` - User email
- `docType` - Document type (address, dob, or pan)

**Response:** File download

**Status Codes:** 200, 404, 500

---

## OAuth Endpoints

### GET /prism/oauthurl
**Description:** Get OAuth authorization URL

**Response:**
```json
{
  "url": "https://oauth.example.com/authorize?..."
}
```

**Status Codes:** 200

---

### GET /prism/callback
**Description:** OAuth callback endpoint (redirect from OAuth provider). Registered as the Redirect URL in the Shoonya broker dashboard (trade.shoonya.com) — if this path ever changes again, that dashboard setting must be updated too.

**Query Parameters:**
- `code` - Authorization code
- `state` - State parameter

**Response:**
```json
{
  "message": "Authorization successful!",
  "code": "...",
  "next": "Use this code with: http://localhost:3000/prism/token?code=..."
}
```

**Status Codes:** 200, 400

---

### Per-broker login and callback routes
`server.ts` registers these in a loop over the four brokers (`ant`, `kite`, `breeze`, `prism`), so they are not greppable by path:
- `GET /{broker}/login` - redirects to the broker's authorization page.
- `GET /{broker}/callback` - exchanges the returned code/token, tells `data` to reconnect, reloads the session in `order`, then redirects to `/`. Responds 400 for missing credentials, 500 when the exchange fails and 502 when the login succeeded but `order` could not load the new session (retry the login). The Prism authorization code is stored only after a successful exchange.
- `POST /breeze/callback` - same handler (ICICI can redirect with a POST form).
- `GET /shoonya/callback` - alias of `/prism/callback`'s handler (the Shoonya dashboard's registered redirect URI).

---

### GET /prism/authcode
**Description:** Retrieve stored authorization code

**Response:**
```json
{
  "code": "..."
}
```

**Status Codes:** 200, 404

---

## Login Endpoints

### GET /prism/quick-login
**Description:** Login using OTP (QuickAuth — deprecated, Shoonya no longer supports this login path for this account; OAuth via /prism/login is the only working flow)

**Query Parameters:**
- `otp` - One-time password

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

### GET /prism/token
**Description:** Login using authorization code to generate access token

**Query Parameters:**
- `code` - Authorization code from OAuth callback

**Response:** Empty (200 OK)

**Status Codes:** 200, 400, 500

---

## Trading Endpoints

### GET /prism/order/buy
**Description:** Place a buy order for options or index. Note: there is currently no sell-to-open endpoint — the underlying broker calls (`buyContract`/`buyIndex`/`sendLimitOrder`) only ever place buy orders. `/prism/squareoff` is the only way to sell, and it closes an existing position rather than opening a fresh short.

**Query Parameters:**
- `index` - Index name (NIFTY, BANKNIFTY)
- `right` - Option type (call, put) - optional
- `strikePrice` - Strike price - optional
- `price` - Price - optional
- `contract` - Contract token - optional
- `triggerPrice` - Trigger price for stop loss - optional

**Headers:** X-User-Id (or session cookie) for user identification

**Response:** Empty (200 OK)

**Status Codes:** 200, 403 (order rejected), 500

---

### GET /prism/orderbook
**Description:** Get list of all orders

**Response:** Array of orders

**Status Codes:** 200, 500

---

### GET /trades
**Description:** Get active trades for current user

**Headers:** X-User-Id (or session cookie)

**Response:** Array of trade objects

**Status Codes:** 200, 500

---

### GET /closedtrades
**Description:** Get closed/squaredoff trades for current user

**Headers:** X-User-Id (or session cookie)

**Response:** Array of closed trade objects

**Status Codes:** 200, 500

---

### GET /refreshtrades
**Description:** Refresh trade list from broker and update monitor

**Response:** Array of open trades

**Status Codes:** 200, 500

---

### GET /subscribetrades
**Description:** Subscribe to trade updates

**Response:** Status 200

**Status Codes:** 200, 500

---

### GET /prism/squareoff
**Description:** Close/square off a position

**Query Parameters:**
- `token` - Contract token
- `qty` - Quantity to sell
- (Optional historical: expiryDate, strikePrice, right)

**Headers:** X-User-Id (or session cookie)

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

### POST /prism/settarget
**Description:** Set target and stop loss for a position

**Request Body:**
```json
{
  "token": "contract_token",
  "targetPoints": 100,
  "stopLossPoints": 50,
  "trailingDistance": 25
}
```

**Headers:** X-User-Id (or session cookie)

**Response:** Empty (200 OK)

**Status Codes:** 200, 400, 500

---

## Quote & Real-time Data Endpoints

### GET /quotes
**Description:** Get quotes for all major indices

**Response:**
```json
{
  "nifty": { "ltp": 17480.6, "open": 17593.85, "high": 17642.15, "low": 17435.55, "prevClose": 17629.8, ... },
  "bankNifty": { ... },
  "finNifty": { ... }
}
```

**Status Codes:** 200, 500

---

### GET /niftyquote
**Description:** Get NIFTY 50 index quote

**Response:** NiftyQuote object

**Status Codes:** 200, 500

---

### GET /quote
**Description:** Get quote for a specific symbol/stock

**Query Parameters:**
- `symbol` - Stock symbol

**Response:** Stock quote object

**Status Codes:** 200, 500

---

### GET /requestOtp
**Description:** Request OTP for login

**Response:**
```json
{
  "message": "Requested OTP"
}
```

**Status Codes:** 200, 500

---

## Event Streams (Server-Sent Events)

### GET /niftystream
**Description:** Real-time stream of NIFTY 50 updates

**Headers:** Accept: text/event-stream

**Response Stream:** JSON events with NIFTY data

**Event Format:**
```
data: { "symbol": "NIFTY 50", "ltp": 17480.6, ... }
```

---

### GET /optionstream
**Description:** Real-time stream of option updates

**Headers:** Accept: text/event-stream

**Response Stream:** JSON events with option data

---

### GET /positionstream
**Description:** Real-time stream of user positions

**Headers:** Accept: text/event-stream
**Headers:** X-User-Id (or session cookie)

**Response Stream:** JSON array of user's active and closed trades

---

## Connection & Subscription Endpoints

### GET /connect
**Description:** Connect to broker (Prism)

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

### GET /subscribe
**Description:** Subscribe to NIFTY real-time updates

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

### GET /start
**Description:** Start trading by buying NIFTY and BANKNIFTY indices

**Response:** Empty (200 OK)

**Status Codes:** 200, 500

---

## Configuration & Statistics

### GET /config
**Description:** Get current configuration (flattened format)

**Response:** Configuration object with all settings flattened

**Status Codes:** 200

---

### POST /config
**Description:** Update configuration

**Request Body:** Flattened configuration object

**Response:** Updated configuration

**Status Codes:** 200

---

## Reconcile

Broker-position and strategy reconciliation is **on-demand only**: it is not run on process startup or on broker login, and nothing waits for it (ticks, order events and new entries work without it). Call it only when broker positions and Mongo documents disagree.

### POST /reconcile
**Description:** Restores open positions from each broker into `order`, then runs every strategy's `reconcile()`. Strategies only reconcile when all brokers were read successfully. Refused before 09:10 IST (broker responses are pre-market and incomplete). Safe to re-run: restored trades are de-duplicated, and it can be re-run any number of times (concurrent calls share the run in flight).

**Auth:** Admin

**Response:** `{ brokers: { kite, ant, breeze }, strategies: { ran } }` (booleans per broker)

**Status Codes:**
- 200 - reconciled
- 409 - one or more brokers could not be read (`brokers` shows which); strategies NOT reconciled. Fix that broker's session and call again.
- 500 - refused (e.g. before 09:10) or unexpected failure

---

### GET /strategyPnl
**Description:** Realized (closed trades) and unrealized (open positions) P&L per strategy for the current `order` session. Admin (loopback needs no auth). Used by `scripts/strategy-status.sh`.

**Query:** `match` (optional regex on the trade's strategy name, case-insensitive)

**Response:** `[{ strategy, realized, unrealized, open, closed }]`

---

### GET /stats
**Description:** Get strategy statistics and P&L data

**Response:** Plain text formatted table with:
- Strategy name
- Total trades
- Wins/Losses
- Win percentage
- Total P&L

**Status Codes:** 200, 500

---

### GET /strategies
**Description:** List all active strategies and their status

**Query Parameters (optional):**
- `strategy` - Strategy class name to filter
- `userId` - User ID to filter
- `enable` - Enable/disable strategy (true/false)

**Response:**
```json
[
  {
    "type": "ContinuousStrategy",
    "userId": "user_id",
    "enabled": true
  }
]
```

**Status Codes:** 200, 500

---

## Testing & Utility Endpoints

### GET /test
**Description:** Test endpoint - fetches option chain data

**Query Parameters:**
- `index` - Index name

**Response:** "Done"

**Status Codes:** 200, 500

---

### GET /search
**Description:** Search for option contract token

**Query Parameters:**
- `depth` - Depth (ATM offset)
- `right` - Option type (call/put)
- `index` - Index name

**Response:**
```json
{
  "token": "54033"
}
```

**Status Codes:** 200, 500

---

### GET /candles
**Description:** Get candle data for charting

**Query Parameters:**
- (Optional: interval, symbol)

**Response:** Array of OHLC candle data

**Status Codes:** 200, 500

---

### GET /replay
**Description:** Replay historical quotes through decision-making pipeline

**Query Parameters:**
- `date` - Date to replay (YYYY-MM-DD format)

**Response:**
```json
{
  "date": "2024-08-13",
  "processed": 100
}
```

**Status Codes:** 200, 400, 404, 500

---

### GET /logout
**Description:** Logout and disconnect from broker

**Response:** Empty

**Status Codes:** 200

---

## Frontend Routes

### GET / (and any unmatched path)
**Description:** Serve React frontend application

**Response:** index.html for the React app

---

### POST /order/lock-profits
Locks the current open P&L. Admin only (loopback callers skip auth). Query: `broker` (`kite`|`breeze`|`ant`; omitted = every broker with an open position), `reprice=true` (re-price a lock that is still resting).

In order: (1) writes `settings.freezeBuys: true` and `enabled: false` on every enabled strategy to `config.yml` in one atomic write (hot-reloaded by every process; nothing is held only in memory), so the `order` process refuses every buy-type request (hedges, averages, refills, re-buys, entries, manual buys - all strategies and brokers) and no strategy re-arms, (2) cancels resting buy orders, then (3) per (owning user, broker, contract) cancels the resting sells once and places one chunked LIMIT sell for the whole remaining quantity at the trade's live price rounded up to the tick. A fill can therefore only be at that price or better, so realized P&L ends at or above the open P&L read at the call. Sells are placed under the position's owning strategy user, so fills book through the normal path and update that strategy. The `order` process re-reads `config.yml` first and refuses to sell if `freezeBuys` is not true.

Response: `{ freezeBuys, disabledStrategies, lock: { buysFrozen, brokers, positions: [{ user, broker, tsym, quantity, entryAvg, ltp, limitPrice, lockedPnl, orderIds, status, note }], cancelledBuys, totalLockedPnl } }`. `status` is `locked`, `partial`, `skipped` (already locked within 10 minutes), `filled-during-cancel` or `failed`.

Notes: only positions in the `order` process's bookkeeping are sold (a broker position with no matching Mongo buy is not). A limit at the current price may not fill if the market falls; it stays resting. A buy that filled before its cancel landed is reported under `cancelledBuys[].filledQty`; call again to lock it. To trade again, set `settings.freezeBuys: false` and `enabled: true` on the strategies you want in `config.yml`; `freezeBuys: true` can also be set by hand to freeze buys without selling anything.

## User Context Resolution

The API uses a priority-based system to identify the user making requests:

1. **Session Cookie** (`session` signed cookie) - highest priority
2. **X-User-Id Header** - fallback
3. **Default** - if neither is provided

**Usage Example:**
```bash
# Using header
curl -H "X-User-Id: user@example.com" http://localhost:3000/trades

# Using session cookie (set via /auth/login)
curl -b "session=user@example.com" http://localhost:3000/trades
```

---

## Monitor & Rate Limiting

The server enforces per-user constraints via the `Monitor` class:

- **Loss Limit:** Maximum loss allowed per session (default: 15000)
- **Lot Limit:** Maximum number of lots per trade (default: 10)
- **Order Validation:** Checks if user can place orders based on P&L and loss limits
- **Pending Users:** Tracks users with pending order execution

Orders can be rejected with status 403 if:
- User has reached loss limit
- User has reached lot limit
- Other risk management rules are violated

**Error Response:**
```json
{
  "error": "ORDER_REJECTED",
  "message": "Reason for rejection"
}
```

---

## Data Models

### User Object
```json
{
  "email": "user@example.com",
  "name": "User Name",
  "picture": "https://example.com/pic.jpg",
  "lossLimit": 15000,
  "lotCount": 10,
  "investmentMode": "percentage|fixed",
  "investmentAmount": 50000,
  "role": "user|admin",
  "emailVerified": false,
  "phoneVerified": false,
  "addressVerified": false,
  "dobVerified": false,
  "panVerified": false
}
```

### Trade Object
```json
{
  "token": "contract_token",
  "orderno": "order_number",
  "stockCode": "NIFTY|BANKNIFTY",
  "action": "Buy|Sell",
  "cost": "entry_price",
  "quantity": 100,
  "expiryDate": "27-Oct-2022",
  "right": "call|put",
  "strikePrice": "17600",
  "user": "user@example.com",
  "open": true
}
```

### Quote Object
```json
{
  "ltp": 17480.6,
  "ltt": "Thu Sep 29 08:33:20 2022",
  "open": 17593.85,
  "high": 17642.15,
  "low": 17435.55,
  "close": 17400,
  "prevClose": 17629.8
}
```

---

## Notes

- All timestamps are in IST (Indian Standard Time)
- Session cookies are signed with secret: "propfirm-secret"
- E-Tag is disabled for dynamic content
- File uploads limited to 5MB
- Replay functionality requires Quote collection in MongoDB
