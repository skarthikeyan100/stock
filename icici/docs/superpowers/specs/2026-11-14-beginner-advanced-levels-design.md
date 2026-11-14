# Beginner / Advanced levels - design (2026-11-14, rev 2)

Status: awaiting approval. Rev 3. Supersedes rev 1 (self-service immediate upgrade, 10/20 limits, same capital) and rev 2 (GST upgrade only after admin verification).

## Intent
Two kinds of users: beginners who know nothing about options, and advanced users who do. The platform bears the trading loss (prop-firm model), so the
aim is to minimise losses (luck does not always favour, for beginners or advanced users), keep trade volume down (about 30 of every 100 of profit goes to
tax, brokerage and STT; more trades also breed greed), and give experienced users real control in exchange for more risk. Real swings are large: on 2L
an advanced user sees +-1L days and 300% option winners, and dips of 20k that recover.

## Goals
- Beginner: Flash Trade only, fixed target and stop-loss, fixed position sizing, small capital, tight limits.
- Advanced: Flash Trade and Search & Buy, own target/stop-loss within a bound, choice of position sizing, more capital.
- A comparison table (below) before login and inside the app; the rules for each level are transparent.
- Everyone starts Beginner. Advanced is granted by admin approval of a request, or automatically for a verified GST-registered company. Permanent.

## Non-goals / anti-goals
- No new instruments: Search & Buy already lists index options (NIFTY, SENSEX, BANKNIFTY, ...) and stock options (~17.5k contracts, `public/symbols.txt`).
- No max payout (removed). No daily profit lock (it would cut the 300% winners; the trade cap handles greed). No profit-split difference.
- Advanced must not be a perk everyone takes: it is freedom plus risk, and it needs admin approval.
- No downgrade by any route a user can reach.

## Decisions (by the user)
1. Everyone starts Beginner. A Beginner can request Advanced; an admin approves. A user who gives a GSTIN (entity type company) is approved
   immediately: no admin step, no `gstVerified` needed. In exchange the GST user must give the platform an invoice for every payment, or the
   account is closed (see Invoice rule). GSTIN holders must accept the Advanced terms (and the invoice obligation) when they give the GSTIN. Permanent,
   even if the GSTIN is later changed or removed.
2. Try Demo shows both Flash Trade and Search & Buy.
3. Same percentages for both levels, different capital: 1L / 2L. Daily loss limit 15% (15k / 30k), weekly 30% (30k / 60k). Max payout removed.
4. Advanced can request more capital; admin decides; needs at least 2 successful weeks (a completed Wed-Tue payment week with positive net realized P&L
   and no daily/weekly drawdown breach; any 2, weeks as Beginner count). The rule and the user's progress ("successful weeks: 1 of 2") are shown.
5. Welcome email on first login (Beginner rules, a note about Advanced and that it is permanent); a second email on upgrade with the changed terms and
   agreement (also for the GSTIN path).
7. The only existing user is Ramaraj: set the level, capital and limits directly through the admin settings, no migration code.
8. Default target / stop-loss: 2 / 10 points (`settings.targetPoints` 2, `settings.stopLossPoints` 10; today 11).
6. Comparison table everywhere the rules are shown.

