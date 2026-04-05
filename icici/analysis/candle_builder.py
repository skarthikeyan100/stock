import numpy as np
import pandas as pd
from dataclasses import dataclass, asdict
from statistics import median as stat_median
from config import INTERVALS, INTERVAL_LABELS


@dataclass
class Candle:
    interval: int
    interval_label: str
    time: int
    open: float
    close: float
    high: float
    low: float
    average: float
    median: float
    stddev: float
    mad: float
    S1: float
    R1: float
    S2: float
    R2: float
    rate_of_change: float
    range: float
    diff: float
    volume: float
    buy_qty: float
    sell_qty: float


def _round2(num: float) -> float:
    return round(num, 2)


def _compute_mad(prices: list[float]) -> float:
    med = stat_median(prices)
    deviations = [abs(p - med) for p in prices]
    return _round2(stat_median(deviations))


def _compute_pivot(high: float, low: float, close: float) -> dict:
    P = (high + low + close) / 3
    return {
        "S1": _round2((2 * P) - high),
        "R1": _round2((2 * P) - low),
        "S2": _round2(P - (high - low)),
        "R2": _round2(P + (high - low)),
    }


class CandleBuilder:

    def __init__(self, intervals=None):
        self.intervals = intervals or INTERVALS

    def build(self, quotes_df: pd.DataFrame) -> dict[int, list[Candle]]:
        ltp = quotes_df["ltp"].values
        ltt = quotes_df["ltt"].values
        vol = quotes_df["volume"].values if "volume" in quotes_df.columns else np.zeros(len(quotes_df))
        bq = quotes_df["buyQty"].values if "buyQty" in quotes_df.columns else np.zeros(len(quotes_df))
        sq = quotes_df["sellQty"].values if "sellQty" in quotes_df.columns else np.zeros(len(quotes_df))

        result = {}
        for interval in self.intervals:
            result[interval] = self._build_interval(ltp, ltt, vol, bq, sq, interval)
            print(f"  {INTERVAL_LABELS[interval]}: {len(result[interval])} candles")
        return result

    def _build_interval(self, ltp, ltt, vol, bq, sq, interval) -> list[Candle]:
        candles = []
        bucket_prices = []
        bucket_vol = 0.0
        bucket_bq = 0.0
        bucket_sq = 0.0
        start_time = ltt[0]

        for i in range(len(ltp)):
            bucket_prices.append(ltp[i])
            bucket_vol += vol[i]
            bucket_bq += bq[i]
            bucket_sq += sq[i]

            if ltt[i] - start_time >= interval and len(bucket_prices) >= 2:
                candle = self._make_candle(
                    bucket_prices, interval, start_time,
                    bucket_vol, bucket_bq, bucket_sq,
                )
                candles.append(candle)
                bucket_prices = []
                bucket_vol = 0.0
                bucket_bq = 0.0
                bucket_sq = 0.0
                start_time = ltt[i]

        return candles

    @staticmethod
    def _make_candle(prices, interval, time, vol, bq, sq) -> Candle:
        o = prices[0]
        c = prices[-1]
        h = max(prices)
        lo = min(prices)
        avg = _round2(np.mean(prices))
        med = _round2(stat_median(prices))
        std = _round2(np.std(prices))  # population std (matches TypeScript)
        mad = _compute_mad(prices)
        pivot = _compute_pivot(h, lo, c)
        roc = _round2((c - o) / o * 100) if o != 0 else 0
        rng = _round2(h - lo)
        diff = _round2(c - o)

        return Candle(
            interval=interval,
            interval_label=INTERVAL_LABELS[interval],
            time=int(time),
            open=o, close=c, high=h, low=lo,
            average=avg, median=med, stddev=std, mad=mad,
            **pivot,
            rate_of_change=roc, range=rng, diff=diff,
            volume=vol, buy_qty=bq, sell_qty=sq,
        )
