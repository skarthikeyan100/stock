# Bug: Orphaned broker position on fill-notify failure

## Problem

`enterPosition` in `src/processes/order/antExecutor.ts` places a live buy
order at the broker (AliceBlue, via `ANT.placeOrder`/`ANT.placeBracketOrder`),
then does `await AntOrderNotifyStream.getInstance().waitForFill(orderNo)` and
**only after that resolves** does it build the `Trade` object, set
target/SL, register it with `exitMonitor`, and call
`bookkeeping.recordFill(trade)`.

`waitForFill` is push-based: it resolves when AliceBlue's order-notify
websocket delivers a `COMPLETE` status message for `orderNo`, or rejects
after a 60s timeout (or on a `REJECTED`/`CANCELLED` push). The push itself is
explicitly documented as unverified (`src/ant/AntOrderNotifyStream.ts:40-46`)
— it assumes the WS's `norenordno` field is the same value as the REST
`brokerOrderId` `ANT.placeOrder` returns, and that assumption is untested
against a live market.

If the WS push is ever missed (assumption wrong, dropped message, WS
reconnect gap, etc.) while the order **did** fill at the broker,
`waitForFill` times out after 60s and throws. `enterPosition` has no
try/catch around it, so the exception propagates straight out — the `Trade`
object is never built, `bookkeeping.recordFill` is never called, and
`exitMonitor.registerTrade` (which arms target/SL monitoring) is never
called. The result: a real, live, filled position at the broker that is
completely invisible to this app — not counted against per-user lot/loss
limits, not shown on `/positionstream`, and with no target/SL protection
watching it (broker-side bracket or in-app `exitMonitor`, depending on
`useGTT`).

There is no reconciliation job anywhere in the codebase that compares live
broker positions (`ANT.getPositions()`) against `bookkeeping.trades` to catch
this after the fact — `ANT.getPositions()` is only called from the read-only
`GET /ant/positions` display route (`src/server.ts:707-716`).

## Root cause (exact files/lines)

- `src/processes/order/antExecutor.ts:76` — `const entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);` is un-guarded; a throw here aborts all of the trade-recording/target-SL/exit-monitor work that follows (lines 79-118), even though the broker-side order may have actually filled.
- `src/ant/AntOrderNotifyStream.ts:40-46` — documents the unverified `norenordno` == `brokerOrderId` assumption that, if wrong, makes `waitForFill` **always** time out (never see a match) even for perfectly good fills.
- `src/ant/AntOrderNotifyStream.ts:200-208` — `waitForFill`'s 60s timeout path (`reject(new Error(...))`) is the concrete failure mode being guarded against.
- No file: there is no periodic/on-demand reconciliation between `ANT.getPositions()` (`src/ant/ANT.ts:226-247`) and `bookkeeping.trades` (`src/processes/order/bookkeeping.ts:37`) anywhere in the codebase — confirmed by grep, `getPositions` has exactly one caller (`src/server.ts:710`, a read-only display route) plus its own definition.

## Fix design (approach + rationale)

**Primary fix (this plan implements this): a synchronous REST fallback in
`enterPosition` itself, not a new background job.**

`src/ant/ANT.ts` already has exactly the right building block for this:
`ANT.getFillPrice(orderNo, maxAttempts=12, intervalMs=5000)`
(`src/ant/ANT.ts:504-535`). It's a **confirmed-live**, already-implemented
REST poll of AliceBlue's `orders/history` endpoint, keyed directly by
`orderNo`, that scans every state-transition record for a terminal
`COMPLETE`/`REJECTED`/`CANCELLED` status and returns
`averageTradedPrice` on `COMPLETE`. It is a completely independent path from
the order-notify websocket (different endpoint, different data shape,
already handles the "unordered records" gotcha) — so it isn't exposed to the
same `norenordno`-vs-`brokerOrderId` risk the WS push is.

