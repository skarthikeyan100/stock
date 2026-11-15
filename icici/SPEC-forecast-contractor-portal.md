# Spec: Convert the PropFirm trading platform into an invite-only Forecasting Contractor Portal

**Repo:** existing React front-end + backend for nivedhatech.com
**Owner:** Karthikeyan (Nivedha Tech, sole proprietor)
**Goal:** Contractors submit NIFTY 50 Up/Down forecasts and are paid a fixed retainer plus a fixed fee per correct forecast. They never trade, never see trading data, and never pay anything. The owner's own decision engine, which can use forecasts as one input, is the only thing that places orders, in the owner's own broker account.

The two new agreements replace the old Beginner and Advanced Terms & Conditions:
- `Forecasting-Agreement-Individual-PAN.pdf`
- `Forecasting-Agreement-Business-GSTIN.pdf`

Product behaviour must match those documents. Where this spec and the agreements disagree, the agreements win.

---

## 0. Before changing anything

1. Explore the repo and write `docs/current-state.md`, mapping where each of these lives today: Gmail login, signup, Beginner/Advanced levels, the level-upgrade flow, GSTIN capture, Flash Trade, Search & Buy, per-user capital allocation, daily/weekly loss limits, profit forfeiture, profit-share payout calculation, invoice tracking, broker integrations (Breeze / Kite / ANT), the demo page, and T&C rendering/acceptance.
2. List every user-facing string containing: trade, trader, trading, profit, capital, PropFirm, broker, ICICI, Zerodha, Alice Blue, Kite, Breeze, ANT, payout share, level, Beginner, Advanced, forfeit.
3. Commit the mapping before refactoring. Make each section below a separate commit or PR with its tests.

---

## 1. Access: invite-only

- **No open signup.** Gmail (Google OAuth) login succeeds only for emails on an admin-managed allowlist with status `ACTIVE`.
- **Unlisted emails** see a static page: "This portal is by invitation only." Create no account record and keep no data except a minimal rate-limited audit log line.
- **Contractor statuses:** `INVITED → AGREEMENT_PENDING → ACTIVE → PAUSED | TERMINATED`.
- **Cap:** `MAX_ACTIVE_CONTRACTORS`, default **5**. Admin cannot activate a 6th while 5 are active.
- **Admin screens:** invite (email, contractor type `INDIVIDUAL | BUSINESS`), activate, pause (with reason), terminate (with date), and a view of KYC fields.
- **Business contractors:** one Designated Forecaster email per business contractor. Store it on the contractor record. Only that email can log in for that contractor.

## 2. Agreement acceptance

- **Serve the agreement by contractor type.** Show the matching PDF: Individual for `INDIVIDUAL`, Business for `BUSINESS`.
- **Acceptance screen:** an embedded PDF viewer, a checkbox reading "I have read and accept the Forecasting Services Agreement v1.0", and an Accept button.
- **Record on acceptance:** `contractor_id`, `agreement_type`, `agreement_version`, SHA-256 of the PDF file, Google email, timestamp (UTC and IST), IP address, user agent. Records are append-only.
- **Gate:** the forecasting UI and APIs reject any contractor without an acceptance record for the current version.
- **New versions:** uploading a new agreement version (admin) moves all contractors to `AGREEMENT_PENDING` on the version's effective date. Show a notice starting 15 days before that date.
- **Remove the old documents.** Delete the old T&C pages and PDFs and all links to them.

## 3. KYC / profile

- **Individual:** legal name, address, PAN (format-validated), bank account number + IFSC, and a declaration "Not registered under GST" (checkbox). If unchecked, block activation and show: "Contact admin to switch to the Business agreement."
- **Business:** legal entity name, registered address, PAN, GSTIN (format-validated; the PAN embedded in the GSTIN must match), optional SEBI registration number, authorised signatory name and designation, Designated Forecaster name and email, bank details.
- **Storage:** encrypt PAN, GSTIN and bank fields at rest. Only admin role can read them. Mask them in the UI except the last 4 characters.
- **Consent:** add a DPDP consent checkbox linked to Section 12 of the agreement.

