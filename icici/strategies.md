# Trading Strategies Guide

Every strategy under `src/strategy/` extends the abstract `Strategy` class
(`src/strategy/strategy.ts`) and is instantiated by `StrategyFactory.ts` from
a `config.yml` `strategies:` block (matched by `type`). `src/strategy/strategies.ts`
is the runtime singleton that holds the live list and expands `RuleBasedStrategy`
multi-indicator configs. A strategy only receives ticks, fills and cancellations
when `Strategy.receivesEvents()` is true: `enabled` in `config.yml` (always
mirrored, never cleared in memory), inside the 09:15-15:25 trading window (09:15 = the NSE open; pre-open ticks are indicative and are never delivered) (a clock
test), and `stateLoaded` (set once the startup restore has run for it: positions from Mongo, then its own `reconcile()` inside `OrderClient.withNoOrders`, which never places an
order; see `strategiesProcess.startupReconcile`).

**Armable today** (a `config.yml` block exists; all `enabled: false` unless the
operator turns one on): `SentimentStrategy`, `ContinuousStrategy` (three
instances, one per broker), `RateOfChangeStrategy`, `GapStrategy`,
`RuleBasedStrategy`, `GoodMorningStrategy`, `GoodMorningSensexStrategy`,
`SupportResistanceStrategy`, `HourlyStrategy`, `TargetReachStrategy`,
`BulkPcrStrategy` (NIFTY and SENSEX), `BulkPcrAutoStartStrategy` (arms
`BulkPcrStrategy` on a schedule by writing `enabled: true` into `config.yml`),
`TopStockOptionsOpeningGapStrategy`, `ButterflyStrategy` (NIFTY and SENSEX),
`RecommendationStrategy`, `NiftyChangeStrategy` and `MomentumAtFixedTimeStrategy` (all on `LimitEntryStrategy`).
The earlier prototypes (`BiDirectionStrategy`, `DiffStrategy`, `PivotStrategy`,
`HighLotStrategy`, `TestStrategy`, `ORBPrevious`) were deleted in commit `9765032`. `Minutes5Decision` was deleted there too and revived
as `MomentumAtFixedTimeStrategy` (see its section).

**Global settings and per-strategy overrides.** `settings` in config.yml holds only strategy-agnostic values (`minPrice`, `maxPrice`, `targetPoints`, `stopLossPoints`, `trailingDistance`, `cooldownSeconds`, `logQuotes`, `maxDailyDrawdownPercent`, `maxWeeklyDrawdownPercent`, `skipNearestExpiryOnEve`, `skipNearestExpiryOnExpiryDay`, `eodCloseTime`). A strategy overrides one by setting the same key on its own block; absent there, the global value is used (`settingFor`, `Strategy.setting(key)`; the legacy strategies' `cooldownSeconds` and the order executors' target/stop points follow this). `maxDailyDrawdownPercent` / `maxWeeklyDrawdownPercent` are account limits for real users only, never applied to a strategy instance (`bookkeeping.isStrategyUser`); strategies have their own stops. The gap-screener cover order keys live on the `GapStrategy` block (`coverOrderEnabled`, `coverOrderUserEmail`, `coverOrderQuantity`, `coverOrderStopLossPoints`).

**End-of-day close time.** `settings.eodCloseTime` (`'HH:mm'`, config ships `'15:50'`) is the one end-of-day close for every strategy (Continuous, SupportResistance, Hourly, SimpleContinuous, Butterfly, BulkPcr, and NiftyChange / MomentumAtFixedTime / Recommendation via `LimitEntryStrategy`), read through `util/eodClose.ts`. Unlike the other global settings it is NOT overridable per strategy: a strategy block that carries `eodCloseTime` is rejected by `configValidation`. When the setting is missing or invalid each strategy falls back to its own default (15:10; BulkPcr and Butterfly 15:15). A time after the trading window (~15:25-15:30) means no end-of-day close happens at all: positions are carried overnight and, outside the window, no strategy is delivered ticks or fills, so they are unmanaged (resting day sells lapse; Kite GTTs persist).

**Profit cooldown.** `profitCooldownSeconds` (Continuous, SupportResistance, BulkPcr; default 0 = locked for the day, the old behaviour) mirrors `lossCooldownSeconds`: after a `maxProfit` trip the lockout is released that many seconds later, once the strategy (or the broker, for BulkPcr) is flat, and the profit target restarts from the P&L at that moment, so the profit that tripped it is not counted again. It survives a restart (Mongo `strategyLatches` for LegManager, the BulkPcr state doc). A BulkPcr loss lockout waits for a pending profit release instead of giving up for the day.

**Target and stop-loss (global, overridable).** `settings.target` and `settings.stopLoss` in config.yml are the default exits for every strategy
that uses them (today RuleBasedStrategy and MomentumAtFixedTimeStrategy; the others keep their own, see `open-review-items.md`). Each takes
points (`10`), a percentage of the entry price (`"5%"`), or `none`. A strategy block can set the same key to override the global value, with the
same formats (`stopLoss: none` gives a strategy no stop). `settings.maxHoldTimeMinutes` is the same kind of global setting for the timeout (minutes, or `none`), applied to RuleBasedStrategy; it closes winning and losing positions alike. A value absent in both places stops that strategy from trading, with an ALERT: an
unset stop is never read as "no stop". Helper: `src/strategy/exitRules.ts`; validation: `src/prism/configValidation.ts`.

