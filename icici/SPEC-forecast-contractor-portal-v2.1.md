# Spec v2.1: Invite-only Forecasting Contractor Portal

**Status:** DRAFT for review. v2.1 = v2 plus the changes listed in section 17. Replaces `SPEC-forecast-contractor-portal.md` (kept unchanged).
**Owner:** Nivedha Tech (sole proprietor)
**Applies to:** the existing React front end and Node/TypeScript back end for nivedhatech.com.

## 1. Purpose

Contractors are engaged by invitation only. They never trade, never connect to a broker, and never pay anything. Two kinds of contractor:

| | Beginner (Individual, PAN) | Advanced (Business, GSTIN) |
|---|---|---|
| Agreement | Forecasting Services Agreement, Individual (PAN) | Forecasting Services Agreement, Business (GSTIN), amended for recommendations and profit share, with loss carry-forward (v1.1) |
| What they submit | **Forecasts**: NIFTY 50 Up or Down, optional confidence Low/Medium/High | **Recommendations**: index, strike, CE/PE, entry, target, stop |
| What decides if a trade is taken | **Two filters, always**, then the order is placed with no owner approval | **The owner approves or rejects every recommendation**, always |
| How they are paid | Monthly retainer + a fixed fee per correct forecast | Configurable fee model (default: a percentage of the profit on trades taken from their approved recommendations), against an invoice |
| Registration | none | Research Analyst registration (`INH`) recorded, verified and unexpired |

Only the owner's own system places orders, in the owner's own broker account. No contractor request can create, modify or cancel an order.

## 2. Hard constraints

1. **No change to the admin or strategies flow.** Existing admin screens, admin routes, strategies, the order process and the existing emails behave exactly as today. New owner functions are additive (a new Owner page, new routes, new files).
2. **No regressions** for existing users and strategies; the new `contractor` role is fenced by a default-deny allowlist that acts only on that role.
3. **No approval or filter switches.** Beginner always goes through the filters and never through approval; Advanced always goes through approval. These are not configurable.
4. **Tax is out of scope in this version** (no TDS, GST computation, tax rates, TDS export). Existing tax handling in the Advanced profit-share path is reused as it is, unchanged.
5. **No payment before the tax phase.** A configuration flag `TAX_PHASE_COMPLETE` (default `false`, changed only by the owner) disables **Mark PAID** and payout approval for real contractors (not `is_test`). Statements, accruals and invoices keep working.

## 3. Access: invitation only, no login page

- There is **no signup and no login page** for contractors. The landing page says "Private forecasting programme. By invitation only." with a contact email.
- **Invite:** the owner creates an invite (contractor type Individual or Business; optional email lock) and gets a **single-use link** (`/invite/<token>`, 7-day expiry, token stored only as a hash). The link can be pasted into WhatsApp (no WhatsApp integration) or **sent by Gmail** through the existing mailer.
- **Accepting** the invite (agreement + KYC, section 4 and 5) creates the contractor and sets a long-lived, signed, httpOnly session cookie (about one year, sliding). **That cookie is the only credential.**
- **Logout or cleared cookies means a new invite.** A re-invite of an existing contractor re-binds to the **same record** (history kept), revokes older sessions and links, and does not require re-accepting the agreement unless its version changed.
- **Statuses:** `INVITED → AGREEMENT_PENDING → ACTIVE → PAUSED | PAUSED_INVOICE | TERMINATED`. Cap `MAX_ACTIVE_CONTRACTORS`, default 5; the owner cannot activate a 6th.
- **Business contractors** have one Research Analyst email; only that email's session may act for the contractor.
- **Owner/admin** still sign in with Google at an unlinked `/owner-login`, restricted to the admin email list. Google login no longer creates users.
- **Link risk:** the link is the credential. It is single use and expires; acceptance records IP and user agent; the owner may lock a link to an email.
- **Session hardening:** the session token is rotated on use; the Owner page has **Revoke sessions** per contractor; Business contractors use a shorter sliding session (default 90 days, configuration) than Individuals (about one year); a **change of bank account, PAN or GSTIN takes effect only after owner approval** and the owner is alerted; the profile never shows full bank, PAN or GSTIN values.
- **Existing test user:** converted in the database to an ACTIVE contractor with an acceptance record clearly labelled as an owner migration. His current cookie keeps working; if lost, the owner re-invites. The record carries `is_test = true`: it is excluded from the `MAX_ACTIVE_CONTRACTORS` count, from payouts, statements, invoices and the daily email, and the Owner page shows a TEST badge. No real contractor may be created this way.

