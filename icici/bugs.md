# Known Bugs

## Codebase-wide audit findings (2026-08-28)

5-agent parallel audit covering streaming pipeline, order execution/risk management,
strategies/decision engine, auth/session/multi-user isolation, and persistence/config/
frontend. Investigation only — nothing below is fixed yet. Organized by priority; auth-
related items are deliberately marked Low per user direction (not urgent to fix), except
that order-to-user traceability itself must stay intact — see note at the end of the Low
section.

### High priority

**Loss limit / lot constraint race.** `canPlaceOrder()` (`src/processes/order/bookkeeping.ts:262-289`)
checks confirmed trades only, never `pendingUsers` (which exists specifically to cover
in-flight orders but has zero live callers — `hasActiveTrade()`, which does check it, is
unused). Two quick order requests for the same user (double-click, retry, two strategies
signaling at once) can both pass the check before either fill lands, exceeding the user's
configured lot/investment limit.

**Orphaned broker position on fill-notify failure.** `enterPosition` (`src/processes/order/antExecutor.ts:32-119`)
waits up to 60s for `AntOrderNotifyStream.waitForFill` *before* recording the trade in
bookkeeping or setting target/SL. If the order fills at the broker but the notify event is
missed (a documented unverified assumption in `AntOrderNotifyStream.ts:40-46`), the timeout
throws and the position is left completely untracked — unprotected, uncounted against
limits, invisible on `/positionstream`. No reconciliation job compares live broker positions
against internal state; `ANT.getPositions()` is only used by a read-only display route.

**Cross-user protection loss on shared contracts.** `exitMonitor`'s `monitored` map
(`src/processes/order/exitMonitor.ts:31`) is keyed by `token` only, not `(user, token)`. If
two users hold a position in the same option contract concurrently, the second user's
`registerTrade` silently overwrites the first's — the first user's target/SL never fires
again, with no error and no self-healing (even `reconcileFromTrades` on restart re-clobbers
the same token).

**Exit monitoring can be permanently disabled by any transient failure.** `handleOptionTick`
(`exitMonitor.ts:111-129`) unregisters a trade from monitoring *before* attempting the exit
(to prevent double-firing), but never re-registers on failure (`catch` at line 127-128 just
logs). One network hiccup during an automated target/SL exit silently ends all further
protection on that position for the rest of the day.

**Strategy state isn't persisted across restarts.** `BuySellStrategy`'s "position already
open" flag (`this.ordered`) and cooldown timer live only in memory (`src/strategy/strategy.ts:22,37-40`).
A `strategies` process restart (observed happening repeatedly today via `tsc-watch` in normal
dev) resets both, and if entry conditions still hold on the next tick, it can fire a
duplicate entry order against a position the `order` process still holds — no cross-process
reconciliation exists (`OrderClient.stats()` could supply this but is never called on boot).

**Live-path Mongo writes can crash the `order` process.** `bookkeeping.ts:415` wraps an
un-awaited async `Mongo.insert()` call in `try/catch`, which cannot catch the eventual
rejection. No `process.on('unhandledRejection', ...)` exists anywhere in the repo — a
transient Mongo error during a trade-event write crashes the whole `order` process, losing
in-flight risk state. Same un-awaited pattern also present in `src/monitor.ts:397,485`
(dead code, lower urgency) and un-guarded entirely in `src/decision.ts`, `src/trade/option.ts`,
`src/trade/option-plus.ts`, `src/trade/icici.ts`.

**Zombie WebSocket connections are undetectable.** `AntWebSocket.ts:29-35`'s heartbeat sends
a ping every 3s but never checks for a reply, and there's no "time since last message"
watchdog. A half-open connection can report `readyState: OPEN` indefinitely with `close`/
`error` never firing, so reconnect logic never triggers. Matches this session's own
observation: `data`'s WS reported connected for 12+ minutes with zero ticks reaching the
frontend, with no way to tell from logs whether that was a quiet auction or a dead socket.

**Square-off race.** `squareOffOnAnt` (`antExecutor.ts:299-340`) has no "in flight" guard.
The trade isn't removed from `bookkeeping.trades` until after the broker call and fill
confirm. A manual squareoff and an `exitMonitor` auto-triggered exit calling the same
function can both fire close together and both issue a live exit order concurrently.

