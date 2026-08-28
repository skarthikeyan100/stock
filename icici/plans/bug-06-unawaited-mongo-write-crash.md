# Bug: Live-path Mongo writes can crash the order process

## Problem

`src/processes/order/bookkeeping.ts` records every completed trade fill by
calling `Mongo.getInstance()?.insert(tradeEvent)` inside `_processTradeEvent`
(around line 415), wrapped in a `try { ... } catch (e) { /* Mongo not
available */ }` block. `insert()` is `async` and its call is **not
`await`ed**, so the `try/catch` around it is a no-op for the case that
actually matters: if the returned promise **rejects** (transient Mongo
connection error, validation error, timeout), that rejection happens after
`_processTradeEvent` has already returned — nothing is there to catch it. It
becomes an **unhandled promise rejection**.

No `process.on('unhandledRejection', ...)` handler exists anywhere in the
repo. Node's default behavior for an unhandled rejection (on modern Node, the
version this repo targets — see `package.json`/`.nvmrc` if present, otherwise
assume Node ≥15 default `throw`) is to **crash the process**. Since this
bookkeeping code runs live, in the `order` process, on every trade fill, a
transient Mongo hiccup during a trade-event write can crash the entire
`order` process — losing all in-flight risk state (`bookkeeping.trades`,
pending order attribution, GTT tracking, per-user P&L) until the process is
restarted.

## Root cause (exact files/lines)

- **Primary bug:** `src/processes/order/bookkeeping.ts`, method
  `_processTradeEvent` (starts at line 412), lines 414–418:

  ```typescript
      private async _processTradeEvent(tradeEvent: Trade) {
          Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
          try {
              Mongo.getInstance()?.insert(tradeEvent);
          } catch (e) {
              /* Mongo not available */
          }
  ```

  The `try/catch` can only catch a *synchronous* throw (e.g. if
  `Mongo.getInstance()` itself threw, which it doesn't — it just returns
  `undefined` if uninitialized). It cannot catch the async rejection from the
  un-awaited `insert(tradeEvent)` call.

- **Confirms `insert()` can reject:** `src/tools/mongo.ts`, lines 62–64:

  ```typescript
      insert = async (obj) => {
          await this.db.collection(obj.constructor.name).insertOne(obj)
      }
  ```

  `insertOne` on a MongoDB driver `Collection` returns a promise that rejects
  on connection loss, write errors, validation errors, etc. Since `insert` is
  `async` and awaits it internally, any such rejection propagates as a
  rejection of the promise `insert()` returns.

- **No global safety net:** repo-wide search confirms there is no
  `process.on('unhandledRejection', ...)` anywhere (checked via `grep -rn
  "unhandledRejection" src/`, zero matches).

