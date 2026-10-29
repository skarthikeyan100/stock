# REVIEW_FINDINGS-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every item in `REVIEW_FINDINGS-2.md`, live-money items first, in verified, separately committed phases.

**Architecture:** Fix the restart/reconcile/exit-safety defects in place (Phase 1), bring Prism to parity behind the existing `BrokerExecutor`/`BrokerClient` interfaces (Phase 2), merge `order` + `strategies` into one process with `data` and `frontend` staying separate (Phase 3), then delete dead code and collapse duplication (Phases 4-7).

**Tech Stack:** Node.js/TypeScript, Mongo, Express, standalone assert-script tests (`src/test/*.test.ts`, run by `npm test` = `scripts/run-all-tests.js`, `MOCK_BROKER=true`).

**Spec:** `REVIEW_FINDINGS-2.md` (decisions 1-5 in its Summary section; decision 2 = merge order+strategies, 3 = frontend separate, 4 = `data` separate, 5 = `data` never restarted live, R6-9 = Prism stays and reaches parity).

## Global Constraints

- Decision 5: never change `data` code or restart `data` during market hours (09:15-15:30 IST). `data` edits happen market-closed only; verify the clock (`date`) before each such task.
- Do not start, restart or hot-restart any process while positions may be open. `npm run processes` runs `tsc -w` with hot restart, so **never start it as a way to test**. Verification is `npx tsc` + `npm test` only (MOCK_BROKER). Currently no orchestrator is running (checked 18:42 IST 2026-10-29), so editing `src/` is safe now; re-check with `pgrep -af orchestrator` before each phase.
- Never delete `config.yml` blocks; only change values. `enabled: false` means no action of any kind (CLAUDE.md).
- No in-memory-only controls (CLAUDE.md). Operator controls live in `config.yml` or Mongo.
- No `code-review` skill unless the user asks. Finish each phase with `npx tsc`, `npm test`, own variation analysis, and say no review pass was run.
- Each phase ends with: update status markers in `REVIEW_FINDINGS-2.md` for every item touched, remove resolved lines from `ToDo.md`, record anything skipped (with the concrete blocker) in `open-review-items.md`, then commit and push to `origin/bulkpcr-loss-stop`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Two chunks of one position (split across the 1755 freeze quantity): every exit/cleanup path must handle N chunks, not one.
- Partial states: a sell that fills part, a cancel that succeeds but the order had filled, a GTT that exists while the position is flat.
- Startup with a disabled strategy that holds legs: reconcile must restore state and place nothing.
- A tick that arrives before reconcile finishes must be dropped, not queued and replayed into a half-built strategy.
- `data` crash during trading: strategies must learn the feed is down and nothing may auto-restart it.

---

## Phase 0: Preconditions (no commit)

- [ ] `date` shows market closed, `pgrep -af orchestrator` is empty, `git status` shows only the known pre-existing changes (`config.yml`, data masters, untracked review/trade files). Do not stage those files in any phase commit; stage by explicit path.
- [ ] Baseline: `npx tsc && npm test` and record which tests already fail (so a phase is judged against the baseline, not against zero).

## Phase 1: Live-money items

### Task 1.1: `data` is never auto-restarted (decision 5)

**Files:**
- Modify: `src/orchestrator.ts` (the `watchAndRestart('data', ...)` block ~366-372; `makeRespawner('data', restartData)` ~254; `restartData` ~240-253)
- Modify: `src/processes/strategiesProcess.ts` (stdin command handler near the `resync` case ~257)
- Test: `src/test/orchestratorRestartPolicy.test.ts`

**Interfaces:**
- Produces: `export function shouldAutoRestart(role: 'data' | 'order' | 'strategies' | 'frontend', reason: 'crash' | 'dist-change'): boolean` in a new `src/orchestratorPolicy.ts`; returns `false` for every `data` reason.
- Produces: stdin command `{cmd: 'feedDown', source: 'data'}` written by the orchestrator to `strategies` when `data` exits unexpectedly.

