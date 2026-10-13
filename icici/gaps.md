# Known Gaps

Known, real issues that have been identified but deliberately deferred -
not historical/resolved items (that's ToDo.md's job). Each entry should have
enough context for a fresh session with no prior conversation history to
pick up and fix without re-deriving the investigation.

## Partial-fill accounting across all 4 brokers' cancel/square-off paths

**Found:** 2026-10-13, during code review of a `cancelOrderOnX` hardening pass
(see git log `2815993`..`0863bea` on `main` for the full chain of fixes that
led here - the shared `cancelOrderWithFillRecheck` helper in
`src/processes/order/BrokerExecutor.ts` is the end result of that pass and
is directly relevant to this gap).

**The problem:** None of the four brokers' fill-confirmation checks
distinguish a **partial** fill (some quantity filled, the rest
cancelled/rejected) from either a full fill or a non-fill. Each one only
asks a binary question - and when the real answer is "partially" - each
broker's code takes a different, individually wrong action:

- **Breeze** (`src/processes/order/breezeExecutor.ts`, `cancelOrderOnBreeze`'s
  `isFilled` closure, ~line 357-360): checks `average_price > 0`. A partial
  fill also has a nonzero average price, so this returns `true` for a
  partial fill exactly the same as a full one. `cancelOrderOnBreeze` then
  throws `OrderAlreadyFilledError`, and **both** of `squareOffOnBreeze`'s two
  catch branches that handle this (`src/processes/order/breezeExecutor.ts`,
  the `OrderAlreadyFilledError` branch around line 278-313, and the
  "unrelated cancel failure" fallback branch around line 315-330) then call
  `recordSellFill(orderId, lateFillPrice)`, which books the **entire
  original `quantity`** (squareOffOnBreeze's own parameter, captured in that
  closure) as sold - not the quantity that actually filled. Net effect:
  bookkeeping shows the position fully closed while a real, unmanaged
  residual quantity is still open at the broker, with nothing left tracking
  it - it can never be squared off again through the normal path.

- **Zerodha** (`src/processes/order/zerodhaExecutor.ts`,
  `cancelOrderOnZerodha`'s `isFilled` closure, ~line 533-535): checks
  `history[history.length - 1]?.status === 'COMPLETE'`. Kite reports a
  partial-fill-then-cancel as `'CANCELLED'` (with `filled_quantity` nonzero
  on that same record), not `'COMPLETE'` - so this returns `false` for a
  partial fill. `cancelOrderWithFillRecheck` then takes the "genuinely not
  filled" path and calls `untrack()`. Net effect: the opposite error from
  Breeze's - the partially-filled quantity is silently dropped entirely,
  never recorded anywhere. Bookkeeping thinks the full original quantity is
  still open/unsold when some of it actually already sold at the broker.

- **ANT** (`src/ant/ANT.ts`, `getOrderStatus`, used by
  `src/processes/order/antExecutor.ts`'s `cancelOrderOnAnt`): same shape as
  Zerodha - only treats `orderStatus === 'COMPLETE'` as filled. AliceBlue's
  own order-history records (confirmed live elsewhere this session - see the
  raw JSON sample in this session's history) carry `filledQuantity`/
  `pendingQuantity`/`cancelledQuantity` fields separately from `orderStatus`,
  so a partial fill's remainder-cancelled record likely reports
  `orderStatus: 'CANCELED'` with a nonzero `filledQuantity` - same
  silently-dropped-partial-fill gap as Zerodha.

- **Prism** (`src/prism.ts`, `getOrderStatus` method, ~line 758-780): same
  shape again - only `match.status === 'COMPLETE'` counts as filled; a
  partial-fill-then-cancel reports `'CANCELLED'`/`'CANCELED'` (normalized to
  `'CANCELLED'`) and falls into the same silently-dropped-partial-fill gap.

**Why this matters:** BulkPcrStrategy and others routinely place
large-quantity chunked orders (e.g. sized up to NIFTY's freeze-quantity cap
via `splitIntoFreezeQtyChunks`, `src/util/quantityChunks.ts`) that can
realistically partially fill before a timeout-triggered cancel. This isn't a
rare edge case for this codebase's actual order sizes.

**Why it wasn't fixed inline (2026-10-13):** The review surfaced it on the
Breeze branch specifically, but confirmed the identical `average_price > 0`
+ full-quantity pattern already existed in the untouched sibling branch
right next to it - i.e. it's a pre-existing architectural gap in all four
brokers' fill-confirmation primitives, not something introduced by that
session's changes. Fixing it properly means changing what each of the four
`isFilled`/`getOrderStatus` checks returns (from a boolean/status string to
something that also carries the actually-filled quantity), and updating
every caller that currently assumes "filled" means "fully filled" -
`cancelOrderWithFillRecheck`'s `isFilled(): Promise<boolean>` signature
itself needs to become quantity-aware, cascading into
`OrderAlreadyFilledError` (`src/processes/order/BrokerExecutor.ts`) needing
to carry the actual filled quantity, `squareOffOnBreeze`'s two recovery
branches needing to record only that quantity (not the closure's `quantity`
param) and re-attempt the genuine remainder, and `orderProcess.ts`'s
`cancelAnyRestingLimitSell` (already quantity-aware as of commit `d0ecc63`,
summing `OrderAlreadyFilledError`-confirmed quantities per order) needing to
receive the same precise number instead of assuming "confirmed filled" means
the whole order's `quantity`.

**Suggested approach for the fix session:**
1. For each broker, find the actual field(s) that expose partial-fill
   quantity on the same order-history/order-detail call `isFilled` already
   makes (Kite: `filled_quantity`; AliceBlue: `filledQuantity`; Shoonya/Prism:
   likely `fillshares`/`qty`, needs live confirmation; Breeze: likely
   `pending_quantity`/`cancelled_quantity` per `Breeze.ts`'s own documented
   shape, needs live confirmation against `getOrderDetail`'s actual response).
2. Change `cancelOrderWithFillRecheck`'s `isFilled` contract to
   `() => Promise<number>` (actual filled quantity, 0 if none) instead of
   `Promise<boolean>`, and have `OrderAlreadyFilledError` carry that quantity.
3. Update all 4 `cancelOrderOnX` wrappers' `isFilled` closures to return the
   real quantity instead of a boolean derived from status alone.
4. Update `squareOffOnBreeze`'s two `OrderAlreadyFilledError`/fallback
   recovery branches to record only the confirmed-filled quantity (not the
   outer `quantity` parameter), and - if the confirmed quantity is less than
   the original - loop back into the retry mechanism for just the genuine
   remainder instead of treating the order as fully resolved.
5. Confirm `cancelAnyRestingLimitSell` (orderProcess.ts) still sums correctly
   once `OrderAlreadyFilledError.quantity` reflects a true partial amount
   rather than always being the order's full original quantity (it already
   sums per-order via `order.quantity` from the pending-order record today -
   needs to switch to the new per-error quantity instead).
6. Verify end-to-end with a deliberately large chunk order in a low-liquidity
   contract (or a controlled test) that's likely to partially fill before a
   timeout-triggered cancel, confirming bookkeeping ends up with exactly the
   right remaining open quantity, not zero and not the full original amount.
