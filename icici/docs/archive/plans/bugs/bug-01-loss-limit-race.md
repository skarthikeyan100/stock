# Bug: Loss limit / lot constraint race (+ pendingUsers leak, bug-10)

This plan covers TWO related High-priority bugs together, since they touch the
same code and the second is a prerequisite for the first being safe:

1. **Loss limit / lot constraint race** — `canPlaceOrder()` in
   `src/processes/order/bookkeeping.ts:262-289` only reads `this.trades`
   (confirmed fills) and Mongo `closedTrades` — it never consults
   `this.pendingUsers` (a `Set<string>` declared at `bookkeeping.ts:42`,
   meant to track in-flight/unfilled orders). Two concurrent order requests
   for the same user can both pass `canPlaceOrder` before either fill lands
   in `this.trades`, exceeding the user's lot/investment limit.
2. **`pendingUsers` leak** (bug-10 in bugs.md) — none of the 7 call sites in
   `src/processes/orderProcess.ts` that do `bookkeeping.pendingUsers.add(...)`
   ever clear it if the broker call throws/rejects. This is fixed in the same
   change below (the new `releasePending`/`placeOrderWithPendingGuard`
   mechanism), so **a separate `bug-10-pendingusers-leak.md` plan should be
   treated as superseded by this file once this fix is applied** — do not
   apply both; if `bug-10-pendingusers-leak.md` exists and is applied first,
   skip re-applying the leak-cleanup portion of this plan.

If executing this plan and `bug-10-pendingusers-leak.md` has ALREADY been
applied to the repo (check `orderProcess.ts` for a `withPendingCleanup` or
similar wrapper already in place), STOP and reconcile manually rather than
blindly applying the code below — the two plans independently invented
different wrapper-function shapes for the same problem.

## 1. Root design decision

`pendingUsers: Set<string>` is the wrong data structure even before today's
bug: a `Set` can't represent two concurrent in-flight orders for the *same*
user (a second `.add(user)` is a no-op, and a single `.delete(user)` from one
order's fill wipes out the reservation of the *other* still-in-flight order
too). Since the whole point of this fix is "make concurrent orders for the
same user visible to each other," the structure must count reservations, not
just flag a user as "some order pending."

**Fix: replace `pendingUsers: Set<string>` with
`pendingOrders: Map<string, PendingOrder[]>`**, where each buy-style request
pushes one reservation (`markPending`) before the broker call and pops exactly
one reservation (`releasePending`) when it resolves (fill) or rejects (leak
fix) — never a blanket "delete this user." `canPlaceOrder` folds the *sum* of
pending reservations into the lot-limit and investment-limit checks (not into
`getTradedLots`/`getCurrentInvestment` themselves, since those are also used
for real accounting like `/positions` display and
`getUserContext.availableAmount`, which must reflect confirmed state only).

Each reservation conservatively counts as **1 lot** (matching
`resolveManualBuyQuantity`'s existing "at least one lot" default — real
quantity isn't always known at reservation time, e.g. `buyIndex`/
`antBuyIndex` resolve quantity inside the executor) and
**`estimatedOrderValue ?? 0`** for the investment check (the same optional
param already threaded through `canPlaceOrder` today; `buyIndex`/
`antBuyIndex` don't pass one, so pending investment protection is a known,
documented gap for those two call sites — only lot-limit protection applies
to them while pending, which is exactly what closes the race described in the
bug report).

This is deliberately *not* "block ALL further orders for a user while
anything is pending" — that would over-block legitimate multi-lot trading.
It's a reservation/optimistic-locking pattern: pending orders count toward
the same limits confirmed trades count toward, so `canPlaceOrder` only
rejects when the reservation would actually push the user over a limit —
which is precisely the race condition.

## 2. Exact fix — `src/processes/order/bookkeeping.ts`

### 2a. Replace the `pendingUsers` field (around line 42)

Add near the `UserSettings` interface (top of file, after line 34):

```typescript
// One reservation per in-flight, not-yet-resolved buy request. A Set<string>
// can't represent two concurrent pending orders for the same user (a second
// add() is a no-op, and a single delete() would wipe out both) - that's
// exactly the gap this whole fix closes, so this must be a per-user list.
interface PendingOrder {
    estimatedLots: number;  // always 1: a conservative reservation - real
                             // quantity isn't always known yet (see buyIndex/
                             // antBuyIndex, which resolve it inside the
                             // broker executor)
    estimatedValue: number; // mirrors canPlaceOrder's estimatedOrderValue
                             // param; 0 when the caller didn't have one
                             // (buyIndex/antBuyIndex) - those get lot-limit
                             // protection while pending but not investment-
                             // limit protection
}
```

