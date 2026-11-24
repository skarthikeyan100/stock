# Analysis Workflow — Resume at 5pm

## Status
Complete (2026-08-25). All 6 domain agents ran, `/home/karthikeyan/work/icici/Analysis.md` was
consolidated from their reports, and `.analysis-work/` was deleted after the user confirmed
(raw findings are preserved in Analysis.md with file:line citations). This doc can be archived
or deleted — nothing left to resume.

## Goal
Produce a single, elaborate `/home/karthikeyan/work/icici/Analysis.md` cataloguing bugs, gaps,
and UX issues across the whole codebase (however small or big), to be used later as the basis
for fixing gaps / implementing missing features. **This task is analysis only — no code
changes.** Note: `/home/karthikeyan/work/icici/analysis/Analysis.md` already exists but is an
unrelated Python ML-analysis artifact — do not confuse it with the deliverable, which goes at
the repo root.

## System context (recap — don't re-derive, just reuse)
Prop-trading-firm platform. Users are either real humans (Google/Gmail OAuth login) or
automated trading strategies modeled AS users (each strategy = a user; its trades, P/L, and
payout are tracked like a real user's). Three broker integrations:
- `ant` (Alice Blue) — used ONLY for real-time price streaming (websocket).
- `prism` (Shoonya) — legacy broker, being phased out.
- `kite` (Zerodha) — currently the only broker actually used for live order execution; broker
  choice for trading *should* be configurable per user but may be hardcoded — needs verifying.

CLAUDE.md is known to be stale in one place: live-trading order/risk bookkeeping actually
happens via `src/orchestrator.ts` → `src/processes/order/bookkeeping.ts`, not the legacy
`src/monitor.ts` (per prior-session memory `live_trading_process_split`).

Known prior findings — do NOT re-report as new discoveries, but DO verify current state and
add detail if relevant:
- `RuleBasedStrategy` / `Minutes5Decision` previously found inert (registered but not wired
  into live execution). Verify still true.
- `ContinuousStrategy`'s `logGateOnce` gate-log wording is misleading (open ToDo.md item,
  not yet fixed as of 2026-08-25) — around `logGateOnce`/`processNiftyQuote` in
  `src/strategy/ContinuousStrategy.ts`.
- `/users` endpoint had a "P&L enrichment gap" (from memory `microservices_split_gaps`) —
  verify current state.
- Per-user broker configurability (ant/prism/kite) for trade execution — verify whether this
  exists at all today or kite is hardcoded.
- **Also re-check `ToDo.md` at the start of the new session** — it's live/hook-maintained and
  may have changed since 2026-08-25.

Explicit user ask for UX pass: admin trade views should have a filter of **ThisDay / ThisMonth
/ Custom (date range between two dates)** rather than whatever exists today — call this out
specifically in the frontend/UX findings and in the consolidated Analysis.md.

Test harness is confirmed missing: `package.json` has `"test": "jest"` but there is no jest
config and `find . -iname "*.test.ts" -o -iname "*.spec.ts"` (excluding node_modules) returns
nothing. Same repo-wide check should be repeated for frontend (Vite/React) — no test setup
found there either as of this session.

## Output locations for sub-agent reports
Do **not** use the session scratchpad (`/tmp/claude-1000/.../scratchpad`) — it's tied to the
session ID and won't survive a restart. Instead have each agent write to a repo-local temp dir
so it survives across sessions:

```
/home/karthikeyan/work/icici/.analysis-work/backend-api.md
/home/karthikeyan/work/icici/.analysis-work/brokers-execution.md
/home/karthikeyan/work/icici/.analysis-work/strategies-decision.md
/home/karthikeyan/work/icici/.analysis-work/data-pnl-payout.md
/home/karthikeyan/work/icici/.analysis-work/frontend-ux.md
/home/karthikeyan/work/icici/.analysis-work/test-harness.md
```
(create the `.analysis-work/` dir first; delete it after final consolidation into `Analysis.md`
if the user doesn't want it left in the repo — ask, since this isn't a git repo so there's no
easy "just don't commit it" fallback.)