## 4. Agreements

- Serve the PDF that matches the contractor type. Individual: `Forecasting-Agreement-Individual-PAN`. Business: `Forecasting-Agreement-Business-GSTIN` (v1.1).
- **The agreement is personalised:** the contractor gives their details first; the portal then prepares the agreement with them (Parties clause, designated forecaster, registration) and the contractor reads and accepts **that** signed file, whose SHA-256 is recorded. The owner is named as **Karthikeyan S** (no registered company).
- **Acceptance screen:** embedded PDF viewer, a checkbox "I have read and accept the Forecasting Services Agreement v<version>", a DPDP consent checkbox linked to the agreement's data-protection section, and an Accept button.
- **Append-only acceptance record:** contractor, agreement type and version, SHA-256 of the PDF file, email, timestamps (UTC and IST), IP address, user agent.
- **Gate:** forecast and recommendation APIs reject any contractor without an acceptance of the current version.
- **New versions** (owner upload with an effective date) move all contractors to `AGREEMENT_PENDING` on that date, with a notice starting 15 days before.
- The old Terms & Conditions pages, the per-level Terms PDFs and their links are removed from the contractor-facing site.

## 5. KYC and profile

- **Individual:** legal name, address, PAN (format-validated), bank account + IFSC, and a declaration "Not registered under GST". If unchecked, activation is blocked with: "Contact admin to switch to the Business agreement."
- **Business:** legal entity name, registered address, GSTIN (format-validated; the entity PAN is **derived from the GSTIN**, not asked for twice), Research Analyst name and email, bank details, and **`SEBI Registration No.`** (Research Analyst, `INH` followed by nine digits; **`INA` (Investment Adviser) is not accepted**, because strike/entry/target/stop calls on index options are research-analyst activity), plus the **registration valid-until date**. The owner marks it verified against SEBI's published list. The SEBI number is **optional**: it does not block submitting or approving a recommendation (the owner is still alerted 30 days before a recorded registration expires).
- **Storage:** PAN, GSTIN and bank fields are AES-256-GCM encrypted at rest, readable only by the admin role, and masked in the UI except the last four characters.

## 6. What contractors can and cannot see

- **Can see:** their own forecasts or recommendations with outcome/status; the live NIFTY 50 value (Beginner); **the entry price and live P&L of the trades produced by their own forecasts or recommendations**, read-only; their own statements; their own profile.
- **Cannot see or do:** any other contractor's or the owner's trades; order status, order ids, broker, balances, capital; any control that places, modifies or cancels an order.
- **Server guarantee (tested):** a contractor token calling any order, position-stream, trade, P&L, broker or config endpoint receives 403. Only two scoped read-only endpoints exist (`/contractor/trades`, `/contractor/positionstream`), each filtered to the caller's own trades.

## 7. Beginner: Flash Forecast

**UI:** two large buttons Up and Down, optional confidence, the live NIFTY 50 value, then "Forecast recorded at HH:MM:SS. Window closes at HH:MM:SS", the forecast history with outcomes, and rolling accuracy for 7 days, 30 days and all time.

**Rules, enforced on the server from configuration:**
- Forecasting hours 09:20–15:00 IST, and 09:20–14:30 on NIFTY expiry days (expiry day from the exchange contract data, not hard-coded).
- At most `DAILY_FORECAST_LIMIT` (default 3) per trading day; one forecast with an open window at a time; no edit or withdraw; not on exchange holidays (holiday list in configuration).
- `submitted_at` is the server time.

