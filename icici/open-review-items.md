# Open review items (2026-10-26)
Everything else from the full-project review is fixed and pushed (order process 20cb2ce/5d0cb38/94d1506, broker clients 9cb15ed/794b005, strategies be6eb4c, server-core 8d53d62, frontend+tools 5a9bb87).
Decisions already made: hardcoded credentials stay as-is; no ANT login `state` check; no existing invoices so the counter needs no seeding.
Optional, not a code item: set CF_ORIGIN_SECRET plus a Cloudflare Transform Rule to enable the origin-secret check.
Remove an item from this file when it is fixed.


## Global exits and RuleBased fixes (2026-11-10)

Done: `settings.target` / `settings.stopLoss` with per-strategy overrides, used by RuleBasedStrategy and MomentumAtFixedTimeStrategy (`strategies/exitRules.ts`); the RuleBased bugs (list form, Stochastic name, `_REV`, unknown indicators, majority vote, target/stop never acted on). Not yet run in a live trading process; code was type-checked and checked with stubbed harnesses, and `momentumAtFixedTime.test.ts` was updated but NOT run (no test scripts this session, by instruction).
- [SEV: med] The other strategies still use their own target/stop and do not read the global keys: ContinuousStrategy (slDistance/targetDistance, LegManager), NiftyChange (stopLossPercent/stopLossPoints/maxLossPerLeg via entryStop.ts), GoodMorning, GoodMorningSensex, Gap, TopStock, Hourly, Butterfly, SupportResistance, RateOfChange, SimpleContinuous, Sentiment, TargetReach, BulkPcr, Recommendation. Migrate each one that has a target/stop, one by one, with its own tests; until then `settings.target` / `settings.stopLoss` apply only to the two strategies above.
- [SEV: low] Key-name collision: RecommendationStrategy reads its own `stopLoss` as an ABSOLUTE option price (`cfg.stopLoss`, like its `targetPrice`), not points. Settings-level `stopLoss` never reaches it, but the same name means different things. Decide whether to rename Recommendation's key before any migration.
- [SEV: low] RuleBased exit on ticks only: the target and stop are checked on option ticks for the held contract; if ticks stop arriving, neither fires (the timeout has the same dependency). No broker-side protection is placed.
- [SEV: low] RuleBased on 15/30-minute candles is NOT live yet. The backtest (`npm run backtest:ruleBased`) builds 900/1800 s candles with `createStatsBuilder(seconds)`; the live pipeline is still the 300 s `record()`. Wiring an `interval` key per rule into strategiesProcess needs one builder per interval and a per-rule `interval`, and should wait for backtest results.


## Awaiting a decision (RecommendationStrategy, 2026-10-30)

- [SEV: med] A recommendation whose trade did not finish on its day (a leg still open at the day rollover: ensureLoaded logs ALERT and drops it) leaves its block enabled, so the next day's first tick places the same recommendation again (the day's keys reset). Decision needed: should a block that traded yesterday be disabled automatically at the rollover, or should yesterday's unfinished trade simply never re-fire? Not changed yet because it decides what a leftover recommendation means.


## Post-fix review (unfixed)

30. [SEV: med] REVIEW NEEDED (stopped on request 2026-10-28, review deferred to the next day): commits 2dbe1f4..HEAD (`git log 5ae5efa..HEAD`) - the vocabulary migration: user fields lotLimit/accountCapital/strategyCapital (User, updateUserSettings, createUser, withCanonicalFields, backfillVocabularyFields, server settings/create routes, pushUserToOrderProcess, bookkeeping/monitor UserSettings, UserContext), frontend AuthContext/AdminPage/ProfilePage/TradingPage/RulesPage, config.yml reads (configVocabulary.ts, ConfigService.loadConfig, configValidation, AppConfig, LegManager/BulkPcr/orderProcess readers, admin UI keys), pending-order docs storing `token`, Trade.realizedPnl/unrealizedPnl accessors. Also not re-reviewed after their last fixes: the legacy-request translation (upgradeLegacyRequest), Breeze resolveOrderExchange, the ANT Bare-duplicate removal.
31. [SEV: med] TESTS NOT RUN (no test scripts were run this session, by instruction): src/test/pendingOrderTrackerAndFillState.test.ts is new and has never executed; bulkPcrStrategyReconcileAnt.test.ts and bulkPcrTrailAndOrderStop.test.ts were edited for the tradingSymbol payload key; orderAreaFixes.test.ts for BuyRequest.brokerToken; strategyTest.ts's MockMonitor for the pending-mark API. Run `npm run test:all` first.
32. [SEV: med] Config rollback / startup check: config.yml is now read with the canonical keys and written with BOTH names for settings (settings.targetPoints/stopLossPoints + targetPriceDiff/stopLossPriceDiff); strategy blocks use maxInvestment only (maxExposure removed 2026-11-04). Verify the file loads (no "config file rejected" in orchestrator.log) after the next restart, and that a rollback to the previous build still reads it. Same for users: confirm the startup backfill ran (`users` documents carry lotLimit/accountCapital).
33. [SEV: low] Vocabulary CONTRACT phase (not started, needs a release in which nothing reads the old names): drop lotCount/investmentAmount/allottedCapital from user documents and the API, targetPriceDiff/stopLossPriceDiff from config.yml and AppConfig, the broker-specific token field on pending-order documents (instrumentId/instrumentToken/antToken), then the aliases in withCanonicalFields / configVocabulary / bookkeeping.updateUserSettings / the server routes / the frontend `?? user.lotCount` fallbacks. Also not renamed: the stored `investmentMode` values ('lotCount'/'investmentAmount'), notification type strings (drawdown_warning/breach) and the drawdown* code names, `qty` in internal code, `instrumentId` as the ANT client/executor parameter name, and the ~270 `.tsym` reads on Trade (`tsym` is the stored Mongo key; moving it is its own expand/contract change).
34. [SEV: low] Review leftovers consciously deferred: (a) Monitor's legacy pending mark is per user, not per order (filledWhileInflight approximation); (b) Breeze resolveOrderExchange throws before the fill recheck when an id-only cancel has no exchange - all in-tree callers pass one; (c) ChunkedContract.supportsDriftCancel should be an executor capability, not a flag in the contract switch; (d) the liveRemainder latch logic is duplicated in BulkPcrStrategy and HourlyStrategy (a shared helper on Strategy would keep the day-scoping in one place); (e) bounded() abandons a timed-out ANT onPollError without cancelling it, so an orphan run can advance flatNoFillCount alongside the next poll; (f) bookkeeping.recordFill has no timeout of its own (a hang holds the tracker's pollInFlight); (g) the getOrders fallback in the Kite tracker caps history lookups at 5 per tick, so with more than 5 resting orders and a failing list some are checked late; (h) the three ANT-only requests that remain (antBuyTargetOnly, antPlaceLimitSellBare, antPlaceCoverOrder) carry ANT-only fields (underlyingOpen/marketProtection, product); (i) the Kite and Breeze polling loops and DemoTradingPage's layout stay separate.


