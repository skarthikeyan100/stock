# Bug: `pendingUsers` leak — SUPERSEDED, do not fix separately

**Status: fully covered by `plans/bug-01-loss-limit-race.md`. Do not apply a
separate fix for this bug.**

## The bug

`bookkeeping.pendingUsers.add(userId)` in `src/processes/orderProcess.ts` runs
before the broker call at all 7 buy-style call sites, but is only ever
cleared inside a successful `recordFill`. Any exception thrown between the
`add()` and the fill (broker rejection, network error, `waitForFill` timeout)
leaves the user permanently marked "active" in `pendingUsers` until the
process restarts, silently blocking all of that user's future orders.

## Why this file doesn't carry its own fix

`plans/bug-01-loss-limit-race.md` fixes the loss-limit/lot-constraint race by
replacing `pendingUsers: Set<string>` with a per-user reservation list
(`pendingOrders: Map<string, PendingOrder[]>`) and threading `markPending`/
`releasePending` through every buy-style call site. That change requires
releasing the reservation on failure as well as on fill — which is exactly
this bug's fix — so bug-01 implements both in one coherent change rather than
have this file duplicate a slightly different wrapper.

Specifically:

- **`## 3. Exact fix for the leak — src/processes/orderProcess.ts`** in
  bug-01's plan is the section that fixes this bug: it adds the shared
  `placeOrderWithPendingGuard(req, estimatedOrderValue, place)` helper, whose
  `catch` block calls `bookkeeping.releasePending(req.userId)` before
  re-throwing — the leak-cleanup step that doesn't exist today — and rewrites
  all 7 buy-style `case` bodies (`buyIndex`, `antBuyIndex`, `antManualBuy`,
  `buyContract`, `manualBuy`, `buyContractZerodhaBare`,
  `placeLimitBuyZerodhaBare`) to go through it instead of calling
  `bookkeeping.pendingUsers.add(...)` directly.
- Bug-01's own title and intro (top of that file) already name this bug
  explicitly as "bug-10" and state it's fixed as part of the same change.
- Bug-01's `## 6. Verification checklist` includes `grep -rn "pendingUsers"
  src` (expected: no output) as a forcing function proving no leftover
  unguarded call sites remain, plus a dedicated test scenario (scenario (b)
  in `## 4`) asserting a failed order releases its reservation.

## Action for the orchestrator

Execute `plans/bug-01-loss-limit-race.md` in full. Once its verification
checklist (section 6) passes — in particular `grep -rn "pendingUsers" src`
returning no hits and the `bookkeepingRace.test.ts` scenario-(b) PASS lines —
this bug is resolved. No separate implementation work is needed for
`bug-10-pendingusers-leak`.
