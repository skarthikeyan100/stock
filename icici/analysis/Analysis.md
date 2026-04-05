# NIFTY ML Analysis Pipeline

Replays historical NIFTY quotes from MongoDB, forms OHLC candles at multiple intervals, calculates technical indicators across many parameter combinations, labels predictions using future price thresholds, and runs ML algorithms to find which indicator combinations best predict price direction.

## Run

```bash
# From icici/
npm run analysis

# Or directly with options
cd analysis && python3 main.py --threshold 10 --lookahead 10

# Custom output directory
python3 main.py --output-dir /path/to/output
```

### Usage Examples

```bash
# Basic usage (backward compatible - single threshold, 59 indicators)
python3 main.py --threshold 10

# With stop loss (realistic risk management)
python3 main.py --threshold 10 --stop-loss 5 --skip-ml

# Multi-threshold analysis (analyze 10 different price targets)
python3 main.py --thresholds 2,4,6,8,10,12,14,16,18,20

# Add reversed RSI indicators (80 indicators total: 59 + 21 reversed RSI)
python3 main.py --threshold 10 --reverse-rsi

# Generate indicator combinations (3,160 pairs from 80 indicators)
python3 main.py --threshold 10 --reverse-rsi --include-combinations

# Full power: all features + multiple thresholds + parallel execution + stop loss
python3 main.py --thresholds 2,4,6,8,10,12,14,16,18,20 \
  --reverse-rsi --include-combinations --parallel --stop-loss 5 --skip-ml

# Fast mode: skip ML training, only compute success rates (~10x faster)
python3 main.py --thresholds 2,4,6,8,10,12,14,16,18,20 \
  --reverse-rsi --include-combinations --skip-ml

# Compare different stop loss strategies
python3 main.py --threshold 10 --stop-loss 5 --skip-ml --output-dir output_sl5
python3 main.py --threshold 10 --stop-loss 10 --skip-ml --output-dir output_sl10
python3 main.py --threshold 10 --stop-loss 20 --skip-ml --output-dir output_sl20
```

### Analyzing threshold_comparison.csv (All 3,240 Indicators)

After running the analysis, the `threshold_comparison.csv` file contains **all indicators** across all thresholds (e.g., 32,401 rows for 10 thresholds × 3,240 indicators). Here's how to filter and analyze it:

```bash
cd /home/karthikeyan/work/icici/analysis/output

# View top 10 indicators for each threshold
awk -F, '$2 <= 10 {print}' threshold_comparison.csv | column -t -s,

# Find indicators with 100% success rate and enough signals
awk -F, '$6 == 100.0 && $4 > 10 {print}' threshold_comparison.csv | \
  column -t -s, | head -20

# Compare specific indicator across all thresholds
grep "RSI_14_80_20__AND__EMA_12_28" threshold_comparison.csv | \
  awk -F, '{printf "Threshold %2.0f: %s (good=%d, bad=%d, rate=%.2f%%)\n", $1, $3, $4, $5, $6}'

# Best performers: success rate > 70% AND total trades > 20
awk -F, 'NR>1 && $6 > 70 && ($4 + $5) > 20 {print}' threshold_comparison.csv | \
  sort -t, -k6 -rn | head -30 | column -t -s,

# Find consistent performers across multiple thresholds
# (appears in top 100 for at least 5 different thresholds)
awk -F, 'NR>1 && $2 <= 100 {count[$3]++; if($2==1) sum[$3]+=$6}
  END {for(i in count) if(count[i]>=5) print count[i],sum[i]/count[i],i}' \
  threshold_comparison.csv | sort -rn | head -20

# Filter by threshold and rank
awk -F, '$1 == 10 && $2 <= 50 {print}' threshold_comparison.csv | \
  column -t -s,

# Export top 10 of each threshold to separate file
awk -F, 'NR==1 || $2 <= 10' threshold_comparison.csv > top10_per_threshold.csv

# Find indicators that perform well at high thresholds (18-20 points)
awk -F, '$1 >= 18 && $6 > 60 && $4 > 5 {print}' threshold_comparison.csv | \
  sort -t, -k6 -rn | column -t -s,

# Indicators with low bad count (defensive)
awk -F, 'NR>1 && $5 <= 5 && $4 > 10 {print}' threshold_comparison.csv | \
  sort -t, -k6 -rn | head -20 | column -t -s,

# Create summary: count how many thresholds each indicator appears in top 50
awk -F, 'NR>1 && $2 <= 50 {count[$3]++}
  END {for(i in count) print count[i],i}' threshold_comparison.csv | \
  sort -rn > indicator_frequency_in_top50.txt

# Combination indicators only (contains __AND__)
awk -F, '$3 ~ /__AND__/ && $6 > 75 && $4 > 10 {print}' threshold_comparison.csv | \
  sort -t, -k6 -rn | head -20 | column -t -s,

# Individual indicators only (no __AND__)
awk -F, '$3 !~ /__AND__/ && $6 > 70 && $4 > 15 {print}' threshold_comparison.csv | \
  sort -t, -k6 -rn | column -t -s,

# Compare overall success rate across thresholds (shows difficulty)
awk -F, 'NR>1 && $2 == 1 {printf "Threshold %2.0f: overall_success_rate = %.2f%%\n", $1, $9}' \
  threshold_comparison.csv

# Find "rare but accurate" signals (high success, low frequency)
awk -F, '$6 == 100 && $4 >= 3 && $4 <= 10 {print}' threshold_comparison.csv | \
  sort -t, -k1,1n -k4,4rn | column -t -s,
```