## Findings from the 2026-10-28 review rounds that were deferred or only partly fixed (reconciled from all 54 saved review outputs)

35. [SEV: low] src/processes/order/pendingOrderTracker.ts - RE-OPENED (it was removed from this file by mistake): the generic COMPLETE/partial booking path and the `resolveFill` path are two parallel flows, plus four optional adapter hooks (`resolveFill`, `onStatusOk`, `onPollError`, `ignoreStaleStatus`) that only ANT uses. Fold into one flow (resolveFill with a default that holds the fillPrice/rowPrice logic and one bookFill-then-untrack tail). Related: the COMPLETE branch books `order.quantity` and ignores `filledQuantity`; `fetchSnapshot`/`rowPrice` are optional and cast, so an adapter with a real Snapshot type can omit them unnoticed; a Breeze `getOrderDetail` with no/err record is mapped to PENDING with no alert or retry limit; `buildAntFillTrade` duplicates the tracker's bookFill Trade; ANT's alert-once flags (`giveUpAlerted`, `noBookPriceAlerted`) reinvent `noPriceAlerted`; `TrackerHandle` repeats the tracker surface by hand; `rejectReason` is forwarded for all four brokers' cancel callbacks though only ANT sets it.
37. [SEV: med] ORDER_MAY_BE_LIVE reaches only buy-side consumers: the order process tags any failed request (sells, squareoffs, chunked square-offs too) but only LegManager.isUnconfirmedBuyError / ContinuousStrategy / BulkPcr's isNothingBought read it, so a sell/square-off with an unsettled fill is still retried by the other strategies (Hourly, strategy.ts, Sentiment/RoC...). Also no test drives the handleRequest tagging path end to end (the new test covers buyChunked's flag propagation only).
41. [SEV: low] src/processes/order/BrokerExecutor.ts - the capability flags for enterShort/buyToClose/marketBuy/marketSell were dropped (every broker has them today), so a future broker that cannot do one has no refusal path; `ChunkedContract.supportsDriftCancel` (orderProcess.ts resolveChunkedContract) should be an executor capability, not a flag in the contract switch.
49. [SEV: high] Restart window still loses fills on the entry paths that wait for the fill in-process and are NOT tracked from placement: Kite `buyIndexOnKite`/contract buys (kiteExecutor ~231, ~313, ~503, they finalizeEntry with target/SL, so a pending-poller booking would lose the stop), ANT `enterPosition` (marketBuy for ANT), Prism and the chunked buys' per-chunk wait. Only `marketBuyBareOnKite` and `marketBuyBareOnBreeze` were fixed (2026-10-28, track from placement, untrack after recordFill). Needs a write-ahead owner+exit-parameters record so a restart can finalizeEntry the order.
50. [SEV: med] A resting refill survives a restart in the pending-order tracker (booked if it fills) but LegManager's `pendingReEntries` intent does not, so a post-restart fill is ignored as a "redundant echo" and the leg is only recovered by the next POST /reconcile. Seen 2026-10-28 10:40 (NIFTY26N0322500CE refill). Needs reconcile/startup to rebuild the intent from the pending doc.
52. [SEV: med] Max-loss figure unexplained: the stop tripped at cumulative -12,142 (threshold -12,000) while strategy-status.sh showed realized +706 / unrealized +960 at the same moment; the six forced exits then realized -15,167. How LegManager's cumulative (realized + unrealized, ~line 391) is computed against live prices was not traced, so it is unknown whether the stop fired on a real loss or an overcount.
54. [SEV: low] npm scripts that start with `tsc &&` (test:strategy, test:continuousStrategy, backtest:*, orderTree*, analyze*, processes:once) re-emit all of dist/ and hot-restart every child of a running orchestrator (the cause of the 2026-10-28 10:05-10:06 restarts was the gapscreener scripts, already fixed). The orchestrator's fs.watch restarts on any dist write with no content check; consider ignoring rewrites with identical content or skipping restarts while legs are open.
55. [SEV: low] Two more orchestrator restarts at 10:19:00 and 10:19:20 (2026-10-28) have no identified cause - no src change by the user, not the gapscreener cron. Not investigated. Likely explanation found later: the orchestrator process tree's elapsed time (4h29m at 14:47) puts its start at about 10:18, so the 10:19:00/10:19:20 restarts were most probably a manual `npm run processes` restart, which also truncated orchestrator.log (events before 10:18 are gone from it). **Fixed 2026-11-03: `orchestrator.log` is no longer truncated on restart (per-day `logs/` files, see `scripts/orchestrator-log.sh`).**
56. [SEV: low] BulkPcr `breeze_put` flagged "was 'buying'/'error' at shutdown - manual review required" by reconcile at 10:05:47 and 10:06:57 (2026-10-28); nobody has reviewed it, and reconcile's alert line is cut off in the monitor feed.
58. [SEV: low] LegManager superseded-refill race (cancelChildRefills: refill fills while the cancel lands, 10:01:19 2026-10-28) is handled by a market sell-back at a spread loss each time; no change made. Consider adopting the filled refill as a leg when its parent is still alive.
59. [SEV: med] Reconcile at 11:54 2026-10-28: NIFTY26N0322600PE (kite) 'restores to 390 but the broker holds only 260 - capping'. Mongo's net of the Buy/Sell fills was 130 over the broker (a sell or fill missing from Mongo - the same contract was also traded by BulkPcr-NIFTY on kite, sold 455 at 11:24:50), and the restored avg moved 200.575 -> 201.00, so the leg's target/hedge prices shifted. Cause not traced; shared-contract netting between strategy pseudo-users on one broker account is the suspect.
60. [SEV: low] Before the 11:53 restart ContinuousStrategy's open leg showed unrealized +1,670.50 unchanged for 25+ minutes (lastTradePrice frozen at 207 while LegManager saw the price adverse enough to try L1/L2 hedges every tick): the stored lastTradePrice was stale for a nested leg (exitMonitor registration not verified). After the restart it reads 0.00 until a tick; not re-verified.


## RecommendationStrategy / NiftyChangeStrategy (2026-10-29)