**Expiry-eve filter.** `settings.skipNearestExpiryOnEve: true` (default false) makes every contract master resolve the NEXT expiry on the trading day before the nearest one (`util/expirySkip.ts`); entries and strike-based sell re-resolution both follow it, so one day never mixes two expiries. An explicit expiry/offset is never changed. `settings.skipNearestExpiryOnExpiryDay: true` does the same ON the nearest expiry's own day (ANT's option chain follows it too, via `AntContractMaster.nearestExpiryIndex`); added 2026-11-09 so SimpleContinuous and MomentumAtFixedTime trade next week's contract on expiry day. The setting is the default for every strategy; a strategy block may set the same key (`skipNearestExpiryOnExpiryDay: true|false`) to override it for its own lookups. Underneath, every contract lookup takes an optional `skipNearestExpiryDay` argument (contract masters, `pickContractByPremium`, `BrokerExecutor.resolveContract/getContractByPriceRange`, the `getContractByPriceRangeBare` / `resolveOptionContract` IPCs, `LegBrokerOps.pickContract`): true = next expiry on expiry day, false = never, undefined = the setting; `expiryDayOverrideOf(block)` reads it from a block. Wired in SimpleContinuous, MomentumAtFixedTime (via LimitEntry) and every LegManager strategy; other strategies follow the setting until they pass it. **Breeze honours the argument too, and its tsym carries the expiry (2026-11-09).** A Breeze trading symbol used to be `NIFTY24950CE` with no expiry, so the 09-Nov and the 17-Nov contract of one strike were one key (a restart reconcile mixed them and a strategy bought a second CE). It is now `NIFTY09NOV2624950CE` (`breezeTsym` / `parseBreezeTsym` / `breezeLegacyTsym` in `src/breeze/BreezeContractMaster.ts`; DDMMMYY, upper case; SENSEX stays `SENSEX...`). Every Breeze order path resolves the contract from the tsym's own expiry (`resolveBreezeContract` in `breezeExecutor.ts`); the pick (`getContractByPriceRangeOnBreeze`, `resolveContract`) prices from the ANT chain of the requested expiry (the per-block `skipNearestExpiryOnExpiryDay`). The old expiry-less form is still read everywhere (state and Mongo rows written before the change): it resolves through the leg's ANT token, and the restart reconcile (`reconcileBreezePositions`) matches fills under either spelling and splits them by the position's contract tokens. `getLiveNetQuantity`, `squareOffOnBreeze`, the lock-profits price map and the pending-order trackers are keyed by the exact tsym. Deploy note: restart only when Breeze is flat or the open legs were opened after the change; a leg opened under the old spelling and still open at the restart gets its sell fill booked under the old tsym while the restored row carries the new one.

**BulkPcr 2026-11-02 additions.** `maxRebuysPerSlot` (optional, default unlimited) caps re-buys of a side per cycle; `maxLossPerOrder` is taken of the CONFIGURED cap, not the loss-trip-cut one; the first hedge buy is exempt from the investment cap (as a hedge re-buy is); a hedge top-up re-sizes from the broker's margin message up to 3 times and updates `entryQuantity`.

**Brokers and the per-broker amount (2026-11-02).** Every strategy block takes `brokers: [kite, ant, breeze]`
(default `[kite]`); the single `broker:` key is REMOVED (ConfigService logs a one-time warning and ignores it).
**The amount is per broker:** `maxInvestment` is what EACH listed broker trades with, and
`maxInvestmentByBroker: {ant: 70000}` overrides one broker (helper `investmentForBroker`, `prism/configVocabulary.ts`).
Two ways a block fans out over its brokers:
- `BulkPcr`, `BulkPcrAutoStart`, `Hourly`, `Butterfly`, `TopStock`, `Recommendation`, `NiftyChange`, `MomentumAtFixedTime`, `NextWeek`, `Breakout` fan out inside one
  instance (`configuredBrokersOf`); the order-side cap is per (user, broker) (`maxInvestmentByBroker`).
- Every other type (Continuous, SupportResistance, Sentiment, RateOfChange, Gap, RuleBased, GoodMorning*, TargetReach) is
  expanded in memory into ONE INSTANCE PER BROKER (`util/strategyInstances.ts`, `expandBrokerInstances`): kite keeps the
  base `userId`, the others get `<base>-ANT` / `<base>-Breeze` (so existing Mongo state and trade history carry over;
  RuleBased composes: `RuleBased`, `RuleBased-ANT`). Each child gets a derived internal `broker` (never written to
  config.yml) and `maxInvestment` = its broker's amount, so each broker has its own legs, maxProfit/maxLoss and cooldown.
  Children are independent signal evaluators, so entries on different brokers can differ by seconds. Changing `brokers:`
  needs a restart (a config reload refreshes configs but creates no new instances). Look instances up through
  `configService.getInstances()`, not `getConfig().strategies`, when keying by `userId`.

**`prism` (Shoonya) as a broker (2026-11-04).** `prism` is accepted in `brokers: [...]` of the strategies that trade through the generic
order family: `SimpleContinuousStrategy` (instance id suffix `-Prism`), `NiftyChange`, `MomentumAtFixedTime`, `Recommendation`. Not
`TopStockOptionsOpeningGapStrategy` (its broker union is kite/breeze/ant only; it drops `prism` with an ALERT). Needs a Shoonya login
(`scripts/login.sh prism`) BEFORE the post-login restart: `brokerSessions` now reports `prism`, and one enabled strategy listing it keeps
every strategy idle at startup until that login is valid, same as ant/breeze. Prism positions are restored from Mongo like every other broker's (no
login needed for the restore; the end-of-day sync reads Prism's order book and positions when a Shoonya session is valid). Bare buys
(`marketBuy`) go through `buyOnPrism`: a limit at the option LTP with a polled, cancel-and-recheck fill. Prism has no post-fill
target/stop primitive (`attachProtection` refuses it), so NiftyChange falls back to a resting target sell plus a tick-driven stop.
`PrismContractMaster` carries no lot size, so sizing from a rupee budget uses the NIFTY lot size (65).
`ContinuousStrategy`/`SupportResistanceStrategy` pass the derived broker to `brokerLegOps(() => cfg.broker)`; the
`tokenRouter.resolveSource` feed choice reads it too (LegManager strategies always use the ANT feed, since their legs carry
ANT tokens: `Strategy.legTokenFeed`).

## Shared infrastructure

### `strategy.ts` — the `Strategy` base class
- `processNiftyQuote`/`processOptionQuote`/`receive` are abstract — every
  strategy implements its own entry trigger here.
- `canHandleOptionQuote(quote)` (default `false`, `strategy.ts:122-124`) gates
  whether a strategy's `processOptionQuote` gets called at all for a given
  tick — routing happens one level up, not inside the strategy.
