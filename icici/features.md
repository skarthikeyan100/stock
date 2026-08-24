# ICICI Trading Platform — Feature Inventory (Pre-Migration Monolith)

Authoritative checklist of every route/feature exposed by the monolithic `src/server.ts`
(as of the pristine pre-migration backup snapshot), organized by functional area. This is
the target the 4-way process split (data / strategies / order / frontend) must be verified
against — nothing here should be silently dropped.

Conventions: **Depends on** lists the concrete in-memory state, files, DB collections, or
channels a route touches — this is what needs to be reproduced (or centralized/shared)
faithfully in the split architecture.

---

## 1. Authentication & Session (application login, not broker)

### `POST /auth/login`
Body `{ email, name, picture }` → gets-or-creates a Mongo user doc, seeds `Monitor`'s
per-user settings cache, sets a signed `session` cookie (email, httpOnly, 30 days).
**Depends on:** Mongo `users` collection (`getOrCreateUser`), `Monitor.userSettingsCache`,
cookie secret `'propfirm-secret'` (set once via `cookieParser('propfirm-secret')`).

### `GET /auth/me`
Returns the current user doc for the signed-in `session` cookie, 401 if absent/unknown.
**Depends on:** signed `session` cookie, Mongo `users` collection.

### `POST /auth/logout`
Clears the `session` cookie. **Depends on:** cookie only, no server state change.

### User resolution helper (used across almost every trading/streaming route)
`resolveUser(req)`: signed `session` cookie → else `X-User-Id` header → else `'Default'`.
Not a route itself, but every per-user route below depends on this resolution order.

---

## 2. User Management (CRUD, roles, KYC, documents)

### `GET /users`
Lists all users, enriched per-row with `sessionPnL` (from `Monitor.userPnL`) and
`hasActiveTrade` (from `Monitor.trades`/`pendingUsers`).
**Depends on:** Mongo `users` collection, `Monitor.userPnL` Map, `Monitor.trades`,
`Monitor.pendingUsers` Set.

### `POST /users`
Body `{ email, name, lossLimit?, lotCount?, role? }` → creates a new user (409 if exists),
defaults `lossLimit=15000`, `lotCount=10`, `role='user'`. Seeds `Monitor` cache.
**Depends on:** Mongo `users` collection, `Monitor.userSettingsCache`.

### `DELETE /users/:email`
Deletes the user doc. **Depends on:** Mongo `users` collection. (Does not clean up
`Monitor` in-memory caches for that email — those are left stale until server restart.)

### `PATCH /users/:email/role`
Body `{ role }`, must be `'admin'` or `'user'` (400 otherwise).
**Depends on:** Mongo `users` collection. Admin auto-assignment on first login is separate
— driven by `ADMIN_EMAILS` env var (default `['skarthikeyan100@gmail.com']`) inside
`getOrCreateUser`.

### `POST /users/:email/settings`
Body `{ lossLimit, lotCount, investmentMode, investmentAmount }` → updates Mongo doc AND
`Monitor.userSettingsCache` (the cache is what `canPlaceOrder`/`getUserContext` actually
read at order time — Mongo alone is not enough for a live risk-limit change to take effect).
**Depends on:** Mongo `users` collection, `Monitor.userSettingsCache`.

### `PATCH /users/:email/profile`
Body `{ phone }` → direct Mongo field update (bypasses the `user.ts` helper layer).
**Depends on:** Mongo `users` collection directly via `Mongo.getInstance().db`.

### `PATCH /users/:email/verify`
Body `{ field, verified }`, field ∈ `email|phone|address|dob|pan`, maps to
`emailVerified|phoneVerified|addressVerified|dobVerified|panVerified` boolean flags.
**Depends on:** Mongo `users` collection directly.

### `POST /users/:email/documents/:docType` (multipart, field `file`, max 5MB)
docType ∈ `address|dob|pan` only. Streams the upload into GridFS, stores the resulting
file ObjectId (as string) on the user doc under `addressProofId`/`dobProofId`/`panCardId`.
**Depends on:** GridFS bucket `'documents'` (via `GridFSBucket` on `Mongo.getInstance().db`),
Mongo `users` collection, `multer` memory storage.

