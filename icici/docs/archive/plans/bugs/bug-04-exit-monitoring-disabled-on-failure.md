# Bug: Exit monitoring can be permanently disabled by any transient failure

## Problem

`handleOptionTick` in `src/processes/order/exitMonitor.ts` unregisters a
trade from the `monitored` map *before* attempting the broker exit call (to
prevent a second tick arriving mid-flight from double-firing the squareoff).
If that exit call throws/rejects (network hiccup, broker rate limit, any
transient error), the `catch` block only logs the error — it never
re-registers the trade. From that point on, the trade is no longer in
`monitored`, so every future tick for that token is silently ignored
(`if (!entry) return;` at the top of `handleOptionTick`). The position's
target/SL protection is permanently gone for the rest of the day (or until
the `order` process restarts and `reconcileFromTrades` picks it back up —
which itself only happens on restart, not automatically).

This is a live risk-management gap: a single transient failure during an
automated target/SL exit ends all further in-app protection on that
position, with no retry and no visible alarm beyond a log line.

## Root cause (exact files/lines)

File: `src/processes/order/exitMonitor.ts`

Function: `handleOptionTick` (lines 95-130 in the version read for this
plan; the target block is lines 111-129):

```ts
    const hitTarget = trade.targetPrice != null && quote.ltp >= trade.targetPrice;
    const hitStopLoss = trade.stopLossPrice != null && quote.ltp <= trade.stopLossPrice;
    if (!hitTarget && !hitStopLoss) return;

    // Unregister before awaiting the exit so a second tick arriving while the
    // squareoff is in flight can't trigger it twice.
    unregisterTrade(trade.token);
    Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

    const exitHandler = exitHandlers.get(broker);
    if (!exitHandler) {
        Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
        return;
    }
    try {
        await exitHandler(trade, exchange);
    } catch (e) {
        Log.log('[order] exitMonitor squareoff failed:', trade.tsym, e);
    }
```

The `catch` block at lines 127-128 is the bug: it logs and returns, leaving
the trade permanently unregistered. `unregisterTrade(trade.token)` at line
117 is the point where the trade is dropped; nothing ever undoes that drop
on failure.

The actual broker calls that can throw here are (both plain `axios`/API
calls that can fail transiently):
- `src/processes/order/zerodhaExecutor.ts:422-424` — `exitMonitor.onExit('zerodha', async (trade, exchange) => { await squareOffOnZerodha(trade.user, trade.tsym, trade.quantity, exchange); });`
- `src/processes/order/antExecutor.ts:343-345` — `exitMonitor.onExit('ant', async (trade, exchange) => { await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange); });`

## Dependency note (relationship to bug-03's key-structure change — apply after)

A separate, concurrently-planned fix ("bug-03: Cross-user protection loss on
shared contracts") is also changing `exitMonitor.ts`, specifically the
`monitored` map's key structure (currently `Map<string, MonitoredTrade>`
keyed by `trade.token` alone — see line 31 and `registerTrade` at line
54-58, `unregisterTrade` at line 60-64). Bug-03 is expected to change this
to something that supports multiple users per token (composite key, or a
nested map). **The exact final shape is not known to this plan.**

To stay structurally independent of that change, this fix is written to use
only the existing *public* functions `registerTrade(trade, exchange,
broker, watchOnly)` and `unregisterTrade(token)` — it does **not** touch the
`monitored` map directly, and does not assume the key is `trade.token`
alone. `registerTrade`/`unregisterTrade` are the abstraction boundary bug-03
is expected to preserve (both executors — `zerodhaExecutor.ts`,
`antExecutor.ts` — call `registerTrade` with the same signature regardless
of internal key structure), so re-registering via `registerTrade(trade,
exchange, broker, watchOnly)` in the `catch` block should continue to work
unmodified no matter what key scheme bug-03 introduces.

**Orchestration instruction: apply bug-03's change first, then apply this
fix on top of it.** When implementing this fix, re-open
`src/processes/order/exitMonitor.ts` as it exists *after* bug-03 has
landed, and re-locate `handleOptionTick`'s target/SL-hit block (it may have
moved line numbers, and the top of the function that computes `entry`/the
lookup key may look different — e.g. it might loop over multiple entries
for a token instead of a single `monitored.get(...)` call). Locate:
1. Where the trade's monitored entry is looked up/deleted (the
   post-bug-03 equivalent of today's `const entry = monitored.get(...)`
   and `unregisterTrade(trade.token)`).
