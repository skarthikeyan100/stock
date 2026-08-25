# Known Bugs

## `norenordno` response access inconsistency (`prism.ts`)

**Location:** `_placeOrderWithForce` (~line 1176) vs `squareOffOrder` (~line 1231)

`squareOffOrder` checks:
```typescript
if (user && orderReply?.data?.norenordno)
```

But the axios response interceptor in `RestAPI.ts` (lines 71-95) unwraps `response.data` automatically for all 200 responses — so `place_order` actually returns `{ stat: 'Ok', norenordno: '...' }` directly, not wrapped in `{ data: {...} }`.

The correct check (as used in `_placeOrderWithForce`) is:
```typescript
if (user && response?.norenordno)
```

**Impact:** In `squareOffOrder`, `Monitor.trackOrder()` is never called, so the user-to-order mapping is not set for square-off orders. This means user P&L tracking and loss limits may not correctly account for square-off fills.

**Fix:** Change `orderReply?.data?.norenordno` to `orderReply?.norenordno` in `squareOffOrder`.

## investmentAmount has no effect on manual-buy order sizing [RESOLVED]

The live Zerodha manual-buy path never reads `investmentAmount`/`investmentMode` at all.
Quantity always defaults to one lot (`bookkeeping.getInstrumentLotSize`, e.g. 65 for NIFTY)
whenever the frontend doesn't send an explicit `quantity` — which it never does.

- `frontend/src/context/TradingContext.tsx` `placeOrder`/`placeContractOrder` never send `quantity`.
- `src/server.ts` `GET /prism/order/buy` never reads `quantity` from the query string.
- `src/processes/order/zerodhaExecutor.ts` `manualBuyOnZerodha` (~line 142-165):
  `const quantity = req.quantity ?? bookkeeping.getInstrumentLotSize(...)` — always 1 lot.

Investment-amount-based sizing (`available / (price * lotSize)`, floored to a lot multiple)
DOES exist, but only in the legacy Prism/Shoonya path, unreachable from the current
Zerodha/ANT flow:
- `src/nse_index.ts` `getQuantity(pricePerquantity, userContext)` (~line 82-91)
- `src/prism.ts` `buyContract()` (~line 773-790), `sendLimitOrder()` (~line 1083-1091)

**Fix (implemented):** Added `bookkeeping.resolveManualBuyQuantity(userId, tsym, price, explicitQuantity?)`
— sizes to as many lots as `investmentMode='investmentAmount'` users' remaining capital covers
at the given price, falling back to 1 lot otherwise (unchanged default). Since Zerodha's own
quote/LTP endpoints return 403 for this account (see `Zerodha.ts` `buyOption`'s comment), the
pre-trade price estimate is sourced from ANT instead (`antExecutor.ts`'s new
`estimateOptionPrice()`/`safeAntQuote()`, never throws — falls back to 1-lot sizing on any
quote failure) and reused by both `manualBuyOnZerodha` and `manualBuyOnAnt`'s `contract`/
`strikePrice` branches. The `right`-only (Flash Trade / ATM-by-index) branch is unchanged,
still 1 lot by default — no pre-resolved contract to price there without added complexity.

## investmentAmount is not editable anywhere in the frontend [RESOLVED]

`frontend/src/pages/ProfilePage.tsx` has an editable `investmentMode` selector (~line 218-231,
`Form.Select` + "Save Mode" button posting to `/users/:email/settings`), but `investmentAmount`
itself has no input field anywhere — it's only interpolated read-only into descriptive text
(~line 235): "Each trade uses your entire allocated capital (₹{investmentAmount}) to buy the
maximum possible quantity" — text that is also currently misleading, since that behavior isn't
what actually executes (see above). `AdminPage.tsx` doesn't expose it either, even for admins.
Backend already supports setting it (`POST /users/:email/settings` accepts `investmentAmount`,
`src/user.ts` `updateUserSettings` persists it) — only the frontend input is missing. Currently
stuck at the Mongo-seeded default (₹100,000, `src/user.ts` ~line 59/81) unless set via a raw
API call.

**Fix (implemented):** `investmentAmount` is admin-only by design (per user direction) — added
an editable ₹ column to `AdminPage.tsx`'s users table (mirroring the existing `perOrderCap`
column) instead of `ProfilePage.tsx`, which now shows it read-only with a note to contact an
admin. Backend already persisted `investmentAmount` from `POST /users/:email/settings`.

**Note:** `POST /users/:email/settings` itself has no role/admin check at all — it's the same
shared endpoint `ProfilePage.tsx` (self-service, `investmentMode` only) and `AdminPage.tsx`
(any user's `lossLimit`/`lotCount`/`useGTT`/`perOrderCap`/`investmentAmount`/etc.) both call, so
a non-admin could still set their own `investmentAmount` via a raw API call — the UI restriction
alone doesn't enforce this server-side. This is pre-existing and applies equally to every field
on that endpoint, not just `investmentAmount` — flagging as a separate, broader follow-up rather
than a partial fix for one field.

## Every manual buy uses a hardcoded global 2pt/11pt target/stop-loss regardless of user or broker [PARTIALLY RESOLVED]

`src/processes/order/zerodhaExecutor.ts` `buyContractOnZerodha()` (~line 186-187):
`finalizeEntry(trade, userId, exchange, settings.targetPriceDiff, settings.stopLossPriceDiff)`
— always uses `config.yml`'s global `settings.targetPriceDiff` (2) / `settings.stopLossPriceDiff`
(11), regardless of the placing user's profile or the instrument's price level. This is why a
manual buy squared off almost immediately at ~₹2/point profit once the broker-side GTT bracket
(placed at entry ± 2/11 points) triggered.

`frontend/src/components/OrderEntry.tsx` (the buy form) has no target/SL inputs at all, and
`TradingContext.tsx` `placeOrder`/`placeContractOrder` never send `targetPoints`/`stopLossPoints`.
There's a post-entry edit path (`PositionCard.tsx` → `setTargetStopLoss` → `POST /prism/settarget`
→ `zerodhaExecutor.ts` `setTargetStopLoss()`), but it's effectively unreachable in practice:
`PositionCard.tsx` computes `hasTargetSet = !!trade.targetPrice || !!trade.stopLossPrice`, and
since `finalizeEntry` sets both synchronously before the trade first reaches the frontend via
SSE, `hasTargetSet` is already true on first render — so the editable T/SL inputs are hidden and
only the (already-defaulted) read-only text is ever shown, before or after the buy.

**Fix (implemented):** `ManualBuyRequest` (both executors) now carries optional `targetPoints`/
`stopLossPoints`; when set, they override `settings.targetPriceDiff`/`stopLossPriceDiff` for
that order (unset still falls back to the global default - fully backward compatible).
`OrderEntry.tsx`'s Symbol Search form now has optional "Target pts" / "Stop-loss pts" inputs,
threaded through `TradingContext.tsx` → `GET /prism/order/buy` → `manualBuyOnZerodha`/
`manualBuyOnAnt`. Also fixed `orderProcess.ts`'s `manualBuy` IPC case, which was hardcoded to
always call `manualBuyOnZerodha` regardless of the placing user's broker setting - now routed
per-user via `bookkeeping.getUserBroker()`, consistent with `buyIndex`/`squareOff`.

**Still open:** Flash Trade (`placeOrder`/`right`-only buys) has no target/SL inputs - still
always uses the global default. `PositionCard.tsx`'s post-entry edit UI is still unreachable
(`hasTargetSet` is already `true` on first render since `finalizeEntry` sets both synchronously
at fill time) - not fixed here, since order-time inputs now cover the reported case.
