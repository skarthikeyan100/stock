# ICICI Trading Platform - Project Guide

## Permissions
This project operates with full permissions in accept edits mode. No permission requests needed for:
- Linux commands and bash operations
- Reading any files in the project or referenced directories
- Editing project files

## Overview
This is a Node.js/TypeScript-based options trading platform built for automated trading strategies using ICICI Direct APIs. The system supports multiple users, real-time market data streaming, and automated trade execution with risk management.

## Documentation

### API Documentation
**See [API.md](./API.md)** for comprehensive documentation of all REST endpoints including:
- Authentication & user management
- OAuth integration
- Trading operations (order placement, position management)
- Real-time data streaming (Server-Sent Events)
- Configuration management
- Strategy statistics

### Learning & Implementation
**See [learning.md](./learning.md)** for detailed learning materials on:
- ANT (Alice Blue) OAuth authentication implementation
- Architecture and design patterns used
- Code examples and usage patterns

## Architecture

### Key Services

**Prism** - Broker API Integration
- Location: `src/prism/`
- Handles all ICICI Direct API communication
- Manages OAuth flow and session management
- Provides methods for order placement, quote retrieval

**Monitor** - Risk Management & State Tracking
- Location: `src/monitor.ts`
- Tracks per-user P&L and position limits
- Enforces loss limits and lot constraints
- Manages active and closed trades
- Maintains real-time market data cache

**Strategies** - Automated Trading Logic
- Location: `src/strategy/`
- Implements various trading strategies (DiffStrategy, BuySellStrategy, etc.)
- Generates buy/sell signals based on technical indicators
- Tracks strategy-level performance statistics

**Mongo** - Data Persistence
- Location: `src/tools/mongo.ts`
- Stores user profiles, trades, quotes, and audit logs
- GridFS support for document uploads (KYC verification)

**Emitter** - Real-time Events
- Location: `src/tools/emitter.ts`
- EventEmitter-based system for broadcasting market updates
- Channels: 'nifty', 'option', 'position'