- **Secondary/out-of-scope (documented, not fixed by this plan):** the same
  un-awaited-Mongo-write-in-try/catch pattern also exists in
  `src/monitor.ts:397,485` (this file is legacy/unused per `CLAUDE.md`'s
  "Live trading process split" note — **do not touch `monitor.ts`** as part
  of this fix) and un-guarded entirely (no try/catch at all) in
  `src/decision.ts`, `src/trade/option.ts`, `src/trade/option-plus.ts`,
  `src/trade/icici.ts`. These are legacy/lower-priority paths per the bug
  report. The global `unhandledRejection` handler added below (see "Fix
  design") provides a safety net for these too, so they are not orphaned by
  scoping this fix to `bookkeeping.ts`.

## Fix design

Two complementary changes:

### 1. `bookkeeping.ts:415` — attach `.catch()`, do NOT `await`

**Decision: use `.catch()`, not `await`.** Reasoning:

- `_processTradeEvent` is on the hot path for every trade fill: it's called
  (via `recordFill`, always `await`ed) from the live fill-processing pipeline
  that updates `this.trades`, `this.userPnL`, drawdown checks, and
  `fillListeners` (which broadcast fill/position updates over the
  `order`↔`strategies`/`frontend` IPC socket — see `orderProcess.ts`'s
  `bookkeeping.onFill`). Blocking this on a Mongo round-trip would delay
  live position/P&L visibility and fill notifications for no benefit.
- This exact class already has an established, explicitly-documented
  convention for exactly this situation. Two sibling methods in the same
  file:
  - `checkDrawdownNotification` (line ~296–316) writes to the
    `notifications` collection with:
    ```typescript
    Mongo.getInstance()?.db.collection('notifications').insertOne({...})
        .catch((e) => Log.log('[order] Failed to write drawdown notification for', user, ':', e));
    ```
  - `persistClosedTrade` (line ~536) writes to the `closedTrades` collection,
    with the method's own comment stating the rule directly: *"Never let a
    Mongo hiccup block live bookkeeping - fire and forget."*
- The raw per-fill insert in `_processTradeEvent` is, by its own neighboring
  comment (line ~532, `persistClosedTrade`'s comment references it: "the raw
  per-fill insert in `_processTradeEvent`... that's a fill log"), an
  audit/history log — not something any caller depends on synchronously.
  Persistence being best-effort here is also consistent with `main()` in
  `orderProcess.ts` (line 393), which explicitly starts up "continuing
  without persistence" if `Mongo.init()` itself fails.

  So: keep the write fire-and-forget (do not `await` it — this preserves
  current fill-processing latency), but replace the useless `try/catch` with
  a `.catch()` handler attached directly to the promise, so a rejection is
  actually handled (logged) instead of becoming unhandled. This exactly
  matches the pattern already used by `checkDrawdownNotification` and
  `persistClosedTrade` in the same class.

### 2. `orderProcess.ts` — global `unhandledRejection` safety net

Defense-in-depth, per the bug report: even after fixing `bookkeeping.ts:415`,
add a process-level `unhandledRejection` handler at `order` process startup
that **logs and does not crash** (no `process.exit()`). This also covers the
legacy/out-of-scope files noted above (`monitor.ts`, `decision.ts`,
`trade/option*.ts`, `trade/icici.ts`) as a safety net, without requiring a
full audit of those files right now.

Place it as the first executable statement after the import block (before
any other top-level code runs), using the same `Log.log(...)` pattern already
used throughout this file (e.g. line 341: `Log.log('[order] Request failed:', req.type, e);`).

## Exact code changes

### File 1: `src/processes/order/bookkeeping.ts`

Locate this exact block (currently lines 412–419):

```typescript
    private async _processTradeEvent(tradeEvent: Trade) {
        Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        try {
            Mongo.getInstance()?.insert(tradeEvent);
        } catch (e) {
            /* Mongo not available */
        }

        if (tradeEvent.action == 'Buy') {
```

Replace it with:

```typescript
    private async _processTradeEvent(tradeEvent: Trade) {
        Log.log(`[order] ${tradeEvent.action} ${tradeEvent.tsym} qty=${tradeEvent.quantity} price=${tradeEvent.price} status=${tradeEvent.status}`);
        // Fire-and-forget, same convention as checkDrawdownNotification/
        // persistClosedTrade elsewhere in this class - never let a Mongo
        // hiccup block live bookkeeping. The .catch() (not a try/catch,
        // which cannot catch a rejection from a promise that isn't awaited)
        // is what actually prevents an unhandled promise rejection from
        // crashing the `order` process on a transient Mongo error.
        Mongo.getInstance()?.insert(tradeEvent).catch((e) => {
            Log.log('[order] Mongo insert failed for trade event (continuing without persistence):', tradeEvent.tsym, e);
        });

        if (tradeEvent.action == 'Buy') {
```

Notes for the executing agent:
- Only that one block changes. Do not touch anything else in this file.
- Do not add `await` before `Mongo.getInstance()?.insert(tradeEvent)` — see
  "Fix design" above for why.
- `Mongo.getInstance()?.insert(tradeEvent).catch(...)` is safe even if
  `Mongo.getInstance()` returns `undefined` (Mongo not initialized): the
  optional-chain (`?.`) short-circuits the *entire* chained expression,
  including the trailing `.catch(...)`, so `.catch` is never called on
  `undefined`. This matches the existing pattern at line ~305
  (`Mongo.getInstance()?.db.collection('notifications').insertOne({...}).catch(...)`)
  which relies on the same short-circuit behavior.

### File 2: `src/processes/orderProcess.ts`

Locate this exact block (currently lines 32–34, the end of the import list
followed by the entry-point comment):

```typescript
import { OptionQuote } from '../model/model';

// Entry point for the `order` process - the IPC server. `strategies` and
```

Replace it with:

```typescript
import { OptionQuote } from '../model/model';

// Defense-in-depth: an unhandled promise rejection anywhere in this process
// (e.g. a fire-and-forget Mongo write - see bookkeeping.ts's
// _processTradeEvent/checkDrawdownNotification/persistClosedTrade) would
// otherwise crash the whole `order` process on Node's default
// unhandledRejection behavior, losing all in-flight risk state
// (bookkeeping.trades, pending order attribution, GTT tracking, P&L). Log
// and keep running instead - deliberately no process.exit() here.
process.on('unhandledRejection', (reason) => {
    Log.log('[order] Unhandled promise rejection (process kept alive):', reason);
});

// Entry point for the `order` process - the IPC server. `strategies` and
```

Notes for the executing agent:
- This must be placed **after** `import Log from '../util/Log';` (already at
  line 15 in the current file) so `Log` is defined when the handler is
  registered — the replacement block above already places it after all
  imports (line 32 is the last import), so this is satisfied automatically
  if you match the exact `old_string` above.
- Do not add `process.exit()` anywhere in this handler — the entire point of
  this change is that the process must NOT crash.
- Do not touch any other part of `orderProcess.ts`.

## New/changed test file

New file: `src/test/bookkeepingMongoInsertRejection.test.ts`

This follows the exact hand-rolled convention used by
`src/test/bookkeepingDedup.test.ts` (header comment with the `Run:` line, a
local `assert()` helper, no describe/it/expect, top-level `async function
main()`).

Test scenario: stub `Mongo.getInstance()` (via `Mongo.instance`, the static
field `Mongo.getInstance()` reads from) to return an object whose `insert()`
always rejects — this simulates a transient Mongo error during a live
trade-event write without needing a real Mongo connection. Then:
1. Call `bookkeeping.recordFill(...)` (the real, unmocked code path that
   internally calls the now-fixed `_processTradeEvent`) and assert it
   resolves without throwing/rejecting.
2. Install a `process.on('unhandledRejection', ...)` listener *before* the
   call, and assert it never fires (after giving the event loop a turn via a
   short `setTimeout`).

This is a full, feasible, non-manual test — because `bookkeeping.recordFill`
does not `await` the Mongo insert, the rejection settles asynchronously and
independently of `recordFill`'s own resolution, so both assertions are
meaningful and directly exercise the fixed code path. (A true "spawn the
process and confirm it doesn't crash" integration test is not attempted here
— see "Manual verification" below for that.)

Full file content to create at `src/test/bookkeepingMongoInsertRejection.test.ts`:

```typescript
/**
 * Verifies bookkeeping's fire-and-forget Mongo trade-event insert
 * (_processTradeEvent, invoked via recordFill) does not produce an
 * unhandled promise rejection when Mongo.insert() rejects, and does not
 * make recordFill() itself throw/reject.
 *
 * Regression test for: src/processes/order/bookkeeping.ts's un-awaited
 * `Mongo.getInstance()?.insert(tradeEvent)` call being wrapped in a useless
 * try/catch (a try/catch cannot catch an eventual rejection from a promise
 * that is never awaited). Before the fix, a transient Mongo error during a
 * live trade-event write became an unhandled promise rejection, which (with
 * no process-level handler installed anywhere in the repo) could crash the
 * `order` process and lose in-flight risk state.
 *
 * Run: npx tsc (compile), then: node ./dist/test/bookkeepingMongoInsertRejection.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import Mongo from '../tools/mongo';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buy(brokerOrderId: string): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok1';
    t.quantity = 65;
    t.price = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = 'MongoRejectionTestUser';
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    let unhandledRejectionSeen: unknown = undefined;
    process.on('unhandledRejection', (reason) => {
        unhandledRejectionSeen = reason;
    });

    // Stub Mongo.getInstance() (which just returns the static `instance`
    // field) to return an object whose insert() always rejects - simulates
    // a transient Mongo error during a live trade-event write without
    // needing a real Mongo connection. Only `insert` is stubbed: the Buy
    // path exercised below never touches `.db` (that's only used by the
    // Sell-side persistClosedTrade/checkDrawdownNotification methods).
    (Mongo as any).instance = {
        insert: async () => {
            throw new Error('Simulated Mongo insert failure');
        },
    };

    let recordFillThrew = false;
    try {
        await bookkeeping.recordFill(buy('mongo-reject-order-1'));
    } catch (e) {
        recordFillThrew = true;
    }
    assert(!recordFillThrew, 'recordFill() does not throw/reject when the fire-and-forget Mongo insert rejects');

    // The Mongo insert's rejection is handled asynchronously via .catch(),
    // independently of recordFill's own await chain - give the event loop a
    // turn to let it settle before asserting no unhandledRejection fired.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(unhandledRejectionSeen === undefined, `no unhandledRejection event fired (got: ${unhandledRejectionSeen})`);

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

### Manual verification (process-doesn't-crash, not covered by the automated test)

A true "the `order` process survives a rejected Mongo write" test would
require spawning the actual `order` process (via the orchestrator) and
injecting a live trade fill while Mongo is unreachable — not feasible in this
hand-rolled test harness (no process-spawning/IPC test infra exists in
`src/test/`). Instead, after both code changes are applied and the build
passes, do this manual check:

1. Stop any local MongoDB instance (or block port 27017), so `Mongo.init()`
   in `orderProcess.ts`'s `main()` fails and any later `insert()` calls
   reject.
2. Start the `order` process the normal way (`npm run processes` or however
   it's normally started in this environment — see `CLAUDE.md`/`ToDo.md` for
   the current dev workflow) and trigger (or wait for) a trade fill.
3. Confirm in `server.log`/`orchestrator.log` that a line like `[order]
   Mongo insert failed for trade event (continuing without persistence): ...`
   appears (or, if the failure instead happens somewhere the primary fix
   doesn't cover, `[order] Unhandled promise rejection (process kept
   alive): ...`) and that the `order` process is still running afterward
   (`ps aux | grep orderProcess` or checking the orchestrator's process
   table), i.e. it did not crash/restart.

This manual step is optional / best-effort verification for whoever executes
this plan — the automated test above is the required, feasible check.

## Verification steps for orchestrator

Run these exact commands from the repo root (`/home/karthikeyan/work/icici`)
after making the two code changes and adding the test file:

```bash
npx tsc --noEmit
```
Expected: exits with status 0 and no `error TS` lines printed (confirms the
edited files and new test file type-check cleanly against the existing
codebase).

```bash
npx tsc
```
Expected: exits with status 0. This performs the real emit into `./dist`,
required because the test is run from compiled JS (matches this repo's
existing test convention — there is no `build` npm script, see `CLAUDE.md`
repo-conventions note).

```bash
node ./dist/test/bookkeepingMongoInsertRejection.test.js
```
Expected output (order of PASS lines may vary slightly but both must be
PASS, and the final line must be `ALL TESTS PASSED`):
```
  PASS: recordFill() does not throw/reject when the fire-and-forget Mongo insert rejects
  PASS: no unhandledRejection event fired (got: undefined)
ALL TESTS PASSED
```
If either line prints `FAIL:` instead of `PASS:`, or the final line reads
`SOME TESTS FAILED`, the fix is not working as intended — do not consider
this task complete in that case.

Also re-run the pre-existing dedup test to confirm nothing in
`bookkeeping.ts` was broken by the edit:
```bash
node ./dist/test/bookkeepingDedup.test.js
```
Expected: ends with `ALL TESTS PASSED` (same as before this change — this
test is unrelated to the fix but exercises the same file/class, so it's a
good regression check that the edit didn't break `_processTradeEvent`'s
control flow).

## Files touched

- `src/processes/order/bookkeeping.ts` — modified (`_processTradeEvent`,
  lines ~412–419: replace useless `try/catch` around an un-awaited Mongo
  insert with a `.catch()` handler on the promise).
- `src/processes/orderProcess.ts` — modified (add a global
  `process.on('unhandledRejection', ...)` handler near the top of the file,
  after the import block, before the entry-point comment).
- `src/test/bookkeepingMongoInsertRejection.test.ts` — new file (regression
  test for the fix).

Not touched (explicitly out of scope, documented above):
- `src/monitor.ts` (legacy/unused, same pattern at lines 397, 485).
- `src/decision.ts`, `src/trade/option.ts`, `src/trade/option-plus.ts`,
  `src/trade/icici.ts` (legacy/lower-priority, unguarded un-awaited Mongo
  writes — now have the global `unhandledRejection` handler in
  `orderProcess.ts` as a safety net, but are not directly fixed).