### `GET /users/:email/documents/:docType`
Streams the stored proof file back (`Content-Type`/`Content-Disposition` from the GridFS
file metadata), 404 if the user has no proof of that type on file.
**Depends on:** GridFS bucket `'documents'`, Mongo `users` collection.

---

## 3. Broker OAuth Flows — three independent, non-interacting integrations

Each broker keeps its own credential store; none of these three share a session file or
cookie with each other or with the application `session` cookie from §1.

### 3a. Prism / Shoonya (ICICI-era name "Prism", broker is actually Shoonya/Finvasia-family)

- `GET /prism/oauthurl` → returns `{ url }` for the Shoonya OAuth authorize page (no redirect).
- `GET /prism/login` → 302 redirect straight to the same OAuth URL.
- `GET /prism/callback?code=` → exchanges `code` via `loginWithGenAcsTok` (SHA-256 checksum of
  `clientId+secretCode+code`), then redirects to `/app`.
- `GET /prism/authcode` → returns the last authorization `code` seen by `/prism/callback`
  (debug-only; 404 if none captured this process lifetime).
- `GET /prism/quick-login?otp=` → legacy password+OTP login path (`NorenRestApi.login`);
  superseded by OAuth but still live.
- `GET /prism/token?code=` → same exchange as `/prism/callback` but without the redirect
  (used for manual/scripted token refresh).

**Depends on:** `NorenRestApi` singleton (`src/prism/RestAPI.ts`) in-memory
`accessToken`/`userToken`/`userId`; persisted to **`userToken.txt`** (repo root, plaintext,
restored on process boot if present — `fs.existsSync('userToken.txt')` in the constructor);
in-memory `authorizationCode` var in `server.ts` (not persisted, lost on restart);
`Prism.getInstance()` singleton wraps `NorenRestApi` and additionally caches
`NFO_symbols.txt` into memory (`cacheFile()`) for token/contract lookups.
**Gotcha carried over:** `RestAPI.ts` installs a *global* axios response interceptor that
unwraps `response.data` — any code sharing the global axios instance is affected.

### 3b. ANT / AliceBlue

- `GET /ant/login` → 302 redirect to `https://ant.aliceblueonline.com/?appcode=...`.
- `GET /ant/callback?authCode=&userId=` → exchanges via SHA-256 checksum
  (`userId+authCode+apiSecret`) against AliceBlue's `getUserDetails` endpoint, stores the
  resulting `userSession` in three places (see Depends on), then redirects to `/app`.
- `GET /ant/token` → returns `{ access_token }` from the in-memory `antAccessToken` var set
  by `/ant/callback` this process lifetime; 401 if not yet set (does **not** fall back to
  the `.ant_session.json` file or the cookie — only the in-process var).
- `GET /ant/positions` / `GET /ant/trades` → REST calls via `ANT.getInstance()`
  (`{success, positions|trades, count}` shape). **Registered a second time later in the
  file with a different response shape (`{positions}`/`{trades}`) — that second
  registration is dead/unreachable code; Express keeps the first handler.**
- `GET /ant/connect` → starts the live WebSocket stream (`AntStream.connect()`), subscribing
  to NIFTY (`NSE|26000`) and SENSEX (`BSE|1`) plus any tokens already tracked in
  `Monitor.trades`/pending orders. **Must be called again after every process restart** —
  connection state is in-memory only (documented gotcha).
- `GET /ant/stream` → SSE endpoint, forwards every `'ant-quote'` emitter event verbatim as
  `data: <json>\n\n`. This is the raw ANT tick feed, separate from `/niftystream`.

**Depends on:** `ANT` singleton in-memory `userSession`/`userId`, persisted to
**`.ant_session.json`** (repo root); in-memory `antAccessToken` var in `server.ts`; signed
cookie `ant_session` (write-only — nothing reads it back); `AntStream` singleton (in-memory
WebSocket connection + `dynamicOptionTokens` Set); `AntSession`/`AntWebSocket` for the
Noren-protocol WS handshake (`susertoken` derived via double SHA-256 from `userSession`);
`AntContractMaster` for NFO/BFO token lookups against `data/ant/NFO_contract.json` /
`data/ant/BFO_contract.json`. Emits on `myEmitter` channel `'ant-quote'` (raw) and, via
`AntStream.broadcastQuote`, also `'nifty'`/`'sensex'` (normalized) which feed `Monitor` and
`Decision` — i.e. ANT is the platform's sole live quote source end-to-end.
**Classic (userId+apiKey) AliceBlue auth is not provisioned for this account** — don't
reintroduce `AntBroker.ts`'s scaffold without confirming the account has a classic key.

