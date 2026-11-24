# Feature List (current codebase, 2026-11-23)

Purpose: checklist for later review. One line per feature, no detail. Excludes tests and backtests (`src/test/`, `*Backtest*`, `ruleBacktest/`, `analysis/` ML, `pipeline`/`analyze` research tools).
Note: the older `features.md` (plural) describes the pre-migration monolith and is stale; this file replaces it as the review checklist.
Basis: `docs/guides/strategies.md`, `docs/architecture/Architecture.md`, `docs/architecture/current-state.md`, `config.yml` and the header comments and exports of `src/**`. Each item below should be checked against code during review.

---

## 1. Process architecture and runtime
- Orchestrator (`npm run processes`) spawns `data`, `trading`, `frontend`; restarts only the child whose `dist/` changed
- `data` is never auto-restarted (crash raises an alert; operator restarts outside market hours)
- `trading` = merged order + strategy process; in-process `OrderClient`; still serves ORDER/STRATEGIES IPC sockets
- `frontend` = Express REST + SSE API (`server.ts`); static React bundle from `public/`
- Hot-restart policy: `HOT_RESTART` env, `settings.hotRestartDuringMarketHours`, blocked in market hours by default
- Stale-orchestrator killer, per-day orchestrator log files
- Unix-socket IPC (newline-delimited JSON): order, strategies, data protocols; reconnecting clients; inode-safe socket cleanup
- Ref-counted tick subscriptions (per owner in-process, per client in `data`); replay of subscriptions on reconnect
- Per-process IPv4-only DNS override for Kite/ANT hosts (Breeze needs IPv6)
- IST timezone pinned at every entry point
- Startup preflight: contract-master files must exist; broker session check; restore open positions from Mongo; per-strategy no-order `reconcile()`
- `POST /reconcile`, `POST /sync`, `npm run sync` (broker → Mongo)
- End-of-day broker → Mongo sync/repair at `settings.eodReconcileTime` (15:45): trade book, order book, positions, closed-trade repair
- Mock mode (`MOCK_BROKER`, `MOCK_QUOTES`, `MOCK_DATE`, `config.mock.yml`, `MockAPI`)
- Cloudflare Pages hosting, `cloudflare/_worker.js` API/SSE forwarding, `cloudflareOnly` IP middleware (loopback bypass)
- Security log (bounded, CR/LF-sanitised), request auth middlewares (`requireAuth/Admin/SelfOrAdmin`)
- Global CSRF guard (`X-Requested-With` on state-changing requests, loopback exempt), NoSQL-operator guard on `user/email/status/userId`, async-handler wrapping, process-level uncaughtException/unhandledRejection keep-alive
- SSE heartbeat (Cloudflare idle timeout), notification-stream Mongo poll
- Frontend-process jobs: forecast scoring every 30 s, hourly invoice check, hourly contractor jobs

## 2. Market data (`data` process)
- ANT WebSocket tick stream (NIFTY, SENSEX, option tokens, depth mode tbq/tsq) with backoff reconnect
- Breeze WebSocket stream (explicit stockToken subscribe form)
- NIFTY nearest-future feed (`fut` ticks: price, volume, exchange VWAP `ap`, own VWAP, VWAP-FEED health alerts, `vwapSamples`)
- Kite and Prism ticks proxied through ANT feed (`feedSource` mapping; `paper` → ANT)
- DataServer: slow-client drop, per-client hold release on disconnect
- Optional quote persistence (`settings.logQuotes`), Mongo `NiftyQuote/SensexQuote`
- Index quote history, shared 300 s stats builder, aligned candle builder (`originSeconds`, `seed`), Yahoo `^NSEI` 15m seed (cached)
- Indicator engine (RSI, MACD, EMA, Bollinger, ADX, Stochastic, reversed RSI), support/resistance state machine, PCR (±300-point window)
- Order-book momentum signal (tbq/tsq imbalance)
- Weekly momentum picks (NSE client, `momentum:fetch` / `momentum:rank`)

