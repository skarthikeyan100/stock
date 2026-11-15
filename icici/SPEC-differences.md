# Differences: Spec v2 vs the original spec

Compares `SPEC-forecast-contractor-portal-v2.md` with `SPEC-forecast-contractor-portal.md` (original, unchanged). Original section numbers in brackets.

## 1. What changed

| # | Topic | Original spec | Spec v2 | Why |
|---|---|---|---|---|
| 1 | Beginner / Advanced | Levels deleted; one contractor kind that forecasts (§4) | Both kept as contractor types: Beginner = Individual (PAN) forecasts; Advanced = Business (GSTIN) recommends | Owner decision |
| 2 | Advanced work | Nothing equivalent | Advanced submit option **recommendations** (strike, CE/PE, entry, target, stop); owner approves or rejects each, always | Owner decision; they hold SEBI registration |
| 3 | Advanced pay | Retainer + fee per correct forecast for everyone (§7) | **Percentage of profit** on trades from their approved recommendations, against an invoice | Owner decision. **Conflicts with the Business PDF v1.0, which says fees are not a profit share, so the PDF is amended (v1.1)** |
| 4 | Profit forfeiture | Removed everywhere (§4) | Removed for Beginner; **not applied to Advanced** either (they don't size trades) | Repo/owner call; confirm |
| 5 | Signup / login | Gmail login for allowlisted emails; unlisted see a static page (§1) | **No login page.** Single-use invite link (WhatsApp paste or Gmail) creates the contractor; a session cookie is the only credential; logout or cleared cookies needs a re-invite. Owner logs in with Google at an unlinked `/owner-login` | Owner decision |
| 6 | Identity at acceptance | Google email recorded | Email entered or locked on the invite; IP and user agent recorded | Follows from #5 |
| 7 | Contractor visibility | None of strike, lots, premium, orders, positions, P&L, capital, broker (§4) | Contractors see **entry price and live P&L of trades produced by their own forecast or recommendation**, read-only, via two scoped endpoints. Still no broker, balances, orders, or anyone else's trades | Owner decision. **Conflicts with Individual PDF §3/§5 wording, which is amended** |
| 8 | Beginner decision engine | Owner approval default on during the pilot; never auto-approve (§9) | **Two filters always; a pass places the order with no approval** | Owner decision |
| 9 | Filters | Mandatory order-book imbalance, other filters optional and off (§9) | Two mandatory filters: buy/sell quantity (as BulkPcr) and 1-minute-candle trend | Owner decision |
| 10 | Approval and filter switches | `REQUIRE_OWNER_APPROVAL` switch (§9) | **No switches**; behaviour fixed by contractor type | Owner decision |
| 11 | Advanced and filters | Not applicable | Filters run on the recommendation's direction and are **shown in the approval pop-up for information only** | My reading of "always go through filters"; confirm |
| 12 | Approval UX | Web push / mobile notification with Approve / Modify (lots) / Reject (§9) | **Persistent pop-up**, Approve / Reject, stays until acted on, reappears after reload. No "Modify lots" | Owner decision |
| 13 | Tax | TDS rates per type, toggle, quarterly CSV; GST-exclusive computation (§7) | **Removed from this version.** Existing tax handling in the Advanced path reused unchanged | Owner decision ("done next") |
| 14 | Invoice fields | Invoice number, date, taxable value, GST amount, mismatch warning (§8) | Invoice PDF, number and date only | Follows from #13 |
| 15 | Delete trading features | Delete Search & Buy, levels, capital, loss limits, forfeiture, payouts UI and endpoints, DB columns (§4) | **Nothing existing is deleted from admin or strategies.** Contractors are fenced by a default-deny allowlist; only contractor-facing pages are removed | Owner constraint: no change to admin or strategies flow, no regressions |
| 16 | Admin screens | Admin screens for contractors added in the existing admin area | **New separate Owner page**; the existing Admin page is not edited | Owner constraint |
| 17 | Order endpoints | 403 for contractor, reachable only by owner/system role | Same, implemented as a default-deny allowlist for the contractor role (admin and existing users pass through untouched) | Safer for no regressions |
| 18 | Old data | Existing users set to INVITED or TERMINATED; archive and drop old tables (§12) | One existing test user converted in the database to an ACTIVE contractor with a labelled migration acceptance record. **No tables dropped or archived** | Owner decision |
| 19 | Demo page | Replace with simulated forecast demo or remove (§11) | Removed, redirect to landing | Simplest of the two allowed options |
| 20 | SEBI number | Optional field for Business (§3) | **`SEBI Registration No.`** required before Advanced can submit; admin marks verified. Format `INH` or `INA` + 9 digits | Owner decision; term and format from public sources, to be verified |
| 21 | Agreements | The two PDFs are the sources of truth (§2) | Business PDF amended to v1.1 (recommendations, profit share, SEBI, visibility); Individual PDF edited for visibility. Section 8 (taxes) untouched | Required by #3 and #7 |
| 22 | Emails | Not specified | New contractor welcome email (agreement attached, how access works) and a **daily transactions email** to each contractor. Existing emails unchanged | Owner decision |
| 23 | Session length | Not specified | About one year, sliding, since there is no way to log in again | Follows from #5 |
| 24 | Forecast engine placement | Server-side service | Runs in the existing trading process (where NIFTY ticks are), each contractor's orders under their own pseudo strategy id for isolated P&L | Repo architecture |
| 25 | Tick data | NIFTY value from the feed | New 1-per-second NIFTY tick store for scoring; existing quote logging left off | Repo has no usable history; turning logging on would also log options |
| 26 | Holidays | Trading calendar table | Holiday list in configuration (hot-reloaded) | Repo has no calendar; fits the repo's config pattern |
| 27 | Contractor cap, forecast limits, hours | As original | Same | No change |

## 2. Kept as in the original

Contractor statuses and the cap of 5; agreement served by type, SHA-256 and append-only acceptance records, versioning and the 15-day notice; encrypted KYC with masking; forecasting hours, daily limit, one open window, write-once forecasts; the scoring rules and ±5 s VOID rule; adjustments table; weekly accuracy statements and monthly retainer for Beginner; the 2-day invoice rule and `PAUSED_INVOICE`; decisions audit log, pass-through alarm and owner risk limits; copy sweep; backups and alerts; out-of-scope list.

## 3. Dropped or postponed from the original

- **Postponed:** all tax work (TDS, GST, quarterly export, invoice tax fields).
- **Dropped:** the approval/filter switches, "Modify lots" in approval, deleting trading code and archiving old tables, the simulated forecast demo.
- **Not built:** multi-forecaster aggregation, optional extra filters (time-of-day, volatility) beyond the two mandatory ones.

## 4. Items that need a decision or confirmation from the other reviewer

1. **Business agreement v1.1 redline** (recommendations, profit share, SEBI registration representation, contractor sees own entry price and live P&L). Legal text is drafted for review before any PDF is regenerated.
2. **Individual agreement §3 and §5:** both currently say the contractor has no access to trading results and no interest in any trade or position. With visibility of entry price and live P&L this must be softened. This edit was not explicitly requested and needs approval.
3. **Profit-share basis for Advanced:** gross profit on trades from approved recommendations at 25% (the existing Advanced rate), with no loss-limit forfeiture. Confirm the percentage, the period (weekly Wednesday–Tuesday as today) and how losses are treated (no carry-forward, as today).
4. **Regulatory position:** contractors must not use the trading API directly (our own strategies may). Beginner forecasts trade without owner approval; confirm this is acceptable with the filters and the immutable decision log as the evidence of the owner's own logic. Whether the contractor-visible P&L and the profit-share pay for Advanced change the regulatory characterisation of the engagement.
5. **SEBI number:** confirm that the Advanced companies hold Research Analyst (`INH`) or Investment Adviser (`INA`) registration, and who verifies it against SEBI's list.
6. **Tax scope (next):** TDS section and rates per contractor type, GST on invoices, certificates.
7. **Link-based access:** acceptance that the invite link is the only credential, a lost cookie needs a re-invite, and a forwarded link is a risk (mitigated by single use, expiry, optional email lock and recorded IP and user agent).
8. **Pilot data:** NSE holiday list and NIFTY expiry handling for forecast hours.