- [ ] Write `orchestratorRestartPolicy.test.ts`: `shouldAutoRestart('data','crash') === false`, `shouldAutoRestart('data','dist-change') === false`, the other three roles keep their current behaviour (true for both).
- [ ] Run it, expect FAIL (module missing).
- [ ] Implement `orchestratorPolicy.ts`, and call it from the `data` exit handler and the `data` watcher in `orchestrator.ts`. On a `data` crash: log an error line, write `feedDown` to strategies, do not respawn. Remove the `data` `watchAndRestart` block and the `5s/20s` resync timers as a recovery path (they remain only in the cold-start path if `strategies` starts before `data` is serving; keep that single case).
- [ ] `strategiesProcess.ts`: on `feedDown`, log an error and set a `feedDown` flag that suppresses new entries (read-only flag, not a control; it clears when ticks resume). Exits are not suppressed.
- [ ] Look for an existing alert helper (`grep -rn "notify\|alert" src/tools`); use it for the crash alert if one exists, otherwise log only and record in `open-review-items.md`.
- [ ] Run test, expect PASS. `npx tsc`.
- [ ] Manual operator note for the user (no restart done): the orchestrator must be restarted to pick this up, at a time they choose with positions flat.

### Task 1.2: Remove the hidden live-order-size default (R2-2 core)

**Files:**
- Modify: `src/strategy/BulkPcrStrategy.ts:943` (`cfg.quantity ?? 13975`), `:378,380,427` (NIFTY fallback, `slDistance ?? 10`, `targetPoints ?? 2`), `:390-399`
- Modify: `src/prism/configValidation.ts` (make `quantity`, `targetPoints`, `maxExposure`/`maxInvestment` required for **enabled** BulkPcr blocks)
- Test: `src/test/configValidation.test.ts` (extend)

- [ ] Add failing cases: an enabled BulkPcr block without `quantity` is rejected; the same block with `enabled: false` is accepted (disabled blocks keep loading).
- [ ] Implement validation, then delete the `?? 13975`, `?? 10`, `?? 2` fallbacks and the index-not-SENSEX-means-NIFTY fallback (unknown index becomes a validation error).
- [ ] Check the current `config.yml` BulkPcr blocks still validate (`node -e` loading `validateConfigFile` on it, no process start). If a disabled block would now fail, fix the validator, not the config.
- [ ] The rest of R2-2 (single `resolveMaxExposure`, delete `configVocabulary.ts`/`percentConfig.ts`/grandfathering) moves to Phase 5 Task 5.1.

### Task 1.3: Delete in-memory `enabled` controls (R4-4, R4-5)

**Files:**
- Modify: `src/strategy/strategies.ts` (`setEnabledOverride` :88, `enforceTradingWindow` :66 and its callers :53)
- Modify: `src/processes/strategiesProcess.ts` (`setEnabled` case :311, the 60 s timer :445), `src/processes/strategies/strategiesProtocol.ts`, `StrategiesClient.ts`, any `frontend/src` caller (grep first)
- Test: `src/test/strategiesEnabledGate.test.ts`

- [ ] Failing test: a strategy with `enabled: true` outside 09:10-15:25 stays enabled; the strategy's own time window (`isTimeInRange`) is what blocks entry. A strategy with `enabled: false` receives no tick.
- [ ] Remove the two mechanisms and the IPC case. Window enforcement stays the job of each strategy's own time check; where a strategy has none, add the check at its entry point (list them while doing this; do not guess).
- [ ] If the frontend has an enable toggle, repoint it to the existing config write path; if it needs a new endpoint, ask the user first.

### Task 1.4: Deterministic startup, no tick before reconcile (R4-1, R5-1, R4-2, R4-7)

> **Needs the user's approval before implementing:** it reverses the CLAUDE.md rule that reconcile is on-demand only. The plan assumes yes (the review recommends it); if no, skip to a `stateLoaded`-only variant (R4-2) and record R4-1/R5-1 in `open-review-items.md`.

**Files:**
- Modify: `src/processes/strategiesProcess.ts` (`main` 393-448, `onTick` :255), `src/processes/orderProcess.ts` (`main` 1419-1570; the empty `reconcileFromTrades` calls :1362,:1444), `src/strategy/BulkPcrStrategy.ts` (:909-911 entry gate), `src/strategy/strategy.ts`
- Test: `src/test/startupReadiness.test.ts`, `src/test/bulkPcrStrategyReconcileAnt.test.ts` (extend)

**Interfaces:**
- Produces: `Strategy.stateLoaded: boolean` (false until `reconcile()` has completed once), and `strategiesProcess` `ready: boolean` consulted at the top of `onTick`/`onFill`/`onOrderCancelled`.
- Startup order: order process loads broker state into `bookkeeping.trades` -> strategies `reconcile()` for **all** strategies (disabled ones restore state, place nothing) -> `ready = true` -> ticks delivered.

