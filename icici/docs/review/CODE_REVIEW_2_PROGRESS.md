# Second review: verify the implementation of the R01-R15 findings

Separate from `PROGRESS.md` (the first, report-only review).
Baseline reviewed: `d0d4af2` (snapshot the review was done on). Reviewed range: `d0d4af2..HEAD` (HEAD at start = `851f7fc`; commits e8ed508, d8ff927, 851f7fc), 104 files, +927/-295 outside docs/.
Claims checked against: "Implementation pass 1/2/3" sections of `PROGRESS.md` (the DONE lists) and findings in `R01..R15.md`.
Uncommitted at start (not in range, not reviewed as code): `cloudflare/_worker.js`, `feature.md`, `PROGRESS.md`, `.claude/settings.local.json`. The worker change is checked in S6 because R01 #7 and R14 #2 claim it.

Per chunk: (a) does each DONE claim match the diff and fix its finding? (b) new bugs introduced? (c) claimed but not in the diff / in the diff but not claimed.
Status: TODO | IN-PROGRESS | DONE (date). Findings in `docs/review/CR2-<id>.md`. Resume: pick any non-DONE chunk.

## Last reviewed commit
Rule (user, 2026-11-24): every code review records the last commit id it covered, so the next review starts from it (`git diff <id>..HEAD`, plus `git diff HEAD` for uncommitted work).

| review | baseline (start) | last reviewed commit | uncommitted work at review time |
|---|---|---|---|
| First review R01-R15 (report only, `PROGRESS.md`) | not recorded | `d0d4af2` (2026-11-24 05:23 +0530, snapshot the review was done on) | - |
| Second review (this file) | `d0d4af2` | `851f7fc` (2026-11-24 07:20 +0530; includes e8ed508, d8ff927) | the fix agents' edits (Kite.ts, bookkeeping.ts, attachProtection.ts, BrokerExecutor.ts, orchestrator*.ts, ConfigService.ts, admin.ts, streams.ts, BulkPcrStrategy.ts, RateOfChangeStrategy.ts, supportResistance.ts and new tests) were reviewed in the working tree and are NOT in 851f7fc; the next review must start from the commit that contains them |

Next review: start at the commit that contains the second-review fixes (record its id here when it exists), then `git diff <that id>..HEAD`.

| id | scope | status | findings |
|----|-------|--------|----------|
| S1 | order process (bookkeeping, executors, chunkedOrder, entryExits, exitMonitor, attachProtection, orderProcess, PendingFillRegistry, keyedLock) | DONE 2026-11-24: claims checked (CR2-claims-check.md), bug pass done, findings fixed | pass-1 #1 (fixed, decision open), #2, #3, #7 FIXED+VERIFIED; #6 refuted |
| S2 | brokers and data (ANT, Kite, Breeze, prism, data streams, indicators, S/R, marketHours, quoteCrossCheck, momentum) | DONE 2026-11-24 | pass-1 #9 FIXED+VERIFIED (decision open); N3 FIXED+VERIFIED |
| S3 | runtime and API (orchestrator, server, streams, IPC, strategiesProcess, routes, level*, user) | DONE 2026-11-24 | pass-1 #4, #5, #10 FIXED+VERIFIED |
| S4 | strategies | DONE 2026-11-24 | pass-1 #8 FIXED+VERIFIED; N1 FIXED+VERIFIED |
| S5 | contractors, payouts, invoice, forecast, tools | DONE 2026-11-24, no findings | - |
| S6 | frontend, scripts, cloudflare worker, config.yml | DONE 2026-11-24, no findings (worker prefixes present in the uncommitted worker file) | - |
| S7 | cross-cutting | DONE 2026-11-24: tsc clean; `npm test` 115/124, the 9 failures are the same 9 that fail at baseline d0d4af2 (verified in a worktree build) | pre-existing stale tests, see below |

Pass 1 (`/code-review medium d0d4af2..HEAD`): 10 reported, 7 confirmed, 1 refuted, 1 mostly refuted, 1 overstated. Claim check: 2 more findings (N1, N3). All confirmed findings fixed by developer agents and re-reviewed (diff read, tsc, tests re-run by me where noted). Nothing committed (tree left uncommitted by instruction).

