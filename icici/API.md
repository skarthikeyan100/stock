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
| `POST /users/:email/settings` | self/admin | Trading settings (loss limit, lots, investment mode, capital, `useGTT`, broker, caps, target/stop points). Every change is pushed in full to the trading process. A non-admin may send only `investmentMode`, `targetPoints` and `stopLossPoints` (the Flash Trade settings popup; targets/stops must be > 0 or null to clear); every other field is admin-only (403). |
| `PATCH /users/:email/profile`, `/kyc-numbers`, `/bank-details`, `/entity-type`, `/company-profile` | self/admin | Profile, PAN/Aadhaar numbers, bank details, entity type, company profile. |
| `POST /users/:email/documents/:docType` | self/admin | Upload a KYC document (multipart `file`, 5 MB, type sniffed; PAN/Aadhaar numbers are OCR-checked). |
| `GET /users/:email/documents/:docType` | self/admin | Download it. |

## Payouts

| Route | Auth | Purpose |
|---|---|---|
| `GET /users/:email/payouts/estimate` | self/admin | Read-only estimate of the payout for the current Wednesday-Tuesday week (gross, split, TDS/GST, net, blocked reason). Creates nothing. |
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
| `POST /order/buy` | auth | Manual buy through the user's broker (kite, ant or breeze; risk limits apply). Quantity: `investmentMode` `investmentAmount` buys as many lots as the remaining capital covers (net of open positions and pending orders; no lot-count cap; clamped to the per-order cap and the exchange freeze quantity, one lot minimum), `lotCount` buys one lot. Applies to the `contract`, `strikePrice` and plain `right` (ATM) forms alike. Breeze has no GTT/bracket: a target/stop is enforced by the in-app exit monitor whatever `useGTT` says; the order is a limit at the widest of Breeze's and ANT's ask. |
| `POST /order/squareoff` | auth | Square off a position. |
| `POST /order/settarget` | auth | Body `{ token, targetPoints, stopLossPoints }` (numbers >= 0): set target / stop-loss points on an open position. |
| `GET /order/can-place` | auth | `{ allowed, reason? }` from the risk gate (loss limit, lot limit, accountClosed). The lot limit applies in `lotCount` mode only; in `investmentAmount` mode (with an account capital set) there is no lot-count cap and the account capital, net of open positions and pending orders, blocks instead ("no capital left"). |
| `POST /order/lock-profits` | admin | See below. |
| `GET /strategyPnl` | admin | Realized and unrealized P&L per strategy (`?match=` regex; `?by=broker` groups by broker instead; `?detail=1` one row per open position; `?opened=today` counts only trades opened today, IST day of `entryTime`, realized and unrealized, a trade with no `entryTime` counts as today; absent or `all` keeps every trade; the response carries `X-Opened-Filter`; `?closed=1` returns one row per CLOSED trade (`strategy, user, broker, tsym, quantity, entryPrice, exitPrice, realizedPnL, entryTime, exitTime`, oldest exit first, same `match`/`opened` filters, response carries `X-Closed-Rows: 1`; no mirrored flag exists on a trade row)); used by `scripts/strategy-status.sh`. |
| `GET /admin/trades/open`, `/admin/trades/closed`, `/admin/trades/pnl-summary` | admin | Open trades, closed trades, P&L summary across users. `from`/`to` (YYYY-MM-DD) are IST calendar days, `to` inclusive of its whole day. |

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

| `GET /demo/health` | none | `{ ok: true }`. Liveness probe for the static site (Cloudflare Pages): an answer means the trading server is up, so the home page offers Google sign-in and the demo uses live prices during market hours. The demo does not need the server otherwise: outside market hours, or when this probe fails, it replays `frontend/public/demo-ticks.csv` in the browser (regenerate with `node dist/tools/makeDemoTicks.js <Mon-DD> [every=10]` after `npx tsc`). |
## Strategies, reconcile and configuration (admin)

