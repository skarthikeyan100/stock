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

## investmentAmount has no effect on manual-buy order sizing

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

**Fix:** Port equivalent sizing logic into the active path so it's reachable from BOTH
`manualBuyOnZerodha` (`src/processes/order/zerodhaExecutor.ts`) and `manualBuyOnAnt`
(`src/processes/order/antExecutor.ts`) — broker-agnostic, backend-only; the frontend should
keep expressing intent only (e.g. "size this using my investment mode"), never compute or
send a broker-specific quantity itself.

## investmentAmount is not editable anywhere in the frontend

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

**Fix:** Add an editable `investmentAmount` input to `ProfilePage.tsx`.

## Every manual buy uses a hardcoded global 2pt/11pt target/stop-loss regardless of user or broker

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

**Fix:** Should stay broker-agnostic (both `zerodhaExecutor.ts` and `antExecutor.ts` currently
hardcode the same global settings for manual buys) and backend-driven.