## Dispatch plan — 6 parallel general-purpose agents, one message, all at once

Use the `superpowers:dispatching-parallel-agents` pattern. All six are independent domains
(no shared files, no sequential dependency) so all six `Agent` calls go in a single response.
Each agent: read-only investigation, `subagent_type: general-purpose`, must not edit code.

### Agent 1 — Backend API & Auth
Scope: `src/server.ts` (routes, `resolveUser`, auth middleware, status codes), `src/user.ts`
(CRUD, KYC fields, GridFS docs, per-user broker-selection field check), `src/prism/ConfigService.ts`
+ `AppConfig.ts` (config GET/POST, validation/caching), full session/auth flow (Google login →
signed cookie → `/auth/me`, OAuth for prism/kite/ant).
Look for: missing input validation, missing authz (can a user hit another user's data?), error
handling gaps, inconsistent API design, race conditions in session/config, dead code/TODOs,
and explicitly confirm/deny per-user broker configurability by grepping executor callers.
Output: `.analysis-work/backend-api.md` — sections: Critical Bugs / Gaps & Missing Features /
Minor Issues / Notes. Cite `file:line` for every finding.

### Agent 2 — Broker & Order Execution
Scope: `src/broker/{Broker,AntBroker,ShoonyaBroker,ZerodhaBroker}.ts`, `src/ant/*.ts` (OAuth,
session persistence, websocket reconnect/heartbeat, contract master staleness), `src/prism/*.ts`
(RestAPI global-axios-interceptor gotcha — check if any non-Prism code accidentally uses the
global axios instance and gets bitten), `src/zerodha/*.ts` (order placement, retry, rate
limiting, token refresh), `src/processes/order/{bookkeeping,antExecutor,prismExecutor,
zerodhaExecutor,exitMonitor,pendingLimitOrders}.ts`, `src/processes/orderProcess.ts`,
`src/processes/data/AntDataStream.ts`, `src/processes/dataProcess.ts`.
Look for: whether broker choice is actually configurable per user (trace orderProcess.ts /
bookkeeping.ts executor-selection logic) or hardcoded to kite; silent failure modes; websocket
reliability; race conditions across concurrent strategies; inconsistent error handling across
the three executors; contract-master staleness handling. Do NOT re-report the open ToDo.md item
about AntOrderNotifyStream brokerOrderId/heartbeat verification — flag anything else in those
files instead.
Output: `.analysis-work/brokers-execution.md` — same 4-section structure, explicitly answer the
per-user broker configurability question in Gaps.

### Agent 3 — Strategy & Decision Logic
Scope: all of `src/strategy/*.ts` (every strategy file — BiDirectionStrategy, BuySellStrategy,
ContinuousStrategy, DiffStrategy, GapStrategy, GoodMorningSensexStrategy, GoodMorningStrategy,
HighLotStrategy, IntermittentStrategy, Minutes5Decision, ORBPrevious, PivotStrategy,
RateOfChangeStrategy, RuleBasedStrategy, SentimentStrategy, SupportResistanceStrategy,
TargetReachStrategy, TestStrategy, plus `strategy.ts`, `StrategyFactory.ts`, `strategies.ts`),
`src/decision.ts`, `src/processes/strategies/*.ts`, `src/scheduler/*.ts`, `src/orchestrator.ts`.
Look for: for EACH strategy, is it registered in StrategyFactory AND actually invoked from the
live pipeline (trace the call chain) — produce an explicit wiring-status table; config-threshold
wiring (real config reads vs hardcoded values); signal-math correctness (off-by-one, div-by-zero,
NaN, market-hours edge cases); scheduler overlap/restart-recovery behavior.
Output: `.analysis-work/strategies-decision.md` — sections: Strategy Wiring Status (table) /
Critical Bugs / Gaps & Missing Features / Minor Issues / Notes.

### Agent 4 — Data Model, P/L & Payout
Scope: `src/monitor.ts` (legacy), `src/payout.ts` (scrutinize the math carefully — rounding,
sign errors, double counting, payout-eligibility timing, partial fills), `src/tax.ts`,
`src/processes/order/bookkeeping.ts` (current live path — compare against monitor.ts for
drift/duplication), `src/model/{CanonicalSymbol,model}.ts`, `src/trade/*.ts` (determine if
truly dead — grep for importers across `src/`), `src/tools/mongo.ts` (schema, GridFS, missing
indexes, error handling on money-relevant writes).
Look for: P/L correctness across lots/partial exits/call+put/fees; payout eligibility bugs
(e.g. computed on unrealized P/L, double-count race on concurrent closes); monitor.ts vs
bookkeeping.ts disagreement risk; confirmed dead code in src/trade/*; Mongo write-safety gaps.
Verify the `/users` P&L enrichment gap's current state.
Output: `.analysis-work/data-pnl-payout.md` — sections: Critical Bugs (money-math first) / Gaps
/ Minor Issues / Dead Code Candidates (with importer evidence) / Notes.

### Agent 5 — Frontend & UX
Scope: `frontend/src/**` (App.tsx, components/{NiftyTicker,NotificationBell,OrderEntry,
PositionCard}.tsx, context/{Auth,Trading}Context.tsx, pages/{Admin,Login,Profile,Rules,Trading}
Page.tsx), and the legacy static `public/*.html` admin pages (config.html, monitor.html,
prism.html, data.html, test.html, time.html) — determine if these overlap/duplicate the React
frontend or are dead UI.
Look for: **admin trade filtering** — does AdminPage today support ThisDay/ThisMonth/Custom
date-range filters, or something worse (no filter, or a clunky one)? This is an explicit user
ask — propose the concrete filter UX (ThisDay / ThisMonth / Custom-between-two-dates) as a
named gap even if partial filtering exists. Also assess: number of clicks to complete common
admin/trading tasks, loading/error/empty states, consistency of components, mobile
responsiveness, accessibility (labels, contrast, keyboard nav), visual consistency/polish
("looks professional" bar), and whether public/*.html pages should be retired.
Output: `.analysis-work/frontend-ux.md` — sections: Critical UX Bugs (broken flows) / Gaps &
Missing Features (lead with the admin filter ask) / Minor Issues / Polish & Professionalism
Recommendations / Notes.

### Agent 6 — Test Harness & API Contract Testing
Scope: whole repo. Confirm current state (jest referenced but unconfigured, zero test files
found via `find . -iname "*.test.ts" -o -iname "*.spec.ts"` excluding node_modules; same check
for frontend — no vitest/RTL setup found). Read `API.md` to enumerate the REST/SSE endpoint
surface.
Deliverable: a concrete, prioritized test-harness plan — not just restating the gap. Recommend
frameworks (e.g. jest + supertest for backend API/interface tests, vitest + React Testing
Library for frontend component/UX tests), propose an initial test-file layout, and name the
highest-priority endpoints/components to cover first (auth flow, order placement/exit,
payout calc, P/L calc, admin trade filters, KYC upload) given this is a money-handling system.
Output: `.analysis-work/test-harness.md` — sections: Current State / Recommended Stack /
Proposed Structure / Priority Coverage List (ranked) / Notes.

## Consolidation step (after all 6 return)
1. Read all six `.analysis-work/*.md` files.
2. Merge into one `/home/karthikeyan/work/icici/Analysis.md` with:
   - Short executive summary (system overview, methodology: 6 parallel agents by domain).
   - One section per domain, each internally ordered Critical → Gaps → Minor → Notes.
   - Dedupe anything reported by more than one agent (e.g. broker-configurability may surface
     in both Agent 1 and Agent 2 — merge into one entry, keep the more detailed citation).
   - A top-level "Priority Punch List" summarizing the highest-severity items across all
     domains (money-correctness bugs first, then security/authz, then reliability, then UX,
     then polish/test-harness).
   - Keep every `file:line` citation from the sub-reports.
3. Confirm with the user whether to delete `.analysis-work/` after consolidation (repo isn't
   git-tracked, so there's no "just don't commit it" option — it's a real cleanup decision).
