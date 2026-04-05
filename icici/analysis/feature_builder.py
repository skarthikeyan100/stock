import pandas as pd
from dataclasses import asdict
from candle_builder import Candle
from config import RSI_PARAMS, MACD_PARAMS, BOLLINGER_PARAMS, EMA_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS
import indicators as ind


class FeatureBuilder:

    def __init__(self, reverse_rsi: bool = False):
        self.reverse_rsi = reverse_rsi
        self.indicator_columns = self._build_column_names()

    def _build_column_names(self) -> list[str]:
        cols = []
        for p in RSI_PARAMS:
            cols.append(ind.rsi_column_name(p["period"], p["overbought"], p["oversold"]))
        for p in MACD_PARAMS:
            cols.append(ind.macd_column_name(p["short"], p["long"], p["signal"]))
        for p in BOLLINGER_PARAMS:
            cols.append(ind.bollinger_column_name(p["period"], p["num_deviations"]))
        for p in EMA_PARAMS:
            cols.append(ind.ema_column_name(p["short"], p["long"]))
        for p in ADX_PARAMS:
            cols.append(ind.adx_column_name(p["period"]))
        for p in STOCHASTIC_PARAMS:
            cols.append(ind.stochastic_column_name(p["k_period"], p["d_period"]))
        # Add reversed RSI columns if enabled
        if self.reverse_rsi:
            for p in RSI_PARAMS:
                cols.append(ind.rsi_column_name_reversed(p["period"], p["overbought"], p["oversold"]))
        return cols

    def build(self, candles: list[Candle]) -> pd.DataFrame:
        rows = []
        closes = []
        highs = []
        lows = []

        for i, candle in enumerate(candles):
            closes.append(candle.close)
            highs.append(candle.high)
            lows.append(candle.low)

            row = asdict(candle)

            # RSI — uses closing prices
            for p in RSI_PARAMS:
                col = ind.rsi_column_name(p["period"], p["overbought"], p["oversold"])
                row[col] = ind.rsi_trend(closes, p["period"], p["overbought"], p["oversold"])

            # MACD — uses closing prices
            for p in MACD_PARAMS:
                col = ind.macd_column_name(p["short"], p["long"], p["signal"])
                row[col] = ind.macd_trend(closes, p["short"], p["long"], p["signal"])

            # Bollinger — uses closing prices
            for p in BOLLINGER_PARAMS:
                col = ind.bollinger_column_name(p["period"], p["num_deviations"])
                row[col] = ind.bollinger_trend(closes, p["period"], p["num_deviations"])

            # EMA Crossover — uses closing prices
            for p in EMA_PARAMS:
                col = ind.ema_column_name(p["short"], p["long"])
                row[col] = ind.ema_crossover_trend(closes, p["short"], p["long"])

            # ADX — uses highs, lows, closes
            for p in ADX_PARAMS:
                col = ind.adx_column_name(p["period"])
                row[col] = ind.adx_trend(highs, lows, closes, p["period"])

            # Stochastic — uses highs, lows, closes
            for p in STOCHASTIC_PARAMS:
                col = ind.stochastic_column_name(p["k_period"], p["d_period"])
                row[col] = ind.stochastic_trend(highs, lows, closes, p["k_period"], p["d_period"])

            # Reversed RSI indicators (if enabled)
            if self.reverse_rsi:
                for p in RSI_PARAMS:
                    col = ind.rsi_column_name_reversed(p["period"], p["overbought"], p["oversold"])
                    row[col] = ind.rsi_trend_reversed(closes, p["period"], p["overbought"], p["oversold"])

            rows.append(row)

        df = pd.DataFrame(rows)
        print(f"  Built feature matrix: {len(df)} rows x {len(df.columns)} columns")
        return df