**Python Analysis:**
```python
import pandas as pd

# Load comprehensive comparison
df = pd.read_csv("threshold_comparison.csv")

# Top 20 indicators by average success rate across all thresholds
indicator_avg = df.groupby('indicator').agg({
    'success_rate': 'mean',
    'good_count': 'sum',
    'bad_count': 'sum'
}).sort_values('success_rate', ascending=False)
print(indicator_avg.head(20))

# Find indicators that maintain >70% success across multiple thresholds
consistent = df[df['success_rate'] > 70].groupby('indicator').size()
consistent = consistent[consistent >= 5].sort_values(ascending=False)
print(f"\nIndicators with >70% success in 5+ thresholds:\n{consistent}")

# Best indicator per threshold
best_per_threshold = df.loc[df.groupby('threshold')['success_rate'].idxmax()]
print(f"\n{best_per_threshold[['threshold', 'indicator', 'success_rate']]}")

# Analyze by threshold difficulty
threshold_stats = df.groupby('threshold').first()[['overall_success_rate']]
print(f"\nThreshold difficulty:\n{threshold_stats}")
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--threshold` | None | **Single threshold** (backward compat). Overrides `--thresholds`. Price must move at least N points to be labeled "good" |
| `--thresholds` | 2,4,6,8,10,12,14,16,18,20 | **Multi-threshold** analysis. Comma-separated list of price movement thresholds |
| `--stop-loss` | Same as threshold | **Stop loss threshold**. Price movement in opposite direction that triggers "bad" label. Enables realistic risk management |
| `--reverse-rsi` | False | Add **reversed RSI indicators** (contrarian: overbought→buy, oversold→sell). Adds 21 indicators |
| `--include-combinations` | False | Generate **indicator pair combinations** (AND logic). Creates 1,711 pairs (59) or 3,160 pairs (80 with reversed RSI) |
| `--parallel` | False | Run threshold analyses in **parallel** using multiprocessing (faster but more CPU) |
| `--skip-ml` | False | Skip ML training (only compute **success rates**). ~10x faster for quick analysis |
| `--lookahead` | 10 | Number of candles ahead to check for price confirmation |
| `--output-dir` | `analysis/output/` | Directory for output CSVs |

**Performance Notes:**
- Single threshold (59 indicators): ~15s (with stop loss)
- Single threshold (3,240 features): ~5 minutes (with stop loss + sequential processing)
- 10 thresholds (3,240 features, parallel): ~15-20 minutes (with stop loss)
- Without stop loss: ~50% faster but less realistic

## Stop Loss Feature

### Overview

The stop loss feature enables **realistic risk management** by checking if the price moves against the predicted direction before reaching the target. This simulates actual trading where you would exit a losing position to limit losses.

### How It Works

