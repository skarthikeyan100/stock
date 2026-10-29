# API Documentation

The REST + SSE API served by the `frontend` process (`src/server.ts`; one route module per area under `src/routes/`). Rewritten 2026-10-29 from the registered routes: the earlier version documented many Shoonya-era endpoints that no longer exist. Request and response shapes live in the route's source file; this document lists what exists, who may call it, and what it does.

Base URL: `http://localhost:3000` (also listens on 80, and 443 when `key.pem`/`cert.pem` exist).

## Conventions

- **Identity.** The signed `session` cookie (`email|issuedAtMs`, set by `POST /auth/login`) is the only identity. `X-User-Id` is no longer trusted. Loopback callers (ops scripts) skip auth.
- **Auth levels** used below: *none*, *auth* (any logged-in user), *self/admin* (the user in the path, or an admin), *admin*.
- **State changes are POST (or PATCH/DELETE) only.** Every non-GET request must carry an `X-Requested-With` header (any value) unless it comes from loopback; this is a global guard in `server.ts`. `POST /breeze/callback` is exempt (the broker's own page posts to it).
- **Errors.** Handlers answer `{ error }` JSON with 400/401/403/404/409/500; an unhandled rejection becomes a generic JSON 500.
- **Routes removed 2026-10-29** (no caller anywhere): `/connect`, `/openTrades`, `/trades`, `/closedtrades`, `/users/:email/trades/closed`, `/refreshtrades`, `/subscribetrades`, `/stats`, `/quotes`, `/niftyquote`, `/quote`, `/search`, `/logout`, `/candles`, `/prism/oauthurl`, `/prism/authcode`, `/prism/token`, `/prism/orderbook`, `/breeze/order/buy`, `/breeze/order/squareoff`, `/breeze/connect`, `/breeze/stream`. The GET twins of the state-changing routes are gone (`/ant/connect`, `/order/buy`, `/order/lock-profits`, `/order/squareoff`, `/strategies/:type/reset` are POST only), `/strategies` no longer takes `enable=` (enabling a strategy is a `config.yml` edit), and `/prism/canPlaceOrder` is now `/order/can-place`.

## Authentication

| Route | Auth | Purpose |
|---|---|---|
| `POST /auth/login` | none | Body `{ credential }` (Google ID token). Verifies audience and `email_verified`, creates the account if new, sets the session cookie. |
| `GET /auth/me` | session | The current user (re-issues a legacy cookie with an issue time). 401 `Not logged in` otherwise. |
| `POST /auth/logout` | session | Clears the cookie. |

## Users, KYC and documents

| Route | Auth | Purpose |
|---|---|---|
| `GET /users`, `POST /users` | admin | List / create accounts. |
| `DELETE /users/:email` | admin | Delete an account. |
| `PATCH /users/:email/role` | admin | Change role. |
| `PATCH /users/:email/verify` | admin | Body `{ field, verified }`: set one verification flag (email, phone, address, dob, pan, aadhar, gst). |
| `POST /users/:email/settings` | self/admin | Trading settings (loss limit, lots, investment mode, capital, `useGTT`, broker, caps, target/stop points). Every change is pushed in full to the trading process. |
| `PATCH /users/:email/profile`, `/kyc-numbers`, `/bank-details`, `/entity-type`, `/company-profile` | self/admin | Profile, PAN/Aadhaar numbers, bank details, entity type, company profile. |
| `POST /users/:email/documents/:docType` | self/admin | Upload a KYC document (multipart `file`, 5 MB, type sniffed; PAN/Aadhaar numbers are OCR-checked). |
| `GET /users/:email/documents/:docType` | self/admin | Download it. |

## Payouts

| Route | Auth | Purpose |
|---|---|---|
| `GET /users/:email/payouts`, `/payouts/:id/invoice`, `/payouts/:id/decision-log`, `/payouts/:id/proof` | self/admin | A user's payouts, invoice HTML, the decision log, the payment proof image. |
| `GET /admin/payouts`, `GET /admin/payouts/:id` | admin | List / one payout. |
| `POST /admin/payouts/compute` | admin | Compute a payout for a user and period without saving it. |
| `POST /admin/payouts` | admin | Body `{ user, periodStart, periodEnd }`: create the payout record. |
| `PATCH /admin/payouts/:id` | admin | Body `{ status: 'rejected', note }`: reject a payout (marking one paid goes through `/pay`). |
| `POST /admin/payouts/:id/pay` | admin | Mark paid (multipart `proof` image); sends the "paid" email. |
| `POST /admin/payouts/:id/resend-email` | admin | Resend that email. |

## Broker login and ops queries

| Route | Auth | Purpose |
|---|---|---|
| `GET /:broker/login` for `ant`, `kite`, `breeze`, `prism` | none | Redirects to the broker's login page. |
| `GET /:broker/callback` (same four), `POST /breeze/callback`, `GET /shoonya/callback` | none | OAuth / session callback: exchanges the token, tells `data` to reconnect (ANT, Breeze), has the trading process reload the session (3 tries), redirects to `/`. `/shoonya/callback` is Prism's, registered at the broker. |
| `GET /broker/:broker/trades`, `/broker/:broker/positions` | admin | The broker's own trade book / positions (debug and ops; used by `scripts/check-broker-sessions.sh`). |
| `POST /ant/connect` | admin | Asks `data` to reconnect the ANT feed (it also reconnects by itself). |
| `GET /ant/stream` | admin | Raw SSE relay of every tick `data` sends. |

## Trading

| Route | Auth | Purpose |
|---|---|---|
| `POST /order/buy` | auth | Manual buy through the user's broker (risk limits apply). |
| `POST /order/squareoff` | auth | Square off a position. |
| `POST /order/settarget` | auth | Body `{ token, targetPoints, stopLossPoints }` (numbers >= 0): set target / stop-loss points on an open position. |
| `GET /order/can-place` | auth | `{ allowed, reason? }` from the risk gate (loss limit, lot limit, accountClosed). |
| `POST /order/lock-profits` | admin | See below. |
| `GET /strategyPnl` | admin | Realized and unrealized P&L per strategy (`?match=` regex); used by `scripts/strategy-status.sh`. |
| `GET /admin/trades/open`, `/admin/trades/closed`, `/admin/trades/pnl-summary` | admin | Open trades, closed trades, P&L summary across users. |

### POST /order/lock-profits
Locks the current open P&L. Admin only (loopback callers skip auth). Query: `broker` (`kite`|`breeze`|`ant`; omitted = every broker with an open position), `reprice=true` (re-price a lock that is still resting).

In order: (1) writes `enabled: false` on every enabled strategy to `config.yml` in one atomic write (hot-reloaded by every process). A disabled strategy takes no action at all - no entries, hedges, averages, refills, stops or exits, and it is not told about fills - so nothing can buy behind the lock. (2) The trading process re-reads `config.yml` and refuses to sell if any strategy is still enabled. (3) It cancels resting buy orders, then per (owning user, broker, contract) cancels the resting sells once and places one chunked LIMIT sell for the whole remaining quantity at the broker's live last price (read from its positions at call time, never the trade row's price) rounded up to the tick. A position whose price cannot be read is not sold and is reported as `failed`. A fill can only be at that price or better, so realized P&L ends at or above the open P&L read at the call. Sells are placed under the position's owning strategy user.