Replace line 42:
```typescript
    pendingUsers: Set<string> = new Set();
```
with:
```typescript
    pendingOrders: Map<string, PendingOrder[]> = new Map();
```

### 2b. Add `markPending` / `releasePending` / pending-aggregation helpers

Insert right after `getCurrentInvestment`/`isInvestmentLimitReached` (after
line 185), reusing the existing "traded lots" / "current investment" naming
pattern:

```typescript
    // Called by orderProcess.ts immediately after canPlaceOrder() returns
    // allowed:true and before the broker call, so a concurrent canPlaceOrder()
    // call for the same user sees this reservation for the duration of the
    // broker round trip - this is what closes the race where two concurrent
    // requests both read only confirmed trades and both pass. Every
    // markPending() must be paired with exactly one releasePending() call -
    // either from the fill path (_processTradeEvent, already wired) or from
    // orderProcess.ts's failure path (placeOrderWithPendingGuard) - or the
    // reservation leaks and this user is blocked until the next fill.
    markPending(user: string, estimatedOrderValue?: number): void {
        const list = this.pendingOrders.get(user) ?? [];
        list.push({ estimatedLots: 1, estimatedValue: estimatedOrderValue ?? 0 });
        this.pendingOrders.set(user, list);
    }

    // Releases exactly one pending reservation for `user` (oldest first) -
    // never all of them - so releasing/resolving one in-flight order can't
    // silently drop a different, still-in-flight order's reservation for the
    // same user. Safe to call when nothing is pending (no-op), so both the
    // fill path and orderProcess's failure path can call it unconditionally.
    releasePending(user: string): void {
        const list = this.pendingOrders.get(user);
        if (!list || list.length === 0) return;
        list.shift();
        if (list.length === 0) this.pendingOrders.delete(user);
    }

    private pendingLots(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedLots, 0);
    }

    private pendingValue(user: string): number {
        return (this.pendingOrders.get(user) ?? []).reduce((sum, p) => sum + p.estimatedValue, 0);
    }
```

### 2c. Update `hasActiveTrade` (lines 175-177)

```typescript
    hasActiveTrade(user: string): boolean {
        return this.trades.some((t) => t.user === user) || (this.pendingOrders.get(user)?.length ?? 0) > 0;
    }
```

### 2d. Update `canPlaceOrder` (lines 262-289) — fold pending lots/value into the two existing gates

```typescript
    async canPlaceOrder(user: string, estimatedOrderValue?: number): Promise<{ allowed: boolean; reason?: string }> {
        const tradedLots = this.getTradedLots(user) + this.pendingLots(user);
        const lotLimit = this.getUserLotLimit(user);
        if (tradedLots >= lotLimit) {
            return { allowed: false, reason: `User '${user}' has reached the lot limit (${tradedLots}/${lotLimit} lots).` };
        }
        const currentInvestment = this.getCurrentInvestment(user) + this.pendingValue(user);
        const maxInvestment = this.getUserMaxInvestment(user);
        if (currentInvestment >= maxInvestment) {
            return { allowed: false, reason: `User '${user}' has reached max investment (${currentInvestment}/${maxInvestment}).` };
        }
        const perOrderCap = this.getUserPerOrderCap(user);
        if (estimatedOrderValue !== undefined && perOrderCap !== undefined && estimatedOrderValue > perOrderCap) {
            return { allowed: false, reason: `Order value ₹${estimatedOrderValue.toFixed(2)} exceeds per-order cap ₹${perOrderCap}.` };
        }
        if (await this.isDailyDrawdownBreached(user)) {
            const reason = `User '${user}' has reached the maximum daily drawdown.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        if (await this.isMonthlyDrawdownBreached(user)) {
            const reason = `User '${user}' has reached the maximum monthly drawdown.`;
            this.logOrderRejection(user, reason);
            return { allowed: false, reason };
        }
        if (await this.hasReachedDailyTradeLimit(user)) {
            return { allowed: false, reason: `User '${user}' has reached the maximum number of trades for today.` };
        }
        return { allowed: true };
    }