61. [SEV: med] Breeze has no post-fill target/stop-loss primitive in this app: RecommendationStrategy on Breeze uses a resting limit sell + a tick-driven stop in the strategy. Neither `breezeconnect` 1.0.29 (installed) nor 1.0.31 (latest, checked 2026-10-29) has any GTT method, so it needs a raw signed REST call to `POST https://api.icicidirect.com/breezeapi/api/v1/gttorder` (as `Breeze.cancelOrder` already does with `generateHeaders`). Blocked on semantics only a live session can confirm: `gtt_type: "cover_oco"` is documented as a fresh order plus target and stoploss legs (the entry becomes part of the GTT, which changes fill tracking), the page gives no post-fill two-sell OCO sample, and its modify sample uses `"ocox"` against a table that says `"cover_oco"`. Next step: place one 1-lot `cover_oco` and one `single` GTT on a live session, see how the fills arrive (order notify stream / order book), then add `Breeze.placeGtt` and a breeze branch in `order/attachProtection.ts` (or a Breeze bracket entry like ANT's).


## REVIEW_FINDINGS-2 Phase 1 leftovers (2026-10-29)

62. [SEV: low] `data` crash alert is a log line (`ALERT: data process exited - NOT restarting`) plus a `feedDown` message to strategies; there is no push/email alert helper in the repo to call. If the operator is not watching `orchestrator.log` a dead feed goes unnoticed until positions are checked. Add a notification (Mongo `notifications` + the existing email/SSE path) when one is wanted.
63. [SEV: low] `LegManager.deferredRootRefill` (a root refill deferred behind open nested legs) is not persisted, unlike the resting refill intents (R5-8). A restart in that window loses the refill; the strategy re-enters via its normal entry gates instead.
64. [SEV: low] HourlyStrategy is LegManager-based but multi-broker; whether its legs' tokens are ANT tokens on a Breeze order was not verified, so it keeps routing by broker (`Strategy.legTokenFeed` is set only on Continuous and SupportResistance). Verify live before relying on Hourly with `breeze`.
66. [SEV: low] Pre-existing test failures, identical on the untouched HEAD (checked in a clean worktree 2026-10-29), not investigated: `bulkPcrStrategyReconcileAnt` (5 assertions, slots stay 'buying' instead of 'selling'), `supportResistanceStrategy` (4: no leg opens on a held-confirmed breach), `bookkeepingMongoInsertRejection` (1), `brokerClientsFixes` (1: 'poll errors still reach the timeout cancel'); `payoutRules` and `pendingOrderTrackerAndFillState` do not exit.


## REVIEW_FINDINGS-2 Phase 2 leftovers (2026-10-29)

67. [SEV: high, needs the user] The Shoonya/Prism credentials (user id, password, secret code, PAN, DOB, app keys, a session token) were hard-coded in tracked source until this phase and are still in git history. They now live in `.env`; rotate them with the broker (and, if the repo has ever been shared, treat them as exposed).
68. [SEV: low] Prism parity was verified with stubbed clients only; no live Prism session was available. Run one 1-lot buy / limit sell / cancel through `chunkedBuyIndex` on a real Prism login before relying on it. Prism stays NFO-only (no BFO contract master), so SENSEX users cannot use it.


## REVIEW_FINDINGS-2 Phase 3 leftovers (2026-10-29)

69. [SEV: low] The merged `trading` process was verified by booting it (and the full orchestrator) against the real, market-closed brokers with all strategies disabled: startup reconcile, both sockets answering a frontend-style client, `data` killed (no respawn, both clients alert), hot restart of `trading` only. It has NOT run through a live trading session with positions and ticks flowing. Watch the first session's log for `[trading]`, `[data-link]` and `startupReconcile` lines.
70. [SEV: low] `startupReconcile` retries every 30 s while any broker's positions cannot be read; `reconcileBrokerPositions` also refuses before 09:10. A process started earlier simply waits (no strategy receives ticks until it clears), which is intended but means a broker that is not logged in holds ALL trading back until the login happens.
71. [SEV: low] `Architecture.md`'s old 2026-10-25 merge decision record is kept (marked superseded) for the reasoning about frontend/data. `strategies.md`, `API.md`, `learnings.md` and the `monitor-strategies` skill were not re-read for stale `order`/`strategies` process names (Phase 7 doc pass).


## Awaiting a decision: exit model (REVIEW_FINDINGS-2 Area 5, 2026-10-29)

72. [DECISION NEEDED] Five Area 5 items were not changed because each is the user's call, not a coding choice:
   a. R5-11 max-loss / max-profit have three meanings (LegManager: percent of exposure on the summed unrealized P&L of all legs, no realized offset; BulkPcr: per order and per broker, profit as min(realized, realized+unrealized) per day; the rest have none). Pick one definition per stop, or confirm they stay different.
   b. R5-12 target/stop key names (`targetPoints`, `targetPrice`, `target`, `targetDistance`; `stopLossPoints`, `stopLossPrice`, `stopLoss`, `slDistance`) differ per strategy, and `stopLoss` is a price in Recommendation but points in GoodMorning. A rename changes `config.yml`; give the new names and whether old keys keep working for a while.
   c. R5-13 end-of-day: TopStock, Sentiment, TargetReach, GoodMorning, Gap, ROC and RuleBased have no EOD close; TopStock disables itself after its single trade, so its position (target-only resting sell, no stop) is unmanaged by the `enabled` rule and carries past the close if the target is not hit. Options: (1) an opt-in `settings.eodSweepTime` in `config.yml` where the order process closes every open position at that time regardless of which strategy owns it (recommended; off by default so nothing changes until set), (2) give TopStock a stay-enabled-until-EOD mode, (3) leave it to `POST /order/lock-profits` by hand.
   d. R5-16 five strategies rewrite `config.yml` to change their own state (AutoStart arming, BulkPcr durablyDisable, GoodMorning x2, TopStock). That is also how `enabled` flips; moving it to Mongo splits the switch across two places.
   e. The ExitManager (one persisted owner of every stop / target / trail / EOD across brokers) is a rewrite of the exit logic in LegManager, BulkPcr, Hourly, LimitEntry, Butterfly and exitMonitor. Phase 1 fixed the live exposures it was meant to remove; say if you still want it, and in what order, since it cannot be exercised live from here.


## REVIEW_FINDINGS-2 Phase 5 not done (2026-10-29)

73. [DECISION NEEDED] Left as they are because each changes live behaviour that cannot be exercised here, or needs `config.yml` edits CLAUDE.md forbids: (a) deleting `configVocabulary.ts`, percent-string parsing and the target/SL grandfathering (config.yml uses both names and `"10%"`); (b) one `SessionStore` for the three broker logins (R2-4) and the orchestrator preflight that starts only `frontend` until every broker is logged in (R2-1); (c) armed-slot dotfiles to Mongo (R4-3) and the other three dotfile stores (LimitEntry, TopStock, GoodMorning); (d) the BulkPcr reconcile decision table (R4-8; its only test already fails on HEAD); (e) moving the broker branches of BulkPcr, TopStock, Butterfly, Hourly and LimitEntry behind a port, plus `closePosition`/`sizeForBudget` (R7-1/R7-2); (f) merging the disabled legacy strategies (R7-4) or deleting them with their config blocks (R1-6). Say which you want.


## Awaiting your confirmation: untracking generated data and clutter (REVIEW_FINDINGS-2 R6-11, 2026-10-29)

74. [CONFIRM FIRST - nothing below has been run] Tracked files that are generated, daily-replaced or personal. `git rm --cached` only stops tracking them (the files stay on disk); history keeps them. Run, after you agree:
   ```
   git rm -r --cached data/breeze data/kite data/prism analysis/output public/index.html public/symbols.txt
   git rm --cached optionquote.csv realtime.csv niftyquote.csv nifty.csv stocks.csv stats.csv sentiment_results.csv output.csv \
       Wednesday.json temp.json status.json source.html view stocks.ods src/Claude.txt src/sample_response.json browser.js \
       ngrok.json .claude/settings.local.json frontend/.claude/settings.local.json
   printf '%s\n' 'data/breeze/' 'data/kite/' 'data/prism/' 'analysis/output/' 'public/' '.claude/settings.local.json' 'ngrok.json' >> .gitignore
   ```
   Sizes: `data/breeze` 29 MB (re-downloaded daily; also why `git status` always shows ~7 modified data files), `data/prism` 9 MB, `data/kite` 3 MB, `analysis/output` 134 MB of CSV, the root CSV/JSON dumps about 8 MB. `public/` is the vite build output (rebuild with `cd frontend && npm run build`); `data/prism/*` and `data/ant/*` masters are re-downloadable (`scripts/download-all-masters.sh`), but `data/nifty100_symbols.txt` is NOT in the list and must stay tracked. `.claude/settings.local.json` is a personal permissions file (4 KB) that also holds a key / OTP-like value: untrack it AND rotate whatever it exposed; it stays in git history. `ngrok.json` is 4 bytes (no token).
   Docs: about 18 root-level docs overlap (`ToDo.md` and `TODO.md`; `plan.md`, `refactor.md`, `REFACTOR_PLAN.md`; `REVIEW_FINDINGS.md`, `open-review-items.md`; `features.md` and `security.md` describe routes and processes that no longer exist; `RoCPlan.md`, `StockOptionStrategy.md`, `Analysis.md`, `continuous-strategy-plan.md`; `plans/bug-01..12.md`; loose notes `thoughts.txt`, `mongo.txt`, `mobile.txt`, `Running.txt`, `ReadMe.txt`, `Stock.txt`, `StockList`, `algorithm`, `4-letter-combinations.txt`, `MachineLearning.py`). Deleting or merging them is your call; `API.md`, `Architecture.md`, `strategies.md` and `CLAUDE.md` were brought up to date in this pass.
75. [DECISION NEEDED] `config.yml` BulkPcr-SENSEX has `maxLossPerOrder: 0%`, which the validator reads as "no limit" (BulkPcr-NIFTY has 10%). With it, only the 30-point hedge distance limits a SENSEX loss. Set a percentage if that is not what you want; I did not change your config.


## Plan 2026-11-02 (multi-broker model + trading-day fixes): items waiting on a user decision

76. [DECISION NEEDED] Part 2 item 2, cross-strategy daily loss limit (`settings.maxDailyLoss`): the design (check realized + open P&L over all strategies in the trading process; on breach write every strategy `enabled: false` to config.yml and close open legs through the `POST /order/lock-profits` path) needs your number and your approval of the design (it disables strategies by itself). Not implemented until you give the rupee limit.
78. [BLOCKED ON A LIVE CHECK] Part 2 item 6, sizing a BulkPcr hedge to the broker's AVAILABLE margin before the buy: no margin/limits call exists in `src/ant/ANT.ts`, and a web search found no confirmed AliceBlue endpoint (only the SDK's `get_balance`, response field `cashmarginavailable`). Needs a live ANT session to confirm the route, then a pre-check in `BulkPcrStrategy.buyAndExit`. Done meanwhile: top-up re-sizes up to 3 times from the rejection text, ALERT names the unhedged quantity.