## 3. Brokers
- Four real brokers (`kite`, `ant`, `breeze`, `prism`) plus in-memory `paper`; canonical names, legacy aliases accepted on read (`normalizeBrokerName`), migration script
- Common `BrokerExecutor` interface + per-broker executors; `BrokerClient` login/read surface
- Per-broker contract masters (Kite, ANT, Breeze, Prism) with refresh, nearest/next expiry, exact-expiry lookup, strike-by-premium pick, lot size, tsym parsing across spellings
- Breeze tsym carries expiry (`NIFTY09NOV2624950CE`); legacy form still read
- Broker OAuth/login flows and session persistence (ANT, Kite, Breeze, Prism/Shoonya); `scripts/login.sh`; session-validity cache; `brokerSessions`; `check-broker-sessions.sh`
- Per-broker order-write queue: FIFO, one in flight, 1 s gap, 30 s timeout
- Exchange freeze-quantity chunking (NIFTY 1755, SENSEX) with inter-chunk delay for rate limits
- Central order pricing (BUY at REST best bid rounded down, SELL at best offer rounded up) for all "market/LTP"-intent orders
- ANT: market-with-protection buy, marketable-limit fallback, LONGTERM/INTRADAY product, trade-book fill resolution, order-notify WebSocket
- Kite: GTT two-leg OCO target/stop, GTT release tracking, trade-book reads
- Breeze: per-order fetch for status, order-notify stream
- Prism: polled cancel-and-recheck fill, session probe, no post-fill protection primitive
- Paper broker: in-memory limit/rest/fill, no Mongo, never latched by global max-profit
- Margin rejection handling (reduced-quantity retry), NOT_PLACED vs unknown-outcome error classes
- Fill wait with cancel + re-check; unconfirmed-buy resolution; pending-fill registry; TTL buffers

## 4. Order process and bookkeeping
- IPC verbs: buy/sell/square-off (index, contract, bare, chunked, limit), cancel resting buys/sells, resolve contract, price-range contract, option LTP, order price, PCR, ATM tokens, live quantity, pending sells, set target/stop, attach/cancel protection, lock profits, reconcile, eod sync, reload session/limits, paper book, butterfly legs, platform sells, contract holders
- `canPlaceOrder` gates: global max-profit latch, per-(user,broker) max investment, lot limit, capital left (investment mode), per-order cap, daily drawdown, weekly account close, strategy exemptions (`skipInvestmentCap` for hedge re-buys)
- Pending-order reservation (`markPending/releasePending`) closing the concurrent-order race
- Fill booking: dedupe, quantity-weighted averages, aggregate rows, clamp to order quantity, partial fill on cancel
- Closed-trade rows (Mongo `closedTrades`), flush timer, repair from fills, `repair-closed-trades.js`
- Order-owner ledger (broker order id → app user), first-writer-wins
- Fill netting for restart rebuild; open positions restored from Mongo alone
- Pending limit-order trackers for all four brokers (one shared loop, Mongo-backed, restart-safe)
- Locked-price sell ledger (`lockedSells`): re-place same price on broker cancel/reject
- One-sell-at-a-time lock per (broker, user, contract)
- Never-short guard (clamp/refuse sells beyond holdings); butterfly is the only short-entry exception
- Foreign (manual) sell attribution and booking: event-driven watch, shortfall booking, ALERT for manual orders
- In-app exit monitor (target/stop/trailing on ticks) for `useGTT=false`; attach-protection after a fill (Kite GTT / ANT monitor / refuse)
- Resting limit entries with exits attached on fill (`entryExits`)
- Admin mirror trades (`settings.mirrorPercentage`): copy frontend/contractor buys, follow sells proportionally, no recursion
- Lock-profits (admin): limit-sell all open longs, disable strategies
- Per-user limit cache (`updateUserSettings`, `reloadUserLimits`), strategy pseudo-user limits from config
- Per-broker investment cap overrides at runtime (`setBrokerInvestmentCap`)
- Drawdown tracking: daily/weekly latches (Wed–Tue week), notifications, account closure on weekly breach
- Order-process write drain on stop
- Order-process pollers (re-entrancy-guarded): open-position drawdown every 10 s, GTT fills 60 s, manual-sell ALERT reconcile 60 s (Kite), foreign-sell safety poll 15 s, pending limit-order trackers 15 s per broker, EOD reconcile tick 60 s
- Drawdown-breach force close (`forceCloseTrade`, shared in-flight guard)
- Expiry-day force close of every open position and butterfly short leg at 15:15 (`util/marketHours`, polled every 60 s)
- Exit-reject retry policy (`exitRejectPolicy`, max 5) shared by BulkPcr and Hourly; Breeze quote cross-check (`quoteCrossCheck`) for order pricing

