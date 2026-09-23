# NIFTY Options Trading System

This workspace contains three projects that form an options trading system for NIFTY index options on the Indian stock market.

## Architecture Overview

```
React Web App (icici/frontend/)     Node.js Server (icici/)              Shoonya Broker
┌──────────────────────┐   HTTP/SSE   ┌─────────────────────┐   REST/WS   ┌───────────────┐
│  PropFirm Web Client │ ◄──────────► │  Express (port 3000) │ ◄────────► │ api.shoonya.com│
│  (React + Bootstrap) │              │  Prism singleton     │            │ NorenWClientTP │
└──────────────────────┘              └─────────────────────┘            └───────────────┘
                                              ▲
Flutter App (nifty/)                          │
┌──────────────────┐    HTTP/SSE              │
│  Mobile Client   │ ◄───────────────────────┘
│  (Riverpod)      │
└──────────────────┘
```

The React web app and Flutter mobile app both send commands (buy, sell, configure) via REST and receive live market data via SSE. The Node.js server handles all broker communication, order placement, position tracking, and strategy execution through the Prism singleton.

---

## Project 1: `nifty/` — Flutter Mobile App

**Package name:** `cbse`
**State management:** Flutter Riverpod v2.3.4
**Local storage:** Hive

### Directory Structure

```
lib/
├── main.dart                  # Entry point, Hive init, app lifecycle observer
├── screen/
│   ├── home_page.dart         # Main screen with navigation (Monitor, Settings)
│   ├── prism_screen.dart      # Trading interface: TargetPrice, Contract, Index, Positions
│   ├── monitor_screen.dart    # Monitoring view
│   ├── settings.dart          # Settings: depth, lot size, host, OTP, login
│   ├── chart_screen.dart      # Interactive candlestick chart
│   └── order_screen.dart      # Order view
├── component/
│   ├── index_card.dart        # NIFTY quote display with call/put buy buttons
│   ├── nifty_card.dart        # Alternative NIFTY display
│   ├── position_card.dart     # Open position with P&L and "Square Off" button
│   ├── contract_card.dart     # Contract search interface
│   ├── contract_search_field.dart  # TypeAheadField for contract search (CSV lookup)
│   ├── target_price_card.dart # Target price selector
│   └── reusable.dart          # Shared UI utilities
├── provider/
│   ├── nifty_stream_provider.dart    # SSE → /niftystream
│   ├── option_stream_provider.dart   # SSE → /optionstream
│   ├── position_stream_provider.dart # SSE → /positionstream (currently mock)
│   ├── nifty_provider.dart           # Processes nifty stream into NiftyState
│   ├── position_provider.dart        # Processes position stream into PositionState
│   ├── settings_provider.dart        # SettingsState (depth, lotSize, host, otp, targetPrice)
│   ├── trade_service_provider.dart   # Buy/sell actions via Service
│   ├── index_provider.dart           # Index state
│   ├── candles_provider.dart         # Candle data for charts
│   ├── retry_provider.dart           # Retry counter (max 3 retries)
│   └── state/
│       └── nifty_state.dart          # NiftyState, LoadingNiftyState, ErrorNiftyState
├── model/
│   ├── nifty_quote.dart       # NiftyQuote: ltp, ltt, open, high, low, prevClose, change
│   ├── option_quote.dart      # OptionQuote: ltp, ltt, open, high, low, prevClose
│   ├── option_stream_data.dart # OptionStreamData: ltp, time, token
│   ├── position.dart          # Position: tsym, token, stockCode, right, quantity, cost, ltp, profit
│   └── position_list.dart     # PositionList wrapper
├── service/
│   └── service.dart           # HTTP calls: buy, squareOff, login, getOpenPositions, etc.
└── util/
    ├── api_util.dart          # HTTP client, base URL http://192.168.0.113:3000
    ├── sse_client.dart        # SSE stream parser (data: prefix extraction)
    ├── hive_helper.dart       # Hive local storage wrapper
    ├── generic_exception.dart # Custom exception
    └── util.dart              # Common utilities
```

### Key Flows

**SSE Streams:** `SSEClient.subscribeToSSE()` connects to server SSE endpoints, parses `data:` lines, feeds into Riverpod StreamProviders.

**Buy:** IndexCard buttons → `TradeServiceNotifier.buy(index, right)` → `Service.buy()` → `GET /order?index=NIFTY&right=call&action=Buy&depth=1`