## 4. Remove trading features from the contractor side

Delete these completely: UI, routes, API endpoints, backend handlers, background jobs, DB columns (migrate/archive), and feature flags.

- Search & Buy (any strike/expiry, stock options, SENSEX)
- Beginner/Advanced levels, the upgrade flow and "Advanced is permanent" logic
- Per-contractor allocated capital, position sizing modes, and per-contractor daily/weekly loss limits
- Profit forfeiture, "account closed on weekly loss", and profit-share percentages (35% / 25%)
- Any display to contractors of strike, lots, premium, order status, positions, P&L, capital or broker
- Any fee or payment collection from users ("platform fees for strategy services")

**Server-side guarantees, with tests:**
- No contractor-authenticated request can create, modify or cancel an order, or read any order, position, fill, P&L, balance or broker record.
- Order-related endpoints return 403 for the contractor role and are reachable only by the owner/system role.

## 5. Flash Forecast (replaces Flash Trade)

**Contractor UI**
- Two large buttons, **Up** and **Down**, plus an optional confidence selector (Low / Medium / High), and a live NIFTY 50 index value for context.
- After submitting, show "Forecast recorded at HH:MM:SS. Window closes at HH:MM:SS."
- **Rules, enforced server-side with the values from config:**
  - Only during Forecasting Hours: default 09:20–15:00 IST, and 09:20–14:30 on NIFTY expiry days. Expiry days come from config or the exchange calendar, not hardcoded.
  - At most `DAILY_FORECAST_LIMIT` (default 3) per Trading Day.
  - Only one forecast with an open window per contractor.
  - No edit or withdraw after submission.
  - Not on exchange holidays (maintain a trading calendar table).

**Data model `forecasts`:** `id`, `contractor_id`, `direction` (`UP | DOWN`), `confidence` (nullable), `submitted_at` (server time; never trust the client), `window_minutes` (snapshot of config at submit time), `ref_value_start`, `ref_value_end`, `neutral_threshold_points` (snapshot), `outcome` (`OPEN | CORRECT | INCORRECT | NEUTRAL | VOID`), `scored_at`, `fee_amount` (snapshot), `agreement_version`.
- **Write-once:** `direction`, `submitted_at` and the snapshots are immutable after insert. Enforce this with a DB trigger or app-level guard plus a test.

## 6. Scoring job

- **Values:** `ref_value_start` is the index value from the market-data feed at `submitted_at`; record the source tick timestamp. `ref_value_end` is the value at `submitted_at + window_minutes`.
- **Outcome rules:**
  - |end − start| < threshold → `NEUTRAL`
  - move in the forecast direction ≥ threshold → `CORRECT`
  - otherwise → `INCORRECT`
- **Feed gaps:** if no tick exists within ±5 s of either point, mark the forecast `VOID` (no fee, no penalty) and alert admin.
- **Finality:** a scored forecast is final. Admin corrections go into an `adjustments` table with a reason, and the original row is never edited.
- **Contractor view:** their own forecast history with outcome, plus rolling accuracy over 7 days, 30 days and all time.

## 7. Fees and payouts (replaces the profit-share engine)

**Config, editable by admin with an effective date; changes never apply retroactively:**
`RETAINER_MONTHLY`, `MIN_PARTICIPATION_DAYS` (default 15), `ACCURACY_FEE_PER_CORRECT`, `MONTHLY_ACCURACY_CAP`, `FORECAST_WINDOW_MIN` (15), `NEUTRAL_THRESHOLD_PTS` (5), `DAILY_FORECAST_LIMIT` (3).

**Weekly accuracy statement** (job runs Wednesday 06:00 IST for the previous Wednesday–Tuesday):
- correct count × fee, capped at the remaining monthly cap
- gross, TDS, net, status `DRAFT → APPROVED → PAID`
- admin marks it PAID with a UTR reference

**Monthly retainer statement** (job runs on the 1st): pro-rated by active days; zero if minimum participation isn't met.