**No timeout on broker HTTP calls or the strategy→order IPC call.** `ANT.ts`'s `placeOrder`/
`placeBracketOrder`/`exitBracketOrder` never pass an axios `timeout`; `OrderClient.request()`
(`src/processes/strategies/OrderClient.ts:81-89`) has no timeout on its IPC promise either. A
hung connection to AliceBlue during order placement can silently and permanently stall the
calling strategy (it never returns from its `await`), with no error surfaced anywhere short
of a manual process restart.

**`pendingUsers` leak.** `pendingUsers.add(userId)` (`orderProcess.ts:91` etc.) happens before
the broker call and is only cleared inside a successful `recordFill`. Any exception between
those two points (broker rejection, network error, `waitForFill` timeout) permanently marks
the user "active" until process restart, silently blocking their further orders.

**Quote collection name drift.** Live ticks write to Mongo collection `NiftyQuote` via
`NiftyQuote.fromAnt()`, but `GET /replay` (`server.ts:1365`), `src/tools/pipeline.ts:329`, and
`src/prism/MockAPI.ts:52,71` all read from collection `Quote` (populated only by the legacy,
unused ICICI-direct path in `src/trade/icici.ts:83`). `/replay?date=<today>` silently 404s
even though today's data was actually recorded — same class of bug as the streaming
`prevClose`/`changePercent` fix already applied this session, just at the persistence layer.

**No server-side `/config` validation.** `POST /config` (`server.ts:1352-1356`,
`ConfigService.ts:41-45`) only checks `typeof v.type === 'string'` before writing straight to
disk — a negative `lossLimit`, negative `quantity`, or `stopLossPoints >= targetPoints` is all
accepted via a direct API call, bypassing whatever validation exists only in the frontend form.

### Medium priority

**GridFS KYC documents: re-upload should be blocked after submission, not just cleaned up.**
`POST /users/:email/documents/:docType` (`server.ts:401-443`) currently lets a document be
re-uploaded an unlimited number of times after the user has already submitted it, silently
overwriting the `<field>ProofId` pointer — with no `bucket.delete()` of the previous GridFS
file, so every re-upload also leaves the prior version permanently orphaned. **Required
behavior:** once a document type has been submitted (and especially once KYC has been
verified/approved), the upload endpoint should reject further uploads for that `docType`
for that user rather than silently accepting a replacement — re-submission should go through
an explicit "resubmit"/admin-reset flow, not the same unrestricted POST. Orphan cleanup
(`bucket.delete()` on replacement) is a secondary fix if resubmission is ever legitimately
allowed.

**Square Off has no duplicate-submit guard on the frontend.** `squareOff()` in
`TradingContext.tsx:187-202` never sets an in-flight flag, and the button has no `disabled`
prop — only a `window.confirm()` dialog stands between clicks. Confirming, then clicking
again while the first request is in flight, fires a second square-off call for the same
position.

**No global 401/session-expiry handling on the frontend.** Session is checked via `/auth/me`
only once, on mount (`AuthContext.tsx:63-72`). If the cookie expires mid-session, `user`/
`isLoggedIn` state stays stale, and every subsequent action fails with a generic "Order
rejected" error with no indication that re-login would fix it.

**Strategy dispatch loop has no per-strategy error isolation.** Both the `receive()` loop and
the `processNiftyQuote()` loop in `strategiesProcess.ts:47-54` iterate with plain
`for...of` + `await`, no try/catch per strategy. If any single strategy throws, every
strategy *later* in `strategies.getList()` is silently skipped for that tick — only a log
line, no alert.

**`Minutes5Decision` bypasses its own `enabled` flag.** Its constructor hardcodes
`this.enabled = true` (`Minutes5Decision.ts:73`) regardless of config, and the `receive()`
dispatch loop (`strategiesProcess.ts:47-51`) doesn't gate on `enabled` at all for that call
path. Currently dormant only because it isn't in the live strategy list — if ever added,
disabling it via config would not actually stop it from trading.