```

**IMPORTANT:** Check the actual current body of `canPlaceOrder` first —
`isDailyDrawdownBreached`/`isMonthlyDrawdownBreached`'s exact reason-string
and any `logOrderRejection` call must match what's really there today; the
snippet above reconstructs it from investigation notes but the executing
agent must diff against the real current file and preserve any details not
explicitly changed here (only the `tradedLots`/`currentInvestment` lines and
the `pendingLots`/`pendingValue` additions are the required changes).

Note: this inlines what `isInvestmentLimitReached`/`getCurrentInvestment` did
before, but adds `pendingValue(user)`. **Do not modify
`isInvestmentLimitReached`, `getCurrentInvestment`, or `getTradedLots`
themselves** — they're used elsewhere for confirmed-state-only accounting
(`getUserContext.availableAmount`, `/positions`-style displays).
`isInvestmentLimitReached` becomes unused by `canPlaceOrder` after this
change; leave it in place (small public method, may have other callers).

### 2e. Update `_processTradeEvent`'s Buy branch (line 421)

Replace:
```typescript
            this.pendingUsers.delete(tradeEvent.user || 'Default');
```
with:
```typescript
            this.releasePending(tradeEvent.user || 'Default');
```

No other changes needed in `_processTradeEvent` — it already only runs on
confirmed fills.

## 3. Exact fix for the leak — `src/processes/orderProcess.ts`

Add one shared helper above `handleRequest` (after
`connectAntOrderNotifyIfSessionValid`, i.e. after line 78), and rewrite the 7
buy-style `case` bodies to use it. This avoids duplicating the
try/catch-and-release boilerplate 7 times, and keeps the outer
`handleRequest` try/catch (lines 80-344) as the single place that formats
thrown errors into `{ ok: false }` responses — unchanged.

```typescript
// Shared guard for every buy-style request type: check canPlaceOrder, reserve
// the slot via bookkeeping.markPending() (so a concurrent request for the same
// user sees the reservation - see bookkeeping.markPending's doc comment), then
// run the actual broker call.
//
// On success, the broker call itself is responsible for releasing the
// reservation - synchronously, via bookkeeping.recordFill, for every market
// order here; asynchronously, later, via pollPendingLimitOrders's recordFill,
// for placeLimitBuyZerodhaBare specifically. Either way this function must
// NOT release on success, or it would double-release / release too early for
// the limit-order case.
//
// On a thrown/rejected broker call, release it here - this is the leak fix:
// previously pendingUsers was never cleared on this path, so a single failed
// order (broker rejection, network error, waitForFill timeout) permanently
// blocked that user's future orders until process restart.
async function placeOrderWithPendingGuard(
    req: OrderRequest,
    estimatedOrderValue: number | undefined,
    place: () => Promise<any>,
): Promise<OrderResponse> {
    const validation = await bookkeeping.canPlaceOrder(req.userId, estimatedOrderValue);
    if (!validation.allowed) {
        return { kind: 'response', id: req.id, ok: false, error: validation.reason };
    }
    bookkeeping.markPending(req.userId, estimatedOrderValue);
    try {
        const result = await place();
        return { kind: 'response', id: req.id, ok: true, result };
    } catch (e) {
        bookkeeping.releasePending(req.userId);
        throw e;
    }
}
```

**IMPORTANT for the executing agent:** `OrderRequest`/`OrderResponse` type
names above are placeholders reconstructed from investigation — read the
actual request/response type names used in `orderProcess.ts` (check the top
of the file / its imports) and use the real ones. Also confirm the actual
`{ kind: 'response', id: req.id, ok: false, error: ... }` shape matches what
every other case in `handleRequest` returns on rejection — match it exactly.

Then replace each of the 7 case bodies (read the CURRENT file first — line
numbers below are from investigation and may have shifted slightly):

**`buyIndex` (was lines 86-97):**
```typescript
            case 'buyIndex': {
                return placeOrderWithPendingGuard(req, undefined, () => {
                    const broker = bookkeeping.getUserBroker(req.userId);
                    return broker === 'ant'
                        ? antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload })
                        : buyIndexOnZerodha({ userId: req.userId, ...req.payload });
                });
            }