Response: `{ disabledStrategies, lock: { brokers, positions: [{ user, broker, tsym, quantity, entryAvg, ltp, limitPrice, lockedPnl, orderIds, status, note }], cancelledBuys, totalLockedPnl } }`. `status` is `locked`, `partial`, `skipped` (already locked within 10 minutes), `filled-during-cancel` or `failed`.

Notes: `lockedPnl` is measured from the bookkeeping row's cost, which a reconcile restores from the latest Mongo buy and can differ from the broker's own average. Only positions in the trading process's bookkeeping are sold. A limit at the current price may not fill if the market falls; it stays resting. A buy that filled before its cancel landed is reported under `cancelledBuys[].filledQty`; call again to lock it. Disabled strategies do not manage open legs, so those positions stay open until sold (this API or by hand). To trade again, set `enabled: true` on the strategies you want in `config.yml`; a startup reconcile (or `POST /reconcile`) hands the open legs back.

## Streams (Server-Sent Events)

| Route | Auth | Purpose |
|---|---|---|
| `GET /niftystream`, `/optionstream` | auth | Live NIFTY and option ticks (the latest NIFTY quote is replayed on connect). |
| `GET /positionstream` | auth | The user's open positions and P&L, re-pushed on every change. |
| `GET /notificationstream`, `GET /users/:email/notifications`, `PATCH /users/:email/notifications/:id/read` | auth, self/admin | Notifications: live stream, history, mark read. |
| `GET /demo/niftystream`, `/demo/optionstream`, `/demo/subscribe`, `/demo/resolve`, `/demo/symbols` | none (rate limited per IP) | The logged-out demo page: ANT-token market data for a small allow-listed set of contracts. |

A comment line is written to every stream every 20 s so a proxy never sees it as idle.

## Strategies, reconcile and configuration (admin)

| Route | Purpose |
|---|---|
| `GET /strategies` (also `POST`) | `[{ type, userId, enabled }]` for every strategy instance. Read-only; enable or disable a strategy by editing `config.yml`. |
| `POST /strategies/:type/reset` | Reset every instance of a strategy type (clears day latches and in-memory state). |
| `POST /reconcile` | Loads each broker's open positions into the trading process, then reconciles every strategy. The trading process does this by itself at start-up (and retries until every broker can be read), so this is for repairing a mismatch. Refused before 09:10 IST. 200 `{ brokers, strategies }`; 409 when a broker could not be read (strategies NOT reconciled); 500 on failure. |
| `GET /config`, `POST /config` | The configuration in flattened form; a save is validated (`configValidation`) and rejected rather than written when the reload would reject it. |

## Frontend

`GET *` serves the React shell (`public/index.html`) to browser navigations; an unknown API-style path (no `Accept: text/html`, or with a file extension) is a JSON 404.

## Data models

See `src/model/model.ts` (`Trade`, `OptionQuote`, `NiftyQuote`, `SensexQuote`) and `src/user.ts` (the user document). Per-user risk state lives in the trading process (`src/processes/order/bookkeeping.ts`).
