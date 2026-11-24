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

## Implementation pass 1 (2026-11-24, uncommitted - awaiting user-triggered code review)
Scope: all non-security findings (credentials, CSRF, auth, authz, KYC crypto, sessions left out by instruction). `npx tsc` clean; `npm test` 109/118, the same 9 failures as before this pass (antExecutorFillFallback, brokerParityMatrix, foreignSellBookingBrokers, limitEntryStrategies, manualBuyBreeze, manualBuySizing, maxProfitLock, replayFixes, simpleContinuousOutsideClose).

DONE
- R01: #3 watch lists (broker/, prism, user, level*, OrderClient), #4 suppressed change stays pending and applies after 15:35, #5 no spawn after shutdown, #6 crash-loop give-up, #7 worker `/strategyPnl` `/sync`, #9 tick-handler isolation, #13 stale comments.
- R02: #1/#2/#3 Breeze socket reset on disconnect, single `stock` listener, revive after server disconnect/auth error; #5 S/R span confirm; #9 flat RSI = 50; #14 ANT reconnect backoff.
- R03: #1 strict ANT positions/trades reads in bookkeeping; #2/#3 ANT + Kite placement errors tagged (not-placed vs may-be-live); #10 PendingFillRegistry waiters; #11 buyChunked stops on a short chunk; #12 price-0 trade-book fill.
- R04: #3 Prism partial fills carry avgprc; #5/#6 Breeze trade book covers NFO+BFO and an empty day is not an error; #7 Breeze placeOrder refusal tagged not-placed.
- R05: #2 (see R03 #1); #9 fill/positions listeners isolated; #10 NaN/negative price and non-positive quantity guard in recordFill.
- R06: #1 EOD marker only counts after the EOD time; #2 SENSEX expiry-day sweep (additive: NIFTY behaviour unchanged); #6 startup reconcile retries failed strategies; #7 resting-entry protection retried 3x.
- R07: F1 Expiry `maxProfit` no longer rewritten to "N%"; F2 LimitEntry state file atomic + fail closed on unreadable file; F3 stale `exitRetryAt = -1` cleared on load; F5 LimitEntry reconcile no longer swallows a failed read; F6 removed block disables its instance; F11 TopStock reset clears the global latch; F16 TrailStop NaN activation.
- R08: #4 AutoStart skips a target that has not reconciled; #8 NaN-safe loss cut / cooldown.
- R09: #1 Hourly entry now fires on the candle open that follows the confirming close; #3 failed hedge of a closed leg is retried (Simple + Scaled, ~30 s apart); #6/#7 PCR fetch throttled after a failure, NaN PCR rejected.
- R10: F1 TargetReach persists "fired today"; F2 Butterfly adopts an unknown-outcome short before buying back; F7 Sentiment add-on/sell failures clear `orderPlaced`.
- R11: #1 Momentum / #2 NiftyChange stale previous-slot price.
- R12: #2 Advanced target 0 falls back to the global target; #14 `right` must be call/put; #17 lock-profits restores `enabled` if the config write fails.
- R13: F3 invoice-received reopens an invoice-closed account (and pushes to the order process); F6 overdue-invoice flag only once the pause applied; F16 reminder not stamped when mail is not configured.
- R14: #1 POST /config keeps top-level blocks such as `forecast:`; #2 `/act-as` added to the Cloudflare worker and the Vite proxy.
- R15: #1 migrate-profit-split needs `--to N --apply`; #4 deploy.sh excludes per-strategy state files; #8 gap-screener cover order honours `enabled`; #16 `tail -F`.

DEFERRED (needs a user decision or a larger design change)
- R01 #2 mock mode, #10 stream coalescing, #11 job timers, #12 socket takeover guard; R02 #4 ANT tick-silence watchdog, #6, #7, #8; R03 #4-#9, #13; R04 #4, #8-#10, #12, #14; R05 #1 short-leg restore, #3-#8, #11-#19; R06 #3 (author's documented design: PENDING must not be retried), #4, #5, #8, #12-#18; R07 F4, F7-F10, F12-F15, F17; R08 #1-#3, #5-#7, #9-#11; R09 #2 (`srHypothesis` block missing from config.yml - needs a config decision), #4, #5, #8-#14; R10 F3-F6, F8-F16; R11 #3-#12; R12 #3-#13, #15-#18; R13 F2, F4-F5, F7-F15, F17-F23; R14 #3-#15; R15 #2, #3, #5-#7, #9-#15, #17-#19.
- Reverted on purpose: R13 F1 (enforcing SEBI on submission) - contractorRecommendations.test.js asserts "no SEBI registration is needed to submit"; the owner must decide which is intended.

