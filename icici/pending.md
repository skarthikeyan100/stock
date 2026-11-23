# Pending

## Resume here (2026-11-23): MandW removal, Recommendation repeat/reverse, ExpiryStrategy, test runner. NOTHING COMMITTED YET
All code is written in the working tree (compiles with `npx tsc`); no commit, no push, no process restart.
1. **MandW removed** (code, tests, backtest tool, config block, docs). `halfTrail.test.ts` now covers only the pure rules.
2. **RecommendationStrategy `repeat` / `reverse`** (default false; only after a target hit): `recommendationCycle.ts`, `State.rec`, validation, tests. Assumptions to confirm: the repeat buys at `entryPrice - entryOffset` (not `entryPrice`); `reverse` alone arms after the 1st target; one cycle across all brokers (the next step waits for every broker's current trade).
3. **New ExpiryStrategy** (`ExpiryStrategy.ts`, `expiryCycle.ts`, config block `Expiry-NIFTY`, `enabled: false`, `brokers: [paper]`, key `driftPoints`). Assumptions to confirm: drift = LTP above the buy limit by more than `driftPoints`; the re-buy after a target is at the average bought price on the same strike.
4. **Test runner fix**: `scripts/test-autoexit.js` (preloaded by `scripts/run-all-tests.js`) ends a finished test that only a config watcher (`FSEventWrap` from `ConfigService.ts:230`, `StatWatcher` from `config.ts:83` `fs.watchFile`) keeps alive. A full run was about 35-45 min, mostly ~20-30 tests that never exit. Cleaner fix: `.unref()` those two watchers (production code, not done). Other slow tests: `optionTsym` (~31 s, big contract masters), `foreignSellBookingEvents` (~19 s of sleeps).
5. **Full `npm run test:all`: 116/116 pass (2026-11-23).** The 10 failures found were stale tests or the runner, fixed: `test-autoexit.js` (stdio pipes were counted as live handles), `scaledHedged` (no add to an open contract), `nonFinitePnl` (trip needs `verified`), `paperBroker` (HighLow trailDistance validation dropped), `supportResistanceStrategy` (ltt 0 is 'no timestamp'), `contractorEmails` / `contractorPortal` (Researcher / Research Analyst wording, schedules renumbered, SEBI required for Business), `contractorRecommendations` / `contractorStatements` / `forecastEngineFlow` (now edit a temp config.yml through `src/test/editYaml.ts`, not text replace), `bulkPcrStrategyReconcileAnt` (runs the deferred actions under a pinned 11:00 clock).
6. **New global `settings.entryStartTime: '10:00'`** (`src/util/entryStart.ts`, validator, AppConfig, strategies.md): ScaledHedged and HighLow take no new entry before it. `config.yml` now has SimpleContinuous enabled on kite, prism, ant, breeze (breeze maxInvestment 50000), ScaledHedged and HighLow enabled on kite.
7. **To do:** commit in separate commits and push, staging only my hunks in `config.yml` / `CLAUDE.md` (they also hold your own uncommitted edits; HEAD's config.yml still has the MandW block, which the code no longer accepts); restart the trading process after market hours.

## All strategies (2026-11-16)

### Every strategy supports `brokers: [...]` natively, each broker independent
Every block already must list `brokers:` (the validator requires it), but it works in two different ways today:
- Ten types handle the list inside one strategy (BulkPcr, BulkPcrAutoStart, Hourly, Butterfly, TopStock, Recommendation, NiftyChange, MomentumAtFixedTime, NextWeek, Breakout; GammaBurst too). The LimitEntry ones start one cycle across all brokers and share the cycle key.
- The other types (Continuous, SupportResistance, Sentiment, RateOfChange, Gap, RuleBased, GoodMorning*, TargetReach) are expanded in memory into one instance per broker (`<id>`, `<id>-ANT`, `<id>-Breeze`), so they are independent but are separate strategies with separate state files and ids.

To do: one rule for all strategies. A block with `brokers: [...]` is ONE strategy, and each broker in it acts independently: its own cycle, legs, state, latch (a profit-cap or loss latch on kite never touches prism), retries and refusals, with `quantity` / `maxInvestment` per broker. Steps:
1. Make the per-broker scope of `LimitEntryStrategy.startCycle(..., [broker])` (kept after MandW was removed; ExpiryStrategy uses it) the model, and move NiftyChange, MomentumAtFixedTime, NextWeek, Breakout, Recommendation and GammaBurst to per-broker cycle keys and state, so one broker's unfilled or refused entry never holds back another's.
2. Decide for the expanded types whether to keep the per-broker instances (already independent) or fold them into one strategy; either way the config looks the same, only the internals differ. Keep the existing `-ANT` / `-Breeze` ids and state files working if they are kept.
3. Add one test per strategy that two brokers diverge independently (one stopped or latched, the other keeps trading).

### Every strategy can use halfTrail
The half-at-target + trail exit (`halfTrail.ts` plus the shared engine in `LimitEntryStrategy`, switched on by `trailDistance`) is enabled by no strategy today (MandW, its only user, was removed), and BulkPcr has its own separate trail (see the ToDo entry to merge them). To do: make it available to every strategy that exits on a target, configured like `target` / `stopLoss` (the block's value, else a `settings.trailDistance`; absent = off; not engaged with fewer than 2 lots):
1. NextWeek, Breakout, NiftyChange, MomentumAtFixedTime, Recommendation, GammaBurst: they already sit on `CandleEntryStrategy` / `LimitEntryStrategy`, so this is mostly reading the key in `trailDistance()` and a validator rule.
2. The strategies with their own exit code (Continuous, SupportResistance, SimpleContinuous, ScaledHedged, Hourly, Butterfly, TopStock, BulkPcr, the legacy ones) need the engine adapted to their exit path; each needs its own check for partial fills, chunked orders and restarts.
3. Per broker: the half and the trail are decided per leg, so they stay independent across brokers.
4. Backtests: add the option to the backtest tools that exist, so the effect can be measured before it is turned on anywhere.