**TDS:**
- A per-contractor-type rate in admin config. No hardcoded rate; the owner's CA sets it.
- Computed on the value excluding GST.
- Toggle `TDS_ENABLED` (default on).
- Quarterly export (CSV) per contractor: PAN, gross, TDS, dates.

**Invariants (tests required):**
- No code path produces a negative amount owed by a contractor.
- No code path reads trading P&L when computing fees.
- Incorrect and Neutral outcomes contribute 0.

**Statements:** contractors can download a PDF/CSV statement per payout.

## 8. Invoices (Business contractors only)

- **Upload:** after a payout is marked PAID, the contractor sees "Invoice due by <paid_date + 2 days, 23:59 IST>" with an upload control (PDF).
- **Overdue:** if no invoice by the deadline, set status `PAUSED_INVOICE`. This blocks new forecasts only; never claw back fees. Uploading the invoice automatically restores `ACTIVE`.
- **Fields:** store invoice number, date, taxable value and GST amount. Validate that the taxable value matches the payout gross, and warn on mismatch.
- **Remove** the old "account closed until invoice" wording.

## 9. Decision engine (owner side; the only path to orders)

The engine is a server-side service owned by the owner. Forecast submission must **never** directly create an order.

- **Inputs:** one contractor forecast per decision (no multi-forecaster aggregation), plus the owner's own filters (pluggable interface `Filter.evaluate(context) -> pass/fail + reason + values`).
- **Mandatory filter: order-book imbalance (`OrderBookImbalanceFilter`).**
  - **Data:** total buy quantity and total sell quantity from market depth of the configured instrument: `NIFTY_FUT_CURRENT` (default) or the option selected for the trade. Fetch a fresh snapshot at evaluation time; reject the forecast if the snapshot is older than 3 seconds.
  - **Rule (thresholds from config, set before go-live):**
    - UP → pass if buy_qty / sell_qty ≥ `OBI_UP_RATIO` (default 1.2)
    - DOWN → pass if sell_qty / buy_qty ≥ `OBI_DOWN_RATIO` (default 1.2)
    - otherwise reject
  - **Changes:** threshold changes are versioned with an effective time and apply only to forecasts submitted after that time.
- **Optional additional filters** (off by default): time-of-day window, trend (e.g. price vs VWAP or EMA), volatility band. Same interface.
- **Required design constraint:** the engine must not be configurable as a pass-through.
  - The order-book filter must be enabled; the engine refuses to start without it.
  - Every decision logs each filter's result with its input values (buy_qty, sell_qty, ratio, threshold, snapshot timestamp).