- `wantsFutQuotes()` (default `false`) / `processFutQuote(quote)` (default no-op): NIFTY-future ticks (`FutQuote`, price + volume + VWAP) are dispatched
  only to a strategy that returns true (BreakoutStrategy); `strategiesProcess.onTick` handles `tick.type === 'fut'`.
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
**Re-buy is a resting limit, not a market buy**: a re-buy after a +2 fill (not the
first buy, not the hedge-opening buy) is a limit buy of the *same contract* at its
average sold price (`rebuyLimit`, set in `onSlotSoldOut`), split into freeze-quantity
chunks via `placeLimitBuyBare` (`placeRestingRebuy`). The slot sits in phase
`'resting'` (holds nothing, counts as active for the cycle but not as a hedge for
the other side). Fills arrive through `updateTrade` (`onRebuyFill`); once the whole
quantity fills, `completeRebuy` rests the normal +N exit. It rests until it fills, or
the other side is no longer open / the broker is stopped / EOD - then
`settleRestingRebuy` cancels it (`cancelRestingLimitBuys`), reads back what filled from
the broker and exits that part (nothing filled = the side stays out for the cycle).
`sweepRestingRebuys` (run from `finishIfFlat`) triggers that. `reconcile()` settles a
persisted `'resting'` slot the same way on restart.
**Drift re-place**: each tick of the resting contract (`checkRebuyDrift`) compares its LTP with the limit; once it is more than
`driftCancelPoints` (BulkPcrStrategy config, default 10, 0 = off; the same key also cancels the rest of a chunked entry buy that price runs away from, as in Hourly) above it, the limit
would never fill. If the hedge is still needed (the other side is held and its last tick is still below its entry, no stop/EOD)
the limit is cancelled and a new one is rested at the current price for the still-unbought quantity (`replaceRestingRebuy`;
what already filled is carried, not re-bought). No cap on re-places. If the hedge is no longer needed the re-buy is cancelled
and the side stays out (`settleRestingRebuy`).
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
`targetPoints`, `driftCancelPoints`, `right` (`call`/`put`/`none`),
`maxInvestment`, `logEnabled`, `slDistance` (ANT pair trigger, default 10), `maxLossPerOrder`, `maxProfit`, `hedgeTrailDistance`, `hedgeTargetFraction`.
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
Only the admin `POST /strategies/BulkPcrStrategy/reset` clears it, or the local day rollover. The auto-start
re-arm (`reset({ keepStops: true })`) keeps the lockout. The admin reset takes `?userId=BulkPcr-NIFTY` to reset one instance
(default: every instance of the type) and keeps the day's realized P&L unless `?clearPnl=true` (2026-10-30).
No `maxLossPerOrder` (or 0) = off. A `maxLossPerOrder` without a usable `maxInvestment` fails config validation.
**Cooldown and per-broker investment (mandatory BulkPcr keys, added 2026-10-29)**: `maxInvestmentByBroker` (map broker -> rupees; keys may use
an alias such as `zerodha`) is each broker's investment cap, enforced per (strategy, broker) in the order process (`bookkeeping.getUserMaxInvestment(user, broker)`)
and the base of that broker's `maxLossPerOrder`/`maxProfit` percentages. Each `maxLossPerOrder` trip cuts the tripped broker's cap by
`lossInvestmentCut` (cumulative for the day, pushed to the order process by `setBrokerInvestmentCap`, reset at the day rollover or an admin reset) and,
after `lossCooldownSeconds`, releases that broker's loss lockout (`PnlStop.release`, both orders) so the next entry / auto-start slot can use it again;
nothing is re-entered by the release itself. Not released: a `maxProfit` lockout, a broker whose cut cap is <= 0, an unreadable latch, or while the broker
is still opening/closing (checked every 5 s). `lossCooldownSeconds: 0` keeps the lockout for the day. The cut and the release time are in the state doc
(`cutsByBroker`, `lossCooldownUntil`), so a restart resumes the cooldown. Known gap: if only the order process restarts, its cut is lost until the strategy next calls `loadStopLatches` (the next auto-start slot or a reconcile).

**Hedge trail exit (`hedgeTrailDistance`, points, optional, ships unset = off)**: applies to the hedge leg (the side
opened by the `slDistance` trigger) only; the root leg keeps its fixed `targetPoints` resting sell. With it set, the hedge
has **no resting sell**. Its target is `ceil(d * hedgeTargetFraction)` points above its entry (`hedgeTargetFraction` defaults to 0.5, i.e. `ceil(d / 2)`; 1 = the full loss of the leg it covers), where `d` is how far the other leg was below its entry when the hedge buy started (CE bought at 100, hedge opened at 90 -> 5; after that hedge closes, a new one opened with CE at 80 -> 10); `slDistance` is the fallback if that price is unknown. Reaching the target
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