## Test failure that predates the 2026-11-04 replay fixes

79. [UNINVESTIGATED] `supportResistanceStrategy.test.js` fails 4 assertions identically at HEAD and in the working tree (run 2026-11-04 after the close, also with `MOCK_BROKER=true`): the first held-confirmed breach opens no leg (`Cannot read properties of undefined (reading 'right')` in test 2, so tests 2, 5 and 6 fail). It is not the clock (no EOD close is logged with MOCK_BROKER), not `enabled` and not `stateLoaded` (the fixture now sets both). Next step: trace `processNiftyQuote` -> `legManager` open path with the fixture's `srHypothesis`/`maxInvestment` config. The strategy is disabled in `config.yml`, so no live trading depends on it today. The same sweep fixed three other stale tests (`brokerClientsFixes`, `bulkPcrStrategyReconcileAnt`, `momentumAtFixedTime`) and one real bug (`orderOwners.recordOrderOwner` threw when the Mongo instance had no `db` yet, which could abort `recordFill`).


## 2026-11-06 (found at the close)

80. [SEV: med] Breeze entry lost to a momentary "session not active": at 13:50:22 MomentumAtFixedTime's Breeze buy failed in `breezeExecutor.ts` (`hasValidSession()` false) during a Breeze data-socket reconnect (13:50:20-22; the stream disconnected about 20 times that day). The strategy logged the outcome as UNKNOWN and did not retry; Breeze showed no position or 24800 trade, but its order book was not read. Not fixed: the user asked for the report and the eodCloseTime setting, and the processes are stopped for the day. To investigate: why `hasValidSession()` reports false while the session file and token are fine, and whether a short retry before declaring UNKNOWN is safe.
81. [SEV: med] TESTS NOT RUN, NOT COMMITTED (eodCloseTime became the global `settings.eodCloseTime`): `src/util/eodClose.ts` is new and eleven strategy/validation files changed; tests edited for it (configValidation, hourlyRestore, limitEntryStrategies, momentumAtFixedTime, replayFixes) have not been executed (test scripts only on request). `tsc` is clean. Not committed because most of these files already carry earlier uncommitted changes from other work, so a commit would sweep those in; commit together once the tests are run.


## 2026-11-11 (found at 15:22, ANT intraday square-off)