**Without Stop Loss (Old Logic):**
```
Signal at t1: UP → Look ahead 10 candles → Did price reach +10? → good/bad
Signal at t2: UP → Look ahead 10 candles → Did price reach +10? → good/bad (OVERLAPPING!)
Signal at t3: DOWN → Look ahead 10 candles → Did price reach -10? → good/bad
```
❌ All signals evaluated independently (unrealistic - you can't take infinite positions)

**With Stop Loss (New Logic):**
```
Signal at t1: UP (close=24,500, target=24,510, stop=24,495)
  ├─ Scan next 10 candles for which hits first
  ├─ If price ≥ 24,510 first → label = "good" ✓
  ├─ If price ≤ 24,495 first → label = "bad" ✗
  └─ If neither hit → label = "oscillating" ~

Signals at t2, t3: IGNORED (scan already active from t1)
Signal at t4: Start new scan after t1 scan completes
```
✓ Sequential processing (realistic - one position at a time per indicator)

### Three-Label System

| Label | Meaning | Included in Success Rate? |
|-------|---------|:-------------------------:|
| **good** | Target hit before stop loss | ✓ Yes |
| **bad** | Stop loss hit before target | ✓ Yes |
| **oscillating** | Neither hit within lookahead window | ✗ No (excluded) |

**Success Rate Formula:** `good / (good + bad) × 100`

Oscillating trades are excluded because they represent "no trade" scenarios where the price stayed in a range without conviction.

### Example Scenarios

**Scenario 1: Good Trade**
```
Time    Close   Signal  Price Action                      Result
10:00   24500   UP      Start scan (target=24510, stop=24495)
10:01   24503           Price moving up                   (scanning...)
10:02   24512           Price hit 24512 (≥ 24510)         good ✓
10:03   24508   DOWN    IGNORED (scan just completed)
10:04   24502   DOWN    Start new scan
```

**Scenario 2: Bad Trade (Stop Loss Hit)**
```
Time    Close   Signal  Price Action                      Result
10:00   24500   UP      Start scan (target=24510, stop=24495)
10:01   24497           Price moving down                 (scanning...)
10:02   24492           Price hit 24492 (≤ 24495)         bad ✗
10:03   24488   UP      IGNORED (scan just completed)
10:04   24495   DOWN    Start new scan
```

**Scenario 3: Oscillating (No Conviction)**
```
Time    Close   Signal  Price Action                      Result
10:00   24500   UP      Start scan (target=24510, stop=24495)
10:01   24503           Price: 24503                      (scanning...)
10:02   24498           Price: 24498                      (scanning...)
...     ...             Price stays between 24495-24510
10:10   24502           Lookahead window expired          oscillating ~
10:11   24505   DOWN    Start new scan
```

### Impact on Results

**Example with threshold=10, stop-loss=5:**

| Metric | Value | % |
|--------|------:|--:|
| Good trades | 13,389 | 18.7% |
| Bad trades | 54,708 | 76.5% |
| Oscillating trades | 3,393 | 4.7% |
| **Success Rate** | **19.66%** | (good / (good+bad)) |

Compare to **no stop loss**: 57.93% success rate (unrealistic - ignores losses)

### Key Benefits

1. **Realistic Trading Simulation**
   - Mimics actual position management
   - One position at a time per indicator
   - Exit on stop loss (risk management)

2. **Better Risk Assessment**
   - Identifies indicators that trigger stop losses frequently
   - Reveals true win rate under risk constraints
   - Helps optimize stop loss levels

3. **Oscillating Detection**
   - Finds indicators that give indecisive signals
   - High oscillating count = indicator lacks conviction
   - Useful for filtering out weak indicators

### Usage Tips

**Finding Optimal Stop Loss:**
```bash
# Test different stop loss ratios
for sl in 5 10 15 20; do
  python3 main.py --threshold 10 --stop-loss $sl --skip-ml \
    --output-dir output_sl${sl}
done

# Compare success rates
grep "overall_success_rate" output_sl*/threshold_10/indicator_success_rates.csv
```

**Analyzing Oscillating Trades:**
```bash
# Find indicators with many oscillating trades
awk -F, 'NR>1 && $3>5 {print $3,$1}' \
  output/threshold_10/indicator_success_rates.csv | sort -rn

# Filter indicators with low oscillating rate
awk -F, 'NR>1 && $3==0 && $4>20 {print}' \
  output/threshold_10/indicator_success_rates.csv
```

**Best Practices:**
- Use `--skip-ml` for faster iterations when testing stop loss values
- Start with stop loss = 50% of threshold (e.g., threshold=10, stop-loss=5)
- Compare multiple stop loss values to find optimal risk/reward
- Exclude indicators with high oscillating counts (>20% of total trades)
- Focus on indicators with success rate >60% AND total trades >20

## Pipeline Steps

### Step 1: Data Loading (`data_loader.py`)

Connects to MongoDB (`localhost:27017/stocks`) and reads the `NiftyQuote` collection. Currently filtered to `day='Friday'` (configurable in `config.py`).

Each document has: `ltp` (last traded price), `ltt` (last traded time as Unix timestamp), `open`, `high`, `low`.

### Step 2: Candle Formation (`candle_builder.py`)

Groups raw quotes into time-interval buckets and computes per-candle:

- **OHLC**: open, close, high, low
- **Statistics**: mean, median, standard deviation (population), MAD (median absolute deviation)
- **Pivot Points**: S1, R1, S2, R2 using `P = (H+L+C)/3`
- **Derived**: rate of change `(close-open)/open * 100`, range `(high-low)`, diff `(close-open)`

**Intervals**: 1min (60s), 5min (300s), 10min (600s), 15min (900s), 20min (1200s), 30min (1800s)

### Step 3: Technical Indicators (`indicators.py`, `feature_builder.py`, `combination_builder.py`)

For each candle, computes indicators on all accumulated closing prices up to that point. Each indicator returns UP, DOWN, or NEUTRAL.

#### Individual Indicators

| Indicator | Count | Parameters |
|-----------|:---:|-------------|
| **RSI** | 21 | Periods: 5, 10, 14, 15, 20, 25, 30 x Thresholds: (70/30), (80/20), (90/10) |
| **RSI Reversed** | 21 | *Same params* — contrarian logic (enabled with `--reverse-rsi`) |
| **MACD** | 7 | Short/Long/Signal: (4,8,3), (8,16,6), (12,24,9), (12,26,9), (16,32,12), (20,40,15), (24,48,18) |
| **Bollinger Bands** | 18 | Periods: 5, 10, 15, 20, 25, 30 x Deviations: 1, 1.5, 2 |
| **EMA Crossover** | 9 | Short/Long: (5,13), (9,21), (12,28), (15,35), (18,42), (21,49), (24,56), (27,63), (30,70) |
| **ADX** | 2 | Periods: 14, 20 |
| **Stochastic** | 2 | K/D: (14,3), (14,5) |
| **Total (base)** | **59** | Default configuration |
| **Total (with reversed RSI)** | **80** | With `--reverse-rsi` flag |

#### Indicator Combinations

When `--include-combinations` is enabled, all indicator pairs are generated using **AND logic** (both must agree on direction):

| Configuration | Individual Indicators | Pair Combinations | Total Features |
|---------------|:---:|:---:|:---:|
| **Base** | 59 | 1,711 | **1,770** |
| **With Reversed RSI** | 80 | 3,160 | **3,240** |

**Combination Logic:**
- Format: `RSI_10_70_30__AND__EMA_18_42`
- Signal: UP if both indicators are UP, DOWN if both are DOWN, else NEUTRAL
- Advantage: Higher precision (filters out contradictory signals)

**Example Combinations:**
- `RSI_14_80_20__AND__EMA_12_28` — RSI + EMA crossover agreement
- `Bollinger_5_1__AND__MACD_12_24_9` — Bollinger breakout + MACD confirmation
- `EMA_15_35__AND__RSI_5_70_30_REV` — EMA crossover + reversed RSI contrarian signal

#### Indicator Logic

- **RSI (Normal)**: RSI < oversold → UP (price expected to rise from oversold), RSI > overbought → DOWN, else NEUTRAL
- **RSI (Reversed)**: RSI > overbought → UP (contrarian: buy the strength), RSI < oversold → DOWN (sell the weakness), else NEUTRAL
- **MACD**: MACD line > signal line → UP, else DOWN
- **Bollinger**: Price > upper band → UP (breakout), price < lower band → DOWN, else NEUTRAL
- **EMA Crossover**: Short EMA crosses above long → UP, crosses below → DOWN, else NEUTRAL
- **ADX**: ADX < 20 → NEUTRAL (weak trend), +DI > -DI → UP, else DOWN
- **Stochastic**: %K < 20 and %K > %D → UP (oversold bounce), %K > 80 and %K < %D → DOWN, else NEUTRAL

### Step 4: Labeling (`labeler.py`)

For each candle row:

1. **Majority vote** across all indicator columns (59, 80, 1,770, or 3,240 depending on flags) determines predicted direction (UP if more UPs than DOWNs, DOWN if more DOWNs, NEUTRAL if tied)
2. Looks at raw price data within the next `lookahead` candles' time window
3. **UP prediction**: labeled "good" if any future price >= `close + threshold`
4. **DOWN prediction**: labeled "good" if any future price <= `close - threshold`
5. No confirmation found → "bad"; tied vote → "neutral"

Also computes **per-indicator success rates** independently (each indicator/combination evaluated against the same future price threshold). With combinations enabled, this can analyze **3,240 indicators** individually to find the best performers.

### Step 5: ML Analysis (`ml_engine.py`)

**Feature encoding**: Indicator values are ordinally encoded (UP=1, NEUTRAL=0, DOWN=-1). Numeric features (stddev, mad, range, rate_of_change, volume, S1/R1/S2/R2) are included as-is. Features are scaled (StandardScaler) for LogisticRegression and SVM.

**Models trained**:

| Model | Notes |
|-------|-------|
| DecisionTree | max_depth=10 |
| RandomForest | 100 estimators |
| LogisticRegression | max_iter=5000, scaled features |
| GradientBoosting | 100 estimators |
| SVM | RBF kernel, scaled features |

**Evaluation**: Stratified K-fold cross-validation (up to 10 folds), train/test split (80/20), confusion matrix, classification report, feature importance ranking.

**Per-interval analysis**: Each interval is evaluated separately to identify which timeframe is most predictable.

**Multi-threshold orchestration**: When multiple thresholds are specified, the pipeline runs Steps 4-5 (labeling + ML) for each threshold independently, storing results in separate directories. This enables comparison of which indicators/combinations perform best at different price targets.

**Parallel execution**: With `--parallel`, threshold analyses run concurrently using Python's multiprocessing.Pool, reducing total runtime from ~10-15 minutes (serial) to ~2-3 minutes (parallel) for 10 thresholds with 3,240 features.

## Output Files

### Directory Structure

**Single threshold** (backward compatible):
```
output/
├── candle_features_full.csv      # Unlabeled feature matrix
├── threshold_10/                 # Results for 10-point threshold
│   ├── candle_features.csv       # Labeled feature matrix
│   ├── indicator_success_rates.csv
│   ├── model_comparison.csv
│   ├── feature_importance.csv
│   └── interval_analysis.csv
└── threshold_comparison.csv      # Summary (single row)
```

**Multi-threshold** (with `--thresholds 2,4,6,8,10,12,14,16,18,20`):
```
output/
├── candle_features_full.csv      # Unlabeled, all features (~14MB with combinations)
├── threshold_2/                  # Results for 2-point threshold
│   ├── candle_features.csv       # Labeled with threshold=2
│   ├── indicator_success_rates.csv  # 3,241 rows (with combinations)
│   ├── model_comparison.csv
│   ├── feature_importance.csv
│   └── interval_analysis.csv
├── threshold_4/
│   └── (same structure)
├── threshold_6/
│   └── (same structure)
├── ...
├── threshold_20/
│   └── (same structure)
└── threshold_comparison.csv      # Cross-threshold summary (10 rows)
```

### File Details

#### `candle_features_full.csv`

The **unlabeled** feature matrix — one row per candle per interval. This file is shared across all thresholds.

**Columns**:
- **Base (59 indicators)**: ~82 columns
- **With reversed RSI (80 indicators)**: ~101 columns
- **With combinations (3,240 features)**: ~3,320 columns (~14MB file)

**Column types**:
- `interval`, `interval_label`, `time` — candle identification
- `open`, `close`, `high`, `low` — OHLC prices
- `average`, `median`, `stddev`, `mad` — statistical measures
- `S1`, `R1`, `S2`, `R2` — pivot point support/resistance levels
- `rate_of_change`, `range`, `diff` — derived metrics
- `volume`, `buy_qty`, `sell_qty` — volume data (if available in source)
- `RSI_5_70_30` through `Stoch_14_5` — base indicator columns
- `RSI_5_70_30_REV` through `RSI_30_90_10_REV` — reversed RSI (if enabled)
- `RSI_5_70_30__AND__RSI_5_80_20` through combinations — pair columns (if enabled)

All indicator columns have values: `UP`, `DOWN`, `NEUTRAL`, or `None`.

#### `threshold_N/candle_features.csv`

**Labeled** feature matrix for specific threshold. Same columns as `candle_features_full.csv` plus:
- `predicted_direction` — majority vote result (UP/DOWN/NEUTRAL)
- `label` — good/bad/neutral based on future price threshold

#### `threshold_N/indicator_success_rates.csv`

Per-indicator success rate with stop loss tracking. Each indicator is evaluated sequentially (one position at a time).

| Column | Description |
|--------|-------------|
| `indicator` | Indicator name (e.g., `RSI_10_80_20`, `RSI_14_80_20__AND__EMA_12_28`) |
| `good` | Count of times target was hit before stop loss |
| `bad` | Count of times stop loss was hit before target |
| `oscillating` | **NEW**: Count of times neither target nor stop loss was hit within lookahead window |
| `total` | good + bad (excludes oscillating and NEUTRAL signals) |
| `success_rate` | `good / total * 100` — percentage of winning trades (oscillating excluded) |

**Rows**:
- Base: 60 (header + 59 indicators)
- With combinations: 3,241 (header + 80 individual + 3,160 pairs)

Sorted by success_rate descending. **Top performers often include combinations!**

**Example entries (threshold=10, stop-loss=5)**:
```csv
indicator,good,bad,oscillating,total,success_rate
RSI_15_70_30__AND__MACD_12_24_9,2,0,0,2,100.0
RSI_10_90_10,9,2,0,11,81.82
RSI_10_80_20,33,19,1,52,63.46
EMA_5_13,43,108,6,151,28.48
```

**Key Insights:**
- High `oscillating` count (>20% of signals) suggests indicator is indecisive
- Low `total` with high success rate may indicate rare but accurate signals
- Compare `good` vs `bad` to assess win rate under risk management

#### `threshold_N/model_comparison.csv`

Comparison of all ML models on the combined dataset (all intervals).

| Column | Description |
|--------|-------------|
| `model` | Model name (DecisionTree, RandomForest, LogisticRegression, GradientBoosting, SVM) |
| `cv_mean` | Mean cross-validation accuracy |
| `cv_std` | Standard deviation of cross-validation accuracy |
| `test_accuracy` | Accuracy on held-out test set (20%) |

Sorted by cv_mean descending. The model with highest cv_mean is the best overall model.

#### `threshold_N/feature_importance.csv`

Ranked list of features by importance, averaged across tree-based models (DecisionTree, RandomForest, GradientBoosting) and coefficient magnitude (LogisticRegression).

| Column | Description |
|--------|-------------|
| `feature` | Feature name (indicator, combination, or numeric feature) |
| `avg_importance` | Average importance score across models that report feature importance |
| `rank` | Rank (1 = most important) |

Top 50 features are included. **Combinations often rank in top 10!**

**Example top entries (threshold=10)**:
```csv
feature,avg_importance,rank
Bollinger_5_1,0.221854,1
EMA_15_35__AND__RSI_5_70_30_REV,0.20674,2
EMA_21_49__AND__ADX_20,0.200415,3
Bollinger_5_1__AND__EMA_9_21,0.183896,4
```

#### `threshold_N/interval_analysis.csv`

Per-interval ML results — shows which timeframe is most predictable.

| Column | Description |
|--------|-------------|
| `interval` | Timeframe label (1min, 5min, etc.) |
| `best_model` | Best performing model for this interval |
| `best_cv_accuracy` | Cross-validation accuracy of the best model |
| `top_3_features` | Three most important features for this interval |

Intervals with fewer than 20 labeled samples show "insufficient data".

#### `threshold_comparison.csv`

**Cross-threshold summary** — compares results across all analyzed thresholds.

| Column | Description |
|--------|-------------|
| `threshold` | Price movement threshold (2, 4, 6, ..., 20) |
| `top_indicator` | Indicator/combination with highest success rate |
| `good_count` | **NEW**: Number of good predictions for the top indicator only |
| `bad_count` | **NEW**: Number of bad predictions for the top indicator only |
| `top_success_rate` | Success rate % of top indicator (good_count / (good_count + bad_count) × 100) |
| `top_5_indicators` | **NEW**: Top 5 best-performing indicators, separated by semicolons |
| `total_good` | Sum of all good predictions across all 3,240 indicators |
| `total_bad` | Sum of all bad predictions across all 3,240 indicators |
| `overall_success_rate` | **NEW**: Overall success rate across all indicators (total_good / (total_good + total_bad) × 100) |
| `best_model` | Best ML model for this threshold |
| `best_cv_accuracy` | Cross-validation accuracy of best model |
| `best_test_accuracy` | Test accuracy of best model |

**Key Insights**:
- **`good_count` and `bad_count`** show how many times the top indicator triggered. Low counts (e.g., 4) mean rare but accurate signals.
- **`overall_success_rate`** reveals which thresholds are easier to predict across all indicators (higher = easier target).
- **`top_5_indicators`** helps identify multiple reliable indicators for each price target.
- Lower thresholds (2-4 points) have higher overall success rates (~80-93%) - easier targets
- Higher thresholds (18-20 points) have lower overall success rates (~32-36%) - harder targets but stronger conviction
- Different indicator combinations excel at different price targets

**Example**:
```csv
threshold,top_indicator,good_count,bad_count,top_success_rate,top_5_indicators,total_good,total_bad,overall_success_rate,best_model,best_cv_accuracy,best_test_accuracy
2,RSI_30_70_30__AND__EMA_9_21,17,0,100.0,RSI_30_70_30__AND__EMA_9_21; Bollinger_20_1.5__AND__RSI_10_90_10_REV; ...,110442,8037,93.22,GradientBoosting,0.9542,0.9619
10,RSI_14_80_20__AND__EMA_12_28,4,0,100.0,RSI_14_80_20__AND__EMA_12_28; RSI_14_80_20__AND__RSI_20_70_30; ...,68638,49841,57.93,GradientBoosting,0.7125,0.6571
20,RSI_20_70_30__AND__RSI_25_80_20,7,0,100.0,RSI_20_70_30__AND__RSI_25_80_20; EMA_27_63__AND__RSI_15_90_10_REV; ...,38447,80032,32.45,GradientBoosting,0.8422,0.8000
```

**How to use `top_5_indicators`**:
- Parse the semicolon-separated list to get multiple reliable indicators
- Cross-reference with individual `indicator_success_rates.csv` for detailed stats
- Use multiple indicators together for ensemble predictions

## Node.js Analysis Tool

A TypeScript equivalent of `focused_indicator.py` + `labeler.py` sequential scan is available in the server project. It uses the **same shared library** as the live trading server, guaranteeing zero logic differences.

### Run

```bash
# From icici/
npm run analyze:focused
# Equivalent to: node ./dist/tools/analyze.js --indicators RSI_5_80_20,EMA_30_70 --threshold 10 --stopLoss 5

# Custom indicators / thresholds
npm run analyze -- --indicators RSI_5_80_20,EMA_30_70,MACD_12_26_9 --threshold 8 --stopLoss 4

# Save results to CSV
npm run analyze -- --indicators RSI_5_80_20,EMA_30_70 --threshold 10 --stopLoss 5 --output focused_output.csv

# Verify Node.js closes match Python closes exactly
npm run analyze:check 2>/dev/null > /tmp/node.txt
python3 analysis/check_indicators.py 2>/dev/null > /tmp/py.txt
diff /tmp/py.txt /tmp/node.txt
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--indicators` | `RSI_5_80_20,EMA_30_70` | Comma-separated indicator names |
| `--threshold` | `10` | Target profit in index points |
| `--stopLoss` | `5` | Stop-loss in index points |
| `--interval` | `60` | Candle interval in seconds |
| `--output` | *(none)* | Optional CSV output path |

### Supported Indicator Names

Format matches Python column names exactly:

| Type | Format | Example |
|------|--------|---------|
| RSI | `RSI_{period}_{overbought}_{oversold}` | `RSI_5_80_20` |
| RSI Reversed | `RSI_{period}_{overbought}_{oversold}_REV` | `RSI_5_80_20_REV` |
| EMA Crossover | `EMA_{short}_{long}` | `EMA_30_70` |
| MACD | `MACD_{short}_{long}_{signal}` | `MACD_12_26_9` |
| Bollinger | `Bollinger_{period}_{deviations}` | `Bollinger_20_2` |
| ADX | `ADX_{period}` | `ADX_14` |
| Stochastic | `Stoch_{k}_{d}` | `Stoch_14_3` |

### Shared Library

The Node.js tool and the live server both import from:

```
src/lib/
├── candle-builder.ts    # buildCandles() — identical algorithm to Python CandleBuilder._build_interval
├── indicators.ts        # calcRSI, calcEMACrossover, calcMACD, calcBollinger, calcADX, calcStochastic
└── indicator-config.ts  # RSI_PARAMS, EMA_PARAMS, MACD_PARAMS, BOLLINGER_PARAMS, etc.
```

Key guarantees:
- **Candle boundary**: append-first + drift-start (matches Python `start_time = ltt[i]`)
- **RSI**: manual Wilder smoothing (matches Python `indicators.py rsi_trend()`)
- **EMA**: seeded EMA `result[0] = prices[0]` (matches Python `_ema()`)
- **MACD**: seeded EMA on same-length array, element-wise subtraction (matches Python)
- **Bollinger**: population std `/N` (matches Python `np.std()`)

---

## Node.js Pipeline (replaces Python main.py — no ML)

`src/tools/pipeline.ts` is a full Node.js port of the Python pipeline, excluding ML training.
It generates the same `threshold_comparison.csv` and `indicator_success_rates.csv` using the
shared TypeScript library, so results are identical to `python3 main.py --skip-ml`.

### Run

```bash
# From icici/
npm run pipeline                  # All 10 thresholds (2–20), 59 indicators, all 6 intervals
npm run pipeline:fast             # Thresholds 5,10,15,20 only (faster)
npm run pipeline:combos           # 59 indicators + C(59,2)=1711 AND pairs = 1770 total
npm run pipeline:full             # 80 indicators (59 + 21 reversed RSI) + C(80,2)=3160 pairs = 3240 total

# Custom usage
npm run pipeline -- --thresholds 5,10,15 --stopLoss 5 --outputDir ./my_output
npm run pipeline -- --reverseRsi --combinations --thresholds 10 --stopLoss 5
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--thresholds` | `2,4,6,8,10,12,14,16,18,20` | Comma-separated threshold list |
| `--stopLoss` | Same as threshold | Fixed stop-loss points (or per-threshold if omitted) |
| `--reverseRsi` | *(flag, off)* | Add 21 reversed RSI indicators (overbought→UP, oversold→DOWN). Total becomes 80 |
| `--combinations` | *(flag, off)* | Include AND pair combinations: C(59,2)=1711 or C(80,2)=3160 |
| `--outputDir` | `analysis/output/` | Output directory |

### Indicator Counts

| Flags | Individual | AND Pairs | Total |
|-------|:---:|:---:|:---:|
| *(none)* | 59 | 0 | **59** |
| `--reverseRsi` | 80 | 0 | **80** |
| `--combinations` | 59 | 1,711 | **1,770** |
| `--reverseRsi --combinations` | 80 | 3,160 | **3,240** |

### How It Differs from analyze.ts

| Feature | `analyze.ts` | `pipeline.ts` |
|---------|-------------|----------------|
| Scan type | AND-combined across all selected indicators | **Per-indicator** (59 independent scans) |
| Scan expiry | 30-min hold time | **No time limit** (scan until hit or end of data) |
| Intervals | One (configurable, default 1min) | **All 6 intervals** (1min–30min) |
| Output | Table + optional CSV | `threshold_comparison.csv` + per-threshold CSVs |
| Use case | Quick single-combo analysis | Full benchmark across all indicators |

### Output Structure

```
analysis/output/
├── threshold_2/
│   └── indicator_success_rates.csv   # All 59 indicators × all intervals
├── threshold_4/
│   └── ...
├── threshold_10/
│   └── indicator_success_rates.csv
├── ...
└── threshold_comparison.csv          # Ranked indicators per threshold × interval
```

### `threshold_comparison.csv` Columns

| Column | Description |
|--------|-------------|
| `threshold` | Price movement threshold |
| `interval_label` | Candle interval (1min, 5min, …, 30min) |
| `rank` | Rank within this threshold+interval (1 = best) |
| `indicator` | Indicator name |
| `good_count` | Times target was hit first |
| `bad_count` | Times stop-loss was hit first |
| `success_rate` | `good / (good + bad) × 100` (oscillating excluded) |
| `total_good` | Sum of good across all indicators (this threshold+interval) |
| `total_bad` | Sum of bad across all indicators |
| `overall_success_rate` | `total_good / (total_good + total_bad) × 100` |

---

## Module Structure

```
analysis/                          # Python pipeline (ML + multi-threshold analysis)
├── main.py                  # Entry point — orchestrates multi-threshold pipeline
├── config.py                # Constants, parameter combos, CLI args (multi-threshold)
├── data_loader.py           # MongoDB → pandas DataFrame
├── candle_builder.py        # Raw quotes → OHLC candles at 6 intervals
├── indicators.py            # RSI, MACD, Bollinger, EMA, ADX, Stochastic + reversed RSI
├── feature_builder.py       # Candles + indicators → 80-column DataFrame (with reversed RSI)
├── combination_builder.py   # Generates indicator pair combinations (AND logic)
├── labeler.py               # Future-price threshold labeling + per-indicator success rates
├── ml_engine.py             # 5 ML models, CV, feature importance, per-interval analysis
├── requirements.txt         # Python dependencies
├── Analysis.md              # This documentation
└── output/                  # Generated CSV files
    ├── threshold_2/
    ├── threshold_4/
    ├── ...
    └── threshold_comparison.csv

src/lib/                           # Shared TypeScript library (server + analysis)
├── candle-builder.ts        # buildCandles() — same algorithm as candle_builder.py
├── indicators.ts            # calcRSI, calcEMA, calcMACD, calcBollinger, calcADX, calcStoch
└── indicator-config.ts      # Central parameter lists (matches config.py)

src/tools/                         # Node.js analysis tools
├── pipeline.ts              # Full pipeline — all 59 indicators × 6 intervals × N thresholds
│                            # (= main.py --skip-ml, no ML training)
├── analyze.ts               # Focused indicator analysis + AND-combine (= focused_indicator.py)
└── check_indicators.ts      # RSI/EMA comparison tool for verifying Python ↔ Node parity
```

## Key Features

✅ **Multi-threshold analysis** — Analyze 10 different price targets in one run
✅ **Reversed RSI indicators** — Test contrarian strategies (overbought→buy)
✅ **Indicator combinations** — Discover powerful pairs (3,160 combinations)
✅ **Parallel execution** — 5-10x faster with multiprocessing
✅ **ML feature importance** — Identify best individual + combined indicators
✅ **Cross-threshold comparison** — Find optimal price targets per indicator
✅ **Backward compatible** — Original single-threshold usage still works

## Dependencies

```
pymongo>=4.0       # MongoDB connection
pandas>=2.0        # DataFrames
numpy>=1.24        # Numeric computation
scikit-learn>=1.3   # ML models
ta>=0.11.0         # Technical analysis (installed but indicators are custom-implemented)
matplotlib>=3.7    # Visualization (available for future use)
seaborn>=0.12      # Visualization (available for future use)
```

Install: `pip install -r analysis/requirements.txt`

## Tips & Best Practices

### Quick Exploration

Start with a fast run to identify promising thresholds:
```bash
python3 main.py --thresholds 2,6,10,14,18 --skip-ml
```
This computes success rates for all 3,240 indicators across 5 thresholds in ~1-2 minutes (no ML training).

### Finding Best Indicators

1. Run with combinations to discover powerful pairs:
   ```bash
   python3 main.py --threshold 10 --reverse-rsi --include-combinations
   ```

2. Check `threshold_10/indicator_success_rates.csv` sorted by success_rate
3. Look for combinations with high success rates AND sufficient samples (total > 20)

### Optimizing Performance

**For quick iterations:**
- Use `--skip-ml` (10x faster)
- Use fewer thresholds (e.g., `--thresholds 5,10,15`)
- Disable combinations for initial exploration

**For comprehensive analysis:**
- Use `--parallel` (5x faster than serial)
- Run overnight for full 10-threshold analysis with combinations

### Interpreting Results

**Success Rate Analysis:**
- **High success rate + low total**: May be overfitting or cherry-picked scenarios
- **Moderate success rate + high total**: More reliable indicator
- **Look for combinations** that beat their individual components

**ML Feature Importance:**
- Features ranked 1-10 are strongest predictors
- Compare individual indicators vs combinations
- Check if reversed RSI outperforms normal RSI

**Threshold Comparison:**
- Lower thresholds (2-6): More signals, higher success rate, smaller profit per trade
- Higher thresholds (14-20): Fewer signals, lower success rate, larger profit per trade
- Find the sweet spot for your risk tolerance

### Common Workflows

**Workflow 1: Find optimal threshold for specific indicator**
```bash
# Run full threshold sweep
python3 main.py --thresholds 2,4,6,8,10,12,14,16,18,20

# Check threshold_comparison.csv to see which threshold has best success rate
```

**Workflow 2: Discover new indicator combinations**
```bash
# Generate all combinations with reversed RSI
python3 main.py --threshold 10 --reverse-rsi --include-combinations

# Sort threshold_10/indicator_success_rates.csv by success_rate
# Filter combinations (contains "__AND__")
# Test top 10 combinations manually or in backtest
```

**Workflow 3: Compare strategies**
```bash
# Run A: Normal RSI only
python3 main.py --threshold 10 --output-dir output/normal

# Run B: Reversed RSI only
python3 main.py --threshold 10 --reverse-rsi --output-dir output/reversed

# Compare indicator_success_rates.csv from both runs
```

### Data Requirements

- **Minimum**: 200+ quotes for meaningful candle formation
- **Recommended**: 1,000+ quotes (full trading day)
- **Current default**: Friday data only (~45K quotes)
- **To expand**: Modify `MONGO_DAY_FILTER` in `config.py`

### Troubleshooting

**"Not enough labeled data for ML training"**
- Increase `--lookahead` to capture more future price movements
- Decrease `--threshold` to get more confirmed predictions
- Expand data range (load multiple days instead of just Friday)

**"ML training very slow"**
- Use `--skip-ml` to only compute success rates
- Disable `--include-combinations` for faster runs
- Reduce `CV_FOLDS` in `config.py` (default: 10)

**"Memory error with combinations"**
- 3,240 features on 577 rows ≈ 15MB RAM (manageable)
- If running multiple thresholds in parallel, reduce worker count
- On low-memory systems, run serially (no `--parallel`)

### Advanced: Custom Indicator Parameters

To add new indicator variations:

1. Edit `RSI_PARAMS`, `MACD_PARAMS`, etc. in `config.py`
2. Re-run analysis — new indicators auto-included
3. New combinations auto-generated if `--include-combinations` enabled

Example (add RSI with 85/15 threshold):
```python
# In config.py
RSI_PARAMS = [
    # ... existing params
    {"period": 14, "overbought": 85, "oversold": 15},  # Tighter threshold
]
```
