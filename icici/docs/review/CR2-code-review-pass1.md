# CR2 pass 1: `/code-review medium d0d4af2..HEAD` (2026-11-24)

Range: d0d4af2..HEAD (HEAD 851f7fc), 104 files. The reviewer reported 10 findings. Each was re-checked against the code
here before being recorded. Verdict: CONFIRMED = the code does what the finding says. REFUTED = it does not. Impact lines
are my judgement and say so where they are inferred.
Status 2026-11-24: all confirmed findings fixed and re-reviewed; see CODE_REVIEW_2_PROGRESS.md "Fix verification".

| # | file:line | verdict | severity (mine) | finding |
|---|-----------|---------|-----------------|---------|
| 1 | src/processes/order/bookkeeping.ts:1131-1135 | CONFIRMED | medium | recordFill books a NaN/negative price at 0 (ALERT logged, "manual review required") and continues. For a Sell the aggregate P&L is then computed from 0. Before this change NaN poisoned the average instead, so it is arguably better, but a 0-priced Sell still feeds drawdown/lockout. Inferred, not run: the size of the P&L error. Fix idea: park the fill, or recover the price from the trade book. |
| 2 | src/processes/order/attachProtection.ts:77-80 | CONFIRMED (narrow) | low | cancelProtection unsets `gttTriggerId` on EVERY Buy doc of that tsym+user (any day) while deleting only `trade.gttTriggerId`. `extraGttTriggerIds` (other lots' GTTs) are neither deleted nor kept in Mongo after that. RecommendationStrategy normally has one lot, so the practical case is narrow. Fix idea: filter the update by the deleted id. |
| 3 | src/processes/order/BrokerExecutor.ts:287-303 | CONFIRMED, severity overstated | low | cancelAndRecheck now sleeps 1.5 s and reads again after every clean cancel. If the second read throws, it rethrows and the order stays tracked. This matches the existing rule for the first read ("leaving tracked, status unconfirmed"), so the order is not lost. Real cost: +1.5 s on every cancel, including stop-loss paths, and a cancel reported as failed after a read error. Whether a caller then skips its market stop is not checked. |
| 4 | src/orchestrator.ts:120-127 | CONFIRMED | medium-high | `quickCrashes` gives up after 10 consecutive crashes within 60 s of start (about 3 min with the backoff), for every role, including `trading`, which holds legs. It restarts only on a code change or orchestrator restart. This implements R01 #6 as written, but R01 did not say trading should be exempt. Fix idea: no give-up for `trading` (or a long cap and an alert). |
| 5 | src/routes/streams.ts:~140-153 | CONFIRMED | low (demo only) | The lease is refreshed only by /demo/subscribe, not by an open stream. After 30 min the sweep drops the hold even with subscribers still connected, deleting the whole count. |
| 6 | src/processes/order/bookkeeping.ts:2726 | REFUTED | - | A partial cut does keep an exit: releaseGtt (bookkeeping.ts:1494-1497) re-registers the in-app exitMonitor for the remaining quantity when target/stop prices exist. The comment at the call site states the release is deliberate. |
| 7 | src/processes/order/BrokerExecutor.ts:21-31 | CONFIRMED | low | After the 60 s timeout, `tail` still chains on the stuck holder, so each later sell on that contract waits 60 s again until the hung call returns. Needs a hung broker call to matter. Fix idea: after a timeout replace the map entry with a fresh resolved tail. |
| 8 | src/strategy/BulkPcrStrategy.ts:1756-1800 | MOSTLY REFUTED | nit | The scenario (an earlier chunk filled, then failure) cannot reach the error branch: that branch runs only when no chunk was placed. Left over: `pos.placingRebuy` is not cleared on the error / not-filled branches. It is stripped from persisted state (line 527) and reset on the next attempt (line 1756), so only a stale in-memory field. |
| 9 | src/kite/Kite.ts:33-43 | CONFIRMED | nit | `!type` marks any error without `error_type` as may-be-live, including local errors thrown before a send. OrderException (Kite rejected the order) is returned unmarked, neither not-placed nor may-be-live. How callers treat unmarked errors was not traced. |
| 10 | src/prism/ConfigService.ts:75-80 | CONFIRMED | nit | writeConfig re-adds any top-level key present on disk and absent from the new object, so a caller can no longer remove a top-level block through it. I did not search for a caller that does. |

Also verified: `npx tsc --noEmit -p .` is clean at HEAD (exit 0).

## Not done by this pass
- The reviewer hunts bugs in the diff. It did NOT check each "DONE" claim of PROGRESS.md passes 1-3 against the diff. That claim-by-claim mapping is still to do (rows S1-S6 "claims", S7).
- Tests were not run (the claim: 109/118 with the same 9 failures). Pass-3 note says the frontend was not rebuilt.
