# Fixes made in this session (2026-10-14)

Session record of code and config changes, what each fixes, and what is still open.
Live trading state at the time of writing: ANT flat, `BulkPcrStrategy` disabled in `config.yml`,
no processes running. Nothing in this file has been run against a live broker since the last restart.

## Incidents this session (context for the fixes)

| Time (IST) | What happened | Root cause |
|---|---|---|
| 10:35 | BulkPcr bought 650 NIFTY 22700 CE on ANT (order 26101400059996). Fill was not booked; bot recorded 0/650 and placed no exit. Manually squared off at 10:40 (+₹3,120 gross). | `ANT.getFillPrice` aborted on the first `ECONNRESET`, so a filled order was reported as unfilled. |
| 10:56 | Entry refused, strategy left in `error`. | ANT OHLC 429 burst; quote fell to 0; quantity −1 sizing refused. |
| 11:00 | BulkPcr bought 650 NIFTY 22750 PE, exited at 148.35 (+~₹1,300 gross). | Working as intended after quote-retry fix. |
| 11:35 | BulkPcr bought 585 NIFTY 22700 PE, exited at 163.5 (+₹1,930.50 booked). | Working as intended. |
| 11:39 | **Unintended second cycle**: BulkPcr bought 650 NIFTY 22700 PE at ~152.7 after a process restart re-armed the 11:35 slot. Exit sell 26101400089382 placed at 154.8 and still resting at last check. | Restart re-arms a slot that already ran; `config.yml` enabled flag persists across restarts. |

## Fixes, in order

### 1. Fill confirmation (`src/ant/ANT.ts`, `getFillPrice`)
- Transient transport errors (ECONNRESET etc.) no longer abort the 12-poll fill check; each poll retries.
- Auth and 4xx errors fail fast.
- A timeout with no successful poll says "fill status UNKNOWN", not "not filled".
- **Why:** the 10:35 fill was booked as 0/650 after one network error.

### 2. Unconfirmed buys are resolved, not dropped (`src/processes/order/antExecutor.ts`, `resolveUnconfirmedAntBuy`)
- Trade book first; a full fill is recorded as is.
- Otherwise the resting order is cancelled, the cancel waits for a terminal status, and the trade book is re-read.
- Any inability to establish the outcome throws for manual review with the order id.
- Bracket and cover parents are never auto-cancelled (cancelling would drop their protection legs).
- Trade-book lookup throws on any non-Ok answer rather than reading it as "nothing filled".

### 3. Transient errors vs real answers (`ANT.ts`)
- `isTransientPollError`: retry only network codes and 5xx/408/429. Auth and other 4xx return at once.
- A 200 response with a non-`Ok` envelope is treated as a real error, not as "no records yet".