**`GoodMorningStrategy`'s "already traded today" flag isn't persisted.** `resetIfNewDay()`
resets `traded = false` on every restart (since `tradingDay` starts `null`). If a restart
lands inside the ~2-minute `LATE_WINDOW_MINUTES` grace period after a trade already executed,
the strategy can fire a second trade that day. Narrow window, but same bug class as the
`BuySellStrategy` restart issue above; note this strategy is otherwise well-hardened against
restarts (persists snapshot/confirm times to `config.yml` specifically for this).

**`/optionstream` has the same no-replay-on-connect gap `/niftystream` had**
(`server.ts:1103-1109`) — no snapshot pushed to a newly-connecting client. Currently no live
impact since nothing in `frontend/src` consumes `/optionstream` today, but will silently
misbehave the moment something does.

### Low priority

**`ORBPrevious` strategy is fully implemented but unreachable.** Never registered in
`StrategyFactory.ts`'s `STRATEGY_REGISTRY`, so it can never be instantiated from config.
Dead code; its `receive()` also unconditionally throws "Method not implemented," which is
moot only because it's unreachable.

**Hardcoded broker API key in source.** `src/zerodha/Zerodha.ts:27` — real Zerodha API key
committed directly to source instead of an env var.

**Auth bypass via unverified `X-User-Id` header.** `resolveUser()` (`server.ts:67-71`) trusts
the raw `X-User-Id` request header with no verification when no signed session cookie is
present.

**Hardcoded, source-committed cookie-signing secret.** `server.ts:60` — the literal
`'propfirm-secret'`; forgeable by anyone with source access even for the cookie-based path.

**IDOR across every `/users/:email/...` route.** No check anywhere that `req.params.email`
matches the authenticated caller — KYC documents (`server.ts:401,445`), payout records
(`server.ts:477+`), risk settings (`server.ts:222`), closed trades and notifications are all
readable/writable by email alone, and `GET /users` (`server.ts:136`) hands out the full user
list (and thus every email) to any caller.

**No CSRF `state` parameter on the ANT OAuth callback.** `/ant/login` / `/ant/callback`
(`server.ts:655,667`) — standard OAuth CSRF gap. Lower severity today since the broker
session (`antAccessToken`) is a single shared process-level token, not bound per end-user;
would become a real account-binding risk if broker OAuth is ever made per-user.

**Note on scope:** despite deprioritizing the above, order-to-user attribution itself is
*not* one of these gaps — the order/risk audit confirmed everything in `bookkeeping.ts`
(trade records, P&L, lot/investment tracking) is correctly `.user`-scoped today. Keep that
property intact when eventually working through the items above (e.g. any auth-model
rework must not weaken how orders are attributed to users) — see also the existing
`norenordno` bug below, which is a *different*, already-tracked gap in that same guarantee
(square-off orders not going through `Monitor.trackOrder()`).

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

## BulkPcrStrategy LPP order rejection (2026-09-22 12:32:50)

**Status:** Active — requires manual review / contract data refresh

**Incident:** BulkPcrStrategy enabled at 12:32:47, evaluated PCR=0.730, resolved to **CALL** direction, attempted chunked entry buy order for NIFTY2692223350CE at price=139.45 for qty=1755 (8 chunks). Chunk 1/8 failed immediately with Zerodha LPP (Limit Price Protection) rejection: "Your order price is higher than the current limit price protection of 64.30. Please place an order below 64.30."

**Root cause:** Unknown — either:
1. Strategy pricing logic is off by ~2.2x (139.45 vs realistic 64.30)
2. Contract master data is stale (Zerodha instruments CSV is **32 days old**, ANT contract master is **36 days old**)
3. PCR-to-direction resolution is correct but contract selection/pricing is misaligned with current market conditions

**Actions taken:**
- System caught the failure and flagged for manual review (no partial fill, all 13975 qty rejected)
- Error logged: `BulkPcrStrategy.processNiftyQuote` → `OrderClient.chunkedBuyIndex` → `Zerodha.placeLimitBuyOption`
- Strategy gate state: `phase=error`, prevents duplicate attempts

**Follow-up required:**
1. Run `scripts/download-zerodha-master.sh` to refresh Zerodha instruments (32 days stale)
2. Re-download ANT contract master from `https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/` (36 days stale)
3. Review `BulkPcrStrategy.resolveEntryRight()` pricing logic — verify contract selection and price derivation against live market data
4. Consider adding pre-order validation: cap order price at or below current LTP + safety buffer before sending to broker

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