**Square Off:** PositionCard button → `TradeServiceNotifier.squareOff(token, right, qty)` → `Service.squareOff()` → `GET /squareoff?token=X&right=Y&qty=Z`

**Settings:** Stored in Hive (`app_settings` box), includes: depth (0-4), lotSize (1-72), host IP, OTP, targetPrice.

---

## Project 2: `icici/` — Node.js/TypeScript Server

**Location:** `/home/karthikeyan/work/icici/`
**Framework:** Express.js on port 3000
**Language:** TypeScript compiled with tsc-watch
**Run command:** `npm run server` (tsc-watch → `node ./dist/server.js`)

> **Note:** The `trade/icici.ts`, `breeze.ts`, `browser.ts`, and any Python files are legacy/unused code. Focus on Prism-related code only.

### Scripts / npm run commands

| Script | Command | Purpose |
|--------|---------|---------|
| `npm run server` | `tsc-watch --onSuccess "node ./dist/server.js"` | Main server with live TypeScript recompile |
| `npm run server:mock` | `PORT=3001 MOCK_BROKER=true MOCK_QUOTES=true node ./dist/server.js` | Run server with mock broker/quotes (uses `config.mock.yml`, date `2026-02-24`) |
| `npm run server:mock:run` | Same as above but tees output to `server_logs.txt` | Mock server with logging |
| `npm run test` | `jest` | Run unit tests |
| `npm run test:watch` | `jest --watchAll` | Watch mode tests |
| `npm run test:strategy` | `tsc && node ./dist/test/strategyTest.js` | Run strategy tests |
| `npm run analyze` | `tsc && node ./dist/tools/analyze.js` | Run indicator analysis tool |
| `npm run analyze:check` | `tsc && node ./dist/tools/check_indicators.js` | Check indicators |
| `npm run pipeline` | `tsc && node ./dist/tools/pipeline.js` | Run strategy pipeline |
| `npm run pipeline:combos` | `tsc && node ./dist/tools/pipeline.js --combinations` | Pipeline with all combinations |
| `npm run momentum:fetch` | `tsc && node ./dist/momentum/fetchDaily.js` | Fetch daily momentum data |
| `npm run momentum:rank` | `tsc && node ./dist/momentum/weeklyMomentum.js` | Weekly momentum ranking |

#### Backtest Tool (`src/tools/backtest.ts`)

Runs a grid search over `targetPriceDiff` (1–30) × `stopLossPriceDiff` (5–30) = 780 combinations.

**Run command:**
```bash
tsc && node dist/tools/backtest.js
```
Or via ts-node: `npx ts-node src/tools/backtest.ts`

**How it works:**
- Spawns up to 10 concurrent `node dist/server.js` processes, each on a different port (4000–4009)
- Each process gets a temp config in `/tmp/backtest_config_<port>.yml` with the combo's target/stopLoss values
- Runs with `MOCK_BROKER=true MOCK_QUOTES=true` so no real broker connection is needed
- Waits for `=== BACKTEST STATS ===` table in stdout, parses Win%, P&L, trade count for `RateOfChangeStrategy`
- Results sorted by Win% and printed + saved to `backtest_results.txt`

### Directory Structure

```
src/
├── server.ts              # Express app, all REST/SSE endpoints
├── prism.ts               # Prism singleton — core broker interface
├── prism/
│   ├── RestAPI.ts         # NorenRestApi — HTTP calls to Shoonya broker
│   ├── WebSocket.ts       # WebSocket client for live quotes
│   ├── config.ts          # Config singleton — trading parameters, file paths, auto-reload
│   ├── AppConfig.ts       # AppConfig model for YAML config (strategies)
│   └── ConfigService.ts   # YAML config reader/writer (config.yml), singleton, auto-reload
├── decision.ts            # Decision engine — routes quotes to strategies, technical analysis
├── monitor.ts             # Monitor singleton — trade lifecycle, per-user P&L tracking
├── model/
│   └── model.ts           # NiftyQuote, Trade, Order, OrderInfo, OptionQuote, PeriodicStats, etc.
├── strategy/
│   ├── strategy.ts        # Abstract Strategy base class
│   ├── strategies.ts      # Strategies singleton registry (currently only BuySellStrategy active)
│   ├── BuySellStrategy.ts # Main strategy: buy on entry, average down, sell on target
│   ├── SentimentStrategy.ts
│   ├── IntermittentStrategy.ts
│   ├── DiffStrategy.ts
│   ├── PivotStrategy.ts
│   ├── BiDirectionStrategy.ts
│   ├── HighLotStrategy.ts
│   ├── Minutes5Decision.ts
│   ├── ORBPrevious.ts
│   └── TestStrategy.ts
├── nse_index.ts           # Index class + indexMap (NIFTY/BANKNIFTY/FINNIFTY tokens, lot sizes)
├── constants.ts           # NIFTY, BANKNIFTY, FINNIFTY, CALL, PUT, SIMULATION flags
├── orderList.ts           # isPriceInRange() — checks option price within config min/max
├── tools/
│   ├── emitter.ts         # Shared EventEmitter for SSE broadcasting
│   └── mongo.ts           # MongoDB client (localhost:27017)
├── candle.ts              # Candle manager for chart data
├── util.ts                # Utility functions
└── executeGap.ts          # Gap trading logic
```

