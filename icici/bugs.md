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

## Discrepancies seen in live logs on 2026-10-30

**Breeze order-notify push reports `averageExecutedRate` 0.000000 on Executed pushes. [FIXED 2026-10-30, not yet seen live]**
`src/breeze/BreezeOrderNotifyStream.ts` (`handleMessage`). Seen at least 12 times on 2026-10-30
(e.g. orders 202610303800003666, 202610303800003669). The stream rejects the push and the REST
fill check confirms the price, so no wrong price is booked, but every such fill waits on REST.
Also seen: an implausible fill price of 2843100.000000 on order 202610303800004030, again
recovered by REST at 99.9.
Root cause: on `Executed` pushes `averageExecutedRate` is zero/garbage and the real average fill price is in `cancelFlag`, in paise (all 7 REST-confirmed
fills that day equalled `cancelFlag / 100`, truncated to paise; a limit sell's `cancelFlag` equals its `limitRate`). Fix: `pushFillPrice()` in
`BreezeOrderNotifyStream.ts` takes `averageExecutedRate` if plausible, else `cancelFlag / 100`, bounded by min/max price and the limit side;
the REST fallback stays as the safety net. Verify live: no "implausible" lines for a normal Executed push.

**`Ordered` status is logged as "unrecognized status". [FIXED 2026-10-30]** `BreezeOrderNotifyStream.handleMessage`
treats a freshly placed, resting order (`orderStatus: Ordered`) as unknown. It is a non-terminal
state, so it is now accepted silently (`Ordered`, `Requested`, `Queued`). Misleading log noise only.

**BulkPcr ANT pair sized unequal after a margin retry. [FIXED 2026-10-30 (top-up), margin figure still open]** 2026-10-30 12:00:47, put buy of 975 on
ANT was rejected for margin (`RED:Margin Shortfall`). `BulkPcrStrategy.onBuyNotFilled` retried
once at 780 and filled. The call leg stayed at 975, so 195 lots of the ANT call are unhedged.
Fix: the lots the resize left out (`topUpQty`) are bought later on the same contract (`topUpSlot`, every 30 s, at most 3 attempts) while the
sibling is open and merged into one resting sell at the blended entry; trailing hedges are not topped up and say so. Still open: the rejection text reports "Available INR 193604" next to a shortfall of
INR 12916, which does not add up for the same account; check the margin figure we send or read. Also: the hedge re-buy was refused by the
max-investment cap (112931/100000) on kite at 11:01 and 12:04, leaving the put naked - fixed by exempting hedge re-buys / top-ups from that one gate
(`hedgeRebuy` through `OrderClient` -> `canPlaceOrder(skipInvestmentCap)`).

**Admin strategy reset is type-wide. [FIXED 2026-10-30]** `POST /strategies/:type/reset` (`src/routes/admin.ts`,
`strategiesProcess.ts` case `reset`) resets every strategy of that type. Resetting
`BulkPcrStrategy` to clear the NIFTY lockout also reset `BulkPcr-SENSEX` (disabled). Reset also
clears the day's realized P&L (`dayRealizedByBroker`), so after a reset the max-profit and
max-loss limits measure from zero, not from the day's actual P&L. Fix: `POST /strategies/:type/reset?userId=<instance>` resets one instance, and
BulkPcr keeps the day's realized P&L unless `?clearPnl=true`.

**`durablyDisable` writes `enabled: false`, and the next arm needs a manual flip. [NOT A BUG - corrected 2026-10-30]** After the
cycle completed at 11:56:52, `BulkPcr-NIFTY` was set to `enabled: false` in `config.yml`, which
stopped the strategy at the next slot. Checked in the log: every `durablyDisable` (10:50, 10:55, 11:56) was followed by the next auto-start slot arming
the strategy again (10:55, 11:00, 12:00), because `attemptStart` writes `enabled: true`. The manual flip was only needed while the strategy was stuck in
the error state below. No code change.

**BulkPcr stuck in broker-error state with no open positions, blocking every slot until a reset. [FIXED 2026-10-30, per-broker scoping not done]**
On 2026-10-30 `BulkPcr-NIFTY` latched `hasBrokerError()` from 11:01 onward and every auto-start
slot from 11:05 to 11:45 was skipped with "STUCK in a broker error state - manual review and
reset() required". The reset was needed even though the book was flat. Chain of events:
- 11:00:38 ANT put rejected for margin (`RED:Margin Shortfall`); the chunked buy failed and set the
  slot to `phase = 'error'`.
- 11:01:44 kite and breeze call re-buys were `[NOT_PLACED]` for max investment (105885/100000,
  106415/100000). `placeRestingRebuy` still logged "outcome unconfirmed - an order may be LIVE",
  so the message says a live order might exist when the code path says none was placed.
- 11:02 `closeBroker` skipped both brokers with "call slot is in error - skipped, manual review
  required", so the error stayed set and nothing closed it.

Problems:
1. The `error` phase is never cleared by a flat check. A slot with no quantity and no live order
   should return to `done` or `idle` on its own. Instead it stays until an admin reset.
2. The "outcome unconfirmed" alert fires for `[NOT_PLACED]`, which is a definite refusal (cap).
   It should say "not placed" and not raise a manual-review error.
3. Auto-start treats any error as a stop for the whole strategy, so one margin-rejected buy blocks
   all later slots, not just that slot.
4. The admin reset also cleared realized P&L and the other brokers' state (see the reset item above),
   which is a heavy fix for a flat book.

Fix: `isNothingBought` now treats `[NOT_PLACED]` as a definite refusal (no `error` latch); `BulkPcrStrategy.recoverFlatErrors()` clears an `error` slot that
is flat at the broker with no pending sell (auto-start calls it before reporting STUCK); the STUCK alert is logged once per cause.
Not done: arming only the healthy brokers while one is errored - a running cycle cannot be armed again concurrently, and `reset({keepStops})` would
drop the errored slot's state. A slot with an unresolved contract or a possibly-live remainder stays latched on purpose (manual review).
