# ICICI Trading Platform — Codebase Analysis

*Generated 2026-08-25 by 6 parallel read-only research agents, one per domain. Analysis only —
no source code was modified in producing this document. Every finding below cites `file:line`
so it can be verified and turned into a fix ticket directly.*

## Methodology

Six agents ran in parallel, each scoped to one domain of the codebase, with instructions to
verify (not assume) claims by reading actual source and grepping for importers/callers before
declaring anything dead, wired, or broken:

1. Backend API & Auth — `src/server.ts`, `src/user.ts`, config service, session/OAuth flow
2. Broker & Order Execution — `src/broker/*`, `src/ant/*`, `src/prism/*`, `src/zerodha/*`, `src/processes/order/*`
3. Strategy & Decision Logic — `src/strategy/*`, `src/decision.ts`, `src/scheduler/*`, `src/orchestrator.ts`
4. Data Model, P&L & Payout — `src/monitor.ts`, `src/payout.ts`, `src/tax.ts`, `src/processes/order/bookkeeping.ts`, `src/model*`, `src/trade/*`, `src/tools/mongo.ts`
5. Frontend & UX — `frontend/src/**`, legacy `public/*.html`
6. Test Harness & API Contract — whole repo, plus `API.md`

Raw per-domain reports (with any material not folded into the sections below) are preserved at
`/home/karthikeyan/work/icici/.analysis-work/*.md`.

## System Overview (for orientation)

Prop-trading-firm platform. Users are either real humans (Google OAuth login) or automated
trading strategies modeled *as* users (each strategy's trades/P&L/payout tracked like a real
user's). Three broker integrations: `ant` (Alice Blue, price streaming only), `prism` (Shoonya,
legacy, being phased out), `kite` (Zerodha, the only broker actually used for live order
execution today). Live order/risk bookkeeping runs through `src/orchestrator.ts` →
`src/processes/order/bookkeeping.ts`, not the legacy `src/monitor.ts` (CLAUDE.md is stale on
this point).

---

## Priority Punch List

Ordered money-correctness → security/authz → reliability → UX → polish/test-harness. Each item
links to its full write-up in the domain section below.