- [ ] Failing test: ticks delivered before `ready` do not reach `processUnderlyingQuote`; after `ready` they do.
- [ ] Failing test: an enabled BulkPcr at `phase = 'idle'` with `stateLoaded = false` does not enter on an aligned tick.
- [ ] Failing test: a disabled strategy holding a broker position is reconciled and no order is placed (reuse the mock executor's call log).
- [ ] Implement; reconcile failure (broker down) leaves `ready = false` and logs loudly, rather than opening the gate.
- [ ] Order process: replace the no-op `exitMonitor.reconcileFromTrades(bookkeeping.trades)` calls with one call after trades are loaded from the brokers.
- [ ] Fix the two stale startup comments (ButterflyStrategy.ts:570, ContinuousStrategy.ts ~133).
- [ ] Update CLAUDE.md's reconcile paragraph to the new rule.
- [ ] R4-3 (armed-slot files to Mongo) is Task 5.4, not here.

### Task 1.5: GTT orphan check and fix (R5-2)

- [ ] Read-only live check first (market closed, Kite session valid): list active GTTs via the Kite client and compare with positions. Record the result in `REVIEW_FINDINGS-2.md` R5-2. If no session is valid, record that as the blocker and still do the code fix below.
- [ ] Failing test: `lockProfits`, manual `squareOff`, Hourly close and the Gap/ROC/RuleBased timeout sell each call `cancelProtection` for every chunk of the position **before** the sell; if the cancel fails the sell still goes out (never leave a position unprotected by a failed cleanup), and the failure is logged.
- [ ] Implement in `src/processes/order/attachProtection.ts` / `kiteExecutor.ts` as one `exitWithCleanup` step reused by the paths above; add `src/test/gttCleanupOnExit.test.ts`.

### Task 1.6: Breeze protection and feed routing (R5-3, R5-4)

- [ ] R5-4 first, read-only: confirm from code which feed `watchToken` subscribes for a `broker: breeze` LegManager leg (trace `tokenRouter.ts:30-33` -> `LegManager.ts:1056`). If confirmed, add `BROKER_TO_FEED_SOURCE` and a test that a Breeze bare-buy leg subscribes the ANT feed (`src/test/tokenRouterFeed.test.ts`). If it cannot be confirmed from code, record the live check needed in `open-review-items.md`.
- [ ] R5-3: make `exitMonitor.reconcileFromTrades` include Breeze and have `buyIndexOnBreeze` register its fill for tick-driven exit (target/stop from `getMonitorConfig`). Failing test in `exitMonitorRetry.test.ts` style: a Breeze trade gets a monitored exit and square-off is chunked.

### Task 1.7: Leg accounting (R5-5, R5-6, R5-7, R5-8, R5-9)

- [ ] R5-5: `antLegOps.sell` returns `{soldQty, complete}` instead of throwing on partial; `LegManager` reduces `totalQuantity` by `soldQty` before any retry. Test in `antLegOps.test.ts`: partial 40 of 100 then retry sells 60.
- [ ] R5-6: route `buyContractBare`/`sellContractBare` on Kite and Breeze through the chunked path. Test: quantity 3510 produces chunks <= 1755, each tracked; one chunk rejected does not drop the others.
- [ ] R5-7: persist `activeInvalidationLevel`/`activeDirection` in `HourlyStrategy.persistState`; treat a restored `error` position as managed. Test in a new `hourlyRestore.test.ts`.
- [ ] R5-8: persist `pendingReEntries` with the legs; `restoreFromOpenTrades` restores them. Test: a fill arriving after restore finds its intent.
- [ ] R5-9: `LimitEntryStrategy` places/updates the exit for the filled quantity on every fill. Test in `limitEntryStrategies.test.ts`: 40% fill has a 40% exit; a later fill tops it up; cancel of the remainder leaves the 40% exit.
- [ ] R5-10: the order process books fills for disabled strategies too (the strategy still receives nothing). Test: a fill for a disabled strategy updates `bookkeeping.trades`; no strategy callback fires. Fix `SentimentStrategy`'s constructor forcing `enabled = true`.

**Phase 1 exit:** `npx tsc && npm test` match the baseline or better, status markers updated, commit + push `Phase 1: live-money fixes (R1-3 partial, R2-2, R4-1..7, R5-1..10)`.

## Phase 2: Prism parity (R6-9)

**Files:** `src/processes/order/brokerExecutors.ts:102-107`, `prismExecutor.ts`, `src/prism/*`, `src/broker/BrokerClient.ts`, `brokerClients.ts`
- Test: `src/test/brokerParityMatrix.test.ts` (new), `prismOrderFailures.test.ts` (extend)

**Interfaces:**
- Produces: `capabilities.placeLimitBuy = true` and `getContractByPriceRange = true` for Prism; `squareOff(…, exchange)` and `cancelOrder(…, exchange)` signatures identical to Kite's; fill wait returns the same result type as the others (confirmed qty, partial fills preserved).

- [ ] Write the parity matrix test first: for each of `kite`, `ant`, `breeze`, `prism` (MOCK_BROKER), run buy, sell, limit sell, cancel, fill (full and partial), reconcile, and assert identical result shapes. Run it, expect Prism failures that match the gaps in R6-9.
- [ ] Implement `placeLimitBuy`, `getContractByPriceRange`, exchange-aware `squareOff`/`cancelOrder`, partial-fill-preserving fill wait in `prismExecutor.ts`.
- [ ] ANT's `getContractByPriceRange: false` is also a gap (R7-4 item 3, SR with `broker: ant`): implement it in `AntExecutor` from the option chain so strategies carry no special cases.
- [ ] Remove capability special-cases from strategies once all four are true (grep `capabilities.`).
- [ ] Prism credentials: move `config/config.properties` secrets to `.env` (R6-9 "still to clear up"); `git rm --cached` is Task 7.3 and needs user confirmation.
- [ ] Phase 2 exit: full matrix green for all four brokers, commit + push.

## Phase 3: Merge order + strategies into one process (decision 2)

**Files:** new `src/processes/tradingProcess.ts`; delete `strategiesProcess.ts`, `strategiesProtocol.ts`, `StrategiesClient.ts`; modify `orchestrator.ts`, `src/processes/strategies/OrderClient*` (becomes an in-process `BrokerPort`), `server.ts` (frontend -> trading IPC), `package.json`
- Test: `src/test/brokerPort.test.ts`, existing strategy tests rerun

**Interfaces:**
- Produces: `interface BrokerPort { resolveContract; pickByPremium; buy; sell /*always chunked*/; limitBuy; limitSell; cancel; attachProtection; cancelProtection }`, always taking an explicit broker, with `OrderClient` (frontend path) and `InProcessBrokerPort` (strategies path) implementations.
- Tick feed: `data` -> trading process over a Unix socket (`TICKS_IPC_SOCKET`), replacing the stdout pipes; stdout becomes plain logs and the `console.log = console.error` redirects are removed (R1-2). Confirm first whether `exitMonitor`'s `useGTT=false` tick feed is still needed (spec marks it unverified).

- [ ] Do in this order, one commit-safe step each: (1) introduce `BrokerPort` and move strategies onto it while still two processes (tests stay green); (2) add the tick socket on `data` (**market-closed only, decision 5**); (3) create `tradingProcess.ts` running `order` main then strategies main in one sequence (preflight -> reconcile -> ready -> ticks, reusing Task 1.4); (4) point the frontend at the single socket and delete the strategies IPC; (5) orchestrator spawns `data`, `trading`, `frontend` only; remove stdout tick pipes and the `resync` timers.
- [ ] Orchestrator hot-restart reduction (R1-1) lands here, as a role table with one `restart(role)`; hot restart of `data` stays removed.
- [ ] R1-5 (`Strategies` builder, double refresh) and R6-4 IPC command pruning that depend on the merge go in this phase.
- [ ] Phase 3 exit: `npm test` green, plus a MOCK_BROKER boot of `tradingProcess` in a throwaway shell (no orchestrator, no real broker) proving startup order. Commit + push. Cutover to the real orchestrator is the user's call, with positions flat.

## Phase 4: Exit-model consolidation (rest of Area 5)

- [ ] R5-11 shared `MaxLossLatch`/`MaxProfitLatch`, R5-13 one configurable `eodCloseTime` + EOD scheduler (including positions of disabled strategies, per-user), R5-14 fill-based P&L and log labels, R5-15 `owner` field replacing the name list in `exitMonitor`, R5-17 delete `getMonitorConfig` overrides (after Phase 5 Task 5.5 removes `monitor.ts`), R5-18 verify-and-fix items, R5-12 naming (with the vocabulary cleanup in Task 5.1).
- [ ] R5-16: strategies stop rewriting `config.yml` for their own state; armed slots and "fired today" move to Mongo (shares Task 5.4).
- [ ] ExitManager (persisted, keyed `(user, broker, tsym)`) is built **after** the above as the single owner, replacing `exitMonitor.monitored` and `SELF_MANAGED_STRATEGY_TYPES`. Separate test file per mechanism.

## Phase 5: Simplification

- [ ] **5.1** R2-2 rest: one `resolveMaxExposure(cfg)`, resolve defaults once in `loadConfig`, delete `configVocabulary.ts`, percent-string parsing, grandfathering (after a `config.yml` value cleanup; values only, no deletions). Move `ConfigService`, `AppConfig`, `configValidation` to `src/config/`.
- [ ] **5.2** R2-1 preflight: one session check per broker before children start; delete per-order `hasValidSession` calls, `reloadSession` IPC, 3-retry loop. R2-4/R6-7 `SessionStore`.
- [ ] **5.3** R2-3 contract masters: one startup load, fail hard if missing/not from today; delete lazy retry and per-lookup checks. Update `contractMasterStaleness.test.ts`.
- [ ] **5.4** R4-3 armed slots to Mongo; R4-6 one `getOpenTrades` retry in the trading process, strategies receive `reconcile(openTrades)`; R4-8 BulkPcr reconcile decision table as a pure function with a test per row.
- [ ] **5.5** R6-8/R1-6 dead engine: repo-wide grep per module, then delete `monitor.ts`, `decision.ts`, `candle.ts`, `ant/AntStream.ts`, `orderList.ts`, `breeze/BreezeStream.ts` and their tests; keep Prism (R6-9). Drop `test:strategy`.
- [ ] **5.6** R7-1..R7-4: `MultiBrokerStrategy` base, shared helpers (`BrokerName`, `configuredBrokers`, `roundToTick` to `util/`, one `selectStrike`, lot size from the contract master), `closePosition` and `sizeForBudget` in the trading process, GoodMorning merge, SR fixed to use `ops`, `BracketedEntryStrategy` for ROC/Gap/RuleBased/Sentiment. Each merge keeps its existing tests green before the old file is deleted.

## Phase 6: API surface

- [ ] R6-1 delete the caller-less routes and their IPC commands (R6-4), R6-2 make the 12 GET twins POST-only and update `.claude/skills/monitor-strategies/SKILL.md:73`, R6-3 collapse per-broker twins (`/prism/canPlaceOrder` -> `/order/can-place`), R6-5 prune the Vite proxy, split `server.ts` into route modules (R1-4), update `API.md`. Test: `serverCoreFixes.test.ts` extended with a route-inventory assertion (every remaining route documented in `API.md`). Rebuild the frontend (`cd frontend && npm run build`) if any frontend file changed.

## Phase 7: Housekeeping

- [ ] R6-10 dead deps (grep-confirm each, then `npm uninstall`), R7-5 `strategies.md`, R6-11 repo clutter: `git rm --cached` of generated data and `.gitignore` additions. **Each tracked-file deletion is listed to the user for confirmation before running** (CLAUDE.md-level decision); `.claude/settings.local.json` / `ngrok.json` secrets: report that rotation is needed, do not print values.
- [ ] Final pass: every item in `REVIEW_FINDINGS-2.md` carries a status (`DONE <commit>`, `VERIFIED-NOT-A-BUG`, or `SKIPPED: <blocker>` mirrored in `open-review-items.md`), `ToDo.md` pruned, `npx tsc && npm test`, commit + push.

## Self-review notes

- **Coverage:** R1-1..7 (1.1, Phase 3, 5.5), R2-1..4 (1.2, 5.1-5.3), R4-1..9 (1.3, 1.4, 5.4), R5-1..18 (1.4-1.7, Phase 4), R6-1..11 (Phases 2, 5, 6, 7), R7-1..5 (5.6, 7). R1-7 is a "confirm and leave" note: confirm during Phase 3 and mark it.
- **Open questions for the user** (do not block Phases 0, 1.1-1.3, 1.5-1.7, 2):
  1. Task 1.4 reverses the "reconcile on demand only" rule: approve?
  2. Phase 7 file-deletion list and secret rotation are confirm-first.
  3. Phase 3 cutover timing (a real restart) is yours.
