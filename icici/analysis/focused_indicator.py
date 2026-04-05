"""
Standalone focused indicator analysis.
Computes RSI_5_80_20, EMA_30_70, RSI_5_80_20__AND__EMA_30_70, and label at candle level.
Does not modify the main analysis pipeline.

Label logic matches labeler.per_indicator_success_rates exactly:
  - Sequential scan: signals during an active scan are ignored
  - Stop loss: whichever hits first (target or stop loss) determines good/bad
  - Scans all future candles (no time boundary)
  - Oscillating (neither target nor stop loss ever hit): label = None

Usage:
    python3 focused_indicator.py [--output-dir output/] [--threshold 10] [--stop-loss 10] [--interval 1800] [--max-hold-minutes 30]

NOTE: The server (RuleBasedStrategy) uses option-price % for target/stop loss (e.g. targetProfitPercent=10
means 10% of option entry price), while --threshold/--stop-loss here are in NIFTY index *points*.
They measure different things and cannot directly match. Align --interval and --max-hold-minutes to
the server values (1800s, 30 min) to at least compare the same set of signals.
"""
import os
import argparse
import numpy as np
import pandas as pd
from dataclasses import asdict
from data_loader import DataLoader
from candle_builder import CandleBuilder
import indicators as ind
from config import INTERVAL_LABELS, DEFAULT_OUTPUT_DIR, DEFAULT_THRESHOLD

RSI_COL = ind.rsi_column_name(5, 80, 20)   # "RSI_5_80_20"
EMA_COL = ind.ema_column_name(30, 70)      # "EMA_30_70"
AND_COL = f"{RSI_COL}__AND__{EMA_COL}"    # "RSI_5_80_20__AND__EMA_30_70"


def _combine(val1, val2):
    if val1 is None or val2 is None:
        return None
    if val1 == val2 and val1 in ("UP", "DOWN"):
        return val1
    return "NEUTRAL"


def _resolve_scan(active_scan, current_time, raw_ltt, raw_ltp, threshold, stop_loss):
    """Mirrors labeler._resolve_scan exactly."""
    scan_start = active_scan["candle_time"]
    scan_end   = active_scan["scan_end_time"]
    scan_close = active_scan["candle_close"]
    scan_dir   = active_scan["direction"]

    effective_end = min(current_time, scan_end)
    mask = (raw_ltt > scan_start) & (raw_ltt <= effective_end)
    scan_prices = raw_ltp[mask]

    if len(scan_prices) == 0:
        return "oscillating" if current_time >= scan_end else "continue"

    if scan_dir == "UP":
        target_level   = scan_close + threshold
        stoploss_level = scan_close - stop_loss
        t_hits = np.where(scan_prices >= target_level)[0]
        s_hits = np.where(scan_prices <= stoploss_level)[0]
    else:  # DOWN
        target_level   = scan_close - threshold
        stoploss_level = scan_close + stop_loss
        t_hits = np.where(scan_prices <= target_level)[0]
        s_hits = np.where(scan_prices >= stoploss_level)[0]

    t_idx = t_hits[0] if len(t_hits) > 0 else None
    s_idx = s_hits[0] if len(s_hits) > 0 else None

    if t_idx is not None and s_idx is not None:
        return "good" if t_idx < s_idx else "bad"
    elif t_idx is not None:
        return "good"
    elif s_idx is not None:
        return "bad"
    else:
        return "oscillating" if current_time >= scan_end else "continue"


def build_focused_df(candles: list, raw_quotes: pd.DataFrame,
                     threshold: float, stop_loss: float, max_hold_seconds: float = None) -> pd.DataFrame:
    raw_ltt = raw_quotes["ltt"].values
    raw_ltp = raw_quotes["ltp"].values

    # Pass 1: compute indicator values
    rows = []
    closes = []
    for candle in candles:
        closes.append(candle.close)
        row = asdict(candle)
        rsi_val = ind.rsi_trend(closes, 5, 80, 20)
        ema_val = ind.ema_crossover_trend(closes, 30, 70)
        and_val = _combine(rsi_val, ema_val)
        row[RSI_COL] = rsi_val
        row[EMA_COL] = ema_val
        row[AND_COL] = and_val
        row["label"] = None
        rows.append(row)

    # Pass 2: sequential scan (mirrors labeler.per_indicator_success_rates)
    active_scan = None
    for i, row in enumerate(rows):
        candle_time = row["time"]
        direction   = row[AND_COL]

        # Step 1: resolve active scan up to this candle's time
        if active_scan is not None:
            result = _resolve_scan(active_scan, candle_time, raw_ltt, raw_ltp, threshold, stop_loss)
            if result in ("good", "bad"):
                rows[active_scan["idx"]]["label"] = result
                active_scan = None
            elif result == "oscillating":
                active_scan = None   # label stays None

        # Step 2: start new scan if signal and no active scan
        if active_scan is None and direction in ("UP", "DOWN"):
            scan_end = (candle_time + max_hold_seconds) if max_hold_seconds else float("inf")
            active_scan = {
                "idx":          i,
                "direction":    direction,
                "candle_time":  candle_time,
                "candle_close": row["close"],
                "scan_end_time": scan_end,
            }

    # Remaining unresolved scan → oscillating (label stays None)

    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser(description="Focused indicator: RSI_5_80_20 AND EMA_30_70")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help=f"Price target in NIFTY points (default: {DEFAULT_THRESHOLD})")
    parser.add_argument("--stop-loss", type=float, default=None,
                        help="Stop loss in NIFTY points (default: same as --threshold)")
    parser.add_argument("--interval", type=int, default=None,
                        help="Only analyse this candle interval in seconds (e.g. 1800 to match server). "
                             "Omit to analyse all intervals.")
    parser.add_argument("--max-hold-minutes", type=float, default=None,
                        help="Max hold time in minutes — mirrors server maxHoldTimeMinutes (e.g. 30). "
                             "Omit for no time limit.")
    args = parser.parse_args()
    stop_loss = args.stop_loss if args.stop_loss is not None else args.threshold
    max_hold_seconds = args.max_hold_minutes * 60 if args.max_hold_minutes else None
    os.makedirs(args.output_dir, exist_ok=True)

    print("Loading data from MongoDB...")
    loader = DataLoader()
    raw_quotes = loader.load()
    loader.close()

    print("Building candles...")
    builder = CandleBuilder()
    candles_by_interval = builder.build(raw_quotes)

    all_dfs = []
    for interval, candles in candles_by_interval.items():
        if args.interval and interval != args.interval:
            continue
        lbl = INTERVAL_LABELS[interval]
        print(f"  {lbl}: {len(candles)} candles")
        df = build_focused_df(candles, raw_quotes, args.threshold, stop_loss, max_hold_seconds)
        all_dfs.append(df)

    combined = pd.concat(all_dfs, ignore_index=True)
    out_path = os.path.join(args.output_dir, "focused_indicator.csv")
    combined.to_csv(out_path, index=False)
    print(f"\nWrote {out_path} ({len(combined)} rows x {len(combined.columns)} cols)")


if __name__ == "__main__":
    main()