### 4. Quote retries (`ANT.ts`, `antExecutor.ts`)
- **Commit `3f4606d`:** 429 quotes are retried, with a backoff, instead of refusing the entry.
- The OHLC throttle is serialised, so concurrent callers queue instead of firing together.
- One retry loop in `ANT.postOhlc`. Callers only choose the schedule (`retryDelaysMs`). The old `singleAttempt` and `rateLimitRetry` flags are gone.
- `Retry-After` is honoured as a floor, capped (3s inside postOhlc's single retry, 10s per sizing wait).
- Retries bypass the cache, and only positive prices are cached.
- `getQuote` throws on a zero or non-numeric LTP. A 0 can no longer become a limit price.
- Order-path quotes (`requireAntLtp`) refuse a missing or zero price rather than send an order at 0.
- Log lines carry status and message only. The raw axios error carries the session token in its headers.

### 5. Entry sizing (`antExecutor.ts`)
- Sizing quote bypasses the cache, so its timestamp is honest.
- The sizing quote is the entry price (`entryLtp`, reused for 5 seconds). If sizing already failed, entry refuses at once. It does not run the backoff a second time.
- Manual buys with an explicit quantity skip the price fetch.
- `enterManualBuy` is the one helper used by both manual-buy branches.
- An unsized buy with no quote is refused for every account type, because the entry also needs a limit price.
- Null quantity is treated as "not given" in both the sizing bypass and `resolveManualBuyQuantity`.

### 6. Exit path (`antExecutor.ts`, `squareOffOnAnt`)
- Exit quote is bounded (one 1.5s retry) and bypasses the cache.
- If no live quote: fall back to the trigger tick's LTP with a 3% floor, then re-price on a timer (see 8).
- No live quote and no trigger price: refuse with an alert. Never send a 0-price exit.
- No instrument token: refuse before any resting sell is touched.
- Stop-loss takes precedence over a resting exit sell. Resting sells for the same position are cancelled and booked, and only the remaining open quantity is exited (`openQuantity`, read from bookkeeping on each attempt).
- Square-off with nothing open and nothing resting is refused, not reported as sold.
- Exit sells are tracked in the pending-order poller, the same way a bare limit sell is.
- A fill is recorded only when the broker confirms it. A square-off that can't confirm its fill does not record a sale.
- A fill recorded by the square-off carries its broker order id, so `recordFill`'s dedupe catches a fill the poller already booked.

### 7. Cancel-and-book for resting sells (`cancelRestingSellForExit`, `bookSellFills`)
- Order is taken off the poller's book before cancelling, so a cancelled-listener cannot re-place a sell (the listener path is BulkPcr's `onOrderCancelled`).
- Re-tracked only if the cancel is not confirmed terminal.
- Fills are booked from the trade book. The status's own `filledQuantity` is cross-checked: if the status shows more filled than the trade book booked, the stop-loss stops for manual review.
- Resting sells are cancelled in parallel (`Promise.allSettled`). A failure in any one aborts the stop-loss with a clear error.

### 8. Re-price chain for unconfirmed exits (`recheckUnfilledExit`, `placeReplacementExit`)
- An exit that isn't confirmed filled is re-checked after a minute (immediately when the caller already waited).
- COMPLETE: fill booked from the trade book, order untracked.
- Still open or dead: cancelled, any partial booked, and what's left re-placed at 99% of live LTP. With no live quote it holds the last limit (no compounding discount).
- Up to 10 re-prices, then an alert with the sell left resting.
- One owner per position: the re-price check takes the same `pendingSquareOffs` lock as a square-off.
- Placement is **not** retried. A timed-out placement may already have been accepted, and a retry would sell the same quantity twice. The failure raises an alert.
- A failed cancel reschedules the check. A status read that fails twice reschedules the check.
- A re-price COMPLETE with no booked fill is an error, and the order is untracked only once booked.

### 9. Poller (`src/processes/order/pendingAntLimitOrders.ts`)
- A COMPLETE sell with no fill price takes its fill from the trade book, not dropped.
- The order is untracked only after its fill is booked, so a failed read is retried rather than lost.
- Status is re-checked after the await: an order taken off the book mid-poll is not acted on.
- A partly filled, cancelled sell books its partial fill and reports only the unfilled rest to the cancelled listener. Before this, it reported the full placed quantity.
- `findPendingOrdersForSymbol` is reused; `pendingAntSellsFor` filters it.

### 10. Bookkeeping dedupe (`src/processes/order/bookkeeping.ts`, `recordFill`)
- If a booking throws, its broker order id is released from `processedFillIds`, so the retry is processed instead of dropped as a duplicate.

### 11. BulkPcr auto-start (`src/strategy/BulkPcrAutoStartStrategy.ts`)
- Every slot attempt is recorded for the day in `.bulkpcr_armed_slots.json`, including skipped ones. A process restart no longer re-arms a slot that already ran (the 11:39 incident).
- If the record can't be written, the slot is not armed (fails closed).
- The file is listed in `.gitignore`.
- **Config:** `BulkPcrStrategy.enabled` is `false` in `config.yml`. Arming writes `true`, which persists across restarts. This is an open issue (see below).

### 12. Smaller items
- Stale and misplaced comments corrected in `ANT.ts` and `antExecutor.ts`.
- One terminal-status predicate (`isTerminalOrderStatus`) for the exit and entry paths.
- A dead condition in manual-buy sizing removed.
- `hasPendingAntSell` removed (unused).

## Still open (not fixed)

