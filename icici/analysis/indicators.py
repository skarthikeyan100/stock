import warnings
import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning)


def _round2(n: float) -> float:
    return round(n, 2)


# ---------------------------------------------------------------------------
# RSI  (mirrors decision.ts _calculateRSITrend lines 927-954)
# ---------------------------------------------------------------------------

def rsi_trend(closing_prices: list[float], period: int, overbought: int, oversold: int) -> str | None:
    if len(closing_prices) < period + 1:
        return None

    prices = np.array(closing_prices, dtype=float)
    deltas = np.diff(prices)

    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        latest_rsi = 100.0
    else:
        rs = avg_gain / avg_loss
        latest_rsi = 100 - (100 / (1 + rs))

    if latest_rsi > overbought:
        return "DOWN"
    elif latest_rsi < oversold:
        return "UP"
    return "NEUTRAL"


def rsi_column_name(period, overbought, oversold) -> str:
    return f"RSI_{period}_{overbought}_{oversold}"


# ---------------------------------------------------------------------------
# MACD  (mirrors decision.ts _calculateMACDTrend lines 887-925)
# ---------------------------------------------------------------------------

def _ema(values: np.ndarray, period: int) -> np.ndarray:
    result = np.empty(len(values))
    multiplier = 2 / (period + 1)
    result[0] = values[0]
    for i in range(1, len(values)):
        result[i] = (values[i] - result[i - 1]) * multiplier + result[i - 1]
    return result


def macd_trend(closing_prices: list[float], short_period: int, long_period: int, signal_period: int) -> str | None:
    total_needed = signal_period + long_period
    if len(closing_prices) < total_needed:
        return None

    prices = np.array(closing_prices[-total_needed:], dtype=float)
    short_ema = _ema(prices, short_period)
    long_ema = _ema(prices, long_period)

    # MACD line: short EMA - long EMA (both full length)
    macd_line = short_ema - long_ema
    if len(macd_line) < signal_period:
        return None

    signal_line = _ema(macd_line, signal_period)

    latest_macd = macd_line[-1]
    latest_signal = signal_line[-1]

    return "UP" if latest_macd > latest_signal else "DOWN"


def macd_column_name(short, long, signal) -> str:
    return f"MACD_{short}_{long}_{signal}"


# ---------------------------------------------------------------------------
# Bollinger Bands  (mirrors decision.ts _calculateBollingerBandsTrend lines 956-990)
# ---------------------------------------------------------------------------

def bollinger_trend(closing_prices: list[float], period: int, num_deviations: float) -> str | None:
    if len(closing_prices) < period:
        return None

    prices = np.array(closing_prices[-period:], dtype=float)
    sma = np.mean(prices)
    # population std (matches TypeScript: divides by N, not N-1)
    std_dev = np.std(prices)

    upper_band = sma + (std_dev * num_deviations)
    lower_band = sma - (std_dev * num_deviations)
    latest = prices[-1]

    if latest > upper_band:
        return "UP"
    elif latest < lower_band:
        return "DOWN"
    return "NEUTRAL"


def bollinger_column_name(period, num_deviations) -> str:
    return f"Bollinger_{period}_{num_deviations}"


# ---------------------------------------------------------------------------
# EMA Crossover  (mirrors decision.ts _detectEMATrend lines 857-885)
# ---------------------------------------------------------------------------

def ema_crossover_trend(closing_prices: list[float], short_period: int, long_period: int) -> str | None:
    if len(closing_prices) < long_period:
        return None

    prices = np.array(closing_prices[-long_period:], dtype=float)
    short_ema = _ema(prices, short_period)
    long_ema = _ema(prices, long_period)

    for i in range(1, len(prices)):
        if short_ema[i - 1] <= long_ema[i - 1] and short_ema[i] > long_ema[i]:
            return "UP"
        elif short_ema[i - 1] >= long_ema[i - 1] and short_ema[i] < long_ema[i]:
            return "DOWN"

    return "NEUTRAL"


def ema_column_name(short, long) -> str:
    return f"EMA_{short}_{long}"


# ---------------------------------------------------------------------------
# ADX  (new indicator — Average Directional Index)
# ---------------------------------------------------------------------------