## 5. Strategy framework
- `Strategy` base: enabled/time-window/`stateLoaded` gating of ticks, fills and cancels; `canHandleOptionQuote`; fut-quote opt-in; self-managed vs monitor exits
- `StrategyFactory` registry; `strategies.ts` runtime list; config-driven expansion
- Multi-broker: fan-out inside one instance (LimitEntry family, BulkPcr, Hourly, Butterfly, TopStock) or one instance per broker (`<id>-ANT/-Breeze/-Prism`)
- Token router: watch-token and registered-trade routing, feed source per broker
- Shared engines: `LegManager` (leg tree), `LimitEntryStrategy`, `CandleEntryStrategy`, `PnlStop`, `TrailStop`, `halfTrail`, `checkpointTrail`, `exitRules`, `entryStop`, `maxProfitLock`, `effectiveMaxProfit`, `globalMaxProfitLatch`, `finiteGuard`
- State persistence: JSON state files, Mongo state docs, `SerialWriter`, `legLineage`, `strategyLatches`
- Restart safety: reconcile without orders, platform-sell evidence, open-trades retry, unconfirmed-buy resolution
- Global settings with per-block override: `target`, `stopLoss`, `maxHoldTimeMinutes`, `maxProfit`, `skipNearestExpiryOnEve/OnExpiryDay`, `entryTimeoutMinutes`; global-only: `eodCloseTime`, `entryStartTime`
- Global `settings.maxProfit` (rupees, per strategy per broker): trip locks the cap with limit sells, latches for the day, survives restart; monitor for strategies without their own stop
- Profit monitors (global `maxProfit`, `overAllMaxProfit`) value open positions from the last option tick the strategies process received (`markPrice.ts`); a live ANT quote is fetched only for a position with no tick (cached 30 s, calls 1.2 s apart, 60 s back-off after a 429)
- `settings.overAllMaxProfit` (rupees, optional): combined day P&L of all strategies on all real brokers reaching it (checked once a minute) runs lock-profits once a day (disables every strategy in config.yml, limit-sells every open long); latch durable in Mongo (`strategyLatches`, ownerType `OverAllMaxProfit`); `src/processes/strategies/overAllMaxProfit.ts`
- SimpleContinuousStrategy `slDistance` (points, optional): any leg falling to entry - slDistance is cancelled and sold at market; the loss is booked through the fill event
- Non-finite P&L fail-safe on every trip decision
- Profit/loss cooldown release (per-block `profitCooldownSeconds`, `lossCooldownSeconds`)
- Expiry-day/eve next-expiry rule; half-days-to-expiry OTM strike shift (`entryStrike`) for spot-index buys
- Config validation per type (`configValidation`), config hot-reload, vocabulary/percent helpers
- Strategy admin: `GET /strategies`, `POST /strategies`, `POST /strategies/:type/reset` (optional `userId`, `clearPnl`) in `routes/admin.ts`; `GET /strategyPnl` in `routes/trading.ts`

