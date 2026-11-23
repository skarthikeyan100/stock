# User onboarding: open items and numbers to finalize

Status as of 2026-11-14. Every number below is a placeholder until the owner confirms it. Nothing here is final.

## 1. Rules per proficiency level (`config.yml` -> `settings.levelRules`)

| Rule | Beginner | Advanced | Status |
|---|---|---|---|
| Daily loss limit (% of allocated capital) | 25% | 25% | PLACEHOLDER: today's global value copied to both levels. Real figures to be decided. |
| Weekly loss limit (% of allocated capital) | 50% | 50% | PLACEHOLDER: same as above. |
| Maximum payment per payment week | ₹20,000 | ₹2,00,000 | Given by the owner; to be finalized with the rest. |

- A user's level is `proficiencyLevel` on the user document (`beginner` by default, `advanced`). Only an admin can set it, through `POST /users/:email/settings`. There is no admin-page control yet.
- Missing fields fall back to global `settings.maxDailyDrawdownPercent` / `maxWeeklyDrawdownPercent` and to the built-in maximum payments.
- The maximum payment caps the user's share before TDS and GST; tax is computed on the capped amount. To be confirmed: cap the share (current) or the net amount.
- The level at the time of payment applies to the whole payment week; earlier estimates can change if the level changes.

## 2. Where these numbers appear (update all when finalized)

- `config.yml` `settings.levelRules`: the single source for the numbers; live loss limits (`bookkeeping.ts`) and the payment cap (`payout.ts`) read it.
- Welcome email rules (`src/welcomeEmail.ts`) and the Agreement PDF (`src/legalPdf.ts`): the weekly limit uses the user's level; the maximum payments for both levels are listed; the daily limit is worded generically ("depends on your proficiency level").
- EOD PDF Payment information (`src/eodPdf.ts`): level, maximum payment, and the share before the cap.
- Still hard-coded and NOT yet linked to the config:
  - Terms & Conditions page 3.2 states a fixed 25% daily limit.
  - Rules page (`frontend/src/pages/RulesPage.tsx`) uses constants 25% daily and 50% weekly.
- The frontend is rebuilt but not published to Cloudflare.

## 3. Decisions pending

- Final daily and weekly percentages per level.
- Final maximum payments per level.
- Whether the Agreement and Terms should state the actual daily percentages once they differ by level, instead of the generic wording.
- Contact email in Terms and Privacy Policy: currently admin@nivedhatech.com (assumed).
- Legal review of the Agreement, Terms and Privacy Policy wording.
- Payout pages and payout emails: to be revisited later. Payment is never made automatically; a daily payment-information email is sent.
- Remove `settings.eodEmailTestRecipient` from `config.yml` only when the email content is approved; until then every customer email goes to the test recipient.

## 4. Account deletion (DPDP Act)

- Profile page -> "Delete account" (type DELETE) calls `POST /users/:email/delete-account`; an admin deleting a trader (`DELETE /users/:email`) uses the same erase. Code: `src/accountDeletion.ts`.
- Deleted: the user row, KYC/GST documents, bank/UPI details (also those copied into payout records), notifications, email records (`eodEmails`, `welcomeEmails`), mirror legs, and `./storage/<user>/`.
- Kept: `Trade`, `closedTrades`, `orderOwners`, `payouts` (and `payoutDecisionLog`, pending-order rows) with the email replaced by a random pseudonym `deleted-<12 hex>`; the pseudonym is not derivable from the email and is not stored anywhere else.
- The same email can sign up again as a new user with a clean history.
- Refused while the user has open positions or a pending payment; admin accounts cannot be deleted at all (profile button, admin Delete button and the API all refuse).
- Not covered (decide): emails already delivered to the user's own mailbox; server logs (`logs/`) that may contain the email; database backups; an erasure log (currently only a log line without the email).
- Erasure log: Mongo `erasureLog` (one row per request, never deleted; `GET /admin/erasure-log`). Fields: pseudonym, HMAC-SHA256 of the email keyed with `SESSION_COOKIE_SECRET` (shows "this email was erased" on request, cannot be reversed; changing the secret breaks that lookup), requester (self / admin's email), status (started / completed / failed), timestamps, per-collection counts, documents deleted, storage removed. No name, email or other personal data. Retention period of the log itself is to be decided.
