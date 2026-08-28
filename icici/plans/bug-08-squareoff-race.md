# Bug: Square-off race

## Problem

`squareOffOnAnt` in `src/processes/order/antExecutor.ts` (currently lines
299-340) has no "in flight" guard. The trade is not removed from
`bookkeeping.trades` (nor is any other in-memory flag set) until *after* the
broker call and fill-confirm round trip completes, inside
`bookkeeping.recordFill` at the end of the function.

There are four call sites that all funnel into this one function:

1. Manual square-off via `/prism/squareoff` → IPC `case 'squareOff'` in
   `src/processes/orderProcess.ts` (~line 115).
2. Manual square-off via the ANT-specific endpoint → IPC
   `case 'antSquareOff'` in `src/processes/orderProcess.ts` (~line 149).
3. Auto square-off on daily/monthly drawdown breach →
   `bookkeeping.onDrawdownBreach` handler in `src/processes/orderProcess.ts`
   (~line 418).
4. `exitMonitor`'s auto-triggered target/stop-loss exit →
   `exitMonitor.onExit('ant', ...)` registration at the bottom of
   `src/processes/order/antExecutor.ts` (currently lines 343-345), invoked
   from `exitMonitor.handleOptionTick` in
   `src/processes/order/exitMonitor.ts` (~line 126).

`exitMonitor.handleOptionTick` already unregisters the trade from its own
`monitored` map *before* awaiting the exit handler (see
`exitMonitor.ts` lines 115-117), which prevents `exitMonitor` from triggering
itself twice on two ticks in quick succession. But that map is local to
`exitMonitor` and is never consulted by the manual-square-off call sites (1),
(2), or the drawdown-breach path (3). So a manual square-off request and an
`exitMonitor` auto-exit (or a drawdown-breach auto-exit) can both call
`squareOffOnAnt` for the *same trade* at nearly the same time, both pass the
(nonexistent) guard, and both issue a live SELL order to the broker
concurrently — a duplicate live exit order.

## Root cause (exact files/lines)

`src/processes/order/antExecutor.ts`, current lines 299-340:

```typescript
export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const ant = ANT.getInstance();
    const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

    let squareOffOrderNo: string | undefined;
    if (existing?.antOrderNo) {
        Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo})`);
        await ant.exitBracketOrder(existing.antOrderNo, 'BO');
    } else {
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
        const instrumentId = existing?.token ?? '';
        const { orderNo } = await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol: tsym,
            quantity,
            transactionType: 'SELL',
        });
        squareOffOrderNo = orderNo;
    }

    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    if (squareOffOrderNo) {
        try {
            trade.price = await AntOrderNotifyStream.getInstance().waitForFill(squareOffOrderNo);
        } catch (e) {
            Log.log('[order] squareOffOnAnt: waitForFill failed, falling back to last-seen price:', e);
            trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
        }
    } else {
        // exitBracketOrder path (existing?.antOrderNo) - no separate orderNo to poll a fill price for.
        trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
    }

    await bookkeeping.recordFill(trade);
    return trade;
}