```

**`antBuyIndex` (was lines 120-128):**
```typescript
            case 'antBuyIndex': {
                return placeOrderWithPendingGuard(req, undefined, () =>
                    antExecutor.buyIndexOnAnt({ userId: req.userId, ...req.payload }),
                );
            }
```

**`antManualBuy` (was lines 130-139):**
```typescript
            case 'antManualBuy': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload }),
                );
            }
```

**`buyContract` (was lines 158-167):**
```typescript
            case 'buyContract': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    prismExecutor.buyContract(req.userId, req.payload.contract, req.payload.quantity, req.payload.price),
                );
            }
```

**`manualBuy` (was lines 216-228):**
```typescript
            case 'manualBuy': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () => {
                    const manualBuyBroker = bookkeeping.getUserBroker(req.userId);
                    return manualBuyBroker === 'ant'
                        ? antExecutor.manualBuyOnAnt({ userId: req.userId, ...req.payload })
                        : manualBuyOnZerodha({ userId: req.userId, ...req.payload });
                });
            }
```

**`buyContractZerodhaBare` (was lines 289-298):**
```typescript
            case 'buyContractZerodhaBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    marketBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.exchange),
                );
            }
```

**`placeLimitBuyZerodhaBare` (was lines 305-314):**
```typescript
            case 'placeLimitBuyZerodhaBare': {
                const estimatedValue = req.payload.price && req.payload.quantity ? req.payload.price * req.payload.quantity : undefined;
                return placeOrderWithPendingGuard(req, estimatedValue, () =>
                    placeLimitBuyBareOnZerodha(req.userId, req.payload.tradingSymbol, req.payload.instrumentToken, req.payload.quantity, req.payload.price, req.payload.exchange),
                );
            }
```

The `case 'canPlaceOrder':` handler (line 83-84) and every non-buy case
(`squareOff`, `antSquareOff`, `sellContract`, etc.) are untouched.

**Important type-safety cross-check:** because `pendingOrders` changes type
from `Set<string>` to `Map<string, PendingOrder[]>`, `npx tsc --noEmit` will
fail on any leftover `bookkeeping.pendingUsers.add(...)` call — this is a
deliberate forcing function so the coding agent cannot miss any of the 7
sites. After the edit, `grep -rn "pendingUsers" src` should return zero hits.

## 4. New test file — `src/test/bookkeepingRace.test.ts`

Follows `src/test/bookkeepingDedup.test.ts`'s exact convention: header
comment with the `npm run build`/`node ./dist/...` run instructions, local
`assert()` helper, plain `async function main()`, imports the live
`bookkeeping` singleton directly (no IPC, no `orderProcess.ts` — that layer
isn't unit-testable per the constraints in this task; its correctness is
verified by `tsc` + code review of the `placeOrderWithPendingGuard` wiring,
not by this test). Use unique per-scenario usernames to avoid
cross-test/process-global contamination.

```typescript
/**
 * Verifies bookkeeping.canPlaceOrder accounts for in-flight (pending) orders,
 * not just confirmed trades - closing the race where two concurrent order
 * requests for the same user could both pass canPlaceOrder before either
 * fill landed, exceeding the user's lot/investment limit - and that a
 * pending reservation is correctly released both on order failure (the
 * leak fix) and on a real fill (the existing _processTradeEvent path).
 * Run: npm run build (compile), then: node ./dist/test/bookkeepingRace.test.js
 */

import { Trade } from '../model/model';
import bookkeeping from '../processes/order/bookkeeping';
import { USER_LOSS_LIMIT, DEFAULT_MAX_INVESTMENT } from '../constants';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

function buyFill(user: string, brokerOrderId: string): Trade {
    const t = new Trade();
    t.tsym = 'NIFTY26AUG24100CE';
    t.token = 'tok-race';
    t.quantity = 65;
    t.price = 100;
    t.action = 'Buy';
    t.status = 'COMPLETE';
    t.user = user;
    t.brokerOrderId = brokerOrderId;
    return t;
}

