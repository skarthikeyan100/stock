# Review 2 findings (2026-10-29): simplification pass

**Scope:** whole project, read-only. Nothing was compiled, run or changed. Each item has a suggested action and a status. Status is `OPEN` unless stated otherwise. Items marked `UNVERIFIED` are claims that still need a grep or a test before anyone acts on them.

**Areas (from the user's request):**
1. Duplicate functionality or code
2. Unnecessary complexity where a situation cannot occur
3. Impossible errors (checks that cannot fail, e.g. symbol-master file existence checked everywhere)
4. Restarts and reconcile
5. Stoploss and targets
6. Too many API endpoints
7. Strategies duplicated per broker

Status of this file: **part 1 of 3** (area 4 restarts/reconcile, area 2 validation, area 3 contract masters, area 1 orchestrator/IPC). Areas 5-7 and the API inventory (area 6) are pending their agents and will be appended below.

---

## Area 2 and 3: impossible errors and unnecessary validation

### R2-1 Broker session checks repeated on every call [high]
- `kite.hasValidSession()` does a `getProfile()` round trip, called 11 times in `src/processes/order/kiteExecutor.ts` (lines 200, 305, 470, 554, 609, 630, 650, 668, 693, 813, 912).
- `breeze.hasValidSession()` (a `getCustomerDetails()` round trip) is called at `breezeExecutor.ts` 280, 677, 729, 786, 814, 859, 875, plus `bookkeeping.ts:1388`, `orderProcess.ts:139`, `breezePendingLimitOrders.ts:50`, `pendingLimitOrders.ts:33`, `BreezeDataStream.ts:55`.
- Inside the clients: `Kite.ts` has 9 `No active session` guards (189, 204, 216, 239, 295, 511, 563, 578), `ANT.ts` has 5 (279, 310, 342, 471, 866), `Breeze.requireSession()` (about line 160) is a third copy.
- **Action:** one preflight in the orchestrator, before any child starts. Read the three session files, apply the existing ANT iat-date staleness test (`ANT.ts:146`), and make one `hasValidSession()` call per broker. If one fails, print the login URL and start only `frontend`. Then delete the per-order checks and keep only `loadSession` reloads.
- **Caveat:** the OAuth callbacks live in `server.ts` (`brokerCallback`, 1170-1205) and push `reloadSession` to `order` and `data`. So "start nothing" really means "start frontend only, then start the rest after login". Today `/reconcile` already needs all three brokers (`orderProcess.ts:1355-1357`, `server.ts:2124` returns 409), so the system is effectively all-or-nothing.
- **Also removable once the gate exists:** `reloadSession` IPC (`orderProcess.ts:1109-1120`), the 3-retry loop (`server.ts:1181-1195`), `connectAntOrderNotifyIfSessionValid` and `connectBreezeOrderNotifyIfSessionValid` (`orderProcess.ts:122-145`), `reloadSessionFns` (`dataProcess.ts:46-52`), and the throttled check in `pendingAntLimitOrders.ts:136-140`.

### R2-2 Config defaults applied at every read site [high]
**Status: PARTIAL (Phase 1, 2026-10-29).** DONE: the `?? 13975` quantity default, the `slDistance ?? 10` / `targetPoints ?? 2` fallbacks and the NIFTY-for-unknown-index fallback are gone; `validateConfigFile` now requires `quantity`, `targetPoints`, `slDistance` and `index` (NIFTY or SENSEX) for an enabled BulkPcr block (test: `configValidation.test.ts`). OPEN: the single `resolveMaxExposure`, `configVocabulary.ts`/`percentConfig.ts` removal, grandfathering removal, `getStrategyConfig` helper (Phase 5, task 5.1).
- `validateConfigFile` already runs at startup and fails closed (`ConfigService.loadConfig`, about line 113-125). Downstream code still re-validates and re-defaults:
  - `BulkPcrStrategy.ts:390-399` `Number.isFinite(n) && n > 0 ? n : 0` for `driftCancelPoints` and `hedgeTrailDistance`.
  - `BulkPcrStrategy.ts:943` `cfg.quantity ?? 13975`. **A hidden live-order size default.** `BulkPcrAutoStartStrategy.ts:227` already refuses to arm without a quantity because this default once bought about 215 lots.
  - `BulkPcrStrategy.ts:378,380` falls back to NIFTY for any index that is not exactly `SENSEX`. Also `slDistance ?? 10` and `targetPoints ?? 2` (line 427).
  - `BulkPcrAutoStartStrategy.ts:222-231` re-validates `quantity` and `targetPoints`.
  - `LegManager.ts:380,417,505`, `orderProcess.ts:1294`, `bookkeeping.ts:228`, `monitor.ts:185`: `maxExposure ?? maxInvestment ?? DEFAULT_MAX_INVESTMENT`, repeated in four places.
- **Keep:** `Number.isFinite(ltp)` checks on ticks (`BulkPcrStrategy.ts:1353,1363,802,1977`, `strategiesProcess.ts:264`). These guard live data, not config.
- **Action:**
  - Resolve each strategy's defaults once, in `loadConfig`. Readers then use `cfg.x`.
  - Make required fields (quantity, targetPoints, maxExposure) hard errors in `validateConfigFile` for enabled strategies.
  - Delete the 13975 magic default.
  - Delete `configVocabulary.ts` (20 LOC, dual-name migration). Finish the rename in `config.yml`.
  - Delete the percent-string parsing (`coerceMaxInvestment`, `normalizeBlock` in `ConfigService.ts` about line 130, and `percentConfig.ts`, 79 LOC) if `config.yml` uses plain numbers only.
  - Delete the grandfathering logic for old target/SL pairs (`configValidation.ts` about 236-262) after one `config.yml` cleanup.
  - `ConfigService.getStrategyConfig` (line 79) returns `{type, enabled:false}` for a missing block, and each strategy re-implements the same fallback (`BulkPcrStrategy.ts:442`, `BulkPcrAutoStartStrategy.ts` about 92). Replace with one helper.
  - `configToFlat`/`flatToConfig` (`ConfigService.ts:47`) exist only for the admin UI. Keep them out of the startup path.

### R2-3 Contract-master file checks repeated everywhere [high]
- Each master has a fail-soft preload that says "lookups will retry lazily" (`AntContractMaster.ts:80-90`, `KiteContractMaster.ts:118-127`, `PrismContractMaster.ts:28-35`).
- Each lookup then re-checks the file. `KiteContractMaster.ts:150` throws if `!existsSync`. This is the "impossible error" the user described.
- Staleness is checked per lookup: `checkStaleness`/`warnedStale` (`AntContractMaster.ts:41-53`, `KiteContractMaster.ts:36-50`), mtime hot reload (`AntContractMaster.ts:95-120`, throttled to once a minute), `refreshIfStale` and `isFileFromToday` (`KiteContractMaster.ts:56-70,~140`), and a third variant in Breeze (`BreezeContractMaster.ts:117-190`, with `downloading` dedupe).
- **Action:** one startup step (in `orderProcess.main`, `strategiesProcess.main`, and `dataProcess` if it needs masters). It downloads or validates the masters, parses them, and fails hard if a file is missing or not from today. Delete the lazy retry, `existsSync` re-checks, mtime checks and per-lookup staleness. Daily restarts make mid-day hot reload unnecessary. Expected saving: roughly 150-250 LOC.

### R2-4 Session-file loading implemented three times [medium]
- `ANT.ts:115`, `Kite.ts:98`, `Breeze.ts:134`. `Kite.ts:100` also reads a legacy file.
- `ANT.ts:121` deletes a stale file as a side effect of a read.
- **Action:** one `SessionStore` (or the R2-1 preflight) for all three. The clear-on-missing behaviour differs (`Kite.ts:116` clears, `ANT.ts:106` and `Breeze.ts:134` do not). A logout in one process therefore leaves a stale token in another.

---

## Area 4: restarts and reconcile

### R4-1 Startup does not reconcile, so the first ticks after a restart can open duplicates [critical]
**Status: DONE (Phase 1, 2026-10-29; user approved the CLAUDE.md rule change).** `strategiesProcess.startupReconcile()` loads broker positions through `order`, then runs every strategy's `reconcile()`, retrying every 30 s; `Strategy.receivesEvents()` (enabled + trading window + `stateLoaded`) gates ticks, fills and cancellations. Test: `startupReadiness.test.ts`. The single-process sequence comes with Phase 3.
- `order` starts with an empty `bookkeeping.trades` (`orderProcess.main`, 1419-1570). `exitMonitor.reconcileFromTrades(bookkeeping.trades)` at `orderProcess.ts:1362` and `:1444` runs on an empty list. It is a no-op, and the comment above it says so.
- `strategies` restores only `restoreLatches()` (Continuous and SupportResistance have it). It never calls `reconcile()` (`strategiesProcess.main`, 393-448).
- So after a restart, an enabled `ContinuousStrategy` has `ordered = false` and an idle `legManager`. The gate at `ContinuousStrategy.ts:293` passes, so it can open a duplicate T1 on top of a real position. The same applies to any strategy whose state is rebuilt only in `reconcile()`, and to `canPlaceOrder` lot and investment limits, which see an empty `bookkeeping.trades`.
- This is deliberate (`orderProcess.ts:1441`, `strategiesProcess.ts:434`, and CLAUDE.md), but it leaves a window where ticks are already being delivered.
- **Action:** make the startup sequence deterministic: preflight (R2-1), then `order` broker reconcile, then strategies `reconcile()`, and only then deliver ticks. Keep a "not ready" flag in `onTick` (`strategiesProcess.ts:255`) for the interval. Reconcile restores state and places nothing for disabled strategies, so it is safe to run at startup. CLAUDE.md's rule against running `/reconcile` unprompted exists because of this ordering problem, so revisit that rule once this is in place.

### R4-2 BulkPcr can enter a second position after a restart mid-cycle [high]
**Status: DONE (Phase 1, 2026-10-29).** `stateLoaded` gate in `Strategy.receivesEvents()` and an explicit check in `BulkPcrStrategy.processUnderlyingQuote`. Test: `startupReadiness.test.ts`. The Mongo-backed armed slots (R4-3) are still open.
- `PROCESS_STARTED_AT` (`BulkPcrAutoStartStrategy.ts:56`, slot skip at 119-120) blocks the **auto-start** path only.
- The auto-start writes `enabled: true` into `config.yml` (`attemptStart`, about 241-247), and BulkPcr's `durablyDisable` (`BulkPcrStrategy.ts:2068`) writes it back to false at cycle end. After a restart mid-cycle, the target is still `enabled: true` with `phase = 'idle'`, because nothing has reconciled it (R4-1).
- `processUnderlyingQuote` (`BulkPcrStrategy.ts:909-911`) checks only `enabled`, `phase === 'idle'` and the time window, so the first aligned tick enters again. This is the same incident class as 2026-10-29.
- **Action:** a BulkPcr instance may enter only after its state is loaded (a `stateLoaded` flag set at the end of `reconcile`/`loadState`). Or require the R4-1 reconcile first.

### R4-3 Armed-slot state lives in repo-root files, not Mongo [medium]
- `.bulkpcr_armed_slots.<userId>.json` (`BulkPcrAutoStartStrategy.ts:136-164`). There are also older `.bulkpcr_armed_slots.BulkPcrAutoStart-NIFTY.json` and `…-SENSEX.json` files in the repo root.
- Also: arming rewrites the whole `config.yml` (`writeConfig(configService.getConfig())`, about line 246), so a hand edit inside the 200 ms debounce window is overwritten.
- **Action:** store armed slots and BulkPcr `stateLoaded` in Mongo like the other state documents. Delete the repo-root files.

### R4-4 `setEnabledOverride` is an in-memory-only control, which CLAUDE.md forbids [high]
**Status: DONE (Phase 1, 2026-10-29).** `setEnabledOverride`, the `setEnabled` IPC case/client method and the `enable=` branch of `/strategies` are deleted (the frontend had no caller). Enabling or disabling is a `config.yml` edit.
- `Strategies.setEnabledOverride` (`strategies.ts:88`, called from `strategiesProcess.ts:311`) flips `strategy.enabled` in memory. `config.yml` is not changed, so it is lost on restart, and the next `refreshFromConfig()` resets it.
- **Action:** delete it. If an admin toggle is wanted, have it write `config.yml`, as `lock-profits` does. Also delete the `setEnabled` IPC case and any UI that calls it.

### R4-5 Trading-window enforcement disables strategies in memory only [high]
**Status: DONE (Phase 1, 2026-10-29).** `enforceTradingWindow`/`recheckTradingWindow` and the 60 s timer are deleted. The window is a read-only clock test in `Strategy.receivesEvents()`, so `enabled` always mirrors `config.yml`. Test: `strategiesEnabledGate.test.ts`.
- `enforceTradingWindow()` (`strategies.ts:66`, called at line 53 and every 60 s from `strategiesProcess.ts:445`) force-disables strategies in memory outside 09:10-15:25. `config.yml` still says `enabled: true`, and nothing re-enables them until the next config save.
- Starting at 09:00 with `enabled: true` therefore silently gives a disabled strategy, which is the opposite of what the config says.
- **Action:** either refuse to start with enabled strategies outside the window (a startup error), or let each strategy's own `isTimeInRange` decide. Do not disable in memory.

### R4-6 Retry loop for `getOpenTrades` copied into six strategies [medium]
- 15 attempts, 2 s apart, then fail closed. Copies: `ContinuousStrategy.ts:149-175`, `SupportResistanceStrategy.ts:108-131`, `HourlyStrategy.ts:681-696`, `BulkPcrStrategy.ts:2230-2250` (`getOpenTradesOnce`), `ButterflyStrategy.ts:574-596` (a variant that retries `reconcileOneBroker`), `RuleBasedStrategy.ts:340`. `LimitEntryStrategy.ts:307-310` has no retry at all, which is inconsistent.
- Continuous and SupportResistance are near-identical.
- **Action:** fetch open trades once, in the orchestrator or `strategiesProcess`, and pass them to `reconcile(openTrades)`. Then the retry lives in one place, and strategies lose their `maxAttempts`/`retryDelayMs`/`sleep` parameters. Fold Continuous and SupportResistance into a shared base class. Expected saving: about 100 LOC.

### R4-7 Stale comments describe a startup reconcile that no longer exists [low]
**Status: DONE (Phase 1, 2026-10-29).** Butterfly's comment is now true (startup reconcile exists); the Continuous / SupportResistance `restoreLatches` comments were corrected.
- `ButterflyStrategy.ts:570-572`: "Called automatically once at strategies process startup".
- `ContinuousStrategy.ts` about 133-145: says reconcile runs immediately at startup.
- **Action:** fix the comments. They mislead anyone reading the code.

### R4-8 BulkPcr reconcile body is about 500 lines of incident-driven branches [medium]
- `reconcileBody` (`BulkPcrStrategy.ts:2209-2625`) has per-phase branches (`done`/`pending`, `resting`, `selling`, `error`, `buying`, never attempted), and about seven nested "live incident" explanations.
- The `'selling'` branch repeats the closed-market, previous-day and same-day checks three ways.
- **Action:** model it as a decision table `(persistedPhase, brokerOpenQty, restingSellQty, sameDay) -> {newPhase, action}` in one pure function, unit-tested, with the actions executed afterwards.

### R4-9 Reconcile still hands open legs to enabled strategies without any gate [note]
- Per CLAUDE.md, `/reconcile` returns 409 if any broker fails and otherwise calls `strategiesClient.reconcile()` (`strategiesProcess.ts:354`), which loops over all strategies, including disabled ones. Disabled strategies are skipped for order placement by design, but the reconcile still rebuilds their legs, and that is the rule in CLAUDE.md. Once R4-1 is in place this is the intended behaviour, not a bug. Recorded so the rule is reconsidered together with R4-1.

---

## Area 1: orchestrator and IPC

### R1-1 `orchestrator.ts` is 400 lines, about 150 of them dev hot-reload machinery [medium]
- `hashTree`/`sameHashes`, `watchAndRestart` (sha1 snapshots, 90 s grace, debounce, lines 160-200), `makeRespawner` with backoff and `MAX_FAILED_RESTARTS`, `serial()` restart chains, `replacementAlreadyRunning`, four near-identical `start`/`restart`/`respawn` triples, and four path lists for watchers.
- The stdio pipes are re-wired by hand in each restart function.
- **Action:** drop the hot restart (a manual restart or `nodemon` per process is enough for a single developer). Make `makeChild(name, script, env)` data-driven with a role table and one `restart(role)`. About 150 LOC less.

### R1-2 Processes communicate through stdout, which forces a `console.log` redirect [medium]
- `data` pipes its ticks to `order` and `strategies` via stdout. Each child sends commands back on stdout. Every entry point then does `console.log = console.error` (`server.ts:6`, `strategiesProcess.ts:4`, `orderProcess.ts:4`, `dataProcess.ts:4`). The orchestrator notes say this has already bitten the project.
- **Action:** use Unix sockets for ticks and commands (both already exist for `order`/`strategies` IPC). Keep stdout as plain logs, and remove the redirect.
- **Unverified:** the tick feed to `order` (for `exitMonitor`'s `useGTT=false` trades). If `useGTT=false` is no longer used, the feed can go. Confirm before deleting.

### R1-3 `resync` timers hack [low]
- `orchestrator.ts` (about 257-263) sends resync after 5 s and 20 s, which are timing guesses. `strategiesProcess.ts:257` handles it.
- **Action:** `data` emits a "ready" line at startup, and `strategies` answers with `resubscribeAll`. No timers.

### R1-4 Two IPC protocols plus a fourth process [medium]
- `order` socket (`orderProtocol.ts` 191 LOC, `OrderClient.ts` 456 LOC) and `strategies` socket (`strategiesProtocol.ts`, `StrategiesClient.ts` 136 LOC). `OrderClient` is used by the frontend and by `strategies`, but lives under `processes/strategies/`.
- `server.ts` (2271 LOC) mixes the Express API, OAuth callbacks, payouts, KYC upload, OCR (`tesseract.js`), email, HTTPS on 443 and HTTP on 80. It is the hardest file in the project to reason about.
- **Action:** split `server.ts` into route modules (payouts, users/KYC, broker, trading). Move `OrderClient` to a shared location. **DECIDED 2026-10-29 (user):** `order` and `strategies` merge into one process. Broker connections do not break on a merge, since they are already per user. The frontend can also be merged if useful. Consequences to plan for:
- Removes the order and strategies IPC sockets and `OrderClient`/`StrategiesClient` cross-process calls. Strategy-to-order calls become in-process calls through the `BrokerPort` (R7-3).
- Removes the stdout tick pipes and the `console.log` redirect (R1-2). Ticks go straight from the data feed to the merged process, or stay on a socket if `data` remains separate.
- Makes the R4-1 startup order (preflight, reconcile, then ticks) one sequence in one process, instead of cross-process waits (`strategiesProcess.ts` 60 s wait on `order`).
- Keep `data` separate for now, unless the user also wants it merged. This is not decided.
- Frontend merge: optional and not decided. It is a separate question from the order/strategies merge.

### R1-5 `Strategies` class duplicates its expanded-config build and refreshes twice [low]
- `strategies.ts` builds `expandedConfigs` identically in `initialize()` and `refreshFromConfig()` (lines 45-55 and 105-115). `syncFromConfig()` calls `configService.reloadNow()`, which fires `onChange`, which calls `refreshFromConfig()`, so the refresh happens twice.
- `Log.log('[] expandedConfigArray: ', ...)` (about line 41) is a debug leftover.
- **Action:** one private builder. Drop `syncFromConfig` and the `syncFromConfig` IPC case (`strategiesProcess.ts:346`) if `onChange` already covers it.

### R1-6 Dead or probably dead code (needs confirmation before deletion) [medium]
- `src/monitor.ts` (584 LOC) and `decision.ts` (434), `prism.ts` (1287) and the `prism/` folder, `AntStream.ts` (274), `BreezeStream.ts`, and the `/breeze/connect` route (`server.ts:1262-1275`). CLAUDE.md calls `Monitor` and `AntStream` "legacy", so this is likely dead.
- **UNVERIFIED:** whether Prism is unused. `orderProcess.ts:42,303` still imports `PrismContractMaster` for ATM estimates, so Prism is not fully dead yet.
- Older strategies with `enabled: false` in `config.yml` (`SentimentStrategy`, `RateOfChangeStrategy`, `GapStrategy`, `TargetReachStrategy` and others). `strategies.md` lists which are armable. Per CLAUDE.md, remove the code only, never the `config.yml` block.
- **Action:** grep each module for importers, then delete the unreferenced ones in one change.

### R1-7 Unhandled-error policy differs by process [note]
- `main().catch` in each process, and `unhandledRejection`/`uncaughtException` handlers that keep running (`strategiesProcess.ts:452-457`, bottom of `orchestrator.ts`). `dataProcess.ts:577` deliberately has no `uncaughtException` handler. The difference is documented, so it looks intentional. Confirm, then leave.

---

---

## Area 6: API endpoints (too many routes)

Route inventory: `src/server.ts` (2271 lines) is the only route file, with about 100 routes and no router modules. Frontend callers were found by grepping `frontend/src`. Script and skill callers were found by grepping `scripts/` and `.claude/skills`.

### R6-1 Routes with no caller anywhere [high]
Delete, after updating `API.md`:
- `/openTrades` (`server.ts:1495`). Duplicates `/admin/trades/open`.
- `/trades`, `/closedtrades` (1546, 1557). Session-scoped views of in-memory stats.
- `/users/:email/trades/closed` (1572). Duplicates `/admin/trades/closed` with a fixed user.
- `/refreshtrades`, `/subscribetrades` (1644, 1654). The code comment calls the latter obsolete.
- `/connect`, `/logout` (1483, 2090). Prism-only, legacy unprefixed names.
- `/prism/oauthurl`, `/prism/authcode`, `/prism/token` (1089-1102). Replaced by the generic `/:broker/login` and `/:broker/callback`. `/prism/oauthurl` has no auth.
- `/prism/orderbook` (1360). Fold into `/broker/:b/orders` or delete.
- `/quotes`, `/niftyquote`, `/quote`, `/search` (2043-2079). Shoonya-era leftovers.
- `/candles` (2100). Also removes the strategies `getCandles` IPC.
- `/stats` (1985). Keep only if an ops view is wanted.
- `/breeze/order/buy`, `/breeze/order/squareoff` (1234, 1248). Manual test routes; `/order/buy` already covers Breeze.
- `/breeze/connect`, `/breeze/stream` (1267, 1278). A second in-process Breeze feed beside `processes/data/BreezeDataStream.ts`.

Keep: `/order/lock-profits` (1426). CLAUDE.md names it as the way to sell positions held by a disabled strategy.

### R6-2 GET+POST twins, including state-changing GETs [high]
- `getOrPost` (`server.ts:169`) registers a legacy GET next to the POST for 12 routes (1234, 1248, 1267, 1333, 1397, 1426, 1445, 1483, 1644, 1654, 2031, 2090).
- A GET that changes state is guarded only by the `X-Requested-With` header. That is a CSRF risk, and it contradicts the stated rule that state-changing routes use POST.
- The frontend already uses POST (`apiPost`) for these. The one caller on GET is `.claude/skills/monitor-strategies/SKILL.md:73` (`/ant/connect` via curl).
- **Action:** make them POST-only and update that skill line.

### R6-3 Per-broker twin routes beside the generic family [medium]
- `/prism/*`, `/breeze/order/*`, `/breeze/{connect,stream}`, `/ant/{connect,stream}` and `/shoonya/callback` sit next to `/:broker/login`, `/:broker/callback` and `/broker/:b/*`.
- **Action:** collapse into the generic family. Keep `/ant/stream` only as a debug SSE if wanted.
- `/prism/canPlaceOrder` is used by the frontend but is not Prism-specific. Rename to `/order/can-place`.

### R6-4 IPC commands with no caller or near-duplicates [medium]
- `orderProcess.ts` `handleRequest` (763-1241) has about 60 commands. Several are legacy names or near-duplicates that could merge: `buyIndex`/`breezeBuyIndex`/`chunkedBuyIndex`/`manualBuy`, `squareOff`/`breezeSquareOff`/`chunkedSquareOff`, `buyContract`/`buyContractBare`, `getContractByPriceRange`/`...Bare`, `antPlaceLimitSellBare`/`brokerPlaceLimitSellBare`.
- Reachable only from the routes deleted in R6-1: `breezeBuyIndex`, `breezeSquareOff`, `manualBuy`, `connectPrism`, `findToken`, `getIndexQuote`, `getStockQuote`. Remove them with those routes.
- Strategies IPC (`strategiesProcess.ts:298-354`): `getCandles` goes with `/candles`. `syncFromConfig` goes with R1-5. `setEnabled` goes with R4-4.

### R6-5 Vite dev proxy lists routes that no longer exist [low]
- `frontend/vite.config.ts:6-12` proxies `/replay`, `/subscribe`, `/kite`, `/shoonya`. Prune to the live prefixes.

### R6-6 Target size [note]
- About 100 routes now. Deleting R6-1 and R6-3 leaves roughly 55, and the user and payout routes are most of what remains. Area 6 is a deletion job, not a redesign.

---

## Area 6 (cont.): broker-layer overlap and dead code

### R6-7 Four broker layers with no shared interface for contract masters, sessions or streaming [medium]
- `src/broker/BrokerClient.ts` gives login URL, `exchangeToken`, `getTrades` and `getPositions` to four adapters (`brokerClients.ts`). Only `server.ts` and `orderProcess.ts` use it.
- **Contract masters:** four classes, four shapes. ANT is sync with an options-object `findNearestExpiryOption`. Kite is async and positional. Breeze is async with different records. Prism is `(symbol, strike, type, offset)`. Each repeats the stale-file warning, the freshness check and a `preload()`. Stale-file warning copies: `AntContractMaster.ts:50`, `KiteContractMaster.ts:38`, `BreezeContractMaster.ts:120`. Note that `ant-master-to-json.js` and `download-all-masters.sh` also exist for the same job.
- **Sessions:** three file stores plus a fourth partial helper. `.kite_session.json` with legacy `.zerodha_session.json` (`Kite.ts:47-49`), `.ant_session.json` (`ANT.ts:43`), `.breeze_session.json` (`Breeze.ts:77`), `userToken.txt` for Prism, and `AntSession.ts`. **Action:** one `SessionStore` (also R2-4).
- **Streaming:** two ANT paths (`ant/AntStream.ts` 274 and `processes/data/AntDataStream.ts` 247) and two Breeze paths (`breeze/BreezeStream.ts` 102, still wired into the server, and `processes/data/BreezeDataStream.ts` 230, which is the one implementing `DataStream`). **Action:** keep only the `data` process versions.
- **Pending-order trackers** are already consolidated: four thin wrappers (`pendingLimitOrders.ts` 89, `breezePendingLimitOrders.ts` 80, `pendingAntLimitOrders.ts` 219, `pendingPrismLimitOrders.ts` 49) over `PendingOrderTracker` (309). Fine as is.
- **Executors:** `kite`/`ant`/`breeze`/`prismExecutor.ts` (959, 1232, 927, 455) repeat `squareOff`, `placeLimitSellBare`, `cancelOrder` and `buyIndex` three or four times each. Already listed in `REVIEW_FINDINGS.md` item 23 (partly done). The shared interface is only a dispatch layer.

### R6-8 Old in-process engine cluster with no production importer (about 1400 LOC) [high, verify then delete]
- `src/monitor.ts` (584), `src/decision.ts` (434), `src/candle.ts` (167), `src/ant/AntStream.ts` (274) and `src/orderList.ts` (8) only import each other. The only outside importers are tests (`strategyTest.ts:9`, `monitorPartialSell.test.ts:8`) and `prism.ts:23` (for `orderList.ts`).
- The `ant-quote`, `nifty`, `sensex` and `position` emitter events have no listeners. `server.ts` listens only to `breeze-quote` (1283) and `notification` (1937).
- **Action:** delete the cluster and its two tests (`strategyTest.ts`, `monitorPartialSell.test.ts`), along with `test:strategy` in `package.json`. Confirm with a repo-wide grep first.
- `strategy/strategies.ts` is imported by `strategiesProcess.ts` too, so it stays.

### R6-9 Prism is kept and must match the other brokers [DECIDED 2026-10-29: Prism is not retired]
**Status: DONE (Phase 2, 2026-10-29).** Prism now implements the same `BrokerExecutor` as Kite / ANT / Breeze: `placeLimitBuyBareOnPrism` (tracked as a pending Buy), `getContractByPriceRangeOnPrism`, `squareOff`/`cancelOrder` take the exchange, and `buyOnPrism` books a partial fill before the error surfaces (it used to leave those lots orphaned at the broker). ANT's `getContractByPriceRange` is implemented too; all four share `pickContractByPremium` (`priceRangeContract.ts`, Kite refactored onto it). The `capabilities` flags and both checks in `orderProcess.ts` are deleted, so strategies have no per-broker special cases to find here. Prism is NFO-only (its contract master has no BFO): a BFO request now fails with `Prism supports NFO only` instead of being treated as NFO. Tests: `brokerParityMatrix.test.ts` (structural check for all four brokers plus the Prism behaviours), `prismOrderFailures.test.ts`. The Shoonya credentials hard-coded in `src/prism.ts` and `src/prism/RestAPI.ts` moved to `.env` (`PRISM_*`, listed in `.env.example`); **they remain in git history, so rotate them.** `config/config.properties` holds no secrets (trading settings and endpoints only). A live end-to-end matrix against a real Prism session was not run (no session; market closed).
- **Decision (user):** Prism stays. It must have the same functionality as the other brokers and implement the same interface. Nothing in this item is a retirement candidate.
- **Current gaps, from `brokerExecutors.ts` capability flags:** Prism has `placeLimitBuy: false` and `getContractByPriceRange: false` (line 102). Kite, ANT and Breeze support both (lines 35, 68, 132), except ANT's `getContractByPriceRange: false`. Prism's `squareOff` ignores exchange (`brokerExecutors.ts:106-107`). Its fill wait drops partial fills (R2-3 in `REVIEW_FINDINGS.md`, item 3).
- **Action:** bring Prism to parity. Implement `placeLimitBuy` and `getContractByPriceRange`. Make `squareOff` and `cancelOrder` take the exchange like the others. Give its fill wait the same result type (R2-3 above). Then it implements the same `BrokerExecutor` and `BrokerClient` interfaces as Kite, ANT and Breeze, with no capability special-cases in strategies.
- **Parity check:** after this, the same test matrix (buy, sell, limit sell, cancel, fill, reconcile) must pass for all four brokers.
- The earlier dead-code candidate list is withdrawn for Prism. Only the parts that are truly unused, if any, should be removed after the parity work, and that needs a repo-wide grep first.
- **Still to clear up:** `prism/config.ts` loads `config/config.properties`, and `prism.ts` and `prism/RestAPI.ts` hold credentials (see R6-11 and R2-1 in `REVIEW_FINDINGS.md`). These belong in the parity work.

Original analysis, kept for reference:
- No strategy or broker value in `config.yml` uses Prism now. Its live consumers are `server.ts` (1089-1110, 1360, 2092), the generic `BROKER_CLIENTS` entry, and `orderProcess.ts:42,303` (`PrismContractMaster` for ATM estimates).
- Candidates if Shoonya is retired: `prism.ts` (1287), `prism/RestAPI.ts` (561), `prism/MockAPI.ts` (152), `prism/WebSocket.ts` (155), `prism/config.ts` (112), `PrismContractMaster.ts` (110), `prismExecutor.ts` (455), `pendingPrismLimitOrders.ts` (49), the `nse_index.ts` Prism import (206), `data/prism/*`, and the `finvasia` SDK in `package.json`.
- The `prism/` folder also holds live config code: `ConfigService`, `AppConfig`, `configValidation`, `percentConfig` and `configVocabulary` are imported widely. **Action:** move those to `src/config/` whatever the Prism decision is.
- `BulkPcrAutoStartStrategy.ts:45` still mentions `brokers: ['ant', 'prism']` in a comment.
- **Question for the user:** is Shoonya/Prism retired for good? I have not treated this as a fact.

### R6-10 Dead dependencies and scripts [low]
- `package.json` dependencies with no import found: `@quantiply/finvasia-nodejs-sdk` (if Prism goes), `json-socket`, `nodemon`, `async`, `async-await-queue`, `cheerio`, `pdf.js-extract`, `selenium-webdriver` (only a comment in `niftyCandleBuilder.ts:5` remains), and `jest` v24. `request` gave loose hits only, so it is not confirmed.
- `test:watch` runs `jest --watchAll`, but the tests are standalone assert scripts. `scripts/run-all-tests.js:2-3` reports "jest reported 0 tests".
- Overlapping scripts: `analyze:scan`, `analyze:focused` and `analyze:check` alongside `analyze`; four `pipeline:*` variants; `sentiment:slow` as a variant of `sentiment`; `tradeTree`, `orderTree` and `orderTree:supportResistance` (niche tools).

### R6-11 Repo clutter and tracked generated data [medium]
- **Tracked and large:** `data/breeze/FONSEScripMaster.txt` (21.6 MB), the other Breeze masters, `data/breeze/SecurityMaster.zip`, `data/prism/*_symbols.txt` (9.4 MB), `data/kite/*_instruments.csv`. The masters are downloaded daily, so they should be untracked. `.gitignore` covers only `data/ant/*_contract.json*`.
- `analysis/output/` (about 150 MB of CSV, including `__pycache__/*.pyc`) is tracked despite `.gitignore` having `*.csv`.
- Root data and output files: `optionquote.csv`, `realtime.csv`, `niftyquote.csv`, `nifty.csv`, `stocks.csv`, `stats.csv`, `sentiment_results.csv`, `output.csv`, `Wednesday.json`, `temp.json`, `status.json`, `source.html`, `view` and `stocks.ods`.
- `public/index.html` and `public/symbols.txt` are tracked, although `public/` is gitignored. They are build output, and `frontend/public/symbols.txt` duplicates one of them.
- Stray source files: `src/Claude.txt`, `src/sample_response.json`, `browser.js`. `breeze_venv/` is untracked in the repo root.
- **Security:** `.claude/settings.local.json` is tracked. It holds obsolete curl permissions and what appears to be a key or OTP value. I have not reproduced the value here. Remove the file from git and rotate anything it exposed. `ngrok.json` is tracked, so check it for a token. `config/config.properties` is tracked and feeds `prism/config.ts`. `frontend/.env` is tracked, but `VITE_GOOGLE_CLIENT_ID` is a public ID, so that one is low risk.
- **Untracked but present (already gitignored):** `server_logs_stoploss5.txt` (15.7 MB), `server_logs_stoploss500.txt` (4.4 MB), `orchestrator_start.log` (2.5 MB), `debug.log` (dated Jan 2024), `cert.pem`, `key.pem`, `userToken.txt`, `requestOtp*`.
- **Docs:** about 3300 lines in 18 root files, several overlapping. Two to-do files (`ToDo.md`, `TODO.md`), with CLAUDE.md naming only `ToDo.md`. Plans and refactors (`plan.md`, `refactor.md`, `REFACTOR_PLAN.md`). Reviews (`REVIEW_FINDINGS.md`, `open-review-items.md`). Misc text files (`thoughts.txt`, `mongo.txt`, `mobile.txt`, `Running.txt`, `ReadMe.txt`, `Stock.txt`, `StockList`, `algorithm`, `4-letter-combinations.txt`, `MachineLearning.py`). Old strategy plans (`RoCPlan.md`, `StockOptionStrategy.md`, `Analysis.md`, `continuous-strategy-plan.md`). `plans/bug-01..12.md` look like a past review and should be archived or deleted once checked. `API.md` (824 lines) documents the routes to be deleted, so update it with R6-1.
- **Action:** `git rm --cached` the generated data, extend `.gitignore`, and consolidate docs. Each deletion of a tracked file is a decision for the user, so confirm the list before running it.

---

---

## Area 5: stoploss, target, trailing, max-loss, profit-lock and EOD

Live exit logic is spread over four places, with no single owner.

| Mechanism | Where | Notes |
|---|---|---|
| Kite GTT (target + SL) | `kiteExecutor.ts:110-176`, `pollGttFills` 799-870, `attachProtection.ts` | Set at entry when `useGTT` is on. |
| ANT bracket / cover | `antExecutor.ts:196-400` | Bracket, cover or exitMonitor, depending on config. |
| Breeze | `breezeExecutor.ts:23-32, 312` | No protection at all, by design. |
| Prism | `prismExecutor.ts:247` | Cover order. |
| In-app polling | `exitMonitor.ts:221-308` | Tick-driven square-off, retried without limit. |
| Strategy-owned | LegManager 673-802, BulkPcr `PnlStop`/`TrailStop`, Hourly invalidation, LimitEntry tick stop, Butterfly combo, ROC/Gap/RuleBased timeout sell | Each one is a separate implementation. |

### R5-1 Stops are lost on restart until someone runs `POST /reconcile` [critical]
**Status: DONE (Phase 1, 2026-10-29)** with R4-1 (reconcile before ticks restores legs, so stops and EOD close act after a restart).
- Reconcile is on-demand only (`strategiesProcess.ts:262-281, 410-412`). LegManager legs (Continuous, SR) exist only in memory until then, so after a restart an open position has no target, hedge, square-off or EOD close.
- `restoreLatches` restores the max-profit and max-loss latches at startup (`strategiesProcess.ts:421-426`), but not the positions they protect.
- This is the same root cause as R4-1. Fixing R4-1 (reconcile before ticks) also fixes this.

### R5-2 Kite GTT is orphaned by any exit that is not the GTT [high, needs a live check]
**Status: DONE (Phase 1, 2026-10-29).** Live check (read-only, 19:51 IST): Kite has 0 GTTs and 0 open positions, so nothing is orphaned today. Fix: every Sell fill that reduces a position carrying a GTT now deletes the GTT (`bookkeeping.releaseGtt`; a partial sell also hands the remainder to the in-app exit monitor); the GTT's own fill clears the id first. A failed delete of a still-active GTT logs `ALERT`. Test: `gttCleanupOnExit.test.ts`.
- `deleteGTT` is called only from `cancelProtection` (`attachProtection.ts:69`, `Kite.ts:510`), which I confirmed.
- Manual square-off, the Gap/ROC/RuleBased timeout sell, `lockProfits` and Hourly's close do not remove the GTT.
- A live GTT sell on a flat account would go short, because a GTT bypasses the app's never-short guard. I did not find a removal on those paths. This needs a check against live GTT state before anything else is decided.

### R5-3 Breeze legs on the legacy `buyIndex` strategies have no stop or target [high]
**Status: DONE (Phase 1, 2026-10-29).** `buyIndexOnBreeze` registers an in-app exit when target and stop points are given; `exitMonitor` knows `'breeze'` (exit handler = chunked square-off, registered in `orderProcess.ts`) and `reconcileFromTrades` no longer skips Breeze. Test: `exitMonitorBreeze.test.ts`.
- `buyIndexOnBreeze` records the fill and nothing else (`breezeExecutor.ts:312-314`).
- `exitMonitor.reconcileFromTrades` skips Breeze (`exitMonitor.ts` about 190).
- Affects Sentiment, Gap, GoodMorning, TargetReach and any Breeze `buyIndex` user.

### R5-4 Feed mismatch for `broker: breeze` LegManager strategies [high, unconfirmed]
**Status: DONE (Phase 1, 2026-10-29), confirmed from code (not live).** LegManager legs carry ANT tokens, but `resolveSource` routed `broker: breeze` to the Breeze feed. `Strategy.legTokenFeed = 'ant'` (set on Continuous and SupportResistance) now wins in `resolveSource` and in `onFill`. Test: `tokenRouterFeed.test.ts`. Hourly (also LegManager-based) was not changed: it is multi-broker and its token convention was not verified.
- `resolveSource` maps `broker: breeze` to the Breeze feed (`tokenRouter.ts:30-33`).
- The Breeze bare buy sets `trade.token = antToken` (`breezeExecutor.ts:725-741`), and LegManager calls `watchToken` with that token (`LegManager.ts:1056`).
- So the token is probably subscribed on the wrong feed and gets no ticks. Tick-driven exits would then never fire.
- BulkPcr avoids this by calling `watchTokenOnSource('ant', ...)` explicitly. **Action:** confirm live, then route through an explicit feed table (`BROKER_TO_FEED_SOURCE`).

### R5-5 Partial sells are accounted wrongly [high]
**Status: DONE (Phase 1, 2026-10-29).** `PartialSellError(soldQty)`; `LegManager.sellLeg` shrinks the leg and books the sold part's P&L before the retry. Test: `legManagerPartialSell.test.ts`.
- `antLegOps.sell` throws when only part is confirmed sold (`antLegOps.ts:91-96`).
- LegManager restores the leg with its full original `totalQuantity` (`LegManager.ts:715, 773`). The next retry sells the full size. The never-short guard only saves it by clamping, and the realized P&L is wrong.
- **Action:** after a partial sell, reduce the leg by the confirmed quantity before any retry.

### R5-6 Unchunked buy and sell on Kite and Breeze LegManager legs [high]
**Status: DONE (Phase 1, 2026-10-29).** Bare buys go through `marketBuyBareChunked` (a later-chunk failure returns the filled part) and `defaultLegOps.sell` through `chunkedLegSell` (same path as ANT). Test: `chunkedLegOps.test.ts`.
- `buyContractBare` and `sellContractBare` are single orders. The NIFTY freeze quantity is 1755 (`constants.ts:24`).
- SR quantity is 1755 (`config.yml:154`). A spawn at `spawnQuantityMode > 1`, or an average-add, can push `totalQuantity` over the freeze. The sell is then rejected, and LegManager retries forever (`LegManager.ts:713-719, 771-776`).
- **Action:** chunk every LegManager buy and sell through the chunked path (ANT already does this via `antLegOps`).

### R5-7 Restored Hourly positions are never closed [high]
**Status: DONE (Phase 1, 2026-10-29).** `activeInvalidationLevel`/`activeDirection` are persisted and restored; invalidation and EOD act on a restored `error` position that has a known contract. Test: `hourlyRestore.test.ts`.
- `activeInvalidationLevel` and `activeDirection` are not persisted (`HourlyStrategy.ts:327-328`, `persistState` 636-645).
- Reconcile flags any restored `selling` position as `error` (`:717-720`).
- `checkInvalidation` and `checkEod` act only on phase `selling` (`:296, 316`). After a restart there is no invalidation stop and no EOD flatten for it.
- **Action:** persist both fields, and treat a restored `error` position as still needing management.

### R5-8 A pending refill buy that survives a restart fills untracked [high]
**Status: DONE (Phase 1, 2026-10-29).** Resting refill intents are persisted (`legPendingReEntries`) on every change and restored by Continuous / SupportResistance `reconcile()`. Not persisted: `deferredRootRefill` (never placed at the broker; a root refill deferred behind open nested legs is lost on restart). Test: `legPendingReEntries.test.ts`.
- `restoreFromOpenTrades` (`LegManager.ts:1204-1283`) restores legs but not `pendingReEntries`.
- A later fill reaches `if (!intent) return` (`:1159`). The position then has no stop.
- **Action:** persist `pendingReEntries` alongside the legs.

### R5-9 LimitEntry leaves a partial fill unprotected [medium]
**Status: DONE (Phase 1, 2026-10-29).** The first partial fill places the exit; later fills top it up (`LimitEntryStrategy.topUp`: GTT re-attached over the whole quantity, resting sells for the delta). The EOD close still waits for the final size. Tests added to `limitEntryStrategies.test.ts`.
- The exit is placed only when `filledQty >= qty` (`LimitEntryStrategy.ts:437`), so it waits for the entry to complete or be cancelled.
- `entryTimeoutMinutes` has no default for Recommendation. A partial fill can sit unprotected until the EOD cancel.
- **Action:** protect the filled quantity immediately, then top up the exit as more fills arrive.

### R5-10 Disabled strategies drop fills [medium, consistent with the rule]
**Status: DONE (Phase 1, 2026-10-29).** Verified that the order process books every fill regardless of `enabled` (only delivery to the strategy is gated). `SentimentStrategy`'s constructor no longer forces `enabled = true`.
- `strategiesProcess.ts:94-97` drops fills when `enabled` is false. A resting target sell that fills while the strategy is disabled is never booked, which is why a reconcile is needed afterwards. This matches the `enabled` rule in CLAUDE.md, so the behaviour is intended. The risk is real, and R4-1/R5-1 would be easier to reason about if the order process booked fills for disabled strategies too.

### R5-11 Max-loss and max-profit each have three meanings [medium]
- `maxLoss`: LegManager is a percent of `maxExposure`, measured on the summed unrealized P&L of all legs with no realized offset (`LegManager.ts:499-512`). BulkPcr `maxLossPerOrder` is per order, per broker (`PnlStop.ts:62-66`). Hourly, Recommendation, NiftyChange, TopStock, Butterfly and the legacy group have none.
- `maxProfit`: LegManager is cumulative realized plus unrealized since reset (`LegManager.ts:393-395`). BulkPcr is `min(realized, realized+unrealized)` per broker per day (`BulkPcrStrategy.ts:815-820`). Nothing else has one.
- `PnlStop.ts` is a standalone copy of the LegManager logic, which the comment says was deliberate.
- **Action:** one definition each, in a shared latch, used by every strategy.

### R5-12 Target and stop naming is inconsistent [low]
- The same idea is `targetPoints`, `targetPrice`, `target` or `targetDistance`, and `stopLossPoints`, `stopLossPrice`, `stopLoss` or `slDistance`.
- In Recommendation `stopLoss` is an absolute price. In GoodMorning it is points. In Continuous and BulkPcr `slDistance` is a hedge or level spacing, not a stop. This overlaps R-vocabulary item 32 in `REVIEW_FINDINGS.md`.

### R5-13 EOD cutoff behaves three ways [medium]
- `eodCloseTime`, default 15:10, in Continuous, SR, Hourly and LimitEntry (`marketHours.ts:81`).
- Hard-coded 15:15 in BulkPcr (`BulkPcrStrategy.ts:872`) and Butterfly (`ButterflyStrategy.ts:523`).
- None at all in TopStock, Sentiment, TargetReach or GoodMorning. Gap, ROC and RuleBased have only `maxHoldTime`.
- **Action:** one EOD scheduler per user (see the proposed mechanism below), with one configurable time.

### R5-14 Exit pricing and log labels [low]
- Target-hit P&L in LegManager is computed from the tick price, not the fill (`LegManager.ts:546, 720, 778`).
- The log says "Max-profit close" for max-loss and EOD paths too (`LegManager.ts:543, 550`).

### R5-15 Hard-coded exit exclusions [low]
- `exitMonitor.ts` (about 137) excludes `['BulkPcrStrategy', 'TopStockOptionsOpeningGapStrategy']` by name. Replace with the owner field proposed below.

### R5-16 Configs rewritten at runtime, mixing operator config with strategy state [medium]
- Five strategies call `configService.writeConfig` to change their own state: AutoStart, BulkPcr `durablyDisable`, GoodMorning (x2) and TopStock. Operator settings and strategy state then live in the same file. This also works against the "config is operator-owned" rule.

### R5-17 Dead path: `getMonitorConfig` [low]
- `strategy.ts:76-82`, overridden in 10 files, is read only by the legacy `monitor.ts` (477, 496). The live `order` process never calls it, so the 10 overrides can go with the legacy cluster (R6-8).

### R5-18 Smaller items [low, verify before acting]
- `restoreFromOpenTrades` seeds `averagedLevels` as `{1,2,3,4}` regardless of `maxLevels` (`LegManager.ts:1251`). `wasAveraged` depends on `cfg.initialQuantity` (`:1225`).
- BulkPcr-SENSEX has `maxLossPerOrder: 0%` in `config.yml`, which means no loss cap, so only its 30-point hedge protects it.
- A second fill on the same tsym may overwrite the first GTT id, because `finalizeEntry` assigns `gttTriggerId` once per entry (unverified).

### Proposed single mechanism (area 5)
One order-process **ExitManager**, persisted in Mongo and keyed by (user, broker, tsym), that owns every stop, target, trail, max-loss, profit-lock and EOD close. It replaces `exitMonitor.monitored` and `SELF_MANAGED_STRATEGY_TYPES`.
- The strategy declares `{target, stop, trail, maxLoss, eodTime, owner}` at buy time, where `owner` is `broker | manager | strategy`. This replaces `getMonitorConfig()`.
- Use Kite GTT where it exists. Everywhere else, the manager runs tick-driven exits. It is rebuilt from Mongo on start, so it does not depend on a strategy reconcile.
- Size exits from the aggregate position, including `pendingReEntries`. Always sell through the chunked path, and book fills from the order rather than the tick.
- `TrailStop` and `PnlStop` become shared components that LegManager also uses.
- One EOD scheduler per user, including positions held by a disabled strategy.
- Deleting a GTT becomes part of every sell path (R5-2).

**Suggested order:** R5-2 (GTT cleanup) and R5-3 (Breeze protection) are live-money exposures and independent of the refactor, so do them first. Then R5-4, R5-5 and R5-6 (feed, partial sells, chunking). Then R5-7 and R5-8 (persistence). The ExitManager comes last.

---

## Area 7: strategies duplicated per broker

### Headline
There are no `-ANT`, `-Breeze` or `-Kite` strategy files. The three `ContinuousStrategy` blocks in `config.yml` (lines 28, 51, 76) are config-only variants of one class, which picks ANT or default leg ops per instance (`ContinuousStrategy.ts:76-85`, `legOpsFor` in `legOps.ts:8`). `BulkPcrStrategy` is also a single class that fans out over `brokers[]` with per-broker pair slots (`BulkPcrStrategy.ts:91-105`).

So the duplication is not per-broker files. It is broker branches **inside** each strategy, plus several copies of the same helpers.

### R7-1 Broker-specific branches still live inside strategies [high]
- `antLegOps.ts` (108 LOC) implements ANT strike choice from the option chain, a hard-coded `NIFTY_STRIKE_STEP = 50` (`:12`), chunked sell (`:91`) and unconfirmed-fill tagging.
- `LegBrokerOps.ts:28` hard-codes `'NIFTY'`.
- `BulkPcrStrategy.ts`: `parseAntMarginReject` (`:145`) parses ANT-only margin text. `feedTokenOf` (`:114`) handles Breeze's separate token. The broker dispatch throws for anything other than ant, kite or breeze (`:1964`). `watchTokenOnSource('ant', ...)` is hard-coded at `:1415, 1427, 2078`.
- `TopStockOptionsOpeningGapStrategy.ts`: three per-broker contract-resolution branches using three contract masters (`:363-426`), and separate ANT and kite/breeze buy-then-target-sell branches (`:530-626`).
- `ButterflyStrategy.ts:114` allows only `['kite','ant']`.
- `HourlyStrategy.ts:540` and `BulkPcrStrategy.ts:1964` cast to `'kite'|'ant'|'breeze'`.
- `LimitEntryStrategy.ts:182-186` and `ButterflyStrategy.ts:202-214` hard-code the `'ant'` feed.
- **Action:** all of these become calls to one broker port (R7-3). The strategy should never name a broker.

### R7-2 The same helpers are copied across strategies [medium]
- `type BrokerName` is redeclared in `HourlyStrategy.ts:66`, `BulkPcrStrategy.ts:87`, `ButterflyStrategy.ts:22` and `TopStock...Strategy.ts:63`.
- `configuredBrokers()` is copied at `BulkPcrStrategy.ts:459`, `HourlyStrategy.ts:177`, `ButterflyStrategy.ts:117`, `TopStock...:128`, `LimitEntryStrategy.ts:92` and `BulkPcrAutoStartStrategy.ts:220`.
- `resolveEntryRight` is in `ContinuousStrategy.ts:206-256`, `BulkPcrStrategy.ts:838-856` and `GapStrategy.ts:204-215`. `PCR_WINDOW_POINTS = 300` is defined three times (`BulkPcrStrategy.ts:24`, `ContinuousStrategy.ts:19`, `GapStrategy.ts:15`).
- `roundToTick` is imported from `../kite/Kite` in six strategy files (`BulkPcrStrategy.ts:13`, `HourlyStrategy.ts:10`, `LimitEntryStrategy.ts:11`, `NiftyChangeStrategy.ts:6`, `RecommendationStrategy.ts:4`, TopStock `:10`). Strategies therefore depend on the Kite module. Move it to `util/`.
- Lot size is hard-coded 65 or 20 in `BulkPcrStrategy.ts:46`, `LimitEntryStrategy.ts:25`, `HourlyStrategy.ts:407` and `ButterflyStrategy.ts:98`. `bookkeeping.getInstrumentLotSize` has the real one. Expose it from the contract master or an IPC call.
- Strike rounding `Math.round(ltp/step)*step` appears in `antLegOps.ts:27`, `ButterflyStrategy.ts:155` and `AntContractMaster.entryStrike` (NiftyChange, `:89`). The step constants are in `antLegOps.ts:12` and `ButterflyStrategy.ts:101`. Use one `selectStrike` helper.
- The exit-reject streak and margin regex are copy-pasted at `BulkPcrStrategy.ts:59-72` and `HourlyStrategy.ts:74-77`, and the `onOrderCancelled` re-placement bodies match.
- `cancel resting sells, book filledQty, chunkedSquareOff` appears in BulkPcr `eodSquareOff`, `repriceTrailExit`, Hourly `invalidateCloseInner` and `LimitEntryStrategy.closeLeg`. Create one `closePosition(userId, broker, tsym)` in the order process.
- Sizing is done three ways: `LimitEntryStrategy.sizeOrder` (`:168`), BulkPcr `marginReducedQuantity` (`:1817`) and `chunkedOrder.ts`. Move it into the order process behind one `sizeForBudget`.
- Capital checks: `LegManager.capitalCheck` (sticky latch, `:376-389`), the order process `canPlaceOrder`, and BulkPcr `effectiveCap`/`pushCap` (`:599-609`). The config keys `maxExposure` and `maxInvestment` are used interchangeably with different fallbacks (`LegManager.ts:380, 417`, `orderProcess.ts:1288`, `configValidation.ts:143`). Make the order-process check the only authority.
- Persistence is done four ways: per-strategy Mongo collections, repo-root dotfiles for LimitEntry (`LimitEntryStrategy.ts` about 100) and TopStock's fired-today file, `strategyLatches`, and config rewrites. Use one `StateStore`.

### R7-3 Shared strategy base is missing [medium]
- Use a single `MultiBrokerStrategy` base for `brokers()`, `BrokerName`, `cfg()` and per-broker state. This replaces the six copies. `Strategy.instanceConfig()` (`strategy.ts:59-70`) is the correct reader, but BulkPcr, Butterfly and LimitEntry each re-implement `cfg()`.
- `LimitEntryStrategy` is the best-factored example. Use its pattern as the template.
- The order process already has the right abstraction: `BrokerExecutor`, assembled in `brokerExecutors.ts`. Add a thin `BrokerPort` over `OrderClient` that always passes an explicit broker. It exposes `resolveContract`, `pickByPremium`, `buy`, `sell` (always chunked), `limitBuy`, `limitSell`, `cancel`, `attachProtection` and `cancelProtection`. All of these already exist as IPC calls.

### R7-4 Near-duplicate strategy groups [medium]
1. **GoodMorning and GoodMorningSensex.** Near-copies, differing mainly by index and constants (`GoodMorningStrategy.ts` 248, `GoodMorningSensexStrategy.ts` 213). Both rewrite `config.yml` at runtime (`GoodMorningStrategy.ts:119, 149`, `GoodMorningSensexStrategy.ts:115`, `goodMorningRetry.ts:54`). Merge into one class with an `index` parameter.
2. **ROC, Gap, RuleBased and Sentiment.** Each carries its own `Contract` class with `clear()`, a timeout sell and chunked-fill folding (for example `RateOfChangeStrategy.ts:14-110` and `GapStrategy.ts` about 14-100). Merge into one `BracketedEntryStrategy`, with the entry trigger, `maxHold` and bracket as plugins.
3. **Continuous and SR.** Both sit on LegManager, but SR has diverged. It has no `ops`, no `isOrderingBlocked`, no `onSpawnBuyError` and no momentum veto, and SR does not pass `ops` to LegManager (`SupportResistanceStrategy.ts:48-55`). Its `broker: kite` key works only through per-user routing. `broker: ant` throws at `getContractByPriceRangeBare`, since ANT has `capabilities.getContractByPriceRange: false` (`brokerExecutors.ts:73`). EOD, `restoreLatches` and `reconcile` are copy-pasted (`ContinuousStrategy.ts:145-171` against `SupportResistanceStrategy.ts:104-130`). Fix by fixing SR to use `ops` and sharing the base.
4. **BulkPcr and Hourly.** Shared exit-reject retry (`BulkPcrStrategy.ts:2103`, `HourlyStrategy.ts:599`), cancel-then-square-off (`BulkPcrStrategy.ts:1922`, `HourlyStrategy.ts:495`), per-broker position maps, and persisted-state `reconcile`. Covered by R7-2.
5. **Recommendation and NiftyChange** are already consolidated through `LimitEntryStrategy`. Use as the template.

### R7-5 Stale docs [low]
- `strategies.md:23-36` says `broker:` is "not read by any strategy", and lists seven legacy strategy files. Both are wrong: `ContinuousStrategy.ts:77` reads `cfg().broker`, `orderProcess.ts:1298-1299` reads it for every strategy block, and `tokenRouter.ts:30-33` reads it to pick the tick feed. Commit `9765032` already deleted BiDirection, Diff, HighLot, Minutes5Decision, ORBPrevious, Pivot and Test. Update `strategies.md`.

### Strategy inventory (all armable, all currently `enabled: false`)

| Strategy | LOC | Status |
|---|---|---|
| `BulkPcrStrategy` (x2 blocks) | 2704 | Live. Multi-broker. |
| `BulkPcrAutoStartStrategy` | 248 | Live. Arms BulkPcr by rewriting `config.yml`. |
| `LegManager` | 1312 | Shared engine for Continuous and SR. |
| `ButterflyStrategy` (x2) | 765 | Live. |
| `HourlyStrategy` | 743 | Live. |
| `TopStockOptionsOpeningGapStrategy` | 634 | Live. Target-only, no stop, no EOD close. |
| `LimitEntryStrategy` | 443 | Abstract base for Recommendation and NiftyChange. |
| `RuleBasedStrategy` | 360 | Legacy. Uses the Prism path via `Strategy.buyContract`. |
| `ContinuousStrategy` (x3) | 358 | Live. |
| `GapStrategy` | 271 | Legacy. |
| `SentimentStrategy` | 257 | Legacy. Constructor forces `enabled = true` (`:~190`), so it ignores config. |
| `RateOfChangeStrategy` | 254 | Legacy. Prism path. |
| `GoodMorningStrategy` / `GoodMorningSensexStrategy` | 248 / 213 | Legacy, near-copies. |
| `SupportResistanceStrategy` | 198 | Live. |
| `TargetReachStrategy` | 123 | Legacy. |
| `NiftyChangeStrategy` | 107 | Live. |
| `RecommendationStrategy` | 97 | Live. |

Helpers total about 650 LOC (`antLegOps`, `LegBrokerOps`, `legOps`, `MomentumSignal`, `PnlStop`, `TrailStop`, `goodMorningRetry`, `SerialWriter`, `dayKey`).

**Note on `SentimentStrategy`:** its constructor forces `enabled = true`, which overrides `config.yml`. That conflicts with the `enabled` rule in CLAUDE.md and should be fixed alongside R5-10.

### Proposed direction (area 7)
1. Introduce `BrokerPort` (R7-3) and move the broker branches out of strategies (R7-1). Delete `LegBrokerOps`, `antLegOps` and `legOps` once ANT strike selection is in `AntExecutor`.
2. Add the shared `MultiBrokerStrategy` base and delete the six `BrokerName` and `configuredBrokers` copies.
3. Merge the legacy group into `BracketedEntryStrategy`, and GoodMorning into one class.
4. Fix SR to use `ops`, then share its base with Continuous.

**Sequencing with the other areas:** R7 depends on R5 for the exit model and on R4 for restart order. Do the live-money items (R5-1, R5-2, R5-3) first, then R7.

---

## Summary across all areas

- **Critical or high, live-money:** R4-1 / R5-1 (no reconcile at startup, stops lost on restart), R4-2 (BulkPcr re-entry after restart), R2-2 (hidden 13975 live order size default), R4-4 and R4-5 (in-memory `enabled` controls), R5-2 (GTT orphaned on non-GTT exits), R5-3 (Breeze legs unprotected), R5-4 (feed mismatch, unconfirmed), R5-5 and R5-6 (partial sells, unchunked orders), R5-7 and R5-8 (restored Hourly and refill state).
- **Simplification:** R1 (orchestrator and IPC), R2-1 and R2-3 (repeated session and master checks), R4-6 (open-trades retry), R6-1 to R6-8 (routes and dead engine), R7 (broker branches and duplicates).
- **Decided by the user (2026-10-29):**
  - Prism is not retired. It must reach parity with the other brokers and implement the same interface (R6-9).
  - `order` and `strategies` merge into one process (R1-4). The frontend merge is optional and not decided.
- **Decided (2026-10-29), decision 3: the frontend stays a separate process.** It holds the Express API, OAuth callbacks, payouts, KYC and OCR, which are the most change-prone code. Keeping it apart means a UI or payout bug, or a frontend restart, cannot stop trading. It talks to the merged trading process over IPC, as it does today.
- **Decided (2026-10-29), decision 4: `data` stays a separate process.** A merge would couple the broker websockets to order execution. A `data` crash or restart would then drop market data, order-notify streams and order execution together. Today a `data` restart affects only ticks. The merged trading process is already a single point of failure, so there is no reason to add the feeds to it.
- **Consequence to plan for:** `data` restarts still need the resubscribe handshake (R1-3), since strategies depend on the feed after a restart.
- **Decided (2026-10-29), decision 5: `data` is never restarted during a live run, and its code is not changed during one.** Plan changes to `data` for market-closed time only. Two current paths break this rule:
  - **DONE (Phase 1, 2026-10-29)** `orchestrator.ts:366-372` `watchAndRestart('data', ...)` restarts `data` whenever its compiled output changes. This is a live risk, because any `tsc -w` rebuild during trading restarts the feeds. **Action:** remove that watcher.
  - **DONE (Phase 1, 2026-10-29: alert + `feedDown` message to strategies, no restart; `orchestratorPolicy.shouldAutoRestart`, test `orchestratorRestartPolicy.test.ts`)** `orchestrator.ts:254` `makeRespawner('data', restartData)` auto-respawns `data` after a crash. This is also a restart. **Action:** do not auto-restart it. A `data` crash should raise an alert and leave the decision to the operator. Strategies should then be told the feed is down, not left to assume it is up.
- **Effect on R1-3 and R4-1:** if `data` is never restarted mid-session, the resubscribe handshake matters only for a cold start of the whole system, not a live-run restart. Keep the handshake for start-up, but remove the `resync` timers as a recovery path.
- **Effect on the merge decision:** this confirms decision 4. Keeping `data` separate also lets the trading process restart without touching the feeds.
- **Verify before acting:** R5-4 (Breeze feed), R5-2 (GTT state on live accounts), R6-8 (dead engine, repo-wide grep), R2-3 (master freshness).

No code was changed. The review is complete for all seven areas.
