# ICICI Trading Platform - Project Guide

## Permissions
This project operates with full permissions in accept edits mode. No permission requests needed for:
- Linux commands and bash operations
- Reading any files in the project or referenced directories
- Editing project files

## Pending Work
**Always check [ToDo.md](./ToDo.md) at the start of a session** — it's a live, hook-maintained snapshot of pending/in-progress work (not a historical log), and may contain follow-ups from a prior session that are directly relevant to whatever you're about to do (e.g. a live-verification step blocked on market hours). Once an item in `ToDo.md` is completed/resolved, remove it from the file rather than leaving it marked done — the file should only ever list what's still pending.

**Update `ToDo.md` the moment an item is resolved, not just when asked to check it.** If work done during the current session (a fix, a cleanup, a live verification) satisfies something listed in `ToDo.md` — even a sub-bullet of a larger entry — remove that item/sub-bullet immediately, in the same turn as the fix. Don't rely on a future session to notice and clean it up; that's how stale "still pending" items survive after the work is actually done (e.g. a debug-log cleanup that shipped but whose `ToDo.md` line lingered until a later session caught the mismatch).

## Code Review Before Declaring a Fix Done
**Run a code review pass (use the `code-review` skill) on any fix or change to live-trading-affecting code (order placement, broker execution, strategy entry/exit logic, config live-sync) before telling the user it's done — not just a `tsc`/build check.** This came up 2026-09-21 after a fix was shipped without a thorough review and a real, unreviewed gap (a stuck limit sell with no re-pricing) caused an actual trading loss live. Compiling clean or "looks right" is not the same as reviewed; the review must specifically consider edge cases and interaction with existing timeouts/retries/live state before calling the work complete.

**Iterating on review comments: commit+push after each round instead of accumulating multiple rounds uncommitted.** The `code-review` skill (no target given) always re-reviews the *entire* current uncommitted diff from scratch, not just what changed since the last pass — so stacking several rounds of fixes uncommitted makes every subsequent pass re-scan an ever-growing diff (slow, and burns tokens re-confirming already-fixed ground). Instead, per round: make the change(s) -> run `code-review` -> once its comments come back, commit and push immediately (even though there are still open comments to act on) -> address those comments as the next round -> run `code-review` again (now scoped to just that small new diff) -> commit and push again -> repeat until a pass comes back clean. This came up 2026-09-24: several review rounds were left stacked uncommitted in a row and each pass took 110k+ tokens partly re-reviewing files earlier rounds had already fixed.

## Finishing a Task
**Once all deliverables for a task are complete and verified (build/type-check passes, and a code-review pass has been run per the rule above for any live-trading-affecting change), commit and push — don't leave finished work sitting uncommitted for the user to commit manually.** Push to the current branch's existing remote tracking branch. This applies once work is genuinely done, not to partial/in-progress changes or anything still blocked on a question for the user.

## Session Efficiency
**Don't re-read a file already read earlier in the same session unless it may have changed since** (e.g. another edit/tool call touched it, or enough time/actions passed that an externally-modified file like `ToDo.md`, `config.yml`, or a log file could plausibly be stale). Rely on the file's contents already in context instead of issuing a fresh `Read`/`cat`. This came up because `ToDo.md` was re-read more than once in a single session with nothing in between that would have changed it.

**Only use the Claude-in-Chrome browser extension with the user's approval first** — it burns significantly more tokens than server-side checks (curl, logs, DB queries). Before reaching for it, ask whether it's OK to drive the browser; don't invoke it proactively just because it's connected/available.

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

