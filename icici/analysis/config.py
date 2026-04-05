import argparse
import os

# MongoDB
MONGO_URI = "mongodb://localhost:27017"
MONGO_DB = "stocks"
MONGO_COLLECTION = "NiftyQuote"

# Candle intervals in seconds
INTERVALS = [60, 300, 600, 900, 1200, 1800]
INTERVAL_LABELS = {
    60: "1min", 300: "5min", 600: "10min",
    900: "15min", 1200: "20min", 1800: "30min",
}

# RSI: 7 periods x 3 threshold pairs = 21 combos
RSI_PARAMS = [
    {"period": p, "overbought": ob, "oversold": os}
    for p in [5, 10, 14, 15, 20, 25, 30]
    for ob, os in [(70, 30), (80, 20), (90, 10)]
]

# MACD: 7 combos
MACD_PARAMS = [
    {"short": 4, "long": 8, "signal": 3},
    {"short": 8, "long": 16, "signal": 6},
    {"short": 12, "long": 24, "signal": 9},
    {"short": 12, "long": 26, "signal": 9},
    {"short": 16, "long": 32, "signal": 12},
    {"short": 20, "long": 40, "signal": 15},
    {"short": 24, "long": 48, "signal": 18},
]

# Bollinger Bands: 6 periods x 3 deviations = 18 combos
BOLLINGER_PARAMS = [
    {"period": p, "num_deviations": d}
    for p in [5, 10, 15, 20, 25, 30]
    for d in [1, 1.5, 2]
]

# EMA Crossover: 9 combos
EMA_PARAMS = [
    {"short": 5, "long": 13},
    {"short": 9, "long": 21},
    {"short": 12, "long": 28},
    {"short": 15, "long": 35},
    {"short": 18, "long": 42},
    {"short": 21, "long": 49},
    {"short": 24, "long": 56},
    {"short": 27, "long": 63},
    {"short": 30, "long": 70},
]

# ADX params
ADX_PARAMS = [
    {"period": 14},
    {"period": 20},
]

# Stochastic params
STOCHASTIC_PARAMS = [
    {"k_period": 14, "d_period": 3},
    {"k_period": 14, "d_period": 5},
]

# Labeling
DEFAULT_THRESHOLD = 10   # NIFTY points
DEFAULT_LOOKAHEAD = 10   # candles

# Multi-threshold analysis
THRESHOLDS_DEFAULT = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]

# ML
TEST_SIZE = 0.2
CV_FOLDS = 10
RANDOM_STATE = 42

# Output
DEFAULT_OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")


def parse_args():
    parser = argparse.ArgumentParser(description="NIFTY ML Analysis Pipeline")

    # Multi-threshold support (backward compatible)
    parser.add_argument(
        "--threshold", type=float, default=None,
        help="Single threshold (backward compat). Overrides --thresholds.",
    )
    parser.add_argument(
        "--thresholds", type=str, default="2,4,6,8,10,12,14,16,18,20",
        help="Comma-separated threshold list (default: 2,4,6,8,10,12,14,16,18,20)",
    )

    # Feature engineering flags
    parser.add_argument(
        "--reverse-rsi", action="store_true",
        help="Add reversed RSI indicators (overbought→buy, oversold→sell)",
    )
    parser.add_argument(
        "--include-combinations", action="store_true",
        help="Generate indicator pair combinations",
    )

    # Performance
    parser.add_argument(
        "--parallel", action="store_true",
        help="Run threshold analyses in parallel (faster but more CPU)",
    )
    parser.add_argument(
        "--skip-ml", action="store_true",
        help="Skip ML training (only compute success rates)",
    )

    # Existing args
    parser.add_argument(
        "--lookahead", type=int, default=DEFAULT_LOOKAHEAD,
        help=f"Number of candles to look ahead for labeling (default: {DEFAULT_LOOKAHEAD})",
    )
    parser.add_argument(
        "--stop-loss", type=float, default=None,
        help="Stop loss threshold (defaults to same as threshold)",
    )
    parser.add_argument(
        "--output-dir", type=str, default=DEFAULT_OUTPUT_DIR,
        help=f"Directory for output CSVs (default: {DEFAULT_OUTPUT_DIR})",
    )

    args = parser.parse_args()

    # Parse thresholds list (handle backward compat)
    if args.threshold is not None:
        args.thresholds = [args.threshold]
    else:
        args.thresholds = [float(t.strip()) for t in args.thresholds.split(",")]

    return args
