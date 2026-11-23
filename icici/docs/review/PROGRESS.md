# Codebase review progress (basis: feature.md, 2026-11-23)
Report-only review. No fixes. Findings per chunk in `docs/review/<id>.md`.
Status: TODO | IN-PROGRESS | DONE (date). Resume: pick any non-DONE chunk, re-run its scope, append to its findings file.

| id | scope (feature.md section) | status |
|----|----------------------------|--------|
| R01 | §1 runtime, orchestrator, IPC, server middleware | DONE (2026-11-23); note: strategiesProcess.startupReconcile not fully verified, cover in R07 |
| R02 | §2 market data (data process) | DONE (2026-11-23) |
| R03 | §3 brokers: ANT, Kite, order queue, chunking, pricing | DONE (2026-11-23) |
| R04 | §3 brokers: Breeze, Prism, paper, contract masters, login/session | DONE (2026-11-23) |
| R05 | §4 order process: bookkeeping.ts | DONE (2026-11-23) |
| R06 | §4 order process: orderProcess.ts, pollers, drawdown, mirror, protection | DONE (2026-11-23); note: pendingAntLimitOrders, fillNetting, timedFills not read in full by R06 - verify coverage in R05/R15 |
| R07 | §5 strategy framework | DONE (2026-11-23) |
| R08 | §6 BulkPcr + BulkPcrAutoStart | DONE (2026-11-23) |
| R09 | §6 Continuous, SimpleContinuous, ScaledHedged, SupportResistance, Hourly | DONE (2026-11-23) |
| R10 | §6 GoodMorning(+Sensex), TargetReach, RoC, Gap, RuleBased, Sentiment, TopStock, Butterfly, Recommendation | DONE (2026-11-23) |
| R11 | §6 NiftyChange, MomentumAtFixedTime, NextWeek, Breakout, GammaBurst, HighLow, Expiry | DONE (2026-11-23) |
| R12 | §7 manual trading + §8 users/levels/accounts | DONE (2026-11-23) |
| R13 | §9 payouts/tax/invoices + §10 research portal | DONE (2026-11-23); note: auth/CSRF items not cross-checked against R01/R04 |
| R14 | §11 frontend (React) | DONE (2026-11-23) |
| R15 | §12 ops/scripts/tools/config API + §13 dead/legacy | DONE (2026-11-23); R06 skipped files pendingAntLimitOrders/fillNetting/timedFills covered here |
| R16 | Uncovered files listed in R15 (MockAPI, closedTradeRows, openedToday, GateLogger, CanonicalSymbol, src/tools remainder, agreements content) | DONE (2026-11-24) via R15 "Uncovered files" section; not deep-reviewed: src/test, offline research tools (excluded by feature.md), legal wording in agreements/content |
