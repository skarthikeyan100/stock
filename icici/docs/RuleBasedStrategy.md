# Rule-Based Trading Strategy

## Overview

`RuleBasedStrategy` is one strategy. Its block in `config.yml` lists **rules**, one per line. A rule fires when its indicators agree on
the direction of NIFTY, and then the strategy buys the option for that direction. Code: `src/strategy/RuleBasedStrategy.ts`; indicator
names and rule parsing in `src/strategy/ruleIndicators.ts`; exits in `src/strategy/exitRules.ts`.

```
5-minute NIFTY candles (processes/strategies/niftyStatsBuilder.ts)
      ↓  receive(oldStats, newStats)
Each rule: its indicators → UP / DOWN / none (all must agree, or a majority with requireAllIndicators: false)
      ↓
Combine the rules:
  - any rule UP and another rule DOWN on the same candle → no trade (conflict)
  - otherwise, any rule that fired → buy CALL (UP) or PUT (DOWN)
      ↓
One position at a time → exits: timeout → target → stop-loss (on option ticks)
```

## Rules

Each item of `indicators` is one rule. Commas inside an item join indicators that must **all** agree within that rule (for a
majority vote, set `requireAllIndicators: false` on the block).

```yaml
- type: RuleBasedStrategy
  enabled: true
  indicators:
    - Bollinger_25_1.5              # rule 1: this indicator alone
    - MACD_4_8_3, MACD_16_32_12     # rule 2: both must agree
    - RSI_5_80_20, EMA_5_13         # rule 3: both must agree
  quantity: 65
  target: 15
  stopLoss: 10
  maxHoldTimeMinutes: 60
```

| Situation on one candle | Result |
|---|---|
| Rule 1 says UP, rules 2 and 3 say nothing | Buy CE |
| Rule 2 says UP, rule 3 says DOWN | No trade (rules disagree) |
| Rule 2 says UP and rule 3 says UP | Buy CE (one trade, not two) |
| Rule 2's MACD says UP and EMA says DOWN | Rule 2 says nothing; rule 2 cannot disagree with itself |
| No rule fires | Nothing |

A rule is evaluated only on the candle that closes. A position already open blocks new signals until it closes.

## Indicators

A name must be one the live builder computes (the parameter sets in `src/lib/indicator-config.ts`). An unknown name, or a
combination the builder does not compute, stops the whole block from trading (ALERT in the log), and config validation rejects it.

| Name | Example | Signal |
|---|---|---|
| `RSI_p_ob_os` | `RSI_5_80_20` | Above overbought → DOWN; below oversold → UP |
| `RSI_p_ob_os_REV` | `RSI_5_80_20_REV` | Contrarian RSI (same parameters): trend inverted, so overbought → UP, oversold → DOWN |
| `MACD_f_s_sig` | `MACD_12_26_9` | MACD above signal → UP; below → DOWN |
| `EMA_s_l` | `EMA_5_13` | Short EMA crossover above long → UP; below → DOWN |
| `Bollinger_p_dev` | `Bollinger_20_2` | Close above upper band → UP; below lower → DOWN |
| `ADX_p` | `ADX_14` | +DI above −DI → UP; −DI above +DI → DOWN; ADX below 20 → NEUTRAL |
| `Stochastic_k_d` | `Stochastic_14_3` | %K below 20 and above %D → UP; %K above 80 and below %D → DOWN (`Stoch_k_d` is accepted too) |

Live parameters: RSI periods 5/10/14/15/20/25/30 with thresholds 70/30, 80/20 or 90/10; MACD 4/8/3 … 24/48/18 (seven sets);
EMA 5/13 … 30/70 (nine pairs); Bollinger periods 5–30 with deviations 1, 1.5 or 2; ADX 14 and 20; Stochastic 14/3 and 14/5.

## Configuration