## My calls (please check)
- Trades per day: Beginner 2, Advanced 3, counted on entries, both investment modes (today's cap of 3 exists only in investmentAmount mode).
- Max loss on one trade: 10% of capital for both (10k / 20k). Beginner's fixed stop-loss is sized under it; Advanced may set their own up to it.
  The builder converts to points from quantity. Two stop-outs roughly use the daily limit.
- The daily drawdown already counts open P&L at live prices and latches the breach for the day, so a 20k dip that would recover is liquidated by a 20k
  limit: 30k for Advanced is what makes recoveries possible. The weekly limit counts realized P&L only.
- investmentMode: Beginner locked to `investmentAmount` (predictable size). Advanced may choose `lotCount` too (a way to size down). `lotCount` today
  checks only a lot limit (no capital-left check, no trade-count rule): add a capital check, a max-lots rule (lots x stop-loss within the per-trade cap)
  and the trade cap before opening the choice.
- Capital on approval (admin or GSTIN path): 2L by default (admin may adjust). Requires no 2-week history; the 2-week rule is for increases beyond that.
- Per-trade cap arithmetic: in investmentAmount mode quantity = capital / price, so a fixed 10-point stop loses quantity x 10: 10k on 1L only when the
  premium is 100 or more; at a premium of 50 it is 20k (20%). So the cap is enforced by reducing the quantity (the Beginner's position is
  min(capital / price, cap / stop points)), not by changing the stop. Same for an Advanced user's own stop.
- Invoice deadline: my reading of "2 days, i.e. end of Friday" is that payments are made on Wednesday and the invoice is due by 23:59 IST on the Friday
  after; the builder confirms against payout.ts's payment day and uses payment date + 2 days.

## Approaches considered
- Upgrade: immediate self-service (first choice, rev 1) -> replaced by request + admin approval, which stops unverified self-declaration from doubling
  exposure (1L -> 2L) with one click; the GSTIN path skips approval because the invoice rule (account closed without an invoice) is the check.
  Residual risk, accepted by the user: a fake GSTIN gets Advanced and 2L until the first invoice deadline (the first payment plus 2 days).
- Greed control: payout cap / daily profit lock / trade cap. Chose the trade cap plus the per-trade loss cap; no payout cap (weekly, indirect),
  no profit lock (cuts winners).

## Design
**Level model.** `proficiencyLevel` exists (default beginner); `settings.levelRules` per level in `config.yml`: maxDailyDrawdownPercent,
maxWeeklyDrawdownPercent, plus new `maxTradesPerDay`, `maxLossPerTradePercent`, default `capital`. Drop `maxPayment` everywhere (levelRules,
payout.ts, eodEmail, welcomeEmail, agreement PDF, configValidation, tests).

**Upgrade request.** Beginner only: `POST /user/upgrade-request` with explicit acceptance of the Advanced terms (stored with timestamp and terms
hash). Mongo `upgradeRequests` {user, status, acceptance, stats snapshot, timestamps}; one pending at a time; refused while the account is closed or
breached. Admin page lists requests with the user's history; approve sets `proficiencyLevel: advanced`, `advancedSince`, capital (default 2L, editable),
pushes it to the trading process, sends the upgrade email; reject records a reason, the user may request again. The generic settings route stays
admin-only for the level. Server rejects any downgrade. GSTIN path: when a company user saves a GSTIN (existing `updateCompanyProfile`), the same
effects run at once after an explicit acceptance of the Advanced terms and the invoice obligation (stored like the request acceptance). It does
not touch `gstVerified`, which still decides TDS treatment separately.

**Invoice rule (GST-registered Advanced users).** For every paid payout the user owes an invoice by payment date + 2 days (end of Friday for a
Wednesday payment). Mongo: `invoiceDueAt`, `invoiceStatus` (pending / received) on the payout; the user submits it (upload on the payout page or by
email, builder's choice, admin marks it received); reminder emails the day before; past the deadline the account is closed with the same closure
mechanism as a weekly breach (positions squared off, trading blocked); an admin can reopen it once the invoice arrives. The rule appears in the
terms the GSTIN user accepts and in the upgrade email.

**Gating (server-side).** A Beginner's Search & Buy order is rejected by the server (UI hiding is not enough); a Beginner's own target/stop is ignored;
Beginner investmentMode locked. Advanced: defaults pre-filled, override within the per-trade loss cap. Trade cap and per-trade cap enforced in the
order path in both modes. Demo shows both.

**Rules and comparison table.** One source (config levelRules + fixed feature list) feeds the public rules page, the in-app rules page, the upgrade
request screen and the welcome email; `RulesPage.tsx` stops hardcoding 25/50. Logged-out: percentages and ruppee amounts at default capital; logged in:
own level and amounts.

| | Beginner | Advanced |
|---|---|---|
| Flash Trade | Yes | Yes |
| Search & Buy | No | Yes (index incl. SENSEX, and stock options, any strike/expiry) |
| Target & stop-loss | Fixed | Your own (defaults, up to the per-trade cap) |
| Max loss on one trade | 10% of capital (10k) | up to 10% of capital (20k) |
| Position sizing | Investment amount | Your choice: amount or fixed lots |
| Trades per day | 2 | 3 |
| Capital | 1L | 2L; more on request after 2 successful weeks |
| Daily loss limit | 15% (15k) | 15% (30k) |
| Weekly loss limit | 30% (30k) | 30% (60k) |
| Profit split | Same | Same |
| Becoming Advanced | Request; admin approves. Give a GSTIN: immediate, but an invoice is due for every payment or the account is closed | - |
| Can switch back? | - | No |

**Capital-increase request.** Advanced only; disabled with the reason until 2 successful weeks; Mongo `capitalRequests`; one pending; admin
approves with the amount (existing admin-only capital setting) or rejects with a reason. Successful weeks computed with the same week/forfeit
logic as payout.ts / computeDrawdownForfeiture.

**Emails.** Welcome on first login: a server-side trigger calling the existing idempotent `sendWelcomeEmails([user])` (storage/<user> folder is the
"already sent" marker; `eodEmailTestRecipient` gate stays). Upgrade email: table, Advanced terms, updated signed Agreement (Advanced addendum).

## Constraints
- Live-trading code: level/capital changes must reach the trading process (limits are enforced in bookkeeping.ts) before the user's next order.
- Never delete `config.yml` keys, only change values (removing `maxPayment` from levelRules is an approved change here).
- Editing `src/` hot-restarts the trading process: outside market hours. Frontend changes need `cd frontend && npm run build`.

## Left to the builder
Wording of the Advanced terms/addendum including the invoice obligation (user to review); how the invoice is submitted; the quantity reduction
that keeps one trade under the per-trade cap. Ramaraj is configured by hand in the admin settings at release (no code).