// exitMonitor calls this when a useGTT=false ANT trade crosses target/SL.
exitMonitor.onExit('ant', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange);
});
```

There is no read-then-set of any "in progress" state before the first
`await` (`ant.exitBracketOrder(...)` or `ant.placeOrder(...)`). The function
identifies the trade to close purely from its own parameters (`userId`,
`tsym`) plus a fresh `bookkeeping.trades.find(...)` lookup — nothing records
that a square-off for this `(userId, tsym)` pair is already underway.

## Fix design (approach + rationale)

**Add a `Set<string>` guard, `bookkeeping.pendingSquareOffs`, keyed by
`` `${userId}:${tsym}` ``, checked and set synchronously at the very top of
`squareOffOnAnt` — before `ANT.getInstance()`, before the
`bookkeeping.trades.find(...)` lookup, and before either broker call — with
release in a `finally` block wrapping the rest of the function body.**

Why `` `${userId}:${tsym}` `` and not `trade.token`: the function's own trade
lookup (`bookkeeping.trades.find((t) => t.tsym === tsym && t.user ===
userId)`) can return `undefined` (e.g. a genuinely manual square-off for a
symbol bookkeeping never recorded a fill for — see the `existing?.token ??
''` fallback already in the function). `token` is therefore not always known
at the point the guard must be set. `userId` and `tsym` are always present as
plain function parameters regardless of whether the trade lookup succeeds,
and they are exactly the two fields every call site already uses to identify
"the trade being squared off" (it's the same pair the function's own
`bookkeeping.trades.find` predicate uses). This also naturally lines up with
how a manual square-off and an `exitMonitor` auto-exit for the *same*
position would collide: both are called with the same `(userId, tsym)`.

Why a synchronous check-and-set closes the race: Node.js runs JavaScript
single-threaded — two calls to `squareOffOnAnt` can only interleave at an
`await` point (or other yield to the event loop), never in the middle of a
synchronous run of code. If the guard's check (`if (pendingSquareOffs.has(key))
...`) and set (`pendingSquareOffs.add(key)`) happen back-to-back with **no
`await` between them**, then whichever of two near-simultaneous calls reaches
that code first will see the key absent, add it, and only *then* yield to the
event loop (at the first `await ant.exitBracketOrder(...)` /
`await ant.placeOrder(...)`). The second call — no matter how close in time —
cannot run any of its own code until the first call yields, and by the time
it does run, the key is already present, so the second call's check sees
`true` and bails out before doing anything async. This is different from
`canPlaceOrder` in bug #1's plan (`bug-01-loss-limit-race.md`), where the
check itself is `async` (it awaits `isDailyDrawdownBreached`/
`isMonthlyDrawdownBreached` before returning) — there, two concurrent callers
can both complete the check and both see "allowed" before either has a chance
to record a reservation, because the check-and-decide span already contains
an `await`. Here, the guard's check-and-set is deliberately kept **fully
synchronous** (no `async`/`await` anywhere between the `.has()` read and the
`.add()` write) specifically to avoid that same TOCTOU gap.

Cleanup uses a `try { ... } finally { bookkeeping.pendingSquareOffs.delete(key); }`
wrapping the entire existing function body (both the broker-call branch and
the `recordFill` call), so the guard is released whether the square-off
succeeds, the broker call throws, or `recordFill` throws — a legitimate retry
of a square-off that failed (e.g. transient broker error) must not be
permanently blocked.

**Naming:** the new field is `pendingSquareOffs`, distinct from
`bookkeeping.pendingUsers` (buy-side in-flight marker) or, if
`bug-01-loss-limit-race.md` has already been applied to this repo,
`bookkeeping.pendingOrders` (its replacement). This fix's guard is for the
square-off/exit (sell) side, which never goes through `canPlaceOrder` at all
— it is entirely separate state from either of those. **Do not rename,
reuse, or merge with `pendingUsers`/`pendingOrders`.** If `bug-01`'s plan has
already been applied and `pendingUsers` no longer exists (replaced by
`pendingOrders: Map<string, PendingOrder[]>`), that has no effect on this
fix — just add `pendingSquareOffs` as its own new field near wherever the
buy-side pending field currently sits.

## Exact code changes

### File: `src/processes/order/bookkeeping.ts`

**Step 1.** Read the current file first and locate the field declarations at
the top of the `OrderBookkeeping` class (originally lines 36-42):

```typescript
class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingUsers: Set<string> = new Set();
```

(Note: `pendingOrdersByTsym` here is a *pre-existing, unrelated* private map
used for something else — likely pending limit-order tracking. Do not touch
it. Also note: if `bug-01-loss-limit-race.md` has already been applied, the
`pendingUsers: Set<string> = new Set();` line above will instead read
`pendingOrders: Map<string, PendingOrder[]> = new Map();` — that's fine and
expected; just use whichever line is actually present as the anchor for the
insertion below, and do not modify it.)

**Step 2.** Immediately after that field (whichever of `pendingUsers` /
`pendingOrders` is actually present), insert a new field:

```typescript
    // Square-off (exit/sell) in-flight guard, keyed by `${userId}:${tsym}` -
    // set synchronously at the very top of squareOffOnAnt (antExecutor.ts),
    // before any await, and released in a finally block there. Prevents a
    // manual square-off and exitMonitor's (or the drawdown-breach handler's)
    // auto-triggered exit from both issuing a live SELL order for the same
    // trade when they fire close together. Entirely separate from
    // pendingUsers/pendingOrders (the BUY-side reservation, unrelated - square-off
    // never goes through canPlaceOrder) - do not merge the two.
    pendingSquareOffs: Set<string> = new Set();
