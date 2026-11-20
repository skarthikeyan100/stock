---
name: recommend
description: Use when the user gives an analyst option recommendation to trade, e.g. "recommend 24150 ce 140 160 120" (strike, CE/PE, entry, target, stop loss; optional index first, NIFTY by default). Validates it and sets the RecommendationStrategy block (Recommendation-1) in config.yml to enabled: true with those values.
---

# Recommend: set the RecommendationStrategy block

Input: `recommend [INDEX] <strike> <CE|PE> <entry> <target> <stop>`

- `INDEX` is optional, `NIFTY` or `SENSEX`, default `NIFTY`.
- `strike` 3 to 6 digits. `CE` or `PE`, any case.
- `entry`, `target`, `stop` are option prices, positive numbers.
- Example: `recommend 24150 ce 140 160 120` -> index NIFTY, contract `24150 CE`, entryPrice 140, targetPrice 160, stopLoss 120.

The target block is `type: RecommendationStrategy` with `userId: Recommendation-1` in `config.yml` (repo root). It is the only block this skill edits.

## Steps

1. **Parse** the input. If it does not match the form above, say the expected form and stop. Change nothing.

2. **Validate.** Read `entryOffset` from the block (default 5 when absent). Refuse, changing nothing, if any check fails:
   - `stop < entry < target` (the entry must sit between the stop loss and the target).
   - The order price `entry - entryOffset` must be above the stop: `entry - entryOffset > stop`. The strategy refuses otherwise.
   - All prices are positive.

2b. **Check the entry against the market (information only, never asks).** If the contract's live LTP is known (the user states it, or it is readable from the running app's option ticks), compare it with the order price `entry - entryOffset`. If the order price is ABOVE the LTP, the limit buy fills at about the LTP, not at the entry. That is fine: target and stop are kept as distances from the recommended entry (`target - entry`, `entry - stop`) and the strategy rebases them to the real average fill automatically once the buy fills (2026-11-20: entry 130 / target 150 / stop 110 filled at 123.95 -> target 143.95 / stop 103.95). Do not ask the user whether to rebase; just mention the LTP and the rebase in the report. If the LTP is not obtainable, say that; the strategy logs an ALERT with the LTP when it places the order.

3. **Refuse if a trade is in progress.** Both checks, and refuse if either finds something:
   - `curl -s "localhost:3000/strategyPnl?match=Recommendation"`: any row with `open > 0` means a position is open.
   - Read `.RecommendationStrategy.Recommendation-1.json` in the repo root (the strategy's state file). Any leg with status `placing` or `resting`, or `filled` with `soldQty < filledQty`, or an entry still open (`entryCancelled` not set, status not `failed`/`cancelled`, `filledQty < qty`) means a trade is in progress. A missing file means none.
   - If the server is not reachable, say so and rely on the state file alone.
   - A recommendation is never continued while a trade is in progress; say which leg or position blocks it and stop.

4. **Refuse if this recommendation already traded today.** Its key is `contract|entryPrice|targetPrice|stopLoss|maxInvestment|entryOffset`, with the contract written as `24150 CE`, e.g. `24150 CE|140|160|120|100000|5`. If the state file's `day` is today and `keys` contains that key, it was already placed today: say so, and do not set `enabled: true`.

5. **Edit `config.yml`** with the Edit tool, changing only the values of the `Recommendation-1` block:
   - `enabled: true`
   - `contract: 24150 CE`
   - `entryPrice: 140`, `targetPrice: 160`, `stopLoss: 120`
   - `index: NIFTY` (or the index given)
   - Keep `maxInvestment` (the amount per broker), `entryOffset`, `brokers`, `startTime` as they are (`eodCloseTime` is a global setting, `settings.eodCloseTime`, not a key of this block). Never delete a key or a block.

6. **Check the result.** Re-read the block and confirm the values. Note the time: a recommendation given after `settings.eodCloseTime` or before `startTime` (09:20) is not placed until the next window. The strategy hot-reloads config.yml, so a running `npm run processes` picks it up with no restart.

7. **Report** in one short message: the contract, entry, target and stop, the order price (`entry - entryOffset`), the index, and that the block is enabled. The block is set to `enabled: false` automatically once the trade is finished (bought and sold, or the entry cancelled with nothing filled).

## Notes

- `targetPrice` and `stopLoss` in the block are the analyst's levels at the recommended entry. The strategy treats them as distances and places the protection at fill + (target - entry) / fill - (entry - stop), per broker, over partial fills (weighted average) and across restarts.
- Changing the values of a block is a new recommendation, and it is placed once more. The same recommendation is never placed twice on a day, even across restarts.
- A recommendation sent while a trade is in progress is refused by this skill. If one reaches the strategy another way (a hand edit), the strategy drops it and never picks it up later.
- Do not run `npm run test:*` for this change unless the user asks.