### Core Components

#### Prism (`prism.ts`) — Singleton

The central broker interface. Wraps all communication with Shoonya/Noren API.

**Key methods:**
- `login(otp)` → authenticates via `NorenRestApi.login()`, fetches NIFTY quote, starts WebSocket
- `connect()` → starts WebSocket, subscribes to NIFTY index
- `requestOtp()` / `logout()`
- `getQuote(index)` / `getNiftyQuote()` / `getOptionQuote(token)` — REST quote fetches
- `buyIndex(index, ltp?, right?, qty?, user?)` — calculates strike price, determines call/put direction, places limit order
- `buyContract(contract, qty, price?, user?)` / `sellContract(contract, qty, price, user?)` — direct contract orders
- `sendLimitOrder(tsym, price, right, action, quantity, user?)` — places NFO limit order
- `squareOffOrder(token, qty, user?)` — market sell order to exit position
- `subscribeNifty()` / `subscribeOption(token)` / `unsubscribeOption(token)` — WebSocket subscriptions
- `getToken(tsym)` / `getContract(token)` — lookups from NFO_symbols.txt file
- `search(token, index, expiryDate, strikePrice, right)` — smart token search with closest-match fallback
- `getContractByPriceRange(right)` — finds contract within configured price range (minPrice-maxPrice)
- `calculateRight(ltp)` — auto-determines call vs put using buyQty/sellQty and extrinsic value comparison
- `getOrders()` / `getTradeList()` / `refreshTradeList()` — position management

**User tracking:** `orderUserMap: Map<string, string>` maps Shoonya order numbers to user identifiers (e.g. 'PropFirm', 'Default', or strategy class names). Set when order is placed, retrieved in WebSocket order callback, cleaned up after confirmation.

**WebSocket callbacks (set in Prism):**
- `socket_open` / `socket_close` / `socket_error` — connection lifecycle
- `quote(data)` — routes NFO quotes to Monitor, NSE quotes (tk=26000 for NIFTY) to Decision, emits via `myEmitter.emit('nifty', quotes)`
- `order(data)` — resolves user from `orderUserMap`, routes to Monitor.updateTrade(data, user), then Strategy.updateTradeWrapper()

**Order splitting:** Orders > 1800 qty are split into multiple orders via `splitQty()`.

#### NorenRestApi (`prism/RestAPI.ts`) — Singleton instance

HTTP client for Shoonya broker (`https://api.shoonya.com/NorenWClientTP`).

**Key methods:** `login(twoFA)`, `get_quotes(exchange, token)`, `place_order(order)`, `modify_order()`, `cancel_order()`, `get_orderbook()`, `get_tradebook()`, `get_positions()`, `option_chain()`, `searchscrip()`, `subscribe(instrument)`, `unsubscribe(instrument)`

**Auth:** SHA256 password hashing, user token persisted to `userToken.txt`.

**Request format:** `jData=<JSON>&jKey=<userToken>` POST body.

#### WebSocket (`prism/WebSocket.ts`)

Connects to `wss://api.shoonya.com/NorenWSTP/`. Handles touchline (`t`/`tf`), depth (`dk`/`df`), order (`om`) messages. Sends heartbeat every 3s.

#### Config (`prism/config.ts`) — Singleton

Trading parameters with auto-reload on file change (`config/config.properties`):
- `endpoint` / `websocket` — Shoonya API URLs
- `NFOSymbolsPath` — `/home/karthikeyan/Downloads/NFO_symbols.txt` (token lookup file)
- `startHour/endHour` — trading window (10:00-15:00)
- `lotCount` — quantity multiplier (or -1 to use investmentAmount)
- `targetPriceDiff` / `stopLossPriceDiff` / `buyAgainPriceDiff` — trade management
- `depth` — strike price depth from ATM
- `optionDirection` — "OTM" or "ITM"
- `bidirection` / `selectedOption` — force call/put or both
- `auto` — auto-trade mode