### RecommendationStrategy / NiftyChangeStrategy (`RecommendationStrategy.ts`, `NiftyChangeStrategy.ts`, shared engine `LimitEntryStrategy.ts`) — config: `enabled: false`
Two simple limit-entry strategies. Both place a LIMIT buy (`placeLimitBuyBare`) on **every** broker in `brokers:` (each broker buys with its own full `maxInvestment`, not a split), size whole lots from the rupee budget (above one freeze quantity the entry is split into several resting limit buys at the same price, one per freeze-size chunk, tracked per order id), persist their state to `.<Type>.<userId>.json` (a restart never places the same entry twice), cancel an unfilled entry at `settings.eodCloseTime` (and after `entryTimeoutMinutes` when set) and close a held position at `eodCloseTime` (default 15:10).
- **RecommendationStrategy** — one analyst recommendation per config block: `contract: '22750 CE'`, `entryPrice`, `targetPrice`, `stopLoss` (absolute option prices), `maxInvestment` (per broker), `entryOffset` (default 5). Order goes in at `entryPrice - entryOffset`; after the fill the target/stop are attached via the `attachProtection` order-process call (`order/attachProtection.ts`): **kite** = two-leg GTT (falls back to the in-app exitMonitor if the GTT call fails), **ant** = in-app exitMonitor (a bracket/cover order must be the entry order itself, it cannot be attached to a filled one), **breeze/other** = resting limit sell at the target + a tick-driven market stop in the strategy. Changing the contract/prices of a block is a new recommendation; the same one is never placed twice in a day. A recommendation that arrives while a trade is still open (order or position) is dropped and never picked up later. When the cycle ends (bought and sold, or the entry cancelled with nothing filled) the block is written `enabled: false` to config.yml, so nothing trades it again. Set a new one with the `recommend` skill (`.claude/skills/recommend/SKILL.md`: `recommend [INDEX] <strike> <CE|PE> <entry> <target> <stop>`). Breeze's REST API does have GTT (`POST /breezeapi/api/v1/gttorder`, `gtt_type: cover_oco`) but it is not wired in yet.
- **NiftyChangeStrategy** — at each `times` slot (BulkPcrAutoStart's rules: once per slot per day, never a slot before process start, 5-minute late window), Nifty's move is `ltp` at this slot − the reference from the live tick: the LTP seen at the previous slot today (held in memory, lost on restart), or the previous close for the day's first slot. A slot with no reference (earlier slot today not recorded) is skipped with an ALERT. The reference is kept in the strategy's state file for the day, so it survives a restart (2026-10-30). With `catchUpMissedSlot: true` the latest slot that came due before a restart (within the 5-minute window) still fires, subject to the same running-position and reference checks; older missed slots are skipped. Up → CE, down → PE, flat → skip. A move smaller than `minMovePoints` (config ships 10; 0/unset = any non-zero move) is skipped, like a flat one (2026-11-04: the 1.95-point 12:40 entry lost). Strike from `AntContractMaster.entryStrike`; limit = option LTP (ANT quote) − `limitOffset` (default 0, i.e. the LTP itself; config ships 0 - a limit below the market filled only on a dip, and all four of 2026-11-04's fills reversed to the stop); on the fill a resting limit sell at fill + `targetPoints` (default 5 in config). Stop loss: `stopLossPercent` (config ships 10%; `none` or omitted = no percentage stop: stop = fill × (1 − 10%) when set) wins over `stopLossPoints` (kept in config, used only when no percent is set; optional `maxLossPerLeg` rupee cap; helper `entryStop.ts`) is attached after the fill with the target via `attachProtection` (kite GTT, ant exitMonitor, breeze resting sell + tick stop); without it only the target sell and the `settings.eodCloseTime` close exist. Skips a slot while the previous slot's position is still open. Config: `times`, `maxInvestment` (per broker), `minMovePoints`, `limitOffset`, `targetPoints`, `stopLossPercent` / `stopLossPoints`, `entryTimeoutMinutes`.
Test: `node dist/test/limitEntryStrategies.test.js` (stubbed OrderClient).

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
   config key (`targetPoints`, `driftCancelPoints`, `right`,
   `maxInvestment`, `logEnabled`) is left exactly as already set in its own
   block — only `quantity`/`brokers`/`enabled` are overwritten.
**Config keys** (`config.yml`): `enabled`, `times` (array of `HH:mm`
strings), `quantity`, `brokers` (array, written onto `BulkPcrStrategy`'s own
config when armed), `catchUpMissedSlot` (default off).
**Restart catch-up** (`catchUpMissedSlot: true`, added 2026-10-30): a slot earlier than the process start is normally skipped. With the
flag, the single LATEST slot that came due before the start, and only if it is within 5 minutes, is armed through the normal
`attemptStart` guards: the durable armed-slots record (a slot that already ran is never redone), the target not running or in a broker
error (so no earlier slot is still open), the loss-stop / latched-broker filter, and `enabled`. Older missed slots are skipped for good.
Log line: `CATCH-UP: <slot> slot came due at ...`.
**Stuck error state**: before reporting `STUCK`, an auto-start calls `target.recoverFlatErrors()` - an `error` slot whose contract is flat at
the broker (live quantity 0, no pending sell) is cleared, a possibly-live-remainder latch is not. A `[NOT_PLACED]` refusal (investment cap,
not connected) of a buy is a definite refusal and no longer latches `error`. The STUCK alert is logged once per cause.
**Hedge re-buy and the investment cap**: a BulkPcr re-buy after a +2 target hit (and a hedge top-up) is sent with `hedgeRebuy`, so the order
process skips only the max-investment gate for it (`bookkeeping.canPlaceOrder(..., skipInvestmentCap)`, strategy pseudo-users only).
**Margin-shrunk hedge top-up**: when ANT rejects a hedge buy for margin and the one smaller retry fills, the missing lots are remembered
(`topUpQty`) and bought later on the SAME contract (`topUpSlot`, every 30 s, at most 3 attempts) while the sibling is open: the resting sell
is cancelled (fills booked), the lots bought, and ONE resting sell re-placed for the blended entry. Trailing hedges are not topped up.
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

### SimpleContinuousStrategy (`SimpleContinuousStrategy.ts`)
**Entry**: ONE root per day: PCR direction (>1 PE, else CE; re-fetched every 5 min), `initialQuantity` at market, gated by `maxInvestment` (per broker; the hedge and the double-up are not). With `onePositionPerSide: true` `initialQuantity` is ignored: the root buys as many whole lots (65) as `maxInvestment` pays for at the picked premium, capped at the NIFTY freeze quantity (1755); the hedge still buys the root's quantity. After it every order is a hedge or a double-up. **First order at a profit (2026-11-13):** when the root's sell fills at a profit and no hedge was ever needed (`!hedged`, nothing else open), it does NOT buy the same direction again: the leg is marked `restarted`, the one-root gate opens and the next Nifty tick runs the contract selection (PCR direction, premium floor, ATM pick) for a fresh root, so a day can hold several roots, one after another. A root that already had its hedge, and every hedge leg, keeps the old rule (profit -> the same right again, loss -> the opposite).
**Exit**: right after each fill a resting limit sell at entry + `priceDiff`. No stop loss.
**Hedge (once per leg, unlimited chain)**: every leg, root or hedge, is hedged once by buying the opposite option at the strike nearest the money (ATM) for the same quantity when the leg falls to entry - `priceDiff`, or when its sell fills (target met). The hedge leg gets its own resting sell and is hedged once in turn (root CE -> hedge PE -> hedge of that PE = CE -> ...). Hedge buys ignore `maxInvestment`.
**Double-up (once per leg)**: when a hedge leg's sell fills at a profit and the leg that caused it (its parent) is still open, the parent's contract is bought again for the parent's quantity (`maxInvestment` does not gate it, 2026-11-11: with `onePositionPerSide` the root costs about the whole budget, so the cap check could never pass; still once per leg, and `maxProfit` is the only brake) and its sell re-placed for the new total at the new average + `priceDiff`. The `doubled` flag is set only when the double-up really happens (2026-11-04): a skip (failed cancel of the resting sell, refused buy) leaves the parent `doubleDue` and its own option ticks retry it every 30 s while it is open  A double-up buy that may be live is never retried (flag set, manual review).
**maxProfit (2026-11-09).** When this broker's total P&L, CE and PE legs together (realized fills since counting started + each open leg valued from its reference price at its last tick), reaches `maxProfit` rupees, the log prints `MAX PROFIT TRIPPED` (a `!!!` line in the alerts feed), every open leg is closed by a LIMIT sell that locks the cap (2026-11-13; the trip is judged on the last tick, the exit never dumps at the bid: 10:53 the old cancel-and-sell-at-the-bid booked 4732 on a 5044 trip of a 5000 cap). Per leg, `clearPrice` = tick-rounded-up `pnlRef + (cap - realized - the other open legs' gain) / remaining` (other legs counted at their resting-sell price, else their last tick; `src/strategy/maxProfitLock.ts`). The resting sell is ALWAYS reset to it (user's rule, 2026-11-13 12:14: 65 x NIFTY26N1725100PE bought 144.25 sat at 154.25, above the 151.20 clear price, and the cap stayed unlocked): only a sell already exactly at `clearPrice` is left alone (so retries never churn), one above or below it (or none) is cancelled (confirmed at the broker: a failed cancel places nothing, a cancel that saw part of it fill places nothing until the next pass re-prices what is really left) and one limit sell for the unsold quantity is placed at `clearPrice`; with several legs each leg's price counts the others' real exit prices and the prices only ever move down, so passes converge in two or three rounds; the leg stays open until that fills, so the booked total is at least `maxProfit` whenever it does. It is re-evaluated from Nifty ticks every 5 s (idempotent: it runs for an already tripped strategy on every Nifty tick pass, no trip event needed, so a restart or a code load re-prices a restored resting sell from the next tick; a reconcile places nothing); a leg still waiting for its reference tick is skipped. There is no automatic drop to the bid: if price falls through `clearPrice` and never returns the leg stays open until the EOD close (which still cancels and sells at the bid). No new root, hedge, double-up or resting sell is placed for the rest of the day; the trip is persisted in the state file (`profitTripped`, `realizedPnl`), so a restart stays idle. Counting starts at the first load of a state file that has no `pnlStarted` field, or at `reset()`; a leg that was open then is valued from its first tick after it (`pnlRef`), so earlier P&L does not count. Re-arm: `POST /strategies/SimpleContinuousStrategy/reset` (or delete the day's state file when flat).

**Stacking limits (two modes)**: (1) `onePositionPerSide: true` (flag, default off, ships ON in config.yml, added 2026-11-09): at most one open CE and one open PE at a time (they may coexist). A hedge for a side that already has an open leg (or a hedge buy in flight on it) is not placed: the leg stays un-hedged (`hedgeWaiting`) and is retried from Nifty ticks every 5 s until that side is free, open legs and closed ones alike. The double-up adds to the SAME contract, so it is unaffected. `maxLegsPerSide` is ignored in this mode. (2) Without the flag, the older stacking guard (`maxLegsPerSide`, optional, config ships 5): a new leg (hedge) on a side that already has `maxLegsPerSide` open legs waits until Nifty has moved back toward the root by `stackRecoveryPoints` (default 20) from the most adverse Nifty level at which an open leg on that side was bought (`niftyAt`: CE side needs Nifty that far above its lowest, PE side that far below its highest). The leg stays un-hedged (`hedgeWaiting`); an open leg is retried by its own ticks, a closed one from Nifty ticks every 5 s. Adopted legs have no `niftyAt` and never block. Unset = no limit.
**Unconfirmed hedge buy**: a hedge buy that times out is resolved against the broker instead of latching manual review at once: the resting buy is cancelled (`cancelRestingLimitBuys`) and the live quantity read (`getLiveQuantity`). Nothing held -> the hedge flag is cleared and the hedge retried on the next tick; held -> adopted as the hedge leg (price from the broker's open trades) with its resting sell; cancel failed or broker unreadable -> manual review as before. A refused (`[NOT_PLACED]`) buy simply retries.
**State**: `.SimpleContinuousStrategy.<userId>.json` (per day); `reconcile()` checks it against the broker's open trades and pending sells and adopts unknown positions (never doubled). EOD close at `settings.eodCloseTime`.
**Backtest**: `npm run backtest:simpleContinuous [-- --allDays <dir> --verbose --maxProfit N --priceDiff N --maxInvestment N]` (`src/tools/SimpleContinuousBacktest.ts`, default dir `~/later/data/backups`, needs `Quote.csv`, `OptionQuote.csv` and `Pcr.csv` per day). Replays ticks through the real class with a broker mock: buys fill at the last tick price, a resting sell fills at its limit on the first tick at or above it, `Date.now()` is the tick time, PCR is the latest `Pcr.csv` row, nothing closes at EOD (open legs are reported at their last price). One simulated broker; optimistic (no slippage or spread).
**Config keys**: `enabled`, `brokers`, `initialQuantity`, `maxInvestment`, `priceDiff`, **`maxProfit`** (REQUIRED, an amount in rupees, per broker; no default in code, a missing / non-positive / `%` value is rejected by the config validator and blocks entries), optional `onePositionPerSide`, `maxLegsPerSide`, `stackRecoveryPoints`; a leg whose sell fills at a profit is always followed by the SAME right (root and hedge legs), an adverse-move hedge or a sell at a loss buys the opposite right (fixed, not configurable). The root premium floor (100) is a constant in the file.

### ScaledHedgedStrategy (`ScaledHedgedStrategy.ts`)
A separate class derived from SimpleContinuousStrategy (registered in `StrategyFactory`; the config.yml block ships `enabled: false`, `brokers: [kite]`, `initialQuantity: 65`, `maxInvestment: 200000` per broker, `priceDiff: 10`, `maxProfit: 20000`; same required keys and `maxProfit`-in-rupees rule as SimpleContinuous; state file `.ScaledHedgedStrategy.<userId>.json`). Rules: (A) the root buys `initialQuantity`, not the whole `maxInvestment`; (B) a hedge buys `initialQuantity + (leg entry - leg price now) / priceDiff * initialQuantity` in whole lots (a CE down 10 gets a PE of 2 x initialQuantity; a hedge after a target fill buys `initialQuantity`); (C) no double-up: a leg that falls by `priceDiff` makes the opposite contract be bought again; (D) one CE contract and one PE contract per cycle (the root's, and the first hedge's ATM pick, kept in `state.pair` and subscribed while they have no open leg): every later buy of a right uses that contract, ADDED to its open leg (the resting sell is cancelled and re-placed for the whole quantity at the new average + `priceDiff`, the leg's hedge trigger re-armed from the new average) or a new leg if it is closed; (E) the first-order rule of SimpleContinuous (a root that made its target with no hedge restarts the contract selection); (F) `maxInvestment` is honoured by every buy (root, hedge, add; the order process enforces it too, no `hedgeRebuy` exemption): a buy is cut to the whole lots that fit, or held back (`hedgeWaiting`) and retried when none fits; (G) a same-direction re-buy is skipped when that contract already has an open leg. `onePositionPerSide` is not a setting of this strategy: it ALWAYS keeps one open leg per side (the key in the block is ignored), because one CE and one PE contract per cycle means one leg per right and the in-flight-buy guard is what stops a re-buy and an opposite-leg hedge from creating two legs on one contract. The ladder grows quantity on every adverse move, so only `maxInvestment` and `maxProfit` bound it: the 2026-11-13 backtests (Nov-02/04/05/06/12 ticks, before the cap) hit the 20k `maxProfit` stop every day with intraday drawdowns up to -125.6k and open-leg cost up to 26 lakh; Nov-06 with the 200000 cap: +20.9k, lowest -20.9k, peak open cost 1.94 lakh. Tests: `node dist/test/scaledHedged.test.js`. Backtest: `npm run backtest:scaledHedged [-- --initialQuantity 65 --maxInvestment 200000 --only Nov-06 --out file.html]` (one HTML row per buy with the leg's running count / quantity / average / resting sell; `backtest-ScaledHedged-Nov06.html` is the Nov-06 run).

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

### RuleBasedStrategy (`RuleBasedStrategy.ts`, indicator names in `ruleIndicators.ts`)
**Entry**: driven by `receive(oldStats, newStats)` on the live 5-minute NIFTY candle stats (`processes/strategies/niftyStatsBuilder.ts`), not
quote ticks; `processNiftyQuote` is a no-op. One `type: RuleBasedStrategy` block is ONE strategy. Its `indicators` list holds rules, one per
item: commas inside an item join indicators that must all agree (or a majority with `requireAllIndicators: false`). Any rule that fires
buys; rules that disagree on the same candle (one UP, one DOWN) give no trade. One position at a time. Trades only 10:00-15:00.
**Indicators** (a name must be one the live builder computes, see `lib/indicator-config.ts`; an unknown or uncomputed name makes the rule
refuse to trade with an ALERT, and config validation rejects it):
- `RSI_p_ob_os`: above overbought → DOWN, below oversold → UP
- `RSI_p_ob_os_REV`: contrarian RSI with the same parameters, trend inverted (`calcRSIReversed`, stats key `rsiReversed`)
- `MACD_f_s_sig`, `EMA_s_l` (crossover), `Bollinger_p_dev`, `ADX_p` (NEUTRAL under ADX 20), `Stochastic_k_d` (`Stoch_k_d` also accepted)
**Exit**: `target` and `stopLoss` from the global settings or the block's override (see "Target and stop-loss" above), in points or as a percent
of the average entry price, checked on the option ticks of the held contract. On each tick: timeout first (`maxHoldTimeMinutes`, 0 = off), then
target (sold as `win`), then stop (sold as `loss`). The levels are fixed when the buy fills and recomputed if a freeze-split chunk changes the
average. The strategy sells at the tick price (`sellContract`); no resting broker order is placed for either exit.
**Sizing**: fixed `quantity` per rule.
**Config keys**: `enabled`, `indicators`, `quantity`, `target`, `stopLoss`, `maxHoldTimeMinutes`, `requireAllIndicators`, `cooldownSeconds`,
`logEnabled`. The old `targetProfitPercent`, `stopLossPercent`, `targetPoints`, `stopLossPoints` keys are ignored (ALERT at startup).
**RuleBasedStrategy: previous rule set** (replaced 2026-11-11 by `Bollinger_5_1` and `MACD_4_8_3`; restore by pasting these under `indicators:`).
Each line is one rule; the comma joins indicators that must all agree. Chosen from `backtest-results/ruleblock-final`. The live candle builder only has
closes since the process start (no backfill), so slow indicators need a long warm-up after a restart (`MACD_16_32_12` needs 44 five-minute closes):
```
- MACD_4_8_3, Bollinger_25_1.5
- EMA_9_21, Bollinger_5_1
- MACD_4_8_3, MACD_16_32_12
- MACD_4_8_3
- Bollinger_20_1
- MACD_16_32_12
```

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

### MomentumAtFixedTimeStrategy (`MomentumAtFixedTimeStrategy.ts`, on `LimitEntryStrategy`) — config: `enabled: false`, multi-broker
Revived from the deleted `Minutes5Decision` prototype (commit `9765032`). At each `times` slot (same slot rules as NiftyChange: once a day per
slot, never a slot before process start, 5-minute late window, no catch-up), it trades only when two signals agree:
1. **Order-book surplus**: `tbq - tsq` (ANT depth ticks, read with `MomentumSignal.readDepth`) on the CE at `ceil(spot/50)*50` and the PE at
   `floor(spot/50)*50`. The contract with the larger surplus must be positive; its side gives the direction (CE = up, PE = down). A tie, a missing
   reading or no positive surplus means no trade.
2. **Price move** since the previous slot today (Nifty LTP now minus the LTP recorded at the previous slot) must match the direction: a rise for CE,
   a fall for PE, and its size must reach `minMovePoints` (config ships 10; 0/unset = any move; 2026-11-04: all six winners followed moves of 14-59
   points, the one loser 1.95). The first slot of the day has no previous slot and never trades.

Entry: one LIMIT buy per broker at the option's prevailing LTP (`getOptionLtp`, no offset). Quantity is computed at runtime from `maxInvestment`
(per broker, `investmentForBroker`) in whole lots, split into freeze-size limit buys when above one freeze quantity. There is no `quantity` key (the validator rejects one).

Exit: `target` (global or block override: points above the fill, `N%` of the fill, or `none`) sets a resting LIMIT sell at fill average +
target for the whole filled quantity, placed as soon as the entry fills (`placeExit`, exit kind `resting`); a fill that lands later is sold by an
extra resting sell at the same level (`topUpExit`). `stopLoss` (points below the fill, `N%`, or `none`) adds a stop: with a target, the stop goes
in together with it via `protectLeg` (Kite GTT, ANT exitMonitor, Breeze/Prism resting sell + tick stop); with no target, the stop is watched on
ticks alone (exit kind `self`). With neither, the position leaves only at the EOD close at `settings.eodCloseTime` (exit kind `none`). The
shipped config sets `target: 5` and `stopLoss: none` on the block (the behaviour before the global exits). If a placement fails, the housekeeping
retry places it again. For reference, 2026-11-04's winners' worst dip below entry was 21%, the loser's 37%. An unfilled entry is
cancelled after `entryTimeoutMinutes`. (Until 2026-11-03 the sell was deferred until a tick reached the target; `deferTargetExit` stays in
`LimitEntryStrategy` and a leg saved with exit kind `target` still follows that path.)

One position at a time: a slot is skipped while any leg is open (`isRunning()`), and that slot is consumed.

Logging: Nifty's up / down / flat counts since the previous slot are logged at every slot. They are **sampled** once per `upDownSampleMinutes`
(default 1): the current LTP against the previous sample, so a 10-minute slot holds about 10 samples (since 2026-11-04). Counting every delivered
tick (the old way) gave ~5,400 per slot because ups + downs is essentially the tick count (5,466 against 5,482 ticks stored for 10:00-10:10; only
flat ticks and a few at the slot edges are missing), with a near-constant 51-54% downs share. They are in memory only and are not used for any decision.

Config keys: `times`, `maxInvestment`, `minMovePoints`, `target`, `stopLoss` (block overrides of the global exits), `upDownSampleMinutes`, `entryTimeoutMinutes`, `index` (NIFTY), `brokers`. The old `targetPoints`, `stopLossPercent`, `stopLossPoints` and `maxLossPerLeg` keys are ignored (ALERT at startup).
Test: `node dist/test/momentumAtFixedTime.test.js` (stubbed OrderClient and depth read).

### NextWeekStrategy (`NextWeekStrategy.ts`, on `CandleEntryStrategy` -> `LimitEntryStrategy`) — config: `enabled: true`, multi-broker
15-minute NIFTY candles, a 50 EMA trend and the breakout-candle pattern, traded on the **next-week expiry** (`expiryOffset: 1` through
`resolveOptionContract`; an explicit offset is never bumped by `skipNearestExpiryOnExpiryDay`). When a candle closes, two signals are computed:
1. **Trend** (`sideVsAverage`): the closed candle's close above the 50 EMA = `call`, below = `put`, equal = none. `seededEMA(closes, 50)`, valid only with
   at least 50 closed candles.
2. **Breakout** (`BreakoutData.from(c1, c2)`, `lib/breakoutData.ts`, shared and pure): c2 closes above its own open AND above c1's high = `call`;
   below its own open AND below c1's low = `put`; otherwise none.
Both must give the same side: one LIMIT buy per broker of the ATM option (`round(NIFTY/50)*50`, CE for call, PE for put) at the option's prevailing
LTP, `quantity` units per broker (see `CandleEntryStrategy`: a fixed quantity, a whole number of lots, split above the freeze quantity), next-week
expiry. Otherwise it logs why and does nothing. One position at a time; a candle is evaluated once (persisted key `<day> <candle start>`), so a restart never
re-fires it.

Candles are the same `createStatsBuilder` the RuleBased strategy uses, with two additive options: `aligned: true` (buckets start on the IST quarter
hours, 09:15, 09:30, ...; the crossing tick starts the next candle; the default drifting behaviour used by every other caller is unchanged) and
`seed(candles)` (pre-loads history; the last seeded candle is the previous candle of the first live one). **History**: at the first tick of the day
the previous days' candles come from **Yahoo Finance** (`lib/yahooCandles.ts`, `^NSEI` 15m, 5 days, one call per trading day, cached in Mongo
`candles15Seed`; verified 2026-11-12: 126 candles, aligned to 09:15, index volume 0; Kite's historical API is not used, there is no paid subscription).
Yahoo is an unofficial keyless endpoint and can change or rate-limit without notice: a failed seed logs `ALERT: SEED failed`, retries every 60 s and the
strategy does not trade meanwhile. Today's own completed candles are stored in Mongo `candles15Live`, so a mid-day restart keeps them.

Guards, each logged as `-> no trade: <reason>` on every candle close (grep `[NextWeek:`): fewer than 50 closes (`warming up n/50`); c1 not the immediately
preceding candle of the same day (so the 09:15-09:30 candle never trades, the first possible entry is the 09:45 close); an incomplete candle (the first tick
arrived more than 60 s after the candle started, a restart mid-candle) is not traded and never used as c1; a candle that closed more than 5 minutes before the
tick that reports it is not traded late; `lastEntryTime` (default 15:00); a position still open; quantity not a multiple of the NIFTY lot (65).

Exit: `target` / `stopLoss` from the block, else `settings.target` / `settings.stopLoss` (the block ships without them, so the global exits apply; points, `N%`
or `none`), placed on fill exactly as MomentumAtFixedTime does (`protectLeg` with both, a resting sell with a target only, a tick stop with a stop only). With
`settings.eodCloseTime` at 23:59 there is no EOD close, so a position with neither exit would be held overnight. Config keys: `quantity`, `target`, `stopLoss`,
`lastEntryTime` (optional, default 15:00), `index` (NIFTY), `brokers`. An unfilled entry is cancelled after the global `settings.entryTimeoutMinutes`. Next-week options are less liquid than the nearest expiry: expect wider spreads.
Test: `node dist/test/nextWeekStrategy.test.js`, `node dist/test/candleLibs.test.js`.

### BreakoutStrategy (`BreakoutStrategy.ts`, on `CandleEntryStrategy` -> `LimitEntryStrategy`) — config: `enabled: true`, multi-broker
First-candle VWAP breakout. Only the day's first 15-minute candle (09:15-09:30) matters, no history. The index has no traded volume, so the candle AND the
VWAP both come from the **current-month NIFTY future** (the future trades at a premium over the index, so comparing an index close with futures VWAP would favour
PE every day). When candle 1 closes: its close **above** the future's VWAP = `call` (buy the ATM CE), **below** = `put` (buy the ATM PE), equal = no trade.
The ATM strike comes from the NIFTY index price, nearest expiry, `quantity` per broker, one LIMIT buy at the option's prevailing LTP; one trade a day, entered at the
end of candle 1. Exit as in NextWeek (`target` / `stopLoss`, block or settings).

**Candle 2 (09:30-09:45) never trades.** It exists to find out whether waiting for it would be better. At its close the strategy logs `BREAKOUT-CONFIRM` and stores one
document per day in Mongo `breakoutAnalysis`: both candles (OHLC), the VWAP at each close, the side candle 1 gave, the side candle 2's close gives against the VWAP, the
breakout-pattern side of (c1, c2), whether candle 2 confirms candle 1 (`confirmedByVwap`, `confirmedByPattern`), the option's price and P&L per unit at that moment
(`legsAtCandle2Close`) and, once the position is closed, its realised P&L (`finalExit`). After some weeks, compare days where candle 2 confirmed with days where it did
not to decide whether a confirmation entry is worth it.

**VWAP feed** (new 2026-11-12). The data process subscribes the nearest not-yet-expired NIFTY future (`AntContractMaster.findNearestFuture`, resolved on every
connect so it rolls by itself) and emits `type: 'fut'` ticks (`FutQuote`: price, cumulative volume `v`, `ap` = the exchange's average traded price, and our own
volume-weighted figure from the volume deltas, `lib/futVwap.ts`). The VWAP used is `ap` when present, else our own. ANT touchline updates are partial, so the data
process merges them. Delivered to strategies that return true from `wantsFutQuotes()` through `processFutQuote`. Whether `ap`/`v` actually arrive on ANT's future
touchline was NOT verified when this was written: the first live morning is the test. Log lines, all greppable with `VWAP-FEED`: the resolved contract at connect; the
raw fields of the day's first future tick; a heartbeat once a minute (`ap`, own VWAP, their difference, `v`, tick count), also stored in Mongo `vwapSamples`; `ALERT`
for no `ap` 60 s after the first tick, `ap = 0`, volume going backwards, or no future tick for 60 s while NIFTY ticks arrive. The own VWAP only covers volume traded
since the process saw its first future tick, so it equals the exchange's figure only when the data process was up from the open.

Guards (each logged as `-> no trade: <reason>`, grep `[Breakout:`): no VWAP, or one older than 2 minutes; close equal to the VWAP; an incomplete candle 1 (first future tick
more than 60 s after 09:15); candle 1 reported more than 5 minutes after it closed; no NIFTY index price in the last minute (needed for the ATM strike); a position
open; already traded today (persisted key, a restart does not redo it); `lastEntryTime`; quantity not a multiple of 65.
Config keys: `quantity`, `target`, `stopLoss`, `lastEntryTime` (optional, default 15:00), `index` (NIFTY), `brokers`; the entry timeout is the global `settings.entryTimeoutMinutes`.
Test: `node dist/test/breakoutStrategy.test.js`, `node dist/test/candleLibs.test.js`.

### CandleEntryStrategy (`CandleEntryStrategy.ts`) — shared base of NextWeek and Breakout, not a strategy
Extends `LimitEntryStrategy`: fixed `quantity` sizing (overrides `sizeOrder`; the validator requires a positive multiple of the NIFTY lot size 65 per broker for these two
types, and `maxInvestment` is not read), and the target / stopLoss exit copied from MomentumAtFixedTime (`placeExit`, `topUpExit`). MomentumAtFixedTime was left on its
own copy so no live strategy was touched; the two can be merged later.

### TopStockOptionsOpeningGapStrategy (`TopStockOptionsOpeningGapStrategy.ts`) — config: `enabled: true`, multi-broker
**Entry**: one-shot per day, **fired by the first Nifty tick the strategy is
delivered, i.e. the first tick of the 09:15 open** (since 2026-11-12 the
dispatcher delivers nothing before 09:15; before that change it was 09:10).
It is NOT a trading window in the design sense: there is no "wait for the
pre-open price to settle" step. `isTimeInRange()` (9:10–9:20 constants in the
file) exists only because the strategy base needs a range test; it is a
retry limit, not the trigger. A retryable skip (no OHLC data yet) is retried
on later ticks, one attempt per 15 s, until 9:20, and a successful dispatch
of the legs records the day as fired. Do not describe this strategy as
"fires inside a 9:10–9:20 window" or as "waiting for the pre-open
equilibrium price". Gap is computed live, not from any CSV: one batched ANT OHLC
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


## Entry strike selection (index buys)
Spot-based index entries (BulkPcr `chunkedBuyIndex`, `buyIndexOnAnt`/Kite/Breeze buys, `/demo/resolve`) no longer buy pure ATM.
`AntContractMaster.entryStrike()` shifts ATM OTM by half the trading days left to the nearest expiry, rounded up (`otmSteps` in `src/util/expiryOffset.ts`):
CE up, PE down; pure ATM on expiry day. Nifty (Tuesday expiry): Wed 2, Thu 2, Fri 1, Mon 1, Tue 0 steps
(SENSEX uses its own expiry and a 100 step). The expiry comes from the contract master, so a holiday-shifted expiry counts as day 0;
mid-week NSE holidays are not subtracted. A strike missing from the chain steps back toward ATM. Exact-strike buys, ContinuousStrategy's
`pickStrikeFromChain` and MomentumSignal's ATM veto lookup are unchanged.