## 6. Strategies (one line each; all `enabled` via `config.yml` only)
- **BulkPcrStrategy** (NIFTY, SENSEX blocks): one-shot PCR/`right` entry, chunked, resting +N sell; ANT opposite-side pair hedge on `slDistance`; resting limit re-buy with drift re-place; hedge trail exit; per-order `maxLossPerOrder` with cut cap and cooldown release; per-broker `maxProfit` (PnlStop); margin-shrunk top-up; EOD close; `reset({keepStops})`
- **BulkPcrAutoStartStrategy**: scheduled slots arm BulkPcr by writing config; opt-in catch-up (`catchUpMissedSlot`) of the latest missed slot; skips latched brokers; stuck-error recovery
- **ContinuousStrategy**: PCR-direction root, momentum veto only when `momentumEnabled`, LegManager tree (target, hard square-off, adverse ladder hedge/average, refill, capital/max-profit/max-loss latches)
- **SimpleContinuousStrategy**: one root/day, resting sell at +`priceDiff`, one-time hedge chain, `onePositionPerSide` / `maxLegsPerSide` stacking rules, first-profit restart, locked-price max-profit
- **ScaledHedgedStrategy**: Simple variant with scaled hedge size, one CE/one PE contract per cycle, `maxInvestment` on every buy
- **SupportResistanceStrategy**: S/R breach (held-duration filter) via LegManager, shared max-profit latch; detector tuning read from the top-level `srHypothesis` config block
- **HourlyStrategy**: hourly S/R breakout confirmed on 10-min candle, entry next candle open, resting target + invalidation stop, multi-broker
- **GoodMorningStrategy / GoodMorningSensexStrategy**: 09:15 vs previous close, 09:20 confirm, retry with persisted time shift, GTT bracket exit, self-rearm (NIFTY)
- **TargetReachStrategy**: watches one contract, enters when its LTP crosses a price
- **RateOfChangeStrategy**: velocity/acceleration on NIFTY ticks, timeout exit
- **GapStrategy**: 09:10–09:25 gap vs previous close, PCR alignment, reversal mode, timeout exit, cover-order keys
- **RuleBasedStrategy**: indicator-rule blocks on 5-min candles, one position, tick exits (target/stop/timeout)
- **SentimentStrategy**: fixed-direction loops with DCA add-on, target-only exit
- **TopStockOptionsOpeningGapStrategy**: rank Nifty-100 gaps at first tick, nearest-strike option per stock per broker, overnight product, target-only resting sell, fired-today marker
- **ButterflyStrategy** (NIFTY, SENSEX): iron / reverse iron butterfly 4-leg combo, short legs, net-premium target/stop, unwind on partial entry
- **RecommendationStrategy**: analyst contract at entry−`entryOffset`, target/stop rebased to fill, `repeat` and `reverse` cycle, auto-disables when done
- **NiftyChangeStrategy**: slot-based Nifty move → CE/PE, `minMovePoints`, `limitOffset`, percent/points stop with optional `maxLossPerLeg` rupee cap, opt-in `catchUpMissedSlot`
- **MomentumAtFixedTimeStrategy**: slot-based, order-book surplus + price move agreement (first slot of the day never trades, no catch-up), target/stop, `noGainTimeoutMinutes`
- **NextWeekStrategy**: 15-min 50 EMA trend + breakout candle on next-week expiry
- **BreakoutStrategy**: first-candle vs futures VWAP; candle-2 analysis only (`breakoutAnalysis`)
- **GammaBurstStrategy**: 2-min candles, 9 EMA, expiry day from 14:00, target only, paper broker
- **HighLowStrategy**: consecutive candles (`candleMinutes`, default 10) ±10-point close rule or `higherHighLow` structure; `bodyDominance`/`closeLocation` candle-quality filters; `confirmCandle` false-breakout check; quantity or budget sizing; `lastEntryTime`; exit = option-candle checkpoint (`checkpointTrail`, 2+ lots) with whole-leg tick stop, or half-at-target + trail when `trailDistance` is set; block is on `kite` in config
- **ExpiryStrategy**: cycling one side: re-buy on target, flip on stop or `driftPoints` drift; bounded by global/own `maxProfit`; block is on `paper`
- Strategy types registered in `StrategyFactory`: exactly the 24 above; every one has a `config.yml` block (all currently `enabled: false`); the old prototypes (BiDirection, Diff, Pivot, HighLot, Test, ORBPrevious) no longer exist in `src/`