### 3c. Zerodha / Kite

- `GET /kite/login` → 302 redirect to `KiteConnect.getLoginURL()`.
- `GET /kite/callback?request_token=` → exchanges via `kc.generateSession(requestToken, apiSecret)`,
  stores `access_token`, redirects to `/app`.
- `GET /kite/token` → returns `{ access_token }` from the in-memory `zerodhaAccessToken` var
  (same in-process-only caveat as ANT's `/ant/token`).
- `GET /kite/trades` → `{ trades }` via `kc.getTrades()`.
- `GET /kite/positions` → `{ positions }` via `kc.getPositions()`.

**Depends on:** `Zerodha` singleton wraps a `KiteConnect` instance; `accessToken` persisted
to **`.zerodha_session.json`** (repo root); in-memory `zerodhaAccessToken` var in
`server.ts`; signed cookie `zerodha_session` (write-only, same as ANT's cookie).
**Not wired to any route:** `Zerodha.buyOption()`, `getFillPrice()`, and
`placeTargetStopLossGTT()` (two-leg OCO GTT for target/stop-loss) are fully implemented on
the class but no `server.ts` route calls them — Kite order placement is currently
unreachable via HTTP. Flag for the migration: either wire these up or drop them
consciously, don't silently leave them stranded.
**Also note:** `dns.setDefaultResultOrder('ipv4first')` is set at the very top of
`server.ts` specifically because Kite's IP allowlist is IPv4-only and this host is
dual-stack — this must travel with whichever process makes Kite API calls.

---

## 4. Order Placement & Execution

### `GET /prism/order/buy?index=&right=&strikePrice=&price=&contract=&triggerPrice=`
The main order-entry endpoint. Resolves user via `resolveUser`, checks
`Monitor.canPlaceOrder` (lot limit / loss limit / investment limit — 403 with reason if
blocked), marks user pending, then one of three paths:
- `contract` given → `Prism.buyContract(contract, ..., userContext)` (buys a specific
  trading symbol directly).
- `right` given without `strikePrice` → `Prism.buyIndex({ userContext, index, right })`
  (ATM-relative auto strike selection).
- neither → `Prism.buyIndex({ userContext, index })` (fully automatic direction+strike).
- both `right` and `strikePrice` → resolves an explicit token via
  `nseIndex.findTokenFor`, fetches/uses `price`, places via `Prism.sendLimitOrder`.
**Order is always buy-side** — `trantype: 'B'` is hardcoded at the broker layer in
`buyContract`/`buyIndex`/`sendLimitOrder`; there is no sell-to-open endpoint.
**Depends on:** `Monitor.canPlaceOrder`/`pendingUsers`/`getUserContext`, `Prism` singleton
(NFO symbol cache, `NorenRestApi.place_order`), `nse_index` token lookup, `Config`
(`prism/config.ts` — `optionDirection`, `depth`, `bidirection`, `selectedOption`,
`lotCount`), `configService` settings.

### `GET /prism/squareoff?token=&expiryDate=&strikePrice=&right=&qty=`
Closes (sells) an existing position by token/qty for the resolved user.
**Depends on:** `Prism.squareOffOrder` → `NorenRestApi.place_order` (market or limit sell),
`Monitor.trackPendingOrder`/`trackOrder` for order→user attribution.

### `POST /prism/settarget` — body `{ token, targetPoints, stopLossPoints, trailingDistance? }`
Sets/updates target price, stop-loss price, and trailing-stop distance on an open trade;
trailing distance defaults from `configService.getConfig().settings.trailingDistance` if
omitted. Actual auto square-off on hit is driven separately by `Monitor.updateQuote` on
every live tick for that token (target hit / stop-loss hit / trailing high-water-mark logic).
**Depends on:** `Monitor.trades` (find by token+user), emits `myEmitter 'position'` on
change.

### `GET /addTrade?tsym=&flqty=&flprc=`
Manually injects a synthetic buy fill into `Monitor.updateTrade` — a debug/manual
trade-entry endpoint, bypasses the broker entirely.
**Depends on:** `Monitor.updateTrade` (same code path real broker order-fill callbacks use).

### `GET /start`
Fires two automatic index buys (NIFTY then BANKNIFTY) for the `'Default'` user context —
legacy/manual trigger, not part of the normal automated-strategy flow.
**Depends on:** `Prism.buyIndex`, `Monitor.getUserContext('Default')`.

### `GET /connect`
Re-establishes the Prism/Shoonya WebSocket connection (order-fill notifications only).
**Depends on:** `Prism.connect()` / `NorenRestApi.start_websocket`.

### `GET /subscribe`
No-op placeholder (200 OK, does nothing) — touchline quote subscription fully moved to ANT;
kept only so stale frontend calls don't 404.

---

## 5. Trade & Position Queries

### `GET /openTrades`
Raw dump of `Monitor.trades` (all users, unfiltered) — internal/debug use.
**Depends on:** `Monitor.trades` in-memory array.

### `GET /trades`
Returns the resolved user's open trades, filtered from `Prism.getTradeList()` (which itself
just returns `Monitor.trades`) by `t.user === user`.
**Depends on:** `Monitor.trades`, `resolveUser`.

### `GET /closedtrades`
Returns the resolved user's closed trades, filtered from `Monitor.getClosedTrades()`.
**Depends on:** `Monitor.closedTrades` in-memory array, `resolveUser`.

### `GET /refreshtrades`
Pulls live positions from the broker (`Prism.refreshTradeList` → `NorenRestApi.get_positions`),
filters to NIFTY-family contracts with positive quantity, replaces `Monitor.trades` wholesale
via `Monitor.refreshTrades` (which also re-subscribes ANT streaming for every trade's token),
and separately fetches+applies pending orders via `Monitor.refreshPendingOrders`.
**Depends on:** broker positions API, `Monitor.trades` (full replace), `AntStream.subscribeOption`.

### `GET /subscribetrades`
Re-subscribes ANT streaming for every currently-known `Monitor.trades` token (does not
refetch broker state first, unlike `/refreshtrades`).
**Depends on:** `Monitor.subscribeTrades`, `AntStream.subscribeOption`.

### `GET /prism/orderbook`
Returns pending (non-COMPLETE) broker orders via `Prism.getOrders()`.
**Depends on:** `NorenRestApi.get_orderbook`.

---

## 6. Real-time Streaming (Server-Sent Events)

All four SSE endpoints follow the same pattern: set SSE headers, `retry: 10000`, register an
`myEmitter.on(channel, cb)` listener that writes `data: <json>\n\n` per event, and deregister
on `req.connection`/`req` `'close'`.

### `GET /niftystream`
Channel `'nifty'`. Payload shape `{ nifty: NiftyQuote }` (emitted by `AntStream.broadcastQuote`
for the NIFTY index token `26000`). No per-user filtering — global broadcast.
**Depends on:** `myEmitter` channel `'nifty'`.

### `GET /optionstream`
Channel `'option'`. **Note:** nothing in the read code path (`Monitor`, `AntStream`,
`Decision`) actually emits on channel `'option'` in this snapshot — `Monitor.updateQuote`
only emits `'position'`. This endpoint appears to be either legacy/unused or fed by a code
path not reached during this read; verify against runtime logs before assuming it's dead,
but do not assume it is wired to option-quote ticks without further check.
**Depends on:** `myEmitter` channel `'option'`.

### `GET /positionstream`
Channel `'position'`. Payload is a **per-connection filtered array**: resolves user from the
SSE request itself, and on every `'position'` event re-filters `Monitor.trades` +
`Monitor.getClosedTrades()` down to that user's trades, tagging each with an explicit `open`
boolean. This is the richest of the streams — every listener gets a personalized payload
computed inside the callback, not a shared broadcast payload.
**Depends on:** `myEmitter` channel `'position'`, `Monitor.trades`, `Monitor.getClosedTrades()`,
`resolveUser`.

### `GET /ant/stream`
Channel `'ant-quote'` (documented in §3b) — raw ANT ticks, unfiltered, no per-user logic.
**Depends on:** `myEmitter` channel `'ant-quote'`, isolated from the three channels above.

---

## 7. Strategy Admin

### `GET /stats`
Renders an ASCII table (`text/plain`) of every registered strategy's stats: trades, wins,
losses, timeouts, win%, total P&L. Columns come from `Strategy.getStats()`.
**Depends on:** `strategies.getList()` (the `Strategies` singleton registry), each
`Strategy` instance's own win/loss/timeout counters (in-memory, not persisted).

### `GET /strategies?strategy=&userId=&enable=`
Dual-purpose: with `enable` present, flips `enabled` on every strategy matching `userId` OR
class name (`strategy` param) equal to `identifier`; always returns the full list
`{ type, userId, enabled }` afterward (list-then-optionally-mutate-then-list-again pattern).
**Depends on:** `strategies.getList()`, mutates `Strategy.enabled` in place (in-memory only —
not written back to `config.yml`, so a restart reverts to the config file's `enabled` value).

### `GET /strategies/:type/reset`
Calls `.reset()` on every strategy instance whose class name matches `:type`; returns
`{ type, reset: <count> }`. `Strategy.reset()` currently only clears `lastTriggerTime`
(cooldown timer) — does not clear win/loss/PnL counters.
**Depends on:** `strategies.getList()`, `Strategy.reset()`.

---

## 8. Market Data / Quotes

### `GET /quotes`
Combined snapshot `{ nifty, bankNifty, finNifty }`, each a `NiftyQuote` fetched fresh via
`Prism.getNiftyQuote/getBankNiftyQuote/getFinNiftyQuote` (REST `get_quotes` call per index,
**not** the live ANT stream — this is a point-in-time broker REST fetch, separate from the
push-based `/niftystream`).
**Depends on:** `NorenRestApi.get_quotes` (Shoonya REST), `nse_index` token map.

### `GET /niftyquote`
Same as above but NIFTY only, unwrapped (`Prism.getNiftyQuote()` directly).

### `GET /quote?symbol=`
Arbitrary NSE equity/index quote by symbol via `Prism.getStockQuote`.

### `GET /requestOtp`
Triggers Shoonya's forgot-password OTP flow (`NorenRestApi.request_otp`) — legacy, tied to
the deprecated password+OTP login path, not the OAuth flow.

### `GET /search?depth=&right=&index=`
Debug token finder: `nseIndex.findToken(index, depth, right)` → returns the resolved token
as a hand-built string (not real JSON — `"{ token: " + token + "}"`, note the malformed
response — a migration should fix this rather than faithfully reproduce the bug, but must
flag it).

### `GET /logout`
Logs out of the Shoonya session (`Prism.logout()` → `NorenRestApi.logout`). Does not clear
`userToken.txt` or respond with any status (missing `res.send`/`res.sendStatus` — the request
just hangs until timeout; another bug worth flagging, not silently porting as "working").

### `GET /candles?` (no query params actually read)
Returns 15-minute NIFTY candles from the in-memory `CandleManager` (`src/candle.ts`).
**Depends on:** `candleManager` singleton, populated by `_formCandle`/`addQuote` — but note
`CandleManager.addQuote` has a hardcoded `x.getDate() != 21` guard (only builds candles on
the 21st day of the month) — this looks like leftover debug/test code, likely stale/broken
for general use; flag rather than assume it's a deliberate feature.

### `GET /test?index=`
Debug endpoint, calls `Prism.getOptionChain()` (logs only, discards the result) and returns
the literal string `"Done"`. Effectively a manual trigger with no useful response — treat as
dev-only tooling, not a real API contract.

---

## 9. Configuration

### `GET /config`
Returns `configService.configToFlat()` — the YAML config flattened so each strategy's block
is keyed by its lowercased-first-letter type name (e.g. `buySellStrategy: {...}`) alongside
a top-level `settings` object.

### `POST /config`
Body is the same flattened shape; `configService.flatToConfig()` reconstitutes the
`{ settings, strategies: [] }` `AppConfig` shape and `writeConfig()` persists it as YAML,
echoing the input back.
**Depends on:** `config.yml` (path overridable via `CONFIG_PATH` env var), hot-reloaded via
`fs.watchFile` inside `ConfigService` (so external edits to the file also take effect without
restart — the POST handler and the file watcher both funnel through the same reload path).
Global settings of note: `minPrice`, `maxPrice`, `targetPriceDiff`, `stopLossPriceDiff`,
`trailingDistance`, `cooldownSeconds`, `logQuotes` (gates whether every tick gets persisted
to Mongo via `Monitor._processQuoteForStrategies`/`AntStream.persistQuote`).

---

## 10. Backtesting / Replay

### `GET /replay?date=YYYY-MM-DD`
Replays a day's worth of persisted quotes through the real candle-building/decision path:
loads all `Quote` documents for that date from Mongo (sorted by `ltt`), feeds each through a
fresh `Decision` instance in `replayMode = true` (`_addPrice` → same candle-bucketing logic
as live ticks, but `replayMode` suppresses the `'stats'` event's strategy dispatch so replay
doesn't place live orders), then force-flushes any partial trailing candle
(`flushCandles()`). Returns `{ date, processed: <count> }`. Intended to reproduce the same
`[VERIFY] Candle`/`Signal` log lines as the offline `pipeline:fast --date` tool for
cross-checking.
**Depends on:** Mongo `Quote` collection, `Decision` (fresh instance per call, not the
`Decision.getInstance()` singleton — avoids polluting live state), `candle-builder` lib
shared with the offline pipeline tool.

---

## 11. Static UI Serving

- `app.use(express.static('public'))` — serves legacy hand-rolled static tools at their
  root paths: `config.html`, `data.html`, `monitor.html`, `prism.html`, `test.html`,
  `time.html`, `index.html` (all directly under `public/`). These are pre-React debug/ops
  pages, independent of the SPA below.
- `GET /app*` — serves `public/app/index.html` for every path under `/app` (SPA
  client-side-routing catch-all; the actual built assets live under `public/app/assets/`).

---

## 12. Startup Sequence (in `app.listen` callback)

1. `Prism.getInstance()` — constructs singleton, triggers `cacheFile()` (loads
   `NFO_symbols.txt`, repo root, into memory for token/contract/lot-size lookups).
2. `await Mongo.init()` — connects to `mongodb://localhost:27017/stocks`, ensures
   collections `trade`, `quote`, `NiftyQuote`, `users` exist (other collections like
   `Quote`, `OptionQuote`, `SensexQuote`, `documents.*` GridFS chunks/files are created
   on first write, not pre-created here).
3. `await strategies.initialize()` — reads `config.yml`'s `strategies` array, expands
   `RuleBasedStrategy` multi-rule configs, instantiates strategy objects via
   `StrategyFactory`, registers each with `Monitor` (`registerStrategy`), and seeds each
   strategy's per-user `lossLimit`/`lotLimit`/`maxInvestment` into
   `Monitor.userSettingsCache` from the Mongo `users` collection.
4. **ANT streaming is NOT auto-started** — `GET /ant/connect` must be called explicitly
   after every process start/restart (documented gotcha: `AntStream`'s WS connection is
   in-memory only and does not survive `tsc-watch` auto-restarts either).

Note also: `app._router.stack.forEach(...)` right after all route registrations just logs
the full route list to console at boot — not a feature, pure introspection/debug logging.

---

## 13. Dead / Commented-Out Code (do not port, noted only to avoid confusion)

- Lines 1-74: original raw `http.createServer`-based implementation, fully commented out,
  superseded by the Express app below it.
- `mockOpenPositions`, `mockRuntimeQuote`, `mockEvent`, `apiSession`, `sessionToken` —
  top-level constants, declared but never read anywhere in the live route handlers.
- `demoLogger` middleware — defined, never `app.use()`'d (commented out).
- A second, fully commented-out `/config` handler using a since-removed
  `Config.targetPriceDiff` direct-mutation style (predates `ConfigService`).
- Inside the `app.listen` callback: a large commented-out block covering a `CronJob` for
  auto-buying at market open, old ICICI Direct/Breeze API key/session comments, a manual
  `BreezeConnect` session/funds walkthrough, and a `localtunnel` public-URL block. None of
  this executes.
- `var BreezeConnect = require('breezeconnect').BreezeConnect;` — required at module scope
  but never instantiated on any reachable path; ICICI Direct/Breeze integration
  (`src/breeze.ts`) is fully retired and unreferenced from `server.ts`.
- The second `/ant/trades` and `/ant/positions` registrations (§3b) — unreachable due to
  Express first-match-wins route dispatch, not "dead" in the source sense but dead in the
  runtime sense; flagged there rather than repeated here.