#### ConfigService (`prism/ConfigService.ts`) — Singleton

YAML-based config (`config.yml`) with strategy parameters. Auto-reloads on file change.

**config.yml structure:**
```yaml
settings:
  minPrice: 20          # Min option price to trade
  maxPrice: 150         # Max option price to trade
buySellStrategy:
  enabled: true
  initialQuantity: 150
  incrementQuantity: 150
  averageThreshold: 10  # Points drop before averaging down
  targetPrice: 5        # Points profit target
  maxIterationCount: 10 # Max averaging iterations
  right: none           # auto-detect call/put
```

#### Decision (`decision.ts`) — Singleton

Routes live quotes to strategies. Contains technical analysis engine:
- Receives NIFTY quotes via `decidePurchase(quote)` → stores in MongoDB, routes to all strategies
- Receives option quotes via `decidePurchaseStockOption(quote)` → routes to strategies
- `decideSell(optionQuote)` — auto-sell if profit target met
- Technical indicators: RSI, MACD, EMA crossover, Bollinger Bands (multiple parameter combos)
- Candle formation with support/resistance (pivot points S1/R1/S2/R2)
- Price series tracked with configurable time intervals

#### Monitor (`monitor.ts`) — Singleton

Manages trade lifecycle with per-user tracking:
- `userPnL: Map<string, number>` — cumulative P&L per user
- `pendingUsers: Set<string>` — users with orders in flight
- `USER_LOSS_LIMIT = 15000` — per-user session loss limit
- `hasActiveTrade(user)` — checks if user has active trade or pending order
- `isLossLimitReached(user)` — checks if user exceeded loss limit
- `canPlaceOrder(user)` — validates: no active trade + not loss-limited → `{ allowed, reason }`
- `updateTrade(data, user?)` — processes order events from WebSocket, assigns user to trade, maintains trades list, emits positions via SSE
- `updateQuote(optionQuote)` — updates live prices, routes to strategies
- `refreshTrades(trades)` — syncs from broker positions, subscribes to option tokens
- `_processTradeEvent(tradeEvent)` — Buy: removes user from pendingUsers, adds/averages into trades list; Sell: calculates realized P&L, updates userPnL, removes from trades
- Emits `position` events for clients

#### Trade Model (`model/model.ts`)

Key fields: `tsym`, `token`, `right`, `action`, `quantity`, `price`, `lastTradePrice`, `status`, `user` (default: 'Default'), `open` (default: true), `realizedPnL`

#### Strategy Framework (`strategy/`)

**Abstract base** (`strategy.ts`):
- `processNiftyQuote(quote)` — handle index quote
- `processOptionQuote(quote)` — handle option quote
- `receive(oldStats, newStats)` — handle periodic analysis
- `buyContract()` / `sellContract()` — order placement with mutex (Strategy.currentStrategy), validates via `canPlaceOrder(strategyClassName)`, adds to `pendingUsers`
- `updateTrade(trade)` — trade confirmation callback
- `isTimeInRange()` — 10:00-15:00 check

**Active strategy — BuySellStrategy** (`BuySellStrategy.ts`):
1. On first NIFTY quote (if enabled + in time range): auto-detects right (call/put), finds contract in price range, buys initial quantity
2. Monitors option price: if drops by `averageThreshold` → buys more (averaging down), up to `maxIterationCount`
3. If profit reaches `targetPrice` → sells entire position
4. On high iteration count → spawns IntermittentStrategy in opposite direction
5. Uses Contract inner class to track per-contract state (price, qty, P&L, iteration count)

**Strategy registry** (`strategies.ts`): Singleton list, currently only `BuySellStrategy` active.

### Index Map (`nse_index.ts`)

```
NIFTY    → token: 26000, lotSize: 65, increment: 50, factor: 50, maxQty: 1800
FINNIFTY → token: 26037, lotSize: 25, increment: 50, factor: 100, maxQty: 900
BANKNIFTY→ token: 26009, lotSize: 15, increment: 100, factor: 100, maxQty: 900
```

Handles strike price calculation, expiry date computation (next Tuesday), token construction (`NIFTY06FEB25C24500`).