async function main() {
    // (a) A pending reservation blocks a second concurrent order for the same
    // user, reproducing orderProcess.ts's exact call order: canPlaceOrder,
    // then (only if allowed) markPending, before the broker call resolves.
    const RACE_USER = 'RaceTestUser';
    bookkeeping.updateUserSettings(RACE_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    const before = await bookkeeping.canPlaceOrder(RACE_USER);
    assert(before.allowed === true, 'first order is allowed when nothing is traded or pending');

    bookkeeping.markPending(RACE_USER); // request A passed canPlaceOrder and reserved its slot
    const during = await bookkeeping.canPlaceOrder(RACE_USER); // request B, concurrent, before A's fill
    assert(during.allowed === false, 'a second concurrent order for the same user is blocked while the first is still pending');
    assert(/lot limit/i.test(during.reason || ''), `rejection reason mentions the lot limit (got "${during.reason}")`);

    // (b) A failed/thrown order releases its reservation (the leak fix), so a
    // subsequent legitimate order is allowed again. This exercises the exact
    // bookkeeping primitives orderProcess.ts's placeOrderWithPendingGuard
    // calls in its catch block - the IPC/orderProcess.ts wiring itself isn't
    // unit-testable here and must be verified by code review + tsc.
    const LEAK_USER = 'LeakTestUser';
    bookkeeping.updateUserSettings(LEAK_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(LEAK_USER); // request A reserved its slot...
    const blocked = await bookkeeping.canPlaceOrder(LEAK_USER);
    assert(blocked.allowed === false, 'pending reservation blocks a second order (sanity check before releasing)');

    bookkeeping.releasePending(LEAK_USER); // ...then A's broker call threw - orderProcess.ts's catch releases it
    const afterRelease = await bookkeeping.canPlaceOrder(LEAK_USER);
    assert(afterRelease.allowed === true, 'releasePending clears the reservation so a later legitimate order is allowed again');

    // (c) A real fill clears the pending marker via the existing
    // _processTradeEvent path (recordFill -> releasePending), and canPlaceOrder
    // then reflects the real, confirmed trade - not a stale pending entry.
    const FILL_USER = 'FillTestUser';
    bookkeeping.updateUserSettings(FILL_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(FILL_USER, 6500); // as buyContract/manualBuy would pass an estimatedOrderValue
    const blockedWhilePending = await bookkeeping.canPlaceOrder(FILL_USER);
    assert(blockedWhilePending.allowed === false, 'pending reservation blocks a second order before the fill lands');

    await bookkeeping.recordFill(buyFill(FILL_USER, 'race-fill-order-1'));

    const pendingAfterFill = bookkeeping.pendingOrders.get(FILL_USER) ?? [];
    assert(pendingAfterFill.length === 0, `fill clears the pending reservation (got ${pendingAfterFill.length} still pending)`);

    const tradedLots = bookkeeping.getTradedLots(FILL_USER);
    assert(tradedLots === 1, `confirmed fill counts toward getTradedLots (got ${tradedLots})`);

    const afterFill = await bookkeeping.canPlaceOrder(FILL_USER);
    assert(afterFill.allowed === false, 'still blocked after the fill, but now by the real confirmed lot limit');
    assert(/lot limit/i.test(afterFill.reason || ''), `rejection reason reflects the confirmed trade (got "${afterFill.reason}")`);

    // (d) Releasing one of two concurrent reservations for the same user must
    // not drop the other still-in-flight one - this is the specific failure
    // mode a plain Set<string> (delete-by-user) could not avoid, and the
    // reason pendingOrders is a per-user list rather than a boolean flag.
    const MULTI_USER = 'MultiPendingTestUser';
    bookkeeping.updateUserSettings(MULTI_USER, { lossLimit: USER_LOSS_LIMIT, lotLimit: 1, maxInvestment: DEFAULT_MAX_INVESTMENT });

    bookkeeping.markPending(MULTI_USER); // order A
    bookkeeping.markPending(MULTI_USER); // order B, also concurrently in flight
    assert((bookkeeping.pendingOrders.get(MULTI_USER)?.length ?? 0) === 2, 'two concurrent pending orders for the same user are both tracked');

    bookkeeping.releasePending(MULTI_USER); // order A fails and is released
    const stillBlocked = await bookkeeping.canPlaceOrder(MULTI_USER);
    assert(stillBlocked.allowed === false, 'order B (still pending) still counts toward the lot limit after releasing A alone');

    bookkeeping.releasePending(MULTI_USER); // order B fails too
    const clearNow = await bookkeeping.canPlaceOrder(MULTI_USER);
    assert(clearNow.allowed === true, 'once both reservations are released the user can order again');

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
```

Notes on this test file:
- `bookkeeping.pendingOrders` must remain a **public** field (no `private`
  keyword) exactly like the current `pendingUsers`/`trades`/`closedTrades`/
  `userPnL`, so the test can assert on it directly (matches this file's
  existing "expose in-memory state for direct test inspection" convention).
- Scenario (c)'s `recordFill` call also exercises the unrelated-but-adjacent
  `processedFillIds` dedup path harmlessly (unique `brokerOrderId`),
  consistent with `bookkeepingDedup.test.ts`.
- Do not reuse `'RaceTestUser'`-style names across test files if both are
  ever run in the same process invocation — here every scenario already uses
  its own dedicated user, and the file as a whole uses names disjoint from
  `bookkeepingDedup.test.ts`'s `'DedupTestUser'`.
- **Before writing this file, read `bookkeeping.updateUserSettings`'s actual
  signature** — the snippet above assumes it accepts
  `(user, { lossLimit, lotLimit, maxInvestment })`; confirm field names match
  the real `UserSettings` interface (`lotLimit?`, `maxInvestment?` per
  investigation) and adjust if they differ.

## 5. Files to touch

| File | Change |
|---|---|
| `/home/karthikeyan/work/icici/src/processes/order/bookkeeping.ts` | Replace `pendingUsers: Set<string>` with `pendingOrders: Map<string, PendingOrder[]>` + new `PendingOrder` interface; add `markPending`/`releasePending`/`pendingLots`/`pendingValue`; update `hasActiveTrade` and `canPlaceOrder` to consult pending state; update `_processTradeEvent`'s Buy branch to call `releasePending` instead of `pendingUsers.delete` |
| `/home/karthikeyan/work/icici/src/processes/orderProcess.ts` | Add `placeOrderWithPendingGuard` helper; rewrite the 7 buy-style `case` bodies (`buyIndex`, `antBuyIndex`, `antManualBuy`, `buyContract`, `manualBuy`, `buyContractZerodhaBare`, `placeLimitBuyZerodhaBare`) to use it instead of raw `bookkeeping.pendingUsers.add(...)` |
| `/home/karthikeyan/work/icici/src/test/bookkeepingRace.test.ts` (new) | New hand-rolled test, matching `bookkeepingDedup.test.ts`'s convention, covering the race fix, the leak fix, fill-triggered cleanup, and multi-pending-per-user correctness |

Out of scope (do not touch unless separately requested): `src/monitor.ts` has
the same `pendingUsers: Set<string>` pattern (lines 32, 74, 91, 179, 399) in
the legacy monolithic `server.ts`/`prism.ts` path — this plan only covers the
split-process `order`/`orderProcess.ts`/`bookkeeping.ts` path per the bug
report's scope. `src/server.ts:139` has a comment already noting the old
path's `hasActiveTrade` doesn't include the `pendingUsers` window — leave
as-is.

## 6. Verification checklist (for the orchestrator to run)

```bash
cd /home/karthikeyan/work/icici

# 1. Typecheck only (fast, no dist/ output) - must be clean, and specifically
#    must NOT show any leftover `pendingUsers` reference (the type change from
#    Set to Map is a deliberate forcing function for missed call sites).
npx tsc --noEmit

# 2. Confirm no leftover references to the old field name anywhere in src/.
#    Expected: no output.
grep -rn "pendingUsers" src

# 3. Full compile to dist/ (this repo has no `npm run build` script - use tsc
#    directly, matching test:strategy/test:continuousStrategy's own pattern).
npx tsc

# 4. Run the new test directly (no jest - hand-rolled script convention).
node ./dist/test/bookkeepingRace.test.js
echo "exit code: $?"
```

Expected output from step 4: 12 `PASS:` lines (2 for scenario a, 2 for b, 4
for c, 4 for d) and a final `ALL TESTS PASSED` line, with exit code `0`.

Also re-run the pre-existing test to confirm no regression from the
`bookkeeping.ts` edits:
```bash
node ./dist/test/bookkeepingDedup.test.js
```
Expected: `ALL TESTS PASSED`.

If any `FAIL:` line appears, or `tsc --noEmit`/`tsc` report errors, or
`grep -rn "pendingUsers" src` returns any hit, the change is not done — do
not mark this bug fixed.
