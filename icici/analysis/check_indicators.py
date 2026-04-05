"""
Compute RSI_5_80_20 and EMA_30_70 on 1-min candle closes from MongoDB.
Prints candle index, close, RSI value, EMA trend for each candle
so results can be compared directly with check_indicators.js.
"""
import numpy as np
from data_loader import DataLoader
from candle_builder import CandleBuilder

RSI_PERIOD, OVERBOUGHT, OVERSOLD = 5, 80, 20
EMA_SHORT, EMA_LONG = 30, 70
INTERVAL = 60


def seeded_ema(values: np.ndarray, period: int) -> np.ndarray:
    """Same seeded EMA used in indicators.py and decision.ts _seededEMA."""
    mult = 2 / (period + 1)
    result = np.empty(len(values))
    result[0] = values[0]
    for i in range(1, len(values)):
        result[i] = (values[i] - result[i - 1]) * mult + result[i - 1]
    return result


def compute_rsi_wilder(closes: list[float], period: int) -> float | None:
    """Python RSI — Wilder smoothing (same as indicators.py rsi_trend)."""
    if len(closes) < period + 1:
        return None
    prices = np.array(closes, dtype=float)
    deltas = np.diff(prices)
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    return 100 - (100 / (1 + avg_gain / avg_loss))


def compute_ema_crossover(closes: list[float], short: int, long: int) -> str | None:
    """Same slice-to-longPeriod crossover scan used in both Python and server."""
    if len(closes) < long:
        return None
    prices = np.array(closes[-long:], dtype=float)
    short_ema = seeded_ema(prices, short)
    long_ema  = seeded_ema(prices, long)
    for i in range(1, len(prices)):
        if short_ema[i-1] <= long_ema[i-1] and short_ema[i] > long_ema[i]:
            return "UP"
        if short_ema[i-1] >= long_ema[i-1] and short_ema[i] < long_ema[i]:
            return "DOWN"
    return "NEUTRAL"


def main():
    loader = DataLoader()
    raw = loader.load()
    loader.close()

    candles = CandleBuilder().build(raw)[INTERVAL]
    closes = [c.close for c in candles]

    print(f"{'idx':>4}  {'close':>8}  {'RSI':>6}  {'RSI_trend':>10}  {'EMA_trend':>10}")
    print("-" * 48)

    for i in range(len(closes)):
        rsi_val = compute_rsi_wilder(closes[:i+1], RSI_PERIOD)
        ema_trend = compute_ema_crossover(closes[:i+1], EMA_SHORT, EMA_LONG)

        if rsi_val is None:
            rsi_trend = "null"
        elif rsi_val > OVERBOUGHT:
            rsi_trend = "DOWN"
        elif rsi_val < OVERSOLD:
            rsi_trend = "UP"
        else:
            rsi_trend = "NEUTRAL"

        rsi_str = f"{rsi_val:.2f}" if rsi_val is not None else "  null"
        print(f"{i:>4}  {closes[i]:>8.2f}  {rsi_str:>6}  {rsi_trend:>10}  {ema_trend or 'null':>10}")


if __name__ == "__main__":
    main()