**Data `forecasts` (write-once after insert):** id, contractor, direction, confidence, submitted_at, window_minutes, ref_value_start, ref_tick_ts, ref_value_end, neutral_threshold_points, outcome (`OPEN|CORRECT|INCORRECT|NEUTRAL|VOID`), scored_at, fee_amount, agreement_version.

**Scoring job:** `ref_value_start` is the NIFTY 50 value at `submitted_at`, `ref_value_end` at `submitted_at + window`. Move below the neutral threshold is NEUTRAL; move in the forecast direction at least the threshold is CORRECT; otherwise INCORRECT. No tick within ±5 seconds of either point: VOID (no fee, no penalty) and an owner alert. Scored rows are final; corrections go to an `adjustments` table, never an edit.

## 8. Beginner: filters and orders (always, no approval)

Every forecast is evaluated by two filters (interface `Filter.evaluate(context) -> pass/fail + reason + values`). **Both must pass.**

1. **Order-book imbalance:** total buy quantity and total sell quantity of the NIFTY current-month future, the same buy/sell-quantity idea BulkPcr uses. UP passes if buy/sell ≥ 1.2; DOWN passes if sell/buy ≥ 1.2. A snapshot older than 3 seconds rejects. Thresholds are configuration, versioned with an effective time (they apply only to forecasts submitted after it).
2. **Trend on 1-minute candles:** UP passes if the last closed 1-minute candle closes above the 9-period EMA of 1-minute closes and that EMA is rising; DOWN is the mirror. Parameters are configuration.

- **On a pass** the engine places the order with no approval: ATM strike, limit orders only, the owner's sizing, fixed target and stop, subject to the owner's risk limits (daily-loss kill switch that flattens and halts, max loss per trade, max open positions, square-off by 15:15 on expiry day, no new positions after a cut-off).
- **The engine refuses to start without the order-book filter.** Every decision is appended to an immutable `decisions` log with each filter's input values (buy qty, sell qty, ratio, threshold, snapshot time, candle values).
- **Pass-through alarm:** if fewer than 10% of the last 30 forecasts were rejected, alert the owner and show a dashboard warning. Thresholds are never lowered automatically.
- A Beginner's fees do not depend on whether or how a forecast was traded.

## 9. Advanced: recommendations (approval always)

- Up to **3 recommendations a day** (`forecast.recommendationsPerDay`), one open at a time. A recommendation has: index, strike, CE/PE, entry, target, stop. Validation: stop < order price < target; contract format; not already traded today; no open trade for that contractor
- It is stored as `PENDING` and the owner gets a **persistent pop-up** (Approve / Reject, optional note) that stays until acted on and reappears after a reload. **No filters apply to a recommendation**: it is taken as submitted and the owner's approval is applied on top of it; the decision is the owner's alone.
- **Approve** arms the contractor's own recommendation strategy in the existing strategy configuration; **Reject** records the note and notifies the contractor. Unactioned recommendations become `EXPIRED` at the end of the day. Nothing is ever approved automatically, and no timer exists near the approval code.
- Every decision is appended to `decisions`.

## 10. Fees and statements

**Beginner (amounts are gross; tax is out of scope):**
- Weekly accuracy statement (Wednesday 06:00 IST, for the previous Wednesday–Tuesday): correct forecasts × fee, capped at the remaining monthly cap.
- Monthly retainer on the 1st, pro-rated by active days, zero if the minimum participation days (default 15) are not met.
- Incorrect, Neutral and Void forecasts contribute zero; no code path produces a negative amount owed by a contractor; no code path reads trading P&L when computing these fees.
- Configuration (retainer, minimum days, fee per correct forecast, monthly cap, window minutes, neutral threshold, daily limit) is editable with an effective date and never applies retroactively. Statements go `DRAFT → APPROVED → PAID` (owner marks PAID with a UTR reference).