**ANT** - Alice Blue Integration (Auth + Live Streaming)
- Location: `src/ant/`
- `ANT.ts` - OAuth flow (authCode → `userSession` bearer token), REST trades/positions, singleton credential store. Persists `userSession` + `userId` to `.ant_session.json`.
- `AntSession.ts` - Prepares the websocket session (`createWsSess` on the OAuth domain) and derives the `susertoken` from the existing `userSession` (double SHA-256). Uses its own `axios.create()` instance — see gotcha below.
- `AntWebSocket.ts` - Raw `ws` client for `wss://ws1.aliceblueonline.com/NorenWS/` (Noren/Omnesys-family protocol, same message shapes as Shoonya's `src/prism/WebSocket.ts`). 3s heartbeat.
- `AntStream.ts` - Orchestrator singleton; subscribes to a fixed instrument list and emits ticks on the `'ant-quote'` emitter channel (isolated from Prism/Shoonya's `'nifty'`/`'option'` channels — does not touch `Monitor`/`Decision`).
- `AntContractMaster.ts` - Looks up tokens from the local NFO/BFO contract-master JSON files (see Data Files below).
- Endpoints: `GET /ant/connect` (starts streaming), `GET /ant/stream` (SSE of `'ant-quote'`), plus existing `/ant/login`, `/ant/callback`, `/ant/token` (OAuth login) and `/ant/trades`, `/ant/positions` (REST).
- **This account is OAuth-only** — AliceBlue's older "classic" `userId`+`apiKey` flow (used by the `pya3` Python SDK and the unused `src/broker/AntBroker.ts` scaffold) is *not* provisioned for it; `getAPIEncpkey` always returns "API key not available" regardless of input. Don't reintroduce that flow without first confirming the account has a classic key.
- **Gotcha:** `src/prism/RestAPI.ts` installs an interceptor on the *global* `axios` instance that silently unwraps `response.data`. Any new ANT code making HTTP calls must use its own `axios.create()` (as `ANT.ts` and `AntSession.ts` already do), or `response.data` will be `undefined`.
- **Gotcha:** `AntStream`'s connection is in-memory only — it does not survive a server restart (including `tsc-watch` auto-restarts in dev). Call `GET /ant/connect` again after every restart.

### Data Models

**User** - User account with:
- Email, name, profile picture
- Loss limit, lot count, investment settings
- KYC verification status (email, phone, address, DOB, PAN)
- Document proofs (uploaded via GridFS)

**Trade** - Active and closed positions with:
- Token, contract expiry, strike price
- Entry price, quantity, direction (call/put)
- User attribution and open/closed status

**Quote** - Market data snapshots:
- LTP, open, high, low, close, previous close
- Timestamp (ltt)
- Used for historical replay and decision-making

### Data Files

- `NFO_symbols.txt` (repo root) - Shoonya/Prism contract master, comma-delimited, loaded by `Prism.cacheFile()`.
- `data/ant/NFO_contract.json`, `data/ant/BFO_contract.json` - ANT's own contract masters (official AliceBlue v2 format, `{"NFO"/"BFO": [...]}`), used by `AntContractMaster`. Large (~18-34MB) — re-download from `https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/` if stale.

## Getting Started

### Setup
```bash
npm install
npm run build  # one-time TypeScript compilation
```

### Running the Server
```bash
npm run server
```
This starts the server with TypeScript watch mode. The server:
- Automatically recompiles on file changes
- Listens on port 3000 (or process.env.PORT)
- Logs output to `server.log`
- Serves the trading platform API and UI

### Environment
- **PORT:** 3000 (or process.env.PORT)
- **MongoDB:** Connection via Mongo.getInstance()
- **ICICI Direct:** OAuth-based authentication

### Key Files to Know

- `src/server.ts` - Main Express server with all route definitions
- `src/user.ts` - User CRUD operations
- `src/prism/index.ts` - Prism broker API client
- `src/monitor.ts` - Risk management and trade tracking
- `src/strategy/strategies.ts` - Strategy manager
- `src/decision.ts` - Technical analysis and signal generation
- `src/ant/AntStream.ts` - ANT live market-data streaming orchestrator

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. Use `resolveUser(req)` to get current user context
3. Get Prism instance: `Prism.getInstance()`
4. Get Monitor instance: `Monitor.getInstance()`
5. Return JSON or appropriate status code

### Checking User Constraints Before Trading
```typescript
const monitor = Monitor.getInstance();
const validation = monitor.canPlaceOrder(user);
if (!validation.allowed) {
    // Order rejected: validation.reason explains why
}
```

### Broadcasting Real-time Updates
```typescript
const myEmitter = require('./tools/emitter');
myEmitter.emit('nifty', { ltp: 17480.6, ... });
myEmitter.emit('position', updatedTradesList);
```

### Accessing Broker Data
```typescript
const prism = Prism.getInstance();
const quote = await prism.getNiftyQuote();
const trades = await prism.getTradeList();
const orders = await prism.getOrders();
```

## Configuration

Configuration is managed via `ConfigService` (flattened format):
- **GET /config** - Retrieve current settings
- **POST /config** - Update settings
- Settings are persisted and cached in Monitor

Common settings:
- `strategy.*.threshold` - Signal generation thresholds
- `strategy.*.enabled` - Enable/disable strategies
- `settings.trailingDistance` - For trailing stop losses

## User Authentication Flow

1. **Frontend Login:** POST /auth/login with email, name, picture
2. **Session Cookie:** Signed cookie 'session' set with user email
3. **OAuth (optional):** GET /prism/oauthurl → callback → /prism/token
4. **Verification:** GET /auth/me to verify current session

## Trading Flow

1. User places order via GET /prism/order/buy with parameters
2. Monitor validates constraints (loss limit, lot limit)
3. Prism executes order via ICICI Direct API
4. Monitor tracks active position
5. Real-time quotes stream via /niftystream, /optionstream
6. Monitor broadcasts position updates via /positionstream
7. User closes position via GET /prism/squareoff
8. Monitor records P&L and moves trade to closed list

## Important Notes

- **User Context:** Resolved from session cookie or X-User-Id header
- **Risk Management:** Per-user loss limits and lot constraints enforced
- **Event Streaming:** Uses Server-Sent Events (SSE) for real-time data
- **Database:** MongoDB stores all persistent state
- **Broker:** ICICI Direct API (Prism client)
- **Frontend:** React app served from /app route

## Debugging

Check these log sources:
- `server.log` - Server startup and API logs
- `server_logs.txt` - Runtime execution logs
- Console output from `Log.log()` calls throughout codebase
- Monitor class tracks state changes and order rejections

## Future Enhancements

Potential areas for improvement:
- Rate limiting per user
- Webhook notifications for trade fills
- Advanced order types (iceberg, time-weighted)
- Historical backtesting framework
- Mobile app support
- Multi-strategy coordination