## Fix verification
| finding | fix | verified by |
|---|---|---|
| #1 unusable Sell price | Sell not booked, not marked processed, listed in `getUnresolvedFills()`; Buy still booked at 0 + ALERT | diff read; agent test reviewFixesBookkeepingGtt 13/13; DECISION OPEN (below) |
| #2 cancelProtection | deletes primary + extra GTTs, Mongo unset filtered by deleted ids, throws if a delete failed | diff read, same test |
| #3 cancelAndRecheck | second read best-effort after a clean cancel | diff read, same test |
| #7 withSellLock | later sells chain behind the timed-out sell | diff read, same test (env knob SELL_LOCK_MAX_WAIT_MS_TEST is test-only) |
| #4 orchestrator | trading never given up (alert every 10th); counters reset on hot restart; failed-spawn cap kept | diff read, orchestratorRestartPolicy test |
| #5 demo lease | refreshed while a demo option stream is open | diff read (no test: anonymous setInterval) |
| #10 writeConfig | opt-in `preserveTopLevelKeys`, only POST /config | diff read, configWritePreserveKeys test |
| #9 Kite classifier | OrderException and local Type/RangeError not-placed; network class and all unclassifiable errors may-be-live | diff read, kitePlacementClassifier test |
| #8 placingRebuy | cleared on the nothing-placed branch; stray fills ALERTed | diff read, bulkPcrRebuyPlacingFills test |
| N1 RoC | outcome recorded once, retry every 5 s | diff read; both new tests re-run by me: OK |
| N3 S/R | anchor price joins the range unless a tick sits on the cutoff | diff read; test re-run by me: OK |

## Open decisions for the user
1. #1: an unbooked Sell waits for a real-price redelivery or the EOD sync; nothing auto-surfaces `getUnresolvedFills()`. Wire it into reconcile / an alert? 
2. #9: GeneralException and DataException are now may-be-live (safe against a double order, but a definite refusal such as a rate-limit reply could latch a strategy slot). Keep or leave unmarked as before?
3. #4: should `trading` also be exempt from the 10-failed-spawn cap?

## Pre-existing, not from the review
9 tests fail at baseline d0d4af2 and still fail: antExecutorFillFallback (`getLiveQuote` missing on the mock), brokerParityMatrix, foreignSellBookingBrokers, limitEntryStrategies and replayFixes (limit price expectations vs the central order price), manualBuyBreeze and manualBuySizing (expired NIFTY17NOV26 Breeze contract), maxProfitLock, simpleContinuousOutsideClose. Not fixed (outside this review's findings) - awaiting the user's call.

## Round 2 of fixes (2026-11-24, after the user's answers) - all VERIFIED
User decisions: (1) unbooked Sells must be actively resolved; (2) use Kite's own rate-limit reply; (3) `trading` is given up like the others, limit 2; (4) fix the 9 stale tests.

| item | result | reviewed |
|---|---|---|
| 1 unbooked Sell | parked Sell triggers a debounced re-read of that broker's trade book (existing `runEodRepair`, one per broker per 60 s, never concurrent with another sync); 5-min timer re-requests it and repeats an ALERT every 15 min per entry after 15 min; `unresolvedFills {count, entries}` added to the order-process `stats`; strategy sees no fill until the sync books it (no strategy code changed) | diff read; reviewFixesBookkeepingGtt 19 PASS and 10 related bookkeeping tests (agent's report); the new orderProcess code has no unit test (module starts on import) |
| 2 Kite rate limit | SDK has no rate-limit class and no HTTP status on the rejected object; a 429 arrives as NetworkException 'Too Many Requests'. Classifier: /too many requests/i or numeric 429 -> definite refusal (not placed), checked before the network class; GeneralException/DataException stay may-be-live | diff read; kitePlacementClassifier test |
| 3 trading give-up | `trading` limit 2 for failed spawns AND quick crashes (my reading of the instruction; other roles 10); exemption removed; code change resets | diff read; orchestratorRestartPolicy test |
| 4 stale tests | all 9 were stale, no src bug: limitEntryStrategies and replayFixes (limitOffset no longer prices the entry, central best-bid price), brokerParityMatrix (Prism buys price via ANT live quote), simpleContinuousOutsideClose (read-only platformSells), antExecutorFillFallback (mock lacked getLiveQuote), foreignSellBookingBrokers (ANT trade-book rows carry a cumulative average and exchangeTradeId), maxProfitLock (code now waits for the order side's held quantity before cancelling), manualBuyBreeze and manualBuySizing (expired 17-Nov-2026 expiry, now run-time relative; manualBuyBreeze price expectation 120 -> 99, buy at best bid) | diffs read for 6 of 9 (the pricing group, the two Breeze tests); the ANT/foreign/maxProfitLock diffs were taken from the agent's report, not read by me |

Final verification: `npx tsc` clean; `node scripts/run-all-tests.js --no-build` = 124/124 passed.

Still open: Breeze 429 (HTML page from the proxy, seen in logs 11-16 and 11-18) is not treated as not-placed - not asked, not changed. Other expiry-dated symbol strings in tests (maxProfitLock, simpleNoDoubleUp, manualCloseRestore, foreignSellBookingEvents, exitMonitorBreeze) do not fail today.

## Last reviewed commit (updated)
Committed code reviewed up to `851f7fc`; HEAD is still `851f7fc`. All fixes of both rounds above are UNCOMMITTED in the working tree (that is what the user wants reviewed next). When they are committed, record that commit id here; the next review is `git diff 851f7fc..<that id>`.