## Implementation pass 2 (2026-11-24, uncommitted)
Decisions: SEBI is NOT enforced on submission (R13 F1 closed as "not wanted"). R06 #3 left as is (by design). `srHypothesis` (detector tuning for SupportResistanceStrategy and its offline test/backtest; live code, not test-only) restored to config.yml with its historical values from git (b3f4d78^). Tests: 109/118, the same 9 failures as the baseline.

DONE in pass 2
- R02 #12 separate silence-alert timer; R03 #4 bracket/cover entry timeout cancels the parent, #5 ANT market exits take the sell lock, #6 bracket exit books the whole position, #7 second read after a cancel before untracking, #9 order-notify retry after a token failure; R04 crossCheckQuote empty-source guard.
- R05 #1 short legs restored from Mongo (today's SellToOpen/BuyToClose net), #3 every lot's GTT id and the earliest entry time restored, #4 GTT released when a trade is dropped/cut by sync or attribution, #8 sell-lock wait bounded (60 s), #12 session P&L and warnings reset per day, #16 raw fill insert retried.
- R06 #4 setTargetStopLoss arms the in-app watch for a Kite/ANT leg with no GTT and refuses an ANT bracket, #8 lock-profits repeat skips while the prior sell is still resting, #17 paper rows skipped by reconcileFromTrades and cancelProtection clears the stored GTT id.
- R08 #1 lockouts persisted/loaded for every pair broker, #2 re-buy fills during placement replayed, #3 unconfirmed re-buy latches the broker, #6 finishIfFlat after the early-close paths.
- R10 F4 Butterfly keeps the token watch while another broker uses it, F6 Recommendation reverse refused on SENSEX.
- R12 #8 admin-forced Advanced no longer records a fabricated acceptance.
- R13 F5 statement jobs catch up (Wed-Fri / days 1-3), F8 failed invite acceptance removes the user row it created, F14/F15 IST dates.

## Remaining items, split (2026-11-24)
Item ids are "<chunk> #n" (R07 uses F-numbers). Security items (auth, CSRF, credentials, sessions, KYC crypto) are excluded by instruction and not listed.

### A. SAFE TO IMPLEMENT (no design decision; being done in pass 3 - see "Pass 3 result" below for what actually landed)
R01 #10 position-stream sequencing, #11 first run of frontend jobs; R02 #10 prevClose per-day reset, #11 momentum ranking `|| 1`; R03 #14 Kite non-positive price guard; R04 #4 Breeze order socket after re-login, #9 breezeTsym silent fallback log, #14 paper stale exit tick; R05 #10 NaN guards in drawdown/realized P&L, #20 repair script mongo URL; R06 #16 lock-profits rows without broker; R07 F13 comment fix; R08 #11a lastStuckCause reset, #11 placingKeys counter; R09 #10 Scaled header comment, #12 Hourly entry into an invalidated level; R10 F10 TopStock reset clears the day marker, F13 Butterfly dead code, F15 RateOfChange/RuleBased small fixes; R11 #6 stale "LTP" comments, #12 Breakout candle 1 persisted at once; R12 #12 KYC PDF size guard, #13 demo hold lease; R13 F10 limit races (in-process), F18 invoice tax line, F19 tool entry points pin TZ, F21 orphan statements, F23 comments; R14 #4 position card key, #7 IST in filters/ticker, #8 dead links, #10 UI text, #12 join page preview race, #15 patchVerify; R15 #7 gapscreener compile + timeout, #11 repair script tz, #12 shell TZ, #13 download-masters temp files, #14 strategy-db freeze size, #15 monitor header, #17/#18 doc/default notes.

