# One multi-broker strategy model: per-broker amount, no `broker:` key, no per-broker copies

## Context
Four requests (2026-11-02, after NiftyChange lost 140k when 300k was needed to give each broker 100k):
1. Every broker should trade the **same** investment amount; today `LimitEntryStrategy.startCycle` does `perBroker = budget / brokers.length` (`src/strategy/LimitEntryStrategy.ts:241`), so Recommendation/NiftyChange split one budget. That split was a deliberate "one cap for the whole strategy" design; the new rule is "the amount is per broker".
2. BulkPcr already has `maxInvestmentByBroker`; every strategy should have a per-broker amount.
3. All strategies take `brokers: [...]`; the single `broker:` key goes.
4. `ContinuousStrategy`, `-ANT`, `-Breeze` (copies per broker) become one block.

Decided with the user: limits are **per broker** (own legs, own maxProfit/maxLoss, own cooldown); **all** strategies become multi-broker, including the seven legacy ones; the `-ANT`/`-Breeze` blocks are **deleted**.

## Current state (verified)
- Already fan out over `brokers:` internally (`configuredBrokersOf`, `src/util/brokerName.ts:33`): BulkPcr, BulkPcrAutoStart, Hourly, Butterfly, TopStock, Recommendation, NiftyChange.
- Single broker via `broker:` / default Kite: ContinuousStrategy and SupportResistanceStrategy (`brokerLegOps(() => cfg.broker)`, `ContinuousStrategy.ts:66`, `SupportResistanceStrategy.ts:56`) and the seven legacy ones (Sentiment, RateOfChange, Gap, RuleBased, GoodMorning, GoodMorningSensex, TargetReach), which route through `bookkeeping.getUserBroker`.
- Everything downstream is keyed by `userId`: fills (`strategiesProcess`), FIFO chains, `strategies.getExpandedConfig(userId)`, tokenRouter feed, Mongo `legLineage`/`strategyLatches`, the order-side caps (`bookkeeping.getUserMaxInvestment(user, broker)` already per (user, broker)). Two live instances with the same `userId` would collide.
- `broker` is also read by `orderProcess.applyConfigStrategyLimitsOnce` (:1257), `bookkeeping.getStrategyConfigBroker` (:251), `tokenRouter.resolveSource` (:32), `BulkPcrAutoStart` (:245), `TopStock` (:125).

## Design
**A. Runtime expansion into per-broker instances (reuses the RuleBased pattern).** A block of a single-broker type with `brokers: [kite, ant, breeze]` is expanded in memory into one config per broker, exactly what the operator does by hand today. Pure helper `expandBrokerInstances(cfg)` in a new `src/util/strategyInstances.ts` (no import cycle), used by `StrategyFactory.createStrategiesFromConfig`, `strategies.loadExpandedConfigs`, `orderProcess.applyConfigStrategyLimitsOnce` and `bookkeeping.getStrategyConfigBroker`.
- Child `userId`: kite keeps the base id (`ContinuousStrategy`), others get `<base>-ANT` / `<base>-Breeze`. Same as the existing ids, so Mongo state, latches and trade history carry over. RuleBased composes with its indicator expansion (`Rule-<ind>`, `Rule-<ind>-ANT`).
- Each child gets an internal `broker` (derived, never written to config.yml) and `maxInvestment` = that broker's amount, so all existing code (`LegManager.effectiveMaxInvestment`, `capitalCheck`, maxProfit/maxLoss as % of cap, tokenRouter, order caps) works unchanged. No LegManager rewrite and no shared-state risk between brokers (this is why "per broker" is cheap).
- Types that already fan out internally (BulkPcr family, Hourly, Butterfly, TopStock, LimitEntry) are not expanded.

**B. Per-broker amount.** One helper `investmentForBroker(cfg, broker)` in `src/prism/configVocabulary.ts`: `maxInvestmentByBroker[broker]` (aliases normalised) else `resolveMaxInvestment(cfg)` (`maxInvestment` ← `maxInvestment`), meaning **per broker**. Used by: expansion (child `maxInvestment`), `LimitEntryStrategy.startCycle` (each broker gets its own full amount, no division), Hourly/Butterfly/TopStock sizing, `BulkPcrStrategy.effectiveCap` (replace its private lookup), `applyConfigStrategyLimitsOnce` (`maxInvestmentByBroker`).