| Route | Purpose |
|---|---|
| `GET /strategies` (also `POST`) | `[{ type, userId, enabled }]` for every strategy instance. Read-only; enable or disable a strategy by editing `config.yml`. |
| `POST /strategies/:type/reset` | Reset a strategy type (clears day latches and in-memory state). `?userId=<instance>` resets only that instance (default: every instance of the type); BulkPcr keeps the day's realized P&L unless `?clearPnl=true`. Returns `{ type, reset, userIds }`. |
| `POST /reconcile` | Runs the broker → Mongo sync (see `POST /sync`), then every strategy re-reads Mongo into its own state (no strategy places an order while reconciling). A restart no longer needs it: the trading process restores open positions from Mongo alone at start-up. Refused before 09:10 IST. 200 `{ brokers, strategies }`; 409 when a broker's sync failed (strategies NOT reconciled); 500 on failure. |
| `POST /sync` | Broker → Mongo sync, on demand (`npm run sync`; the platform also runs it by itself after `settings.eodReconcileTime`, default 15:45). Reads each broker's trade book / order book / open positions and updates Mongo: books a Sell the broker did and Mongo lacks at its exact price, closes a contract that is flat at the broker at an implied (`ESTIMATED`) price, and only reports what it cannot attribute. Places no order; strategies are not touched. 200 `{ <broker>: { ok, skipped?, error?, bookedFills, bookedFlat, repairedClosed, mismatches[] } }`. First step, Mongo only: writes a `closedTrades` row for every Sell fill of the last 7 days that has none (`repairedClosed`). |
| `GET /config`, `POST /config` | The configuration in flattened form; a save is validated (`configValidation`) and rejected rather than written when the reload would reject it. `settings.hotRestartDuringMarketHours` (default `false`) decides whether a compiled-code change is applied during market hours (09:00-15:35 weekdays); the orchestrator reads it at the moment of each change. `settings.mirrorPercentage` (0-100, `N` or `N%`) is the share of every frontend user's lots (`POST /order/buy`) that the admin account mirrors with its own real order, rounded down to whole lots; 0 = off. |

## Frontend
| `POST /admin/eod-email/send` | End-of-day trading summary email, one per real user (not the admin, not strategy pseudo-users, enabled accounts) who had a closed trade or a fill that IST day: trades table, realized day P&L, open positions, and a payment section (current Wed-Tue week payout estimate: gross, split %, TDS, GST, net, blocked/forfeited reason; masked bank/UPI destination; latest payouts). NOT scheduled by this repo: another program calls it. Query: `date=YYYY-MM-DD` (default today IST, not in the future), `dryRun=true` (renders only; each result carries `subject` and `html`), `force=true` (resend users already sent), `user=<email>` (one user). While `settings.eodEmailTestRecipient` is set every email goes only to that address with a `[TEST for <user>]` subject prefix (recorded separately from live sends); remove the key to email real users. Sent from `GMAIL_USER` (admin@nivedhatech.com) via the Gmail OAuth `GMAIL_*` vars in `.env`; 503 when they are unset (dry runs still work). Sent records live in Mongo `eodEmails` (`date`+`user`+`mode`), so a repeat call skips them. 200 `{ date, mode: 'test'\|'live', testRecipient, results: [{ user, to, status: 'sent'\|'skipped'\|'failed'\|'dryRun', reason?, subject?, html? }] }`. Template: `templates/eodEmail.{html,subject.txt}`. |

`GET *` serves the React shell (`public/index.html`) to browser navigations; an unknown API-style path (no `Accept: text/html`, or with a file extension) is a JSON 404.

## Data models

See `src/model/model.ts` (`Trade`, `OptionQuote`, `NiftyQuote`, `SensexQuote`) and `src/user.ts` (the user document). Per-user risk state lives in the trading process (`src/processes/order/bookkeeping.ts`).