```yaml
settings:
  target: 10            # global exit: 10 points above the entry; "5%" or none also allowed
  stopLoss: 20          # global exit: 20 points below the entry; "10%" or none also allowed
  maxHoldTimeMinutes: 60  # global timeout: minutes held, winners and losers alike; 'none' = no timeout

strategies:
  - type: RuleBasedStrategy
    enabled: true
    indicators:                   # one line per rule
      - RSI_5_80_20, EMA_5_13
      - Bollinger_25_1.5
    quantity: 65                  # contracts per trade (NIFTY lot = 65)
    maxHoldTimeMinutes: 30        # 0 = no timeout
    cooldownSeconds: 300
    requireAllIndicators: true    # false = a majority of each rule's indicators
    target: "10%"                 # optional override of settings.target
    stopLoss: none                # optional override: no stop-loss
    logEnabled: true
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Off = the block takes no action (see the project guide on `enabled`) |
| `indicators` | required | List of rules. Each item is a rule; commas inside an item join indicators that must agree |
| `quantity` | 65 | Contracts per trade |
| `target` | `settings.target` | Points or `N%` above the entry, or `none`. Required, from the block or from settings |
| `stopLoss` | `settings.stopLoss` | Points or `N%` below the entry, or `none`. Required, from the block or from settings |
| `maxHoldTimeMinutes` | `settings.maxHoldTimeMinutes` | Minutes a position is held, whatever its P&L. `none` (or 0) = no timeout. Required, from the block or from settings |
| `requireAllIndicators` | `true` | `true`: all of a rule's indicators must agree. `false`: a majority; NEUTRAL or no value casts no vote |
| `cooldownSeconds` | 0 | Wait after a trigger before the next one |
| `logEnabled` | `true` | Debug logging |

The block's id is its `userId`, or `RuleBased` when none is given. Legacy keys `targetProfitPercent`, `stopLossPercent`,
`targetPoints`, `stopLossPoints` are ignored (an ALERT is logged at startup).

## Exits

Target and stop-loss come from `settings.target` / `settings.stopLoss` and can be overridden on the block with the same formats
(points, `"N%"` of the entry price, or `none`). They are checked on each option tick of the held contract, in this order:

1. **Timeout**: `maxHoldTimeMinutes` after the entry, for winners and losers alike (sold as `timeout`). It is not a loss-only exit.
2. **Target**: option price at or above entry + target (sold as `win`).
3. **Stop-loss**: option price at or below entry − stop (sold as `loss`).

The levels are fixed when the buy fills and are recomputed if a freeze-split chunk changes the average price. Exits are sold
by the strategy at the tick price; no resting broker order is placed for them. The exit depends on option ticks reaching
the strategy, the same as the timeout.

## Monitoring

Log lines (with `logEnabled: true`):

```
[Rule:RuleBased] Rules: [RSI_5_80_20,EMA_5_13]=UP [Bollinger_25_1.5]=none
[Rule:RuleBased] Consensus: call
[Rule:RuleBased] TRIGGERED: call, buying NIFTY06FEB25C24550 qty=65
[Rule:RuleBased] Buy confirmed: NIFTY06FEB25C24550 qty=65 price=85.5 target=8.55 stop=17.1 (points)
[Rule:RuleBased] Selling NIFTY06FEB25C24550: WIN P&L=...
```

## Troubleshooting

**No trades.**
1. `enabled: true` on the block, and the time is 10:00–15:00.
2. An `ALERT` in the log: an unknown indicator name, or a `target`/`stopLoss` that is missing or invalid (in the block and in settings).
3. `Rules disagree` in the log: a conflict on that candle.
4. Cooldown still running, or a position already open.
5. Each indicator needs enough history. The live builder starts from the first tick after the process starts, so after a
   restart long periods (for example MACD 24/48/18 or EMA 30/70) return no value and the rule waits.

**Order failed.** Check the price range (`settings.minPrice` / `maxPrice`), the balance and the lot size (65 for NIFTY).

## Backtest over the backup days

`npm run backtest:ruleBased` scores RuleBased rules on the recorded days (default `~/later/data/backups/<Mon-DD>/csv`). It is in
`src/tools/RuleBasedBacktest.ts` and `src/tools/ruleBacktest/`.

```bash
npm run backtest:ruleBased -- --maxSize 2 --intervals 300,900,1800 --verifyTop 10 --out backtest-results/run1
```

| Flag | Default | Meaning |
|---|---|---|
| `--allDays` | `~/later/data/backups` | Folder of `<Mon-DD>/csv/` day folders |
| `--intervals` | `300,900,1800` | Candle lengths in seconds |
| `--maxSize` | `2` | Largest rule (number of indicators); singles and pairs all-agree, triples and above also majority |
| `--verifyTop` | `5` | Top rules replayed through the real `RuleBasedStrategy` and compared trade by trade |
| `--costPerTrade`, `--slippagePoints` | `0` | Rupees per trade; points per side |
| `--maxStrikeDistance` | `100` | Skip a signal when the nearest recorded strike is farther than this from ATM |
| `--out` | `backtest-results/rulebased-<time>` | Output folder (gitignored) |

**What is simulated.** The same consensus, exits and order of checks as the live strategy: a signal at a candle close in 10:00–15:00
buys the ATM CE (UP) or PE (DOWN) at the first option tick after it; the exit is timeout, target or stop on each option tick; one position
per rule. Every rule is run against 105 exit cells (targets none/5/10/15/20 points, 10/20%; stops none/10/20 points, 10/20%; timeouts
15/30/60 min). The cell reported for a rule is the one with the best median total over itself and its one-step neighbours.

**Outputs.** `summary.md` is the first file to read: data coverage, a warning when every day moved the same way, the robust and gate-passing
rules, and the verification result. `rules.csv` has one row per rule and interval at its reported cell. `trades-top.csv` lists the top rule's
trades. `run.json` records the flags and the input files, so a rerun can be compared.

**Baselines.** The summary also scores always-CALL and always-PUT on the same candles and exit cells. Read the rules against them: in a
one-way market the always-CALL baseline can pass the gate on its own. The per-interval table counts how many robust rules make more net
P&L than always-CALL.

**The consistency test.** A rule passes the gate when: at least 20 signals with a direction hit rate above 55% at 15 points; at least 8
trades; net P&L above zero; positive on at least 3 of the days; profit factor above 1.2. It is robust when it also makes money in the
leave-one-day-out test (the best exit on the other days, scored on the day left out). A passing rule on a few days is a shortlist to test
further, not proof: the data is a few days, the market moved one way on every recorded day, and many rules and exit cells are compared.

**Checks.** The verification step drives the real `RuleBasedStrategy` class (order client stubbed, clock set to the tick times) and fails
the report if its trades differ from the sweep. Zero mismatches on the verified rules is the evidence that the sweep matches the live code.

Limits: 15- and 30-minute candles are built by the backtest's own builder; the live pipeline is still 5-minute only. Highs and lows are
closes, as in the live builder, so ADX and Stochastic are approximate. The recorded option strikes are fixed per day, so an ATM strike that
was not recorded is skipped (or uses the nearest recorded strike within the distance limit).