1. **Restart durability of the re-price timers.** They are in memory. A restart drops a pending re-price, and a resting sell can go unmanaged. The fix is to drive re-pricing from the Mongo-backed pending state.
2. **Restart entry window.** `BulkPcrStrategy.enabled: true` persists after arming. A restart can enter during 10:00–15:00 without a slot. The entry gate should also require an armed slot for today.
3. **Chunks of the same contract.** Resting sells are matched by user and symbol, so a stop-loss on one chunk can cancel another chunk's target. Needs a chunk identifier.
4. **Bracket and cover exits.** Only the single `existing` bracket is exited, and `exitBracketOrder` takes no quantity. A second bracket for the same symbol stays live.
5. **Bracket buy with a partial fill and a failed poll.** The partial is not booked; the entry throws for manual review.
6. **Square-off while a re-price holds the lock.** The stop-loss is refused with "already in progress" and not retried by the monitor.
7. **Duplicated fill-building code.** `bookSellFills` (antExecutor) and the poller's inline `Trade` build the same sell fill.
8. **Caller handling of `PENDING`.** `orderProcess` returns `ok: true` for an unconfirmed exit. The UI and callers need to treat `PENDING` as in-flight.
9. **Shared cancel logic.** `cancelRestingSellForExit` duplicates `cancelOrderWithFillRecheck` (BrokerExecutor.ts).
10. **Atomic write.** `.bulkpcr_armed_slots.json` is written in place. A crash mid-write leaves it unreadable, and an unreadable file is treated as empty. It should be written to a temp file and renamed, and an unreadable file should block arming.
11. **Token in logs.** `postOhlc` still rethrows the raw axios error after the final 429. Its headers carry the session token, and callers may log it.
12. **Concurrency window.** The re-price and square-off share a lock, but `cancelRestingSellForExit` can be called from the poller path without it.

## Review state
- Review loops on the exit path did not reach a clean pass during this session. Each round found new issues in the exit path, mainly from its several interacting owners (poller, square-off, re-price chain, cancel helper).
- Recommended: redesign the exit path as one persisted owner per position (see open items 1–4 and 6). Patching it further is what kept producing findings.

## Commits made this session

| Commit | Message (summary) | Status |
|---|---|---|
| `be83558` | Fix check-broker-sessions summary reporting all OK on failures | Pushed to `main` |
| `3b058a3` | Don't drop ANT buys whose fill the history poll couldn't confirm | Pushed to `main` (after review round 3) |
| `3f4606d` | Retry ANT quote 429s in sizing instead of refusing the entry | Pushed to `main` (after review) |
| `4f35384` | WIP: exit-path and ANT quote fixes through review loop 4 (not clean) | Local only, not pushed |

Uncommitted at the time of writing: the loop-5 changes listed in fix 13 below, and this file.

## Review rounds (exit path and quote path)

Each round below was a `code-review` pass with `medium` effort. A round is either clean (committed) or not (findings fixed or left open). Finding counts are approximate, taken from each round's report; the reports themselves are the authoritative record.

| Round | Scope | Result | Findings fixed | Findings left open |
|---|---|---|---|---|
| 1 | Quote fallback change | Not clean (10) | 2 cheap (zero price, comments) | design items (see Open) |
| 2 | Quote fallback follow-up | Not clean (8) | 3 | exit fallback re-pricing (decided: re-price at LTP) |
| 3 | Five-fix batch | Not clean (9) | 4 (poller race, cancelled-listener, sizing order) | retry layers consolidation (done in fix 4) |
| 4 | Stop-loss precedence | Not clean (6) | 2 (refusal removed; listed) | REJECTED stop-loss not thrown; re-price (decided) |
| 5 | Re-price chain (loop 1) | Not clean (11) | 6 | restart durability; bracket; chunks |
| 6 | Loop 2 | Not clean (10) | 6 | durability; caller PENDING handling |
| 7 | Loop 3 | Not clean (11) | 4 | durability; chunks; partial cancel |
| 8 | Loop 4 | Not clean (8) | 6 (this file, fixes 13) | placement duplicate (fixed by removing retry); bracket partial |
| 9 | Delta since `4f35384` | Pending | — | — |

## Questions raised and decisions taken

These are the questions I asked during the session and the answers you gave. Each decision is in the fixes above.