2. The `try { await exitHandler(...) } catch (e) { ... }` block immediately
   after.

Then apply the same transformation described below: in the `catch` block,
call the same registration function/pattern that inserted this entry in the
first place (today that's `registerTrade(trade, exchange, broker,
watchOnly)` — use whatever the post-bug-03 equivalent is, with the same
`trade`, `exchange`, `broker`, `watchOnly` values that were in scope before
the entry was removed), so the entry goes back into monitoring exactly as
it was before the failed exit attempt. Do NOT reconstruct the entry from
scratch or guess at a new key — reuse the same local variables
(`trade`, `exchange`, `broker`, `watchOnly`) that were already destructured
near the top of `handleOptionTick` before the delete, since those are
independent of whatever key scheme is used internally.

**If bug-03 has not landed yet when this fix is implemented:** apply the
"Exact code changes" section below as-is against the current file (verified
against the file contents quoted in this plan). If line numbers have
drifted slightly due to unrelated changes, locate the block by matching the
`unregisterTrade(trade.token);` line and the `try { await exitHandler(...)`
block that follows it — the code shown below is otherwise verbatim from the
current file.

## Fix design (approach + rationale)

**Primary fix: unconditional re-registration on failure.** In the `catch`
block, call `registerTrade(trade, exchange, broker, watchOnly)` — the exact
same call (with the exact same arguments) that originally registered this
trade for monitoring. This uses the existing public API rather than poking
at the `monitored` map's internals, so it is robust to bug-03's key-shape
change (see Dependency note above).

`trade`, `exchange`, `broker`, and `watchOnly` are already destructured
from `entry` at the top of `handleOptionTick` (line 98:
`const { trade, exchange, broker, watchOnly } = entry;`), before
`unregisterTrade` is ever called — so no new capture step is needed; these
four local variables are already in scope inside the `catch` block and
already hold exactly the values that were in the map entry before it was
removed. (Note: by the time the code reaches the target/SL-hit block,
`watchOnly` is always `false` here — a `watchOnly` entry returns early at
line 109 and never reaches the exit-trigger code — but passing the
variable through, rather than hardcoding `false`, keeps the call symmetric
with the original registration and correct if that invariant ever changes.)

Unconditional (no retry cap/backoff) is the right call here:
- The failure mode being fixed is "a transient network/API error silently
  ends all protection for the rest of the day." Retrying indefinitely on
  every subsequent tick is exactly the desired behavior — worst case, the
  system keeps trying to protect the position, which is strictly better
  than giving up.
- A retry-count cap risks recreating the original bug in a different form:
  if the exit is failing for a *persistent* reason (e.g. bad order params),
  a hard cap would eventually stop protecting the position again, just
  after N tries instead of 1.
- The tick rate is naturally throttled by the market data feed, and each
  retry is a real attempt to close risk exposure, not a runaway loop — so
  there's no resource-exhaustion concern that would justify the added
  complexity of a cap/backoff.

**Deferred/optional enhancement (do NOT implement as part of this fix,
noted for future consideration only):** a lightweight failure counter
purely for *logging* visibility (e.g. include "attempt #N" in the log line
so repeated failures on the same trade are easy to spot in `server.log`)
would be a reasonable follow-up, but adds a small amount of extra state
(counter storage, reset-on-success logic) that isn't needed to fix the bug
itself. Skip it unless it can be added with a single extra field on
`MonitoredTrade` and zero behavior change — not required for this plan to
be considered complete.

## Exact code changes

### File: `src/processes/order/exitMonitor.ts`

Locate the `handleOptionTick` function (current lines 95-130). Replace the
final block of the function — from the `unregisterTrade` call through the
end of the function — as follows.

**Before** (current lines 115-130):

```ts
    // Unregister before awaiting the exit so a second tick arriving while the
    // squareoff is in flight can't trigger it twice.
    unregisterTrade(trade.token);
    Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

    const exitHandler = exitHandlers.get(broker);
    if (!exitHandler) {
        Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
        return;
    }
    try {
        await exitHandler(trade, exchange);
    } catch (e) {
        Log.log('[order] exitMonitor squareoff failed:', trade.tsym, e);
    }
}
```

**After:**

```ts
    // Unregister before awaiting the exit so a second tick arriving while the
    // squareoff is in flight can't trigger it twice. If the exit attempt
    // fails below, this trade is re-registered in the catch block so a
    // future tick can retry it - see the comment there.
    unregisterTrade(trade.token);
    Log.log(`[order] exitMonitor triggering squareoff for ${trade.tsym} (${trade.user}, ${broker}): ltp=${quote.ltp} hit=${hitTarget ? 'target' : 'stopLoss'}`);

    const exitHandler = exitHandlers.get(broker);
    if (!exitHandler) {
        Log.log(`[order] exitMonitor has no exit handler registered for broker '${broker}' - cannot square off`, trade.tsym);
        return;
    }
    try {
        await exitHandler(trade, exchange);
    } catch (e) {
        // A transient failure here (network hiccup, broker rate limit, etc.)
        // must not silently end target/SL protection on this position for
        // the rest of the day. Re-register with the same trade/exchange/
        // broker/watchOnly this entry was unregistered with above, so the
        // next tick retries the exit. Deliberately unconditional (no retry
        // cap/backoff) - worst case this keeps trying to protect the
        // position, which is the desired behavior; see bug-04 plan for
        // rationale.
        Log.log('[order] exitMonitor squareoff failed - re-registering for retry:', trade.tsym, e);
        registerTrade(trade, exchange, broker, watchOnly);
    }
}
```

No other changes to this file are needed. `registerTrade` is already
defined above `handleOptionTick` in the same file (lines 54-58), so no new
import is required.

### No other files change

`src/processes/order/zerodhaExecutor.ts` and
`src/processes/order/antExecutor.ts` are unaffected — their `onExit(...)`
registrations are the thing that throws; this fix only changes how
`exitMonitor.ts` reacts to that throw.

## New/changed test file (exact full file content)

Create a new file at `src/test/exitMonitorRetry.test.ts` with exactly this
content:

```ts
/**
 * Verifies exitMonitor.handleOptionTick re-registers a trade for monitoring
 * when its exit (target/SL squareoff) attempt fails, instead of silently
 * dropping protection for the rest of the day (bug-04).
 *
 * Uses only exitMonitor's public API (registerTrade/onExit/handleOptionTick)
 * - it does not reach into the internal `monitored` map, so it stays valid
 * regardless of the map's internal key structure (see bug-03, which changes
 * that structure independently of this fix).
 *
 * Run: npx tsc (compile), then: node ./dist/test/exitMonitorRetry.test.js
 */