85. [OPEN] The old broker-driven readers (`reconcile{Kite,Ant,Breeze,Prism}Positions`, `reconcileAllBrokersOnce`, `lastReconcileResult`, `prismInUse`, `startReconcile`, `runBrokerReconcileNow`) and `syncExternalCloses`'s periodic mode (`minFlatMs`, `flatSeen`) are unused; delete them after a week of clean end-of-day runs.
86. [OPEN] BulkPcr's `reconciling` guards (:671, :711, :824, :828, :948, :1189, :1240, :1242, :1306, :1900) were written for a reconcile that places orders; with `withNoOrders` they only stop a tick racing a state restore - re-check each. BulkPcr and Butterfly deferred actions (`runDeferredRestoreActions`, `runPendingRestoreActions`) were verified by tsc and code review only, no stub harness (they write the live strategy state docs); run them for the first time after a close with `npm run sync -- --strategies`. `ButterflyStrategy.resumeOrPlaceSellLegs` is now unused.
87. [OPEN] LimitEntry (`exitRetryAt === -1` persisted mid-placement) blocks every later exit retry after a crash (pre-existing).
88. [OPEN] After a restore from Mongo `lastTradePrice` is the cost until a tick arrives, so open P&L reads flat; seed it from `getOptionLtp` after the first login. `BrokerExecutor.ts:61` sells unverified when the live position cannot be read (a mid-day restart with an invalid session has no never-short guard on non-Kite brokers).
89. [OPEN] The end-of-day job cannot attribute: a partial close with several owners (`partialUnattributable`), a position held at a broker with no Mongo record (`brokerExcess`, mostly the user's manual trades), a missing Buy (`unattributedFill`). Breeze reports no sell totals, so its flat-close fallback is ESTIMATED when its trade book has no fill. A rule for any `reconcile()`: never use `*.getInstance()` broker clients (the `withNoOrders` guard only covers `OrderClient`).
90. [OPEN] ANT orders are INTRADAY (MIS) by default, so AliceBlue squares them off at ~15:16-15:20 whatever the platform does; a strategy meant to carry ANT positions overnight must place LONGTERM (`ANT.ts` `product`). The MIS->NRML conversion (`POST /open-api/od/v1/conversion`) was denied by the auto-mode classifier at 14:55 and is untested.


## 2026-11-13 (SimpleContinuous kite state kept two phantom open legs)

97. [OPEN, NOT FIXED] A strategy instance that is not created (broker removed from `brokers:`, strategy block disabled-and-removed) keeps its `.<Strategy>.<id>.json` state file untouched, so open legs in it are invisible until the instance exists again (then the day check and reconcile handle it; a leg from an earlier day only gets the rollover ALERT). Nothing scans state files of absent instances at startup. Not done because it needs a decision on whether to delete/rewrite another instance's state file from a different process; the safe action today is to check `.Strategy.*.json` by hand after removing a broker from `brokers:`.


## 2026-11-13 (manual buy refused for a Breeze account; index+right manual buy sized to one lot)

103. [(a) FIXED IN CODE 2026-11-17, NOT LIVE YET, NOT LIVE-VERIFIED: a frontend manual buy above one freeze order is no longer clamped; `chunkedOrder.manualBuyChunked` places it as several orders (NIFTY 1755, SENSEX 1000) on Kite/ANT/Breeze, every chunk merges into the user's ONE bookkeeping row, a split position is protected by the in-app exit monitor on that row (no per-chunk GTT/bracket: restore keeps one GTT id and ANT exits via one antOrderNo, so several would be left live), and every exit route sells above-freeze quantities in freeze-sized chunks (`squareOffAutoChunked`); a chunk that fails/fills short stops the run and throws `partial` with what filled, the admin mirror keeps its share of the filled part. Contractor `resolveContractorQuantity` and the resting limit entry (`restingLimitBuyOnKite`, contractor recommendations) still clamp to one freeze order, deliberately left out (the resting path would need one resting order + entry-exit record per chunk). (c) is also reduced: the mirror share of an unfilled remainder is taken back. (b) below is still OPEN.] Older text: (a) Manual buys are one order per click on all three brokers; an investmentAmount buy larger than the freeze quantity (NIFTY 1755 = 27 lots, SENSEX 1000) is CLAMPED to the freeze quantity (logged), not chunked: exitMonitor is keyed per (user, token, broker), so several entries of one contract would leave all but the last chunk unmonitored; real chunking needs that fixed first. (b) `squareOffOnBreeze` prices its sell off Breeze's own `getOptionQuote` bestBid without the ANT cross-check the buys got (item 100): a stale Breeze bid would rest an unfillable sell until its re-price attempts. (c) A partial manual fill returns the filled part while the admin mirror (started in parallel for the full quantity) is not reduced.


## 2026-11-17 (SimpleContinuous max-profit trip left a losing PE leg with a resting sell above the market)

109. [OPEN, NEEDS THE USER'S DECISION, NO CODE CHANGED] SimpleContinuousStrategy-Prism 11:56:03 `MAX PROFIT TRIPPED - total=6217 threshold=5000 (realized=23400)`, then a resting sell of NIFTY17NOV26P25400 qty=780 @23.85 (entry 57.43, ltp later 15.8-17). Analysis: (a) the numbers do not disagree: `total` = `state.realizedPnl` (23400, three +7800 wins) + every open leg valued at its last tick from its entry (`profitTotalOf`): PE leg 780 x (ltp - 57.43), about -25k, plus the L5 CE leg about +8k = 6217; the cap is judged on realized + unrealized, not on realized. The trip fired because L5's rise lifted that total over 5000. (b) The 23.85 is `clearPrice` (`maxProfitLock.ts`): the price at which realized 23400 + L5 at its resting sell (+7800) + 780 x (p - 57.43) = 5000, by design "lock the cap, never dump at the bid" (user's rule 2026-11-13). Selling a leg below its entry on a trip is therefore intended when the strategy total is carried by other legs. The sell was at/above the floor (ltp - 5%) at placement, then the PE fell through it during the ~2 s Prism placement. (c) Once the market is below `clearPrice` the sell rests out of reach (`keepTripSell` keeps a sell that sits AT clearPrice even above the market) and, as documented in strategies.md, nothing drops it to the bid until the EOD close, so the leg is unmanaged and the loss is open. Not changed because making it dump to the bid when price falls through clearPrice reverses the user's 2026-11-13 rule (cap is a floor, no sell at the bid); needs the user to decide: (1) keep as is, (2) after N seconds / once the market is below clearPrice, sell at the marketable floor (accepting a total below the cap). The strategy is now `enabled: false`, so it is delivered no ticks or fills: the resting 23.85 sell, if it fills, will not be booked by the strategy (the EOD sync books it from the broker). Also: the global `settings.maxProfit` and the block `maxProfit` are the same 5000 here, so no scope mismatch.


## 2026-11-18 (two strategies on one Breeze account: phantom ScaledHedged leg, clamped Simple sell, rejected max-profit sell)

117. [OPEN, small, recorded not fixed] A fill that arrives while its strategy is disabled is not delivered (strategiesProcess.onFill) and a later `reconcile` closes the leg as 'closed outside the platform, neutral P&L, not added to realizedPnl' (live 2026-11-18 10:23:04: ScaledHedged-Breeze L5 PE sold @203.10 vs entry 193.10; Mongo `closedTrades` booked +650 and the order id is in `Trade`, but the strategy's `realizedPnl` 2697.50 lacks it, so the max-profit latch under-counts by 650). The real price is known to the order side (`closedTrades` / `Trade` by order id) but the strategy cannot ask for it today (`OrderClient.stats` returns every user's trades, no per-leg lookup); matching a closed trade to a leg by quantity+entry price is ambiguous when several legs share a contract (L1-L3 here), and `realizedPnl` feeds the max-profit latch, so a wrong match is unsafe. Needs a per-leg lookup by sell order id (the leg would have to store its sell order id) - the trader decides.


## Two failing tests of the full suite, and the unconfirmed ANT / Prism entry buy (2026-11-26)

149. [OPEN, SEV: med] Remaining gaps of the unconfirmed-buy path (code-read, not changed): (a) an ANT / Prism buy still inside its fill wait is not on the poller, so a strategy whose order call timed out first (a chunked buy longer than `ORDER_IPC_TIMEOUT_MS`) can still read "nothing bought"; (b) a placement whose reply was lost has no order id to track; (c) `BulkPcrStrategy.onOrderCancelled` and `HourlyStrategy.onOrderCancelled` do not check `action`, so a cancelled BUY notification on a contract in phase `selling` is handled as a cancelled resting sell.


## False max-profit trip above a resting sell, and the status script's resting-sell column (2026-11-26)

152. [OPEN, SEV: low] Quantity still valued at the LTP although a sell may rest (code-read): (a) global / overall monitors: sells placed before the restart that loads this fix have no stored price (the three chain strategies use the price recorded in their state file); (b) overall monitor: the target leg of an ANT bracket order (manual users with the GTT setting) is not in the pending trackers; (c) chain strategies: chunks that rested before a later chunk of the same placement failed are not counted until a reconcile or the shortfall path reads the pending sells. Unchanged by choice: the locked-price calculation (`clearPrice`) still counts another leg's resting sell at its own price even when that is above the market (existing lock semantics).


## Recommendation pending entry: no timer cancel (2026-11-26)

155. [OPEN, SEV: low] `LimitEntryStrategy.housekeeping` does not cancel (timeout, latch or EOD) the rest of an entry whose leg is already `closed` because its filled part was sold (multi-chunk or late fills): its `entryOpen` test takes only `resting` / `filled` legs (code-read, not changed).


## dist/ stale while `tsc -w` reports no error (2026-11-26)

162. [OPEN, SEV: medium, user's decision] The weekday cron jobs `5 10` `scripts/gapscreener-morning.sh` and `25 15` `scripts/gapscreener-eod.sh` run `npx tsc` in the live checkout (seen 2026-11-26 10:05:17-23: 612 files written in dist/). They compile whatever is in the working tree at that minute, uncommitted and unreviewed edits included, into the dist/ that the next restart loads. Not the cause of item 160; not changed.
163. [OPEN, SEV: low] `npm run server` uses `tsc-watch` without the `--watchFile` option of item 160 (standalone UI / API work only); not changed.


## Trading page: orders at the clicked price and NIFTY / SENSEX switch (2026-11-26)

165. [OPEN, SEV: high until done] Not live-verified. On the first live use check, per broker: the `limit buy at the clicked price` log line, the fill booked within seconds, `limit entry ... filled ... target / stop (GTT n | in-app exit monitor)`; for a square-off `GTT n deleted` before `square-off at the clicked price`, one resting sell at the broker, no GTT beside it, and `GTT n restored` after cancelling it. Cancel and a partial fill (cut after 20 s) are also unverified. SENSEX buys through Breeze have a code path but were never seen live.
166. [OPEN, SEV: medium, user's decision] ANT: a buy at the clicked price is a plain limit order with in-app target / stop (no ANT bracket, whatever `useGTT` says). A position held as an ANT bracket (bought by the market route / strategies) offers "Sell at market" only, and a clicked-price buy of that contract is refused. Prism positions: market only.
167. [OPEN, SEV: low] Remaining edges (code-read): (a) a clicked-price buy whose placement times out (outcome unknown) is not on the pending poller, as for every bare limit buy: a late fill is not booked; (b) a partly filled buy has no target / stop until it is cut (up to the 15 s poll plus 20 s grace); an unfilled buy left to expire at the close disappears from Pending orders without a notice; (c) a held contract with no tick for 30 s offers "Sell at market" only; (d) a position with no target / stop stays without one while its limit sell rests; (e) an in-app target hit while a limit sell rests above the target sells at market (exits unchanged); (f) the admin mirror sells at market when the user's limit sell fills, and a resting mirror buy is not cancelled when the user's already filled position is sold; (g) the displayed price is the ANT tick for every broker; (h) no tests were written for the new modules.
169. [OPEN, SEV: medium, code-read, pre-existing, not changed] `POST /order/buy` accepts `strikePrice` from a Beginner (`gateBuy` refuses only `contract`), so a hand-made request picks any strike. The new `/order/buy-locked` accepts a Beginner only for the strike the server put on their button.


## ANT fill fallback message and related gaps (2026-11-27)

175. [OPEN, SEV: low, code-read, not seen live] `resolveUnconfirmedAntBuy` raises manual review only when the trade book lists nothing while order history reports a fill; a trade book listing fewer than history's `filledQuantity` is booked at the smaller quantity. Whether the ANT trade book can lag that way is not verified.
176. Buy fill wait raised to 5 minutes on every broker (2026-11-27, user request; BUY_FILL_WAIT in src/util/fillWait.ts); sells and square-off exits unchanged. Items 173 (Breeze fill log wording) and 174 (ANT buy-to-close now settles / cancels after the wait) are FIXED in the same change. tsc clean, no tests run, trading and frontend restart pending. Open for the user: (a) partly filled lots of a waiting buy are booked and protected only when the order ends (up to 5 min, no target / stop meanwhile); (b) disabling a strategy does not cancel its waiting buy, and the buy call still records the leg and rests its sell; (c) BulkPcr, Hourly, TopStock, Butterfly tick handlers still await the buy (exits on the same handler can wait 5 min) and Continuous / LegManager refills queue on opLock behind a waiting spawn: review before enabling any of them; (d) a restart mid-wait books a manual / ANT target-only buy without target / stop, and ANT bracket / cover parents and buy-to-close orders are not on the pending list; (e) buy-to-close on Kite / Prism / Breeze (an exit) keeps its short wait; the BulkPcr / Hourly price-drift cancel and ExpiryStrategy / LegManager drift cancels are unchanged; (f) a lock-profits call made while a buy is partly filled needs a repeat call to sell those lots.
177. Kite GTT beside a platform sell (live 2026-11-27 10:18:03-10:18:11, GTT 346629657): fixed - every platform sell removes the position's GTTs first (order/gttRelease.ts), the in-app monitor holds target/stop (a hit cancels the resting sell, a max-profit lock sell included), the GTT is restored when the sell dies; ANT bracket / Prism cover rows refuse a second sell. Not run (tsc only, no tests), not live until the trading process restarts. Open: (a) setTargetStopLoss modifies the primary GTT to the whole row quantity while extra GTTs stay (GTTs can exceed the held quantity); (b) a max-profit lock cannot be placed on an ANT bracket / Prism cover position (it stays on its broker exit, ALERT retried); (c) no test yet for gttRelease; triggered-GTT result shape not verified live.
179. (2026-11-27) combinedMaxProfit rename and RecommendationStrategy max-profit exemption, tsc only. Open: (b) AdminPage help for `settings.maxProfit` is stale; (c) an old or misspelled config key turns the combined limit off with no error or log line.


## Trading page declutter (2026-11-27)

181. User request, replaces what items 164, 166 and 167(c) say about the page: no success panels; Up / Down show no price or contract; no Pending orders card (pending orders are under Active Positions, tag "Pending", Cancel only); "Square off" with no price and no confirmation; no selling at market from the trading page. Open, accepted with the plan: (a) an ANT bracket position cannot be exited from the page (only its broker target / stop); (b) with no live price for 30 s, or a server without locked orders, Square off is disabled; (c) while a sell is pending the exit is its fill, Cancel, or target / stop. Server change is message text only, applied by the orchestrator's held restart after 15:35. Not seen in a browser, not live-verified.

182. 2026-11-27 combinedMaxProfit ignores users' trades (rows booked under an email, util/realUser.ts): their P&L is not counted and its lock leaves their positions and resting orders alone; manual lock-profits unchanged. tsc clean; combinedMaxProfit.test updated, not run; the strategies-only lock has no test of its own and is not yet seen live (today's latch is locked: true).


## Trading page: one card after Buy, editable target / stop (2026-11-27)

183. (a) After a buy the page showed the Pending card and the position card together for up to about 1.7 s (the price stream's pending list is refreshed every 1.5 s; positions are pushed at once): an open row now lists its `buyOrderIds` and the page drops those pending cards. (b) Target / stop are editable under Active Positions; with it, `setTargetStopLoss` now stores edits for a restart, holds the stop to the loss budget, moves the in-app hard stop, keeps the old levels when the Kite GTT change fails, watches a one-sided level, refuses a level already crossed, and the route says why (409). Not seen in a browser, not live-verified. Open, limits: (i) a position sold within about 1.7 s of its buy fill can still show the stale Pending card alone; (ii) the crossed-level check uses the server's last price, which on a position with no target / stop is not refreshed by ticks; (iii) with several GTTs on one position, a failure part-way can leave some at the new levels while the page shows the old ones; (iv) a Beginner sees Edit and is refused with the reason.


## Platform (2026-11-27)

184. [SEV: med, uninvestigated] Platform processes warn at start that `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS certificate verification; where it is set was not checked.

## Code is loaded, live verification pending (title only; full text in git history before this cleanup)

- ScaledHedged had no PE hedge while its CE was at a loss
- a stop-loss sell fill never reached the strategy and its real P&L was lost (live 12:10:08-12:10:30, SimpleContinuousStrategy-ANT NIFTY01DEC26C25950, ...
- RecommendationStrategy only logged the LTP next to the order price, so a buy rested far below the market and was cancelled after 5 minutes
- SimpleContinuousStrategy left `hedged: true` with no hedge leg after an UNCONFIRMED hedge buy (live: Breeze L12 11:52-11:58 and L3 10:20; the leg ...
- SimpleContinuousStrategy stopped dead after the last leg's stop loss (live: Breeze 10:39:45, PE 25750 L3 closed at the stop and no CE order followed)
- false 'hedge buy may be live' manual-review latch (live: SimpleContinuousStrategy-Breeze, 10:20, NIFTY01DEC2625800CE order 202611253800001844 was ...
- paper was excluded from the status tables by the strategy's CURRENT config, so a strategy switched kite->paper mid-day lost its real P&L from BY ...
- lock-profits restart reconcile now books a leg that the platform's own sell closed as a normal close (see ToDo.md, first item, for the uncovered ...
- ANT master staleness alert
- `scripts/strategy-status.sh` BY BROKER unrealized now sums only the open positions of the strategies the other tables show (before: every open ...
- per-broker order queue (`src/util/brokerOrderQueue.ts`, `runOrderWrite`): every broker write (Kite place/GTT place/modify/delete/cancel in `Kite.ts`, ...
- ScaledHedged no longer ADDS to an open contract (rule D: `hedge()` returns after marking the trigger leg hedged when the fixed contract has an open ...
- max-profit/max-loss trips fail safe on NaN (finiteGuard.ts; SimpleContinuous, ScaledHedged, LegManager, PnlStop, global monitor; tests ...
- 2026-11-13: `/strategyPnl?opened=today` (status script default, `status all` for everything) is coded and unit-tested but NOT live: it needs a ...
- 82: Breeze tsym had no expiry (`NIFTY24950CE` = both the 09-Nov SimpleContinuous-Breeze 780 and the 17-Nov Momentum 390), so the 13:31 restart reconcile ...
- 83: `ConfigService.writeConfig` appended `%` to every `maxProfit`, including SimpleContinuousStrategy's, which is rupees (validation rejects a `%` there)
- 93: SimpleContinuousStrategy-Breeze tripped MAX PROFIT at 10:53 (`total=5044 threshold=5000`, 520 x NIFTY17NOV2625250PE) and `closeAllLegs` cancelled the ...
- 94: After the 11:36:05 restart `createWsSess` returned HTTP 500 and `dataProcess.ts` logged "will retry via reconnect", but nothing retried: ...
- 96: The kite `SimpleContinuousStrategy` state file kept L1/L2 (650 x NIFTY26N1725350CE / 25200PE) `open` after the broker sold them and the sync booked ...
- 98: ScaledHedgedStrategy-Breeze root buy 13:18:30 (order 202611133800007145): Breeze fill wait = 30 s order-notify push + 12 x 5 s REST poll + ...
- 99: When a buy IPC call still ends unconfirmed (timeout / unknown fill), the strategies parked for a human. `strategy/unconfirmedBuy.ts` (shared) cancels ...
- 100: Two Breeze buys "at best ask" in a row did not fill (13:18:30 25100CE @155.85, 13:20:28 25150CE @131.85, both resting `Ordered` until cancelled; ...
- 101: `manualBuy` for a user whose broker is `breeze` threw "no Breeze manual-buy primitive" (13:28:12, admin account)
- 102: The index+right branch of `manualBuyOnKite`/`manualBuyOnAnt` sized `req.quantity ?? one lot`, so an investmentAmount user got ONE lot (13:31:21, qty ...
- 104: SimpleContinuousStrategy double-up removed (user's decision 2026-11-13; ScaledHedgedStrategy already had none, 1a3c54e): a hedge leg's profit sell no ...
- 105: 2026-11-13 14:35 max-profit trip of ScaledHedgedStrategy-Breeze: (a) clearPrice was 41 for a 126 leg (other legs' realized 8450 already above the ...
- 106: 2026-11-13 15:05 manual square-off of MomentumAtFixedTime-NIFTY NIFTY17NOV26P25050 (ant, 325) was booked twice
- 107: 2026-11-16 10:50 duplicate sell of 520 NIFTY17NOV26P25200 on Prism (protectLeg target 91.50 order 26111600141317, then the global max-profit trip ...
- 108: 2026-11-16 10:50 the global max-profit latch is per broker, so an ANT entry buy resting when Prism tripped (order 26111600081396) filled at 10:52 ...
- 110: A max-profit locked-price sell had NO owner once placed: the order side only reported a broker cancel/reject (`pendingOrderTracker` -> `broadcast ...
- 111: Root cause, from the 10:00-10:02 log: ScaledHedged-Breeze's root buy hit a Breeze 429 ("outcome unknown", not tagged not-placed), so ...
- 113: The 112 locked sell was re-sent unchanged (585 @180.4, 10:01:59 to 10:08:37, 10 failures) against a refusal no retry can cure, and the leg had no ...
- 114: Root cause of the 112 refusals (verified from Mongo `pendingBreezeLimitOrders` and the strategy state files, not from Breeze's own order book, which ...
- 115: Root cause of 111/112/114's bookkeeping difference (verified from Mongo `Trade` + `orderOwners`): every fill of NIFTY23NOV2625300CE today is in Mongo ...
- 116: Retry storm of 112 (SimpleContinuous-Breeze locked sell 65 @180.4 refused by the never-short guard "covered by other users' resting sells", 20+ ...
- 118: The daily drawdown never counted the OPEN loss of Kite / Breeze / Prism positions: `getOpenUnrealizedPnL` resolved the ANT token with ...
- 119: Daily-drawdown open P&L (118) counted the manual Breeze NIFTY23NOV2625350CE (65) as 0 at every check: the only source was ANT's ScripDetails REST ...
- 120: SimpleContinuousStrategy-Prism root buy 10:00 placed limit buys of NIFTY23NOV26C25300 at 25282 and 25283.25 (the NIFTY index level; both rejected by ...
- 2026-11-20 10:09 Recommendation-1 (25500 CE, entry 130 / target 150 / stop 110, offset 5) filled at 123.95 and got the raw GTT 345711541 (150 / 110 = ...
- 121: Live 2026-11-20 11:16:34: ContinuousStrategy tripped max-profit and its mass close retried the sell of NIFTY26NOV25550CE 195 on every tick (65 ...
- 122: ROOT CAUSE behind 121: LegManager (ContinuousStrategy, SupportResistance) never compared its legs with the broker
- 123: A sell made outside the platform that took the platform's own lots is now booked (user decision A)
- 124: Kite sells are serialized per contract instead of refused (user decision B): `Kite.placeLimitSellOption` used `sellsInFlight` and threw 'NEVER-SHORT ...
- 125: lock-profits re-price race: `cancelAnyRestingLimitSell` (orderProcess.ts) now waits, bounded 45 s (`waitUntilNotResting`, BrokerExecutor.ts), after a ...
- 126: User decision 2026-11-20 'do it for all brokers': the non-platform-sell booking of item 123 now runs for ant, prism (Shoonya) and breeze. (1) Timed ...
- 127: User decision 'a manual sell should be booked whenever another trade happens, as and when the sell happens' + 'NEVER-SHORT guard tripped = fix the ...
- 128: MAX PROFIT trip placed a second full-size sell for an already-sold leg (live 2026-11-23: SimpleContinuous NIFTY26NOV25650CE 845; trip 10:02:30, trip ...
- 129: ScaledHedgedStrategy.reset() did not open the one-root gate (live 11:00:37: `Reset via admin request` then `gate: root already opened today` every ...
- 130: GET /broker/prism/trades returned `trades: []` with HTTP 200 while Prism had fills
- 131: `status net` (61,321) and `status` (61,280) differed per broker; ANT booked 83.20 below "the fills", Prism +2.60, Breeze +1.70. ROOT CAUSE (verified ...
- 132: User rule 'ExpiryStrategy should have maxProfit as 20000'. ROOT CAUSE: ExpiryStrategy is not in OWN_MAX_PROFIT, so the global monitor ...
- 133: GET /broker/paper/positions and /trades answered `[]` while Expiry-NIFTY held an open paper leg
- 134: Paper ExpiryStrategy produced 171 fills in 23 s (13:29:22-45, 86 buys at 58.6 / 85 sells at 61.6, qty 1690, ~430k fictitious profit, ~1,700 log lines)
- 135: User rule: orders intended as market / LTP orders use the best bid (buys) / best offer (sells), not the LTP. CENTRAL PATH: `getOrderPrice` ...
- 136: Expiry-NIFTY paper 14:18:41: a leg of 2470 (1755 + 715 parts) was booked as 3185 and `topUp` alerted every second (15x)
- 137: SimpleContinuousStrategy-ANT hedge buy of NIFTY01DEC26P25750 qty 195 (10:00:47-58): the target sell placed on the Buy COMPLETE was clamped 195 -> 65 ...
- 138: RuleBasedStrategy ignored `brokers:` and always bought/sold through the Prism-only path (`Strategy.buyContract` / `sellContract`, ...
- the 21c61f1 fix did not apply to Breeze: `getBreezeOrderFillInfo` (`src/processes/order/breezeExecutor.ts`) took `terminal = pending_quantity === 0`, ...
- 139: NEVER-SHORT guard firing when nobody shorted ("same contract name" report)
- 140: ANT buy NIFTY01DEC26P25700 (SimpleContinuousStrategy-ANT, 13:34:40) dropped as 'already stored in Mongo' and never registered in memory, so the ...
- 141: The class behind item 140 closed for good: one canonical order key and a same-day proof. (a) `src/util/orderKey.ts`: `orderKey(broker, id)` = ...
- 142: Tick store for option contracts (`tickHistory`)
- 143: ANT answers a flat account's positions call with `EC920` "Error: No positions found for this user."; the strict read (added 2026-11-24, e8ed508) ...
- 144: Day rollover ALERTed legs the platform's own lock sells had closed while the strategy was disabled (ScaledHedged, SimpleContinuous; same code in ...
- 147: The record above is only safe when the order process still knows the order: Kite and Breeze entry buys are on the pending-order poller from ...
- 148: `reset()` of a DISABLED SimpleContinuous / ScaledHedged / ExperimentalScaled strategy settled its pending records (cancel at the broker, a resting ...
- 150: SimpleContinuous (kite) tripped its 5000 cap at 10:00:31 on total 5233: a 455 leg bought at 194.95 with a sell resting at 204.95 was valued at LTP ...
- 153: User request (live 10:19:16-10:24:19, 25950 CE: entry cancelled unfilled after 5 minutes and the block disabled). `RecommendationStrategy` ignores ...
- 172: The ANT REST fallback logged "order-notify push was missed" for a push that was not missed
- 178: Item 177(a) fixed 2026-11-27: GTTs of a position are sized so together they never exceed what is held (gttRelease.modifyPositionGtts; used by ...
