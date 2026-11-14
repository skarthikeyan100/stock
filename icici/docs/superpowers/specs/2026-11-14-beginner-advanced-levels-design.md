# Beginner / Advanced levels - design (2026-11-14)

Status: awaiting approval.

## Intent
Two kinds of users: beginners who know nothing about options, and advanced users who do. The platform bears the trading loss (prop-firm model), so
the aim is to minimise losses from beginners' luck-driven trading, keep the trade count down (about 30 of every 100 of profit goes to tax,
brokerage and STT), and give experienced users real control in exchange for taking on more risk.

## Goals
- Beginner: Flash Trade only, fixed target and stop-loss, tight loss limits.
- Advanced: Flash Trade and Search & Buy, own target and stop-loss, wider loss limits, and the ability to ask for more capital.
- A clear table showing the differences, available before login and inside the app.
- Everyone starts as Beginner; upgrading is the user's own, permanent, immediate choice.

## Non-goals
- No new instruments: Search & Buy already lists index options (NIFTY, SENSEX, BANKNIFTY, ...) and stock options (~17.5k contracts in `public/symbols.txt`).
- No difference in profit split, and none in capital at the start. No daily trade cap per level in this project (considered, not decided).
- No downgrade, by any route the user can reach.

## Anti-goals
- Advanced must not become a perk that everyone takes: it offers freedom and risk, not better terms. Hence no higher split or capital.
- A user must not be able to get Search & Buy or wider limits without accepting the Advanced terms.

## Decisions (by the user)
1. Everyone starts Beginner. The user can upgrade to Advanced, permanently, with immediate effect.
2. Try Demo shows both Flash Trade and Search & Buy.
3. Same starting capital for both levels. Max payment is removed.
4. Differences: Search & Buy (index incl. SENSEX, and stock options), target/stop-loss (fixed vs own), drawdown limits, capital-increase requests.
5. Capital increase: Advanced only, the admin decides, minimum 2 successful weeks. A successful week = a completed payment week (Wed-Tue) with positive
   net realized P&L and no daily or weekly drawdown breach. Any 2 weeks (not necessarily consecutive); weeks traded as Beginner count. The rule and
   the user's progress ("successful weeks: 1 of 2") are shown to the user.
6. Welcome email when the user first logs in (Beginner rules, a note about Advanced and that it is permanent). A second email on upgrade, with the
   changed terms and agreement.
7. Comparison table (below), shown on the public rules page, the in-app rules page, the upgrade confirmation and the welcome email.

## Approaches considered
- Upgrade timing: (A) immediate, (B) from the next payment week, (C) immediate unless traded this week. **User chose A.** Removing max payment closes the
  payout-cap loophole; the remaining one (more loss room after a bad stretch) is covered by the guard below.
- Who becomes Advanced: user chooses at first login only / admin approves / user chooses any time (one way). **User chose: starts Beginner, may
  upgrade any time, no way back.**

## Design
**Level model.** `proficiencyLevel` already exists on the user (default beginner), with `settings.levelRules` per level in `config.yml`. Keep it; drop
`maxPayment` everywhere (levelRules, payout.ts, eodEmail, welcomeEmail, agreement PDF, config validation, tests). Proposed limits (my call, tighter
than today's 25/50 for both): Beginner 10% daily / 20% weekly, Advanced 20% / 40%.

**Upgrade.** New endpoint, user-callable (the generic settings route stays admin-only for `proficiencyLevel`): `POST /user/upgrade-level` with an explicit
acceptance flag. Server checks: caller is Beginner; acceptance present; account not closed and no daily/weekly breach or forfeit in the current
day/week (guard). On success: set `proficiencyLevel: advanced`, store `advancedSince` and the accepted terms version/hash, push the new level to the
trading process (OrderClient.updateUserSettings already carries it), send the upgrade email. A downgrade is rejected server-side; only an admin
can set a level (admin action stays possible for corrections and for existing users).

**Gating.** Beginner: the trading page renders only Flash Trade; the Search & Buy order route rejects a Beginner server-side (UI hiding is not enough).
Beginner's target/stop-loss are the global defaults, not editable (FlashSettingsModal read-only for Beginner; the server ignores a Beginner's override
and any per-order target/stop on a Beginner's order). Advanced: defaults pre-filled, overridable within bounds (a maximum stop-loss, value left to the builder
with the user to confirm). Demo (`demo` prop) shows both, as now.

**Rules and comparison table.** One source (config levelRules plus a fixed feature list) feeds all four places; `RulesPage.tsx` stops hardcoding 25/50.
Public route (no login) shows the table with percentages; logged in shows the user's rupee amounts and their own level. Table:

| | Beginner | Advanced |
|---|---|---|
| Flash Trade | Yes | Yes |
| Search & Buy | No | Yes (index incl. SENSEX, and stock options, any strike/expiry) |
| Target & stop-loss | Fixed | Your own (defaults, within limits) |
| Daily loss limit | 10% of capital | 20% of capital |
| Weekly loss limit | 20% of capital | 40% of capital |
| Capital | Fixed | Can request an increase (admin decides; needs 2 successful weeks) |
| Profit split | Same | Same |
| Can switch? | Yes, to Advanced | No |

**Capital-increase request.** Advanced users only. Profile button, disabled with the reason until 2 successful weeks. Stored in Mongo
`capitalRequests` {user, requestedAmount, stats snapshot, status, timestamps}; one pending at a time. Admin page lists pending requests with the
user's weekly history; approve writes the new capital through the existing admin-only capital setting; reject records a reason. Successful-week
count is computed from closed trades with the same week/forfeit logic as `payout.ts` / `computeDrawdownForfeiture`.

**Emails.** Welcome: sent on first login (a server-side trigger that calls the existing idempotent `sendWelcomeEmails([user])`; the storage/<user>
folder stays the "already sent" marker; the `eodEmailTestRecipient` gate keeps applying). Content: Beginner rules, the table, the Advanced note.
Upgrade: sent once on upgrade, with the table, the Advanced terms and an updated signed Agreement (Advanced addendum), through the same
mailStorage/pdfSigning path. Acceptance is recorded in-app; the email is the copy.

## Constraints
- Live-trading code: level changes must reach the trading process (limits are enforced in bookkeeping.ts) before the user's next order.
- Config rules: never delete `config.yml` keys, only change values (remove `maxPayment` from levelRules is a user-approved change in this design).
  Editing `src/` hot-restarts the trading process: do it outside market hours.
- Frontend changes need `cd frontend && npm run build`.

## Left to the builder
Bounds for Advanced override; the exact wording of the Advanced terms/agreement addendum (needs the user's review); migration of existing users
(all default to Beginner, so any user who trades Search & Buy today loses it until upgraded or set by an admin: check who that is before release);
the global default 2/11 points (risking 11 to make 2) should be reviewed before it becomes the fixed Beginner setting.
