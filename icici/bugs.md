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