## 7. Manual / user trading
- Flash Trade (server-sized, global target/stop) and Search & Buy (Advanced)
- `POST /order/buy`, `/order/squareoff`, `/order/settarget`, `/order/lock-profits`, `GET /order/can-place`, `/order/contract-quote`
- Multi-broker manual fan-out; user broker choice; investment mode vs lot-count mode
- Per-trade loss cap sizing (`levelLimits`)
- Level gating server-side (`levelGate`)
- Live position/NIFTY/option SSE streams, notification stream, ANT raw stream
- Act-as (admin impersonation) with cookie
- Broker debug reads: `/broker/:broker/positions|trades`
- Public demo endpoints replaying ticks (`/demo/*`, `makeDemoTicks`)

## 8. Users, levels and accounts
- Google login (owner/admin only; invite-only otherwise), signed session cookie, 30-day expiry, `sessionsValidAfter` revocation, CSRF POST-only rule
- User CRUD, roles, settings, profile, KYC verify flags, documents upload (GridFS), bank details, entity type, company profile (GSTIN → Advanced)
- Beginner/Advanced levels from `settings.levelRules`; level table single source; public rules endpoint
- Upgrade requests with accepted Advanced terms; capital-increase requests (successful-weeks rule); admin decisions
- Notifications (bell, mark read), approval popup
- Account deletion (DPDP erasure with pseudonymised records)
- Welcome, upgrade, EOD, payout-paid emails (Gmail API, signed PDFs, storage markers, test-recipient redirect); legal PDFs; agreements v1.1

## 9. Payouts, tax, invoices
- Weekly (Wed–Tue) payout computation from closed trades, profit split by level, drawdown forfeiture, zero/negative block
- TDS for individuals, gross for verified GST company
- Admin payouts: compute, create, pay, resend email, decision log, invoice/proof download, estimate
- Invoice rule: due paid+2 days, hourly check, account close, reopen on receipt
- Admin trade/P&L summaries (open, closed, pnl-summary)
- EOD email + signed PDF report (tool-run only)

## 10. Research (contractor) portal
- Invite-only onboarding, agreement acceptance (hashed, personalised, signed), KYC with AES-256-GCM, SEBI verification, KYC-change approvals
- Default-deny contractor guard; per-key rate limiting; contractor sessions with rotation
- Forecast engine runs in the `frontend` process (1-min candles, per-second tick store `niftyTicks`, NIFTY-future depth subscription); config block `forecast:` (hours, expiry-day end, `dailyLimit`, `windowMinutes`, `neutralThresholdPoints`, filters, `minRejectionRate`, `orders.enabled` master switch and `noNewAfter`, `maxActiveContractors`, `sessionDays`)
- Beginner forecasts: window/daily limits, order-book and trend filters, write-once record, scoring (correct/incorrect/neutral/void), accuracy stats, optional order placement
- Advanced recommendations: validation, owner approval, order under contractor id, expiry at day end, Add More
- Fee statements (accuracy/retainer for Beginner, profit-share with carry-forward for Advanced), CSV, invoice upload, approve/paid
- Drawdown limits on contractor orders
- Owner console: invites, contractors (pause/terminate/reinvite/revoke sessions/fee model), engine view, approvals, agreements, statements
- Hourly jobs: agreement version enforcement, recommendation expiry, overdue-invoice pause, SEBI expiry alerts
- Daily contractor email (tool-run only); `check-contractor-bundle.js`

