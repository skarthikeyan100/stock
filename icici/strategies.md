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
`SupportResistanceStrategy`, `TargetReachStrategy`, `BulkPcrStrategy` — all
currently `enabled: false`. The rest (`BiDirectionStrategy`, `DiffStrategy`,
`PivotStrategy`, `HighLotStrategy`, `Minutes5Decision`, `TestStrategy`) are
registered in `StrategyFactory.ts`'s `STRATEGY_REGISTRY` but have no config
block, so they never get instantiated by `Strategies.initialize()` — legacy/
early-prototype code, read them with that in mind (some use dead APIs, e.g.
`isSentimentAligned` against `quote.buyQty/sellQty`, which ANT ticks never
populate). `ORBPrevious.ts` isn't even in the factory registry — an
unfinished stub (`process()` body fully commented out).

**Gotcha:** a strategy's `broker:` key in `config.yml` (seen on
`ContinuousStrategy`, `SupportResistanceStrategy`, `BulkPcrStrategy`) is
**not read by any strategy code** — grep confirms no `cfg.broker` reference
anywhere in `src/strategy/`. The actual broker used for a given user's orders
is resolved per-user at order-placement time via
`bookkeeping.getUserBroker(user)` (`src/processes/order/bookkeeping.ts:138-140`,
defaults to `'zerodha'`). Don't infer which broker a strategy will actually
trade on from its config block alone — check the user's broker setting.

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
  `closeAllOnMaxProfit` force-sells every open leg.
- **Restart safety**: `restoreFromOpenTrades()` rebuilds the leg tree from
  broker open trades + a Mongo `legLineage` collection (parent/level/isRoot
  per leg, keyed by a stable `legRef` UUID that survives restarts, unlike the
  in-memory `legId` counter).
- No GTT/bracket is ever placed for LegManager-owned legs — `getMonitorConfig()`
  on the owning strategy returns `null` specifically so the broker-side/exitMonitor
  path never double-manages these positions.

## Strategy reference

### BulkPcrStrategy (`BulkPcrStrategy.ts`) — config: active, `enabled: false`
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
**Exit (CURRENT behavior, changed this session)**: `placeExitSell()` (`:183`)
places a resting **LIMIT** sell — chunked via `chunkedSquareOffLimit` — at
`entryAvg + targetPoints` **immediately once the chunked buy completes**,
with **no stop-loss** (holds indefinitely until the limit fills, however
long that takes) and **no live-tick confirmation gate** before placing it
(deliberate — see the file's header comment: a resting limit can only fill
at-or-better than the target price regardless of when it's placed, so
gating on a tick adds a live-feed dependency for no safety benefit). This
replaces the old design that waited for a live option tick to "confirm" the
target before selling. Fills are tallied asynchronously in `updateTrade`
(`:230`) until the full `targetQuantity` is sold, at which point the
strategy **durably self-disables** (`configService.writeConfig`, one-shot —
`config.yml`'s `enabled` must be manually flipped back to `true` to arm
another run).
**Restart safety**: `reconcile()` (`:266`) distinguishes a persisted
`'selling'` phase (an exit is already resting — never re-place it, would
oversell) from `'error'` (manual review required, never auto-place an exit).
**Broker**: `getMonitorConfig()` returns `null` (self-monitored) — designed
around Breeze specifically (code comments: "Breeze doesn't support
[GTT/bracket] anyway"), though `config.yml`'s own `broker: zerodha` field is
unread by the code (see broker gotcha above) — actual broker is whatever the
user's `bookkeeping.getUserBroker` resolves to.
**Config keys** (`config.yml`): `enabled`, `broker` (informational only),
`quantity`, `targetPoints`, `right` (`call`/`put`/`none`), `maxInvestment`,
`logEnabled`.

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
**Broker**: `config.yml` says `broker: zerodha` (also unread by code — see
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
a broker-side two-leg **GTT bracket** at entry (`zerodhaExecutor.ts`'s
buy→fill→GTT sequence) or, per-user, gets routed to in-app `exitMonitor.ts`
polling if that user has `useGTT=false`. No stop-loss/target logic lives in
the strategy itself.
**Self-rearm**: on a GTT-closed trade, `updateTrade` → `rearmAfterClose`
(`:124`) opens a fresh same-day window (new `previousClose` = the exit
price) rather than waiting for tomorrow — capped at the same 14:45 limit.
**Broker**: Zerodha-specific (order path goes through `zerodhaExecutor.ts`
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
**Exit**: reuses `GoodMorningStrategy`'s Zerodha GTT-bracket entry path
(`OrderClient.buyIndex` with `targetPoints`/`stopLossPoints`, `:87-95`).
**One-shot**: fires at most once per arming (`this.fired`); `reset()`
(`:65`) re-arms the watch via `watchToken` again.
**Broker**: Zerodha (same path as GoodMorningStrategy).
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
