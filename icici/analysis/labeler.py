import numpy as np
import pandas as pd


class Labeler:

    def __init__(self, indicator_columns: list[str], threshold: float = 10.0, lookahead: int = 10, stop_loss: float = None):
        self.indicator_columns = indicator_columns
        self.threshold = threshold
        self.stop_loss = stop_loss if stop_loss is not None else threshold  # Default to threshold
        self.lookahead = lookahead

    def label(self, df: pd.DataFrame, raw_prices: pd.DataFrame) -> pd.DataFrame:
        raw_ltp = raw_prices["ltp"].values
        raw_ltt = raw_prices["ltt"].values

        predicted_dirs = []
        labels = []

        for idx, row in df.iterrows():
            # Majority vote across indicator columns
            direction = self._majority_vote(row)
            predicted_dirs.append(direction)

            if direction == "NEUTRAL":
                labels.append("neutral")
                continue

            # Find the time window: from this candle's time to the next N candles' end time
            candle_time = row["time"]
            candle_close = row["close"]
            interval = row["interval"]

            # Look ahead N candles worth of time
            window_end = candle_time + (self.lookahead * interval)

            # Get raw prices in the future window
            mask = (raw_ltt > candle_time) & (raw_ltt <= window_end)
            future_prices = raw_ltp[mask]

            if len(future_prices) == 0:
                labels.append("bad")
                continue

            if direction == "UP":
                confirmed = np.any(future_prices >= candle_close + self.threshold)
            else:  # DOWN
                confirmed = np.any(future_prices <= candle_close - self.threshold)

            labels.append("good" if confirmed else "bad")

        df = df.copy()
        df["predicted_direction"] = predicted_dirs
        df["label"] = labels

        total = len(labels)
        good = labels.count("good")
        bad = labels.count("bad")
        neutral = labels.count("neutral")
        print(f"  Labeled: {good} good, {bad} bad, {neutral} neutral (of {total})")
        return df

    def _majority_vote(self, row) -> str:
        up_count = 0
        down_count = 0
        for col in self.indicator_columns:
            val = row.get(col)
            if val == "UP":
                up_count += 1
            elif val == "DOWN":
                down_count += 1
        if up_count > down_count:
            return "UP"
        elif down_count > up_count:
            return "DOWN"
        return "NEUTRAL"

    def per_indicator_success_rates(self, df: pd.DataFrame, raw_prices: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate success rates with stop loss logic.

        For each indicator:
        - Process signals sequentially (no overlapping scans)
        - Check if target or stop loss is hit first
        - Label: good (target first), bad (stop loss first), oscillating (neither)
        - Success rate = good / (good + bad) [oscillating excluded]
        """
        raw_ltp = raw_prices["ltp"].values
        raw_ltt = raw_prices["ltt"].values

        results = []

        # Process each indicator separately with state tracking
        for indicator in self.indicator_columns:
            good = 0
            bad = 0
            oscillating = 0

            # State: track active scan for this indicator
            active_scan = None  # None or dict with scan info

            # Process candles sequentially
            for idx, row in df.iterrows():
                candle_time = row["time"]
                candle_close = row["close"]
                interval = row["interval"]
                direction = row.get(indicator)

                # STEP 1: Check if active scan needs to be resolved
                if active_scan is not None:
                    scan_result = self._resolve_scan(
                        active_scan, candle_time, raw_ltp, raw_ltt
                    )

                    if scan_result == "good":
                        good += 1
                        active_scan = None
                    elif scan_result == "bad":
                        bad += 1
                        active_scan = None
                    elif scan_result == "oscillating":
                        oscillating += 1
                        active_scan = None
                    # else: scan_result == "continue" → keep scanning

                # STEP 2: Start new scan if no active scan and signal is UP/DOWN
                if active_scan is None and direction in ("UP", "DOWN"):
                    scan_end_time = float('inf')  # scan all future candles
                    active_scan = {
                        "direction": direction,
                        "candle_time": candle_time,
                        "candle_close": candle_close,
                        "scan_end_time": scan_end_time,
                        "interval": interval,
                    }

                # Signals during active scan are IGNORED (implicit)

            # After all candles processed, check for unresolved scan
            if active_scan is not None:
                oscillating += 1

            # Calculate success rate (oscillating excluded)
            total = good + bad
            rate = round(good / total * 100, 2) if total > 0 else 0.0

            results.append({
                "indicator": indicator,
                "good": good,
                "bad": bad,
                "oscillating": oscillating,
                "total": total,
                "success_rate": rate,
            })

        return pd.DataFrame(results).sort_values("success_rate", ascending=False)

    def _resolve_scan(self, active_scan: dict, current_time: float,
                      raw_ltp: np.ndarray, raw_ltt: np.ndarray) -> str:
        """
        Check if the active scan is resolved (target hit, stop loss hit, or expired).

        Returns:
            "good" - target hit first
            "bad" - stop loss hit first
            "oscillating" - scan window expired without hitting either
            "continue" - scan still active
        """
        scan_start = active_scan["candle_time"]
        scan_end = active_scan["scan_end_time"]
        scan_close = active_scan["candle_close"]
        scan_direction = active_scan["direction"]

        # Get all prices from scan start to current time (but not past scan end)
        effective_end = min(current_time, scan_end)
        mask = (raw_ltt > scan_start) & (raw_ltt <= effective_end)
        scan_prices = raw_ltp[mask]
        scan_times = raw_ltt[mask]

        if len(scan_prices) == 0:
            # No prices yet, check if window expired
            if current_time >= scan_end:
                return "oscillating"
            return "continue"

        # Determine target and stop loss levels
        if scan_direction == "UP":
            target_level = scan_close + self.threshold
            stoploss_level = scan_close - self.stop_loss
        else:  # DOWN
            target_level = scan_close - self.threshold
            stoploss_level = scan_close + self.stop_loss

        # Find first time target was hit
        target_hit_idx = None
        if scan_direction == "UP":
            target_hits = np.where(scan_prices >= target_level)[0]
        else:
            target_hits = np.where(scan_prices <= target_level)[0]

        if len(target_hits) > 0:
            target_hit_idx = target_hits[0]

        # Find first time stop loss was hit
        stoploss_hit_idx = None
        if scan_direction == "UP":
            stoploss_hits = np.where(scan_prices <= stoploss_level)[0]
        else:
            stoploss_hits = np.where(scan_prices >= stoploss_level)[0]

        if len(stoploss_hits) > 0:
            stoploss_hit_idx = stoploss_hits[0]

        # Determine which was hit first
        if target_hit_idx is not None and stoploss_hit_idx is not None:
            # Both hit - compare indices (chronological order)
            if target_hit_idx < stoploss_hit_idx:
                return "good"
            else:
                return "bad"
        elif target_hit_idx is not None:
            return "good"
        elif stoploss_hit_idx is not None:
            return "bad"
        else:
            # Neither hit yet - check if window expired
            if current_time >= scan_end:
                return "oscillating"
            return "continue"