### REST API Endpoints (server.ts)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/login?otp=X` | Login via Prism |
| GET | `/requestOtp` | Request OTP from broker |
| GET | `/logout` | Logout |
| GET | `/connect` | Start WebSocket + subscribe NIFTY |
| GET | `/quotes` | Get NIFTY + BANKNIFTY + FINNIFTY quotes |
| GET | `/niftyquote` | Get NIFTY quote only |
| GET | `/quote?symbol=X` | Get stock quote |
| GET | `/order?index=X&right=Y&action=Z&strikePrice=N&price=P` | Place order (by index) |
| GET | `/order?contract=X&action=Buy` | Place order (by contract symbol) |
| GET | `/squareoff?token=X&qty=N` | Market sell to exit |
| GET | `/trades` | Get monitored trades |
| GET | `/refreshtrades` | Sync from broker positions |
| GET | `/subscribetrades` | Subscribe to trade updates |
| GET | `/orderbook` | Get pending orders |
| GET | `/strategies?strategy=X&enable=true` | Enable/disable strategy |
| GET | `/config` | Get YAML config |
| POST | `/config` | Update YAML config |
| GET | `/candles` | Get candle data |
| GET | `/search?depth=N&right=X&index=Y` | Search for option token |

**Order endpoint modes** (`/order`):
1. `contract=X` → `prism.buyContract(contract)` — buy by full contract symbol
2. `right=X` (no strikePrice) → `prism.buyIndex(index, right)` — server auto-determines strike
3. `strikePrice=X&right=Y` → finds token, fetches quote, `prism.sendLimitOrder()` — explicit strike

**User identification:** `X-User-Id` HTTP header (e.g. 'PropFirm'). Validated via `Monitor.canPlaceOrder(user)` — rejects if user has active trade or exceeded loss limit (403 response).

### SSE Endpoints

| Endpoint | Event | Data |
|----------|-------|------|
| `/niftystream` | `nifty` | `{nifty, bankNifty, finNifty}` quotes |
| `/optionstream` | `option` | Option quote updates |
| `/positionstream` | `position` | Open positions array |
| `/statusstream` | `status` | Status messages |
| `/timestream` | `timewindow` | Time window analysis |
| `/datastream` | `data` | General data |

### Event Flow

```
Shoonya WebSocket
    │
    ├── NSE quote (tk=26000) → Prism.quote()
    │       ├── _updateQuote() → updates niftyQuote in memory
    │       ├── Decision.decidePurchase() → routes to strategies
    │       └── myEmitter.emit('nifty') → SSE /niftystream → clients
    │
    ├── NFO quote → Prism.quote()
    │       └── Monitor.updateQuote() → updates trade LTP
    │               ├── strategy.processOptionQuote() → buy/sell decisions
    │               └── myEmitter.emit('position') → SSE /positionstream → clients
    │
    └── Order update (om) → Prism.order()
            └── resolve user from orderUserMap
                    └── Monitor.updateTrade(data, user) → updates trade state
                            └── Strategy.updateTradeWrapper() → confirms order to strategy
```

### Data Persistence

- **MongoDB** (localhost:27017): NiftyQuote history, Trade records, OptionQuote history
- **Hive** (Flutter): User settings (host, OTP, depth, lotSize, targetPrice)
- **Files**: `userToken.txt` (session token), `config.yml` (strategy config), `config/config.properties` (trading params), `NFO_symbols.txt` (contract tokens)

### Dependencies

**Flutter (nifty/):** flutter_riverpod, hive, http, flutter_typeahead, csv, interactive_chart, intl

**Node.js (icici/):** express, axios, ws, mongodb, crypto-js, technicalindicators, moment, js-yaml, cron, csv-parse, regression, stats-lite, tsc-watch

---

## Project 3: `icici/frontend/` — React Web App (PropFirm Trading)

**Location:** `/home/karthikeyan/work/icici/frontend/`
**Framework:** React 18 + TypeScript + Vite
**UI Library:** React-Bootstrap 5.3
**State management:** React Context API
**Run commands:**
- Dev (real backend): `npm run dev` (Vite on port 5173, proxies to localhost:3000)
- Dev (mock): `npm run dev:mock` (Vite, proxies to localhost:4000)
- Mock server: `npm run mock` (Express on port 4000)
- Build: `npm run build` (outputs to `../public/app/`, served by Express at `/app/`)

### Directory Structure