def adx_trend(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> str | None:
    n = len(closes)
    if n < period * 2:
        return None

    h = np.array(highs, dtype=float)
    lo = np.array(lows, dtype=float)
    c = np.array(closes, dtype=float)

    # True Range
    tr = np.maximum(h[1:] - lo[1:], np.maximum(np.abs(h[1:] - c[:-1]), np.abs(lo[1:] - c[:-1])))
    # +DM / -DM
    plus_dm = np.where((h[1:] - h[:-1]) > (lo[:-1] - lo[1:]), np.maximum(h[1:] - h[:-1], 0), 0)
    minus_dm = np.where((lo[:-1] - lo[1:]) > (h[1:] - h[:-1]), np.maximum(lo[:-1] - lo[1:], 0), 0)

    # Smoothed with Wilder's method
    atr = np.zeros(len(tr))
    s_plus = np.zeros(len(tr))
    s_minus = np.zeros(len(tr))
    atr[period - 1] = np.mean(tr[:period])
    s_plus[period - 1] = np.mean(plus_dm[:period])
    s_minus[period - 1] = np.mean(minus_dm[:period])

    for i in range(period, len(tr)):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
        s_plus[i] = (s_plus[i - 1] * (period - 1) + plus_dm[i]) / period
        s_minus[i] = (s_minus[i - 1] * (period - 1) + minus_dm[i]) / period

    plus_di = np.where(atr != 0, 100 * s_plus / atr, 0)
    minus_di = np.where(atr != 0, 100 * s_minus / atr, 0)
    dx = np.where((plus_di + minus_di) != 0, 100 * np.abs(plus_di - minus_di) / (plus_di + minus_di), 0)

    # ADX = smoothed DX
    adx_vals = np.zeros(len(dx))
    start = 2 * period - 1
    if start >= len(dx):
        return None
    adx_vals[start] = np.mean(dx[period:start + 1])
    for i in range(start + 1, len(dx)):
        adx_vals[i] = (adx_vals[i - 1] * (period - 1) + dx[i]) / period

    latest_adx = adx_vals[-1]
    latest_plus = plus_di[-1]
    latest_minus = minus_di[-1]

    if latest_adx < 20:
        return "NEUTRAL"
    elif latest_plus > latest_minus:
        return "UP"
    else:
        return "DOWN"


def adx_column_name(period) -> str:
    return f"ADX_{period}"


# ---------------------------------------------------------------------------
# Stochastic Oscillator  (new indicator)
# ---------------------------------------------------------------------------

def stochastic_trend(highs: list[float], lows: list[float], closes: list[float],
                     k_period: int = 14, d_period: int = 3) -> str | None:
    n = len(closes)
    if n < k_period + d_period:
        return None

    h = np.array(highs, dtype=float)
    lo = np.array(lows, dtype=float)
    c = np.array(closes, dtype=float)

    # %K
    k_values = []
    for i in range(k_period - 1, n):
        highest = np.max(h[i - k_period + 1:i + 1])
        lowest = np.min(lo[i - k_period + 1:i + 1])
        if highest == lowest:
            k_values.append(50.0)
        else:
            k_values.append(100 * (c[i] - lowest) / (highest - lowest))

    k_arr = np.array(k_values)
    # %D = SMA of %K
    d_values = []
    for i in range(d_period - 1, len(k_arr)):
        d_values.append(np.mean(k_arr[i - d_period + 1:i + 1]))

    latest_k = k_arr[-1]
    latest_d = d_values[-1] if d_values else latest_k

    # Overbought > 80, oversold < 20
    if latest_k < 20 and latest_k > latest_d:
        return "UP"
    elif latest_k > 80 and latest_k < latest_d:
        return "DOWN"
    return "NEUTRAL"


def stochastic_column_name(k_period, d_period) -> str:
    return f"Stoch_{k_period}_{d_period}"


# ---------------------------------------------------------------------------
# Reversed RSI (Contrarian Strategy)
# ---------------------------------------------------------------------------

def rsi_trend_reversed(closing_prices: list, period: int, overbought: int, oversold: int) -> str:
    """
    Reversed RSI logic for contrarian strategies.
    Overbought (>70) → UP signal (buy the strength)
    Oversold (<30) → DOWN signal (sell the weakness)
    """
    if len(closing_prices) < period + 1:
        return "NEUTRAL"

    # Calculate RSI (same as normal)
    gains = []
    losses = []
    for i in range(len(closing_prices) - period, len(closing_prices)):
        delta = closing_prices[i] - closing_prices[i - 1]
        if delta > 0:
            gains.append(delta)
            losses.append(0)
        else:
            gains.append(0)
            losses.append(abs(delta))

    avg_gain = np.mean(gains)
    avg_loss = np.mean(losses)

    if avg_loss == 0:
        return "UP"  # No losses = strong uptrend

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))

    # REVERSED interpretation
    if rsi > overbought:
        return "UP"  # Contrarian: overbought = buy signal
    elif rsi < oversold:
        return "DOWN"  # Contrarian: oversold = sell signal
    return "NEUTRAL"


def rsi_column_name_reversed(period: int, overbought: int, oversold: int) -> str:
    return f"RSI_{period}_{overbought}_{oversold}_REV"
