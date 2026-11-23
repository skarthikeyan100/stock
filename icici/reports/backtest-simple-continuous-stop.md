# SimpleContinuous: hard stop + extra opposite hedge, backtest result

Recommendation: **do not build yet, more data needed.** The replay does not reproduce the actual days, the sample is 8 sessions, and the result swings on slippage and on path chaos, not on the stop.

## What was run
`src/tools/SimpleContinuousStopBacktest.ts` replays the real `SimpleContinuousStrategy` class over the recorded per-second ticks (`~/later/data/backups`, Nov 02, 04, 05, 06, 12, 13, 17, 20) and injects a stop from the replay loop (no broker, no order, no strategy change). Variants: S in {10,20,30,40,50,60,80} points below entry; (i) stop only, (ii) plus one extra opposite hedge when the stopped leg was already hedged, (iii) like (ii) with the extra hedge not hedged in turn; slippage on the stop sell 0 / 2 / 4 points (per-run results include 2). Uncapped (`maxProfit` off) because the configured 10,000 cap ends most days after two winners and no stop ever matters. Run: `tsc --outDir .bt-dist && MOCK_BROKER=true node .bt-dist/tools/SimpleContinuousStopBacktest.js`.

## Baseline reproduction: FAILED (so the comparison is indicative only)
Replay baseline (kite size, current config, uncapped) against actual closedTrades by exit day:

| Day | Replay | Actual (kite) |
|---|---|---|
| Nov 04 | -17,322 | +19,566 |
| Nov 05 | +26,062 | -4,859 |
| Nov 13 | -16,585 | -139,290 |
| Nov 17 | -41,542 | +5,847 |
| Nov 20 | +40,739 | +5,727 |

Not one day is within tolerance. Reasons (verified in the data): the code and config changed over these days (double-up until Nov 13, per-day cap and sizing, roots at 10:00 in reality vs the replay's own first-tick roots), the roots differ, no bid/ask in the recorded data, no EOD close. Per the agreed rule no variant result below is evidence; it only shows what the stop does inside the replay's own world.

## Replay results (8 days, sum of net; baseline uncapped = +55,357)
| S | (i) slip 0 | (i) slip 4 | (ii) slip 0 | (ii) slip 4 | (iii) slip 0 | (iii) slip 4 | stops |
|---|---|---|---|---|---|---|---|
| 10 | +128,567 | -423,517 | same | same | same | same | 223 |
| 20 | +98,881 | -167,879 | -32,003 | -277,183 | -37,271 | -195,065 | 107 |
| 30 | +26,800 | -138,560 | +145,187 | +1,927 | +128,989 | -2,311 | 66 |
| 40 | +65,029 | -32,731 | +47,070 | -61,350 | +22,100 | -86,320 | 39 |
| 50 | +37,307 | -19,113 | +74,883 | +16,643 | +64,668 | +3,568 | 23 |
| 60 | +656 | -36,855 | +31,960 | -5,551 | same as ii | same | 16 |
| 80 | +3,848 | -23,192 | +37,550 | +10,510 | same as ii | same | 11 |

Reading it:
- Slippage dominates: 4 points on every stop turns almost every row negative. Any real broker gap (the paper engine slipped 2.6 to 3.5 points on an 8-point stop) moves the answer more than the choice of S.
- The extra hedge does not behave consistently: it adds +87k to +115k at S 30-50 but loses at S 20; no stable ordering of (ii) vs (iii).
- The assumption "the opposite right gains after the stop" is not supported: mean change of the nearest-ATM opposite option 5/15/30 min after a stop is -0.1/-1.5/-2.5 points at S20 (107 events, about half up) and -1.2/-0.4/-1.5 at S30. At S50 (23 events) +1.6/+3.3/+10.1, up in 16 of 23 at 30 min, too few events and one expiry-day cluster.
- Stopped legs that later reached their target (the cost of stopping): S50 2 of 23, S30 21 of 66, S20 46 of 107, S10 134 of 223. A 10-30 point stop cuts many winners; a 50+ point stop cuts almost none, which fits the user's premise. Held to the close instead, the 23 S50 legs would have lost 979k against 709k stopped (replay), i.e. the stop saves about 270k on those legs before the knock-on effects.
- Knock-on effects (new roots, re-hedges, different one-per-side occupancy) change the chain after a stop, so the net can end below baseline even though each stopped leg is better off than holding it. One day of chain path dominates each row; 8 days cannot average that out.
- Max drawdown (sum of daily): baseline 319k; S50 (ii) 255k, S50 (i) 310k, S30 (ii) 315k, S20 (i) 405k.

## Data findings (verified)
- 8 sessions recorded; none for Nov 09, 11, 16, 18, 19, 23. The evidence days (Nov 11 -75..-127 point legs, Nov 23 four CE roots) have no price path. The collector is not running now (no process; Mongo OptionQuote empty), so Nov 23 will not be backed up.
- Only 6 CE + 6 PE NIFTY strikes (about 300 points around the morning ATM); no bid/ask, so the bid-resting hedge buy and its fill rate are not modelled (a buy fills at the last tick).
- 23 stop events at S50 in 8 days, all from the replay's own legs.

## What would make it decidable
1. Collect more sessions with the collector running every day and the Nov 23-type days exported; widen the strike window or follow the ATM; record best bid / offer if the feed carries it. At least 15-20 more sessions.
2. Then reproduce the actual baseline first (the replay must match the day's real roots, size and cap), by seeding the replay with the actual root fills from closedTrades.
3. Decide with slippage 4 as the bar, and a cap on winners cut (a 50+ point stop cuts almost none).

Not verified: why the collector stopped; whether the Nov 23 ticks exist anywhere; the bid-resting fill model; Mongo documents for Nov 11.