### Trading Strategies
**See [strategies.md](./strategies.md)** for every strategy under `src/strategy/`:
- Entry triggers, position sizing, and exit mechanisms (GTT/bracket vs self-monitored vs polling)
- Which strategies are actually armable via `config.yml` vs legacy/dead code
- `LegManager.ts`/`strategy.ts` shared infrastructure (leg lifecycle, capital/max-profit gates)

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
- Implements various trading strategies (DiffStrategy, ContinuousStrategy, etc.)
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
npm run processes
```
**Use this, not `npm run server`, for anything involving live trading, order placement, or broker WebSocket streaming (ANT/Breeze market-data ticks, order-notify pushes).** It's the full orchestrator: spawns `order`/`data`/`strategies`/`frontend` as child processes (`orchestrator.ts`), watches/rebuilds via `tsc -w`, and logs to `orchestrator.log`. `npm run server` only starts the standalone `frontend`-equivalent process (`server.ts` directly) with no `order`/`data`/`strategies` processes behind it — broker order execution and stream auto-connect (e.g. `BreezeOrderNotifyStream`, `AntStream`'s order side) live in those other processes, so `npm run server` alone can't exercise them. Reach for plain `npm run server` only for UI/API-only work that doesn't touch orders or streaming.

Both listen on port 3000 (or `process.env.PORT`) and serve the trading platform API and UI; `npm run processes` additionally always listens on 80/443.

### Environment

**Config lives in `.env`** (repo root, gitignored - copy `.env.example` to `.env` and fill in real
values). Loaded via `dotenv/config`, imported as the first line of `src/server.ts` and
`src/orchestrator.ts` - covers every process, since `orchestrator.ts` spawns
order/data/strategies/frontend as children that inherit its already-populated `process.env`.
`npm run server` (standalone, outside the orchestrator) is covered by `server.ts`'s own load.

**Required - the server refuses to start (fails closed) if either is unset:**
- `SESSION_COOKIE_SECRET` - session cookie signing secret. Generate with `openssl rand -hex 32`.
- `GOOGLE_CLIENT_ID` - Google OAuth client ID, used server-side to verify login ID tokens
  (`google-auth-library`'s `verifyIdToken`). Must exactly match `frontend/.env`'s
  `VITE_GOOGLE_CLIENT_ID` - same public client ID, not a secret.

**Recommended (has a fallback default):**
- `ADMIN_EMAILS` - comma-separated emails granted the `admin` role on account creation. Default:
  `skarthikeyan100@gmail.com`.
- `PORT` - HTTP port for the frontend/API server. Default: `3000` (also always listens on 80/443
  regardless of this value).

**Infra/dev (defaults are fine for a normal single-machine setup):**
- `CONFIG_PATH` - path to the strategy/risk config YAML. Default: `./config.yml`.
- `ORDER_IPC_SOCKET`, `STRATEGIES_IPC_SOCKET` - Unix domain socket paths for the order/strategies
  IPC channels. Defaults: `/tmp/icici-order.sock`, `/tmp/icici-strategies.sock`.
- `ORDER_IPC_TIMEOUT_MS` - timeout (ms) for a single order-process IPC request. Default: `90000`.
- `HOT_RESTART` - `orchestrator.ts` dev convenience; set to `'false'` to disable auto-restarting a
  child process when its compiled output changes. Default: on.

**Test/mock mode only (do not set for real trading):** `MOCK_BROKER`, `MOCK_QUOTES`, `MOCK_DATE` -
see `src/constants.ts`.

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
- **Frontend:** React app served from / (root)
- **Frontend build is NOT hot-reloaded:** unlike the backend (`tsc-watch` auto-restarts on save), the frontend is a static pre-built bundle at `public/`, built from `frontend/` via `npm run build` (vite outputs directly into `../public`, per `frontend/vite.config.ts`). Any edit under `frontend/src/` is inert on the running server until you `cd frontend && npm run build` — always do this after frontend changes, or the user will see stale UI with no visible error.

## Debugging

Check these log sources:
- `server.log` - Server startup and API logs
- `server_logs.txt` - Runtime execution logs
- Console output from `Log.log()` calls throughout codebase
- Monitor class tracks state changes and order rejections

**When a broker/API call fails or returns something unusable (null result, 404, unexpected shape), don't just explain what the error means and stop there — web search for a fix or alternative before reporting back.** This applies especially to AliceBlue/ANT API gaps: check their official docs (`v2api.aliceblueonline.com`) and other sources for a working endpoint or workaround, then verify anything found live (real session, real token) before proposing it. Only hand the problem back unsolved if a real search turns up nothing usable. This came up when an ANT `getQuote` call returned `result: [null]` post-market-close — the fix (a different ScripDetails endpoint) should have been found via search, not left for the user to go find via Claude.ai and paste back in.

## Testing

- `npm run test:continuousStrategy` (and other test scripts) should only be run when explicitly requested by the user — not automatically after a code change, even to verify a fix.

## Future Enhancements

Potential areas for improvement:
- Rate limiting per user
- Webhook notifications for trade fills
- Advanced order types (iceberg, time-weighted)
- Historical backtesting framework
- Mobile app support
- Multi-strategy coordination