This is a much better fallback than polling `ANT.getPositions()` (the
approach floated in the task description) because:
- `getPositions()`'s response shape is untyped (`Promise<any>`) and has
  never been verified against a live response for this codebase (unlike
  `getFillPrice`, whose field names are confirmed-live per its own comment).
- `getPositions()` answers "is there an open position for this
  instrument at all", which is ambiguous if the user already held a position
  in the same contract before this order — `getFillPrice(orderNo)` answers
  the precise question "did *this specific order* complete", with no
  ambiguity.
- It reuses code that already exists and is already documented as
  confirmed-live, instead of introducing a new, unverified codepath.

**Change:** wrap the `waitForFill` call in `enterPosition` in a try/catch.
On ANY failure (timeout, REJECTED, CANCELLED — all of them, since a missed
WS push and a genuine rejection look identical from this call site), fall
back to `ant.getFillPrice(orderNo)`. If that resolves, treat the order as
filled and proceed exactly as before (trade recorded, target/SL set,
`exitMonitor` registered) — closing the orphan gap. If `getFillPrice` also
throws (order genuinely never completed, or genuinely was
rejected/cancelled — `getFillPrice` finds those terminal states directly
too), let that error propagate out of `enterPosition` exactly as the
original code did — no behavior change for a truly-failed order, and
critically, no orphan is created in that case either since nothing gets
recorded.

**Reconciliation background job — recommended follow-up, NOT implemented in
this plan (out of scope):** a periodic job comparing `ANT.getPositions()`
against `bookkeeping.trades` would be a useful defense-in-depth net for
failure modes this synchronous fix can't catch (e.g. the whole `order`
process crashing between broker fill and `bookkeeping.recordFill`). It's
deliberately left out here to keep this change minimal, synchronous, and
directly testable without inventing a new poller/scheduler and without
depending on `getPositions()`'s unverified response shape. Flag this to the
user as a suggested next step; do not build it as part of this fix.

## Exact code changes (file-by-file)

### File: `src/processes/order/antExecutor.ts`

**Change 1 — export `enterPosition`** so it can be unit-tested directly
without going through `AntContractMaster`'s live contract-master JSON
lookup (which `buyIndexOnAnt`/`manualBuyOnAnt` require and which depends on
today's date/expiry and multi-megabyte data files — not suitable for a
deterministic unit test).

Locate this exact line (currently line 32):

```
async function enterPosition(
```

Replace with:

```
export async function enterPosition(
```

Nothing else on that line or signature changes — the parameter list on the
following lines (33-40) is untouched.

**Change 2 — try/catch + REST fallback around `waitForFill`.**

Locate this exact block (currently lines 72-79 of
`src/processes/order/antExecutor.ts` — the end of the `if (useBracket) {...}
else {...}` order-placement block, followed by the `waitForFill` call and
the start of `Trade` construction):

```javascript
    }

    // Push-based, not polled - resolves as soon as the order-notify websocket
    // delivers a COMPLETE status for this order (see AntOrderNotifyStream.ts).
    const entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
    Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);

    const trade = new Trade();
```

Replace it with:

```javascript
    }

    // Push-based, not polled - resolves as soon as the order-notify websocket
    // delivers a COMPLETE status for this order (see AntOrderNotifyStream.ts).
    //
    // BUG FIX (orphaned broker position on fill-notify failure): the
    // order-notify WS push can be missed even though the order actually
    // filled at the broker (see AntOrderNotifyStream.ts:40-46's documented,
    // unverified norenordno-vs-brokerOrderId assumption - if wrong,
    // waitForFill NEVER sees a match and always times out). Previously, any
    // waitForFill failure aborted this function before the trade was ever
    // recorded in bookkeeping or protected with target/SL, silently
    // orphaning a real, live, filled broker position (uncounted against
    // limits, unprotected, invisible on /positionstream). So on ANY
    // waitForFill failure (timeout, REJECTED, CANCELLED), fall back to a
    // direct REST check - ANT.getFillPrice, a confirmed-live poll of
    // AliceBlue's orders/history endpoint keyed by this exact orderNo (see
    // ANT.ts) - before giving up. Only if the REST fallback ALSO fails to
    // find a COMPLETE fill do we treat the order as genuinely not filled and
    // let the error propagate, exactly as before.
    let entryPrice: number;
    try {
        entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        entryPrice = await ant.getFillPrice(orderNo);
        Log.log(`[order] REST fallback confirmed fill for ${tradingSymbol} at ${entryPrice} for ${userId} (order-notify push was missed)`);
    }

    const trade = new Trade();
```