```

So the class field block becomes (example assuming `pendingUsers` is still
present — adjust the anchor line only if it has already been renamed per the
note above; everything else in this block is unchanged):

```typescript
class OrderBookkeeping {
    trades: Trade[] = [];
    closedTrades: Trade[] = [];
    private orderUserMap: Map<string, string> = new Map();
    private pendingOrdersByTsym: Map<string, string[]> = new Map();
    userPnL: Map<string, number> = new Map();
    pendingUsers: Set<string> = new Set();
    // Square-off (exit/sell) in-flight guard, keyed by `${userId}:${tsym}` -
    // set synchronously at the very top of squareOffOnAnt (antExecutor.ts),
    // before any await, and released in a finally block there. Prevents a
    // manual square-off and exitMonitor's (or the drawdown-breach handler's)
    // auto-triggered exit from both issuing a live SELL order for the same
    // trade when they fire close together. Entirely separate from
    // pendingUsers/pendingOrders (the BUY-side reservation, unrelated - square-off
    // never goes through canPlaceOrder) - do not merge the two.
    pendingSquareOffs: Set<string> = new Set();
```

No other changes to `bookkeeping.ts` are needed. `pendingSquareOffs` must
remain a **public** field (no `private` keyword), matching this file's
existing convention of exposing in-memory state (`trades`, `closedTrades`,
`userPnL`, `pendingUsers`) for direct inspection — the test below asserts on
it directly.

### File: `src/processes/order/antExecutor.ts`

Replace the entire `squareOffOnAnt` function (current lines 299-340) with the
version below. Everything inside the function body is byte-for-byte
unchanged except for the new guard check/set at the top and the
`try { ... } finally { ... }` wrapper — **do not alter the broker-call logic,
the fill-price resolution logic, or the `recordFill` call itself.**

Before:
```typescript
export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    const ant = ANT.getInstance();
    const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

    let squareOffOrderNo: string | undefined;
    if (existing?.antOrderNo) {
        Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo})`);
        await ant.exitBracketOrder(existing.antOrderNo, 'BO');
    } else {
        Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
        const instrumentId = existing?.token ?? '';
        const { orderNo } = await ant.placeOrder({
            exchange,
            instrumentId,
            tradingSymbol: tsym,
            quantity,
            transactionType: 'SELL',
        });
        squareOffOrderNo = orderNo;
    }

    const trade = new Trade();
    trade.tsym = tsym;
    trade.quantity = quantity;
    trade.action = 'Sell';
    trade.status = 'COMPLETE';
    trade.user = userId;
    if (squareOffOrderNo) {
        try {
            trade.price = await AntOrderNotifyStream.getInstance().waitForFill(squareOffOrderNo);
        } catch (e) {
            Log.log('[order] squareOffOnAnt: waitForFill failed, falling back to last-seen price:', e);
            trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
        }
    } else {
        // exitBracketOrder path (existing?.antOrderNo) - no separate orderNo to poll a fill price for.
        trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
    }

    await bookkeeping.recordFill(trade);
    return trade;
}
```

After:
```typescript
export async function squareOffOnAnt(userId: string, tsym: string, quantity: number, exchange: 'NFO' | 'BFO' = 'NFO'): Promise<Trade> {
    // In-flight guard: set synchronously (no await between the check and the
    // add) so two near-simultaneous callers - e.g. a manual /prism/squareoff
    // request and exitMonitor's auto-triggered exit for the same trade - can
    // never both pass this check. Node is single-threaded, so whichever call
    // reaches this line first sets the key and only then yields to the event
    // loop (at the first await below); the other call runs this same
    // synchronous check afterward and sees the key already present. See the
    // plan's "Fix design" section for the full race-closure argument.
    const pendingKey = `${userId}:${tsym}`;
    if (bookkeeping.pendingSquareOffs.has(pendingKey)) {
        Log.log(`[order] squareOffOnAnt: square-off for ${tsym} (${userId}) already in flight - ignoring duplicate call`);
        throw new Error(`Square-off for ${tsym} is already in progress for ${userId}`);
    }
    bookkeeping.pendingSquareOffs.add(pendingKey);

    try {
        const ant = ANT.getInstance();
        const existing = bookkeeping.trades.find((t) => t.tsym === tsym && t.user === userId);

        let squareOffOrderNo: string | undefined;
        if (existing?.antOrderNo) {
            Log.log(`[order] Square-off ${tsym} qty=${quantity} for ${userId} via ANT exitBracketOrder (${existing.antOrderNo})`);
            await ant.exitBracketOrder(existing.antOrderNo, 'BO');
        } else {
            Log.log(`[order] Manual square-off ${tsym} qty=${quantity} for ${userId} via ANT regular order`);
            const instrumentId = existing?.token ?? '';
            const { orderNo } = await ant.placeOrder({
                exchange,
                instrumentId,
                tradingSymbol: tsym,
                quantity,
                transactionType: 'SELL',
            });
            squareOffOrderNo = orderNo;
        }

        const trade = new Trade();
        trade.tsym = tsym;
        trade.quantity = quantity;
        trade.action = 'Sell';
        trade.status = 'COMPLETE';
        trade.user = userId;
        if (squareOffOrderNo) {
            try {
                trade.price = await AntOrderNotifyStream.getInstance().waitForFill(squareOffOrderNo);
            } catch (e) {
                Log.log('[order] squareOffOnAnt: waitForFill failed, falling back to last-seen price:', e);
                trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
            }
        } else {
            // exitBracketOrder path (existing?.antOrderNo) - no separate orderNo to poll a fill price for.
            trade.price = existing?.lastTradePrice ?? existing?.price ?? 0;
        }

        await bookkeeping.recordFill(trade);
        return trade;
    } finally {
        // Always release, on success or failure, so a legitimately-retriable
        // square-off (e.g. after a transient broker error) is never
        // permanently blocked.
        bookkeeping.pendingSquareOffs.delete(pendingKey);
    }
}
```

