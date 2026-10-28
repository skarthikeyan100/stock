# Trading Strategies Guide

Every strategy under `src/strategy/` extends the abstract `Strategy` class
(`src/strategy/strategy.ts`) and is instantiated by `StrategyFactory.ts` from
a `config.yml` `strategies:` block (matched by `type`). `src/strategy/strategies.ts`
is the runtime singleton that holds the live list, expands `RuleBasedStrategy`
multi-indicator configs, and enforces the global trading window (force-disables,
never auto-re-enables — see `strategies.ts:66-93`).

**Only strategies with a `config.yml` block are actually armable today**:
`SentimentStrategy`, `ContinuousStrategy`, `RateOfChangeStrategy`, `GapStrategy`,
`RuleBasedStrategy`, `GoodMorningStrategy`, `GoodMorningSensexStrategy`,
`SupportResistanceStrategy`, `HourlyStrategy`, `TargetReachStrategy`,
`BulkPcrStrategy`, `BulkPcrAutoStartStrategy` — all `enabled: false` except
`BulkPcrAutoStartStrategy` (its job is to arm `BulkPcrStrategy` on a
schedule — see below). The rest (`BiDirectionStrategy`, `DiffStrategy`,
`PivotStrategy`, `HighLotStrategy`, `Minutes5Decision`, `TestStrategy`) are
registered in `StrategyFactory.ts`'s `STRATEGY_REGISTRY` but have no config
block, so they never get instantiated by `Strategies.initialize()` — legacy/
early-prototype code, read them with that in mind (some use dead APIs, e.g.
`isSentimentAligned` against `quote.buyQty/sellQty`, which ANT ticks never
populate). `ORBPrevious.ts` isn't even in the factory registry — an
unfinished stub (`process()` body fully commented out).

**Gotcha:** a strategy's `broker:` key in `config.yml` (seen on
`ContinuousStrategy`, `SupportResistanceStrategy`) is **not read by any
strategy code** — grep confirms no `cfg.broker` reference for those two
anywhere in `src/strategy/`. The actual broker used for a given user's orders
is resolved per-user at order-placement time via
`bookkeeping.getUserBroker(user)` (`src/processes/order/bookkeeping.ts:138-140`,
defaults to `'kite'`). **`BulkPcrStrategy` is the one exception**: it does
read its own `brokers`/`broker` config keys directly (`configuredBrokers()`)
rather than going through per-user resolution, since it fans out to every
configured broker independently rather than picking one. For every other
strategy, don't infer which broker it will actually trade on from its config
block alone — check the user's broker setting.

## Shared infrastructure

### `strategy.ts` — the `Strategy` base class
- `processNiftyQuote`/`processOptionQuote`/`receive` are abstract — every
  strategy implements its own entry trigger here.
- `canHandleOptionQuote(quote)` (default `false`, `strategy.ts:122-124`) gates
  whether a strategy's `processOptionQuote` gets called at all for a given
  tick — routing happens one level up, not inside the strategy.
- `getMonitorConfig()` (`strategy.ts:76-82`) — returning `{targetPoints,
  stopLossPoints, trailingDistance}` (the default, from `config.yml`'s
  `settings.*`) means the broker-side GTT/bracket or the in-app
  `exitMonitor.ts` poller owns the exit. Returning `null` (overridden by
  `ContinuousStrategy`, `SupportResistanceStrategy`, `BulkPcrStrategy`) means
  the strategy self-manages its own exit and nothing else will square it off.