1. **After the 11:35 run.** Asked whether to set `BulkPcrStrategy.enabled` back to `false`. You said yes, and I did.
2. **Restart at 11:39.** Asked whether to square off the unintended 650 PE position manually. You said let the resting sell fill and you would inform. I left the sell in place.
3. **Restart with an open position.** Asked before restarting with the exit still resting. You said restart now; I restarted, then verified the exit was still tracked.
4. **Kill all processes.** You said kill all processes; I stopped them. Nothing was restarted afterwards.
5. **Exit design, three options.** I asked for (A) stop-loss precedence over a resting target sell, or (B) cancel the target. You chose stop-loss precedence.
6. **Fallback re-pricing.** Asked whether a stop-loss sitting at the fallback floor should be re-priced. You said re-price at LTP. Implemented in fix 8.
7. **Bracket and cover exits.** Not yet decided. Open item 4.
8. **Restart durability of re-price timers.** Not yet decided. Open item 1.
9. **Chunk ownership.** Not yet decided. Open item 3.
10. **Exit design: stop or redesign.** Asked whether to stop patching the exit path or redesign it as one persisted owner per position. You said keep looping, then to fix all findings and not start the processes. The redesign is **not** done.
11. **Haiku-fixes.md filename.** Asked by reading "Haiuk" as "Haiku". Stated in my reply; you have not objected.
12. **Commit policy.** Asked whether to commit after every review round so each review covers only the delta. You confirmed. Commits `4f35384` and the later rounds follow that.
13. **Commit and push.** Asked before pushing unreviewed live-trading code. You said fix, send for review, commit and push, with no processes started. The loop-5 push waits on its review.

## Fixes made in the final round (fix 13)

Made after the loop-4 review, in response to its findings:

- **Placement not retried.** A re-price placement that times out may already have been accepted by the broker. Retrying would sell the same quantity twice, so the placement is no longer retried. The failure raises an alert and leaves the position for manual action.
- **Partly filled, cancelled sell.** The poller books its partial fill and reports only the unfilled rest to the cancelled listener. The listener previously received the full placed quantity, so the strategy could re-place a full-size exit over shares already sold.
- **Dedupe release on a failed booking.** `bookkeeping.recordFill` removes the broker order id from its dedupe set if booking throws, so a retry is processed.
- **Status read that fails twice.** The re-price check reschedules itself instead of ending the chain silently.
- **Shared terminal predicate.** One `isTerminalOrderStatus` replaces two copies.
- **Stale comment and dead condition.** The comment about the no-quote path was contradicted by the code below it. A dead condition in manual-buy sizing is removed.

## Review findings still open (not fixed)

From the loop-4 review and the rounds before it:

- **Bracket buy with a partial fill and a failed poll** (`resolveUnconfirmedAntBuy`, `mayCancel=false`). The partial is not booked. The entry throws for manual review, leaving a live partial position unmonitored.
- **Bracket exit ignores quantity.** `exitBracketOrder` takes no quantity, so a partly sold bracket may be exited in full. Depends on AliceBlue's BO exit semantics, which are not verified.
- **Two brackets for one symbol.** Only `existing` is exited. The other stays live.
- **Caller treatment of `PENDING`.** `orderProcess` returns `ok: true` for an unconfirmed exit. Callers and the UI need to treat `PENDING` as in-flight.
- **Square-off refused while a re-price holds the lock.** The stop-loss is refused with "already in progress" and is not retried by the monitor.
- **Restart durability.** The re-price timers are in memory (open item 1).
- **Chunk ownership** (open item 3).
- **Duplicated fill-building code** in `bookSellFills` and the poller.
- **Shared cancel logic** with `cancelOrderWithFillRecheck`.
- **Atomic write** for `.bulkpcr_armed_slots.json`. An unreadable file is treated as empty, which can re-arm a slot.
- **Token in logs** from the raw axios error after the final 429 in `postOhlc`.
- **Concurrency window** in `cancelRestingSellForExit` when called from the poller path without the lock.

## Before the next trading day
- Do not start the processes until items 2 and 1 are resolved, or at least until the strategy is confirmed disabled in `config.yml` and in memory after startup.
- Check `/broker/ant/trades` for the 26101400089382 resting sell and the 650 NIFTY 22700 PE position first (see the last live state in the session log).