Leave everything else in `antExecutor.ts` untouched, including the
`exitMonitor.onExit('ant', ...)` registration immediately below this
function (current lines 343-345):

```typescript
// exitMonitor calls this when a useGTT=false ANT trade crosses target/SL.
exitMonitor.onExit('ant', async (trade: Trade, exchange: 'NFO' | 'BFO') => {
    await squareOffOnAnt(trade.user, trade.tsym, trade.quantity, exchange);
});
```

This registration already calls `squareOffOnAnt` the same way every other
call site does, and `exitMonitor.handleOptionTick` already wraps its call to
this handler in `try { ... } catch (e) { Log.log(...) }` (see
`src/processes/order/exitMonitor.ts` lines 125-129), so a thrown
"already in progress" error from a blocked duplicate call is caught and
logged there, not an unhandled rejection. The IPC call sites in
`orderProcess.ts` (`case 'squareOff'`, `case 'antSquareOff'`, and the
drawdown-breach handler) are all inside `handleRequest`'s own outer
`try/catch` (`src/processes/orderProcess.ts`, the `catch (e: any)` block
right before `handleRequest`'s closing brace, ~line 341-343), which already
converts any thrown error into `{ kind: 'response', id: req.id, ok: false,
error: e?.message ?? String(e) }` — so a blocked manual square-off surfaces
as a normal `ok:false` API response, not a crash. **No changes are needed in
`orderProcess.ts` or `exitMonitor.ts` for this fix** — the single guard
inside `squareOffOnAnt` covers all four call sites, since they all funnel
through this one function.

## New test file

Create `src/test/squareOffRace.test.ts` with exactly this content:

```typescript
/**
 * Verifies squareOffOnAnt guards against a concurrent duplicate square-off
 * for the same trade (e.g. a manual squareoff racing exitMonitor's
 * auto-triggered exit) - only one of two concurrent calls may reach the
 * broker; the other is rejected as a no-op. Also verifies the guard clears
 * after the winning call finishes, so neither a square-off on a DIFFERENT
 * trade nor a later legitimate retry of the SAME trade is permanently
 * blocked.
 * Run: npm run build (compile), then: node ./dist/test/squareOffRace.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import ANT from '../ant/ANT';
import { squareOffOnAnt } from '../processes/order/antExecutor';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

// Bracket-order-style open trade (antOrderNo set) - squareOffOnAnt exits this
// via ant.exitBracketOrder, which this test stubs out, avoiding any need to
// also stub AntOrderNotifyStream.waitForFill (only exercised by the
// non-bracket "regular order" square-off path, which this test does not use).
function openBracketTrade(user: string, tsym: string, token: string, antOrderNo: string): Trade {
    const t = new Trade();
    t.tsym = tsym;
    t.token = token;
    t.quantity = 65;
    t.price = 100;
    t.lastTradePrice = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.antOrderNo = antOrderNo;
    return t;
}

async function main() {
    const USER = 'SquareOffRaceUser';
    const ant = ANT.getInstance();
    const originalExitBracketOrder = ant.exitBracketOrder.bind(ant);

    let brokerCalls = 0;
    // Stub the live broker call: count invocations and add an artificial
    // delay so two concurrent squareOffOnAnt calls are guaranteed to overlap
    // in-flight - this is exactly the window the race exploits without the
    // guard in place.
    (ant as any).exitBracketOrder = async (_orderNo: string, _orderComplexity: 'BO' | 'CO' = 'BO') => {
        brokerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    try {
        // --- Scenario 1: two concurrent square-offs for the SAME trade ---
        const tradeA = openBracketTrade(USER, 'NIFTY26AUG24100CE', 'tok-race-A', 'bo-order-A');
        bookkeeping.trades.push(tradeA);

        const results = await Promise.allSettled([
            squareOffOnAnt(USER, 'NIFTY26AUG24100CE', 65, 'NFO'),
            squareOffOnAnt(USER, 'NIFTY26AUG24100CE', 65, 'NFO'),
        ]);

        assert(brokerCalls === 1, `only one concurrent square-off call reaches the broker (got ${brokerCalls})`);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        assert(fulfilled.length === 1, `exactly one concurrent call resolves (got ${fulfilled.length})`);
        assert(rejected.length === 1, `exactly one concurrent call is rejected as a duplicate no-op (got ${rejected.length})`);

        const pendingAfterScenario1 = bookkeeping.pendingSquareOffs;
        assert(pendingAfterScenario1.has(`${USER}:NIFTY26AUG24100CE`) === false, 'guard is cleared after the winning call finishes');

        // --- Scenario 2: guard clearing doesn't block a DIFFERENT trade ---
        const tradeB = openBracketTrade(USER, 'NIFTY26AUG24200PE', 'tok-race-B', 'bo-order-B');
        bookkeeping.trades.push(tradeB);

        await squareOffOnAnt(USER, 'NIFTY26AUG24200PE', 65, 'NFO');
        assert(brokerCalls === 2, `a square-off for a different trade proceeds normally and reaches the broker (got ${brokerCalls} total broker calls)`);

        // --- Scenario 3: guard clearing allows a legitimate later retry of the SAME tsym+user ---
        const tradeC = openBracketTrade(USER, 'NIFTY26AUG24300CE', 'tok-race-C', 'bo-order-C');
        bookkeeping.trades.push(tradeC);

        await squareOffOnAnt(USER, 'NIFTY26AUG24300CE', 65, 'NFO');
        assert(brokerCalls === 3, `first square-off of trade C reaches the broker (got ${brokerCalls})`);

        // trade C was fully closed (quantity fully sold) and removed from
        // bookkeeping.trades by recordFill inside the call above - re-add it
        // to simulate a legitimate later, non-concurrent retry and confirm
        // the guard does not wrongly stay latched from the earlier call.
        bookkeeping.trades.push(openBracketTrade(USER, 'NIFTY26AUG24300CE', 'tok-race-C', 'bo-order-C'));
        await squareOffOnAnt(USER, 'NIFTY26AUG24300CE', 65, 'NFO');
        assert(brokerCalls === 4, `a later sequential (non-concurrent) square-off of the same trade is NOT permanently blocked (got ${brokerCalls})`);
    } finally {
        (ant as any).exitBracketOrder = originalExitBracketOrder;
    }

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

Notes on this test file:
- It monkey-patches the live `ANT` singleton's `exitBracketOrder` method
  directly (no jest, no mocking library — matches this repo's "no working
  jest setup" constraint) and restores the original method in a `finally`
  block so the process-lifetime singleton isn't left stubbed if anything
  else in the same process were to use it afterward.
- It never calls `ANT.getInstance().loadSession()`-triggering code paths
  that hit the network — `ANT`'s constructor only reads a local session file
  (wrapped in try/catch), matching the safety of the existing
  `bookkeepingDedup.test.ts`, which also runs without any broker
  connectivity or `Mongo.init()` call.
- It only exercises the `existing?.antOrderNo` (bracket order /
  `exitBracketOrder`) branch of `squareOffOnAnt`, not the "regular order"
  `ant.placeOrder` + `AntOrderNotifyStream.waitForFill` branch — the guard
  fix is identical for both branches (it wraps the whole function), so this
  is sufficient to prove the race is closed without also having to stub
  `AntOrderNotifyStream`.
- Uses a dedicated `'SquareOffRaceUser'` username and per-scenario `tsym`
  values disjoint from `bookkeepingDedup.test.ts`'s `'DedupTestUser'` /
  `'NIFTY26AUG24100CE'`-on-`'tok1'` combination, so the two test files remain
  safe to run in either order or independently.
- Scenario 1's two concurrent calls both find the same `tradeA` via
  `bookkeeping.trades.find(...)` before either one's guard would matter for
  that lookup — the guard fix rejects the loser *before* it ever reaches
  that `find(...)` call, which is exactly what "checked at the very top,
  before any other logic" means in the fix design.

## Verification steps for orchestrator

Run these exact commands from the repo root:

```bash
cd /home/karthikeyan/work/icici

# 1. Typecheck only (fast, no dist/ output) - must be clean.
npx tsc --noEmit

# 2. Full compile to dist/ (this repo has no `npm run build` script - use tsc
#    directly, matching the existing test files' own run instructions).
npx tsc

# 3. Run the new test directly (no jest - hand-rolled script convention).
node ./dist/test/squareOffRace.test.js
echo "exit code: $?"

# 4. Re-run the pre-existing bookkeeping test to confirm no regression from
#    the bookkeeping.ts field addition.
node ./dist/test/bookkeepingDedup.test.js
echo "exit code: $?"
```

Expected output from step 3: exactly these lines (order may vary slightly
based on `Log.log` interleaving, but every `assert()` line below must appear
as `PASS`, not `FAIL`):

```
  PASS: only one concurrent square-off call reaches the broker (got 1)
  PASS: exactly one concurrent call resolves (got 1)
  PASS: exactly one concurrent call is rejected as a duplicate no-op (got 1)
  PASS: guard is cleared after the winning call finishes
  PASS: a square-off for a different trade proceeds normally and reaches the broker (got 2 total broker calls)
  PASS: first square-off of trade C reaches the broker (got 3)
  PASS: a later sequential (non-concurrent) square-off of the same trade is NOT permanently blocked (got 4)
ALL TESTS PASSED
```
followed by `exit code: 0`.

Expected output from step 4: `ALL TESTS PASSED` followed by `exit code: 0`
(unchanged from before this fix — this confirms the `bookkeeping.ts` field
addition didn't break the existing dedup test).

If any `FAIL:` line appears, if `npx tsc --noEmit` or `npx tsc` report
compile errors, or if either test exits non-zero, the change is not done —
do not mark this bug fixed. In particular:
- If `brokerCalls` after Scenario 1 is `2` instead of `1`, the guard did not
  close the race (check that the check-and-set in `squareOffOnAnt` truly has
  no `await` between `.has()` and `.add()`, and that it happens before
  `ANT.getInstance()`/`bookkeeping.trades.find(...)`, not after).
  - Fetch the current `squareOffOnAnt` source and diff against the
  "After" snippet in this plan.
- If Scenario 2 or 3 fails, the `finally` block is not releasing the guard
  correctly, or `pendingKey` was built from the wrong fields (must be exactly
  `` `${userId}:${tsym}` ``, matching what's used for the check/set/release
  all three).

## Files touched

| File | Change |
|---|---|
| `/home/karthikeyan/work/icici/src/processes/order/bookkeeping.ts` | Add new public field `pendingSquareOffs: Set<string> = new Set();` near the existing `pendingUsers`/`pendingOrders` field declaration. No other changes. |
| `/home/karthikeyan/work/icici/src/processes/order/antExecutor.ts` | Replace `squareOffOnAnt` (current lines 299-340) with the guarded version: synchronous check-and-set of `bookkeeping.pendingSquareOffs` keyed by `` `${userId}:${tsym}` `` at the top (throwing if already present), wrapping the existing unchanged function body in `try { ... } finally { bookkeeping.pendingSquareOffs.delete(pendingKey); }`. No changes to the `exitMonitor.onExit('ant', ...)` registration below it. |
| `/home/karthikeyan/work/icici/src/test/squareOffRace.test.ts` (new) | New hand-rolled test, matching `bookkeepingDedup.test.ts`'s convention, covering: concurrent duplicate rejection, broker-call count, guard clearing after success, a different trade not being blocked, and a later sequential retry of the same trade not being blocked. |

Out of scope (do not touch): `src/monitor.ts` / `src/server.ts`'s legacy
squareoff path (if one exists outside the `order`/`orderProcess.ts` split) —
per this repo's live-trading-process-split note, live order/risk logic for
the split process lives in `src/processes/order/*`, and that is the only
path this bug report and this plan cover. Do not touch
`bookkeeping.pendingUsers` / `bookkeeping.pendingOrders` (the unrelated
BUY-side reservation from `bug-01-loss-limit-race.md`) — this fix's
`pendingSquareOffs` is a separate, independent field for the SELL/exit side
only.
