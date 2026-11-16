# Pending

## MandWStrategy: parameters and ideas for fine tuning (2026-11-16)

### What is tunable today
`quantity`, `startSide`, `startTime`, `target`, `stopLoss`, `patternTimeoutMinutes`, `lastEntryTime`, `trailDistance` (half at the target, trail the rest), the global `settings.maxProfit` and `settings.entryTimeoutMinutes`.

The pattern levels are not separate numbers: they are derived from the entry price P.

| Level | Today | Where it comes from |
|---|---|---|
| First peak | P + T | `target` |
| Valley | price at or below P | the entry price (no tolerance, by the user's rule) |
| Second peak | P + T again | `target` |
| Failed shape | price at or below P - S | `stopLoss` |

### 1. Own numbers for the peak, valley and failure level (the question asked)
Using the target and stop for both the exit and the shape ties two different jobs together. Candidate keys, all in option points (or "N%" of P), each defaulting to today's value so nothing changes until set:
- `valleyDepth`: the valley counts when the price has fallen this many points from the highest price seen since the target hit (a real pullback), instead of "back to P". With T = 10 a value like 5 would catch pullbacks that never return to P.
- `peakTolerance`: the second peak counts at the first peak minus this (e.g. 1 or 2 points). The first peak should be the highest price actually seen after the target hit, not just P + T, because a real M has two tops of similar height.
- `peakConfirm`: require the second peak to exceed the first by this much (a break above, not just a retest). Fewer false patterns.
- `failDistance`: the level at which the shape is called failed, separate from `stopLoss`. A tighter value (say S/2) reverses earlier, a wider one gives the shape room.
- `minPatternGap`: minimum time between the target hit and the valley (and between valley and second peak) so one noisy tick pair is not read as a pattern.

### 2. Cutting stop-flip whipsaw (the likely main cost)
Nov-13 backtest, target 10 / stop 10: 24 trades, 8 winners, 16 stop-flips. A win is +650, a stop is about -650 to -780, so at 10/10 it needs a hit rate above 50% plus costs just to break even. Ideas:
- `stopConfirmTicks` / `stopConfirmSeconds`: the stop needs the price at or below it for N ticks or seconds, not one tick.
- `flipCooldownSeconds`: minimum time after a stop before the reversal buys.
- `maxConsecutiveStops`: after N stops in a row, stop trading for the day (or pause for M minutes). The Nov-13 run had 6 stops in a row between 10:04 and 10:31.
- `flipFilter`: reverse only if NIFTY has moved in the new direction since the entry (or the option's delta-adjusted move supports it); otherwise skip or re-enter the same side.
- A break-even or trailing stop once the price is +X above P (today the stop is fixed; `trailDistance` only trails the second half after the target).
- Asymmetric target and stop (for example target 14 / stop 8). Test it, do not assume it.
- A percent or volatility based size instead of fixed points: `target`/`stopLoss` already accept "N%"; a size from the option's recent range (ATR-like) is not built.

### 3. Risk limits that do not exist yet
- **A daily loss cap.** There is a profit cap (`settings.maxProfit`) but no loss cap for this strategy; Nov-13 reached -8,131 at the lowest. `maxLoss` (rupees, per broker, own latch like the profit cap) is the most important missing guard.
- `maxTradesPerDay` (the user chose `maxProfit` over this, but it can be an extra, default off).
- `maxConsecutiveLosses` (see above).
- A no-new-entry window near the close and after a given loss.

### 4. Entry quality
- Strike choice: ATM today. Options: one strike ITM or OTM, or "the strike whose premium is closest to N" (a fixed-premium entry makes T and S comparable from day to day).
- `minPremium` / `maxPremium`: skip when the option is too cheap or too dear for fixed 10-point moves.
- Direction of the first entry from a signal (PCR, EMA/VWAP trend, `NiftyChange`-style momentum) instead of the fixed `startSide`.
- `startTime` and a list of no-trade windows (the first minutes and the lunch hour are noisy); skip the expiry day or trade it with smaller size.
- Spread / depth check before a buy, since entries are limit orders at the LTP.

### 5. Watch and timeout behaviour
- `patternTimeoutMinutes` runs for the whole watch. Alternatives: a separate timeout after the valley, or a different action on timeout (skip and wait for a fresh first entry, instead of re-buying the same side). Nov-13 had 3 timeouts out of 8 watches and the re-buy of the same side won 1 of those 3, so this is worth a sweep, not a guess.
- The watch could end when the NIFTY level has moved against the watched side by a set amount.
- Cap on how many consecutive watches or reversals a day.

### 6. Tooling to find good values (do before changing defaults)
- Extend `npm run backtest:mandw` to sweep `target` x `stopLoss` x the new keys over every stored day and print a table. One day is not evidence: the backups hold a limited set of days (Nov-02, 04, 05, 06, 12, 13 and some Aug/Sep ones; not all checked for this strategy), and on Nov-13 only strikes 25100 to 25350 were recorded, so a deeper move stops being tradable in the replay.
- Add brokerage, taxes and slippage to the backtest; the current numbers are before costs and the stop sells at the tick that crossed it.
- Simulate more than one broker in the backtest (it replays one).
- Record the real fills of the first live days (pattern, flip and timeout events are already logged with the `MandW:` tag) and compare with the backtest.

### Suggested order
1. Daily loss cap (`maxLoss`).
2. Stop confirmation, flip cooldown and `maxConsecutiveStops`.
3. Separate `valleyDepth`, `peakTolerance`, `failDistance`, with today's behaviour as the default.
4. Sweep tool over all stored days, then pick defaults from it.

## All strategies (2026-11-16)

### Every strategy supports `brokers: [...]` natively, each broker independent
Every block already must list `brokers:` (the validator requires it), but it works in two different ways today:
- Ten types handle the list inside one strategy (BulkPcr, BulkPcrAutoStart, Hourly, Butterfly, TopStock, Recommendation, NiftyChange, MomentumAtFixedTime, NextWeek, Breakout; GammaBurst and MandW too). Among them only MandW keeps a fully separate cycle, leg, watch, retry count and profit-cap latch per broker; the LimitEntry ones start one cycle across all brokers and share the cycle key.
- The other types (Continuous, SupportResistance, Sentiment, RateOfChange, Gap, RuleBased, GoodMorning*, TargetReach) are expanded in memory into one instance per broker (`<id>`, `<id>-ANT`, `<id>-Breeze`), so they are independent but are separate strategies with separate state files and ids.

To do: one rule for all strategies. A block with `brokers: [...]` is ONE strategy, and each broker in it acts independently: its own cycle, legs, state, latch (a profit-cap or loss latch on kite never touches prism), retries and refusals, with `quantity` / `maxInvestment` per broker. Steps:
1. Make the per-broker scope of `LimitEntryStrategy.startCycle(..., [broker])` (added for MandW) the model, and move NiftyChange, MomentumAtFixedTime, NextWeek, Breakout, Recommendation and GammaBurst to per-broker cycle keys and state, so one broker's unfilled or refused entry never holds back another's.
2. Decide for the expanded types whether to keep the per-broker instances (already independent) or fold them into one strategy; either way the config looks the same, only the internals differ. Keep the existing `-ANT` / `-Breeze` ids and state files working if they are kept.
3. Add one test per strategy that two brokers diverge independently (one stopped or latched, the other keeps trading).

### Every strategy can use halfTrail
The half-at-target + trail exit (`halfTrail.ts` plus the shared engine in `LimitEntryStrategy`, switched on by `trailDistance`) is only enabled for MandWStrategy today, and BulkPcr has its own separate trail (see the ToDo entry to merge them). To do: make it available to every strategy that exits on a target, configured like `target` / `stopLoss` (the block's value, else a `settings.trailDistance`; absent = off; not engaged with fewer than 2 lots):
1. NextWeek, Breakout, NiftyChange, MomentumAtFixedTime, Recommendation, GammaBurst: they already sit on `CandleEntryStrategy` / `LimitEntryStrategy`, so this is mostly reading the key in `trailDistance()` and a validator rule.
2. The strategies with their own exit code (Continuous, SupportResistance, SimpleContinuous, ScaledHedged, Hourly, Butterfly, TopStock, BulkPcr, the legacy ones) need the engine adapted to their exit path; each needs its own check for partial fills, chunked orders and restarts.
3. Per broker: the half and the trail are decided per leg, so they stay independent across brokers.
4. Backtests: add the option to the backtest tools that exist, so the effect can be measured before it is turned on anywhere.