### B. NEEDS YOUR DECISION
R01 #2 mock mode (fix or remove), #12 refuse to start when another instance owns a socket; R02 #4 ANT tick-silence watchdog (what to do when ticks stop), #7 seed/persist the live 300 s candles, #8 ADX/Stochastic need real highs/lows; R03 #8 Kite GTT vs an in-app exit, #17 Kite master daily vs monthly refresh (memory says monthly), #13 buy-to-close resolution scope; R04 #8 Prism master (refresh/exact expiry/BFO), #10 ANT strike step for other indices, #12 migration script coverage; R05 #5 FIFO vs average cost, #6 gate "would exceed cap", #7 durable-state ordering, #13 brokerCapOverride is in-memory (CLAUDE.md forbids; needs a Mongo design), #14 rebuild reservations after restart, #15 recordFill ordering, #17 gates fail open until limits load, #18 lot size by name, #19 mergeRestored only adds; R06 #13 admin mirror skips gates, #18 on-demand sync blocks protective orders, #12 write drain on stop; R07 F4 exit abandoned after 10 attempts, F7 enabling at runtime forces a reconcile, F8 15:25 to eodCloseTime gap, F9 LegManager maxProfit day-scoped/fail-closed, F12 rejected config alert, F14/F15/F17; R08 #5/#10 (crash windows), #7/#9 doc vs behaviour; R09 #4 SR unconfirmed-buy latch, #5 persist pending root, #8 SR entry window, #9 Hourly last candle; R10 F3 Butterfly failed sell leaves wings, F5 sign of adopted position, F8 Sentiment partial sells, F9 TopStock window vs first tick, F11 GoodMorning previous close, F12 day state in memory, F14, F16; R11 #3/#5/#8 docs, #4 Expiry loss bound, #7 stop twice the target (config), #9, #10 Momentum depth broker, #11 hardcoded 'ant' unwatch; R12 #3 loss-cap bypass, #4 atomic caps, #9 DRAFT wording, #10 erasure, #11 farmable weeks, #15 legal text, #17 manual buys vs lock, #18 emails; R13 F2 atomic forecast limit (needs an index), F7 fee-model change mid-week, F9 approve edge cases, F11, F17 payout constraints, F20, F22; R14 #3 admin deep-link on reload, #5 symbols.txt refresh in the build, #6 lot sizes from the master, #9 dead code deletion, #11 confirmation dialogs, #13 stale-data banner, #14 strategy tab; R15 #2 POST /config diff-based, #5 welcome-email dry-run, #6 rollback, #9 syncQuotes, #10 kill-stale guard.

### C. CANNOT BE VERIFIED FROM CODE (or latent today)
R02 #6 ANT `cf` ack meaning; R03 #18 other-index freeze quantity (latent); R05 #11 broker order id overlap; R06 #15; R09 #11, #13, #14; R10 F4 done, F14 (ranking without options: needs live master check); R11 #9.

## Pass 3 result (2026-11-24, uncommitted) - group A
`npx tsc` clean (backend and frontend), tests 109/118 = the same 9 failures as the baseline. The frontend was NOT rebuilt or deployed (the memory note says to run the full `npm run build` after frontend changes - do that when you accept the diff).

DONE: R01 #10 (position fan-out sequenced), #11 (invoice/contractor jobs also run 2-3 min after start); R02 #10 (prevClose per day), #11 (momentum: a missing half is skipped); R03 #14 (Kite refuses a non-positive limit price as not-placed); R04 #4 (Breeze order socket rebuilt after a re-login), #9 (ALERT when a Breeze expiry cannot be read), #14 (paper market exits need a fresh tick); R05 #10 (NaN guards in drawdownDecision and realized P&L), #20 (repair script uses MONGO_URL); R06 #16 (a row with no broker counts as Kite in lock-profits); R07 F13 (comment); R08 #11 (placingKeys is a counter; stuck alert once per cause per day); R09 #10 (Scaled header note), #12 (Hourly skips an entry that opens through its invalidation level); R10 F10 (TopStock reset removes the fired-today marker), F13 (dead resumeOrPlaceSellLegs removed), F15 (RoC retries a failed timeout sell; RuleBased refuses quantity <= 0); R11 #6 (entry-price wording), #12 (Breakout stores candle 1 at its close and never overwrites it with null); R12 #12 (KYC PDF page-size guard, OCR queue bound), #13 (demo holds expire after 30 min); R13 F10 (per-contractor locks for forecast, recommendation and the active-contractor cap), F18 (invoice tax line matches computeTax), F19 (tool entry points pin IST), F21 (orphan statements are tax-locked), F23 (comments; the POST /owner/agreements PDF-before-schedule ordering was left as is); R14 #4 (position card key), #7 (IST day/week and ticker time), #8 (dead links removed, acting-as landing), #10 (UI text, Lot Count disabled for Beginner, server reason shown), #12 (join preview race and blob revoke), #15 (patchVerify reports a refusal); R15 #7 (cron wrappers build first, screener run has a 20 min timeout), #11 (Kite fill time read as IST), #12 (shell dates use IST), #13 (verified: the Prism temp files are already removed), #14 (SENSEX freeze size in strategy-db), #15 (monitor header), #17/#18 (documented: trailingDistance is unread, AppConfig defaults are not applied).

PARTLY DONE / NOT DONE from group A: R08 #11 (the `enterOnBroker` retry still does not re-check `isBrokerStopped`); R10 F13 (Butterfly NaN target/stop and empty-brokers points left); R13 F23(c).

## Pass 4 (2026-11-24)
Done: R08 #11 (entry retry re-checks the lockout/EOD after its wait), R10 F13 (Butterfly refuses to arm on a non-positive target/stop or an empty broker list), R13 F23(c) (a failed agreement scheduling removes the PDFs it wrote). Group A is complete. `src/` was committed (e8ed508); everything outside `src/` (frontend, scripts, config.yml, docs, package.json, cloudflare) is still uncommitted. Group B as a table: docs/review/group-B-decisions.html.