### Money-correctness (real P&L / payout risk)
1. **No idempotency on trade fills — a redelivered fill double-books realized P&L and inflates payouts.** [§4.1](#critical-bugs-4)
2. **Prism/Shoonya order-placement failures are silently swallowed and can record phantom full-quantity fills.** [§2.1](#critical-bugs-2)
3. **`monitor.ts` mishandles partial sells (uses full open quantity, not filled quantity) and conflates unrealized with realized P&L.** [§4.4](#critical-bugs-4), [§4.5](#critical-bugs-4)
4. **A losing period can still produce an approvable "pending" payout with a negative net amount.** [§4.1](#critical-bugs-4)
5. **The payout consistency rule's math can exceed 100%, over-blocking legitimate payouts whenever the period has any losing day.** [§4.1](#critical-bugs-4)

### Security / authorization
6. **`POST /auth/login` performs zero identity verification — anyone can mint a session for any email, including the hardcoded admin account.** [§1.1](#critical-bugs-1)
7. **`resolveUser()`'s `X-User-Id` header fallback is an unauthenticated full identity bypass for every trading route.** [§1.1](#critical-bugs-1)
8. **Systemic IDOR: no route under `/users/:email/*` checks the caller matches `:email` or is an admin** — role escalation, KYC/bank-detail read+write, identity-document download, payout history, all exposed to anyone who knows an email. [§1.1](#critical-bugs-1)
9. **No authorization on any `/admin/*` route**, including payout approve/reject. [§1.1](#critical-bugs-1)
10. **`/config` (GET/POST) and the static `public/config.html` are completely unauthenticated** — full read/write access to live strategy risk parameters, bypassing the React app's `RequireAdmin` gate entirely. [§1.1](#critical-bugs-1) / [§5](#critical-ux-bugs-5)
11. **Unauthenticated `GET` routes execute live trades or mutate the trade ledger** (`/start`, `/addTrade`, `/connect`), and all order-mutating actions are `GET` (CSRF-exposed, no `sameSite` cookies). [§1.1](#critical-bugs-1)
12. **Hardcoded plaintext broker credentials for all three brokers, committed in source.** [§2.1](#critical-bugs-2)
13. **KYC document upload accepts attacker-controlled `Content-Type` and re-serves it inline — stored-XSS risk.** [§1.1](#critical-bugs-1)

### Reliability
14. **Per-user broker configurability doesn't work in practice** — the routing mechanism exists in `bookkeeping.ts`/`orderProcess.ts`, but the `broker` field that drives it has no writer anywhere (not in `user.ts`, not in any endpoint, not in the frontend), so every user is hardcoded to Zerodha. [§1.2](#gaps--missing-features-1) / [§2.2](#gaps--missing-features-2) (merged finding)
15. **`ContinuousStrategy`'s runtime enable/disable toggle is a no-op** — always initializes `enabled = true`, ignoring both `config.yml` and the admin API's intended target field. [§3](#critical-bugs-3)
16. **`GapStrategy` self-disables permanently after its first trade** — no daily reset exists anywhere in the live pipeline. [§3](#critical-bugs-3)
17. **`BuySellStrategy` uses module-level (not instance-level) shared mutable state** — a second configured instance would corrupt the first's order-in-flight tracking. [§3](#critical-bugs-3)
18. **`receive()` / `decision.ts` has no live invocation path at all** — root-causes the previously-known "RuleBasedStrategy/Minutes5Decision are inert" finding; also silently disables entry logic in BiDirectionStrategy, DiffStrategy, PivotStrategy, HighLotStrategy if any of them are ever added to config. [§3](#strategy-wiring-status)
19. **`SupportResistanceStrategy` ships with `supportPrice`/`resistancePrice` defaulting to 0** — enabling it as-shipped would fire a buy on every single tick. [§3](#gaps--missing-features-3)
20. **`AntStream` (legacy path) has no websocket reconnect logic**, unlike its sibling `AntDataStream`; non-bracket ANT square-offs don't record the real fill price; contract-master staleness has no automated detection anywhere. [§2.2](#gaps--missing-features-2)
21. **`pendingLimitOrders`/`exitMonitor` in-memory state doesn't survive a process restart**, with no reconciliation against live broker state on startup. [§2.2](#gaps--missing-features-2)
22. Multiple dormant-but-live-if-ever-enabled strategy bugs in `HighLotStrategy`, `BiDirectionStrategy`, `IntermittentStrategy` — see [§3 Critical Bugs](#critical-bugs-3) items 3–9.

### UX
23. **Admin trade views have no ThisDay/ThisMonth/Custom date-range filter** (explicit user ask) — today it's two bare empty date inputs, single-user-only, manual "Load" click, and doesn't cover Open Positions at all. [§5 lead finding](#lead-finding-explicit-ask-admin-trade-date-filtering--what-exists-today-and-proposed-fix)
24. **Square-off (closing a real position) has no confirmation dialog and silently fails on error** in the trading UI. [§5](#critical-ux-bugs-5)
25. **`NotificationBell`'s SSE stream has no reconnect logic**, unlike its two sibling SSE consumers — including for `drawdown_breach`, the most safety-critical notification type. [§5](#critical-ux-bugs-5)

### Polish / test harness
26. **Zero automated tests exist anywhere in the repo** (backend or frontend), despite `jest`/`supertest` sitting unused in `devDependencies` — this is a real-money system with no safety net. [§6](#6-test-harness--api-contract)
27. **`API.md` is materially stale**: ~40 documented endpoints vs. 82 actually registered in `server.ts` — entire subsystems (payouts, KYC detail fields, notifications, admin trade filters, the ANT order path) are undocumented. [§6](#6-test-harness--api-contract)
28. Visual/professionalism split between a polished marketing funnel and near-unstyled internal admin/trading pages; five of six legacy `public/*.html` pages are fully dead and safe to delete; see [§5 Polish](#polish--professionalism-recommendations-5).

---

## 1. Backend API & Auth

*Scope: `src/server.ts`, `src/user.ts`, `src/prism/ConfigService.ts` + `AppConfig.ts`, session/OAuth flow.*

### Critical Bugs {#critical-bugs-1}

1. **`/auth/login` performs zero server-side identity verification — full authentication bypass.** `src/server.ts:75-96` takes `email`, `name`, `picture` directly from the POST body and issues a signed `session` cookie via `getOrCreateUser`. No Google ID-token verification exists anywhere (no `google-auth-library`, no `verifyIdToken`, no Google dependency in `package.json`). Anyone can `POST /auth/login {"email":"<admin-email>","name":"x"}` and receive a valid session for the admin account (hardcoded admin email check at `src/user.ts:90-92`) or any other user, with no proof of ownership.
2. **`resolveUser()` trusts an unauthenticated request header as a full identity bypass.** `src/server.ts:66-71` falls back to `req.headers['x-user-id']` with no validation when no session cookie is present. Every trading route (`/prism/order/buy` `server.ts:801`, `/prism/squareoff` `server.ts:822`, `/ant/order/buy` `server.ts:852`, `/ant/order/squareoff` `server.ts:873`, `/prism/settarget` `server.ts:834`) uses this to place/close real trades. Setting `X-User-Id: victim@example.com` on an unauthenticated request places/closes orders as that user.
3. **No authorization check on any `/users/:email/*` route — systemic IDOR.** None verify the caller matches `:email` or is an admin:
   - `PATCH /users/:email/role` (`server.ts:181-203`) — any caller can promote any account, including their own, to `admin`.
   - `PATCH /users/:email/verify` (`server.ts:306-327`) — any caller can mark any user's KYC fields verified with no admin gate.
   - `PATCH /users/:email/bank-details`, `/kyc-numbers`, `/profile`, `/entity-type`, `/company-profile` (`server.ts:229-304`) — any caller can overwrite any other user's bank account, IFSC, UPI, PAN/Aadhaar, legal name, phone.
   - `POST`/`GET /users/:email/documents/:docType` (`server.ts:380-448`) — any caller can upload to, or download, any other user's identity documents.
   - `GET /users/:email/payouts*` (`server.ts:456-486`) — any caller can view any other user's payout history/invoices/decision logs.
   - `GET/PATCH /users/:email/notifications*` (`server.ts:1120-1143`) — any caller can read/mark-read any other user's notifications.
   - `GET /users/:email/trades/closed` (`server.ts:981-997`) — any caller can view any other user's full trade history.
   - `isAdminEmail()` (`src/user.ts:94-96`) exists but is only ever called once, at account creation (`user.ts:132`) — never used to gate a route.
4. **No authorization on any `/admin/*` route.** `GET /admin/payouts` (`server.ts:488-500`), `POST /admin/payouts/compute` (`:502-514`), `POST /admin/payouts` (`:516-528`), `PATCH /admin/payouts/:id` (`:530-543`), `GET /admin/trades/closed` (`:999-1015`), `GET /admin/trades/open` (`:1021-1031`) — none check the caller is an admin. `PATCH /admin/payouts/:id` records `resolveUser(req)` as `decidedBy` (`:536-537`) without verifying that identity is an admin — combined with bug #2, any unauthenticated caller can approve/reject arbitrary payouts under a spoofed admin's name.
5. **Unauthenticated `GET` routes execute real trading actions / mutate the ledger.** `GET /start` (`server.ts:913-925`) places a live market order with no auth. `GET /addTrade` (`:901-911`) injects a trade directly into bookkeeping from client-supplied fields with no user attribution. `GET /connect` (`:927-935`) triggers a broker connection, unauthenticated. More generally, all order-mutating actions are exposed as `GET` (`/prism/order/buy`, `/prism/squareoff`, `/ant/order/buy`, `/ant/order/squareoff`, `/start`, `/addTrade`, `/logout`, `/requestOtp`) rather than `POST`/`DELETE`; combined with no `sameSite`/`secure` cookie attributes (Minor #1) and no CSRF protection, these are exploitable via cross-site GET navigation.
6. **`/config` GET/POST has no authentication and no schema validation — controls live trading risk parameters.** `server.ts:1315-1323`. `POST /config` writes the raw request body via `configService.writeConfig(configService.flatToConfig(flat))`; `flatToConfig` (`ConfigService.ts:41-45`) does no shape validation — any subset of fields is accepted and written to `config.yml`, silently blanking fields like `minPrice`, `stopLossPriceDiff`, `safetyBufferAmount`, `consistencyLimitPercent` (defaults never re-applied — `AppConfig.ts:17-30`'s `Settings` field initializers are never invoked, the parsed object is only ever `as`-cast). **Compounding this: the static `public/config.html` (see §5 Critical UX Bugs) serves an unauthenticated Monaco-editor UI directly against this same unauthenticated route**, so anyone who finds the URL can view and overwrite live strategy config with no login, fully bypassing the React app's `RequireAdmin` gate (`frontend/src/App.tsx:22-27,48-55`).
7. **Document upload accepts attacker-controlled `Content-Type` and re-serves it `inline` at the app's own origin — stored-XSS risk.** `server.ts:380-422` (multer, no mimetype allow-list) stores `req.file.mimetype` verbatim in GridFS (`:392`); the download route sets `Content-Type` from that stored value with `Content-Disposition: inline` (`:441-443`). A file uploaded as `text/html`/`image/svg+xml` under the guise of a KYC proof will later execute in-browser, same-origin. Only a 5MB size cap exists (`:329`) — no content-type allow-list or sniffing.

### Gaps & Missing Features {#gaps--missing-features-1}

1. **Per-user broker configurability does not exist in practice — see merged finding in Priority Punch List #14 and §2.2 for the full mechanism.** `User` (`src/user.ts:5-49`) has no `broker` field; nothing in `server.ts` ever pushes a `broker` value into `bookkeeping`'s settings cache, so it always defaults to `'zerodha'` (`bookkeeping.ts:94`, `zerodhaExecutor.ts:125-133` documents this as unimplemented).
2. `POST /users` doesn't validate `role` (`server.ts:140-164` → `user.ts:237-266`) — inconsistent with `updateUserRole` (`user.ts:273-279`), which does validate.
3. No global Express error-handling middleware — `/config`'s `writeConfig` (`server.ts:1319-1323`) and `GET /replay` (`:1327-1343`) have no try/catch and would fall through to Express's default handler.
4. `ConfigService.loadConfig()` (`ConfigService.ts:52-57`) is unguarded `readFileSync`+YAML parse, re-invoked with no try/catch from an `fs.watchFile` callback (`:59-64`) — a partial/malformed write observed mid-flush could throw inside that callback, which is fatal to the Node process absent a process-level `uncaughtException` handler (none found).

### Minor Issues {#minor-issues-1}

1. No `sameSite`/`secure` on any session cookie (`server.ts:90,659,726`) — compounds the CSRF exposure from GET-based mutating routes above.
2. Two confusingly overlapping logout endpoints: `POST /auth/logout` (`:112-115`) clears the app session; `GET /logout` (`:1287-1295`) instead does broker logout and leaves the app session cookie untouched despite the generic name.
3. Inconsistent error status-code conventions — most routes `res.sendStatus(500)`, others `res.status(400/404).json(...)` regardless of client-vs-server fault; `/prism/order/buy`/`/ant/order/buy` classify errors via a fragile `e.message.includes('limit')` string match (`:818,869`).
4. Redundant per-route `express.json()` on top of the already-global `bodyParser.json()` (`:834,885`).
5. `maskLast4`/bank-account masking (`user.ts:55-62,74`) produces zero masking for values ≤4 characters — not currently exploitable given fixed-length PAN/Aadhaar patterns, but `bankAccountNumber` has no length validation.
6. Admin auto-assignment (`isAdminEmail`) only runs at first account creation (`user.ts:132`) — never reconciled if `ADMIN_EMAILS` changes later (moot anyway since role is unauthenticated-writable, Critical #3).

### Notes {#notes-1}

- **`/users` P&L enrichment gap — verified resolved**, with one residual staleness issue folded into §4 Gaps (`sessionPnL` resets to 0 on `order` process restart).
- Broker OAuth flows for prism/ant/kite are structurally consistent with each other; no functional bugs beyond the cookie-attribute issue above.

---

## 2. Broker & Order Execution

*Scope: `src/broker/*` (dead), `src/ant/*`, `src/prism/RestAPI.ts` + `src/prism.ts`, `src/zerodha/*`, `src/processes/order/*`, `src/processes/orderProcess.ts`, `src/processes/data/AntDataStream.ts`, `src/processes/dataProcess.ts`.*

### Critical Bugs {#critical-bugs-2}

1. **Order-placement failures are silently swallowed and can produce phantom "successful" fills at full requested quantity (Prism/Shoonya legacy path).** `src/prism.ts:1128-1160` (`_placeOrderWithForce`) catches the broker call's exception, logs it, and returns `undefined` — never re-throws. `sellContract` (`:636-663`) loops per-leg over `splitQty(qty)` (`:65-73`, splits qty >1800) and ignores the return value entirely. `buyContract` (`:773-817`) does the same, then unconditionally sets `response.qty = qty` (`:817`) — the originally *requested* quantity, not what actually filled; if an earlier leg fails and a later one succeeds, the response silently reflects only the last leg's data at full requested size. Both flow into `prismExecutor.ts:54-71`/`:92-111`, which call `bookkeeping.recordFill(trade)` unconditionally — recording a fill that may not have happened, corrupting position/P&L/limit accounting with no alert. Only the single-leg-fails-last-and-is-only-leg case surfaces at all (via a `TypeError` on `response.qty`); every other failure pattern is silently reported as full success.
2. **Hardcoded broker credentials committed in plaintext source, all three brokers:** AliceBlue `appKey`/`apiSecret` (`src/ant/ANT.ts:13-14`), Zerodha `apiKey`/`apiSecret` (`src/zerodha/Zerodha.ts:10-11`), Shoonya `userId`/`passwd`/`vendorCode`/`secretCode` + PAN-derived OTP hash (`src/prism/RestAPI.ts:24-30`). Contrast with the *unused* `src/broker/AntBroker.ts:35-38` scaffold, which correctly reads from `process.env` — the live code does the opposite of the abandoned draft.

### Gaps & Missing Features {#gaps--missing-features-2}

- **Per-user broker configurability — the mechanism is real and per-user, but unreachable from any UI/API, so every user is hardcoded to Zerodha in practice.** `bookkeeping.getUserBroker(user)` (`bookkeeping.ts:93-95`) reads a `broker?: 'zerodha'|'ant'` field (`:29`) from `userSettingsCache`; `orderProcess.ts`'s `buyIndex`/`squareOff`/`manualBuy` (`:63-95,193-205`) and the drawdown-breach auto-squareoff (`:346-356`) all branch on it correctly. But `broker` is only ever populated once at startup by `loadUserLimits()` (`orderProcess.ts:311-324`) from `cfg.broker`/`mongoUser.broker` — and **neither field has any writer anywhere**: zero hits for `broker` in `user.ts`/`ConfigService.ts`, `POST /users/:email/settings` (`server.ts:205-227`) doesn't accept/forward it, and no frontend file references `broker` at all. An IPC path (`case 'updateUserSettings'`, `orderProcess.ts:228-231`) *could* set it at runtime, but nothing calls it with a `broker` value. ANT execution is reachable today only via separate hardcoded `antBuyIndex`/`antManualBuy`/`antSquareOff` IPC request types (`orderProcess.ts:97-128`) — a call-site choice made by which frontend endpoint is hit, not a persisted per-user setting. Prism/Shoonya is a fully independent legacy path, not part of this switch at all.
- **`src/ant/AntStream.ts` has no reconnect logic at all**, unlike its near-identical siblings. `ws.on('close', ...)` (`AntStream.ts:89-92`) only logs and sets `connected = false` — no `scheduleReconnect`/backoff anywhere in the file. Compare `AntDataStream.ts:84-99` and `AntOrderNotifyStream.ts:132-143`, both of which implement exponential backoff correctly in this same codebase. `AntStream` backs the legacy `monitor.ts`/`prism.ts` path, which is still wired into live `server.ts` routes, so this is a live reliability gap, not dead code.
- **Non-bracket ANT square-off does not resolve the real fill price.** `antExecutor.ts:287-320` (`squareOffOnAnt`), plain-SELL branch (`:295-303`): the code's own comment (`:312-316`) says fill-price polling "left as the entry price for now"; `trade.price` is set to the last-seen tick price or original entry price (`:316`), not the actual sell fill — misstating realized P&L for every non-bracket ANT exit.
- **Contract-master staleness has no automated check or refresh.** `AntContractMaster.ts:46-60` and `ZerodhaContractMaster.ts:39-77` load static files once per process lifetime with no TTL/mtime check; only expired-contract filtering exists (`AntContractMaster.ts:142-151`, `ZerodhaContractMaster.ts:136-141`), not staleness-of-file detection. A stale master just silently fails lookups with no distinguishing signal.
- **`pendingLimitOrders.ts`/`exitMonitor.ts` in-memory state doesn't survive a restart** (acknowledged in-code, `pendingLimitOrders.ts:6-12`) — a pending limit order or active target/SL watch is silently dropped from tracking with no startup reconciliation against live broker state.

### Minor Issues {#minor-issues-2}

- `RestAPI.ts`'s global axios interceptor only handles `response.status === 200` (`:76-82`) — any other 2xx falls through to an implicit `undefined` return.
- `get_time_price_series`, `get_holdings`, `get_limits`, `exit_order` in `RestAPI.ts` all reference undefined `this.username`/`this.accountid` fields (never declared on the class) — dead/never-exercised paths that would send `uid: undefined` if ever called.
- `src/broker/AntBroker.ts` (dead scaffold) imports the bare global `axios` instead of its own instance — a trap for whoever revives it.
- `ZerodhaContractMaster`'s CSV parser is a naive `split(',')` (`:47-74`) with no RFC-4180 quoted-field handling beyond the `name` column.
- `AntWebSocket.ts`'s 3s heartbeat (`:29-35`) has no dead-connection detection beyond `ws`'s own close event — a half-open TCP connection could leave `AntStream` believing it's connected indefinitely.

### Notes {#notes-2}

- `src/broker/{Broker,AntBroker,ShoonyaBroker,ZerodhaBroker}.ts` are entirely dead code — zero importers found anywhere in `src`.
- `AntOrderNotifyStream.ts`'s `brokerOrderId`/heartbeat/`flprc` items are already tracked in `ToDo.md` and not re-reported; its reconnect/backoff logic was reviewed and found correct.
- `prismExecutor.ts` is the outlier among the three executors for error-handling: because `_placeOrderWithForce` swallows its own exceptions, Prism-path errors frequently never reach `orderProcess.ts`'s top-level catch (`:305-308`) at all — they're absorbed lower down and reported as success (see Critical #1).
- No cross-strategy/cross-user race found in `bookkeeping.ts`'s core trade-mutation logic — the read-modify-write in `_processTradeEvent` (`:371-448`) is synchronous with no `await` in between, so Node's run-to-completion semantics prevent interleaving.

---

## 3. Strategy & Decision Logic

*Scope: all of `src/strategy/*.ts`, `src/decision.ts`, `src/processes/strategiesProcess.ts`, `src/scheduler/*.ts`, `src/orchestrator.ts`.*

Live pipeline (confirmed from code): `npm run processes` runs `orchestrator.ts`, spawning
`dataProcess` (ticks), `orderProcess` (IPC order/risk), `server.js`, and `strategiesProcess.js`.
`strategiesProcess.ts`'s `onTick()` (`:40-57`) is the **only** live entry point into strategy
code. `strategy.receive(oldStats, newStats)` is never called from this path. Only strategy types
present in `config.yml`'s `strategies:` list are ever instantiated — being registered in
`StrategyFactory.ts` is necessary but not sufficient to run live.

### Strategy Wiring Status {#strategy-wiring-status}

| Strategy | Registered? | Invoked in live pipeline? | Evidence |
|---|---|---|---|
| BuySellStrategy | Yes (`StrategyFactory.ts:23`) | Yes — `config.yml:42-53` (currently `enabled: false`) | `BuySellStrategy.ts:242-293` |
| SentimentStrategy | Yes (`:24`) | Yes — `config.yml:35-41` | `SentimentStrategy.ts:200-229` |
| IntermittentStrategy | Yes (`:25`) | Partially — config-driven instance's `processNiftyQuote` is a no-op; only dynamically-spawned instances trade | `IntermittentStrategy.ts:150-152`; spawn sites `BuySellStrategy.ts:157-161`, `IntermittentStrategy.ts:88-90` |
| BiDirectionStrategy | Yes (`:26`) | **No** — no config entry; gated on dead `receive()` besides | `config.yml:34-138`; `BiDirectionStrategy.ts:226-232,349-350` |
| DiffStrategy | Yes (`:27`) | **No** — same dead-path issue | `DiffStrategy.ts:44-48,112-113` |
| PivotStrategy | Yes (`:28`) | **No** — same dead-path issue | `PivotStrategy.ts:28-39` |
| HighLotStrategy | Yes (`:29`) | **No** — would be dangerous if wired, see Critical Bugs | `HighLotStrategy.ts:107-118,162-177` |
| Minutes5Decision | Yes (`:30`) | **No** — all logic lives in dead `receive()`. Confirms prior known finding. | `Minutes5Decision.ts:50-55,93` |
| TestStrategy | Yes (`:31`) | **No** — intentional stub | `TestStrategy.ts:32-38` |
| RateOfChangeStrategy | Yes (`:32`) | Yes — `config.yml:71-80` | `RateOfChangeStrategy.ts:127-167` |
| GapStrategy | Yes (`:33`) | Yes — `config.yml:81-91` | `GapStrategy.ts:118-161` |
| RuleBasedStrategy | Yes (`:34`) | Partially — position management live-wired; entry logic dead. Confirms & sharpens prior known finding. | `RuleBasedStrategy.ts:144-176,253` |
| GoodMorningStrategy | Yes (`:35`) | Yes — `config.yml:101-110`, has daily reset | `GoodMorningStrategy.ts:153-216` |
| GoodMorningSensexStrategy | Yes (`:36`) | Yes — `config.yml:111-119` | `GoodMorningSensexStrategy.ts:125-188` |
| SupportResistanceStrategy | Yes (`:37`) | Yes — `config.yml:120-127` (see config-default footgun below) | `SupportResistanceStrategy.ts:31-46` |
| TargetReachStrategy | Yes (`:38`) | Yes — `config.yml:128-138` | `TargetReachStrategy.ts:38-54,73-83` |
| ContinuousStrategy | Yes (`:39`) | Yes — live-wired, but enable/disable toggle broken (see Critical Bugs) | `ContinuousStrategy.ts:84-87,203-210` |
| ORBPrevious | **No** — absent from `STRATEGY_REGISTRY` | No | `StrategyFactory.ts:22-39`; `ORBPrevious.ts:14-22` (all methods throw "not implemented") |

`config.yml`'s every configured strategy currently has `enabled: false` — a snapshot of intent,
not a bug, but nothing in this scope is trading live as of this audit.

**`receive()`/`decision.ts` is structurally dead in the live pipeline.** `strategy.receive()` is
called from exactly one place: `decision.ts:391-396`, inside a `'stats'` handler that returns
immediately if `replayMode` is true. `Decision` is instantiated exactly once in the live process
tree, at `server.ts:1335` inside `GET /replay`, which sets `replayMode = true` on the same line
that creates it (`server.ts:1336`) — so the guard always short-circuits. `strategiesProcess.ts`'s
live `onTick()` never touches `Decision`/`receive()` at all. Net effect: `receive()` is
unreachable under any circumstance today, not just rarely triggered — which is the exact
mechanism behind the previously-known "RuleBasedStrategy/Minutes5Decision are inert" finding, and
also silently neuters BiDirectionStrategy/DiffStrategy/PivotStrategy/HighLotStrategy's
`this.stats`-gated paths if any of them are ever added to config.

**`src/scheduler/*.ts` is entirely legacy/orphaned** — not imported by any live process. Dated
2020 (hardcoded `expiryDate = '26-Mar-2020'`, `scheduler.ts:70`), most cron jobs commented out
(`:159-215`), hardcoded NIFTY strike tables in the 7750–8750 range (~3x below current levels),
and `processor.ts:336` reads an absolute path specific to a different machine. There is no live
scheduler anywhere in this codebase.

### Critical Bugs {#critical-bugs-3}

1. **`ContinuousStrategy`'s admin enable/disable toggle is a no-op.** Constructor unconditionally sets `this.enabled = true` (`ContinuousStrategy.ts:84-87`), ignoring `config.yml`'s `enabled` field; `processNiftyQuote` instead gates on a fresh `configService.getStrategyConfig()` read (`:205-206`). The dispatch loop (`strategiesProcess.ts:46`) and the admin `setEnabled` IPC command (`strategiesProcess.ts:73-84`) both operate on `this.enabled`, which is permanently `true` — the runtime enable/disable API has zero effect for this strategy; only editing `config.yml` directly works. Every other modern strategy correctly gates on `this.enabled`.
2. **`BuySellStrategy` uses module-level (not instance-level) mutable state for order-in-flight tracking.** `let buyOrderPlaced = false; let sellOrderPlaced = false;` at module scope (`BuySellStrategy.ts:14-15`), mutated/read by every `Contract` instance (`:93-95,132-165,177-200`). Two configured instances (different `userId`s, which the factory supports) would silently share the same flags, corrupting each other's order state — conflicts with the platform's per-user P&L isolation.
3. **`HighLotStrategy`'s volatility gate defaults to always-true.** `isStdDeviationInRange()` (`:162-177`) initializes `trigger = true`, only overwrites inside `if (this.stats)`, which never runs since `this.stats` is only set via the dead `receive()` path. If ever added to config expecting it to wait for low volatility, it fires unconditionally on the first qualifying tick instead.
4. **`HighLotStrategy.updateTrade` copy-paste bug: re-buying CALL initializes `putOrder` instead of `callOrder`** (`:203-208`) — `callOrder` never becomes `.active`, so the branch re-triggers indefinitely, repeatedly buying CALLs and clobbering `putOrder`'s state.
5. **`HighLotStrategy`'s contra-order condition is unreachable** — `diff <= -contraThreshold && diff > stopLossThreshold` (`:66`, with `contraThreshold=4`, `stopLossThreshold=20`) requires `diff <= -4 AND diff > 20` simultaneously, which no number satisfies.
6. **`BiDirectionStrategy.canHandleOptionQuote` resets a correct CALL match back to `false`** (`:234-247`) — an `else` branch fires whenever the CALL side already matched (since `this.put.canHandleOptionQuote` is a truthy method reference), forcibly resetting `handled`. CALL-side option ticks can never pass this check, so the CALL leg would be bought but never managed.
7. **`BiDirectionStrategy`'s SELL-side trade handler never reports the position closed, and blindly re-buys the same contract.** `tradeClosed` (`:160`) is declared `false` and never set `true` (`:184-196`) — the fresh-strike re-entry path (`:409-429`) never runs; instead the SELL branch re-buys the exact same contract regardless of price movement. The author's own comment flags this: `// Fix: Trade will never be closed, hence needs to monitor` (`:190`).
8. **`IntermittentStrategy`'s re-buy sell-target uses the wrong config field.** `Contract.updateTrade` (`:105`) assigns `configService.getStrategyConfig('IntermittentStrategy').loopCount` to a variable named `targetPrice`, used for the re-buy sell target (`:120,129`) — the real target field is never read.
9. **`BuySellStrategy`'s "iteration" increment mode is dead due to variable shadowing.** The `"iteration"` branch (`:140-147`) declares a new block-scoped `quantity` that shadows and discards the outer one used for the actual buy — `incrementFactor: iteration` behaves identically to `single`.
10. **`GapStrategy` self-disables for the rest of forever, not just the day.** `processNiftyQuote` sets `this.enabled = false` (`:151`) after its one decision, with no `resetIfNewDay()` equivalent (contrast `GoodMorningStrategy`/`GoodMorningSensexStrategy`, which have one). Since no scheduler resets state at day rollover, it trades once ever, then never again until a manual admin call or process restart.

### Gaps & Missing Features {#gaps--missing-features-3}

- **`SupportResistanceStrategy` has no rate limiting and a dangerous zero-value config default.** `processNiftyQuote` (`:31-46`) evaluates `ltp < supportPrice`/`ltp > resistancePrice` on every tick with no cooldown/latch; `config.yml:120-127`'s current defaults (`supportPrice: 0`, `resistancePrice: 0`) mean enabling it as-shipped would call `buyIndex` on every single tick, relying entirely on the order process's duplicate-position check as a safety net.
- Per-type config lookup (`ConfigService.getStrategyConfig(type)`, `:47-50`) is keyed purely by `type`, returning the first match — can't support two differently-tuned instances of the same strategy type for most strategies (RuleBasedStrategy works around this via its own lookup; nine other config-driven strategies don't).
- No shared/base-class daily-reset mechanism — only the admin-triggered `'reset'` IPC exists; each "once per day" strategy has to reinvent `tradingDay` bookkeeping correctly (`GapStrategy`, above, didn't).
- `IntermittentStrategy`'s dynamically-spawned instances default to `enabled = false` (inherited from base `Strategy`) despite actively trading via `Contract` methods that don't check `.enabled` — misleading in any admin UI/stats surface driven by that flag.
- `IntermittentStrategy`/`BuySellStrategy` spawn child `IntermittentStrategy` instances regardless of `IntermittentStrategy`'s own `enabled` config — disabling it in config stops it managing existing positions but not `BuySellStrategy` from opening new ones through the same class.
- Legacy strategies (`BiDirectionStrategy`, `HighLotStrategy`, `Minutes5Decision`) hardcode thresholds as module-level consts with zero `configService` involvement, unlike every modern strategy — would need a rewrite, not a config toggle, to become admin-configurable.

### Minor Issues {#minor-issues-3}

- `PivotStrategy.processNiftyQuote` checks `this.stats.S1 != -1` (`:39`) — the real path is `this.stats.results.pivot.S1`, so this guard is always a no-op (moot since the strategy is unreachable anyway).
- `ORBPrevious.ts` is a pure scaffold (all methods throw "not implemented") — harmless since unregistered, but a landmine if registered without finishing it.
- Dead `selenium-webdriver` `TouchSequence` imports in `Minutes5Decision.ts:9`, `BuySellStrategy.ts:9`, `SentimentStrategy.ts:8`, `IntermittentStrategy.ts:8`, `BiDirectionStrategy.ts:8`, `DiffStrategy.ts` — copy-pasted boilerplate.
- `SentimentStrategy`'s averaging-down path has no iteration/quantity cap unlike `BuySellStrategy`'s `maxIterationCount` — can average down indefinitely on a sustained adverse move.
- `ContinuousStrategy.ts:80` documents a real production incident (2026-08-25, 4 concurrent spawns landed on the same contract) that `opLock` serialization was added to fix — the fix covers spawn paths but target-hit/5x-square-off leg deletion (`:272-273,314-315`) happens outside `withOpLock`; worth an explicit test for a race between a target-hit and an in-flight spawn against `capitalCheck`'s unlocked `legsByToken` sum (`:150-158`).

### Notes {#notes-3}

- `orchestrator.ts`/`strategiesProcess.ts` themselves look solid — no unbounded-buffer/backpressure issues, well-commented restart-without-cross-kill design.
- No off-by-one/divide-by-zero found in `decision.ts`'s indicator math, but since the whole file is unreachable live, bugs there only matter for the `/replay` backtest endpoint.

---

## 4. Data Model, P&L & Payout

*Scope: `src/monitor.ts`, `src/payout.ts`, `src/tax.ts`, `src/processes/order/bookkeeping.ts`, `src/model/CanonicalSymbol.ts`, `src/model/model.ts`, `src/model.ts`, `src/trade/*`, `src/tools/mongo.ts`.*

### Critical Bugs {#critical-bugs-4}

1. **`computePayout` can produce a "pending" payout with negative net amount for a losing period.** `src/payout.ts:73-169`. `grossProfit` is never checked `<= 0` except as a side-effect of the drawdown-forfeiture block (`:127-148`, which only fires if `investmentAmount > 0` and the loss breaches 25%/50% thresholds). A user with no `investmentAmount` set (e.g. a strategy pseudo-user) or a small net loss sails through with `blocked=false`; `splitAmount` (`:75`) goes negative and propagates through `computeTax` (`tax.ts:15-23`) into a `status: 'pending'` record with negative `netAmount`. Nothing re-validates sign before an admin can mark it `paid` (`markPayoutDecision`, `payout.ts:236-244`). **Fix: block/clamp whenever `grossProfit <= 0`, independent of the drawdown check.**
2. **No idempotency/dedup on trade fills → double-booked realized P&L and payouts.** `bookkeeping.ts:343-346` (`recordFill`), `:349-369`, `:371-448` (`_processTradeEvent`). Every executor calls `recordFill(trade)` directly (`antExecutor.ts:104,318`; `prismExecutor.ts:69,109`; `zerodhaExecutor.ts:58,248,276,306,422`; `pendingLimitOrders.ts:53`) with no fill/order-id tracked for dedup. A redelivered fill event (reconnect replay, webhook retry) re-runs the sell branch, double-subtracts `sellQty` and double-`persistClosedTrade`s (`:455-470`) — double-counting both in-memory `userPnL` and the Mongo `closedTrades` collection that `payout.ts:70-73`'s `grossProfit` sums directly. A duplicated fill directly inflates a payout.
3. **The payout "consistency rule" can mathematically exceed 100% and over-block legitimate payouts whenever the period has any losing day.** `payout.ts:100-119`: `worstPercent = (best day's pnl) / grossProfit * 100`. With a strong winning day and any losing day, `grossProfit` (net of the loss) is smaller than the single best day, so `worstPercent` routinely exceeds 100% (e.g. +₹10,000 day / −₹6,000 day → grossProfit ₹4,000 → 250%). Any `consistencyLimitPercent` under 100 will then block almost every period with one great day offset by a loss — a much higher false-positive rate than the rule's apparent intent ("one day carried the whole payout").
4. **`monitor.ts`'s sell branch mishandles partial fills.** `src/monitor.ts:437-465`, specifically `:445`: `realizedPnL = (tradeEvent.price - buyTrade.price) * buyTrade.quantity` uses the *whole open quantity*, not the quantity actually sold in this fill, then unconditionally `splice`s the whole position out of tracking (`:455`) regardless of whether the sell was partial. Contrast the live path, `bookkeeping.ts:408-440`, which correctly reduces against `sellQty` and only removes the trade once `buyTrade.quantity <= 0`. `monitor.ts`'s class/methods (`Monitor.getInstance()`, `_processTradeEvent`, `updateTrade`) are still fully wired live code, just off the current order-execution path — this is exactly the monitor.ts/bookkeeping.ts drift risk the task asked to check for.
5. **`monitor.ts` conflates unrealized (mark-to-market) P&L with the `realizedPnL` field on still-open trades.** `src/monitor.ts:343` sets `matchingTrade.realizedPnL = (lastTradePrice - price) * quantity` on every tick for an *open* trade, only overwritten with the true realized value on close (`:447`). Any consumer reading `Monitor.trades[i].realizedPnL` on an open position would treat unrealized P&L as realized. Not on the live bookkeeping.ts path today, but a live landmine in monitor.ts.

### Gaps & Missing Features {#gaps--missing-features-4}

- **No brokerage/fee deduction anywhere in the realized-P&L pipeline** — `bookkeeping.ts:414` and `monitor.ts:445` both compute pure price-delta P&L; `payout.ts` sums this unadjusted value as `grossProfit`. Payouts and displayed session P&L are systematically overstated relative to actual account P&L.
- **`/users`' `sessionPnL` resets to 0 on every `order` process restart and never resyncs with Mongo.** `server.ts:126,130` → `orderProcess.ts:189` → `bookkeeping.userPnL` (`:38`), populated only by the sell branch (`:415-416`) and never rehydrated from `closedTrades` on start — contrast `getRealizedPnLSince` (`:173-183`), which correctly recomputes from Mongo for drawdown checks. **This is the residual issue behind the previously-known "/users P&L enrichment gap" — the enrichment itself is now confirmed fixed (§1 Notes); what remains is this narrower staleness-on-restart problem.**
- **No overlap/duplicate protection on payout periods.** `createPayoutRecord` (`payout.ts:180-234`) and the Mongo layer have no unique index or overlap check on `(user, periodStart, periodEnd)`, and closed trades aren't tagged with the payout they were paid under — two `POST /admin/payouts` calls with overlapping periods for the same user can double-pay the same profit.
- **`monitor.ts` vs `bookkeeping.ts`: fully duplicated bookkeeping logic with no shared source of truth** — `bookkeeping.ts`'s header (`:9-16`) acknowledges it was "ported from monitor.ts" but the two have since diverged (Critical #4/#5) with nothing preventing further drift.
- **Short/write positions are silently dropped from P&L tracking** — `bookkeeping.ts:392-446`'s non-Buy branch only acts if a matching open `buyTrade` exists; a Sell with no prior tracked Buy is inserted into raw Mongo but never enters `closedTrades`/`userPnL`/payout calculation. Not enforced or documented as a long-only assumption.

### Minor Issues {#minor-issues-4}

- `payout.ts:107`: `worstDay`/`worstPnL` naming reads backwards next to the over-blocking bug in Critical #3.
- `bookkeeping.ts:409-411`: when a broker-reported sell exceeds locally tracked open quantity, the excess is silently clamped and dropped (only a WARNING log) — the dropped proceeds are never reflected in P&L, i.e. can under-count on desync.
- `bookkeeping.ts:374` and `monitor.ts:397,472`: `Mongo.getInstance()?.insert(...)` called without `await` inside `try/catch` — since `insert()` is async, a rejection surfaces as an unhandled promise rejection, not a caught error.
- `mongo.ts:33-44` pre-creates a collection literally named `'trade'` (lowercase), but writes actually go to `'Trade'` (capital, from the class name) — the pre-created collection is dead; the real one is implicitly auto-created with no schema.
- `model/model.ts:159-161` (`Trade.getProfit()`) also computes an unrealized-style value under the generic name "profit" — same naming-clarity issue as Critical #5, in the shared model.
- `payout.ts:200`: `accountNumberMasked` has no lower-bound guard beyond `Math.max(0, ...)` — sub-4-char account numbers print more than intended.

### Dead Code Candidates {#dead-code-candidates-4}

- **`src/model.ts` (top-level, 18 lines) — fully dead and self-corrupting if revived.** Zero importers found (`grep -rn "from ['\"].*[^/]model['\"]" src/` → nothing; every `OptionQuote` consumer imports from `src/model/model.ts` instead). Also actively wrong: `model.ts:16` unconditionally sets `this.ltp = 225` after copying the real quote price, clobbering it with a hardcoded test value.
- **`src/trade/strategy/bollinger_band.js` — fully dead**, zero importers.
- **`src/trade/{icici,option,option-plus,icicinse}.ts`, `src/trade/strategy/strategy.ts` — unreachable from the live server.** Reachable only through a legacy `npm start` (`src/index.ts`) cluster (`functions.ts`, root `browser.ts`, `multiple_browsers.ts`, `server_old.ts`, `breeze.ts`, `onTrigger.ts`, `candle.ts`, `scheduler/*`), none of which `server.ts`/`orchestrator.ts` import.
- **`src/trade/browser.ts` — still loaded at boot, but functionally unreachable.** Imported live by `prism.ts:14` and `decision.ts:16` (both transitively required by `server.ts`); unused in `decision.ts`, and in `prism.ts` used only inside `getOtp()` (`:276-280`, old QuickAuth OTP scraping), which itself has zero callers anywhere (QuickAuth is confirmed dead per prior session memory, OAuth is now automated). Its Selenium imports still get evaluated on every server boot despite this.

### Notes {#notes-4}

- `Mongo` (`tools/mongo.ts`) has zero `createIndex` calls on any trade/payout/user collection — `payout.ts:70-72`'s and `bookkeeping.ts:177,218`'s per-user/per-day queries are full collection scans as data grows, and there's no database-level backstop against the duplicate-payout gap above.
- `Mongo.insert()` routes by `obj.constructor.name` — an implicit, undocumented contract; currently safe since every call site passes a real class instance, but a plain object literal would land in a collection literally named `"Object"`.
- No GridFS/Mongo transactions anywhere in scope — payout creation + notification write, and fill-processing + closedTrades-persist, are each sequences of independent un-transacted writes, consistent with the dedup gap in Critical #2.
- CLAUDE.md says Prism's home is `src/prism/`; in practice the live `Prism` class is the top-level `src/prism.ts` (45KB), with `src/prism/` holding only supporting files — a documentation fix, and the same top-level-file-vs-subdirectory shape recurs with `src/model.ts` vs `src/model/model.ts`.

---

## 5. Frontend & UX

*Scope: `frontend/src/**`, legacy `public/*.html`.*

### Lead finding (explicit ask): Admin trade date filtering — what exists today, and proposed fix

**What exists today** in `AdminPage.tsx`'s "Trades" tab (lines 1255–1354):
- A single "User" `<Form.Select>` (line 1263) that picks exactly one user or strategy — **no "All Users" option**.
- Two plain `<Form.Control type="date">` inputs, "Closed From"/"Closed To" (lines 1274–1285), both starting **empty** with no presets and no default range.
- The date range applies **only to Closed Trades** — the "Open Positions" table (lines 1296–1320) has zero date filtering.
- Filtering requires a manual "Load" click (lines 1286–1290) — not automatic.
- No label restating the currently-displayed range once loaded.
- Because a single user/strategy is required first (lines 94–97), **there is no way to review trades across all users for a given day/month in one view** — directly at odds with a prop-trading admin's core reconciliation workflow.

**Proposed concrete UX** (replacing/augmenting lines 1274–1285):
1. A segmented control with three modes — **This Day | This Month | Custom** — This Day/This Month auto-set `from=to` and auto-load; Custom reveals the existing pickers.
2. Auto-fetch (debounced) on mode/date change instead of requiring "Load".
3. Extend the same date range to the Open Positions query too, or explicitly label it as always-live if that's intentional.
4. Add an **"All Users"** option to the selector so an admin can pull one day's/month's trades across everyone for reconciliation.
5. Reflect the mode/range/user in the URL query string for bookmarkable/shareable audit views.
6. Show the resolved range as a label above results (e.g. "Showing Aug 1–25, 2026").

The same gap pattern (bare date inputs, no presets, manual click) also exists in the Payments
tab's "Compute Payout" period pickers (lines 1147–1158) — a secondary instance worth the same
treatment for consistency.

### Critical UX Bugs {#critical-ux-bugs-5}

- **`TradingContext.squareOff` (lines 184–193) has no `response.ok` check and no user-facing error path** — only `console.error` on failure. A failed square-off (real money, open position) fails silently; the position appears unchanged with no explanation. `placeOrder`/`placeContractOrder` in the same file do surface errors — `squareOff` is the odd one out for the higher-stakes action.
- **`PositionCard`'s "Square Off" button (lines 68–73) fires immediately with no confirmation dialog**, unlike `AdminPage.tsx`'s `handleDeleteUser` which uses `confirm()`. Closing a live options position is irreversible and real-money.
- **`NotificationBell`'s SSE connection (lines 28–35) has no `onerror` handler and no reconnect logic**, unlike `NiftyTicker.tsx` (reconnects up to 3x) and `TradingContext.tsx` (backoff, up to 3x). A dropped stream silently stops the bell for the rest of the session — including for `drawdown_breach`, its most safety-critical notification type.
- **`public/config.html` + backend `/config` have no authentication whatsoever** (also flagged in §1 Critical #6) — `public/config.html` is served statically with no auth middleware ahead of it (`server.ts:56`). Anyone who guesses `/config.html` can view and overwrite the entire live strategy configuration, fully bypassing the React app's `RequireAdmin` gate (`App.tsx:22-27,48-55`).

### Gaps & Missing Features {#gaps--missing-features-5}

- No CSV/export anywhere in AdminPage (Users, Payouts, Open/Closed Trades tables) — needed for back-office reconciliation/compliance.
- No pagination or row limit on any admin table (Users, Closed Trades, All Payouts) — will degrade as data grows.
- No search/sort on the 16-column Users table.
- `OrderEntry.tsx` symbol search requires 4+ characters (line 52) with no hint text or loading indicator.
- `RulesPage.tsx` "Accept & Continue" (lines 42–48) performs **no API call at all** — plain `navigate()`. Rule acceptance is never persisted or logged server-side (confirmed via repo-wide grep for `rulesAccepted`/`acceptRules`) — no audit trail despite framing this as a compliance gate.
- `PositionCard.tsx`: once a target/SL is set, it's shown read-only with no way to edit/clear afterward.
- AdminPage Payments tab's "All Payouts" filter is status-only — no user or date-range filter.

### Minor Issues {#minor-issues-5}

- `ProfilePage.tsx:665`: `<>...</>` Fragment used as a list item can't take the `key` prop that's actually placed on the inner `<tr>` — React "missing key" warning.
- `AdminPage.tsx:14-19`: `stickyActionsStyle` hardcodes `background: '#fff'` inline rather than a CSS class — brittle if theming is ever added.
- Three SSE components each hand-roll independent connect/reconnect logic, with `NotificationBell` diverging (see Critical Bugs) — no shared hook.
- `OrderEntry.tsx` suggestion dropdown caps at 10 matches with no "N more" indicator or match highlighting.
- AdminPage's "Strategy Configuration" tab is one long scroll of 12 Cards with no anchor nav/search.
- Currency formatting is inconsistent: `AdminPage.tsx` uses `&#8377;` HTML entity, `ProfilePage.tsx` mixes the literal `₹` character.
- `handleDeleteUser` uses native `confirm()`/`alert()`, inconsistent with the rest of the Bootstrap-Alert-driven UI.

### Polish & Professionalism Recommendations {#polish--professionalism-recommendations-5}

- Stark split in visual investment: the login/marketing funnel is highly polished (~290 lines of custom CSS), while every authenticated page (`TradingPage`, `AdminPage`, `ProfilePage`) runs on near-unstyled Bootstrap defaults (~35 lines of custom CSS total outside the funnel) — reads as two different builds glued together.
- "Use GTT" badge colors (`bg-secondary`/`bg-info`) don't intuitively signal an operational broker-execution-mode toggle — worth a more deliberate color pair.
- Couldn't confirm `frontend/index.html`'s favicon/branding (outside reviewed scope) — worth checking it carries the "PropFirm" branding used elsewhere.
- Admin Users table (16 columns) relies solely on horizontal scroll for small screens — no column prioritization/collapsing.

### Notes {#notes-5}

**Legacy `public/*.html` — verdict: retire, with one exception needing an auth fix first.**
- `monitor.html`, `data.html`, `time.html`, `index.html` are **fully dead** — each opens an `EventSource` against an endpoint (`/statusstream`, `/datastream`, `/timestream`, `/events`) that no longer exists in `server.ts`. Safe to delete.
- `test.html` is a static demo with hardcoded sample JSON, no live connection. Safe to delete.
- `prism.html` posts to a literal `https://example.com/api/endpoint` placeholder, never wired to the real backend. Safe to delete.
- `config.html` is the **one page that still works** (hits the live `/config` route) and isn't fully redundant with `AdminPage.tsx`'s Strategy Configuration tab — it edits the entire config blob as freeform YAML, exposing keys the React tab hasn't been given fields for. But as covered in Critical Bugs, it's a live, unauthenticated back door. Recommend either deleting it (porting any config keys it exposes that the React tab lacks) or gating both the static file and the `/config` route behind the same admin session check as the React app.
- None of the six legacy pages are linked from anywhere in the React app — reachable only by typing the URL directly.

---

## 6. Test Harness & API Contract

*Scope: whole repo, plus `API.md`.*

### Current State

**Backend:** `"test": "jest"` (`package.json:14`) and `"test:watch"` (`:15`) exist, but there is
no `jest.config.js`/`jest` key anywhere — `npm test` today would fall through to Jest's
zero-config defaults against TypeScript with no `ts-jest`/`babel-jest`, and wouldn't compile
`.ts` sources correctly. `jest@^24.9.0` and `supertest@^4.0.2` sit unused in `devDependencies`
(`:110-111`) — old (Jest 24 is from 2019) but present, suggesting an abandoned prior attempt.
Zero `*.test.ts`/`*.spec.ts` files exist anywhere (confirmed via repo-wide `find`, excluding
`node_modules`) — `src/test/` holds only manual CLI backtest scripts (`strategyTest.ts`,
`continuousStrategyTest.ts`), not Jest specs. No CI config exists (`.github/workflows`, etc.).

**Frontend:** no `test` script, no test dependency of any kind (no vitest/jest/RTL/jsdom), no
config, no test files — a bigger gap than the backend, which at least has stale deps in place.

**`API.md` is materially stale:** it documents ~40 endpoints, but `server.ts` actually registers
**82** (`grep -n "app\.\(get\|post\|patch\|delete\|put\)("`). Entire undocumented subsystems:
payouts (`/users/:email/payouts*`, `/admin/payouts*` — `server.ts:456,467,478,488,502,516,530`),
KYC detail fields (`/kyc-numbers`, `/bank-details`, `/entity-type`, `/company-profile` —
`:246,264,277,293`), notifications (`/users/:email/notifications*` — `:1120,1134`), admin trade
filters (`/admin/trades/closed`, `/admin/trades/open` — `:999,1021`), and a parallel ANT-broker
order path (`/ant/order/*` — `:852,873,885`) alongside the documented Prism one. Any test-harness
or integration work should treat `server.ts` as the source of truth, not `API.md`.

### Recommended Stack

**Backend — Jest + ts-jest + supertest.** Jest is already the declared runner and `supertest`
already a dependency — least-friction path is finishing what's half-present. Upgrade Jest 24→29,
add `ts-jest`+`@types/jest` (recommended over `babel-jest` specifically because this is a
money-handling codebase where catching type errors in test fixtures has real value). Use
`supertest` against the in-process Express app (not a bound port, since the server dials real
broker WebSocket/SSE connections on startup that must be mocked, not live-dialed). Use
`mongodb-memory-server` for Mongo-backed integration tests rather than hand-rolled driver mocks —
gives realistic query behavior the repo's index-free queries actually need to be tested against.
Reuse the repo's existing `MOCK_BROKER=true`/`config.mock.yml` seam (`package.json:11-12`) for
broker mocking rather than inventing a parallel strategy.

**Frontend — Vitest + React Testing Library.** Natural fit since the frontend already runs on
Vite 6 — shares the transform pipeline, dramatically faster than Jest for this stack. Add
`vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`,
`@testing-library/user-event`; add a `test` block to `vite.config.ts` or a sibling
`vitest.config.ts`. Reuse the existing `frontend/mock-server.js` (already run via `npm run mock`)
as the fixture backend before reaching for `msw`.

### Proposed Structure

Backend (colocated `*.test.ts`, one root config):
```
jest.config.js                                   # ts-jest preset, testMatch: **/*.test.ts
src/server.test.ts                               # supertest against the Express app directly
src/user.test.ts
src/payout.test.ts
src/monitor.test.ts
src/processes/order/bookkeeping.test.ts
src/processes/order/antExecutor.test.ts
src/processes/order/exitMonitor.test.ts
src/tools/__mocks__/mongo.ts                     # or wire mongodb-memory-server in jest setup
src/__tests__/fixtures/                          # shared User/Trade/Quote fixtures if needed
```
Explicitly exclude `src/test/` from `testMatch`/`testPathIgnorePatterns` — those are manual
backtest scripts, not specs, and Jest would otherwise try to execute them.

Frontend (colocated `*.test.tsx`):
```
frontend/vitest.config.ts                        # or a `test` block in vite.config.ts
frontend/src/test/setup.ts                        # jest-dom matchers, RTL cleanup
frontend/src/components/**/*.test.tsx             # colocated per component
```

### Priority Coverage List

Ranked by real-money blast radius:

1. **Order placement & risk gating** (`GET /prism/order/buy` `server.ts:801`, `GET /ant/order/buy` `:852`, and the constraint checks in `monitor.ts`/`bookkeeping.ts`). Highest priority — test loss-limit/lot-limit rejection, the 403 `ORDER_REJECTED` contract, and that an unresolvable user never silently defaults to the wrong account.
2. **Position exit / square-off** (`GET /prism/squareoff` `:822`, `GET /ant/order/squareoff` `:873`, `exitMonitor.ts`). Test idempotency (double square-off on an already-closed trade) and partial-quantity exits.
3. **P&L / `sessionPnL` calculation** feeding `GET /users` (`:119`) and loss-limit checks — if wrong, risk limits are silently defeated in either direction.
4. **Payout computation** (`payout.ts`, `POST /admin/payouts/compute` `:502`, `GET /users/:email/payouts` `:456`) and `tax.ts` — money actually leaving/recorded against a real account, and per the admin-payouts flow, manually reviewed with no payment-gateway integration, so a computation bug could sail past review.
5. **Auth/session flow** (`POST /auth/login` `:75`, `GET /auth/me` `:98`, `resolveUser()`'s cookie/header precedence) — every other endpoint's authorization depends on this; pin the cookie-vs-header precedence and the unauthenticated-default behavior explicitly.
6. **Admin trade filters** (`GET /admin/trades/closed` `:999`, `GET /admin/trades/open` `:1021`) — payout/compliance decisions get made from this data.
7. **Role/permission changes** (`PATCH /users/:email/role` `:181`) — privilege-escalation surface, easy to pin with a unit test.
8. **KYC document upload** (`POST`/`GET /users/:email/documents/:docType` `:380,424`) — 5MB limit, `docType` allowlist, cross-user document access.
9. **Frontend order-entry/position-close components** and whatever renders `sessionPnL`/loss-limit state — focus on behavior ("does the buy button disable on rejection," "does displayed P&L match the mock API"), not visual snapshots.
10. **Config endpoints** (`GET/POST /config` `:1315,1319`) — lower urgency but strategy thresholds read from here indirectly gate order triggers; basic round-trip/validation tests once 1–9 are covered.

### Notes

- Both `jest`/`supertest` versions are old enough that a version bump should happen while standing up the harness, not after.
- The `MOCK_BROKER=true` seam's exact scope (full network isolation vs. partial) needs a closer read of `src/prism/index.ts`/`src/ant/ANT.ts` before assuming supertest tests can run with zero real network access — flagged as a pre-flight check for whoever implements this.
- `src/test/`'s existing manual scripts create a naming-collision risk if a new test convention isn't clearly separated in `jest.config.js`.
- API.md's staleness is a separate backlog item (regenerate from `server.ts`), out of scope for the test-harness plan itself but noted here since it affects anyone writing contract tests.
- No test files, config, or CI exist anywhere today — this plan starts from zero, which for a real-money system is the single largest risk-reduction opportunity found in this whole audit.

---

## Cross-Cutting Dead Code Inventory

Consolidated from all domains, each with importer-search evidence in its source section:

| Path | Status | Evidence |
|---|---|---|
| `src/broker/{Broker,AntBroker,ShoonyaBroker,ZerodhaBroker}.ts` | Dead | [§2 Notes](#notes-2) |
| `src/model.ts` (top-level) | Dead, and self-corrupting if revived (hardcoded `ltp=225`) | [§4 Dead Code](#dead-code-candidates-4) |
| `src/trade/strategy/bollinger_band.js` | Dead | [§4 Dead Code](#dead-code-candidates-4) |
| `src/trade/{icici,option,option-plus,icicinse}.ts`, `src/trade/strategy/strategy.ts` | Unreachable from live server (legacy `npm start` cluster only) | [§4 Dead Code](#dead-code-candidates-4) |
| `src/trade/browser.ts` | Loaded at boot but functionally unreachable (only caller, `Prism.getOtp`, is itself dead) | [§4 Dead Code](#dead-code-candidates-4) |
| `src/scheduler/*.ts` | Entirely orphaned, 2020-era legacy | [§3](#strategy-wiring-status) |
| `public/{monitor,data,time,index,test,prism}.html` | Fully dead (endpoints no longer exist / never wired) | [§5 Notes](#notes-5) |
| `public/config.html` | Not dead, but a live unauthenticated back door — retire or gate | [§5 Critical UX Bugs](#critical-ux-bugs-5) |

---

## Addendum (2026-09-08): SupportResistance dynamic-detector grid search

*Not part of the original 2026-08-25 agent audit above — added after a follow-up session that
fixed and then tuned the S/R hypothesis-testing pipeline. Scope: `src/lib/supportResistance.ts`,
`src/test/supportResistanceBacktest.ts`, `src/tools/SupportResistanceHypothesisTest.ts`,
`src/tools/SupportResistanceGridSearch.ts` (new), `config.yml`'s `srHypothesis:` block.*

**Important distinction from §3 above:** this work is entirely separate from the live
`SupportResistanceStrategy` class flagged in [§3's Gaps](#gaps--missing-features-3) (the one with
the dangerous `supportPrice: 0`/`resistancePrice: 0` config default). That strategy still
compares `quote.ltp` against static config values and is unaffected by anything below — nothing
here is wired into live trading. This addendum concerns only the **analysis-only** dynamic
support/resistance detector (`initSRState()`/`processTick()` in `src/lib/supportResistance.ts`),
which locks a support/resistance range once price consolidates and detects confirmed breaches,
consumed by manual backtest/hypothesis tools, not by any live strategy.

### What changed

1. **Fixed `src/test/supportResistanceBacktest.ts`**, which previously drove the static-config
   `SupportResistanceStrategy` (a no-op with `supportPrice`/`resistancePrice` both `0`) and
   simulated P&L with `Math.random() > 0.5` — not a real test of anything. Rewrote it to run the
   real dynamic detector and a genuine target/stop-loss walk-forward simulation on each breach
   (CE on resistance breach, PE on support breach), mirroring the approach already used by
   `src/tools/SupportResistanceHypothesisTest.ts`. Cross-checked: both tools now produce
   identical trade counts/win rates for the same day and config (verified on Sep-01: 34
   trades/20 wins/14 losses/58.8% in both).
2. **Restored the `srHypothesis:` block to `config.yml`** (present in a prior git-synced copy,
   commit `e5498bf`, but missing from the live config — `SupportResistanceHypothesisTest.ts`
   would otherwise throw), so both analysis tools share one tuning surface.
3. **Added `src/tools/SupportResistanceGridSearch.ts`** — grid-searches
   `confirmWindowMin`/`maxJump`/`maxRangeWidth`/`buffer`/`breachBuffer`/`breachConfirmSec`
   (detection parameters) × `target`/`stopLoss` (simulation parameters) across all 7 available
   backup days (`/home/karthikeyan/work/data/backups/{Aug-19,Aug-20,Aug-28,Sep-01,Sep-02,Sep-03,Sep-04}`).
   Uses its own O(1)-amortized sliding-window reimplementation of the detector (monotonic
   min/max deques) instead of the library's O(window-length)-per-tick array spread/filter/map,
   since the latter is too slow to run thousands of times over ~650K total ticks. Self-validates
   against the real library output for the current config before trusting any sweep result — the
   script aborts if they don't match exactly.

### Grid search result

Swept 972 detection configs × 9 target/stopLoss pairs = 8,748 combos in ~25s. Original defaults
(`confirmWindowMin: 2, maxJump: 15, maxRangeWidth: 30, buffer: 10, breachBuffer: 0,
breachConfirmSec: 0, target: 10, stopLoss: 10`) produced 192 trades across all 7 days at ~48%
overall win rate and −4,000 net points — no real edge.

The best **robust** config found — defined as ≥60% aggregate win rate **and** ≥50% win rate on
*every individual day* (not just a good aggregate propped up by one lucky day) — was:

| Parameter | Old default | New (tuned) |
|---|---:|---:|
| `confirmWindowMin` | 2 | **3** |
| `maxJump` | 15 | 15 (unchanged) |
| `maxRangeWidth` | 30 | **25** |
| `buffer` | 10 | **8** |
| `breachBuffer` | 0 | **5** |
| `breachConfirmSec` | 0 | **15** |
| `target` | 10 | **8** |
| `stopLoss` | 10 | **15** |

Result: 79 trades, 78.5% win rate, +12,050 net points, verified consistent across all 7 days
(worst single day 71.4%, best 100%):

| day | trades | win rate |
|---|---:|---:|
| Aug-19 | 6 | 100.0% |
| Aug-20 | 2 | 100.0% |
| Aug-28 | 21 | 76.2% |
| Sep-01 | 16 | 81.3% |
| Sep-02 | 15 | 73.3% |
| Sep-03 | 12 | 75.0% |
| Sep-04 | 7 | 71.4% |

The key driver was adding a non-zero `breachBuffer` + `breachConfirmSec` (requiring price to
clear the locked line by 5pts and hold for 15s before confirming a breach) — this filters out
the noise-wick breaches that dominated the old zero/zero (immediate-confirm) config. Tightening
`maxRangeWidth` and lengthening `confirmWindowMin` also helped, by requiring a longer, narrower
consolidation before a range is allowed to lock.

Notably, no config was found that got trade count down to ~5/day while staying consistently
≥60% per day — the closest attempts had at least one day dip to 40% or 0% win rate. Selectivity
(fewer trades) and per-day consistency traded off against each other on this dataset; tightening
further concentrated risk into fewer, noisier per-day samples rather than uniformly improving
quality.

**Applied**: `config.yml`'s `srHypothesis:` block now uses the tuned values above (verified via a
live re-run of `supportResistanceBacktest.js`, which reproduced the exact 79-trade/78.5% numbers
end-to-end, not just via the sweep's fast reimplementation).

**Caveat — in-sample search, not yet out-of-sample validated:** all 8,748 combos were scored
against the same 7 days used to pick the winner, with no held-out data. 79 trades is a reasonably
sized sample, but searching this many combinations against one fixed dataset carries real
overfitting risk. Treat the tuned config as a strong hypothesis to re-validate as new days'
`Quote.csv` data is collected — not a proven edge yet. Full 8,748-row sweep output saved to
`supportresistance_grid_search_results.csv` (repo root) for later re-analysis.

---

*End of consolidated analysis. Six raw per-domain reports remain at `.analysis-work/*.md` pending
a decision on whether to delete that directory (this repo is not git-tracked, so there is no
low-cost "just don't commit it" fallback — ask before deleting).*