- **Pass-through alarm:** track the rolling rejection rate over the last 30 forecasts evaluated. If it falls below `MIN_REJECTION_RATE` (default 10%), alert the owner and show a dashboard warning. Never auto-lower thresholds.
- **Owner approval mode:** `REQUIRE_OWNER_APPROVAL` (default **true** during the pilot). The engine creates a `pending_decision` and sends the owner a web push / mobile notification with **Approve / Modify (lots) / Reject**. An order is placed only after a human tap by the owner's authenticated session. Never add auto-approve timers or randomised delays.
- **Order construction (owner's rules):** strike selection, lot sizing from owner capital and risk config, fixed stop-loss and target, limit orders only (no market orders).
- **Owner-level risk limits** (move here from the per-user logic):
  - owner daily loss limit → kill switch that flattens positions and halts the engine
  - max loss per trade
  - max open positions
  - square off by 15:15 IST on NIFTY expiry day
  - no new positions after a configurable cut-off
- **Audit log `decisions`:** forecast ID, filter results with input values, decision (accepted/rejected + reason), approval actor and timestamp, order IDs, fills. Append-only.
- **Pilot dashboard (owner only):** per contractor, show forecasts, filter pass/reject counts, approvals and resulting trades. This is the record that the owner's logic, not the forecaster, decides.

## 10. Broker integration (owner only)

- **Credentials:** broker API credentials live only in server-side secrets (env or secret manager). Never send them to the browser or log them.
- **Routing:** all orders go out from the server with the registered static IP.
- **Throttle:** a global order rate limiter with a hard cap of **2 orders/second**, well under the 10 OPS threshold. Count modifications and cancels too.
- **Sessions:** automatic logout at end of day and a fresh login before market open, per broker rules.
- **Configuration:** support whichever single broker the owner configures; don't route across multiple brokers by default.

## 11. Copy and branding sweep

- **Site title:** "Nivedha Tech – Forecasting Contractor Portal". Remove "PropFirm" everywhere.
- **Replace wording:** trader → contractor, trade → forecast, profit share → fees, payout → fee payment.
- **Remove broker names, logos and "partner" claims** from all public and contractor-facing pages.
- **Landing page:** a short description ("Private forecasting programme. By invitation only."), a login button and a contact email. Add no marketing, returns claims, testimonials or recruitment calls to action.
- **Demo page (`/demo`):** replace it with a forecast-only demo using simulated index data, clearly labelled "Simulation – no real data, no payments". Or remove it and redirect to `/`.
- **Disclaimers:** don't add disclaimers that imply SEBI registration or broker endorsement.

## 12. Data migration

- **Existing users:** set to `INVITED`, or `TERMINATED` if not on the owner's pilot list (owner provides the list). All must accept the new agreement.
- **Old tables:** archive the old profit-share and level data read-only (export to CSV, then drop or rename the tables). No old balance carries over into fees.
- **Rollback:** write a reversible migration script and test it on a copy of production.

## 13. Security and ops

- **Roles:** `CONTRACTOR`, `ADMIN`, `OWNER` (owner implies admin). Enforce role checks on the server for every endpoint.
- **Rate limiting:** on login and forecast endpoints.
- **Clock:** all times are server-side in IST and stored as UTC. Use NTP-synced servers.
- **Backups:** daily DB backup. Audit tables (`agreement_acceptances`, `forecasts`, `decisions`, `adjustments`) are append-only.
- **Alerts** go to the owner's email/phone for: feed gaps, a kill switch trip, broker login failure, an invoice overdue, and the engine refusing a pass-through config.

## 14. Acceptance tests (must pass before deploy)

1. Non-allowlisted Gmail → invite-only page; no account created.
2. 6th activation is blocked while 5 are active.
3. A contractor without current-version acceptance gets 403 on forecast submit.
4. Forecast outside hours, beyond the daily limit, or with one already open → rejected with a clear message.
5. A contractor token calling any order/position/P&L endpoint → 403.
6. Scoring: synthetic ticks produce CORRECT, INCORRECT, NEUTRAL and VOID correctly, and scored rows can't be edited.
7. Weekly fees = correct × fee, capped by the monthly cap; Incorrect/Neutral = 0; never negative; fees don't change if owner P&L is mocked as large profit or large loss.
8. Retainer pro-rated, and zero below minimum participation.
9. Business contractor: invoice not uploaded within 2 days → `PAUSED_INVOICE` and forecasts blocked; upload → `ACTIVE`; fees unchanged.
10. Engine config with the order-book filter disabled → refuses to start. Filter tests:
    - synthetic depth (buy 1,30,000 / sell 1,00,000) passes UP and rejects DOWN
    - a stale snapshot (> 3 s) rejects
    - the rejection-rate alarm fires when < 10% of 30 evaluations are rejected
11. With `REQUIRE_OWNER_APPROVAL=true`, no order is placed without an authenticated owner tap; there is no timer-based approval code anywhere (grep test for setTimeout/schedule near approval logic, plus a unit test).
12. Order rate limiter never exceeds 2 ops/second under a burst test.
13. No user-facing string contains: PropFirm, profit share, trader, Zerodha, ICICI, Alice Blue, Kite, Breeze, allocated capital, forfeit (automated grep over the built bundle).
14. Broker secrets never appear in the client bundle or the logs (scan).

## 15. Out of scope

- Payments from contractors (never build this).
- Leaderboards or public rankings (avoid anything that looks like a contest or game).
- Social sharing of forecasts.
- Any contractor-facing view of trading activity.
