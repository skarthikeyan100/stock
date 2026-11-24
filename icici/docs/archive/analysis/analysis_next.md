# RuleBasedStrategy block: analysis, recommendation, next steps (2026-11-10)

## What was analysed
`backtest-results/ruleblock-10pt-nostop` and `rulebased-final`, plus a replay of the block through the compiled backtest engine over every
exit cell and a set of "levers" (direction, time of day, consensus, leave-one-rule-out). Data: 4 days (Nov-02, 04, 05, 06), **all rising**.
Re-run with `npm run analyze:ruleBlockGrid` and `npm run analyze:ruleBlockLevers` (`scripts/ruleBlock*.js`; they read the block from
`config.yml` and use `dist/`, so run `npx tsc` first if `src/` changed).

## The block is now 6 rules (3 pairs + 3 single), still `enabled: false`
`MACD_4_8_3+Bollinger_25_1.5`, `EMA_9_21+Bollinger_5_1`, `MACD_4_8_3+MACD_16_32_12`, `MACD_4_8_3`, `Bollinger_20_1`, `MACD_16_32_12`.
Exits unchanged: target 10, no stop, 60 min timeout.

| | 20 rules | 6 rules |
|---|---|---|
| Trades / win % | 47 / 85.1% | 50 / 86.0% |
| Net P&L / profit factor | 17,979 / 2.82 | 21,612 / 3.76 |
| Max drawdown / days positive | 2,476 / 4 of 4 | 2,476 / 4 of 4 |

The other 14 rules took no trades the 6 do not already take, so cutting them loses nothing in this sample. The 6 were picked **on these
same 4 days**, so the improvement is partly selection; treat it as "simpler, not better".

## Findings
1. The 85-86% win rate comes from the exit shape: a tight target, no stop. Every loser is a 60-minute timeout (avg loss about -1,400 vs avg win about +700).
2. Always-CALL on the same days wins 79.6%, so the block's edge over "just buy CALL" is about 5 points (2-3 trades). The sample direction explains most of it.
3. A smaller target raises the win rate with no extra drawdown in this sample: 20-rule block, target 7 / no stop / 60 min = 90.0%, net 18.6k, same max drawdown; 90 min timeout = 94.5%. For the 6-rule block, target 7 with 90 min is 92.2% but drawdown rises to 4,036 and one day is negative, so the gain is not clean.
4. Adding a stop lowers both win rate and P&L (target 10: stop 10 = 56%, 20 = 71%, 40 = 78%; net falls from about 18k to 6-7k).
5. Filters do not help: CALL-only, PUT-only, skipping 11-12h, requiring 2 or 3 rules to agree all lowered win rate or P&L. Time-of-day slices have only 8-19 trades.
6. PUT trades are weak (6-rule block: 69.6% win, net -1,125 alone). CALLs carry the result, which is what a rising market produces.

## Recommendation
- **Keep the block disabled.** Do not enable it live on 4 rising days. The sweep behind it tested about 10 million combinations on that sample.
- **Do not add a stop to fix win rate.** It reduces both. If a loss cap is wanted for safety, size it as a risk decision, not a win-rate one.
- **Do not add direction/time/consensus filters.** They did not help.
- **Optional, low-cost change: target 10 -> 7.** It raised the win rate for the 20-rule block with the same drawdown, but for the 6-rule block the benefit is smaller (86.7% vs 86.0%, lower net). Not worth changing until more data confirms it.
- **Known risk of no stop:** a CALL held through a falling day can lose most of its premium (about 6,500 per trade at observed prices). None of the 4 days tests this.

## Next steps
1. **Get more days**, especially falling and range-bound ones. Copy earlier backups into `~/later/data/backups` (one folder per day, same layout as Nov-02). Without a down day the CALL/PUT asymmetry and the no-stop tail risk are untested.
2. Re-run `npm run backtest:ruleBlock` and `npm run analyze:ruleBlockGrid` / `analyze:ruleBlockLevers` on the larger set. Accept the block only if it beats always-CALL on net P&L and win rate on the falling days too, and is positive on most days.
3. Pick the exit (target / stop / timeout) from the larger set using leave-one-day-out, not from the best cell.
4. If it passes: enable with a small `quantity` first, then `POST /reconcile` per the `enabled` rules in `CLAUDE.md`, and check the first live days against the backtest trades (`trades.csv`).
5. If it fails on falling days: keep it disabled, or restrict it to CALL signals only and re-test that variant.
