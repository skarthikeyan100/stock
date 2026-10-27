# Known Bugs

Open bugs only. Remove an entry when it is fixed.

## 2026-10-21 - Strategies.enforceTradingWindow is one-directional: a restart before the window permanently disables an otherwise-armed strategy for the whole window

Context: `Strategies.enforceTradingWindow()` (`src/strategy/strategies.ts:66-72`) force-disables
(in-memory `strategy.enabled = false`) any strategy found enabled outside the global
09:10-15:25 trading window, and is deliberately one-directional (never auto-re-enables - see
its own comment). It runs at `initialize()` (process startup), on `syncFromConfig()` (a config
save / admin toggle), and every 60s via `strategiesProcess.ts`'s `recheckTradingWindow()`
`setInterval`. The periodic recheck only *disables*, so a strategy that was armed in
`config.yml` (`enabled: true`) but happened to start up *before* 09:10 gets force-disabled at
startup and then **silently stays disabled for the rest of that trading window** - the 60s
recheck never flips it back on once the window opens, and nothing logs this as an ongoing
problem (only the one-time "force-disabled" line at the moment it happened, easily scrolled
past in `orchestrator.log`).

Hit live 2026-10-21: `npm run processes` was (re)started at 08:47 (before 09:10) with
`TopStockOptionsOpeningGapStrategy` armed (`enabled: true`) for its 9:10-9:20 entry window.
`enforceTradingWindow()` force-disabled it at startup as designed. Nothing re-armed it as
09:10 passed, and the strategy produced zero log output through the entire window with no
error raised. Worked around by sending a `syncFromConfig` IPC request directly to the
`strategies` process's Unix socket (`/tmp/icici-strategies.sock`) at 09:16 while still inside
the window, which re-read `config.yml` and re-armed it.

| # | Gap | Where | Status |
|---|---|---|---|
| A | A process start/restart before the trading window opens permanently strands any `enabled: true` strategy disabled for that entire window, with no periodic re-check and no distinguishing log once the one-time startup message scrolls by | `strategies.ts` `enforceTradingWindow`/`recheckTradingWindow`; `strategiesProcess.ts`'s 60s interval | NOT FIXED: needs either a periodic re-enable-if-config-says-so-and-now-in-window check (tracking which strategies the window parked, so an admin disable is never undone), or a louder/repeating "N strategies parked outside window" signal |

## 2026-10-20 - Drawdown ledger: closed-trade rows held in memory (accepted design, known gap)

Context: the drawdown breach check (`bookkeeping.ts` `drawdownState` / `checkBreachAndNotify`) sums
`closedTrades` in Mongo plus rows still held in memory (`unpersistedClosed`) while their insert is in
flight or has failed. Chosen deliberately over an awaited write (decided 2026-10-20).

| # | Gap | Where | Status |
|---|---|---|---|
| A | A restart before a held row's insert lands loses that realized loss from the day's drawdown total (the startup reload only reads `closedTrades`). | `bookkeeping.ts` `unpersistedClosed`, startup reload | NOT FIXED: needs a durable journal or an awaited write (kept open per decision 2026-10-20) |

## 2026-10-19 - ContinuousStrategy live session: remaining items (Kite, expiry day)

| # | Bug | Evidence | Status |
|---|---|---|---|
| 9 | tsc-watch hot-restarts the order/strategies processes on every compile, killing in-flight buys | orphan at 10:26:34 | NOT FIXED (operational): do not edit source or restart while a buy is resting |
| 10 | Mass close (`maxProfit`, 1% of maxInvestment) realizes the losing hedge legs along with the winners; a restored leg is classed "averaged" (target avg+2 instead of +5). A `maxLoss` latch now exists in `LegManager`, so the old "no daily loss cap" part is obsolete | -2.4k..-2.8k legs at 12:35 | NOT FIXED: needs a decision on sizing and on the restored-leg class |
| 11 | ANT/Breeze/Prism sell paths have no equivalent never-short guard (ANT clamps to its own bookkeeping, not the broker; Kite's `getSellableQuantity` guard is the model) | - | NOT FIXED |

## Other open bugs

**`Minutes5Decision` bypasses its own `enabled` flag.** Its constructor hardcodes
`this.enabled = true` (`Minutes5Decision.ts:71`) regardless of config, and the `receive()`
dispatch loop in `strategiesProcess.ts` does not gate on `enabled` for that call path.
Dormant (no config block), but disabling it via config would not stop it.

**`GoodMorningStrategy`'s "already traded today" flag isn't persisted.** `resetIfNewDay()` resets
`traded = false` on every restart (`tradingDay` starts `null`). A restart landing inside the
~2-minute `LATE_WINDOW_MINUTES` grace period after a trade already executed can fire a second
trade that day. Strategy is disabled in `config.yml` today.

**`/optionstream` has no replay-on-connect** (`server.ts`, `app.get('/optionstream')`): no
snapshot is pushed to a newly-connecting client. Only the demo UI consumes it, so no live impact.

**No global 401/session-expiry handling on the frontend.** The session is checked via `/auth/me`
only once, on mount (`AuthContext.tsx`). If the cookie expires mid-session, `user`/`isLoggedIn`
stay stale and every action fails with a generic error with no hint that re-login would fix it.

**KYC document re-upload policy.** `POST /users/:email/documents/:docType` now deletes the replaced
GridFS file and resets that document's verified flag, but still allows unlimited re-uploads after
submission and after verification. Required behavior (original report): reject further uploads
once a document type is submitted/verified; re-submission goes through an explicit
resubmit/admin-reset flow.

**Hardcoded broker API key in source.** `src/kite/Kite.ts` - real Kite API key (and the other
brokers' keys/secrets in `prism.ts`, `RestAPI.ts`, `ANT.ts`, `Breeze.ts`) committed in source.
Left as-is by the user's decision (2026-10-26).

## Every manual buy uses a hardcoded global 2pt/11pt target/stop-loss regardless of user or broker [PARTIALLY RESOLVED]

`src/processes/order/kiteExecutor.ts` `buyContractOnKite()` (~line 186-187):
`finalizeEntry(trade, userId, exchange, settings.targetPriceDiff, settings.stopLossPriceDiff)`
- always uses `config.yml`'s global `settings.targetPriceDiff` (2) / `settings.stopLossPriceDiff`
(11), regardless of the placing user's profile or the instrument's price level. This is why a
manual buy squared off almost immediately at ~Rs 2/point profit once the broker-side GTT bracket
(placed at entry +/- 2/11 points) triggered.

Order-time target/SL inputs now cover the reported case. **Still open:**
- Flash Trade (`placeOrder`/`right`-only buys) has no target/SL inputs - it still always uses the
  global default, and sizing defaults to 1 lot because there is no contract to price before the
  order (`bookkeeping.resolveManualBuyQuantity` only sizes contract-resolved buys).
- `PositionCard.tsx`'s post-entry edit UI (`setTargetStopLoss` -> `POST /prism/settarget` ->
  `kiteExecutor.ts` `setTargetStopLoss()`) is unreachable in practice: `hasTargetSet` is already
  `true` on first render because `finalizeEntry` sets both synchronously at fill time, so only the
  read-only text is shown.
