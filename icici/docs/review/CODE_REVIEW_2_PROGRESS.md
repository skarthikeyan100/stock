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

## Last reviewed commit (updated 2026-11-24, third review)
Second-review fixes committed as `a2c8f10` (they were reviewed in the working tree before the commit). Third review: `git diff 851f7fc..a2c8f10` (the committed form of those fixes) and later work starts at `a2c8f10`. Record the id covered by the third review below when it finishes.

## Third review - done 2026-11-24
`/code-review medium 851f7fc..a2c8f10`: 6 findings. #1 demo lease, #2 cancelProtection, #3 parked Sell key, #4 sell-lock env var, #5 Kite rate-limit match FIXED (tsc clean, 126/126 tests). #6 trading give-up limit 2: no code change, documented in Architecture.md.
Last reviewed commit: `447bcbc` (fixes) - the next review starts at `447bcbc`.
Open: demo lease is per client IP, so two tabs behind one IP share a lease.

## Fourth review - 2026-11-24
`/code-review medium a2c8f10..447bcbc`: 5 findings. Parked-sell clearing (only a matching Sell clears; per-fill keys) and per-IP demo lease counts FIXED; different-IP subscribe/stream limitation documented in Architecture.md; cancelProtection ordering verified correct, no change. Also pinned the market clock in antDataStreamRetry.test (it failed after 15:30). tsc clean, 126/126 tests.
Last reviewed commit: `447bcbc`; fixes are in `4527d8b`. The fifth review covers `447bcbc..4527d8b`.

## Fifth review - 2026-11-24
`/code-review medium 447bcbc..4527d8b` (+docs): 5 findings, all FIXED (parked-Sell dedupe by broker|user|tsym|qty with 200 cap, cleared only after a Sell is newly booked and by order id/qty or when the contract is flat; demo unsubscribe rejected for non-holder IPs; test restores the market clock; comment). tsc clean, 126/126.
Last reviewed commit: `4527d8b`; fixes are in `59d6def`. Sixth review covers `4527d8b..59d6def`.

## Sixth review - 2026-11-24
`/code-review medium 4527d8b..59d6def`: 6 findings. 5 fixed (late clear by order id on early-return paths; eviction ALERT + seen count; flat-clear logged and skipped when no tracked row existed; demo 403 kept, released by the 30-min lease sweep, comment added; test stub signature). The 6th (SessionEnd hook removed from .claude/settings.json) is not ours: working-tree change by the user, not touched. tsc clean, 126/126.
Last reviewed commit: `59d6def`; fixes are in `a36a96f`. Seventh review covers `59d6def..a36a96f`.

## Seventh review - 2026-11-24
`/code-review medium 59d6def..a36a96f`: 5 findings, all FIXED. Rule now: a parked Sell is cleared only when this process verifiably booked it into memory (bookedFillIds); the already-stored-in-Mongo path leaves it parked; hadRow needs qty>0; alert wording; demo comment. tsc clean, 126/126.
Last reviewed commit: `a36a96f`; fixes are in `0bf7fe8`. Eighth review covers `a36a96f..0bf7fe8`.

## Eighth review - 2026-11-24
`/code-review medium a36a96f..0bf7fe8`: 4 findings, all FIXED (central markSellBooked used by recordFill, foreign-sell sync, EOD sync and restore netting; stale ALERT text corrected; redelivery count seen-1; bookedFillIds is Sell-only, unpruned like processedFillIds). Still parked by design: a user fully closed in Mongo with no restored row. tsc clean, 126/126.
Last reviewed commit: `0bf7fe8`; fixes are in `58d9816`. Ninth review covers `0bf7fe8..58d9816`.
