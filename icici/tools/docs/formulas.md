# Stock Analysis Formulas

## Quick Reference

| Section | Method | Formula |
|---|---|---|
| Standard Pivots | PP = (H+L+C)/3, R1/R2/R3, S1/S2/S3 | Deterministic, most widely used |
| Fibonacci Pivots | PP ± 0.382/0.618/1.0 × (H−L) | Fib ratios applied to range |
| Camarilla Pivots | C ± 1.1×(H−L)/12..2 | R4/S4 = key breakout levels |
| Swing Highs/Lows | 5-bar local extremes | Last 3 swing H + 3 swing L |
| Price Clusters | ATR-bucketed touch count | Top 3 most-tested price zones |
| Weighted Score | (1Y×4 + 6M×3 + 3M×2 + 1M×1) / 10 | Longer periods weighted higher |
| Rank Score | Average rank across all 5 periods | Lower = stronger momentum |
| 12-1 Momentum | 1Y return − 1M return | Classic Jegadeesh-Titman factor |

---

## Momentum Scores (`stockReturns.ts`)

### Weighted Composite Score
Weighted average of return periods — longer periods get higher weight. 1-Week is excluded (too noisy).

```
Weighted Score = (R_1Y × 4 + R_6M × 3 + R_3M × 2 + R_1M × 1) / 10
```

Where `R_XM` = percentage return over that period:
```
R = (current_price - past_price) / past_price × 100
```

### Cross-Sectional Rank Score
For each return period, rank all N stocks from best (rank 1) to worst (rank N).
Average the 5 ranks per stock. Lower average rank = stronger momentum.

```
Rank_period[stock] = position of stock when all stocks sorted by R_period descending

Rank Score = mean(Rank_1W, Rank_1M, Rank_3M, Rank_6M, Rank_1Y)
```

### 12-1 Momentum (Jegadeesh-Titman)
Classic quant factor. Subtracts the most recent month to avoid short-term reversal.

```
12-1 Momentum = R_1Y − R_1M
```

Positive value = sustained long-term uptrend with no short-term exhaustion.

---

## Support & Resistance (`supportResistance.ts`)

> All pivot formulas use the **previous trading day's** High (H), Low (L), Close (C).

### Standard Pivot Points

```
PP = (H + L + C) / 3              ← Pivot Point (centre)

R1 = 2×PP − L                     ← Resistance 1
R2 = PP + (H − L)                 ← Resistance 2
R3 = H + 2×(PP − L)              ← Resistance 3

S1 = 2×PP − H                     ← Support 1
S2 = PP − (H − L)                 ← Support 2
S3 = L − 2×(H − PP)              ← Support 3
```

### Fibonacci Pivot Points
Uses Fibonacci ratios (0.382, 0.618, 1.0) applied to the previous day's range.

```
PP = (H + L + C) / 3

R1 = PP + 0.382 × (H − L)
R2 = PP + 0.618 × (H − L)
R3 = PP + 1.000 × (H − L)

S1 = PP − 0.382 × (H − L)
S2 = PP − 0.618 × (H − L)
S3 = PP − 1.000 × (H − L)
```

### Camarilla Pivot Points
Derived from the previous day's range and close. R4/S4 are the key breakout levels.

```
R1 = C + 1.1 × (H − L) / 12
R2 = C + 1.1 × (H − L) / 6
R3 = C + 1.1 × (H − L) / 4
R4 = C + 1.1 × (H − L) / 2      ← Major resistance / breakout level

S1 = C − 1.1 × (H − L) / 12
S2 = C − 1.1 × (H − L) / 6
S3 = C − 1.1 × (H − L) / 4
S4 = C − 1.1 × (H − L) / 2      ← Major support / breakdown level
```

### Swing Highs & Swing Lows (Price Action)
A swing high/low is a candle that is the local extreme across a window of N candles on each side.

```
N = 5  (lookback bars on each side)

swingHigh[i] = true  if  high[i] = max(high[i−N .. i+N])
swingLow[i]  = true  if  low[i]  = min(low[i−N  .. i+N])
```

- Recent swing highs → resistance zones
- Recent swing lows  → support zones
- The more times a level has been tested, the stronger it is

### Price Cluster Zones (Statistical)
Find price levels where multiple daily highs and lows have clustered historically.

```
ATR_14 = average(|H − L|) over last 14 days    ← Average True Range

bucket_size = ATR_14 × 0.5

bucket[price] = round(price / bucket_size) × bucket_size

strength[bucket] = count of daily highs and lows that fall into that bucket
```

Buckets with the highest touch count are the strongest historical S/R zones.
Sort by strength descending → top 3 are the key levels.