**C. `broker:` removed.** `configuredBrokersOf` and the readers listed above stop falling back to `broker`; `configValidation.ts` warns once ("config key broker is REMOVED, use brokers: [...]") like the existing removed-key warnings, then ignores it; `maxInvestmentByBroker` validated for every strategy (positive numbers, known brokers). No `brokers:` means `[kite]` (today's default).

## Changes by file
- NEW `src/util/strategyInstances.ts`: `expandBrokerInstances`, child-id rule (+ unit test).
- `src/prism/configVocabulary.ts`: `investmentForBroker`. `src/prism/configValidation.ts`: removed-key warning, `maxInvestmentByBroker` rules.
- `src/strategy/StrategyFactory.ts`, `strategies.ts`: expand before instantiate / when loading expanded configs.
- `src/strategy/LimitEntryStrategy.ts`: per-broker amount (item 1). `NiftyChangeStrategy.ts`/`RecommendationStrategy.ts`: docs/log text.
- `src/strategy/ContinuousStrategy.ts`, `SupportResistanceStrategy.ts`: keep `brokerLegOps(() => cfg.broker)` (now the derived value).
- `src/util/brokerName.ts`: drop the `broker` fallback; `BulkPcrAutoStartStrategy.ts`, `TopStockOptionsOpeningGapStrategy.ts`: same.
- `src/processes/orderProcess.ts` (:1237-1260), `src/processes/order/bookkeeping.ts` (:251): iterate expanded configs.
- `config.yml`: delete `broker:` keys; delete the `ContinuousStrategy-ANT`/`-Breeze` blocks (user-approved exception to the "never delete entries" rule); Continuous gets `brokers: [kite]` (today's behaviour) with `maxInvestmentByBroker` kept; NiftyChange `maxInvestment`/`maxInvestment` back to a **per-broker** 100000 (the 300k workaround is no longer needed).
- `strategies.md`, `CLAUDE.md` (broker keys, per-broker amount, expansion), tests that set `broker:` (`legBrokerOps`, `tokenRouterFeed`, `hourlyRestore` ...).

## Risks and decisions to keep in view
- **Behaviour change at enable time:** a block listing three brokers now trades all three at the full amount each. Config keeps Continuous at `[kite]` until the user adds more.
- Changing `brokers:` on an expanded type needs a restart (config hot-reload refreshes configs but does not create new instances; same as RuleBased today).
- Children are independent signal evaluators (each runs its own PCR check and T1 entry), like today's three blocks, so entries across brokers can differ by seconds.
- P&L views key on `userId`, so Continuous shows as up to three rows (as today).
- Edits under `src/` hot-restart the trading process; do this only while processes are stopped or flat (they are stopped now). Per project rules: no code-review pass unless asked; tests run only on request; update `strategies.md` and commit + push when done.

## Verification
1. `npx tsc --noEmit -p .` clean.
2. New unit test for `expandBrokerInstances` and `investmentForBroker` (ids, per-broker amounts, aliases, single broker, RuleBased × brokers); existing tests updated for the removed key (run only when you ask).
3. Startup dry check with all strategies disabled: log shows the expanded instance count and ids, no "unknown broker"/removed-key warnings except for intended ones.
4. With one strategy enabled on two brokers (paper size), confirm each broker gets its own full amount (NiftyChange log `qty` per broker) and Continuous creates `ContinuousStrategy` and `ContinuousStrategy-ANT` as separate instances with their own `maxProfit`/`maxLoss`.

---

# Part 2: fixes from the 2026-11-02 trading day (do these in the same session, after Part 1)

Day result: NiftyChange -131.8k, BulkPcr -41.9k, Continuous -2.0k, Recommendation +21.7k. Each item below is a defect or gap seen in the logs, with the evidence and the fix. Order = priority. Already done today (commits `b6ef4f9`, `0741fb4`, `88877bc`): `hedgeTargetFraction` key, BulkPcr/Continuous config retune, NiftyChange slot reference surviving a restart, startup reconcile retry 5 s.

## P1: money-losing gaps

1. **NiftyChange has no stop loss** (`src/strategy/NiftyChangeStrategy.ts`, `LimitEntryStrategy.ts`). The 13:40 slot bought 1365 x 3 brokers of `23150PE` at ~71.3 and rode it to 28 to 42 (-140.5k); the only exits are the +5 sell and the 15:10 close. Fix: add `stopLossPoints` (and optional `maxLossPerLeg`) to NiftyChange; after the fill call the existing `attachProtection` (Kite GTT, ANT in-app exitMonitor, Breeze resting sell + tick stop, as Recommendation already does in `RecommendationStrategy.placeExit`) with target = fill + `targetPoints`, stop = fill - `stopLossPoints`. The engine already has `leg.stop` handling (`LimitEntryStrategy.ts:~301`). Default stop must be set in `config.yml` (suggest 8 pts, reward:risk is the user's call).
2. **No cross-strategy daily loss limit.** Nothing stopped the session at -50k, -100k or -150k. Proposal (needs user approval of the design, per the no-in-memory-controls rule): `settings.maxDailyLoss` in `config.yml`, checked by the trading process against the sum of realized + open P&L over all strategies; on breach set every strategy `enabled: false` in `config.yml` (durable) and close open legs via the existing `POST /order/lock-profits` path. Ask the user for the number before implementing.
3. **Alert coverage hole.** `scripts/monitor-strategies-alerts.sh` covers only BulkPcr and Continuous; NiftyChange and Recommendation lost/made 130k with no alert. Fix: add both (fills, stop/target hits, entry cancelled unfilled, ALERT lines, the slot results) and make "process restarted" slot-missed lines show only the slots that matter (today every restart printed 20+ `SLOT MISSED ... process started after it` lines).

## P2: BulkPcr logic (`src/strategy/BulkPcrStrategy.ts`)

4. **Loss-trip cap cut starves the hedge and shrinks the stop.** Each trip cuts the broker cap by `lossInvestmentCut` (10k): the cap went 100k -> 90k -> 80k -> 70k, and `maxLossPerOrder` (a % of the cut cap) shrank 10k -> 8k -> 6.4k -> 5.6k, so later cycles stopped out sooner. At 12:42 the put hedge was refused four times: "reached max investment (70388.5/70000)" because the root call alone cost 70,388. Fix: (a) compute `maxLossPerOrder` from the configured cap, not the cut cap (`effectiveCap` at `:~590`, `lossStopRupees`); (b) the first hedge buy of a cycle passes `skipInvestmentCap` like a hedge re-buy does (`bookkeeping.canPlaceOrder` ~`:802`), or the root is sized to leave hedge headroom.
5. **Re-buy loop re-enters the same chop.** ANT put: sold 83.6, re-bought 83.6, sold 85.6, re-bought 85.4, stopped at 76.5 (-9.3k). Fix: optional `maxRebuysPerSlot` (default unlimited = today) in `onSlotSoldOut` / `placeRestingRebuy`.
6. **Hedge top-up gave up on margin** (ANT, 10:35: 650 qty left unhedged after "retrying with 715 -> 65"). Fix: before a hedge buy, size it to the broker's available margin (the order process already parses the shortfall); log one ALERT with the unhedged quantity.
7. **Stale `entryQuantity` after a hedge top-up** (saved 1040 for a slot holding 1105; the sell order was 1105). Update `entryQuantity` in `buyTopUp`.
8. **Expiry-eve filter.** All of today's BulkPcr/Continuous trades were on contracts expiring the next day (high gamma and theta). Add optional `skipNearestExpiryOnEve: true` (or an `expiryOffset`) in the contract pick (`pickContract` / `getContractByPriceRangeBare`), default off.

## P3: Continuous / LegManager (`src/strategy/LegManager.ts`)

9. **Refill cancel not retried** (`cancelChildRefills`, `:~1177`): Kite answered "An internal error occurred" to a cancel sent 0.3 s after the order was placed; the order stayed resting and later filled (it was sold back, +97). Fix: on a transient cancel error, retry 2 x with 1 s / 2 s backoff, with the existing "already filled" and "does not exist" handling on each attempt.
10. **Spawn during a max-loss close.** At 10:24:47 a `Level 1 spawn` bought 520 `23300CE` while `closeAllLegsAndCancelReEntries` was closing everything (it was then sold a second later at +0.1). `newOrdersBlocked()` should be true as soon as the close starts, not only once the latch is set.
11. **Cost-basis alert after restart:** "NIFTY26N0323350CE cost basis uncertain: Mongo FIFO says 85.85, broker average 73.44 - using 85.85". The broker average blends other strategies' fills on the same contract; check `restoreFromOpenTrades` (`openTrades.ts`) so a leg restored after a restart uses its own FIFO lots (it does) and that the alert only fires when it matters.
12. **`scripts/continuous-strategy-trades.sh` is stale:** after a max-loss close it still listed the closed legs and the refills as open for 30+ minutes. Fix it to read the live state (or `strategyPnl` + open trades) instead of the saved tree.

## P4: Recommendation and limit entries

13. **Kite price-protection rejection mis-classified.** `recommend 23300 PE 123 185 63` placed a limit buy at 118 on a contract trading ~80; Kite rejected it ("order price is higher than the current limit price protection of 108.65"). The strategy logged "entry order outcome UNKNOWN ... check by hand", marked the key used for the day and disabled the block. Fix: treat a Kite LPP / price-range rejection as definite NOT_PLACED (`NOT_PLACED_TAG`), do not burn the key, and log a clear "entry above the allowed range" message.
14. **Entry above the market fills at market, so the stop and target are mis-sized.** Entry 110 with the contract at 80 filled at 78.85; the supplied target 172 / stop 50 were then +93 / -29 from the real cost. Fix in the `recommend` skill (`.claude/skills/recommend/SKILL.md`) and in `RecommendationStrategy`: read the contract's live LTP; if `entryPrice - entryOffset` is above LTP, warn and ask whether to rebase target/stop to the LTP; log the LTP with the order.
15. **No supported way to move target/stop of an open trade.** I swapped GTTs with an ad-hoc script (`cancelProtection` + `attachProtection` through `OrderClient`). Add it to the strategy: when `targetPrice` / `stopLoss` change in `config.yml` while the leg is open and filled, re-attach the protection (same key rule: it is not a new recommendation). Today a hand edit is treated as a new recommendation and dropped while a trade is open.
16. **Limit entry below the market on a falling option rarely fills** (NiftyChange 11:40 and 12:40 slots: no fill; 13:40 filled only on a reversal). Decision for the user: `limitOffset: 0`, or a market-style marketable limit, or keep as is. Not changed without a decision.

## P5: config and ops

17. **`config.yml` overwritten by strategy writers.** `maxInvestment: 300000` I set at 12:34 was back at 100000 by 12:40:00 (file mtime exactly 12:40:00), when BulkPcrAutoStart/BulkPcr rewrote the file from their in-memory copy (`BulkPcrAutoStartStrategy.ts:268`, `BulkPcrStrategy.ts:2215`, `RecommendationStrategy.ts:92`). Fix: `configService.writeConfig` for a single-key change should read the file, change only that key and write atomically (or serialize writers), and the loader should warn when `maxInvestment` and `maxInvestment` differ (the canonical `maxInvestment` silently wins, `configVocabulary.ts`).
18. **Editing `src/` mid-session hot-restarts the trading process** with open legs (twice today). Document in `CLAUDE.md`; consider `HOT_RESTART` being off during market hours by default.
19. **`CLAUDE.md` notes to add:** NiftyChange/Recommendation sizing is per broker; no-stop strategies must be named when sizing is raised; `maxInvestment` overrides `maxInvestment`.

## Verification for Part 2
- `npx tsc --noEmit -p .` after each item; the new tests (stop attach for NiftyChange, hedge exempt from cap, LPP rejection classification, cancel retry) run only on request.
- After items 1 and 13, replay with `MOCK_BROKER` only if the user asks; otherwise verify on the next session with one broker at minimum size.
- Commit and push per item group; update `strategies.md` for every new config key.