import { Trade, OptionQuote } from '../model/model';
import * as exitMonitor from '../processes/order/exitMonitor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function makeTrade(): Trade {
    const t = new Trade();
    t.tsym = 'TESTOPT26AUG24100CE';
    t.token = 'exitmonitor-retry-tok1';
    t.quantity = 1;
    t.user = 'ExitMonitorRetryTestUser';
    t.targetPrice = 100;
    t.stopLossPrice = 50;
    return t;
}

function makeQuote(token: string, ltp: number): OptionQuote {
    const q = new OptionQuote();
    q.token = token;
    q.ltp = ltp;
    q.ltt = Date.now();
    return q;
}

async function main() {
    const trade = makeTrade();

    let exitCallCount = 0;
    let failNextCall = true;

    // Register the exit handler for a broker name unique to this test so it
    // can't collide with a real zerodha/ant handler if this module were ever
    // imported alongside orderProcess.ts (it isn't, by design - exitMonitor
    // avoids importing the executors to prevent a circular dependency).
    exitMonitor.onExit('zerodha', async (_trade: Trade, _exchange: 'NFO' | 'BFO') => {
        exitCallCount++;
        if (failNextCall) {
            failNextCall = false;
            throw new Error('simulated transient exit failure');
        }
        // second call succeeds - resolves normally
    });

    exitMonitor.registerTrade(trade, 'NFO', 'zerodha', false);

    // Tick 1: crosses target, exit handler throws. Before the fix, this
    // would drop the trade from monitoring permanently.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 1, `first tick triggers the exit attempt (got ${exitCallCount} call(s))`);

    // Tick 2: still above target. If the trade was re-registered after the
    // failure (the fix), this tick retries the exit and the handler is
    // called again (and this time succeeds). If the bug is present, the
    // trade is no longer monitored and this tick is a silent no-op.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 2, `second tick retries the exit after the first failure was re-registered (got ${exitCallCount} call(s))`);

    // Tick 3: exit already succeeded on tick 2, so the trade should have
    // been unregistered normally (not re-registered) - a further tick must
    // NOT trigger another exit attempt.
    await exitMonitor.handleOptionTick(makeQuote(trade.token, 100));
    assert(exitCallCount === 2, `no further exit attempts after a successful exit (got ${exitCallCount} call(s))`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

Notes for the executing agent on this test:
- `OptionQuote.token` and `OptionQuote.ltt` have no explicit type annotation
  in `src/model/model.ts` (implicit `any`) — assigning a string to `token`
  and a number to `ltt` is fine as-is; do not add type annotations to
  `model.ts`.
- `Trade.token` is typed `string` — `makeTrade()` sets it directly.
- This test intentionally does not import `orderProcess.ts`,
  `zerodhaExecutor.ts`, or `antExecutor.ts` — importing either executor
  would register its own real `onExit('zerodha', ...)` / `onExit('ant',
  ...)` handler (which calls real broker APIs), overwriting the test's fake
  handler if imported after it, or being overwritten by it if imported
  before. Only `exitMonitor` and `model` are imported, matching the file's
  own comment that `exitMonitor.ts` avoids importing the executors to
  prevent a circular dependency — the test relies on that same isolation.
- If, after bug-03 lands, `registerTrade`'s signature changes (e.g. an
  extra parameter), update the `exitMonitor.registerTrade(trade, 'NFO',
  'zerodha', false)` call in this test to match — the rest of the test
  (asserting `exitCallCount` transitions 0→1→2→2 across three ticks) does
  not need to change.

## Verification steps for orchestrator

Run these exact commands from the repo root (`/home/karthikeyan/work/icici`):

1. Type-check the whole project (no `build` npm script exists — this is a
   pre-existing gap, use `tsc` directly):

```bash
cd /home/karthikeyan/work/icici && npx tsc --noEmit
```

Expected: no output, exit code 0. (If pre-existing unrelated errors already
exist in the repo before this change, compare against a baseline run before
the fix to confirm this change introduces no *new* errors — but as of this
plan's investigation the repo compiles cleanly.)

2. Compile for real (needed to produce `dist/` for step 3):

```bash
cd /home/karthikeyan/work/icici && npx tsc
```

Expected: exit code 0, `dist/processes/order/exitMonitor.js` and
`dist/test/exitMonitorRetry.test.js` are produced/updated.

3. Run the new test:

```bash
cd /home/karthikeyan/work/icici && node ./dist/test/exitMonitorRetry.test.js
```

Expected output (order of PASS lines matches assertion order in the test;
JSON-line IPC output from `writeJsonLine` writing `subscribe`/`unsubscribe`
commands to stdout is expected interleaved and is not a failure):

```
  PASS: first tick triggers the exit attempt (got 1 call(s))
  PASS: second tick retries the exit after the first failure was re-registered (got 2 call(s))
  PASS: no further exit attempts after a successful exit (got 2 call(s))
ALL TESTS PASSED
```

Expected exit code: `0`. If any line reads `FAIL:` instead of `PASS:`, or
the final line reads `SOME TESTS FAILED`, the fix is not working — do not
mark this bug resolved.

4. Sanity-check the diff is scoped to the intended change:

```bash
cd /home/karthikeyan/work/icici && git status --short 2>/dev/null || echo "(not a git repo here - see CLAUDE.md/memory: use scripts/git.sh to sync into the mirror repo for actual commits)"
```

Note: per project memory, `/home/karthikeyan/work/icici` itself is not a
git repository — do not attempt `git diff`/`git commit` directly here.
Follow the project's documented `git.sh` rsync-to-mirror workflow if this
fix needs to be committed, or ask the user how they want it committed.

## Files touched

- `src/processes/order/exitMonitor.ts` — modified (`handleOptionTick`'s
  catch block re-registers the trade on exit failure).
- `src/test/exitMonitorRetry.test.ts` — new file (regression test for this
  fix).