- `addOrder()` / `buyContract()` / `sellContract()` (`strategy.ts:141-180`) —
  generic order helpers most of the legacy (non-config'd) strategies use
  directly; newer strategies go through `OrderClient` singleton methods
  (`buyIndex`, `buyContractBare`, `chunkedBuyIndex`, etc.) instead.
- `toMillis(ltt)` (`strategy.ts:69-74`) — normalizes ANT's tick timestamp
  (epoch **seconds**) to milliseconds by magnitude check. Any strategy
  comparing `quote.ltt` against a millisecond-scale threshold (cooldowns,
  breach-confirm windows) must use this — a raw-seconds comparison silently
  needs ~83 hours to trip a 5-minute throttle (real 2026-09-18 live bug, see
  `ContinuousStrategy.ts:164-169`).
- `isTimeInRange()` default window is 10:00–15:00; several strategies
  override it (`ContinuousStrategy` 09:30–15:00, `GapStrategy` 09:10–09:25).
- Win/loss/timeout counters and `recordOutcome()` (`strategy.ts:84-92`) feed
  the `/strategies` stats endpoint.

### `LegManager.ts` — shared leg/order lifecycle for self-monitored strategies
Extracted 2026-09-11 out of `ContinuousStrategy` so `SupportResistanceStrategy`
could reuse it; each owning strategy constructs its **own private instance**
(not a singleton). Handles the entire "hedge-spawn on loss, average into a
losing leg, refill on target-hit, capital/max-profit circuit breakers" tree
lifecycle so the owning strategy only needs to supply entry-trigger logic.

- **Entry**: `openRootLeg()` (`LegManager.ts:376-414`) — resolves a contract
  via `getContractByPriceRangeBare`, capital-checks
  (`capitalCheck`, `LegManager.ts:242`), buys via `buyContractBare` (single
  order, no freeze-quantity chunking — root/hedge quantities here are small
  lot sizes, not BulkPcr's block size).
- **Exit — target hit**: `onOptionTick()` (`LegManager.ts:424` onward,
  target-hit branch `~449-490`) sells via `sellContractBare` the instant
  `ltp >= target`. Target is `avgPrice + slDistance` for a never-averaged leg,
  collapsing to `avgPrice + postAverageTargetDistance` (default 1) once the
  leg has absorbed an average-add — unless `marketSentiment` favors the leg's
  own direction, in which case it holds out for the full `slDistance`
  (`targetFor()`, `LegManager.ts:360-367`). **Tick-driven, no GTT** — a target
  is only detected on the next live option tick for that token.
- **Exit — hard square-off**: separate fixed `squareOffDistance` points of
  adverse move from entry (`~500-517`), checked before the adverse-level
  ladder — also `sellContractBare`.
- **Adverse-level ladder**: 1..`maxLevels` (default 4) adverse moves of
  `slDistance` each spawn an opposite-direction hedge leg
  (`trySpawnLevel`, `~530-608`, sized off the parent's *current* `totalQuantity`
  × `spawnQuantityMode`) and/or average into the same losing leg
  (`tryAverageLevel`, `~610-653`, mode `same`/`double` via
  `averageQuantityMode`).
- **Refill on target-hit**: a closed leg re-enters a limit buy at its own
  original entry price (`placeRefill`), gated so the tree can't grow
  unbounded — a nested leg only refills while its parent is still an open leg
  (`isParentAlive`), and a refill that drifts `refillCancelDistance` points
  away from its resting price is cancelled outright, no re-price.
- **Circuit breakers** (one-way latches, never reset except via `reset()`):
  `capitalGateTripped` — total exposure (open legs + pending re-entries)
  would exceed `maxInvestment`; `maxProfitTripped` — cumulative realized +
  unrealized P&L crosses `maxProfit`% of `maxInvestment`, at which point
  `closeAllOnMaxProfit` force-sells every open leg; `maxLossTripped` — the
  unrealized P&L of the legs open right now (NOT cumulative: earlier realized
  gains do not offset it, changed 2026-10-28) reaches `-maxLoss`% of
  `maxInvestment`, which closes every open leg and blocks new entries.
- **Restart safety**: `restoreFromOpenTrades()` rebuilds the leg tree from
  broker open trades + a Mongo `legLineage` collection (parent/level/isRoot
  per leg, keyed by a stable `legRef` UUID that survives restarts, unlike the
  in-memory `legId` counter).
- No GTT/bracket is ever placed for LegManager-owned legs — `getMonitorConfig()`
  on the owning strategy returns `null` specifically so the broker-side/exitMonitor
  path never double-manages these positions.

### HourlyStrategy (`HourlyStrategy.ts`)
Multi-timeframe breakout/breakdown off hourly support/resistance, confirmed
on a 10-minute candle close — built from a shared Gemini conversation
("Hourly Nifty Support and Resistance"). Not `LegManager`-based (single
direction, one shot per breakout, no hedge tree) — closer in shape to
`RateOfChangeStrategy`, but multi-broker like `BulkPcrStrategy`.
**Levels**: resistance = previous clock-hour's high, support = previous
clock-hour's low, snapshotted at every hour rollover from the hour that just
finished (`rollHourIfNeeded`). No level exists for the first hour — gated by
`isTimeInRange()` (10:15–15:00).
**Confirmation**: a fully closed 10-minute candle whose entire body (not
just a wick) closes above resistance (breakout) or below support
(breakdown) sets a pending confirmation; filters fakeouts (`updateTenMinCandle`).
**Entry**: fires on the *open* of the very next 10-minute candle after the
confirming close — never mid-candle, never later (a confirmation more than
one bucket stale is dropped as expired) — gated by `isCooldownElapsed`,
`isSentimentAligned` (reused as the "avoid choppy hours" momentum filter the
source conversation calls for), and `hasOpenPosition()` (at most one open
trade cycle at a time, across hour boundaries).
**Multi-broker**: `brokers: [kite, ant, breeze]` (falls back to legacy
single `broker:`, same convention as `BulkPcrStrategy.configuredBrokers()`)
— the full configured `quantity` is entered independently and in parallel on
every configured broker via `chunkedBuyIndex`, `Promise.allSettled` so one
broker's failure never touches another's.
**Exit — two layers per broker**: (1) a resting LIMIT sell at
`entryAvg + targetPoints`, placed right after entry via
`chunkedSquareOffLimit`. (2) **Invalidation**: the stop level is the
confirming candle's own low (CALL) / high (PUT) — if NIFTY crosses back
through it, the breakout failed; every broker's resting sell is cancelled
(`cancelRestingLimitSells`) and whatever remains is market-squared-off
(`chunkedSquareOff`) immediately (`invalidateClose`). `getMonitorConfig()`
returns `null` — self-monitored, no GTT/bracket (Breeze doesn't support
them anyway).
**Recurring**: once every configured broker's position for a cycle reaches
`'done'`, state clears (`afterPositionDone`) so the next qualifying breakout
can trade again — unlike `BulkPcrStrategy`, this does not durably disable
itself after one cycle.
**Restart safety**: deliberately conservative, not a full leg rebuild.
Candle/hourly-level state is process-local and not persisted (same
precedent as `niftyQuoteHistory.ts`/`niftyCandleBuilder.ts` — costs at most
one hour's entries, never a stuck position). Broker *position* state is
persisted to Mongo (`hourlyStrategyState`); `reconcile()` restores it and
checks against the broker's live open trades — closed at the broker while
down is marked `'done'`, still open is flagged `'error'` for manual review
rather than guessing whether the resting sell survived.
**Config keys**: `enabled`, `brokers` (or legacy `broker`), `quantity`,
`targetPrice`, `cooldownSeconds`, `driftCancelPoints`, `logEnabled`.

## Strategy reference

### BulkPcrStrategy (`BulkPcrStrategy.ts`) — config: `enabled: false` (armed by `BulkPcrAutoStartStrategy`, see below)
**Entry**: one-shot. On the first `NiftyQuote` tick while `enabled` and in
time-range and `phase === 'idle'` (`processNiftyQuote`, `BulkPcrStrategy.ts:140`),
resolves direction either from config `right` (call/put) or, if `'none'`
(default), from PCR (`resolveEntryRight`, `:127`) — PCR > 1 favors PUT, PCR < 1
favors CALL, reusing `ContinuousStrategy`'s formula but with **no recheck
throttle** (fires at most once ever per arming). Phase is flipped to
`'buying'` synchronously *before* the PCR await to close a real 2026-09-21
race (concurrent ticks both seeing `phase='idle'` and firing duplicate buys).
**Sizing**: entry buy is the full configured `quantity` (default 13975 = 215
lots × 65) placed via `chunkedBuyIndex` (`:164`), which auto-splits across
NIFTY's exchange freeze-quantity cap (1755) and only returns once every chunk
fills.
**Exit**: `placeExitSell()` places a resting **LIMIT** sell — chunked via
`chunkedSquareOffLimit` — at `entryAvg + targetPoints` immediately once the
buy completes, with no stop-loss and no live-tick confirmation gate (a resting
limit only fills at-or-better than its price). Fills are tallied in
`updateTrade` until the slot's full quantity is sold.
**ANT pair (current design)**: ANT holds up to two slots, one per option side
(`ant_call` / `ant_put`, `slotKey`). A lone ANT slot whose option tick falls
`slDistance` (config, default 10) below its `entryAvg` opens the opposite side
once, sized to the lone slot's still-open quantity, with its own +2 sell. The
original +2 sell is never cancelled. When a side's +2 sell fully fills while
the other side is still active, that side re-buys (`entryQuantity`, the root's
entry quantity) and rests its +2 again (`onSlotSoldOut`, `buyAndExit`). So
there are never more than two open trades, one per direction. Buys use
`chunkedBuyIndex`, so they split above the freeze quantity. A buy that fills
nothing becomes `'pending'` and is retried off the active side's ticks
(`retryPendingRebuys`, throttled). An ambiguous or partial buy becomes `'error'`
(manual review). The cycle ends when no side is active (`allBrokersFinished`).
**EOD (15:15)**: `eodCloseAnt` pulls each open ANT slot's resting sells
(`cancelRestingLimitSells`) and squares off the remainder (`chunkedSquareOff`).
Nothing re-buys after EOD (`eodDone`).
**Restart safety**: `reconcile()` restores each slot from its own persisted
`'selling'`/`'pending'`/`'done'` state. A persisted `'selling'` exit is never
re-placed unless the broker shows it gone (same rule as before). A slot caught
`'buying'` or in `'error'` becomes manual review. A legacy pre-pair `ant` record
is migrated to its side, inferred from the tsym's CE/PE suffix.
**Broker**: `getMonitorConfig()` returns `null` (self-monitored — no
GTT/bracket). Multi-broker fan-out via config `brokers: [...]` (falls back to
the legacy single `broker:` field if `brokers` is empty/absent) — runs each
configured broker's full buy→exit lifecycle independently
(`configuredBrokers()`, `enterOnBroker()`). `BrokerName` supports all four:
`kite`, `breeze`, `ant`, `prism` — `ant`/`prism` support (contract
resolution + pricing branches in `orderProcess.ts`'s `chunkedBuyIndex`, and a
real `squareOffLimit` implementation added for Prism, which previously had
none) was added alongside `BulkPcrAutoStartStrategy` below.
**Config keys** (`config.yml`): `enabled`, `broker` (legacy single-broker
fallback), `brokers` (preferred, multi-broker array), `quantity`,
`targetPoints`, `chunkDriftCancelPoints`, `right` (`call`/`put`/`none`),
`maxInvestment`, `logEnabled`, `slDistance` (ANT pair trigger, default 10), `maxLossPerOrder`, `maxProfit`, `hedgeTrailDistance`.
(`maxLossPerDay` was removed on 2026-10-22, `maxLoss` before it, and `maxLossPerTrade` was replaced by
`maxLossPerOrder` on 2026-10-27. A config still carrying any of them is ignored, with a one-time WARN in the log.)

**Loss stop (`maxLossPerOrder`, optional, ships unset)**: a percent of this block's `maxInvestment`
(`10%` = 10000 on 100000), applied **to each order on its own**: the root leg and the hedge leg each have their own
cap, so with both at the cap the total loss is 2 x the cap. Loss figure of an order = that slot's open quantity marked
at its last live tick. Another side's gain, earlier cycles of the same side (a re-buy is a new order) and partial
fills do not offset it. Once an order reaches `-maxLossPerOrder`, its latch trips (`PnlStop`, a Mongo
`strategyLatches` doc keyed by `ownerType`, `userId`, `scope` = the slot key `<broker>_call` / `<broker>_put`, `day`)
and **that order is closed**: its resting sell is cancelled and its open quantity squared off (`eodSquareOff`). The
broker is **locked out for the rest of the day**: no new buys or re-buys, and `BulkPcrAutoStartStrategy` skips it at
every later slot. The broker's other order is NOT closed: it keeps its resting exit (a `maxProfit` trip still closes
everything). The other broker keeps running. One `ALERT` line is logged.

The lockout survives restarts: it is written to both the `strategyLatches` docs and the strategy's state doc
(`stoppedSlots`, plus `stoppedBrokers`), and reconcile re-applies it (a state doc from before per-order stops has no
`stoppedSlots`; its `stoppedBrokers` then locks both orders). A restored lockout also closes the tripped order and any
pending slot of that broker. If the lockout state cannot be read at all, the broker stays closed (fail-closed) until it can.
Only the admin `GET /strategies/BulkPcrStrategy/reset` clears it, or the local day rollover. The auto-start
re-arm (`reset({ keepStops: true })`) keeps the lockout.
No `maxLossPerOrder` (or 0) = off. A `maxLossPerOrder` without a usable `maxInvestment` fails config validation.

**Hedge trail exit (`hedgeTrailDistance`, points, optional, ships unset = off)**: applies to the hedge leg (the side
opened by the `slDistance` trigger) only; the root leg keeps its fixed `targetPoints` resting sell. With it set, the hedge
has **no resting sell**. Its target is `ceil(d / 2)` points above its entry, where `d` is how far the other leg was below its entry when the hedge buy started (CE bought at 100, hedge opened at 90 -> 5; after that hedge closes, a new one opened with CE at 80 -> 10); `slDistance` is the fallback if that price is unknown. Reaching the target
only **arms** the trail (`TrailStop.ts`, one instance per slot; nothing is sold). Once armed, the exit level is
`max(entry + target, peak - hedgeTrailDistance)`: it follows the highest tick and never sits below the target. A tick at
or below it fires the exit: a **limit** sell for the open quantity, priced at that tick (so it is marketable) and never
below the entry, placed through the same chunked limit path as every exit. If the price then falls through the limit and
it is still unfilled after 3 s, it is cancelled and re-placed at the current tick (still a limit, never below the entry;
below the entry it just rests, as today's target sell would). The peak is persisted on the position (`trail`) and
survives a restart; a fired exit is persisted as `exitLimitPrice`, so reconcile/cancel re-placements reuse it. The mode (`trailDistance`/`trailTarget`) is fixed on the slot when its exit is set up, so a config change never flips a live hedge. `hedgeTrailDistance` requires `maxLossPerOrder` (validation), since the trail never sells below the entry. A
sold-out hedge re-buys exactly as before (a new cycle, trail reset). The EOD close and a loss/profit lockout close a
trailing hedge the same way as any slot.

**Profit stop (`maxProfit`, optional, ships unset)**: the same percent-of-`maxInvestment` form, but cumulative **per
broker for the whole day**, not per trade. Day P&L = realized over every slot cycle today (`dayRealizedByBroker`) +
open P&L of that broker's selling slots at the last live tick. Once it reaches `+maxProfit`, its own latch trips
(`PnlStop` kind `profit`, scope `<broker>:maxProfit`, field `maxProfitTripped`) and the broker gets the same lockout as
a loss trip: open slots closed at limit, no new buys or re-buys, skipped by `BulkPcrAutoStartStrategy` for the rest of
the day. The day's realized P&L survives a re-arm (`reset({ keepStops: true })`) and is cleared only by the admin
reset or the day rollover; it is persisted as `dayRealizedByBroker` and restored on reconcile. Its lockout is stored as
`profitStoppedBrokers`. A breach is checked on every tick and on every realized slot fill. Keep it above the hedge trigger (`slDistance` points on the put, about
7,800 at 780 qty), or the hedge has no room under the cap.

**Margin rejections (ANT)**: a margin-rejected buy is never re-sent unchanged. It gets ONE reduced-quantity
attempt (rounded down to whole lots, 5% headroom, from the shortfall the broker reports). If that fails,
or the rejection cannot be parsed, the side is abandoned for this cycle with an `ALERT`. Other "nothing
bought" failures retry at most 3 times with 10s/20s/40s backoff, then abandon. An abandoned hedge is never
reopened in the same cycle, and the other side's resting +N sell is left alone (the loss stops and the EOD
close are the backstop). A root entry rejected for margin is not retried; its slot ends `done` with an `ALERT`.
**`isRunning()`**: exposes `phase === 'running'` externally — used by
`BulkPcrAutoStartStrategy` to decide whether a scheduled re-arm should be
skipped.

### BulkPcrAutoStartStrategy (`BulkPcrAutoStartStrategy.ts`) — config: active, `enabled: true`
Scheduled auto-arm wrapper around `BulkPcrStrategy` — doesn't place any
orders itself, only flips `BulkPcrStrategy`'s own `config.yml` block and
`enabled` flag. At each configured `times` HH:mm slot (default
`['10:35', '11:35', '12:35']`), attempted at most once per day per slot
(mirrors `GoodMorningStrategy`'s snapshot/confirm late-window-skip pattern,
`LATE_WINDOW_MINUTES = 5`):
1. Looks up the live `BulkPcrStrategy` instance via
   `strategies.getByUserId('BulkPcrStrategy')`.
2. If `target.isRunning()`, skips this slot (logs and moves on — the next
   scheduled slot will try again).
3. Otherwise calls `target.reset()` (clears any stale `phase='done'`/
   `positions` from a previous cycle), writes this wrapper's own `quantity`/
   `brokers` onto `BulkPcrStrategy`'s `config.yml` block along with
   `enabled: true`, and calls `strategies.syncFromConfig()` so the live
   instance picks up `enabled` immediately. Every other `BulkPcrStrategy`
   config key (`targetPoints`, `chunkDriftCancelPoints`, `right`,
   `maxInvestment`, `logEnabled`) is left exactly as already set in its own
   block — only `quantity`/`brokers`/`enabled` are overwritten.
**Config keys** (`config.yml`): `enabled`, `times` (array of `HH:mm`
strings), `quantity`, `brokers` (array, written onto `BulkPcrStrategy`'s own
config when armed).
**Requires** `BulkPcrStrategy` to be present (even if `enabled: false`) in
`config.yml` — this wrapper only arms an existing instance, it never creates
one.

### ContinuousStrategy (`ContinuousStrategy.ts`)
**Entry ("T1")**: `processNiftyQuote` (`:222`) gates on enabled/time-in-range
(own override: 09:30–15:00)/not-already-ordered/cooldown, then resolves
direction via PCR (`resolveEntryRight`, `:199`), re-checked at most every 5
minutes (`PCR_RECHECK_MS`, `:14`) over a ±300-point window around spot
(`fetchPcrIfDue`, `:170`). If `cfg.momentumEnabled`, `MomentumSignal`
(`MomentumSignal.ts`) can veto an entry if ATM CE/PE order-book imbalance
(tbq/tsq) actively disagrees with PCR's direction (never blocks by itself if
inconclusive). If `cfg.right` is set, PCR must agree with it. On a resolved
direction, opens a root leg via `legManager.openRootLeg()`.
**Sizing**: `initialQuantity` config key, per `LegManager.openRootLeg`.
**Exit**: entirely delegated to `LegManager` (target/adverse-ladder/
square-off/refill — see shared section above); `getMonitorConfig()` returns
`null` (`:278`).
**Broker**: `config.yml` says `broker: breeze`, but unread by code — real
broker is per-user (see gotcha above).
**Restart safety**: `reconcile()` (`:115`) restores open legs from broker
trades via `legManager.restoreFromOpenTrades`.
**Config keys**: `enabled`, `broker` (informational), `initialQuantity`,
`slDistance`, `squareOffDistance`, `postAverageTargetDistance`, `minPremium`,
`maxInvestment`, `maxProfit`, `spawnQuantityMode`, `averageQuantityMode`,
`right`, `marketSentiment`, `maxLevels`, `cooldownSeconds`,
`refillCancelDistance`, `logEnabled`, `momentumEnabled`, `momentumTimeoutMs`.

### SupportResistanceStrategy (`SupportResistanceStrategy.ts`)
**Entry**: driven by `src/lib/supportResistance.ts`'s SEEKING/LOCKED/BREACH
detector (`processTick`, called from `processNiftyQuote`, `:116`) — a
confirmed **resistance** breach buys CALL, a confirmed **support** breach
buys PUT, gated by a held-duration filter (`heldMinSec`–`heldMaxSec`, from
the shared `srHypothesis:` config block, not this strategy's own block —
same tuning `SupportResistanceHypothesisTest.ts` validates offline). One
position per side at a time (`hasOpenLegOfRight`, `:145`) plus a cooldown.
**Sizing**: fixed `quantity` config key via `legManager.openRootLeg`.
**Exit**: delegated to `LegManager`, same as `ContinuousStrategy` — CE and PE
share **one** `LegManager` instance so `maxProfit` is a single combined latch
across both sides. `getMonitorConfig()` returns `null` (`:70`).
**Broker**: `config.yml` says `broker: kite` (also unread by code — see
gotcha).
**Restart safety**: `reconcile()` (`:95`), same pattern as `ContinuousStrategy`.
**Config keys**: `enabled`, `broker` (informational), `quantity`,
`slDistance`, `squareOffDistance`, `maxLevels`, `spawnQuantityMode`,
`averageQuantityMode`, `postAverageTargetDistance`, `refillCancelDistance`,
`minPremium`, `maxInvestment`, `maxProfit`, `cooldownSeconds`,
`marketSentiment`. Detector tuning lives separately under `srHypothesis:`.

### GoodMorningStrategy (`GoodMorningStrategy.ts`)
**Entry**: two-stage same-day window. At `snapshotTime` (default 09:15),
records direction of `NIFTY ltp - config.previousClose` if it exceeds
`minMovementPoints` (`computeDirection`, `:147`). At `confirmTime` (default
09:20), re-checks the same direction test against the snapshot price; if the
trend didn't hold, `retryOrGiveUp` (`:92`) pushes both times out by 30
minutes (persisted into `config.yml`, capped at 14:45) rather than giving up
for the day. A late (re)start skips the day entirely if either time window
was already missed by more than 2 minutes (`LATE_WINDOW_MINUTES`) — prevents
a stale price firing instantly on restart.
**Sizing**: fixed `quantity` config key.
**Exit**: `OrderClient.buyIndex()` is called with `targetPoints`/
`stopLossPoints` from config directly (`executeTrade`, `:218`) — this places
a broker-side two-leg **GTT bracket** at entry (`kiteExecutor.ts`'s
buy→fill→GTT sequence) or, per-user, gets routed to in-app `exitMonitor.ts`
polling if that user has `useGTT=false`. No stop-loss/target logic lives in
the strategy itself.
**Self-rearm**: on a GTT-closed trade, `updateTrade` → `rearmAfterClose`
(`:124`) opens a fresh same-day window (new `previousClose` = the exit
price) rather than waiting for tomorrow — capped at the same 14:45 limit.
**Broker**: Kite-specific (order path goes through `kiteExecutor.ts`
directly via `OrderClient.buyIndex`, not broker-agnostic).
**Config keys**: `enabled`, `quantity`, `targetPoints`, `stopLossPoints`,
`logEnabled`, `snapshotTime`, `confirmTime`, `previousClose`,
`minMovementPoints`.

### GoodMorningSensexStrategy (`GoodMorningSensexStrategy.ts`)
Exact SENSEX/BFO sibling of `GoodMorningStrategy` — same two-stage
snapshot/confirm logic, driven off `processSensexQuote` instead of
`processNiftyQuote`, no self-rearm-after-close (`updateTrade` is a no-op,
`:60`), separate config block/type because `ConfigService` keys one config
block per strategy `type`. Trades ~3x NIFTY's point scale (20-share lot,
default `minMovementPoints: 30` vs NIFTY's 10).
**Exit**: same as `GoodMorningStrategy` — GTT bracket via
`OrderClient.buyIndex`.
**Config keys**: `enabled`, `quantity`, `targetPoints`, `stopLossPoints`,
`logEnabled`, `snapshotTime`, `confirmTime`, `minMovementPoints` (no
`previousClose` key in the current config.yml block — must be set for the
snapshot to fire, else it skips for the day, `:147-152`).

### TargetReachStrategy (`TargetReachStrategy.ts`)
**Entry**: not NIFTY-move-driven like the others — told exactly which
contract to watch (`symbol`+`strike`+`expiry`+`optionType`, resolved to an
ANT token at construction via `AntContractMaster`, `:38-54`), then registers
itself as a Monitor "watcher" (`watchToken`) so it receives ticks for that
token before holding any position (normal routing only fires for tokens with
an open trade). Fires once the option's own LTP crosses `config.targetPrice`
(`processOptionQuote`, `:73`) — a price-target trigger, not a NIFTY-based
signal.
**Sizing**: fixed `quantity` config key.
**Exit**: reuses `GoodMorningStrategy`'s Kite GTT-bracket entry path
(`OrderClient.buyIndex` with `targetPoints`/`stopLossPoints`, `:87-95`).
**One-shot**: fires at most once per arming (`this.fired`); `reset()`
(`:65`) re-arms the watch via `watchToken` again.
**Broker**: Kite (same path as GoodMorningStrategy).
**Config keys**: `enabled`, `symbol`, `strike`, `expiry`, `optionType`,
`targetPrice` (the *entry* trigger price, distinct from `targetPoints` which
is the post-entry exit target), `quantity`, `targetPoints`, `stopLossPoints`,
`logEnabled`.

### RateOfChangeStrategy (`RateOfChangeStrategy.ts`)
**Entry**: velocity/acceleration signal over a rolling window of NIFTY quote
history (`niftyQuoteHistory`, `N = numberOfDatapointsReceived`) —
`calculatePointsChange`/`calculateAcceleration` (`:215-227`). Direction only
fires when acceleration *dominates* velocity in magnitude
(`accDominates`, `:147`): accelerating-up or accelerating-down continues the
existing move, while velocity-up-but-decelerating (or vice versa) is read as
a reversal signal in the opposite direction. Also runs the base class's
`isSentimentAligned` check (a known-dead no-op against ANT ticks, per the
`ContinuousStrategy` comment — effectively always passes).
**Sizing**: fixed `quantity` config key, resolved contract via
`getContractByPriceRange`.
**Exit**: `getMonitorConfig()` returns `{targetPoints: config.targetPrice,
stopLossPoints: config.stopLossPrice, ...}` (`:113`) — broker GTT/bracket or
`exitMonitor.ts` owns target/SL; the strategy itself only handles a
**timeout** exit (`maxHoldTimeMinutes`, sells via `strategy.sellContract` —
a plain limit-at-LTP order, not a bracket).
**Config keys**: `enabled`, `pointsThreshold`, `accelerationThreshold`,
`numberOfDatapointsReceived`, `quantity`, `targetPrice`, `stopLossPrice`,
`maxHoldTimeMinutes`, `logEnabled`.

### GapStrategy (`GapStrategy.ts`)
**Entry**: single decision per day, only within a 09:10–09:25 window
(`isTimeInRange` override, `:125`) — compares `NIFTY ltp` against the
broker's own live `prevClose` field on the quote (`gapPoints`, `:155`), not a
rolling window. Either simple threshold mode (`gapPoints >= pointsThreshold`
→ CALL, `<=` → PUT) or `gapReversalMode` (fade small gaps, follow large
ones past `gapReversalThreshold`). Direction must also align with a
fresh PCR read (`isPcrAligned`, `:204`, ±300pt window, fail-closed on error).
`decidedToday` latches after the one decision (trade or not), re-armed by
`resetIfNewDay` — deliberately tracked separately from `this.enabled` so a
config-level disable doesn't prevent tomorrow's re-arm.
**Sizing**: fixed `quantity` config key via `OrderClient.buyIndex`.
**Exit**: `buyIndex` is called with `targetPoints`/`stopLossPoints` — GTT/
bracket-based, per the buy request shape (comment at `:53` confirms "Broker
(GTT/exitMonitor) handles target/SL exits"); strategy itself only forces a
**timeout** square-off (`maxHoldTimeMinutes`, via `OrderClient.squareOff`,
not a bracket-safe limit — worth double-checking this is a marketable-limit
order at the executor level, not a raw market order).
**Config keys**: `enabled`, `pointsThreshold`, `numberOfDatapointsReceived`
(unused by this file — vestigial from a shared template), `quantity`,
`targetPrice`, `stopLossPrice`, `maxHoldTimeMinutes`, `gapReversalMode`,
`gapReversalThreshold`, `logEnabled`.

### RuleBasedStrategy (`RuleBasedStrategy.ts`)
**Entry**: driven by `receive(oldStats, newStats)` (periodic technical-
indicator stats snapshots from `decision.ts`), not quote ticks —
`processNiftyQuote` is a no-op (`:253`). Every indicator in the configured
`indicators` list (e.g. `RSI_5_70_30`, `MACD_12_26_9`, `EMA_5_13`,
`Bollinger_20_2`, `ADX_14`, `Stoch_14_3`) must independently resolve to the
**same** UP/DOWN trend (`consensus`, `:182`) — a single NEUTRAL or missing
signal blocks the trade entirely. Multiple indicator-group configs under one
`type: RuleBasedStrategy` block get expanded into separate strategy
instances by `StrategyFactory.expandRuleBasedConfig` (userId
`Rule-<indicators>`), each with its own config looked up via
`Strategies.getExpandedConfig(userId)` (`getConfig()`, `:120`).
**Sizing**: fixed `quantity` per expanded config.
**Exit**: `getMonitorConfig()` returns `{targetPoints: config.target,
stopLossPoints: config.stopLoss, ...}` (`:115`) — GTT/bracket or
`exitMonitor.ts`; strategy itself only forces a timeout exit
(`maxHoldTimeMinutes`).
**Config keys** (per indicator-group, under one `type: RuleBasedStrategy`
block): `enabled`, `indicators` (array, one entry per spawned instance),
`quantity`, `target`, `stopLoss`, `maxHoldTimeMinutes`, `logEnabled`.

### SentimentStrategy (`SentimentStrategy.ts`) — config: active, `enabled: false`
**Entry**: fires up to `loopCount` times total (across the process lifetime,
not per-day), buying `sentiment`-direction (fixed `call`/`put`, not PCR-
derived) NIFTY options at `NIFTY ltp - 2` once per cooldown window, inside a
09:30–15:30 window override (`:172-178`).
**Sizing**: fixed `orderQuantity`, with an internal same-token DCA add-on: if
price drops more than `averageThreshold` below the last fill, it buys 600
more of the *same* contract to average down (`Contract.processOptionQuote`,
`:103-109`) — hardcoded quantity `600`, not config-driven.
**Exit**: purely self-managed — sells the whole averaged position via
`strategy.sellContract` (a plain limit order) once `ltp - avgPrice >=
targetPrice` (`:112-119`). No stop-loss at all — a losing position with no
target reached is never cut, it either eventually recovers to target or
stays open indefinitely.
**Config keys**: `enabled`, `averageThreshold`, `targetPrice`,
`orderQuantity`, `sentiment` (`call`/`put`), `loopCount`.

### Minutes5Decision (`Minutes5Decision.ts`)
No `config.yml` block — always `enabled = true` in its constructor
regardless of factory config (`:73`), driven entirely by `receive()`'s
`oldStats.results.eventName === 'priceUpdate_60'` gate, not by `enabled`/
`isTimeInRange`. Picks a contract by order-book imbalance
(`getTradersDirection`, buy/sell qty diff over an `interestThreshold`) among
near-the-money CE/PE, buys `orderQuantity` (hardcoded 300), and immediately
places a **fixed-offset limit sell** at `buyPrice + targetPrice` (hardcoded
3) right after the buy (`_executeTrade`, `:76-88`, `await sleep(2000)` then
sell — no fill confirmation). Explicit code comment: "no stop loss - monitor
manually". Caps concurrent trades at `tradesCount` (10). Legacy/prototype —
not part of the current live strategy set.

### TopStockOptionsOpeningGapStrategy (`TopStockOptionsOpeningGapStrategy.ts`) — config: `enabled: true`, multi-broker
**Entry**: one-shot per day, fires once within a short morning window
(`isTimeInRange()` override, 9:10–9:20 IST — right as NSE's pre-open
equilibrium price settles, well clear of `BulkPcrAutoStartStrategy`'s 10:35
earliest slot). Gap is computed live, not from any CSV: one batched ANT OHLC
call (`getOpenAndPrevClose`) over a static Nifty-100 universe
(`data/nifty100_symbols.txt`, snapshotted from NSE's index-constituent CSVs —
re-run the fetch by hand every few months to refresh it; not wired to a
cron), ranks by `|Gap %|` descending, takes the configured rank window
(default ranks 3–5, i.e. `rankStart: 3`, `rankCount: 3`), and for each one
buys the nearest-strike CE (gap up) or PE (gap down) option — one leg per
(stock, broker) pair, isolated via `Promise.allSettled` so one leg's
contract-resolution/order failure doesn't abort the others.
**Product (overnight, not intraday)**: the position is meant to be held
past the session. Kite places `NRML` and Breeze `options` (both carry
forward). ANT's buy and resting target sell pass `product: 'LONGTERM'`
explicitly (`ANT.placeOrder`'s default is `INTRADAY`, which AliceBlue squares
off at ~3:20pm). The product is stored on the Trade so exits and restores
reuse it. `LONGTERM` is the unverified value from AliceBlue's v2 docs; if
the first live ANT entry is rejected, check the logged response and try
`NORMAL`.
**Multi-broker (`brokers: [kite, breeze, ant]`)**: ranking stays
broker-independent — the single ANT OHLC batch call picks the stocks and
`AntContractMaster.findNearestStrikeOption` picks the reference strike +
nearest expiry for each one; every configured broker then resolves its OWN
tradable contract for that SAME (strike, expiry) pair
(`KiteContractMaster.findExactOptionBySymbol`,
`BreezeContractMaster.findOption` via `getEquityStockCode` for the ICICI
shortName) rather than independently re-picking a strike, so a stale
weekly-vs-monthly master on one broker can't silently diverge from what ANT
chose (the exact failure class flagged in `KiteContractMaster.ts`'s own
`refreshIfStale` comment). `kite` is accepted as an alias for `kite`;
unknown broker names are dropped with a log; an empty/missing config falls
back to `['ant']`. `lots` applies **per stock per broker** — 3 stocks × 3
brokers = up to 9 positions — and the shared per-user capital/loss caps
(`canPlaceOrder`) can reject a later broker's leg once an earlier one has
used up the budget.
**Contract resolution**: uses `AntContractMaster.findNearestStrikeOption`
(not `findATMOption` - its strike-rounding step only covers NIFTY/SENSEX,
defaulting to a flat 50 for everything else, which almost never matches a
real listed strike for an individual stock) to pick the strike nearest to
the stock's `Latest Open` from the real listed strikes for the nearest
expiry. A breeze leg is skipped (logged, not fatal) if the ICICI shortName
isn't plain letters (e.g. `M&M`) or no contract exists at ANT's exact
expiry.
**Entry/exit — ant**: 1 lot (`lots` config, default 1) per leg, bought at
MARKET with AliceBlue's `marketProtectionPercent` (`marketProtectionPercent`
config, default 5) instead of a pre-trade-LTP marketable limit — this drops
the second (pre-buy) OHLC call entirely, cutting the ANT-throttled gap
between ranking and the first buy to well under a second. If ANT rejects the
MARKET+protection order (`EC965`/"Market orders are not allowed"),
`antExecutor.enterPosition` falls back to a marketable LIMIT priced off
`ANT.getScripQuote` (not OHLC-throttled).
**Entry/exit — kite/breeze**: bought via the broker-dispatched
`butterflyBuyLeg` IPC (`marketBuyBareOnKite`/`marketBuyBareOnBreeze` —
themselves a marketable LIMIT at the live best bid/ask, not a true broker
MARKET order), using the ANT-native token for the live-quote lookup and
that broker's own trading symbol to place the order. The target is computed
strategy-side from the real fill, with the identical formula ANT's
`antExecutor` uses server-side, and placed as a separate resting sell via
the broker-dispatched `brokerPlaceLimitSellBare` IPC
(`placeLimitSellBareOnKite`/`placeLimitSellBareOnBreeze`).
**All brokers**: the resting target-only exit is a separate limit sell
placed after the real fill, at `min(0.0025 * stockOpen, fillPrice)` points
above the fill price (0.25 assumed delta × 1% of the underlying's open,
capped at 100% of the premium paid) — exit is self-managed (one resting
limit sell per leg, no re-place-on-cancel, no reconcile), not broker-owned;
`getMonitorConfig()` returns `null` and `canHandleOptionQuote()` is always
`false` accordingly. `exitMonitor.ts`'s `SELF_MANAGED_STRATEGY_TYPES` lists
this strategy's type so a restart's `reconcileFromTrades()` never
re-registers these trades as broker-owned; the kite/breeze fills on the
resting sell are picked up by `pendingLimitOrders.ts`'s/
`breezePendingLimitOrders.ts`'s own pollers like any other bare limit sell.
**Fire-and-forget**: `executeTrade()` dispatches every leg's buy+fill-wait+
sell and returns immediately once all buys are in flight; per-leg
aggregation (entered-count logging, `durablyDisable`) happens in the
background via a detached `Promise.allSettled(...).then(...)`.
**Restart safety**: a `.topStockOptionsOpeningGap_firedToday.<userId>.json`
marker (namespaced by `userId`, same pattern as `BulkPcrAutoStartStrategy`'s
`.bulkpcr_armed_slots.json`, written *before* any leg is dispatched)
prevents a process restart inside the trading window from re-entering all
legs a second time the same day.
**Config keys** (`config.yml`): `enabled`, `brokers` (or legacy single
`broker`), `rankStart`, `rankCount`, `marketProtectionPercent`, `lots`,
`logEnabled`. This places real option orders across up to `rankCount`
stocks × `brokers.length` brokers at once; a dry run of the log output
(rank selection, resolved contracts) should be reviewed before changing the
rank window or broker list.

### BiDirectionStrategy, DiffStrategy, PivotStrategy, HighLotStrategy, TestStrategy
Legacy/early-prototype strategies registered in `StrategyFactory.ts` but with
no `config.yml` block, so `Strategies.initialize()` never instantiates them —
dead in practice. All predate the PCR/LegManager infrastructure; several use
hardcoded constants instead of config (e.g. `HighLotStrategy`'s
`buyQuantity = 300`, `BiDirectionStrategy`'s `initialQuantity = 65`), rely on
`this.stats.results.pivot`/`eventName == 'priceUpdate_60'` from an older
`decision.ts` shape, and self-manage exits with no stop-loss (`HighLotStrategy`
even has a `// REVISIT` log line where a sell call was commented out,
`HighLotStrategy.ts:63-64,71-72` — its sell paths are non-functional as
written). Not worth deep individual documentation; read the file directly if
reviving one, and verify current `decision.ts`/`OrderClient` APIs still match
before trusting anything here to actually place orders correctly.

### ORBPrevious.ts — not registered, not live
`export class ORBPrevious extends Strategy` (no `export default`, absent from
`StrategyFactory`'s `STRATEGY_REGISTRY`) — an opening-range-breakout stub
whose entire `process()` body is commented out. Cannot be armed via config at
all in its current state.

### MomentumSignal.ts — helper, not a strategy
Not a `Strategy` subclass. One-shot ATM CE/PE order-book-imbalance (tbq/tsq)
reader used only by `ContinuousStrategy` as an optional entry veto (see
`ContinuousStrategy` above) — subscribes ANT depth-mode ticks for the nearest
ATM CE/PE, waits up to `momentumTimeoutMs` for both legs' imbalance to agree,
then unsubscribes. Returns `null` (never blocks) on ATM-lookup failure,
timeout, or CE/PE disagreement.