```
frontend/
├── src/
│   ├── App.tsx                      # Router: /app → RulesPage, /app/trade → TradingPage
│   ├── App.css                      # Styling (rules-bg, trading-bg, pnl-bar)
│   ├── main.tsx                     # React entry point
│   ├── components/
│   │   ├── OrderEntry.tsx           # Two-mode order form (trend buttons + symbol search)
│   │   └── PositionCard.tsx         # Trade display with P&L and Square Off button
│   ├── context/
│   │   └── TradingContext.tsx       # Global state: trades, P&L, order actions
│   └── pages/
│       ├── RulesPage.tsx            # Landing page with trading rules + acceptance checkbox
│       └── TradingPage.tsx          # Main trading interface: P&L bar, OrderEntry, positions
├── public/
│   └── symbols.txt                  # NFO trading symbols (FEB month, column 5 from NFO_symbols.txt)
├── mock-server.js                   # Standalone Express mock backend (port 4000)
├── vite.config.ts                   # Vite config: base=/app/, proxy to backend
├── package.json                     # Dependencies
└── index.html                       # HTML entry point
```

### Key Components

#### TradingContext (`context/TradingContext.tsx`)

Provides global state via React Context:
- **Trade interface:** `{ tsym, token, right, action, quantity, price, lastTradePrice, user, status, open?, realizedPnL? }`
- **State:** `trades` (active), `closedTrades`, `openPnL`, `totalPnL`, `placingOrder`, `isOrderDisabled`, `orderError`
- **Actions:**
  - `placeOrder(right)` — trend mode: `GET /order?index=NIFTY&right=${right}&action=Buy` with `X-User-Id: PropFirm`
  - `placeContractOrder(contract)` — symbol mode: `GET /order?contract=${contract}&action=Buy` with `X-User-Id: PropFirm`
  - `squareOff(token, qty)` — `GET /squareoff?token=${token}&qty=${qty}` with `X-User-Id: PropFirm`
- **SSE:** Connects to `/positionstream`, detects closed trades by comparing previous vs current trade lists
- **Business rules:**
  - One active trade limit: `isOrderDisabled = trades.length > 0`
  - Max loss threshold: `totalPnL <= -15000` disables ordering
  - Closed trades tracked by detecting trades that disappear from SSE stream

#### OrderEntry (`components/OrderEntry.tsx`)

Two order entry modes:

**Section A — Trend Buttons:**
- Green "Up" (call) and Red "Down" (put) buttons
- Sends order with only `index=NIFTY` and `right` — server auto-determines strike price via `buyIndex`

**Section B — Symbol Search:**
- Loads `symbols.txt` on mount (FEB-month NFO symbols, ~40K entries)
- Typeahead input: on typing (min 4 chars), splits input by spaces, filters symbols that contain ALL terms (AND logic)
  - Example: `98000 P` matches `NIFTYNXT5024FEB26P98000` but not `NIFTYNXT5024FEB26C98000`
- Shows top 10 matches in dropdown, user selects one, then clicks Buy
- Sends order with `contract=<selectedSymbol>` — server calls `prism.buyContract()`

#### PositionCard (`components/PositionCard.tsx`)

Displays a trade (active or closed):
- Contract symbol with CE/PE badge (blue for CE, yellow for PE)
- Quantity, average price, LTP, P&L (green/red)
- Square Off button (active trades only)

#### RulesPage (`pages/RulesPage.tsx`)

Landing page with 3 trading rules, checkbox acceptance required before navigating to `/app/trade`.

#### TradingPage (`pages/TradingPage.tsx`)

Main trading interface layout:
- Sticky P&L header bar (color-coded green/red)
- Loss limit warning at 80% threshold
- OrderEntry component
- Active positions list
- Collapsible closed trades section

### Mock Server (`mock-server.js`)

Standalone Express server on port 4000 for development without the real backend:
- `GET /trades` — returns current trades array
- `GET /positionstream` — SSE connection, broadcasts position updates
- `GET /order` — creates mock trade with random price, supports both `strikePrice` and `contract` params, simulates live price ticks every 3s
- `GET /squareoff` — closes trade, removes from array, broadcasts update
- Trade object: `{ _id, user, open, tsym, quantity, price, token, action, status, right, lastTradePrice, realizedPnL }`

### Vite Configuration

- `base: '/app/'` — all routes and static files under `/app/`
- Build output: `../public/app` (served by Express server)
- Proxy: `/order`, `/squareoff`, `/trades`, `/optionstream`, `/positionstream` → backend (port 3000 or 4000 with MOCK=true)
- Static files (e.g. `symbols.txt`) served from `public/` at `/app/symbols.txt`