Everything from `const trade = new Trade();` onward (currently lines 79-119)
is **unchanged** — do not modify it. Note `ant` (used in the fallback's
`ant.getFillPrice(orderNo)` call) is already in scope: it's declared at the
top of `enterPosition` as `const ant = ANT.getInstance();` (line 41) and is
already used earlier in the function for `ant.getQuote`/`ant.placeBracketOrder`/`ant.placeOrder`.

After both changes, the full function signature/opening and the fill-wait
section should read (for orientation only — this is the expected resulting
shape, not something to paste over the whole function):

```javascript
export async function enterPosition(
    userId: string,
    tradingSymbol: string,
    instrumentId: string,
    quantity: number,
    exchange: 'NFO' | 'BFO',
    targetPoints: number,
    stopLossPoints: number
): Promise<Trade> {
    const ant = ANT.getInstance();
    const useBracket = targetPoints > 0 && stopLossPoints > 0 && bookkeeping.getUserUseGTT(userId);

    let orderNo: string;
    if (useBracket) {
        ... (unchanged)
    } else {
        ... (unchanged)
    }

    let entryPrice: number;
    try {
        entryPrice = await AntOrderNotifyStream.getInstance().waitForFill(orderNo);
        Log.log(`[order] Filled ${tradingSymbol} at ${entryPrice} for ${userId}`);
    } catch (waitErr) {
        Log.log(`[order] waitForFill failed for ${tradingSymbol} order ${orderNo} (${userId}) - falling back to REST fill check:`, waitErr);
        entryPrice = await ant.getFillPrice(orderNo);
        Log.log(`[order] REST fallback confirmed fill for ${tradingSymbol} at ${entryPrice} for ${userId} (order-notify push was missed)`);
    }

    const trade = new Trade();
    ... (unchanged, lines 80-118 of the original file)
```

No other files need source changes.

## New/changed test file (exact full file content)

Create a new file at:

`/home/karthikeyan/work/icici/src/test/antExecutorFillFallback.test.ts`

with exactly this content:

