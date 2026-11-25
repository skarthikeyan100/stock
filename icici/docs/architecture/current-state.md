# Current state map (before the contractor-portal work, 2026-11-15)

Where each of the things in spec section 0 lives today. Nothing below is changed by the contractor portal except where `docs/specs/SPEC-forecast-contractor-portal-v2.1.md` says additive.

| Area | Where |
|---|---|
| Google login, session | `src/routes/auth.ts` (`POST /auth/login` upserts any verified Google email via `getOrCreateUser`, `src/user.ts`), `src/routes/session.ts` (signed `session` cookie `email|issuedAt`, 30-day server expiry, `sessionsValidAfter` revocation, act-as cookie). Frontend `context/AuthContext.tsx`, `pages/LoginPage.tsx`. |
| Signup | Open: any verified Google account becomes a `user` (role `admin` if in `ADMIN_EMAILS`). No allowlist, invite or cap. |
| Levels | `proficiencyLevel` on `users`; `src/levelRules.ts` (config `settings.levelRules`), `levelGate.ts`, `levelTable.ts`, `levelUpgrade.ts`, `capitalRequests.ts`, `successfulWeeks.ts`, `routes/levels.ts`. Frontend `AccountLevelCard`, `LevelsPage`, `LevelTable`, `LevelRequestsPanel` (Admin tab). |
| GSTIN capture | `PATCH/POST /users/:email/company-profile` (`routes/users.ts`); format check only; makes the user Advanced. |
| Flash Trade, Search & Buy | `POST /order/buy` (`routes/trading.ts`), frontend `OrderEntry`, `FlashSettingsModal`, `TradingPage`. |
| Capital, loss limits, forfeiture | `src/processes/order/bookkeeping.ts` (drawdown, account close), `src/payout.ts` (`computeDrawdownForfeiture`). |
| Profit share payout | `src/payout.ts`, `routes/payouts.ts`, `tax.ts`; frontend Admin Payments tab, `PayoutPaymentPage`, Profile Payments tab. |
| Invoice tracking | `src/invoiceRule.ts` (hourly check in `server.ts`), `POST /admin/payouts/:id/invoice-received`. |
| Brokers | Kite / ANT / Breeze (Prism legacy) under `src/kite`, `src/ant`, `src/breeze`, executors in `src/processes/order/`. |
| Demo page | `frontend/src/pages/DemoTradingPage.tsx`, `context/DemoTradingContext.tsx`, `demo/demoFeed.ts`, `public/demo-ticks.txt`. |
| T&C | `TermsAndConditionsPage` (static HTML); per-level PDFs from `src/legalPdf.ts` + `templates/legal/terms.json`; acceptance of the base rules is browser-only (`localStorage`). Server-side acceptance exists only for the Advanced terms (`advancedAcceptance`). |
| Recommendation strategy | `src/strategy/RecommendationStrategy.ts` (config block `Recommendation-1`), `.claude/skills/recommend`. |
| Mirror | `src/processes/order/mirror.ts` (`settings.mirrorPercentage`): copies a frontend user's buy to the primary admin. |
| Notifications | Mongo `notifications`, `GET /notificationstream`, frontend `NotificationBell`. Email via `src/mailer.ts` (Gmail API), test-recipient redirect `settings.eodEmailTestRecipient`. |
| Option tick history | `src/processes/data/TickStore.ts`: every option tick of the ANT and Breeze feeds (never index, future or VIX) -> in-memory bounded buffer (100k, drops counted) -> `insertMany` every 1 s into Mongo `tickHistory`, one document per tick: `day` (IST), `t` (ms) / `at` (Date), `src`, `exch`, `tk`, `tsym`, normalized `key` (`NIFTY\|2026-12-01\|25750\|PE`, `src/util/tickKey.ts`) with `u`/`exp`/`k`/`ot`, `ltp`, `v`, `ap`, `bp`/`sp`/`bq`/`sq`, `tbq`/`tsq`, `oi`, `ft`. TTL index 36 h on `at` and a startup purge of days before today; `settings.storeTicks` (absent = on, false = nothing written). Read: `scripts/ticks-query.js`. Estimate: 15-40 contracts x ~2 ticks/s x 6.25 h = 0.7-1.8 M documents/day (~150-400 MB, disposable). |
| Market data | NIFTY ticks from `src/processes/data/AntDataStream.ts`; persisted only when `settings.logQuotes` (off). No holiday calendar; expiry day from `isNiftyExpiryDay()` (`src/util/marketHours.ts`). |

User-facing strings to sweep are in `frontend/src/pages/{LoginPage,RulesPage,TermsAndConditionsPage,PrivacyPolicyPage,ProfilePage}.tsx`, `components/{AccountLevelCard,TradingFaq,FlashSettingsModal,OrderEntry}.tsx` and the Terms/Welcome email templates.