**Advanced:**
- **Fee model is configuration**, `ADVANCED_FEE_MODEL`, set per contractor with an effective date, never retroactive: `PROFIT_SHARE` (default; a percentage, currently 25%, of the profit on closed trades produced by that contractor's approved recommendations, using the existing profit-share payout flow) or `FIXED_PER_APPROVED` (a fixed amount per approved recommendation). Switching the model changes no other code. Loss-limit forfeiture is not applied to this source because the contractor does not size the trades.
- Under either model: no negative amount is ever owed by the contractor and nothing is charged to the contractor. **Under `PROFIT_SHARE` a loss is carried forward** and set off against later weeks' profit before any share is paid (clause 6A.2). **Under `FIXED_PER_APPROVED` the fixed amount is earned only to the extent the suggested profit (target minus entry) is achieved**, pro rata when partly achieved, in the weekly statement of the week the trade closes (clause 6A.6).
- **Written confirmation (optional):** the acceptance screen offers the clause 6A.5 confirmation (registration valid; compliance permits receiving the Profit Share). **If it is not given, the contractor accepts anyway and the fixed fee of clause 6A.6 applies from the acceptance date** (the agreement they accept is prepared that way; the owner is notified to set the fixed amount on the Fees tab, which may be applied to the contractor's own entry from its start date). If it is given, `PROFIT_SHARE` applies.
- **Invoice:** within 2 days of each paid payout (end of day IST) the contractor uploads an invoice (PDF, invoice number, date). If it is late the contractor is `PAUSED_INVOICE`: new recommendations are blocked, fees are never clawed back, and uploading restores access automatically.

Contractors can download a PDF or CSV statement per payout.

## 11. Emails

- **Welcome email** (after acceptance): confirms the agreement version accepted, attaches the agreement PDF for the contractor's type, explains how the portal works for their type, and states that access is through the invite link on their device, so a logout or cleared cookies needs a re-invite.
- **Daily transactions email** (once per trading day, after the end-of-day reconcile): to each active contractor, only their own items. Beginner: the day's forecasts with direction, time, outcome and the resulting trade's entry, exit and P&L. Advanced: the day's recommendations with status and the resulting trade's entry, exit and P&L.
- The existing end-of-day email and welcome email for the old flow are unchanged.

## 12. Owner page (new; the existing Admin page is untouched)

Tabs: **Contractors** (create invite, copy link, send by Gmail, statuses, activate, pause with reason, terminate with date, re-invite, KYC view, active count against the cap); **Recommendations** (pending and history); **Pilot dashboard** (per contractor: forecasts, filter pass/reject counts, alarm banner, resulting trades; the record that the owner's logic decides); **Fees** (statements, approval, mark paid); **Agreements** (upload a version with an effective date).

## 13. Copy and branding

- Site title "Nivedha Tech – Forecasting Contractor Portal". Contractor-facing pages contain none of: PropFirm, trader, Zerodha, ICICI, Alice Blue, Kite, Breeze, allocated capital, forfeit. No broker names or logos or "partner" claims. No marketing, returns claims, testimonials or recruitment prompts. No disclaimers implying SEBI registration or broker endorsement.
- The demo page is removed (redirect to the landing page).

## 14. Security and operations

- Roles `CONTRACTOR`, `ADMIN`; the owner is an admin. Server-side role checks on every endpoint; contractors are default-deny.
- Rate limiting on invite acceptance and forecast/recommendation endpoints. All times stored in UTC and shown in IST; server clock synchronised.
- Append-only: acceptance records, forecasts (write-once fields), decisions, adjustments. Daily database backup.
- Owner alerts: feed gap (VOID), kill-switch trip, broker login failure, invoice overdue, pass-through alarm, engine refusing a configuration.
- Broker credentials stay in server-side secrets only, never in the client bundle or logs. A global order rate limit stays well under the broker threshold (verified against the order process, built only if missing).
- Market data: NIFTY 50 ticks sampled once per second during forecasting hours are stored in a dedicated collection for scoring; existing quote logging stays as it is.

## 15. Acceptance tests (must pass before deploy)

1. A request without a valid session cookie or invite sees only the invite-only page; no account is created.
2. A used, expired or revoked invite link is refused; a re-invite re-binds the same record and revokes older sessions.
3. The 6th activation is blocked while 5 are active.
4. A contractor without a current-version acceptance gets 403 on forecast or recommendation submission.
5. A forecast outside hours, beyond the daily limit, on a holiday, or with one already open is rejected with a clear message.
6. Every route other than the allowlist returns 403 for a contractor token (route-enumeration test); the two scoped trade endpoints return only the caller's own trades.
7. Scoring with synthetic ticks gives CORRECT, INCORRECT, NEUTRAL and VOID; scored and write-once fields cannot be edited.
8. Beginner fees: correct × fee, capped by the monthly cap; Incorrect/Neutral/Void contribute 0; never negative; unchanged when owner P&L is mocked large profit or loss; retainer pro-rated and zero below minimum participation.
9. Advanced: an invoice not uploaded within 2 days gives `PAUSED_INVOICE` and blocks new recommendations; an upload restores access; fees unchanged. Under both `PROFIT_SHARE` and `FIXED_PER_APPROVED`: no negative payout, nothing charged to the contractor, no loss-limit forfeiture; a loss is carried forward under PROFIT_SHARE and never reduces a payment already made; switching the model with an effective date does not alter earlier statements.
10. The engine refuses to start without the order-book filter. Synthetic depth (buy 1,30,000 / sell 1,00,000) passes UP and rejects DOWN; a stale snapshot rejects; the trend filter passes and rejects on synthetic candles; the pass-through alarm fires under 10% rejections over 30 evaluations.
11. A Beginner forecast that passes both filters places an order with no approval step; one that fails either filter places none. An Advanced recommendation places no order until the owner approves; there is no timer-based approval code (grep test).
12. The recommendation validation module gives the same results as the existing recommendation strategy on a shared test set (parity test).
13. Existing admin and strategy tests give the same results before and after; a diff review of existing files shows only additive changes.
14. No contractor-facing string contains the forbidden words; no broker secret appears in the client bundle or logs.
15. Advanced: `INA` numbers, unverified numbers and expired registrations are rejected for recommendation submission; the 30-day expiry alert fires; acceptance without the clause 6A.5 confirmation puts the contractor on the fixed fee from the acceptance date and the owner is notified.
16. With `TAX_PHASE_COMPLETE=false`, Mark PAID is refused for a real contractor and allowed for the `is_test` user; the test user does not count toward the cap and receives no daily email.
17. A bank/PAN/GSTIN change stays pending until the owner approves; Revoke sessions invalidates the old cookie; the session token rotates; a Business session expires at the shorter limit.

## 16. Out of scope

- Any payment from contractors; leaderboards, public rankings or social sharing; any contractor control over orders.
- **Tax work (TDS, GST computation, tax rates, quarterly exports, invoice tax fields): next phase.**
- Section 8 (Taxes and Invoicing) of the agreements is left as drafted until the tax work.

## 17. Changes in v2.1 (over v2)

1. Advanced registration: `INH` only; valid-until date stored and enforced (section 5).
2. Advanced fee model is a configuration switch (`PROFIT_SHARE` default, `FIXED_PER_APPROVED` fallback), and the contractor confirms in the agreement that their registration terms and compliance permit it (section 10).
3. Existing test user flagged `is_test`; excluded from cap, payouts, statements and emails (section 3).
4. `TAX_PHASE_COMPLETE` gate on Mark PAID for real contractors (section 2, item 5).
5. Session hardening: token rotation, revoke sessions, shorter Business session, approval for bank/PAN/GSTIN changes (section 3).
6. New tests 15 to 17 and a wider test 9.