## 11. Frontend (React/Vite)
- Pages: landing, owner login, join (invite), trading, profile, admin (users, config, payments, levels, trades tabs), payout payment, owner console (participants, recommendations, pilot forecasts, fees, KYC changes, agreements tabs), contractor home/forecast/recommend/profile, privacy notice (`/privacy-policy`); `/rules`, `/levels`, `/demo`, `/terms-and-conditions` redirect to `/`
- Components: order entry, position card, trade tables, date-range filter, level table/card/requests, NIFTY ticker, notification bell, theme toggle, FAQ, Flash settings
- Contexts: auth, trading, theme, demo; SSE hook; server-reachable check; market-hours util
- Build/deploy: `npm run build`, `scripts/deploy-frontend.sh`

## 12. Operations and tooling
- Scripts: login (`login.sh/js`), `check-broker-sessions.sh`, `download-all-masters.sh`, `ant-master-to-json.js`, `sync.sh`, `syncQuotes.sh`, `strategy-status.sh`, `strategy-db.js`, `continuous-strategy-trades.sh`, `trades-summary-dump.js` + `trades-summary.py`, `repair-closed-trades.js`, one-off migrations (`migrate-broker-names.js`, `migrate-profit-split.js`), `orchestrator-log.sh`, `kill-stale-orchestrator.sh`, `deploy.sh`, `deploy-frontend.sh`, gap-screener morning/eod runs, `check-contractor-bundle.js`
- Monitor feeds for the Monitor tool: `monitor-bulkpcr(-events).sh`, `monitor-continuous-events.sh`, `monitor-gap.sh`, `monitor-limitentry-events.sh`, `monitor-sentiment-events.sh`, `monitor-strategies-alerts.sh`
- npm scripts: `server`, `processes`, `processes:once`, `server:mock(:run)`, `sync`, `eod-email`, `welcome-email`, `contractor-email`, `check-invoices`, `momentum:*`, `gapscreener:*`, `orderTree*`, `tradeTree`, `logs`, `logs:errors`, `monitor:bulkPcr`
- Repo-root `tools/` (`pcr-chart`, `returns.html`, `support_resistance.html`)
- Tools: gap screener generate/quote/cover-order, order-tree printers, email senders, `buildAgreements`, `extractLegal`, `makeLevelTerms`, `makeDemoTicks`, `migrateTestUserToContractor`, quote date range, ANT batch quote, sentiment analyzer, shared `emitter`
- Skills: check-broker-sessions, monitor-strategies, recommend, trades-summary
- Config API: `GET/POST /config` with validation and diff-based write
- Global price/exit settings: `minPrice`, `maxPrice`, `targetPoints`, `stopLossPoints`, `targetPriceDiff`, `stopLossPriceDiff`, `cooldownSeconds` (also seed per-user defaults and the level table). `trailingDistance` is accepted and validated but no code reads it (setting it has no effect). `minPrice`/`maxPrice` have almost no live consumer: the order-list filter only runs for a Prism-broker RoC/RuleBased strategy and the Breeze push fill-price sanity band reads them
- Per-broker OAuth routes `/:broker/login|callback`, `POST /breeze/callback`, `GET /shoonya/callback`, `POST /ant/connect`
- Per-user routes: `/users/:email/notifications`, `/trades/open|closed|pnl-summary`, `/payouts/estimate`, `delete-account`; `GET /admin/erasure-log`; `/contractor/trades`, `/contractor/positionstream`; `/demo/health|subscribe|resolve|symbols`

## 13. Known dead/legacy (for review awareness)
- Retired Breeze-direct paths, legacy Prism password/OTP login (`prism.ts` legacy flows), legacy `minPrice`/`maxPrice` price filter (`orderList.ts`), and docs that still mention removed strategies (`docs/guides/strategies.md`, `HighLowStrategy.ts` header says `[paper]`, config says `[kite]`)