```typescript
/**
 * Verifies enterPosition's REST fallback (ANT.getFillPrice) for the
 * "orphaned broker position on fill-notify failure" bug: if
 * AntOrderNotifyStream.waitForFill fails (missed/timed-out order-notify
 * push), enterPosition must fall back to a direct REST fill check instead
 * of aborting and leaving the broker-side fill untracked. If the REST
 * fallback also fails to find a fill, enterPosition must still throw and
 * must NOT record a trade (i.e. no orphan is created either way).
 *
 * Run: npm run build (compile), then: node ./dist/test/antExecutorFillFallback.test.js
 */

import ANT from '../ant/ANT';
import AntOrderNotifyStream from '../ant/AntOrderNotifyStream';
import bookkeeping from '../processes/order/bookkeeping';
import { enterPosition } from '../processes/order/antExecutor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// --- Mocks, following continuousStrategyTest.ts's MockOrderClient pattern:
// monkey-patch the singleton's private static `instance` field so
// ANT.getInstance()/AntOrderNotifyStream.getInstance() return these mocks
// instead of constructing the real network-backed singletons. ---

class MockAnt {
    placeOrderCalls: any[] = [];
    getFillPriceCalls: string[] = [];
    nextOrderNo = 'ORDER-1';
    // Set to a number to have getFillPrice resolve with that price, or to an
    // Error instance to have it reject with that error.
    getFillPriceResult: number | Error = 100;

    async placeOrder(req: any): Promise<{ orderNo: string }> {
        this.placeOrderCalls.push(req);
        return { orderNo: this.nextOrderNo };
    }

    async placeBracketOrder(req: any): Promise<{ orderNo: string }> {
        this.placeOrderCalls.push(req);
        return { orderNo: this.nextOrderNo };
    }

    async getQuote(_exchange: string, _instrumentId: string): Promise<number> {
        return 100;
    }

    async getFillPrice(orderNo: string): Promise<number> {
        this.getFillPriceCalls.push(orderNo);
        if (this.getFillPriceResult instanceof Error) throw this.getFillPriceResult;
        return this.getFillPriceResult;
    }
}

class MockNotifyStream {
    waitForFillCalls: string[] = [];
    // Set to a number to have waitForFill resolve with that price, or to an
    // Error instance to have it reject with that error (simulating a missed
    // push / 60s timeout / REJECTED / CANCELLED).
    waitForFillResult: number | Error = 100;

    async waitForFill(orderNo: string): Promise<number> {
        this.waitForFillCalls.push(orderNo);
        if (this.waitForFillResult instanceof Error) throw this.waitForFillResult;
        return this.waitForFillResult;
    }
}

let mockAnt: MockAnt;
let mockNotify: MockNotifyStream;

function installMocks() {
    mockAnt = new MockAnt();
    mockNotify = new MockNotifyStream();
    (ANT as any).instance = mockAnt;
    (AntOrderNotifyStream as any).instance = mockNotify;
}

// targetPoints/stopLossPoints are deliberately 0 in every test below - this
// forces enterPosition's non-bracket ("regular order") branch, which needs
// no quote fetch and no placeBracketOrder mocking, keeping these tests
// focused purely on the waitForFill/getFillPrice fallback logic under test.

async function main() {
    // --- Scenario 1: waitForFill succeeds normally - no fallback should be used. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-HAPPY-PATH';
    mockNotify.waitForFillResult = 111;
    const userA = 'FallbackTestUser_HappyPath';

    const tradeA = await enterPosition(userA, 'NIFTY26AUG24100CE', 'tok-a', 65, 'NFO', 0, 0);

    assert(tradeA.price === 111, `happy path: trade price comes from waitForFill (got ${tradeA.price})`);
    assert(mockNotify.waitForFillCalls.length === 1, `happy path: waitForFill was called once (got ${mockNotify.waitForFillCalls.length})`);
    assert(mockAnt.getFillPriceCalls.length === 0, `happy path: REST fallback was NOT used (got ${mockAnt.getFillPriceCalls.length} calls)`);
    assert(bookkeeping.trades.some((t) => t.user === userA && t.brokerOrderId === 'ORDER-HAPPY-PATH'), 'happy path: trade was recorded in bookkeeping');

    // --- Scenario 2: waitForFill fails (missed push / timeout), REST fallback finds the fill. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-FALLBACK-RECOVERS';
    mockNotify.waitForFillResult = new Error('ANT order ORDER-FALLBACK-RECOVERS did not complete within 60000ms (order-notify)');
    mockAnt.getFillPriceResult = 222;
    const userB = 'FallbackTestUser_Recovers';

    const tradeB = await enterPosition(userB, 'NIFTY26AUG24200CE', 'tok-b', 65, 'NFO', 0, 0);

    assert(tradeB.price === 222, `fallback-recovers: trade price comes from REST fallback (got ${tradeB.price})`);
    assert(mockNotify.waitForFillCalls.length === 1, `fallback-recovers: waitForFill was attempted once (got ${mockNotify.waitForFillCalls.length})`);
    assert(mockAnt.getFillPriceCalls.length === 1 && mockAnt.getFillPriceCalls[0] === 'ORDER-FALLBACK-RECOVERS', `fallback-recovers: REST fallback was called with the same orderNo (got ${JSON.stringify(mockAnt.getFillPriceCalls)})`);
    assert(bookkeeping.trades.some((t) => t.user === userB && t.brokerOrderId === 'ORDER-FALLBACK-RECOVERS'), 'fallback-recovers: trade was recorded in bookkeeping despite the missed push (THIS IS THE CORE BUG FIX - no orphaned position)');

    // --- Scenario 3: waitForFill fails AND the REST fallback also fails (order genuinely never filled) - must throw, must NOT record a trade. ---
    installMocks();
    mockAnt.nextOrderNo = 'ORDER-GENUINELY-REJECTED';
    mockNotify.waitForFillResult = new Error('ANT order ORDER-GENUINELY-REJECTED did not complete within 60000ms (order-notify)');
    mockAnt.getFillPriceResult = new Error('ANT order ORDER-GENUINELY-REJECTED REJECTED (Insufficient funds)');
    const userC = 'FallbackTestUser_GenuineFailure';

    let threw = false;
    try {
        await enterPosition(userC, 'NIFTY26AUG24300CE', 'tok-c', 65, 'NFO', 0, 0);
    } catch (e) {
        threw = true;
    }

    assert(threw, 'genuine-failure: enterPosition throws when both waitForFill and the REST fallback fail');
    assert(mockAnt.getFillPriceCalls.length === 1, `genuine-failure: REST fallback was still attempted once (got ${mockAnt.getFillPriceCalls.length})`);
    assert(!bookkeeping.trades.some((t) => t.user === userC), 'genuine-failure: no trade was recorded for a genuinely-failed order (no orphan created)');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

## Verification steps for orchestrator

Run these exact shell commands, in order, from the repo root
(`/home/karthikeyan/work/icici`):

1. Typecheck/compile the whole project (there is no `build` npm script —
   this is a pre-existing gap, use `npx tsc` directly):

   ```bash
   cd /home/karthikeyan/work/icici && npx tsc
   ```

   Expected: the command exits with status 0 and prints no output (no
   compile errors). If it prints TypeScript errors referencing
   `antExecutor.ts` or the new test file, the code changes above were not
   applied exactly as specified — re-check against the "Exact code changes"
   section before proceeding.

2. Run the new test:

   ```bash
   cd /home/karthikeyan/work/icici && node ./dist/test/antExecutorFillFallback.test.js
   ```

   Expected output: every line is `  PASS: ...` (9 PASS lines total — 4 in
   Scenario 1, 4 in Scenario 2, 3 in Scenario 3 — 11 total, recount against
   the assert() calls in the file above if in doubt), followed by a final
   line:

   ```
   ALL TESTS PASSED
   ```

   with process exit code 0 (`echo $?` immediately after should print `0`).
   If any assertion fails, that line will read `  FAIL: ...` instead, the
   final line will read `SOME TESTS FAILED`, and the process exit code will
   be `1` — in that case, stop and re-verify the code changes against this
   plan; do not attempt to "fix" the test to make it pass.

3. Sanity-check the pre-existing test suite still passes unmodified
   (confirms the fix didn't regress `bookkeeping.recordFill`'s dedup
   behavior, which the new test's Scenario 1/2 both exercise indirectly via
   `enterPosition`):

   ```bash
   cd /home/karthikeyan/work/icici && node ./dist/test/bookkeepingDedup.test.js
   ```

   Expected: all `  PASS: ...` lines, ending in `ALL TESTS PASSED`, exit
   code 0 (this test's own expected output, unchanged by this fix).

Do not run `npm run server`, `npm run processes`, or any command that starts
a live process/websocket connection as part of this verification — this bug
fix is verified entirely through the direct in-process unit test above, per
this repo's process-split architecture (no mock-broker seam exists on the
`order`-process path; see this plan's context).

## Files touched

- `src/processes/order/antExecutor.ts` — modified (export `enterPosition`; wrap `waitForFill` in try/catch with `ANT.getFillPrice` REST fallback)
- `src/test/antExecutorFillFallback.test.ts` — new file (test)
- `/home/karthikeyan/work/icici/plans/bug-02-orphaned-broker-position.md` — this plan file
